const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Task progress separates initial and rerun-1 and keeps unknown results explicit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-progress-'));
  const script = `
    const { getDatabase } = require('./src/database');
    const { saveSession, listSessions } = require('./src/store');
    const now = new Date().toISOString();
    const insertReport = (db, taskId, reportKey, reportType, metrics, revision = 1) => {
      db.prepare('INSERT INTO skill_reports(id, task_id, report_key, revision, report_hash, schema_version, skill_id, skill_version, skill_content_hash, report_type, status, title, summary, payload_json, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(taskId + '-' + reportKey + '-' + revision, taskId, reportKey, revision, reportKey + '-' + revision, 2, 'test-skill', 1, '', reportType, 'partial', reportKey, reportKey, JSON.stringify({ metrics }), now);
    };
    saveSession('progress-v3-18-0', { name: 'Release 3.18.0', objective: 'progress', workingDir: '.' });
    saveSession('progress-v3-19-1', { name: 'Release 3.19.1', objective: 'progress', workingDir: '.' });
    saveSession('progress-unknown', { name: 'Unknown progress', objective: 'progress', workingDir: '.' });
    const db = getDatabase();
    db.prepare('UPDATE tasks SET created_at=? WHERE id=?').run('2026-11-01T00:00:00.000Z', 'progress-v3-18-0');
    db.prepare('UPDATE tasks SET created_at=? WHERE id=?').run('2026-11-02T00:00:00.000Z', 'progress-v3-19-1');
    db.prepare('UPDATE tasks SET created_at=? WHERE id=?').run('2026-10-01T00:00:00.000Z', 'progress-unknown');
    insertReport(db, 'progress-v3-19-1', 'stage:initial', 'test-result', [
      { key: 'total', value: 4 }, { key: 'passed', value: 3 }, { key: 'failed', value: 1 },
    ]);
    insertReport(db, 'progress-v3-19-1', 'stage:rerun-1', 'test-result', [
      { key: 'selected', value: 1 }, { key: 'recovered', value: 1 }, { key: 'persistent', value: 0 },
    ]);
    insertReport(db, 'progress-v3-19-1', 'summary', 'workflow-progress', [
      { key: 'initial_total', value: 4 }, { key: 'rerun1_selected', value: 1 },
      { key: 'final_total', value: 4 }, { key: 'final_passed', value: 4 }, { key: 'final_failed', value: 0 },
    ]);
    insertReport(db, 'progress-unknown', 'stage:initial', 'test-result', [{ key: 'total', value: 10 }]);
    const tasks = listSessions({ limit: 20, internal: true });
    if (tasks.findIndex(task => task.id === 'progress-v3-19-1') > tasks.findIndex(task => task.id === 'progress-v3-18-0')) throw new Error('creation order was not applied');
    const progress = tasks.find(task => task.id === 'progress-v3-19-1').testProgress;
    if (progress.runs.initial.completed !== 4 || progress.runs.rerun1.completed !== 1) throw new Error(JSON.stringify(progress));
    if (progress.runs.rerun1.passed !== 1 || progress.runs.rerun1.failed !== 0) throw new Error(JSON.stringify(progress));
    const unknown = tasks.find(task => task.id === 'progress-unknown').testProgress.runs.initial;
    if (unknown.status !== 'unknown' || unknown.total !== 10) throw new Error(JSON.stringify(unknown));
    console.log(JSON.stringify({ ok: true }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      CODEX_DESK_DATA_DIR: path.join(root, 'data'),
      CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
      CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'workspaces'),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
  fs.rmSync(root, { recursive: true, force: true });
});
