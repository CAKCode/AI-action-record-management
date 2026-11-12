const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cycle-delete-'));
for (const name of ['workspace', 'source', 'skills']) fs.mkdirSync(path.join(root, name));
Object.assign(process.env, {
  CODEX_DESK_DATA_DIR: path.join(root, 'data'), CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
  CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'workspace'), CODEX_TASK_SESSIONS_DIR: path.join(root, 'workspace', 'sessions'),
  SOURCE_CODEX_HOME: path.join(root, 'source'), WORKSPACE_CODEX_SKILLS_DIR: path.join(root, 'skills'),
});
const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
test.after(() => { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

function cycle(id) {
  return store.createReleaseCycle({ id, name: id, releaseKey: `version-${id}`,
    taskTemplate: { name: id, objective: 'Local deletion fixture', workingDir: '.', workspaceMode: 'shared' } });
}
function schedule(id) {
  return store.createTaskSeriesSchedule(id, { id: `${id}-nightly`, cron: '0 23 * * *', overlapPolicy: 'queue' });
}
function due(id, date) {
  getDatabase().prepare('UPDATE task_series_schedules SET next_run_at=? WHERE id=?').run(date, id);
}

test('deleting an empty closed cycle removes schedules, keeps other cycles and is idempotent', () => {
  const other = cycle('keep-cycle');
  const otherSchedule = schedule(other.id);
  const empty = cycle('empty-cycle');
  schedule(empty.id);
  store.closeReleaseCycle(empty.id);
  const context = { idempotencyKey: 'empty-delete', expectedCreatedAt: empty.createdAt };
  const result = store.deleteReleaseCycle(empty.id, context);
  assert.equal(result.deleted, true);
  assert.equal(result.deletedTasks, 0);
  assert.equal(result.historyRetained, false);
  assert.deepEqual(store.deleteReleaseCycle(empty.id, context), result);
  assert.equal(store.getReleaseCycle(empty.id), null);
  assert.equal(getDatabase().prepare('SELECT 1 FROM release_cycles WHERE id=?').get(empty.id), undefined);
  assert.equal(getDatabase().prepare('SELECT 1 FROM task_series_schedules WHERE release_cycle_id=?').get(empty.id), undefined);
  assert.equal(store.getReleaseCycle(other.id).schedules.find(item => item.id === otherSchedule.id).enabled, true);
  assert.equal(store.listAudit({ kind: 'release_cycle.deleted', limit: 100 }).filter(item => item.entityId === empty.id).length, 1);
});

test('a committed delete replays during maintenance and cannot delete a replacement generation', () => {
  const original = cycle('replace-cycle');
  const context = { idempotencyKey: 'replace-delete', expectedCreatedAt: original.createdAt };
  const result = store.deleteReleaseCycle(original.id, context);
  cycle(original.id);
  getDatabase().prepare('UPDATE release_cycles SET created_at=? WHERE id=?').run('2099-01-01T00:00:00Z', original.id);
  store.acquirePlatformMaintenance('test', 'delete-replay', 30000);
  try {
    assert.deepEqual(store.deleteReleaseCycle(original.id, context), result);
    assert.throws(() => store.deleteReleaseCycle(original.id, { idempotencyKey: 'new-maintenance-delete' }), error => error.statusCode === 503);
  } finally { store.releasePlatformMaintenance('delete-replay'); }
  assert.equal(store.getReleaseCycle(original.id).createdAt, '2099-01-01T00:00:00Z');
  assert.throws(() => store.deleteReleaseCycle(original.id, { ...context, idempotencyKey: 'stale-new-key' }), error => error.statusCode === 409);
  assert.throws(() => store.deleteReleaseCycle('keep-cycle', context), error => error.statusCode === 409);
  assert.equal(store.getReleaseCycle(original.id).status, 'active');
});

test('an audit failure rolls back deletion and schedule changes together', () => {
  const item = cycle('rollback-cycle');
  const plan = schedule(item.id);
  const db = getDatabase();
  db.exec(`CREATE TRIGGER reject_cycle_delete_audit BEFORE INSERT ON audit_events
    WHEN NEW.kind='release_cycle.deleted' BEGIN SELECT RAISE(ABORT, 'injected cycle audit failure'); END`);
  try {
    assert.throws(() => store.deleteReleaseCycle(item.id, { idempotencyKey: 'rollback-delete' }), /injected cycle audit failure/);
  } finally { db.exec('DROP TRIGGER reject_cycle_delete_audit'); }
  assert.equal(store.getReleaseCycle(item.id).status, 'active');
  assert.equal(store.getReleaseCycle(item.id).schedules.find(item => item.id === plan.id).enabled, true);
  const retried = store.deleteReleaseCycle(item.id, { idempotencyKey: 'rollback-delete' });
  assert.equal(retried.ok, true);
});

test('a Cron candidate selected before deletion is rechecked before Task creation', () => {
  const item = cycle('racing-cycle');
  const plan = schedule(item.id);
  due(plan.id, '2000-01-01T00:00:00Z');
  const db = getDatabase();
  const original = db.prepare;
  let deleted = false;
  db.prepare = function(sql) {
    const statement = original.call(this, sql);
    if (/SELECT s\.id FROM task_series_schedules s/.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = all(...args);
        if (!deleted && rows.some(row => row.id === plan.id)) {
          deleted = true;
          store.deleteReleaseCycle(item.id, { idempotencyKey: 'race-delete' });
        }
        return rows;
      };
    }
    return statement;
  };
  let result;
  try { result = store.claimDueTaskSeriesSchedules('delete-race-worker'); }
  finally { db.prepare = original; }
  assert.equal(deleted, true);
  assert.equal(result.some(row => row.scheduleId === plan.id), false);
  assert.equal(store.listReleaseCycleTasks(item.id).length, 0);
  assert.equal(store.getReleaseCycle(item.id), null);
  assert.throws(() => store.createAndQueueSession('after-delete', {
    name: 'after-delete', objective: 'Must roll back', workingDir: '.', releaseCycleId: item.id,
  }, '', 'after-delete-key'), error => error.statusCode === 404);
  assert.equal(store.getSession('after-delete'), null);
});

async function drainDeletion(id, options = {}) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const progress = store.getReleaseCycleDeletion(id);
    if (progress.deleted) return progress;
    getDatabase().prepare("UPDATE release_cycle_deletions SET next_attempt_at='2000-01-01T00:00:00Z' WHERE id=?").run(id);
    for (const job of store.claimReleaseCycleDeletions('cycle-delete-fixture')) {
      await store.processReleaseCycleDeletion(job, 'cycle-delete-fixture', options);
    }
  }
  assert.fail(JSON.stringify(store.getReleaseCycleDeletion(id)));
}

