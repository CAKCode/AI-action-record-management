'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const OUTCOMES = ['passed', 'failed', 'error', 'skipped', 'xfailed', 'xpassed', 'unknown'];
const cache = new Map();
const pending = new Map();
const liveReportCache = new Map();
const MAX_LIVE_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_LIVE_REPORT_BYTES_BIGINT = BigInt(MAX_LIVE_REPORT_BYTES);
const LIVE_REPORT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const LIVE_REPORT_CACHE_MAX_ENTRIES = 64;
let liveReportCacheBytes = 0;
let liveWorker = null;
let liveWorkerRequestId = 0;
const liveWorkerRequests = new Map();
let liveWorkerIdleTimer = null;
const LIVE_WORKER_IDLE_MS = 5000;
let parsing = Promise.resolve();

function emptyCounts() {
  return Object.fromEntries(['total', ...OUTCOMES].map(key => [key, 0]));
}

function caseOutcome(rows) {
  const outcomes = new Set(rows.map(row => String(row.result || '').toLowerCase()));
  // Setup/teardown errors take precedence over a successful call row.
  return ['error', 'failed', 'xpassed', 'passed', 'xfailed', 'skipped'].find(value => outcomes.has(value)) || 'unknown';
}

function decodeAttribute(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };
  return value.replace(/&#x([0-9a-f]+);|&#(\d+);|&(amp|apos|gt|lt|quot);/gi,
    (_, hex, decimal, name) => name ? named[name.toLowerCase()] : String.fromCodePoint(Number.parseInt(hex || decimal, hex ? 16 : 10)));
}

function readCases(report) {
  const descriptor = fs.openSync(report.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let content;
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error('PYTEST_REPORT_NOT_REGULAR');
    content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error('PYTEST_REPORT_CHANGED');
    }
  } finally { fs.closeSync(descriptor); }
  if (content.length !== report.bytes || crypto.createHash('sha256').update(content).digest('hex') !== report.sha256) {
    throw new Error('PYTEST_REPORT_INTEGRITY');
  }
  return parseCasesFromContent(content);
}

function parseCasesFromContent(content) {
  const match = /\bdata-jsonblob\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(content.toString('utf8'));
  if (!match) throw new Error('PYTEST_RESULTS_UNAVAILABLE');
  const data = JSON.parse(decodeAttribute(match[1] ?? match[2]));
  if (!data.tests || Array.isArray(data.tests) || typeof data.tests !== 'object') throw new Error('PYTEST_RESULTS_UNAVAILABLE');
  return Object.entries(data.tests).map(([nodeid, rows]) => {
    if (!Array.isArray(rows) || !rows.length) throw new Error('PYTEST_RESULTS_UNAVAILABLE');
    return [nodeid, caseOutcome(rows)];
  });
}

function liveReportCacheWeight(contentBytes, rows) {
  const caseBytes = rows.reduce((total, [nodeId, outcome]) => total
    + Buffer.byteLength(String(nodeId), 'utf8')
    + Buffer.byteLength(String(outcome), 'utf8')
    + 128, 0);
  // Account for both the source text and the parsed case strings. This is a
  // conservative bound for the retained worker-thread heap.
  return Math.max(1, (Number(contentBytes) * 2) + caseBytes);
}

function removeLiveReportCacheEntry(target) {
  const existing = liveReportCache.get(target);
  if (!existing) return;
  liveReportCache.delete(target);
  liveReportCacheBytes = Math.max(0, liveReportCacheBytes - existing.weight);
}

function cacheLiveReport(target, signature, rows, contentBytes) {
  const weight = liveReportCacheWeight(contentBytes, rows);
  removeLiveReportCacheEntry(target);
  if (weight > LIVE_REPORT_CACHE_MAX_BYTES) return;
  liveReportCache.set(target, { signature, value: { signature, cases: rows }, weight });
  liveReportCacheBytes += weight;
  while (liveReportCache.size > LIVE_REPORT_CACHE_MAX_ENTRIES
    || liveReportCacheBytes > LIVE_REPORT_CACHE_MAX_BYTES) {
    const oldest = liveReportCache.keys().next().value;
    if (oldest === undefined) break;
    removeLiveReportCacheEntry(oldest);
  }
}

