const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-progress-live-multipid-'));
for (const name of ['data', 'runtime', 'workspace']) fs.mkdirSync(path.join(root, name));
Object.assign(process.env, {
  CODEX_DESK_DATA_DIR: path.join(root, 'data'),
  CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
  CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'workspace'),
});

const { getDatabase, closeDatabase } = require('../src/database');
const { saveSession } = require('../src/store');
const { refreshTaskTestProgress } = require('../src/task-test-progress');

const taskId = 'live-progress-multipid';
const now = new Date().toISOString();

function writeReport(fileName, tests) {
  const filePath = path.join(root, 'workspace', fileName);
  const payload = JSON.stringify({ tests }).replace(/"/g, '&quot;');
  fs.writeFileSync(filePath, `<div data-jsonblob="${payload}">`);
  return filePath;
}

function insertExternalAttempt(db, id, reportKey, reportPath) {
  db.prepare(`INSERT INTO external_attempts(
    id, task_id, chain_key, generation, label, status, log_path, meta_path,
    artifact_declarations_json, started_at, created_at, updated_at
  ) VALUES (?, ?, ?, 1, ?, 'running', ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      taskId,
      `${reportKey}:${id}`,
      reportKey,
      `${reportPath}.log`,
      `${reportPath}.meta`,
      JSON.stringify([{ key: id, kind: 'pytest-html', path: reportPath }]),
      now,
      now,
      now,
    );
}

function insertReport(db, id, reportKey, externalAttemptId, selected, revision = 1) {
  db.prepare(`INSERT INTO skill_reports(
    id, task_id, report_key, revision, report_hash, schema_version, skill_id,
    skill_version, skill_content_hash, report_type, status, title, summary,
    payload_json, published_at
  ) VALUES (?, ?, ?, ?, ?, 2, 'fixture-test', 1, '', 'test-result', 'running', ?, ?, ?, ?)`)
    .run(
      id,
      taskId,
      reportKey,
      revision,
      id,
      reportKey,
      reportKey,
      JSON.stringify({
        metrics: [{ key: 'selected', value: selected }],
        executionEvidence: { externalAttemptId },
      }),
      now,
    );
}

test.after(() => {
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test('live progress merges all active PIDs and keeps single PID reports visible', async () => {
  saveSession(taskId, { name: 'Live progress', objective: 'Track pytest', workingDir: '.' });
  const db = getDatabase();
  const singlePath = writeReport('single.html', {
    single: [{ result: 'Passed' }],
  });
  const parallelPathA = writeReport('parallel-a.html', {
    caseA: [{ result: 'Passed' }],
    caseB: [{ result: 'Failed' }],
  });
  const parallelPathB = writeReport('parallel-b.html', {
    caseC: [{ result: 'Passed' }],
  });

  insertExternalAttempt(db, 'external-single', 'suite:single', singlePath);
  insertExternalAttempt(db, 'external-parallel-a', 'suite:parallel', parallelPathA);
  insertExternalAttempt(db, 'external-parallel-b', 'suite:parallel', parallelPathB);
  insertReport(db, 'report-single', 'suite:single', 'external-single', 1);
  insertReport(db, 'report-parallel-a', 'suite:parallel', 'external-parallel-a', 2);
  insertReport(db, 'report-parallel-b', 'suite:parallel', 'external-parallel-b', 1, 2);

  const progress = (await refreshTaskTestProgress(db, [taskId])).get(taskId);
  assert.deepEqual(progress.runs.initial, {
    available: true,
    resultKnown: true,
    total: 4,
    completed: 4,
    passed: 3,
    failed: 1,
    skipped: 0,
    percent: 100,
    status: 'failed',
  });
});
