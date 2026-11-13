const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('release cycle analysis keeps Feature and regression Tasks in separate groups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-release-analysis-'));
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const script = `
    const { createReleaseCycle, createReleaseCycleTask, listReleaseCycleAnalysis, linkTaskToReleaseCycle, saveSession } = require('./src/store');
    (async () => {
      const cycle = createReleaseCycle({
        id: 'analysis-cycle', name: 'Analysis cycle', releaseKey: 'analysis-v1', project: 'cloudRecord',
        taskTemplate: { name: 'Feature task', objective: 'Run feature checks', workingDir: '.', workspaceMode: 'shared', sourceMode: 'shared-repo', testType: 'feature' },
      });
      createReleaseCycleTask(cycle.id, {}, { idempotencyKey: 'feature-task' });
      saveSession('regression-task', { name: 'Regression task', objective: 'Run regression', workingDir: '.', testType: 'regression' });
      linkTaskToReleaseCycle('regression-task', cycle.id);
      const all = await listReleaseCycleAnalysis(cycle.id, { testType: 'all' });
      const feature = await listReleaseCycleAnalysis(cycle.id, { testType: 'feature' });
      if (all.summary.taskCount !== 2 || all.groups.feature.summary.taskCount !== 1 || all.groups.regression.summary.taskCount !== 1) throw new Error('analysis groups were not separated');
      if (feature.summary.taskCount !== 1 || feature.groups.feature.tasks[0].testType !== 'feature') throw new Error('feature filter failed');
      console.log(JSON.stringify({ ok: true }));
    })().catch(error => { console.error(error.stack || error.message); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      CODEX_DESK_DATA_DIR: path.join(root, 'data'),
      CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
      CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('release cycle analysis reports rerun-1 case transitions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-release-analysis-results-'));
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const script = `
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const path = require('node:path');
    const { getDatabase } = require('./src/database');
    const { createReleaseCycle, createReleaseCycleTask, listReleaseCycleAnalysis } = require('./src/store');
    const now = new Date().toISOString();
    const reportFile = (name, results) => {
      const tests = Object.fromEntries(Object.entries(results).map(([nodeid, result]) => [nodeid, [{ result }]]));
      const content = '<html><div data-jsonblob="' + JSON.stringify({ tests }).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"></div></html>';
      const filePath = path.join(process.env.CODEX_TASK_WORKSPACE_ROOTS, name);
      fs.writeFileSync(filePath, content);
      return { filePath, bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') };
    };
    (async () => {
      const cycle = createReleaseCycle({
        id: 'result-cycle', name: 'Result cycle', releaseKey: 'result-v1', project: 'cloudRecord',
        taskTemplate: { name: 'Regression task', objective: 'Run regression', workingDir: '.', workspaceMode: 'shared', sourceMode: 'shared-repo', testType: 'regression' },
      });
      const created = createReleaseCycleTask(cycle.id, {}, { idempotencyKey: 'result-task' });
      const taskId = created.session.id;
      const db = getDatabase();
      const stepId = 'step-result';
      db.prepare('INSERT INTO task_steps(id, task_id, step_key, label, ordinal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(stepId, taskId, 'regression', 'Regression', 1, 'succeeded', now, now);
      db.prepare('INSERT INTO step_runs(id, task_id, step_id, run_key, run_kind, run_number, status, started_at, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('run-initial', taskId, stepId, 'initial', 'initial', 1, 'succeeded', now, now, now, now);
      db.prepare('INSERT INTO step_runs(id, task_id, step_id, run_key, run_kind, run_number, source_run_id, status, started_at, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('run-rerun-1', taskId, stepId, 'rerun-1', 'rerun', 2, 'run-initial', 'succeeded', now, now, now, now);
      const reports = [
        ['report-initial', 'run-initial', 'initial', reportFile('initial.html', { caseA: 'Failed', caseB: 'Passed' })],
        ['report-rerun-1', 'run-rerun-1', 'rerun-1', reportFile('rerun-1.html', { caseA: 'Passed' })],
      ];
      for (const [reportId, stepRunId, runKey, artifact] of reports) {
        const payload = { artifacts: [{ key: runKey, kind: 'pytest-html', path: artifact.filePath }] };
        db.prepare('INSERT INTO skill_reports(id, task_id, step_run_id, report_key, revision, report_hash, schema_version, skill_id, skill_version, skill_content_hash, report_type, status, title, summary, payload_json, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(reportId, taskId, stepRunId, 'result:' + runKey, 1, artifact.sha256, 2, 'cloud-recording-test', 1, '', 'test-result', 'succeeded', runKey, runKey, JSON.stringify(payload), now);
        db.prepare('INSERT INTO skill_report_artifacts(id, task_id, report_id, artifact_key, label, kind, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('artifact-' + runKey, taskId, reportId, runKey, runKey, 'pytest-html', runKey + '.html', 'text/html', artifact.filePath, artifact.bytes, artifact.sha256, now);
      }
      const result = await listReleaseCycleAnalysis(cycle.id, { testType: 'regression' });
      const task = result.groups.regression.tasks[0];
      if (task.transitions.recovered !== 1 || task.transitions.persistent !== 0 || task.targetInitial.passRate !== 0 || task.rerun.passRate !== 1) throw new Error(JSON.stringify(task));
      console.log(JSON.stringify({ ok: true }));
    })().catch(error => { console.error(error.stack || error.message); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      CODEX_DESK_DATA_DIR: path.join(root, 'data'),
      CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
      CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
  fs.rmSync(root, { recursive: true, force: true });
});
