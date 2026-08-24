const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-cleanup-'));
const dataDir = path.join(tempDir, 'data');
const runtimeDir = path.join(tempDir, 'runtime');
const bridgeRuntimeRoot = path.join(runtimeDir, 'bridge-sessions');
const bridgeChatfileRoot = path.join(runtimeDir, 'bridge-chatfiles');
const workspaceRoot = path.join(tempDir, 'task-workspaces');
const projectDir = path.join(workspaceRoot, 'project');
const sourceHome = path.join(tempDir, 'codex-home');
const sourceSkills = path.join(sourceHome, 'skills');
const workspaceSkills = path.join(tempDir, 'workspace-skills');

for (const directory of [
  dataDir,
  bridgeRuntimeRoot,
  bridgeChatfileRoot,
  projectDir,
  sourceSkills,
  workspaceSkills,
]) {
  fs.mkdirSync(directory, { recursive: true });
}

process.env.CODEX_DESK_DATA_DIR = dataDir;
process.env.CODEX_DESK_RUNTIME_DIR = runtimeDir;
process.env.CODEX_TASK_WORKSPACE_ROOTS = workspaceRoot;
process.env.SOURCE_CODEX_HOME = sourceHome;
process.env.WORKSPACE_CODEX_SKILLS_DIR = workspaceSkills;
process.env.BRIDGE_RUNTIME_ROOT = bridgeRuntimeRoot;
process.env.BRIDGE_CHATFILE_ROOT = bridgeChatfileRoot;
process.env.BRIDGE_BOT_ID = 'codex-task-sessions';

const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
const {
  stableBridgeSessionId,
  sessionTargets,
  listBridgeSessionRecords,
  resolveBridgeSessionRuntime,
  secureBridgeRuntimeStorage,
} = require('../src/bridge-runtime-cleanup');

function setTaskRuntime(taskId, sessionKey, status = 'waiting_review') {
  const db = getDatabase();
  db.prepare(`
    UPDATE tasks SET persistent_session_key=?, status=?, recovery_state=?, updated_at=? WHERE id=?
  `).run(sessionKey, status, status, new Date().toISOString(), taskId);
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
}

function createTask(taskId, sessionKey, status = 'waiting_review') {
  store.saveSession(taskId, {
    name: taskId,
    objective: `Cleanup ${taskId}`,
    workingDir: projectDir,
  });
  return setTaskRuntime(taskId, sessionKey, status);
}

function createBridgeArtifacts(sessionKey, options = {}) {
  const sourceDir = options.sourceDir || projectDir;
  const sessionId = options.sessionId || stableBridgeSessionId(sessionKey, sourceDir);
  const targets = sessionTargets(sessionKey, sessionId);
  for (const directory of [targets.workspaceRoot, targets.codexHome, targets.chatfileDir]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'evidence.txt'), sessionKey);
  }
  fs.mkdirSync(path.dirname(targets.workspaceLock), { recursive: true });
  fs.mkdirSync(path.dirname(targets.sessionRunLock), { recursive: true });
  fs.mkdirSync(path.dirname(targets.recordFile), { recursive: true });
  fs.writeFileSync(targets.workspaceLock, '');
  fs.writeFileSync(targets.sessionRunLock, '');
  const record = {
    sessionId,
    botId: 'codex-task-sessions',
    botName: 'codex-task-sessions',
    chatKey: sessionKey,
    workspaceId: `user:codex-task-sessions:${targets.userId}`,
    workspaceScope: 'user',
    workspaceMode: 'team',
    cwdDir: targets.workfileDir,
    skillDir: targets.skillDir,
    chatfileDir: targets.chatfileDir,
    workfileDir: targets.workfileDir,
    roomfileDir: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    threadId: `thread-${sessionId}`,
    lastRunAt: Date.now(),
    recentChat: [],
  };
  fs.writeFileSync(targets.recordFile, JSON.stringify(record, null, 2));
  return { sessionId, targets, record };
}