function taskFile(taskId, relative, content = 'owned artifact') {
  const file = path.join(root, 'data', 'sessions', taskId, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  return file;
}

test('deleting a populated cycle stops creation and removes every associated Task and artifact', async () => {
  const item = cycle('cascade-cycle'); const plan = schedule(item.id);
  due(plan.id, '2000-01-01T00:00:00Z'); store.claimDueTaskSeriesSchedules('fixture-worker');
  due(plan.id, '2000-01-02T00:00:00Z'); store.claimDueTaskSeriesSchedules('fixture-worker');
  const tasks = store.listReleaseCycleTasks(item.id);
  const evidence = tasks.flatMap(task => ['skill-report-artifacts/report.html', 'skill-report-artifacts/video.mp4',
    'skill-report-artifacts/audio.mp3', 'logs/run.log', 'playback-cache/stream.m3u8'].map(file => taskFile(task.id, file)));
  store.saveSession('unrelated-task', { name: 'keep', objective: 'unrelated', workingDir: '.' });
  const unrelated = taskFile('unrelated-task', 'report.html', 'keep');
  const context = { idempotencyKey: 'cascade-delete', expectedCreatedAt: item.createdAt };
  const accepted = store.deleteReleaseCycle(item.id, context);
  assert.equal(accepted.deleted, false); assert.equal(accepted.totalTasks, 2);
  assert.equal(store.getReleaseCycle(item.id).status, 'deleting');
  assert.equal(store.listReleaseCycles({ status: 'deleting' }).some(cycle => cycle.id === item.id), true);
  assert.equal(store.listReleaseCycles({ status: 'closed' }).some(cycle => cycle.id === item.id), false);
  assert.equal(store.getReleaseCycle(item.id).schedules[0].enabled, false);
  for (const task of tasks) {
    assert.equal(store.acquireTaskLease(task.id, 'must-not-start'), false);
    assert.equal(store.getSession(task.id).releaseCycleStatus, 'deleting');
  }
  const result = await drainDeletion(accepted.deletionId);
  assert.equal(result.deleted, true); assert.equal(result.deletedTasks, 2);
  assert.equal(store.getReleaseCycle(item.id), null);
  assert.equal(getDatabase().prepare('SELECT 1 FROM task_series_schedules WHERE release_cycle_id=?').get(item.id), undefined);
  assert.equal(store.listReleaseCycleTasks(item.id).length, 0);
  for (const task of tasks) assert.equal(store.getSession(task.id), null);
  for (const file of evidence) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  assert.deepEqual(store.deleteReleaseCycle(item.id, context), result);
  assert.equal(store.claimDueTaskSeriesSchedules('after-delete-worker').some(row => row.scheduleId === plan.id), false);
});

test('legacy hidden cycles become ended cycles without deleting or stopping their Tasks', () => {
  const item = cycle('legacy-retained-cycle');
  const task = store.createReleaseCycleTask(item.id, {}, { idempotencyKey: 'legacy-retained-task' }).session;
  const file = taskFile(task.id, 'report/keep.html', 'keep legacy report');
  getDatabase().prepare("UPDATE release_cycles SET status='archived' WHERE id=?").run(item.id);
  assert.equal(store.getReleaseCycle(item.id), null);
  assert.equal(store.normalizeRetainedReleaseCycles(), 1);
  assert.equal(store.getReleaseCycle(item.id).status, 'closed');
  assert.equal(store.getSession(task.id).status, 'queued');
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep legacy report');
  assert.equal(store.normalizeRetainedReleaseCycles(), 0);
  store.requestSessionStop(task.id); store.deleteSession(task.id);
});

test('closing a cycle stops only new Task creation and preserves existing execution and evidence', () => {
  const item = cycle('close-preserves-tasks'); const plan = schedule(item.id);
  const task = store.createReleaseCycleTask(item.id, {}, { idempotencyKey: 'close-existing' }).session;
  const evidence = taskFile(task.id, 'report/video.mp4', 'keep media');
  store.closeReleaseCycle(item.id);
  assert.equal(store.getReleaseCycle(item.id).status, 'closed');
  assert.equal(store.getReleaseCycle(item.id).schedules.find(s => s.id === plan.id).enabled, false);
  assert.equal(store.getSession(task.id).status, 'queued');
  assert.equal(fs.readFileSync(evidence, 'utf8'), 'keep media');
  assert(store.claimPendingCommands('closed-cycle-worker', 100).some(command => command.task_id === task.id));
  assert.throws(() => store.createReleaseCycleTask(item.id, {}, { idempotencyKey: 'closed-new-task' }), error => error.statusCode === 409);
  store.requestSessionStop(task.id); store.deleteSession(task.id);
});

test('Task deletion failure restores files and the cycle job retries without claiming success', async () => {
  const item = cycle('cascade-retry');
  const task = store.createReleaseCycleTask(item.id, {}, { idempotencyKey: 'retry-existing' }).session;
  const evidence = taskFile(task.id, 'report/video.mp4');
  const accepted = store.deleteReleaseCycle(item.id, { idempotencyKey: 'retry-delete' });
  const db = getDatabase();
  db.exec("CREATE TRIGGER reject_task_delete BEFORE INSERT ON audit_events WHEN NEW.kind='session.deleted' BEGIN SELECT RAISE(ABORT,'task delete failure'); END");
  try {
    const [job] = store.claimReleaseCycleDeletions('retry-worker');
    const progress = await store.processReleaseCycleDeletion(job, 'retry-worker');
    assert.equal(progress.deleted, false); assert.equal(progress.state, 'retry');
    assert(store.getSession(task.id)); assert(fs.existsSync(evidence));
  } finally { db.exec('DROP TRIGGER reject_task_delete'); }
  assert.equal((await drainDeletion(accepted.deletionId)).deleted, true);
  assert.equal(fs.existsSync(evidence), false);
});

test('a committed Task deletion keeps failed file cleanup durable across a retry', async () => {
  const item = cycle('cascade-file-retry');
  const task = store.createReleaseCycleTask(item.id, {}, { idempotencyKey: 'file-retry-task' }).session;
  taskFile(task.id, 'report/video.mp4');
  const accepted = store.deleteReleaseCycle(item.id, { idempotencyKey: 'file-retry-delete' });
  const unlink = fs.unlinkSync;
  fs.unlinkSync = file => {
    if (String(file).includes('.deleting-') && String(file).endsWith('video.mp4')) {
      throw Object.assign(new Error('temporary file cleanup failure'), { code: 'EPERM' });
    }
    return unlink(file);
  };
  try {
    const [job] = store.claimReleaseCycleDeletions('file-retry-worker');
    const progress = await store.processReleaseCycleDeletion(job, 'file-retry-worker');
    assert.equal(store.getSession(task.id), null);
    assert.equal(progress.deleted, false); assert.equal(progress.deletedTasks, 1);
    assert(progress.pendingFileCleanup > 0);
    assert.equal(store.getReleaseCycle(item.id).status, 'deleting');
    closeDatabase();
    assert.equal(store.getReleaseCycleDeletion(accepted.deletionId).deleted, false);
    assert.equal(store.getReleaseCycle(item.id).status, 'deleting');
  } finally { fs.unlinkSync = unlink; }
  assert.equal((await drainDeletion(accepted.deletionId)).deleted, true);
});

test('cycle deletion never removes a replacement Task or a replacement cycle with the same ID', async () => {
  const item = cycle('cascade-generation');
  const task = store.createReleaseCycleTask(item.id, {}, { idempotencyKey: 'generation-task' }).session;
  const context = { idempotencyKey: 'generation-delete', expectedCreatedAt: item.createdAt };
  const accepted = store.deleteReleaseCycle(item.id, context);
  store.requestSessionStop(task.id); store.deleteSession(task.id);
  store.saveSession(task.id, { name: 'replacement', objective: 'keep replacement', workingDir: '.' });
  getDatabase().prepare('UPDATE tasks SET created_at=? WHERE id=?').run('2099-01-01T00:00:00Z', task.id);
  const keep = taskFile(task.id, 'replacement.html', 'keep replacement');
  await drainDeletion(accepted.deletionId);
  assert.equal(store.getSession(task.id).name, 'replacement');
  assert.equal(fs.readFileSync(keep, 'utf8'), 'keep replacement');
  cycle(item.id);
  getDatabase().prepare('UPDATE release_cycles SET created_at=? WHERE id=?').run('2099-01-01T00:00:00Z', item.id);
  assert.equal(store.deleteReleaseCycle(item.id, context).deleted, true);
  assert.equal(store.getReleaseCycle(item.id).createdAt, '2099-01-01T00:00:00Z');
});

test('DELETE API is idempotent and leaves the replacement cycle intact on stale retries', async () => {
  const item = cycle('http-cycle'); schedule(item.id);
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const selected = probe.address().port; probe.close(() => resolve(selected)); });
  });
  const environment = { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_DISABLE_WORKER: '1',
    CODEX_ALLOW_ROOT_EXECUTION: '1', CODEX_DB_BACKUP_INTERVAL_HOURS: '0', CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    CODEX_DESK_AUTH_USER: 'fixture', CODEX_DESK_AUTH_PASSWORD: 'fixture-password',
    BRIDGE_RUNTIME_ROOT: path.join(root, 'runtime', 'bridge'), BRIDGE_CHATFILE_ROOT: path.join(root, 'runtime', 'chatfiles') };
  for (const key of Object.keys(environment)) if (/^CODEX_(REQUIRE_|HOST_LAUNCHER_|WEB_SUPERVISOR_|MANAGED_WEB_SUPERVISOR_)/.test(key)) delete environment[key];
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: environment, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Basic ${Buffer.from('fixture:fixture-password').toString('base64')}` };
  try {
    let ready;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = await fetch(`${base}/api/release-cycles`, { headers: auth }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(ready, 'Isolated server failed to start');
    const headers = { ...auth, 'Idempotency-Key': 'http-cycle-delete', 'X-Release-Cycle-Created-At': item.createdAt };
    const request = () => fetch(`${base}/api/release-cycles/${item.id}`, { method: 'DELETE', headers });
    const response = await request(); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.deleted, true);
    assert.equal((await fetch(`${base}/api/release-cycles/${item.id}`, { headers: auth })).status, 404);
    cycle(item.id);
    getDatabase().prepare('UPDATE release_cycles SET created_at=? WHERE id=?').run('2099-01-01T00:00:00Z', item.id);
    const repeated = await request(); assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), result);
    const stale = await fetch(`${base}/api/release-cycles/${item.id}`, { method: 'DELETE',
      headers: { ...headers, 'Idempotency-Key': 'new-key-stale-generation' } });
    assert.equal(stale.status, 409);
    assert.equal(store.getReleaseCycle(item.id).createdAt, '2099-01-01T00:00:00Z');
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended;
    }
  }
});

test('cycle deletion releases Task-owned source and Skill snapshot directories and preserves shared sources', async () => {
  const item = cycle('delete-clone-files');
  store.saveSession('clone-file-task', { name: 'clone files', objective: 'fixture', workingDir: '.',
    workspaceMode: 'session-clone', releaseCycleId: item.id });
  const task = store.getSession('clone-file-task');
  fs.mkdirSync(task.sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(task.sourceRoot, 'test_case.py'), '# Task source');
  const snapshot = path.join(root, 'runtime', 'skill-snapshots', task.id);
  fs.mkdirSync(snapshot, { recursive: true }); fs.writeFileSync(path.join(snapshot, 'SKILL.md'), 'snapshot');
  const shared = path.join(root, 'workspace', 'source-video.mp4'); fs.writeFileSync(shared, 'shared source');
  const result = store.deleteReleaseCycle(item.id, { idempotencyKey: 'delete-clone-files' });
  await drainDeletion(result.deletionId);
  assert.equal(fs.existsSync(task.sessionRoot), false);
  assert.equal(fs.existsSync(snapshot), false);
  assert.equal(fs.readFileSync(shared, 'utf8'), 'shared source');
});

test('deletion recovers a crash after filesystem staging but before the Task transaction committed', async () => {
  const item = cycle('delete-crash-staging');
  store.saveSession('staging-crash-task', { name: 'crash fixture', objective: 'fixture', workingDir: '.',
    workspaceMode: 'session-clone', releaseCycleId: item.id });
  const task = store.getSession('staging-crash-task');
  const data = path.join(root, 'data', 'sessions', task.id);
  taskFile(task.id, 'report/video.mp4');
  const accepted = store.deleteReleaseCycle(item.id, { idempotencyKey: 'delete-crash-staging' });
  const generation = crypto.createHash('sha256').update(`${task.id}\0${task.createdAt}`).digest('hex').slice(0, 16);
  const tombstones = [data, task.sessionRoot].map(target => {
    const tombstone = `${target}.deleting-${generation}-${crypto.randomUUID()}`;
    fs.renameSync(target, tombstone); return tombstone;
  });
  store.saveSession('another-task', { name: 'unrelated recovery', objective: 'keep', workingDir: '.' });
  const other = store.getSession('another-task');
  const otherGeneration = crypto.createHash('sha256').update(`another-task\0${other.createdAt}`).digest('hex').slice(0, 16);
  const unrelated = taskFile('another-task', 'keep.txt', 'unrelated data');
  const otherRoot = path.dirname(unrelated);
  fs.renameSync(otherRoot, `${otherRoot}.deleting-${otherGeneration}-${crypto.randomUUID()}`);
  closeDatabase();
  const completed = await drainDeletion(accepted.deletionId);
  assert.equal(completed.deleted, true);
  assert.equal(store.getSession(task.id), null);
  for (const file of [data, task.sessionRoot, ...tombstones]) assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated data');
});

test('deletion claims recover after interruption and pause for maintenance', async () => {
  const item = cycle('delete-resume');
  store.saveSession('resume-delete-task', { name: 'resume delete', objective: 'fixture', workingDir: '.', releaseCycleId: item.id });
  const accepted = store.deleteReleaseCycle(item.id, { idempotencyKey: 'delete-resume' });
  const [claimed] = store.claimReleaseCycleDeletions('old-web');
  assert.equal(claimed.id, accepted.deletionId);
  assert.deepEqual(store.claimReleaseCycleDeletions('new-web'), []);
  assert.equal(store.getPlatformActivityCounts().releaseCycleDeletions, 1);
  getDatabase().prepare("UPDATE release_cycle_deletions SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(claimed.id);
  const [recovered] = store.claimReleaseCycleDeletions('new-web');
  assert.equal(recovered.id, claimed.id);
  await store.processReleaseCycleDeletion(recovered, 'new-web');
  assert.equal(store.getReleaseCycleDeletion(claimed.id).deleted, true);
  assert.equal(store.getPlatformActivityCounts().releaseCycleDeletions, 0);
  const pending = cycle('delete-maintenance');
  store.saveSession('maintenance-delete-task', { name: 'fixture', objective: 'fixture', workingDir: '.', releaseCycleId: pending.id });
  const acceptedPending = store.deleteReleaseCycle(pending.id, { idempotencyKey: 'delete-maintenance' });
  store.acquirePlatformMaintenance('test', 'delete-maintenance', 30000);
  try {
    assert.deepEqual(store.claimReleaseCycleDeletions('paused-web'), []);
    assert.equal(store.deleteReleaseCycle(pending.id, { idempotencyKey: 'delete-maintenance' }).deletionId, acceptedPending.deletionId);
  } finally { store.releasePlatformMaintenance('delete-maintenance'); }
  assert.equal((await drainDeletion(acceptedPending.deletionId)).deleted, true);
});

test('deletion removes registered per-run outputs in shared repositories and preserves shared references and original media', async () => {
  const item = cycle('shared-run-output-delete');
  const taskId = 'shared-run-output-task';
  const project = path.join(root, 'workspace', 'shared-project'); fs.mkdirSync(project, { recursive: true });
  const sourceCode = path.join(project, 'test_source.py'); fs.writeFileSync(sourceCode, '# keep project code');
  store.saveSession(taskId, { name: taskId, objective: 'fixture', workingDir: project, releaseCycleId: item.id });
  const otherId = 'shared-run-other-task';
  store.saveSession(otherId, { name: otherId, objective: 'fixture', workingDir: project });
  const ownRun = path.join(project, 'task', 'owned-run');
  const sharedRun = path.join(project, 'task', 'shared-run');
  for (const run of [ownRun, sharedRun]) {
    fs.mkdirSync(path.join(run, 'report'), { recursive: true });
    fs.writeFileSync(path.join(run, 'report', 'report.html'), '<html>report</html>');
    fs.mkdirSync(path.join(run, 'videos')); fs.writeFileSync(path.join(run, 'videos', 'video.mp4'), 'local copy');
  }
  const original = path.join(root, 'source', 'original-video.mp4'); fs.writeFileSync(original, 'keep original');
  fs.symlinkSync(original, path.join(ownRun, 'videos', 'original-link.mp4'));
  const log = path.join(project, 'task', 'owned-flat.log');
  for (const suffix of ['.log', '.done', '.state', '.meta', '.cmd', '.pid']) fs.writeFileSync(log.slice(0, -4) + suffix, 'fixture');
  fs.writeFileSync(log.slice(0, -4) + '.meta', `work_dir=${project}\n`);
  const now = new Date().toISOString();
  const insert = getDatabase().prepare(`INSERT INTO external_attempts
    (id,task_id,chain_key,generation,status,pid,log_path,meta_path,done_path,state_path,artifact_declarations_json,started_at,created_at,updated_at)
    VALUES (?,?,?,1,'failed',999999998,?,?,?,?,?,?,?,?)`);
  insert.run('shared-own-external', taskId, 'own', log, log.slice(0, -4) + '.meta', log.slice(0, -4) + '.done', log.slice(0, -4) + '.state',
    JSON.stringify([{ key: 'own', kind: 'pytest-html', path: path.join(ownRun, 'report', 'report.html') },
      { key: 'shared', kind: 'pytest-html', path: path.join(sharedRun, 'report', 'report.html') }]), now, now, now);
  insert.run('shared-other-external', otherId, 'other', path.join(project, 'other.log'), '', '', '',
    JSON.stringify([{ key: 'shared', kind: 'pytest-html', path: path.join(sharedRun, 'report', 'report.html') }]), now, now, now);
  const accepted = store.deleteReleaseCycle(item.id, { idempotencyKey: 'delete-shared-run' });
  await drainDeletion(accepted.deletionId);
  assert.equal(fs.existsSync(ownRun), false);
  for (const suffix of ['.log', '.done', '.state', '.meta', '.cmd', '.pid']) assert.equal(fs.existsSync(log.slice(0, -4) + suffix), false);
  assert.equal(fs.existsSync(sharedRun), true);
  assert.equal(fs.readFileSync(original, 'utf8'), 'keep original');
  assert.equal(fs.readFileSync(sourceCode, 'utf8'), '# keep project code');
  assert(store.getSession(otherId));
});
