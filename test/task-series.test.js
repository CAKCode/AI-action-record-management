const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('release cycle schedules create independent Tasks and close stops future creation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-series-'));
  const dataDir = path.join(root, 'data');
  const runtimeDir = path.join(root, 'runtime');
  const workspaceRoot = path.join(root, 'workspaces');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const script = `
    const { getDatabase } = require('./src/database');
    const {
      createReleaseCycle, createTaskSeriesSchedule, claimDueTaskSeriesSchedules,
      closeReleaseCycle, listReleaseCycleTasks, listSessions, createReleaseCycleTask,
    } = require('./src/store');
    const cycle = createReleaseCycle({
      id: 'cloud-recording-v281', name: 'Cloud Recording v2.8.1',
      releaseKey: 'cloud-recording-v2.8.1', project: 'cloudRecord',
      taskTemplate: {
        name: 'Nightly full regression', objective: 'Run the full cloud recording workflow',
        workingDir: '.', workspaceMode: 'shared', sourceMode: 'shared-repo', tags: ['nightly'],
      },
    });
    const schedule = createTaskSeriesSchedule(cycle.id, {
      id: 'cloud-recording-v281-nightly', cron: '0 23 * * *', timezone: 'Asia/Shanghai',
    });
    getDatabase().prepare('UPDATE task_series_schedules SET next_run_at=? WHERE id=?')
      .run('2000-01-01T00:00:00.000Z', schedule.id);
    const dispatched = claimDueTaskSeriesSchedules('test-worker', 10);
    if (dispatched.length !== 1) throw new Error('expected one scheduled Task');
    const tasks = listReleaseCycleTasks(cycle.id, { limit: 20, offset: 0 });
    if (tasks.length !== 1 || tasks[0].releaseKey !== cycle.releaseKey) throw new Error('Task was not linked to the cycle');
    if (listSessions({ releaseKey: cycle.releaseKey, limit: 20, offset: 0 }).length !== 1) throw new Error('release filter failed');
    const manualA = createReleaseCycleTask(cycle.id, {}, { idempotencyKey: 'manual-series-key' });
    const manualB = createReleaseCycleTask(cycle.id, {}, { idempotencyKey: 'manual-series-key' });
    if (manualA.session.id !== manualB.session.id) throw new Error('manual series idempotency failed');
    closeReleaseCycle(cycle.id);
    const next = getDatabase().prepare('SELECT enabled FROM task_series_schedules WHERE id=?').get(schedule.id);
    if (next.enabled !== 0) throw new Error('schedule was not disabled');
    console.log(JSON.stringify({ cycle: cycle.id, schedule: schedule.id, task: tasks[0].id, status: next.enabled }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      CODEX_DESK_DATA_DIR: dataDir,
      CODEX_DESK_RUNTIME_DIR: runtimeDir,
      CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"status":0/);
});