function claimOne(workerId) {
  const jobs = store.claimBridgeCleanupJobs(workerId, 10);
  assert.equal(jobs.length, 1);
  return jobs[0];
}

function assertArtifactsExist(artifacts) {
  for (const target of [
    artifacts.targets.workspaceRoot,
    artifacts.targets.codexHome,
    artifacts.targets.chatfileDir,
    artifacts.targets.workspaceLock,
    artifacts.targets.sessionRunLock,
    artifacts.targets.recordFile,
  ]) assert.equal(fs.existsSync(target), true, target);
}

function assertArtifactsRemoved(artifacts) {
  for (const target of [
    artifacts.targets.workspaceRoot,
    artifacts.targets.codexHome,
    artifacts.targets.chatfileDir,
    artifacts.targets.workspaceLock,
    artifacts.targets.sessionRunLock,
    artifacts.targets.recordFile,
  ]) assert.equal(fs.existsSync(target), false, target);
}

function makeRetryDue(jobId) {
  getDatabase().prepare(`
    UPDATE bridge_cleanup_jobs SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?
  `).run(jobId);
}

test.after(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('resolves the validated Bridge runtime needed by interactive Codex CLI', () => {
  const sessionKey = 'single:interactive-runtime-00000000-0000-4000-8000-000000000000';
  const artifacts = createBridgeArtifacts(sessionKey);
  assert.deepEqual(resolveBridgeSessionRuntime(sessionKey), {
    sessionId: artifacts.sessionId,
    sessionKey,
    threadId: `thread-${artifacts.sessionId}`,
    cwdDir: artifacts.targets.workfileDir,
    codexHome: artifacts.targets.codexHome,
    chatfileDir: artifacts.targets.chatfileDir,
  });
});

test('reset refuses an active Task without changing its current Session', () => {
  const taskId = 'cleanup-reset-active';
  store.saveSession(taskId, {
    name: taskId, objective: 'Reset must reject an active Task.', workingDir: projectDir,
  });
  getDatabase().prepare("UPDATE tasks SET status='queued', recovery_state='queued' WHERE id=?").run(taskId);
  const createdAt = store.getSession(taskId).createdAt;
  assert.throws(
    () => store.resetSession(taskId, {
      idempotencyKey: 'cleanup-reset-active-key', expectedTaskCreatedAt: createdAt,
    }),
    (error) => error.statusCode === 409 && /Stop the active task/.test(error.message),
  );
  assert.equal(store.getSession(taskId).persistentSessionKey, '');
  assert.equal(store.getSession(taskId).status, 'queued');
  setTaskRuntime(taskId, '', 'waiting_review');
  store.deleteSession(taskId);
});

test('deleting a task durably releases only its own Bridge Session resources', () => {
  const sessionKey = 'single:cleanup-delete-11111111-1111-4111-8111-111111111111';
  const otherKey = 'single:cleanup-other-22222222-2222-4222-8222-222222222222';
  createTask('cleanup-delete', sessionKey);
  const artifacts = createBridgeArtifacts(sessionKey);
  const other = createBridgeArtifacts(otherKey);

  assert.equal(store.deleteSession('cleanup-delete'), true);
  assert.equal(store.getSession('cleanup-delete'), null);
  const job = claimOne('cleanup-worker-delete');
  assert.equal(job.reason, 'deleted');
  assert.equal(store.processBridgeCleanupJob(job, 'cleanup-worker-delete').ok, true);
  assertArtifactsRemoved(artifacts);
  assertArtifactsExist(other);

  const status = store.bridgeCleanupStatus();
  assert.equal(status.queued, 0);
  assert.equal(status.completed, 1);
  const audit = store.listAudit({ sessionId: 'cleanup-delete', limit: 20 });
  assert.ok(audit.some((event) => event.kind === 'bridge.session.cleanup.queued'));
  assert.ok(audit.some((event) => event.kind === 'bridge.session.cleanup.completed'));
});

test('completion retains Runtime and restoration resumes the archived task idempotently', () => {
  const sessionKey = 'single:cleanup-complete-33333333-3333-4333-8333-333333333333';
  createTask('cleanup-complete', sessionKey);
  const artifacts = createBridgeArtifacts(sessionKey);

  const createdAt = store.getSession('cleanup-complete').createdAt;
  const completeContext = {
    idempotencyKey: 'cleanup-complete-cycle-1', expectedTaskCreatedAt: createdAt,
  };
  const completed = store.completeSession('cleanup-complete', completeContext);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(store.completeSession('cleanup-complete', completeContext), completed);
  assert.equal(store.claimBridgeCleanupJobs('cleanup-worker-complete', 10).length, 0);
  assertArtifactsExist(artifacts);
  assert.equal(store.getSession('cleanup-complete').status, 'completed');
  const restoreContext = {
    idempotencyKey: 'cleanup-restore-cycle-1', expectedTaskCreatedAt: createdAt,
  };
  const restored = store.restoreCompletedSession('cleanup-complete', restoreContext);
  assert.equal(restored.status, 'waiting_input');
  assert.equal(restored.archivedAt, '');
  assert.deepEqual(store.restoreCompletedSession('cleanup-complete', restoreContext), restored);
  assertArtifactsExist(artifacts);
  assert.deepEqual(
    store.listSessionWorklogs('cleanup-complete')
      .filter((event) => ['session.completed', 'session.restored'].includes(event.kind))
      .map((event) => event.kind),
    ['session.completed', 'session.restored'],
  );
  assert.equal(getDatabase().prepare(`
    SELECT COUNT(*) AS count FROM session_operation_receipts
    WHERE task_id='cleanup-complete' AND operation='restore'
  `).get().count, 1);

  store.deleteSession('cleanup-complete');
  const job = claimOne('cleanup-worker-complete');
  assert.equal(job.reason, 'deleted');
  assert.equal(store.processBridgeCleanupJob(job, 'cleanup-worker-complete').ok, true);
  assertArtifactsRemoved(artifacts);
});

test('reset retains the Task and history, reclaims the old Runtime, and restore follows the latest Session', () => {
  const taskId = 'cleanup-reset';
  const oldSessionKey = 'single:cleanup-reset-55555555-5555-4555-8555-555555555555';
  const latestSessionKey = 'single:cleanup-reset-66666666-6666-4666-8666-666666666666';
  createTask(taskId, oldSessionKey);
  const oldArtifacts = createBridgeArtifacts(oldSessionKey);
  store.appendSessionWorklog(taskId, {
    id: 'cleanup-reset-history', kind: 'agent.message', message: 'Preserved Task history',
  });
  getDatabase().prepare(`
    UPDATE tasks SET notes='keep these notes', run_count=3, summary='old context',
      last_brief='old brief', last_error='old error' WHERE id=?
  `).run(taskId);
  const before = store.getSession(taskId);
  const resetContext = {
    idempotencyKey: 'cleanup-reset-cycle-1', expectedTaskCreatedAt: before.createdAt,
  };

  const reset = store.resetSession(taskId, resetContext);
  assert.equal(reset.id, taskId);
  assert.equal(reset.name, before.name);
  assert.equal(reset.objective, before.objective);
  assert.equal(reset.workingDir, before.workingDir);
  assert.equal(reset.notes, 'keep these notes');
  assert.equal(reset.runCount, 3);
  assert.equal(reset.status, 'idle');
  assert.equal(reset.persistentSessionKey, '');
  assert.equal(reset.summary, '');
  assert.equal(reset.lastBrief, '');
  assert.equal(reset.lastError, '');
  assert.equal(reset.recoveryState, 'reset');
  assert.deepEqual(store.resetSession(taskId, resetContext), reset);
  assert.equal(store.listSessionWorklogs(taskId).filter((event) => event.kind === 'session.reset').length, 1);
  assert.ok(store.listSessionWorklogs(taskId).some((event) => event.id === 'cleanup-reset-history'));

  const oldCleanup = claimOne('cleanup-worker-reset-old');
  assert.equal(oldCleanup.reason, 'deleted');
  assert.equal(oldCleanup.sessionKey, oldSessionKey);
  assert.equal(store.processBridgeCleanupJob(oldCleanup, 'cleanup-worker-reset-old').ok, true);
  assertArtifactsRemoved(oldArtifacts);

  setTaskRuntime(taskId, latestSessionKey, 'waiting_review');
  const latestArtifacts = createBridgeArtifacts(latestSessionKey);
  const completed = store.completeSession(taskId, {
    idempotencyKey: 'cleanup-reset-complete-latest', expectedTaskCreatedAt: before.createdAt,
  });
  assert.equal(completed.persistentSessionKey, latestSessionKey);
  const restored = store.restoreCompletedSession(taskId, {
    idempotencyKey: 'cleanup-reset-restore-latest', expectedTaskCreatedAt: before.createdAt,
  });
  assert.equal(restored.status, 'waiting_input');
  assert.equal(restored.persistentSessionKey, latestSessionKey);
  assertArtifactsExist(latestArtifacts);

  store.deleteSession(taskId);
  const latestCleanup = claimOne('cleanup-worker-reset-latest');
  assert.equal(latestCleanup.sessionKey, latestSessionKey);
  assert.equal(store.processBridgeCleanupJob(latestCleanup, 'cleanup-worker-reset-latest').ok, true);
  assertArtifactsRemoved(latestArtifacts);
});

test('a replacement generation cannot make an old cleanup delete its live Session key', () => {
  const sessionKey = 'single:cleanup-reuse-44444444-4444-4444-8444-444444444444';
  createTask('cleanup-reuse', sessionKey);
  const artifacts = createBridgeArtifacts(sessionKey);
  assert.equal(store.deleteSession('cleanup-reuse'), true);
  const replacement = store.saveSession('cleanup-reuse', {
    name: 'replacement', objective: 'Must survive stale cleanup.', workingDir: projectDir,
  });
  setTaskRuntime('cleanup-reuse', sessionKey, 'waiting_review');

  const firstClaim = claimOne('cleanup-worker-reuse-1');
  const blocked = store.processBridgeCleanupJob(firstClaim, 'cleanup-worker-reuse-1');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /still referenced/);
  assertArtifactsExist(artifacts);
  assert.equal(store.getSession('cleanup-reuse').createdAt, replacement.createdAt);

  getDatabase().prepare("UPDATE tasks SET persistent_session_key='' WHERE id='cleanup-reuse'").run();
  makeRetryDue(firstClaim.id);
  const recovered = claimOne('cleanup-worker-reuse-2');
  assert.equal(store.processBridgeCleanupJob(recovered, 'cleanup-worker-reuse-2').ok, true);
  assertArtifactsRemoved(artifacts);
  store.deleteSession('cleanup-reuse');
});

