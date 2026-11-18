'use strict';

const fs = require('node:fs');
const { readLivePytestProgressAsync } = require('./pytest-result-summary');

const TASK_TEST_PROGRESS_CACHE_MAX = 1000;
const LIVE_PROGRESS_DIAGNOSTIC_MAX = 1000;
const LIVE_PROGRESS_FAILURE_MAX = 1000;
const taskTestProgressCache = new Map();
const liveProgressCache = new Map();
const liveProgressFailures = new Map();
let liveProgressRefresh = null;
const liveProgressDiagnostics = new Map();

function setBoundedMapValue(map, key, value, maximum) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maximum) map.delete(map.keys().next().value);
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function emptyTaskTestRunProgress() {
  return {
    available: false,
    resultKnown: false,
    total: 0,
    completed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    percent: 0,
    status: 'unavailable',
  };
}

function emptyTaskTestProgress() {
  return {
    ...emptyTaskTestRunProgress(),
    runs: {
      initial: emptyTaskTestRunProgress(),
      rerun1: emptyTaskTestRunProgress(),
    },
  };
}

function finiteMetricValue(metrics, keys) {
  for (const key of keys) {
    const value = Number(metrics.get(key));
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function liveReportRows(db, taskIds) {
  if (!taskIds.length) return [];
  const placeholders = taskIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT task_id, report_key, revision, payload_json, artifact_declarations_json,
           external_attempt_id
    FROM (
      SELECT report.task_id, report.report_key, report.revision, report.payload_json,
             report.status AS report_status,
             external.id AS external_attempt_id,
             external.artifact_declarations_json,
             ROW_NUMBER() OVER (
               PARTITION BY report.task_id, report.report_key, external.id
               ORDER BY report.revision DESC, report.published_at DESC
             ) AS report_rank
      FROM skill_reports report
      JOIN external_attempts external
        ON external.id=json_extract(report.payload_json, '$.executionEvidence.externalAttemptId')
        AND external.task_id=report.task_id
      WHERE report.task_id IN (${placeholders})
        AND report.report_type='test-result'
        AND external.status='running'
    ) live_reports
    WHERE report_rank=1
      AND report_status IN ('pending', 'running', 'partial')
  `).all(...taskIds);
}

function liveFileSignature(filePath) {
  try {
    const stat = fs.lstatSync(filePath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) return '';
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch {
    return '';
  }
}

function isUnresolvedArtifactPath(value) {
  return /(?:<[^>\r\n]+>|\$\{[^}\r\n]+\}|\$CODEX_[A-Z0-9_]+)/.test(String(value || ''));
}

function liveReportGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const declarations = parseJson(row.artifact_declarations_json, []);
    const filePaths = [...new Set(declarations
      .filter(declaration => declaration?.kind === 'pytest-html' && declaration.path)
      .map(declaration => String(declaration.path))
      .filter(filePath => !isUnresolvedArtifactPath(filePath)))];
    if (!filePaths.length) continue;
    for (const filePath of filePaths) {
      const id = `${row.task_id}\0${row.report_key}\0${row.external_attempt_id}\0${filePath}`;
      groups.set(id, {
        id,
        taskId: row.task_id,
        reportKey: row.report_key,
        externalAttemptId: row.external_attempt_id,
        filePath,
        filePaths: [filePath],
        sourceSignature: liveFileSignature(filePath),
      });
    }
  }
  return [...groups.values()];
}

function refreshLiveTaskProgress(db, taskIds) {
  const rows = liveReportRows(db, taskIds);
  const groups = liveReportGroups(rows);
  const pendingGroups = groups.filter(group => group.sourceSignature
    && liveProgressCache.get(group.id)?.sourceSignature !== group.sourceSignature
    && liveProgressFailures.get(group.id) !== group.sourceSignature);
  if (!pendingGroups.length) return Promise.resolve(false);
  if (liveProgressRefresh) return liveProgressRefresh;
  const refreshingAt = new Date().toISOString();
  for (const group of pendingGroups) {
    setBoundedMapValue(liveProgressDiagnostics, group.taskId,
      { status: 'refreshing', code: '', updatedAt: refreshingAt }, LIVE_PROGRESS_DIAGNOSTIC_MAX);
  }
  liveProgressRefresh = readLivePytestProgressAsync(pendingGroups)
    .then(results => {
      const updatedAt = new Date().toISOString();
      for (const group of pendingGroups) {
        const value = results[group.id];
        if (value) {
          liveProgressCache.set(group.id, { ...value, sourceSignature: group.sourceSignature });
          liveProgressFailures.delete(group.id);
          setBoundedMapValue(liveProgressDiagnostics, group.taskId,
            {
              status: value.unavailable?.length ? 'partial' : 'ready',
              code: value.unavailable?.length ? 'LIVE_PROGRESS_SOURCE_UNAVAILABLE' : '',
              updatedAt,
            }, LIVE_PROGRESS_DIAGNOSTIC_MAX);
        } else {
          setBoundedMapValue(liveProgressFailures, group.id, group.sourceSignature, LIVE_PROGRESS_FAILURE_MAX);
          setBoundedMapValue(liveProgressDiagnostics, group.taskId, {
            status: 'error', code: 'LIVE_PROGRESS_REFRESH_FAILED', updatedAt,
          }, LIVE_PROGRESS_DIAGNOSTIC_MAX);
        }
      }
      while (liveProgressCache.size > 2048) liveProgressCache.delete(liveProgressCache.keys().next().value);
      return true;
    })
    .catch((error) => {
      const updatedAt = new Date().toISOString();
      console.error(`[task-test-progress] live pytest progress refresh failed: ${error.message}`);
      for (const group of pendingGroups) {
        setBoundedMapValue(liveProgressFailures, group.id, group.sourceSignature, LIVE_PROGRESS_FAILURE_MAX);
        setBoundedMapValue(liveProgressDiagnostics, group.taskId, {
          status: 'error', code: 'LIVE_PROGRESS_REFRESH_FAILED', updatedAt,
        }, LIVE_PROGRESS_DIAGNOSTIC_MAX);
      }
      return false;
    })
    .finally(() => { liveProgressRefresh = null; });
  return liveProgressRefresh;
}

function taskTestProgressByTask(db, taskIds) {
  if (!taskIds.length) return new Map();
  refreshLiveTaskProgress(db, taskIds).catch(() => {});
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT task_id, report_key, report_type, status, revision, published_at, metrics_json, payload_json
    FROM (
      SELECT task_id, report_key, report_type, status, revision, published_at,
             json_extract(payload_json, '$.metrics') AS metrics_json, payload_json,
             ROW_NUMBER() OVER (PARTITION BY task_id, report_key ORDER BY revision DESC, published_at DESC) AS report_rank
      FROM skill_reports
      WHERE task_id IN (${placeholders}) AND report_type IN ('test-result', 'workflow-progress')
    ) latest_reports
    WHERE (report_type='workflow-progress' AND report_rank<=3) OR (report_type<>'workflow-progress' AND report_rank=1)
    ORDER BY task_id, report_key, revision DESC
  `).all(...taskIds);
  const latestByTask = new Map();
  for (const row of rows) {
    if (!latestByTask.has(row.task_id)) latestByTask.set(row.task_id, new Map());
    const reports = latestByTask.get(row.task_id);
    const reportKey = row.report_type === 'workflow-progress'
      ? `${row.report_key}\0${row.revision}` : row.report_key;
    reports.set(reportKey, row);
  }
  const liveRows = liveReportRows(db, taskIds);
  const liveGroupsByExecution = new Map();
  for (const group of liveReportGroups(liveRows)) {
    const key = `${group.taskId}\0${group.reportKey}\0${group.externalAttemptId}`;
    const groups = liveGroupsByExecution.get(key) || [];
    groups.push(group);
    liveGroupsByExecution.set(key, groups);
  }
  const liveSignatures = new Map();
  for (const row of liveRows) {
    const payload = parseJson(row.payload_json, {});
    const fallbackMetrics = new Map((Array.isArray(payload.metrics) ? payload.metrics : [])
      .filter(metric => metric && typeof metric.key === 'string')
      .map(metric => [metric.key.trim().toLowerCase(), Number(metric.value)]));
    const executionKey = `${row.task_id}\0${row.report_key}\0${row.external_attempt_id}`;
    const groups = liveGroupsByExecution.get(executionKey) || [];
    const liveCounts = { total: 0, passed: 0, failed: 0, error: 0, skipped: 0, xfailed: 0, xpassed: 0 };
    const liveSignaturesForExecution = [];
    let hasLiveCounts = false;
    for (const group of groups) {
      const live = liveProgressCache.get(group.id);
      if (!live || live.sourceSignature !== group.sourceSignature) continue;
      hasLiveCounts = true;
      for (const key of Object.keys(liveCounts)) liveCounts[key] += Number(live.counts?.[key] || 0);
      liveSignaturesForExecution.push(`${group.filePath}\0${live.signature}`);
    }
    if (!hasLiveCounts) continue;
    const liveSignature = liveSignaturesForExecution.sort().join('\0');
    const liveSignatureKey = `${row.task_id}\0${row.report_key}\0${row.external_attempt_id}`;
    liveSignatures.set(liveSignatureKey, liveSignature);
    const metrics = [
      { key: 'total', value: Math.max(liveCounts.total, finiteMetricValue(fallbackMetrics, ['total', 'selected']) || 0) },
      { key: 'passed', value: liveCounts.passed },
      { key: 'failed', value: liveCounts.failed },
      { key: 'error', value: liveCounts.error },
      { key: 'skipped', value: liveCounts.skipped },
      { key: 'xfailed', value: liveCounts.xfailed },
      { key: 'xpassed', value: liveCounts.xpassed },
      { key: 'executed', value: liveCounts.total - liveCounts.skipped },
    ];
    if (!latestByTask.has(row.task_id)) latestByTask.set(row.task_id, new Map());
    latestByTask.get(row.task_id).set(row.report_key, {
      ...row,
      metrics_json: JSON.stringify(metrics),
      status: 'running',
      liveSignature,
    });
  }
  const result = new Map();
  for (const taskId of taskIds) {
    const reports = latestByTask.get(taskId) || new Map();
    const signature = [...reports.values()]
      .map((row) => `${row.report_type}\0${row.report_key}\0${row.revision}\0${row.published_at || ''}\0${row.status}\0${row.liveSignature || liveSignatures.get(`${taskId}\0${row.report_key}\0${row.external_attempt_id || ''}`) || ''}`)
      .join('\x01');
    const cached = taskTestProgressCache.get(taskId);
    if (cached?.signature === signature) {
      if (liveRows.some(row => row.task_id === taskId)) cached.value.liveProgress = {
        ...(liveProgressDiagnostics.get(taskId) || { status: 'idle', code: '', updatedAt: '' }),
      };
      result.set(taskId, cached.value);
      continue;
    }
    const value = calculateTaskTestProgress([...reports.values()]);
    if (liveRows.some(row => row.task_id === taskId)) value.liveProgress = {
      ...(liveProgressDiagnostics.get(taskId) || { status: 'idle', code: '', updatedAt: '' }),
    };
    taskTestProgressCache.set(taskId, { signature, value });
    result.set(taskId, value);
  }
  while (taskTestProgressCache.size > TASK_TEST_PROGRESS_CACHE_MAX) {
    taskTestProgressCache.delete(taskTestProgressCache.keys().next().value);
  }
  return result;
}

async function refreshTaskTestProgress(db, taskIds) {
  const normalizedTaskIds = [...new Set((taskIds || []).map(String).filter(Boolean))];
  if (!normalizedTaskIds.length) return new Map();
  await refreshLiveTaskProgress(db, normalizedTaskIds);

  // Re-read after the worker finishes so callers receive this refresh's counts.
  return taskTestProgressByTask(db, normalizedTaskIds);
}

function calculateTaskTestProgress(reports) {
  const parsedReports = reports.map((report) => {
    let metrics;
    try { metrics = JSON.parse(report.metrics_json || '[]'); } catch { metrics = []; }
    return {
      ...report,
      values: new Map(Array.isArray(metrics)
        ? metrics.filter((metric) => metric && typeof metric.key === 'string')
          .map((metric) => [metric.key.trim().toLowerCase(), metric.value])
        : []),
    };
  });
  const workflowSummaries = parsedReports.filter((report) => report.report_type === 'workflow-progress');
  const finalSummary = workflowSummaries
    .filter((report) => finiteMetricValue(report.values, ['final_total']) != null)
    .sort((left, right) => Number(right.revision || 0) - Number(left.revision || 0))[0];
  const testReports = parsedReports.filter((report) => report.report_type !== 'workflow-progress');
  const aggregateParents = testReports.filter((report) => (
    reportRelatedKeys(report).length && reportHasProgressMetrics(report.values)
  ));
  const relatedChildKeys = new Set(aggregateParents.flatMap(report => reportRelatedKeys(report)));
  const independentReports = aggregateParents.length
    ? testReports.filter(report => !relatedChildKeys.has(report.report_key))
    : testReports;
  const runs = {
    initial: calculateTaskTestRunProgress(
      independentReports.filter((report) => taskReportRun(report) === 'initial'),
      latestWorkflowMetric(workflowSummaries, 'initial_total'),
    ),
    rerun1: calculateTaskTestRunProgress(
      independentReports.filter((report) => taskReportRun(report) === 'rerun1'),
      latestWorkflowMetric(workflowSummaries, 'rerun1_selected'),
    ),
  };
  const overall = finalSummary
    ? summaryTaskTestProgress(finalSummary.values, reportCompleteness(finalSummary))
    : combineTaskTestRunProgress(runs.initial, runs.rerun1);
  return { ...overall, runs };
}

function latestWorkflowMetric(reports, key) {
  return reports
    .map((report) => ({ report, value: finiteMetricValue(report.values, [key]) }))
    .filter((item) => item.value != null)
    .sort((left, right) => Number(right.report.revision || 0) - Number(left.report.revision || 0))[0]?.value ?? null;
}

function taskReportRun(report) {
  const key = String(report.report_key || '').toLowerCase();
  if (/(?:manual[-_. ]?rerun|recovery|targeted|retry)/.test(key)) return '';
  const rerun = /(?:^|[:._ -])rerun[-_. ]?(\d+)(?=$|[:._ -])/.exec(key);
  if (rerun) return rerun[1] === '1' ? 'rerun1' : '';
  return 'initial';
}

function reportRelatedKeys(report) {
  const payload = parseJson(report.payload_json, {});
  return Array.isArray(payload.relatedReportKeys)
    ? payload.relatedReportKeys.map(String)
    : [];
}

function reportHasProgressMetrics(values) {
  return [
    'total', 'selected', 'collected', 'passed', 'pass', 'failed', 'fail', 'error', 'errors',
    'skipped', 'skip', 'xfailed', 'xpassed', 'executed', 'business_executed', 'persistent',
    'bug', 'environment', 'env_issue', 'case_issue',
  ].some(key => finiteMetricValue(values, [key]) != null);
}

function reportCompleteness(report) {
  const payload = parseJson(report.payload_json, {});
  if (typeof payload.complete === 'boolean') return payload.complete;
  const source = Array.isArray(payload.sections)
    ? payload.sections.find((section) => section?.id === 'count-source')
    : null;
  const field = source?.fields?.find((item) => ['统计完整', 'Complete'].includes(String(item?.label || '')));
  return typeof field?.value === 'boolean' ? field.value : null;
}

function calculateTaskTestRunProgress(reports, fallbackTotal = null) {
  const progress = emptyTaskTestRunProgress();
  const backfillReports = reports.filter((report) => /^backfill:pytest-progress:(?:initial|rerun-1):/i.test(report.report_key || ''));
  const stageReports = reports.filter((report) => /(?:^|:)stage:[^:]+$/i.test(report.report_key || ''));
  const selectedReports = backfillReports.length ? backfillReports : (stageReports.length ? stageReports : reports);
  let hasMetric = false;
  let active = false;
  for (const report of selectedReports) {
    const { values } = report;
    const total = finiteMetricValue(values, ['total', 'selected', 'collected']);
    const passedDirect = finiteMetricValue(values, ['passed', 'pass']);
    const passed = passedDirect ?? (finiteMetricValue(values, ['flaky_pass', 'recovered']) || 0);
    const failedDirect = (finiteMetricValue(values, ['failed', 'fail']) || 0)
      + (finiteMetricValue(values, ['error', 'errors']) || 0);
    const failed = failedDirect || (finiteMetricValue(values, ['persistent', 'bug', 'environment', 'env_issue', 'case_issue']) || 0);
    const skipped = finiteMetricValue(values, ['skipped', 'skip']) || 0;
    const xfailed = finiteMetricValue(values, ['xfailed']) || 0;
    const xpassed = finiteMetricValue(values, ['xpassed']) || 0;
    const outcomeCount = passed + failed + skipped + xfailed + xpassed;
    const executed = finiteMetricValue(values, ['executed', 'business_executed']);
    if (total == null && executed == null && outcomeCount === 0) continue;
    hasMetric = true;
    progress.total += total == null ? outcomeCount : total;
    progress.completed += outcomeCount || executed || 0;
    progress.passed += passed;
    progress.failed += failed;
    progress.skipped += skipped;
    active ||= ['pending', 'running'].includes(String(report.status || '').toLowerCase());
  }
  if (!hasMetric && fallbackTotal == null) return progress;
  progress.available = true;
  progress.total = Math.max(progress.total, Number(fallbackTotal || 0), progress.completed);
  progress.completed = Math.min(progress.completed, progress.total);
  progress.resultKnown = progress.completed > 0 || progress.passed > 0 || progress.failed > 0 || progress.skipped > 0;
  if (!progress.resultKnown) {
    progress.percent = 0;
    progress.status = 'unknown';
    return progress;
  }
  progress.percent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  progress.status = active ? 'running'
    : (progress.failed > 0 ? 'failed'
      : (progress.total > 0 && progress.completed >= progress.total ? 'completed' : 'partial'));
  return progress;
}

function summaryTaskTestProgress(values, complete = null) {
  const total = finiteMetricValue(values, ['final_total']) || 0;
  const passed = finiteMetricValue(values, ['final_passed']) || 0;
  const failed = (finiteMetricValue(values, ['final_failed']) || 0)
    + (finiteMetricValue(values, ['final_error', 'final_errors']) || 0);
  const skipped = finiteMetricValue(values, ['final_skipped', 'final_skip']) || 0;
  const completeReport = complete !== false;
  const observed = Math.min(total, passed + failed + skipped);
  return {
    available: true,
    resultKnown: true,
    total,
    completed: completeReport ? total : observed,
    passed,
    failed,
    skipped,
    percent: completeReport && total ? 100 : 0,
    complete: completeReport,
    status: completeReport ? (failed > 0 ? 'failed' : 'completed') : 'partial',
  };
}

function combineTaskTestRunProgress(initial, rerun1) {
  const progress = emptyTaskTestRunProgress();
  if (!initial.available && !rerun1.available) return progress;
  progress.available = true;
  progress.resultKnown = initial.resultKnown || rerun1.resultKnown;
  progress.total = initial.total + rerun1.total;
  progress.completed = initial.completed + rerun1.completed;
  progress.passed = initial.passed + rerun1.passed;
  progress.failed = initial.failed + rerun1.failed;
  progress.skipped = initial.skipped + rerun1.skipped;
  progress.percent = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
  progress.status = initial.status === 'running' || rerun1.status === 'running' ? 'running'
    : (initial.status === 'failed' || rerun1.status === 'failed' ? 'failed'
      : (progress.completed >= progress.total ? 'completed' : 'partial'));
  return progress;
}

module.exports = {
  emptyTaskTestProgress,
  taskTestProgressByTask,
  refreshTaskTestProgress,
  refreshLiveTaskProgress,
};