function readLivePytestCases(filePath) {
  const target = String(filePath || '');
  if (!target) return null;
  let stat;
  try {
    stat = fs.lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > BigInt(MAX_LIVE_REPORT_BYTES)) return null;
  } catch { return null; }
  const signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const cached = liveReportCache.get(target);
  if (cached?.signature === signature) {
    liveReportCache.delete(target);
    liveReportCache.set(target, cached);
    return cached.value;
  }
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > MAX_LIVE_REPORT_BYTES_BIGINT
      || before.dev !== stat.dev || before.ino !== stat.ino) return null;
    const content = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < content.length) {
      const bytesRead = fs.readSync(descriptor, content, offset, content.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return null;
    const rows = parseCasesFromContent(content);
    cacheLiveReport(target, signature, rows, content.length);
    return { signature, cases: rows };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function readLivePytestReportCounts(filePath) {
  const live = readLivePytestCases(filePath);
  if (!live) return null;
  const counts = emptyCounts();
  for (const [, outcome] of live.cases) {
    counts.total++;
    counts[outcome]++;
  }
  return { signature: live.signature, counts };
}

function sendLiveWorkerRequest(mode, payload) {
  if (!liveWorker) {
    liveWorker = new Worker(__filename, { workerData: { mode: 'live-worker' } });
    liveWorker.unref();
    liveWorker.on('message', (message) => {
      const request = liveWorkerRequests.get(message?.id);
      if (!request) return;
      liveWorkerRequests.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result || {});
      scheduleLiveWorkerShutdown();
    });
    const failWorker = (error) => {
      for (const request of liveWorkerRequests.values()) request.reject(error);
      liveWorkerRequests.clear();
      liveWorker = null;
    };
    liveWorker.on('error', failWorker);
    liveWorker.on('exit', (code) => {
      if (code !== 0) failWorker(new Error(`Live pytest progress worker exited (${code})`));
      else liveWorker = null;
    });
  }
  if (liveWorkerIdleTimer) {
    clearTimeout(liveWorkerIdleTimer);
    liveWorkerIdleTimer = null;
  }
  return new Promise((resolve, reject) => {
    const id = ++liveWorkerRequestId;
    liveWorkerRequests.set(id, { resolve, reject });
    try {
      liveWorker.postMessage({ id, mode, ...payload });
    } catch (error) {
      liveWorkerRequests.delete(id);
      reject(error);
    }
  });
}

function readLivePytestProgressAsync(groups) {
  const normalized = (groups || []).filter(group => group?.id && group.filePaths?.length)
    .map(group => ({ id: String(group.id), filePaths: [...new Set(group.filePaths.map(String))] }));
  if (!normalized.length) return Promise.resolve({});
  return sendLiveWorkerRequest('live-progress', { groups: normalized });
}

function scheduleLiveWorkerShutdown() {
  if (liveWorkerIdleTimer || !liveWorker || liveWorkerRequests.size) return;
  liveWorkerIdleTimer = setTimeout(() => {
    liveWorkerIdleTimer = null;
    if (liveWorker && !liveWorkerRequests.size) {
      const worker = liveWorker;
      liveWorker = null;
      worker.terminate().catch(() => {});
    }
  }, LIVE_WORKER_IDLE_MS);
  liveWorkerIdleTimer.unref();
}

function summarizeReports(reports) {
  const cumulative = emptyCounts();
  const latest = new Map();
  const seen = new Set();
  const failures = [];
  let reportCount = 0;
  let pendingReports = 0;
  let unmatchedRerunCases = 0;
  const ordered = [...reports].sort((left, right) => Date.parse(left.at || 0) - Date.parse(right.at || 0));
  for (const report of ordered) {
    if (!report.filePath || report.running) { pendingReports++; continue; }
    const identity = `${report.executionKey}\0${report.sha256}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    try {
      const cases = readCases(report);
      reportCount++;
      for (const [nodeid, outcome] of cases) {
        cumulative.total++;
        cumulative[outcome]++;
        const caseKey = `${report.scope}\0${nodeid}`;
        if (report.rerun && !latest.has(caseKey)) unmatchedRerunCases++;
        latest.set(caseKey, outcome);
      }
    } catch (error) {
      failures.push({ artifactId: report.id, code: /^PYTEST_/.test(error.message) ? error.message : 'PYTEST_RESULTS_UNAVAILABLE' });
    }
  }
  const final = emptyCounts();
  for (const outcome of latest.values()) { final.total++; final[outcome]++; }
  return { available: reportCount > 0, complete: !pendingReports && !failures.length && !cumulative.unknown && !unmatchedRerunCases,
    reportCount, pendingReports, unmatchedRerunCases, failures, cumulative, final,
    executed: cumulative.total - cumulative.skipped };
}

function outcomeCounts(rows) {
  const counts = emptyCounts();
  for (const outcome of rows.map(([, value]) => value)) {
    counts.total++;
    counts[outcome]++;
  }
  return counts;
}

function summarizeRunReports(reports) {
  const groups = new Map();
  const ordered = [...reports].sort((left, right) => Date.parse(left.at || 0) - Date.parse(right.at || 0));
  for (const report of ordered) {
    const groupKey = report.runId || report.executionKey || `${report.stepKey || report.scope}\0${report.runKey || ''}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        runId: report.runId || '', runKey: report.runKey || '', runKind: report.runKind || '',
        runNumber: report.runNumber == null ? null : Number(report.runNumber),
        stepKey: report.stepKey || report.scope || '',
        reports: [],
      });
    }
    groups.get(groupKey).reports.push(report);
  }
  return [...groups.values()].map((group) => {
    const latest = new Map();
    const seen = new Set();
    const failures = [];
    let reportCount = 0;
    let pendingReports = 0;
    for (const report of group.reports) {
      if (!report.filePath || report.running) { pendingReports++; continue; }
      const identity = `${report.executionKey}\0${report.sha256}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      try {
        for (const [nodeid, outcome] of readCases(report)) {
          const caseKey = `${report.scope || ''}\0${nodeid}`;
          latest.set(caseKey, { nodeid, scope: report.scope || '', outcome });
        }
        reportCount++;
      } catch (error) {
        failures.push({ artifactId: report.id, code: /^PYTEST_/.test(error.message) ? error.message : 'PYTEST_RESULTS_UNAVAILABLE' });
      }
    }
    const cases = [...latest.entries()].map(([key, item]) => ({ key, ...item }));
    return {
      runId: group.runId,
      runKey: group.runKey,
      runKind: group.runKind,
      runNumber: group.runNumber,
      stepKey: group.stepKey,
      available: reportCount > 0,
      complete: reportCount > 0 && !pendingReports && !failures.length && !cases.some((item) => item.outcome === 'unknown'),
      reportCount, pendingReports, failures, cases, counts: outcomeCounts(cases.map((item) => [item.key, item.outcome])),
    };
  });
}

function runParser(reports, mode = 'summary') {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { mode, reports } });
    let received = false;
    worker.once('message', result => { received = true; resolve(result); });
    worker.once('error', reject);
    worker.once('exit', code => { if (!received) reject(new Error(`Pytest summary parser exited (${code})`)); });
  });
}

function readTaskPytestSummary(reports) {
  if (!reports.length) return Promise.resolve(summarizeReports([]));
  const signature = reports.map(report => {
    let stamp = 'missing';
    if (report.filePath) {
      try {
        const stat = fs.lstatSync(report.filePath, { bigint: true });
        stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { ...report, stamp };
  });
  const key = crypto.createHash('sha256').update(JSON.stringify(signature)).digest('hex');
  if (cache.has(key)) {
    const result = cache.get(key); cache.delete(key); cache.set(key, result);
    return Promise.resolve(result);
  }
  if (pending.has(key)) return pending.get(key);
  // Serialize cold parses so several open Tasks cannot retain several large HTML trees.
  const operation = parsing.then(() => runParser(reports)).then(result => {
    cache.set(key, result);
    while (cache.size > 8) cache.delete(cache.keys().next().value);
    return result;
  }).finally(() => pending.delete(key));
  parsing = operation.then(() => undefined, () => undefined);
  pending.set(key, operation);
  return operation;
}

function readTaskPytestRunSummaries(reports) {
  if (!reports.length) return Promise.resolve([]);
  const signature = reports.map(report => {
    let stamp = 'missing';
    if (report.filePath) {
      try {
        const stat = fs.lstatSync(report.filePath, { bigint: true });
        stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { ...report, stamp };
  });
  const key = crypto.createHash('sha256').update(JSON.stringify({ mode: 'runs', signature })).digest('hex');
  if (cache.has(key)) {
    const result = cache.get(key); cache.delete(key); cache.set(key, result);
    return Promise.resolve(result);
  }
  if (pending.has(key)) return pending.get(key);
  const operation = parsing.then(() => runParser(reports, 'runs')).then(result => {
    cache.set(key, result);
    while (cache.size > 8) cache.delete(cache.keys().next().value);
    return result;
  }).finally(() => pending.delete(key));
  parsing = operation.then(() => undefined, () => undefined);
  pending.set(key, operation);
  return operation;
}

if (!isMainThread) {
  if (workerData?.mode === 'live-worker') {
    parentPort.on('message', (message) => {
      try {
        let result;
        if (message.mode === 'live-progress') {
          result = Object.fromEntries((message.groups || []).map(group => {
            const cases = new Map();
            const signatures = [];
            for (const filePath of group.filePaths || []) {
              const live = readLivePytestCases(filePath);
              if (!live) return [group.id, null];
              signatures.push(live.signature);
              for (const [nodeId, outcome] of live.cases) cases.set(nodeId, outcome);
            }
            const counts = emptyCounts();
            for (const outcome of cases.values()) {
              counts.total++;
              counts[outcome]++;
            }
            return [group.id, signatures.length === (group.filePaths || []).length
              ? { signature: signatures.join('\0'), counts } : null];
          }));
        } else result = {};
        parentPort.postMessage({ id: message.id, result });
      } catch (error) {
        parentPort.postMessage({ id: message.id, error: error.message });
      }
    });
  } else {
    const reports = workerData?.reports || [];
    parentPort.postMessage(workerData?.mode === 'runs' ? summarizeRunReports(reports) : summarizeReports(reports));
  }
}

module.exports = {
  readTaskPytestSummary,
  readTaskPytestRunSummaries,
  readLivePytestCases,
  readLivePytestReportCounts,
  readLivePytestProgressAsync,
};
