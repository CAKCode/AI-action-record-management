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
      const id = taskId + '-' + reportKey + '-' + revision;
      db.prepare('INSERT INTO skill_reports(id, task_id, report_key, revision, report_hash, schema_version, skill_id, skill_version, skill_content_hash, report_type, status, title, summary, payload_json, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, taskId, reportKey, revision, reportKey + '-' + revision, 2, 'test-skill', 1, '', reportType, 'partial', reportKey, reportKey, JSON.stringify({ metrics }), now);
      return id;
    };
    saveSession('progress-v3-18-0', { name: 'Release 3.18.0', objective: 'progress', workingDir: '.' });
    saveSession('progress-v3-19-1', { name: 'Release 3.19.1', objective: 'progress', workingDir: '.' });
    saveSession('progress-unknown', { name: 'Unknown progress', objective: 'progress', workingDir: '.' });
    saveSession('progress-business-only', { name: 'Business only', objective: 'progress', workingDir: '.' });
    saveSession('progress-rerun-ten', { name: 'Rerun ten', objective: 'progress', workingDir: '.' });
    saveSession('progress-incomplete-final', { name: 'Incomplete final', objective: 'progress', workingDir: '.' });
    saveSession('progress-parent-stage', { name: 'Parent stage', objective: 'progress', workingDir: '.' });
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
    insertReport(db, 'progress-business-only', 'coverage:summary', 'business-result', [
      { key: 'total', value: 100 }, { key: 'passed', value: 100 },
    ]);
    insertReport(db, 'progress-rerun-ten', 'stage:initial', 'test-result', [
      { key: 'total', value: 10 }, { key: 'passed', value: 10 },
    ]);
    insertReport(db, 'progress-rerun-ten', 'stage:rerun-10', 'test-result', [
      { key: 'selected', value: 10 }, { key: 'passed', value: 10 },
    ]);
    insertReport(db, 'progress-incomplete-final', 'summary', 'workflow-progress', [
      { key: 'final_total', value: 10 }, { key: 'final_passed', value: 10 },
    ]);
    const parentReportId = insertReport(db, 'progress-parent-stage', 'phase:initial', 'test-result', [
      { key: 'total', value: 10 }, { key: 'passed', value: 9 }, { key: 'failed', value: 1 },
    ]);
    insertReport(db, 'progress-parent-stage', 'child:a', 'test-result', [
      { key: 'total', value: 4 }, { key: 'passed', value: 4 },
    ]);
    insertReport(db, 'progress-parent-stage', 'child:b', 'test-result', [
      { key: 'total', value: 6 }, { key: 'passed', value: 5 }, { key: 'failed', value: 1 },
    ]);
    db.prepare('UPDATE skill_reports SET payload_json=? WHERE id=?').run(
      JSON.stringify({ metrics: [{ key: 'total', value: 10 }, { key: 'passed', value: 9 }, { key: 'failed', value: 1 }], relatedReportKeys: ['child:a', 'child:b'] }),
      parentReportId,
    );
    db.prepare('UPDATE skill_reports SET payload_json=? WHERE task_id=?').run(
      JSON.stringify({
        metrics: [{ key: 'final_total', value: 10 }, { key: 'final_passed', value: 10 }],
        sections: [{ id: 'count-source', fields: [{ label: '统计完整', value: false }] }],
      }),
      'progress-incomplete-final',
    );
    const tasks = listSessions({ limit: 20, internal: true });
    if (tasks.findIndex(task => task.id === 'progress-v3-19-1') > tasks.findIndex(task => task.id === 'progress-v3-18-0')) throw new Error('creation order was not applied');
    const page = listSessions({ limit: 1, offset: 5, internal: true });
    if (page.length !== 1 || page[0].id !== 'progress-v3-18-0') throw new Error('unexpected task page: ' + JSON.stringify(page));
    const progress = tasks.find(task => task.id === 'progress-v3-19-1').testProgress;
    if (progress.runs.initial.completed !== 4 || progress.runs.rerun1.completed !== 1) throw new Error(JSON.stringify(progress));
    if (progress.runs.initial.status !== 'failed') throw new Error(JSON.stringify(progress));
    if (progress.runs.rerun1.passed !== 1 || progress.runs.rerun1.failed !== 0) throw new Error(JSON.stringify(progress));
    const unknown = tasks.find(task => task.id === 'progress-unknown').testProgress.runs.initial;
    if (unknown.status !== 'unknown' || unknown.total !== 10) throw new Error(JSON.stringify(unknown));
    const businessOnly = tasks.find(task => task.id === 'progress-business-only').testProgress;
    if (businessOnly.runs.initial.available) throw new Error('business-result polluted test progress');
    const rerunTen = tasks.find(task => task.id === 'progress-rerun-ten').testProgress;
    if (rerunTen.runs.rerun1.available) throw new Error('rerun-10 was classified as rerun-1');
    const incompleteFinal = tasks.find(task => task.id === 'progress-incomplete-final').testProgress;
    if (incompleteFinal.status === 'completed' || incompleteFinal.percent !== 0 || incompleteFinal.complete !== false) {
      throw new Error(JSON.stringify(incompleteFinal));
    }
    const parentStage = tasks.find(task => task.id === 'progress-parent-stage').testProgress;
    if (parentStage.runs.initial.total !== 10 || parentStage.runs.initial.failed !== 1) {
      throw new Error('parent stage and child reports were double-counted: ' + JSON.stringify(parentStage));
    }
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