test('expired cleanup ownership is reclaimed after a Worker interruption', () => {
  const sessionKey = 'single:cleanup-lease-55555555-5555-4555-8555-555555555555';
  createTask('cleanup-lease', sessionKey);
  const artifacts = createBridgeArtifacts(sessionKey);
  store.deleteSession('cleanup-lease');
  const abandoned = claimOne('cleanup-worker-abandoned');
  assert.equal(store.getPlatformActivityCounts().bridgeCleanups, 1);
  assert.throws(
    () => store.acquirePlatformMaintenance('test_maintenance', 'test:bridge-cleanup', 30000),
    (error) => error.statusCode === 409 && error.activityCounts.bridgeCleanups === 1,
  );
  getDatabase().prepare(`
    UPDATE bridge_cleanup_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?
  `).run(abandoned.id);

  const recovered = claimOne('cleanup-worker-recovered');
  assert.equal(recovered.attemptCount, 2);
  assert.equal(store.processBridgeCleanupJob(recovered, 'cleanup-worker-recovered').ok, true);
  assert.equal(store.getPlatformActivityCounts().bridgeCleanups, 0);
  assertArtifactsRemoved(artifacts);
});

test('malformed, duplicate, and path-escaping records fail closed without partial deletion', () => {
  const scenarios = [
    {
      id: 'cleanup-malformed',
      key: 'single:cleanup-malformed-66666666-6666-4666-8666-666666666666',
      mutate(artifacts) { fs.writeFileSync(artifacts.targets.recordFile, '{not-json'); },
      error: /malformed/,
    },
    {
      id: 'cleanup-duplicate',
      key: 'single:cleanup-duplicate-77777777-7777-4777-8777-777777777777',
      mutate(artifacts) {
        const duplicate = path.join(path.dirname(artifacts.targets.recordFile), 'session-aaaaaaaaaaaaaaaa.json');
        fs.writeFileSync(duplicate, JSON.stringify(artifacts.record));
      },
      error: /Multiple/,
    },
    {
      id: 'cleanup-escape',
      key: 'single:cleanup-escape-88888888-8888-4888-8888-888888888888',
      mutate(artifacts) {
        fs.writeFileSync(artifacts.targets.recordFile, JSON.stringify({
          ...artifacts.record,
          cwdDir: path.join(tempDir, 'outside-cwd'),
        }));
      },
      error: /cwdDir/,
    },
  ];

  for (const scenario of scenarios) {
    createTask(scenario.id, scenario.key);
    const artifacts = createBridgeArtifacts(scenario.key);
    scenario.mutate(artifacts);
    store.deleteSession(scenario.id);
    const job = claimOne(`worker-${scenario.id}`);
    const result = store.processBridgeCleanupJob(job, `worker-${scenario.id}`);
    assert.equal(result.ok, false);
    assert.match(result.error, scenario.error);
    assertArtifactsExist(artifacts);
  }
});

