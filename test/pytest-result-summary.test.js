const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readTaskPytestSummary } = require('../src/pytest-result-summary');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pytest-result-summary-'));
let sequence = 0;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function report(scope, results, options = {}) {
  const id = `report-${++sequence}`;
  const tests = Object.fromEntries(Object.entries(results).map(([nodeid, result]) => [nodeid,
    (Array.isArray(result) ? result : [result]).map(result => ({ result }))]));
  const encoded = JSON.stringify({ tests }).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const content = `<html><div data-jsonblob="${encoded}"></div></html>`;
  const filePath = path.join(root, `${id}.html`);
  fs.writeFileSync(filePath, content);
  return { id, filePath, bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex'),
    scope, executionKey: id, at: `2026-10-27T12:${String(sequence).padStart(2, '0')}:00Z`, ...options };
}

test('counts all executions and applies reruns within the same test target', async () => {
  const initial = report('gw51', { a: 'Passed', b: 'Failed', c: 'Skipped', d: 'XFailed' });
  const secondTarget = report('gw53', { a: 'Failed', b: 'Passed' });
  const rerun = report('gw51', { b: 'Passed' }, { rerun: true });
  const stillFailed = report('gw53', { a: 'Failed' }, { rerun: true });
  const result = await readTaskPytestSummary([initial, secondTarget, rerun, stillFailed]);
  assert.equal(result.complete, true);
  assert.equal(result.cumulative.total, 8);
  assert.equal(result.cumulative.passed, 3);
  assert.equal(result.cumulative.failed, 3);
  assert.equal(result.cumulative.skipped, 1);
  assert.equal(result.cumulative.xfailed, 1);
  assert.equal(result.final.total, 6);
  assert.equal(result.final.passed, 3);
  assert.equal(result.final.failed, 1);
  assert.equal(result.executed, 7);
});

test('does not count reused report revisions twice, while independent executions remain distinct', async () => {
  const original = report('suite', { a: 'Passed' });
  const alias = { ...original, id: 'revision-copy' };
  const independent = { ...original, id: 'independent', executionKey: 'different-execution', scope: 'other-target' };
  const result = await readTaskPytestSummary([original, alias, independent]);
  assert.equal(result.reportCount, 2);
  assert.equal(result.cumulative.total, 2);
  assert.equal(result.final.total, 2);
  assert.deepEqual(await readTaskPytestSummary([original, alias, independent]), result);
});

test('setup and teardown rows do not inflate case counts and errors override a successful call', async () => {
  const result = await readTaskPytestSummary([report('suite', { a: ['Passed', 'Error'], b: ['Passed', 'Passed'] })]);
  assert.equal(result.cumulative.total, 2);
  assert.equal(result.cumulative.passed, 1);
  assert.equal(result.cumulative.error, 1);
});

test('missing, changing and unreadable reports remain incomplete instead of becoming zero failures', async () => {
  const valid = report('suite', { a: 'Failed' });
  const damaged = report('suite', { b: 'Passed' });
  fs.appendFileSync(damaged.filePath, 'changed');
  const result = await readTaskPytestSummary([valid, damaged, { id: 'pending', scope: 'suite', running: true }]);
  assert.equal(result.available, true);
  assert.equal(result.complete, false);
  assert.equal(result.pendingReports, 1);
  assert.equal(result.failures[0].code, 'PYTEST_REPORT_INTEGRITY');
  assert.equal(result.final.failed, 1);
  assert.equal(JSON.stringify(result).includes(root), false);
});

test('a terminal report replaces its running state and an unmatched rerun is disclosed', async () => {
  const entry = report('suite', { a: 'Passed' }, { running: true });
  const waiting = await readTaskPytestSummary([entry]);
  assert.equal(waiting.available, false);
  assert.equal(waiting.complete, false);
  const terminal = await readTaskPytestSummary([{ ...entry, running: false }]);
  assert.equal(terminal.complete, true);
  assert.equal(terminal.final.passed, 1);
  const unmatched = await readTaskPytestSummary([{ ...entry, running: false, rerun: true }]);
  assert.equal(unmatched.complete, false);
  assert.equal(unmatched.unmatchedRerunCases, 1);
});

test('an empty business Task has no pytest statistics', async () => {
  const result = await readTaskPytestSummary([]);
  assert.equal(result.available, false);
  assert.equal(result.final.total, 0);
});
