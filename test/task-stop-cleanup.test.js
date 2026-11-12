const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-stop-cleanup-'));
for (const name of ['workspace', 'source', 'skills']) fs.mkdirSync(path.join(root, name));
Object.assign(process.env, {
  CODEX_DESK_DATA_DIR: path.join(root, 'data'), CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
  CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'workspace'), CODEX_TASK_SESSIONS_DIR: path.join(root, 'sessions'),
  SOURCE_CODEX_HOME: path.join(root, 'source'), WORKSPACE_CODEX_SKILLS_DIR: path.join(root, 'skills'),
  BRIDGE_RUNTIME_ROOT: path.join(root, 'bridge'), BRIDGE_CHATFILE_ROOT: path.join(root, 'chatfiles'),
});
const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
const { inspectProcess } = require('../src/process-identity');
test.after(() => { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

async function backgroundTask(t, id, { status = 'waiting_review', ignoreTerm = false } = {}) {
  const cycle = store.createReleaseCycle({ id: `${id}-cycle`, taskTemplate: {
    name: id, objective: 'Isolated process cleanup fixture', workingDir: '.', workspaceMode: 'shared',
  } });
  store.saveSession(id, { name: id, objective: 'fixture', workingDir: '.', releaseCycleId: cycle.id });
  getDatabase().prepare('UPDATE tasks SET status=? WHERE id=?').run(status, id);
  const file = path.join(root, 'data', 'sessions', id, 'background.log');
  const child = spawn(process.execPath, ['-e', `
    const fs = require('fs'), path = require('path');
    process.on('SIGTERM', () => { if (!${ignoreTerm}) process.exit(0); });
    const write = () => {
      fs.mkdirSync(path.dirname(process.argv[1]), { recursive: true });
      fs.appendFileSync(process.argv[1], 'tick\\n');
    };
    write(); setInterval(write, 20); process.send('ready');
  `, file], { detached: true, env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await exited;
  });
  await once(child, 'message');
  const identity = inspectProcess(child.pid);
  const now = new Date().toISOString();
  getDatabase().prepare(`INSERT INTO external_attempts
    (id,task_id,chain_key,generation,status,pid,pid_start_ticks,process_group_id,log_path,started_at,created_at,updated_at)
    VALUES (?,?,?,1,'running',?,?,?,?,?,?,?)`)
    .run(`${id}-external`, id, id, child.pid, identity.startTicks, identity.processGroupId, file, now, now, now);
  return { cycle, id, file, child, exited };
}

async function captureStopTimers(action) {
  const original = global.setTimeout;
  const timers = [];
  global.setTimeout = (callback, milliseconds, ...args) => {
    if (![50, 2000].includes(milliseconds)) return original(callback, milliseconds, ...args);
    const timer = { callback: () => callback(...args), milliseconds, unref() {} };
    timers.push(timer);
    return timer;
  };
  try { await action(timers); }
  finally { global.setTimeout = original; }
}

async function advanceDeletion(deletionId) {
  getDatabase().prepare("UPDATE release_cycle_deletions SET next_attempt_at='' WHERE id=?").run(deletionId);
  const job = store.claimReleaseCycleDeletions('stop-cleanup-test').find(job => job.id === deletionId);
  assert(job);
  return store.processReleaseCycleDeletion(job, 'stop-cleanup-test');
}

test('cycle deletion preserves a reviewable Task and its files until its background writer exits', async t => {
  const task = await backgroundTask(t, 'reviewable-writer', { ignoreTerm: true });
  await captureStopTimers(async timers => {
    const deletion = store.deleteReleaseCycle(task.cycle.id);
    const pending = await advanceDeletion(deletion.deletionId);
    assert.equal(pending.deleted, false);
    assert.equal(store.getSession(task.id).status, 'stopping');
    assert.equal(pending.remainingTasks, 1);
    assert(fs.existsSync(task.file), 'Files were removed while the writer was alive');
    assert.notEqual(inspectProcess(task.child.pid)?.state, 'Z');

    timers.find(timer => timer.milliseconds === 2000).callback();
    await task.exited;
    for (const timer of timers.filter(timer => timer.milliseconds === 50)) timer.callback();
    assert.equal((await advanceDeletion(deletion.deletionId)).deleted, true);
    assert.equal(store.getSession(task.id), null);
    assert.equal(fs.existsSync(path.dirname(task.file)), false);
  });
});

test('delayed stop callbacks safely expire after a cycle and its Tasks have been deleted', async t => {
  const task = await backgroundTask(t, 'expired-stop', { status: 'waiting_scheduled' });
  await captureStopTimers(async timers => {
    store.requestSessionStop(task.id);
    await task.exited;
    timers.find(timer => timer.milliseconds === 50).callback();
    assert.equal(store.getSession(task.id).status, 'stopped');
    const deletion = store.deleteReleaseCycle(task.cycle.id);
    assert.equal((await advanceDeletion(deletion.deletionId)).deleted, true);
    for (const timer of timers) assert.doesNotThrow(() => timer.callback());
    assert.equal(fs.existsSync(path.dirname(task.file)), false);
  });
});

test('an old stop callback cannot write to or finalize a replacement Task with the same ID', async t => {
  const task = await backgroundTask(t, 'replaced-stop', { status: 'waiting_scheduled' });
  await captureStopTimers(async timers => {
    const stopContext = { idempotencyKey: 'replaced-stop-original',
      expectedTaskCreatedAt: store.getSession(task.id).createdAt };
    store.requestSessionStop(task.id, stopContext);
    await task.exited;
    timers.find(timer => timer.milliseconds === 50).callback();
    store.deleteSession(task.id);
    store.saveSession(task.id, { name: 'Replacement', objective: 'Preserve this generation', workingDir: '.',
      createdAt: '2099-01-01T00:00:00.000Z' });
    getDatabase().prepare("UPDATE tasks SET status='stopping' WHERE id=?").run(task.id);
    const before = store.listSessionWorklogs(task.id);
    assert.equal(store.requestSessionStop(task.id, stopContext), true);
    for (const timer of timers) timer.callback();
    assert.equal(store.getSession(task.id).status, 'stopping');
    assert.deepEqual(store.listSessionWorklogs(task.id), before);
  });
});

test('Task deletion waits for registered live processes even if the stored status is inactive', async t => {
  const task = await backgroundTask(t, 'inactive-live-process');
  assert.throws(() => store.deleteSession(task.id), error => error.statusCode === 409);
  assert(store.getSession(task.id));
  assert(fs.existsSync(task.file));
});

test('old stop requests cannot reconcile or cancel the result collection of a replacement Task', () => {
  const id = 'replacement-result-collection';
  store.saveSession(id, { name: id, objective: 'Original generation', workingDir: '.' });
  const originalContext = { idempotencyKey: 'original-generation-stop',
    expectedTaskCreatedAt: store.getSession(id).createdAt };
  assert.equal(store.requestSessionStop(id, originalContext), false);
  store.deleteSession(id);
  store.saveSession(id, { name: id, objective: 'Replacement generation', workingDir: '.',
    createdAt: '2099-01-01T00:00:00.000Z' });
  const db = getDatabase();
  db.prepare("UPDATE tasks SET status='waiting_scheduled' WHERE id=?").run(id);
  const log = path.join(root, 'workspace', 'replacement.log');
  const done = path.join(root, 'workspace', 'replacement.done');
  fs.writeFileSync(log, 'Replacement result'); fs.writeFileSync(done, '0');
  const now = new Date(Date.now() - 10000).toISOString();
  db.prepare(`INSERT INTO external_attempts
    (id,task_id,chain_key,generation,status,pid,log_path,done_path,started_at,created_at,updated_at)
    VALUES (?,?,?,1,'running',999999998,?,?,?,?,?)`)
    .run('replacement-external', id, id, log, done, now, now, now);
  db.prepare(`INSERT INTO scheduled_jobs
    (id,task_id,external_attempt_id,due_at,idempotency_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run('replacement-check', id, 'replacement-external', '2099-01-01T00:00:00.000Z', 'replacement-check', now, now);
  const snapshot = () => ({
    task: store.getSession(id),
    external: db.prepare('SELECT * FROM external_attempts WHERE id=?').get('replacement-external'),
    scheduled: db.prepare('SELECT * FROM scheduled_jobs WHERE id=?').get('replacement-check'),
    worklogs: store.listSessionWorklogs(id),
  });
  const before = snapshot();
  assert.equal(store.requestSessionStop(id, originalContext), false);
  assert.deepEqual(snapshot(), before);
  assert.throws(() => store.requestSessionStop(id, { ...originalContext, idempotencyKey: 'new-stale-stop-key' }),
    error => error.statusCode === 409);
  assert.deepEqual(snapshot(), before);
  assert.throws(() => store.requestSessionStop(id, { idempotencyKey: 'prepared-for-old-generation',
    preparedTaskCreatedAt: originalContext.expectedTaskCreatedAt }), error => error.statusCode === 409);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(store.prepareSessionStop(id, originalContext), { replayed: true, ok: false });
  assert.deepEqual(snapshot(), before);
});

for (const includeGeneration of [false, true]) {
  test(`confirming completed history saves a new receipt before returning (generation=${includeGeneration})`, () => {
    const id = `already-completed-${includeGeneration}`;
    store.saveSession(id, { name: id, objective: 'Original generation', workingDir: '.' });
    getDatabase().prepare("UPDATE tasks SET status='waiting_review' WHERE id=?").run(id);
    const original = store.completeSession(id, { idempotencyKey: `${id}-first` });
    const context = { idempotencyKey: `${id}-second`,
      ...(includeGeneration ? { expectedTaskCreatedAt: original.createdAt } : {}) };
    const plan = store.prepareSessionCompletion(id, context);
    assert.equal(plan.replayed, true);
    assert.equal(plan.session.createdAt, original.createdAt);
    assert(getDatabase().prepare('SELECT 1 FROM session_operation_receipts WHERE idempotency_key=?').get(context.idempotencyKey));
    assert.equal(store.listSessionWorklogs(id).filter(event => event.kind === 'session.completed').length, 1);
    store.deleteSession(id);
    store.saveSession(id, { name: id, objective: 'Replacement generation', workingDir: '.',
      createdAt: '2099-01-01T00:00:00.000Z' });
    getDatabase().prepare("UPDATE tasks SET status='waiting_review' WHERE id=?").run(id);
    const replay = store.completeSession(id, context);
    assert.equal(replay.createdAt, original.createdAt);
    assert.equal(store.getSession(id).status, 'waiting_review');
    assert.equal(store.listSessionWorklogs(id).length, 0);
  });
}
