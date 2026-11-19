const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-progress-pid-shape-'));
for (const name of ['data', 'runtime', 'workspace']) fs.mkdirSync(path.join(root, name));
Object.assign(process.env, {
  CODEX_DESK_DATA_DIR: path.join(root, 'data'),
  CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
  CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'workspace'),
});

const { getDatabase, closeDatabase } = require('../src/database');
const { saveSession } = require('../src/store');
const { refreshTaskTestProgress } = require('../src/task-test-progress');

const taskId = 'progress-pid-shape';
const now = new Date().toISOString();

function writeReport(name, nodeId, result) {
  const filePath = path.join(root, 'workspace', name);
  const payload = JSON.stringify({ tests: { [nodeId]: [{ result }] } }).replace(/"/g, '&quot;');
  fs.writeFileSync(filePath, `<div data-jsonblob="${payload}">`);
  return filePath;
}

function insertExternal(db, id, reportPath) {
  db.prepare(`INSERT INTO external_attempts(
    id, task_id, chain_key, generation, label, status, log_path, meta_path,
    artifact_declarations_json, started_at, created_at, updated_at
  ) VALUES (?, ?, ?, 1, ?, 'running', ?, ?, ?, ?, ?, ?)`)
    .run(id, taskId, id, id, `${reportPath}.log`, `${reportPath}.meta`, JSON.stringify([
      { key: id, kind: 'pytest-html', path: reportPath },
    ]), now, now, now);
}

function insertReport(db, id, reportKey, externalAttemptId, revision) {
  db.prepare(`INSERT INTO skill_reports(
    id, task_id, report_key, revision, report_hash, schema_version, skill_id,
    skill_version, skill_content_hash, report_type, status, title, summary,
    payload_json, published_at
  ) VALUES (?, ?, ?, ?, ?, 2, 'fixture-test', 1, '', 'test-result', 'running', ?, ?, ?, ?)`)
    .run(id, taskId, reportKey, revision, id, reportKey, reportKey, JSON.stringify({
      metrics: [{ key: 'selected', value: 1 }],
      executionEvidence: { externalAttemptId },
    }), now);
}

test.after(() => {
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test('progress handles one PID and multiple PIDs without merging HTML cases', async () => {
  saveSession(taskId, { name: 'PID shape', objective: 'progress', workingDir: '.' });
  const db = getDatabase();
  const first = writeReport('pid-1.html', 'same-node', 'Passed');
  const second = writeReport('pid-2.html', 'same-node', 'Failed');
  insertExternal(db, 'external-pid-1', first);
  insertExternal(db, 'external-pid-2', second);
  insertReport(db, 'report-pid-1', 'stage:initial', 'external-pid-1', 1);
  insertReport(db, 'report-pid-2', 'stage:initial', 'external-pid-2', 2);

  const progress = (await refreshTaskTestProgress(db, [taskId])).get(taskId).runs.initial;
  assert.equal(progress.total, 2);
  assert.equal(progress.completed, 2);
  assert.equal(progress.passed, 1);
  assert.equal(progress.failed, 1);
  assert.equal(progress.status, 'running');
});
