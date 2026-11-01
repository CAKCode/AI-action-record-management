const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-runtime-lifecycle-'));
const workspace = path.join(root, 'workspaces');
fs.mkdirSync(workspace);
process.env.CODEX_DESK_DATA_DIR = path.join(root, 'data');
process.env.CODEX_DESK_RUNTIME_DIR = path.join(root, 'runtime');
process.env.CODEX_TASK_WORKSPACE_ROOTS = workspace;
process.env.CODEX_TASK_SESSIONS_DIR = path.join(workspace, 'sessions');
const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
const { nextCronAt } = require('../src/task-series');
const { createIdleTaskRuntimeManager } = require('../src/idle-task-runtime');

function cycle(id, enabled = true, policy = 'queue') {
  store.createReleaseCycle({ id, name: id, releaseKey: id,
    taskTemplate: { name: id, objective: 'local fixture', workingDir: '.', workspaceMode: 'shared', enabled } });
  return store.createTaskSeriesSchedule(id, { id: `${id}-schedule`, cron: '0 23 * * *', overlapPolicy: policy });
}
function due(id, ago = 1000) {
  getDatabase().prepare('UPDATE task_series_schedules SET next_run_at=? WHERE id=?')
    .run(new Date(Date.now() - ago).toISOString(), id);
}
function tasks(id) { return store.listReleaseCycleTasks(id, { limit: 100 }); }
function idleTask(id, status = 'waiting_review') {
  store.saveSession(id, { name: id, objective: 'local fixture', workingDir: '.' });
  getDatabase().prepare(`UPDATE tasks SET status=?,persistent_session_key=?,
    last_finished_at='2000-01-01T00:00:00.000Z' WHERE id=?`).run(status, `single:${id}`, id);
}
test.after(() => { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

test('queue policy serializes a series while unrelated tasks remain runnable', () => {
  const schedule = cycle('serial');
  due(schedule.id, 2000); store.claimDueTaskSeriesSchedules('worker');
  const first = tasks('serial')[0];
  due(schedule.id); store.claimDueTaskSeriesSchedules('worker');
  const second = tasks('serial').find(t => t.id !== first.id);
  store.createAndQueueSession('unrelated', { name: 'unrelated', objective: 'local fixture', workingDir: '.' });
  const claimed = store.claimPendingCommands('worker', 100).map(c => c.task_id);
  assert(claimed.includes(first.id)); assert(claimed.includes('unrelated'));
  assert(!claimed.includes(second.id));
  assert.equal(store.acquireTaskLease(second.id, 'worker'), false);
  getDatabase().prepare("UPDATE tasks SET status='waiting_scheduled' WHERE id=?").run(first.id);
  assert.equal(store.acquireTaskLease(second.id, 'worker'), false);
  getDatabase().prepare("UPDATE tasks SET status='waiting_review' WHERE id=?").run(first.id);
  assert.equal(store.acquireTaskLease(second.id, 'worker'), true);
});

test('skip and parallel overlap policies perform their configured behavior', () => {
  for (const policy of ['skip', 'parallel']) {
    const id = `overlap-${policy}`;
    const schedule = cycle(id, true, policy);
    due(schedule.id, 2000); store.claimDueTaskSeriesSchedules('worker');
    due(schedule.id); const dispatch = store.claimDueTaskSeriesSchedules('worker');
    assert.equal(tasks(id).length, policy === 'skip' ? 1 : 2);
    if (policy === 'skip') assert(dispatch.some(row => row.skipped === 'previous_run_active'));
  }
});

test('a bad schedule retries independently without rolling back a good schedule', () => {
  const good = cycle('healthy-plan'); const bad = cycle('disabled-plan', false);
  due(good.id, 2000); due(bad.id);
  const result = store.claimDueTaskSeriesSchedules('worker');
  assert.equal(tasks('healthy-plan').length, 1);
  assert.equal(tasks('disabled-plan').length, 0);
  assert(result.some(item => item.scheduleId === bad.id && item.error));
  const saved = getDatabase().prepare('SELECT * FROM task_series_schedules WHERE id=?').get(bad.id);
  assert.equal(saved.failure_count, 1);
  assert(saved.next_attempt_at > new Date().toISOString());
  assert.doesNotThrow(() => store.claimDueTaskSeriesSchedules('worker'));
  assert.equal(getDatabase().prepare('SELECT failure_count FROM task_series_schedules WHERE id=?').get(bad.id).failure_count, 1);
});

test('closed-cycle create rolls back Task, command and cycle association together', () => {
  cycle('closed'); store.closeReleaseCycle('closed');
  const body = { name: 'closed-task', objective: 'local fixture', workingDir: '.', releaseCycleId: 'closed' };
  assert.throws(() => store.createAndQueueSession('closed-task', body, '', 'closed-key'), /Closed/);
  assert.equal(store.getSession('closed-task'), null);
  assert.equal(getDatabase().prepare('SELECT 1 FROM commands WHERE idempotency_key=?').get('closed-key'), undefined);
  assert.throws(() => store.saveSession('closed-idle', body), /Closed/);
  assert.equal(store.getSession('closed-idle'), null);
});

test('create-and-run replay preserves the same cycle after cycle closure', () => {
  cycle('replay');
  const body = { name: 'replay-task', objective: 'local fixture', workingDir: '.', releaseCycleId: 'replay' };
  const first = store.createAndQueueSession('replay-task', body, '', 'cycle-replay');
  store.closeReleaseCycle('replay');
  const repeated = store.createAndQueueSession('replay-task', body, '', 'cycle-replay');
  assert.equal(repeated.session.id, first.session.id);
  assert.equal(repeated.session.releaseCycleId, 'replay');
  assert.equal(repeated.created, false);
  assert.throws(() => store.createAndQueueSession('replay-task', { ...body, releaseCycleId: '' }, '', 'cycle-replay'), /release cycle/);
});

test('an idle release lease defers Worker starts and retains the Session key', () => {
  idleTask('idle-lease');
  const lease = store.claimIdleTaskRuntime('idle-lease');
  assert(lease);
  assert.equal(lease.sourceDir, workspace);
  store.queueSessionRun('idle-lease', 'continue', 'continue-idle');
  assert.equal(store.acquireTaskLease('idle-lease', 'worker'), false);
  assert(!store.claimPendingCommands('worker', 100).some(c => c.task_id === 'idle-lease'));
  store.finishIdleTaskRuntimeRelease(lease, { sessionId: 'session-idle', released: [123], errors: [] });
  assert.equal(store.getSession('idle-lease').persistentSessionKey, 'single:idle-lease');
  assert(store.claimPendingCommands('worker', 100).some(c => c.task_id === 'idle-lease'));
  assert.equal(store.acquireTaskLease('idle-lease', 'worker'), true);
});

test('idle cleanup excludes managed Turns but includes background-waiting and failed Tasks', () => {
  for (const status of ['running', 'queued', 'recovering', 'waiting_scheduled', 'failed', 'waiting_input', 'completed']) {
    const id = `idle-${status}`; idleTask(id, status);
    assert.equal(Boolean(store.claimIdleTaskRuntime(id)), !['running', 'queued', 'recovering'].includes(status));
  }
});

test('reconnect waits for release, while a connected CLI is excluded from cleanup', async () => {
  let finishRelease; let finished = false; let claims = 0;
  const manager = createIdleTaskRuntimeManager({
    list: () => ['connected', 'idle'],
    isInteractive: id => id === 'connected',
    claim: taskId => { claims++; return { taskId, sessionKey: 'single:history', sourceDir: workspace }; },
    release: (sessionKey, options) => {
      assert.equal(sessionKey, 'single:history');
      assert.equal(options.sourceDir, workspace);
      return new Promise(resolve => { finishRelease = resolve; });
    },
    finish: () => { finished = true; }, getRelease: () => null,
  });
  const sweep = manager.sweep(); await new Promise(resolve => setImmediate(resolve));
  let connected = false;
  const reconnect = manager.beforeConnect('idle').then(() => { connected = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(connected, false);
  finishRelease({ sessionId: 'history', released: [123], errors: [] });
  await Promise.all([reconnect, sweep]);
  assert.equal(connected, true); assert.equal(finished, true); assert.equal(claims, 1);
  await manager.shutdown();
});

test('an unresolved Session release records failure and clears its coordination lease', async () => {
  const id = 'idle-unresolved-runtime';
  idleTask(id);
  const manager = createIdleTaskRuntimeManager({
    list: () => [id], isInteractive: () => false,
    claim: taskId => ({ ...store.claimIdleTaskRuntime(taskId), sourceDir: '' }),
    finish: store.finishIdleTaskRuntimeRelease, getRelease: store.getTaskRuntimeRelease,
  });
  try {
    const [result] = await manager.sweep();
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /source directory.*unavailable/i);
    assert.equal(store.getTaskRuntimeRelease(id), null);
    assert.equal(store.getSession(id).status, 'waiting_review');
    assert.equal(store.getSession(id).persistentSessionKey, `single:${id}`);
    const event = store.listSessionWorklogs(id).find(item => item.kind === 'session.runtime.release.failed');
    assert.ok(event);
  } finally { await manager.shutdown(); }
});

test('Cron preserves sub-second scheduling and midnight in the configured timezone', () => {
  assert.equal(nextCronAt('0 23 * * *', '2026-10-26T10:00:00.753Z'), '2026-10-26T15:00:00.000Z');
  assert.equal(nextCronAt('0 0 * * *', '2026-10-26T15:00:00.753Z'), '2026-10-26T16:00:00.000Z');
});
