const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cycle-create-'));
for (const name of ['workspace', 'source', 'skills']) fs.mkdirSync(path.join(root, name));
Object.assign(process.env, {
  CODEX_DESK_DATA_DIR: path.join(root, 'data'), CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
  CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'workspace'), CODEX_TASK_SESSIONS_DIR: path.join(root, 'workspace', 'sessions'),
  SOURCE_CODEX_HOME: path.join(root, 'source'), WORKSPACE_CODEX_SKILLS_DIR: path.join(root, 'skills'),
});
const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
test.after(() => { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

function payload(id, schedule) {
  return { id, name: id, releaseKey: `version-${id}`, project: 'cloudRecord',
    taskTemplate: { name: 'Regression', objective: 'Fetch fresh code and run the workflow', workingDir: '.' },
    ...(schedule ? { schedule } : {}) };
}

test('legacy creation without a schedule remains supported and never starts a Task', () => {
  const cycle = store.createReleaseCycle(payload('legacy'));
  assert.equal(cycle.status, 'active');
  assert.equal(cycle.schedules.length, 0);
  assert.equal(cycle.taskTemplate.workspaceMode, 'session-clone');
  assert.equal(cycle.taskTemplate.sourceMode, 'session-clone');
  assert.equal(store.listReleaseCycleTasks(cycle.id).length, 0);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM commands').get().n, 0);
});

test('cycle and optional Cron are committed together and retries reuse the generated schedule ID', () => {
  const body = payload('scheduled', { cron: '0 23 * * *', timezone: 'Asia/Shanghai', overlapPolicy: 'queue' });
  const context = { idempotencyKey: 'scheduled-create' };
  const created = store.createReleaseCycle(body, context);
  const repeated = store.createReleaseCycle(body, context);
  assert.deepEqual(repeated, created);
  assert.equal(created.schedules.length, 1);
  assert.equal(created.schedules[0].enabled, true);
  assert.equal(created.schedules[0].cron, '0 23 * * *');
  assert.equal(store.listReleaseCycleTasks(created.id).length, 0);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM task_series_schedules WHERE release_cycle_id=?').get(created.id).n, 1);
  assert.throws(() => store.createReleaseCycle({ ...body, name: 'changed' }, context), error => error.statusCode === 409);
});

test('invalid Cron, timezone and schedule conflicts roll back the cycle, audit and receipt', () => {
  const attempts = [
    ['bad-cron', { cron: 'invalid' }],
    ['bad-timezone', { cron: '0 23 * * *', timezone: 'not/a-zone' }],
    ['conflict', { id: store.getReleaseCycle('scheduled').schedules[0].id, cron: '0 23 * * *' }],
  ];
  for (const [id, plan] of attempts) {
    assert.throws(() => store.createReleaseCycle(payload(id, plan), { idempotencyKey: `${id}-key` }));
    assert.equal(store.getReleaseCycle(id), null);
    assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM task_series_schedules WHERE release_cycle_id=?').get(id).n, 0);
    assert.equal(store.listAudit({ kind: 'release_cycle.created', limit: 100 }).some(event => event.entityId === id), false);
  }
  const corrected = store.createReleaseCycle(payload('bad-cron', { cron: '0 23 * * *' }), { idempotencyKey: 'bad-cron-key' });
  assert.equal(corrected.schedules.length, 1);
});

test('a successful creation replays during maintenance and after deletion without recreating it', () => {
  const body = payload('create-replay');
  const context = { idempotencyKey: 'create-replay-key' };
  const first = store.createReleaseCycle(body, context);
  store.deleteReleaseCycle(first.id, { idempotencyKey: 'delete-created-cycle', expectedCreatedAt: first.createdAt });
  assert.equal(store.getReleaseCycle(first.id), null);
  store.acquirePlatformMaintenance('test', 'cycle-create-replay', 30000);
  try {
    assert.deepEqual(store.createReleaseCycle(body, context), first);
    assert.throws(() => store.createReleaseCycle(payload('new-during-maintenance'), { idempotencyKey: 'new-create' }), error => error.statusCode === 503);
  } finally { store.releasePlatformMaintenance('cycle-create-replay'); }
  assert.equal(store.getReleaseCycle(first.id), null);
});

test('a failure to write the schedule audit leaves no half-created cycle or schedule', () => {
  const db = getDatabase();
  db.exec(`CREATE TRIGGER reject_new_schedule BEFORE INSERT ON audit_events
    WHEN NEW.kind='task_series_schedule.created' BEGIN SELECT RAISE(ABORT,'schedule audit failed'); END`);
  try {
    assert.throws(() => store.createReleaseCycle(payload('atomic-audit', { cron: '0 23 * * *' }),
      { idempotencyKey: 'atomic-audit-key' }), /schedule audit failed/);
  } finally { db.exec('DROP TRIGGER reject_new_schedule'); }
  assert.equal(store.getReleaseCycle('atomic-audit'), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_series_schedules WHERE release_cycle_id='atomic-audit'").get().n, 0);
  assert.equal(store.createReleaseCycle(payload('atomic-audit', { cron: '0 23 * * *' }), { idempotencyKey: 'atomic-audit-key' }).schedules.length, 1);
});

test('POST API creates an optional schedule atomically and replays confirmed results in maintenance', async () => {
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  const environment = { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_DISABLE_WORKER: '1',
    CODEX_ALLOW_ROOT_EXECUTION: '1', CODEX_DB_BACKUP_INTERVAL_HOURS: '0', CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    CODEX_DESK_AUTH_USER: 'fixture', CODEX_DESK_AUTH_PASSWORD: 'fixture-password',
    BRIDGE_RUNTIME_ROOT: path.join(root, 'runtime', 'bridge'), BRIDGE_CHATFILE_ROOT: path.join(root, 'runtime', 'chatfiles') };
  for (const key of Object.keys(environment)) if (/^CODEX_(REQUIRE_|HOST_LAUNCHER_|WEB_SUPERVISOR_|MANAGED_WEB_SUPERVISOR_)/.test(key)) delete environment[key];
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: environment, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Basic ${Buffer.from('fixture:fixture-password').toString('base64')}`, 'content-type': 'application/json' };
  const body = payload('http-created', { cron: '0 23 * * *', timezone: 'Asia/Shanghai' });
  const request = (data = body, key = 'http-created-key') => fetch(`${base}/api/release-cycles`, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(data),
  });
  try {
    let ready;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = await fetch(`${base}/api/release-cycles`, { headers }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(ready, 'Isolated server failed to start');
    const response = await request(); assert.equal(response.status, 201);
    const created = await response.json(); assert.equal(created.schedules.length, 1);
    assert.equal(store.listReleaseCycleTasks(created.id).length, 0);
    store.acquirePlatformMaintenance('test', 'http-create-replay', 30000);
    try {
      const repeated = await request(); assert.equal(repeated.status, 201); assert.deepEqual(await repeated.json(), created);
      assert.equal((await request(payload('http-new'), 'http-new-key')).status, 503);
    } finally { store.releasePlatformMaintenance('http-create-replay'); }
    const invalid = await request(payload('http-invalid', { cron: 'invalid' }), 'http-invalid-key');
    assert.equal(invalid.status, 400);
    assert.equal(store.getReleaseCycle('http-invalid'), null);
    assert.equal(getDatabase().prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  } finally {
    if (child.exitCode == null && child.signalCode == null) {
      const ended = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await ended;
    }
  }
});
