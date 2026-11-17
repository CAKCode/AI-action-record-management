const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('Task progress separates initial and rerun-1 and keeps unknown results explicit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-progress-'));
  const script = `(async () => {
    const { getDatabase } = require('./src/database');
    const { saveSession, listSessions } = require('./src/store');
    const { refreshLiveTaskProgress } = require('./src/task-test-progress');
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
    saveSession('progress-live-report', { name: 'Live report', objective: 'progress', workingDir: '.' });
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
    const livePath = require('path').join(process.env.CODEX_TASK_WORKSPACE_ROOTS, 'live-report.html');
    const livePayload = JSON.stringify({ tests: { 'case-a': [{ result: 'Passed' }], 'case-b': [{ result: 'Passed' }], 'case-c': [{ result: 'Failed' }] } });
    require('fs').writeFileSync(livePath, '<div data-jsonblob="' + livePayload.replace(/"/g, '&quot;') + '">');
    const livePath2 = require('path').join(process.env.CODEX_TASK_WORKSPACE_ROOTS, 'live-report-2.html');
    const livePayload2 = JSON.stringify({ tests: { 'case-c': [{ result: 'Failed' }], 'case-d': [{ result: 'Passed' }] } });
    require('fs').writeFileSync(livePath2, '<div data-jsonblob="' + livePayload2.replace(/"/g, '&quot;') + '">');
    const externalId = 'external-live-report';
    db.prepare("INSERT INTO external_attempts(id, task_id, chain_key, generation, label, status, log_path, meta_path, artifact_declarations_json, started_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 'running', ?, ?, ?, ?, ?, ?)")
      .run(externalId, 'progress-live-report', 'live-chain', 'Live pytest', livePath + '.log', livePath + '.meta', JSON.stringify([
        { key: 'live', kind: 'pytest-html', path: livePath },
        { key: 'live-2', kind: 'pytest-html', path: livePath2 },
      ]), now, now, now);
    const liveReportId = insertReport(db, 'progress-live-report', 'live:initial', 'test-result', [
      { key: 'selected', value: 5 },
    ]);
    db.prepare('UPDATE skill_reports SET payload_json=? WHERE id=?').run(JSON.stringify({
      metrics: [{ key: 'selected', value: 5 }], executionEvidence: { externalAttemptId: externalId },
    }), liveReportId);
    db.prepare('UPDATE skill_reports SET payload_json=? WHERE id=?').run(
      JSON.stringify({ metrics: [{ key: 'total', value: 10 }, { key: 'passed', value: 9 }, { key: 'failed', value: 1 }], relatedReportKeys: ['child:a', 'child:b'] }),
      parentReportId,
    );
    db.prepare('UPDATE skill_reports SET payload_json=? WHERE task_id=?').run(
      JSON.stringify({
        metrics: [{ key: 'final_total', value: 10 }, { key: 'final_passed', value: 4 }],
        sections: [{ id: 'count-source', fields: [{ label: '统计完整', value: false }] }],
      }),
      'progress-incomplete-final',
    );
    await refreshLiveTaskProgress(db, ['progress-live-report']);
    const tasks = listSessions({ limit: 20, internal: true });
    if (tasks.findIndex(task => task.id === 'progress-v3-19-1') > tasks.findIndex(task => task.id === 'progress-v3-18-0')) throw new Error('creation order was not applied');
    const page = listSessions({ limit: 1, offset: 6, internal: true });
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
    if (incompleteFinal.status !== 'partial' || incompleteFinal.percent !== 40 || incompleteFinal.completed !== 4 || incompleteFinal.complete !== false) {
      throw new Error(JSON.stringify(incompleteFinal));
    }
    const parentStage = tasks.find(task => task.id === 'progress-parent-stage').testProgress;
    if (parentStage.runs.initial.total !== 10 || parentStage.runs.initial.failed !== 1) {
      throw new Error('parent stage and child reports were double-counted: ' + JSON.stringify(parentStage));
    }
    const live = tasks.find(task => task.id === 'progress-live-report').testProgress.runs.initial;
    if (live.total !== 5 || live.completed !== 4 || live.passed !== 3 || live.failed !== 1 || live.status !== 'running') {
      throw new Error('live pytest report was not used: ' + JSON.stringify(live));
    }
    console.log(JSON.stringify({ ok: true }));
  })();
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