test('a symbolic-link target is rejected without touching its destination', () => {
  const sessionKey = 'single:cleanup-link-99999999-9999-4999-8999-999999999999';
  createTask('cleanup-link', sessionKey);
  const artifacts = createBridgeArtifacts(sessionKey);
  const outside = path.join(tempDir, 'outside-link-target');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.rmSync(artifacts.targets.workspaceRoot, { recursive: true });
  fs.symlinkSync(outside, artifacts.targets.workspaceRoot);

  store.deleteSession('cleanup-link');
  const job = claimOne('cleanup-worker-link');
  const result = store.processBridgeCleanupJob(job, 'cleanup-worker-link');
  assert.equal(result.ok, false);
  assert.match(result.error, /symbolic link/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.lstatSync(artifacts.targets.workspaceRoot).isSymbolicLink(), true);
  assert.equal(fs.existsSync(artifacts.targets.recordFile), true);
});

test('Bridge Session inventory classifies resources and manual reclaim is exact, durable, and idempotent', () => {
  const ownedKey = 'single:inventory-owned-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const completedKey = 'single:inventory-completed-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const orphanKey = 'single:inventory-orphan-cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const unsafeKey = 'single:inventory-unsafe-dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  createTask('inventory-owned', ownedKey);
  createTask('inventory-completed', completedKey, 'completed');
  store.appendSessionWorklog('inventory-completed', {
    id: 'inventory-completed-worklog',
    kind: 'agent.message',
    message: 'Retained Agent evidence',
  });
  const owned = createBridgeArtifacts(ownedKey);
  const completed = createBridgeArtifacts(completedKey);
  const orphan = createBridgeArtifacts(orphanKey);
  const unsafe = createBridgeArtifacts(unsafeKey);
  fs.writeFileSync(unsafe.targets.recordFile, JSON.stringify({
    ...unsafe.record,
    cwdDir: path.join(tempDir, 'inventory-escape'),
  }));

  const inventory = store.listBridgeRuntimeInventory();
  const byId = new Map(inventory.sessions.map((session) => [session.sessionId, session]));
  assert.equal(byId.get(owned.sessionId).category, 'task_owned');
  assert.equal(byId.get(owned.sessionId).reclaimable, false);
  assert.equal(byId.get(completed.sessionId).category, 'completed_retained');
  assert.equal(byId.get(completed.sessionId).reclaimable, true);
  assert.equal(byId.get(orphan.sessionId).category, 'orphan');
  assert.equal(byId.get(orphan.sessionId).reclaimable, true);
  assert.equal(byId.get(unsafe.sessionId).category, 'unsafe');
  assert.equal(byId.get(unsafe.sessionId).reclaimable, false);
  assert.ok(byId.get(orphan.sessionId).bytes > 0);
  assert.ok(Object.values(byId.get(orphan.sessionId).resources).every(Boolean));
  assert.ok(inventory.summary.totalBytes >= byId.get(orphan.sessionId).bytes);
  assert.ok(inventory.summary.reclaimableBytes >= byId.get(orphan.sessionId).bytes);
  assert.equal(JSON.stringify(inventory).includes(bridgeRuntimeRoot), false);
  assert.equal(JSON.stringify(inventory).includes(orphanKey), false);

  assert.throws(
    () => store.requestBridgeSessionReclaim(orphan.sessionId, owned.sessionId),
    (error) => error.statusCode === 400 && /exact confirmationSessionId/.test(error.message),
  );
  assert.throws(
    () => store.requestBridgeSessionReclaim(orphan.sessionId, ` ${orphan.sessionId}`),
    (error) => error.statusCode === 400 && /exact confirmationSessionId/.test(error.message),
  );
  assert.throws(
    () => store.requestBridgeSessionReclaim(owned.sessionId, owned.sessionId),
    (error) => error.statusCode === 409 && /task_owned/.test(error.message),
  );
  assert.throws(
    () => store.requestBridgeSessionReclaim(unsafe.sessionId, unsafe.sessionId),
    (error) => error.statusCode === 409 && /unsafe/.test(error.message),
  );
  assertArtifactsExist(unsafe);

  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = function readdirWithConcurrentRemoval(target, ...args) {
    if (path.resolve(target) === path.resolve(orphan.targets.codexHome)) {
      throw Object.assign(new Error('simulated concurrent cleanup'), { code: 'ENOENT' });
    }
    return originalReaddirSync.call(this, target, ...args);
  };
  try {
    const raced = listBridgeSessionRecords().find((record) => record.sessionId === orphan.sessionId);
    assert.equal(raced.safe, true);
    assert.ok(raced.bytes > 0);
  } finally {
    fs.readdirSync = originalReaddirSync;
  }

  const orphanJob = store.requestBridgeSessionReclaim(orphan.sessionId, orphan.sessionId, {
    actor: 'inventory-test', requestId: 'inventory-orphan-reclaim',
  });
  const orphanReplay = store.requestBridgeSessionReclaim(orphan.sessionId, orphan.sessionId);
  assert.equal(orphanReplay.id, orphanJob.id);
  assert.equal(orphanReplay.status, 'pending');
  assert.match(orphanJob.taskId, /^bridge-orphan-/);
  const orphanClaim = claimOne('inventory-worker-orphan');
  assert.equal(orphanClaim.id, orphanJob.id);
  assert.equal(store.processBridgeCleanupJob(orphanClaim, 'inventory-worker-orphan').ok, true);
  assertArtifactsRemoved(orphan);

  const completedJob = store.requestBridgeSessionReclaim(completed.sessionId, completed.sessionId);
  const completedClaim = claimOne('inventory-worker-completed');
  assert.equal(completedClaim.id, completedJob.id);
  assert.equal(completedClaim.reason, 'completed');
  assert.equal(store.processBridgeCleanupJob(completedClaim, 'inventory-worker-completed').ok, true);
  assertArtifactsRemoved(completed);
  assert.equal(store.getSession('inventory-completed').status, 'completed');
  assert.deepEqual(store.listSessionWorklogs('inventory-completed').map((event) => ({
    id: event.id, kind: event.kind, message: event.message,
  })), [{
    id: 'inventory-completed-worklog', kind: 'agent.message', message: 'Retained Agent evidence',
  }]);

  assert.equal(store.deleteSession('inventory-owned'), true);
  const ownedClaim = claimOne('inventory-worker-owned');
  assert.equal(store.processBridgeCleanupJob(ownedClaim, 'inventory-worker-owned').ok, true);
  assertArtifactsRemoved(owned);

  fs.writeFileSync(unsafe.targets.recordFile, JSON.stringify(unsafe.record));
  const repairedJob = store.requestBridgeSessionReclaim(unsafe.sessionId, unsafe.sessionId);
  const repairedClaim = claimOne('inventory-worker-repaired');
  assert.equal(repairedClaim.id, repairedJob.id);
  assert.equal(store.processBridgeCleanupJob(repairedClaim, 'inventory-worker-repaired').ok, true);
  assertArtifactsRemoved(unsafe);
});

test('an existing Bridge cleanup is reported instead of queued twice', () => {
  const sessionKey = 'single:inventory-queued-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  createTask('inventory-queued', sessionKey);
  const artifacts = createBridgeArtifacts(sessionKey);
  assert.equal(store.deleteSession('inventory-queued'), true);
  const inventory = store.listBridgeRuntimeInventory();
  const record = inventory.sessions.find((session) => session.sessionId === artifacts.sessionId);
  assert.equal(record.category, 'cleanup_queued');
  assert.equal(record.reclaimable, false);
  assert.equal(record.cleanupJob.status, 'pending');
  const replay = store.requestBridgeSessionReclaim(artifacts.sessionId, artifacts.sessionId);
  assert.equal(replay.id, record.cleanupJob.id);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM bridge_cleanup_jobs WHERE session_key=?')
    .get(sessionKey).count, 1);
  const claimed = claimOne('inventory-worker-queued');
  assert.equal(store.processBridgeCleanupJob(claimed, 'inventory-worker-queued').ok, true);
  assertArtifactsRemoved(artifacts);
});

test('Bridge runtime permission migration is private and never follows links', () => {
  const permissionRoot = path.join(bridgeRuntimeRoot, 'permission-migration');
  const nested = path.join(permissionRoot, 'nested');
  const regular = path.join(nested, 'regular.txt');
  const executable = path.join(nested, 'tool.sh');
  const outside = path.join(tempDir, 'permission-outside.txt');
  const linked = path.join(nested, 'outside-link');
  fs.mkdirSync(nested, { recursive: true, mode: 0o755 });
  fs.writeFileSync(regular, 'regular', { mode: 0o644 });
  fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(outside, 'outside', { mode: 0o666 });
  fs.symlinkSync(outside, linked);
  fs.chmodSync(permissionRoot, 0o755);
  fs.chmodSync(nested, 0o755);
  fs.chmodSync(regular, 0o644);
  fs.chmodSync(executable, 0o755);
  fs.chmodSync(outside, 0o666);

  const result = secureBridgeRuntimeStorage();
  assert.ok(result.runtime.directories > 0);
  assert.equal(fs.statSync(permissionRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(nested).mode & 0o777, 0o700);
  assert.equal(fs.statSync(regular).mode & 0o777, 0o600);
  assert.equal(fs.statSync(executable).mode & 0o777, 0o700);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o666);
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
});
