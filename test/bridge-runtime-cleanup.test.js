const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
  releaseBridgeSessionProcess,
  releaseBridgeSessionProcessAndWait,
  releaseOrphanTaskProcesses,
  sessionDaemonProcesses,
  cleanupBridgeSessionResources,
  secureBridgeRuntimeStorage,
} = require('../src/bridge-runtime-cleanup');
const { inspectProcess, signalVerifiedProcessGroup } = require('../src/process-identity');

function writeProcessFixture(procRoot, pid, argv, environment) {
  const directory = path.join(procRoot, String(pid));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'cmdline'), `${argv.join('\0')}\0`);
  fs.writeFileSync(path.join(directory, 'environ'), Object.entries(environment)
    .map(([key, value]) => `${key}=${value}\0`).join(''));
}

async function spawnRuntimeComponent(t, artifacts, role, { stubborn = false, taskId = '' } = {}) {
  const executable = path.join(artifacts.targets.codexHome,
    role === 'code-mode' ? 'codex-code-mode-host' : 'codex');
  if (!fs.existsSync(executable)) fs.symlinkSync(process.execPath, executable);
  const args = role === 'daemon' ? ['app-server', '--managed-daemon']
    : role === 'pid-loop' ? ['app-server', 'daemon', 'pid-update-loop']
      : role === 'cli' ? ['resume', 'fixture-thread'] : [];
  const child = spawn(executable, ['-e',
    `${stubborn ? 'process.on("SIGTERM",()=>{});' : ''}setInterval(()=>{},1000);process.stdout.write("ready");`,
    ...args], {
    detached: true,
    env: { ...process.env, CODEX_HOME: artifacts.targets.codexHome, WECOM_BRIDGE_SESSION_ID: artifacts.sessionId,
      ...(taskId ? taskRuntimeEnvironment(artifacts, taskId) : {}),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(async () => {
    if (child.exitCode != null || child.signalCode != null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Runtime fixture exited before ready: ${code}`)));
  });
  return child;
}

function processRunning(pid) {
  const identity = inspectProcess(pid);
  return identity != null && identity.state !== 'Z';
}

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
  return { sessionId, targets, record, sourceDir };
}

function taskRuntimeEnvironment(artifacts, taskId) {
  return { CODEX_HOME: artifacts.targets.codexHome, CODEX_TASK_ID: taskId,
    WECOM_BRIDGE_BOT_ID: 'codex-task-sessions', WECOM_BRIDGE_CHAT_KEY: artifacts.record.chatKey,
    WECOM_BRIDGE_SESSION_ID: artifacts.sessionId, WECOM_BRIDGE_SOURCE_DIR: artifacts.sourceDir,
  };
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

test('releases only the matching managed Codex daemon and preserves Session files', () => {
  const sessionKey = 'single:runtime-release-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const artifacts = createBridgeArtifacts(sessionKey);
  const procRoot = path.join(tempDir, 'proc-runtime-release');
  const procDir = path.join(procRoot, '12345');
  fs.mkdirSync(procDir, { recursive: true });
  fs.writeFileSync(path.join(procDir, 'cmdline'), Buffer.from(
    `${artifacts.targets.codexHome}/packages/app-server-daemon/releases/test/bin/codex\0app-server\0--listen\0unix://\0--managed-daemon\0`,
  ));
  fs.writeFileSync(path.join(procDir, 'environ'), Buffer.from(
    `WECOM_BRIDGE_SESSION_ID=${artifacts.sessionId}\0CODEX_HOME=${artifacts.targets.codexHome}\0`,
  ));
  const kills = [];
  assert.deepEqual(sessionDaemonProcesses(artifacts.sessionId, artifacts.targets.codexHome, { procRoot }), [
    { pid: 12345, commandLine: `${artifacts.targets.codexHome}/packages/app-server-daemon/releases/test/bin/codex app-server --listen unix:// --managed-daemon` },
  ]);
  const released = releaseBridgeSessionProcess(sessionKey, {
    procRoot,
    inspectProcess: pid => ({ pid, startTicks: '123', state: 'S' }),
    killProcess(pid, signal) { kills.push({ pid, signal }); },
  });
  assert.deepEqual(released.released, [12345]);
  assert.deepEqual(kills, [{ pid: 12345, signal: 'SIGTERM' }]);
  assert.equal(fs.existsSync(artifacts.targets.recordFile), true);
  assert.equal(fs.existsSync(artifacts.targets.codexHome), true);
  assert.equal(resolveBridgeSessionRuntime(sessionKey).threadId, artifacts.record.threadId);
});

test('idle daemon release confirms exit and preserves the resumable thread and files', async () => {
  const sessionKey = 'single:runtime-idle-release';
  const artifacts = createBridgeArtifacts(sessionKey);
  const binary = path.join(artifacts.targets.codexHome, 'codex');
  fs.symlinkSync(process.execPath, binary);
  const child = spawn(binary, ['-e',
    'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);process.stdout.write("ready");',
    'app-server', '--managed-daemon'], {
    env: { ...process.env, CODEX_HOME: artifacts.targets.codexHome, WECOM_BRIDGE_SESSION_ID: artifacts.sessionId },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    const result = await releaseBridgeSessionProcessAndWait(sessionKey, { graceMs: 50 });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.released, [child.pid]);
    assert.equal(sessionDaemonProcesses(artifacts.sessionId, artifacts.targets.codexHome).length, 0);
    assert.equal(resolveBridgeSessionRuntime(sessionKey).threadId, artifacts.record.threadId);
    assertArtifactsExist(artifacts);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }
});

test('discovers daemon, PID maintenance and code hosts only for the exact Session', () => {
  const artifacts = createBridgeArtifacts('single:runtime-component-discovery');
  const procRoot = path.join(tempDir, 'proc-component-discovery');
  const home = artifacts.targets.codexHome;
  const codex = path.join(home, 'packages', 'release with spaces', 'bin', 'codex');
  const environment = { CODEX_HOME: home, WECOM_BRIDGE_SESSION_ID: artifacts.sessionId };
  const fixtures = [
    [201, [codex, 'app-server', '--managed-daemon'], environment],
    [202, [codex, 'app-server', 'daemon', 'pid-update-loop'], environment],
    [203, [path.join(path.dirname(codex), 'codex-code-mode-host')], environment],
    [204, [codex, 'app-server', 'daemon', 'pid-update-loop'], { ...environment, WECOM_BRIDGE_SESSION_ID: 'another-session' }],
    [205, [codex, 'app-server', '--managed-daemon'], { ...environment, CODEX_HOME: `${home}-other` }],
    [206, ['/usr/bin/python3', 'pytest'], environment],
    [207, [codex, 'exec', 'some command containing app-server --managed-daemon'], environment],
    [208, [codex, 'resume', 'thread-id'], environment],
    [209, [`${home}-other/codex`, 'app-server', '--managed-daemon'], environment],
    [210, [codex, 'app-server', '--managed-daemon'], { WECOM_BRIDGE_SESSION_ID: artifacts.sessionId }],
    [211, ['/usr/local/bin/codex', 'resume', 'thread-id'], environment],
  ];
  for (const [pid, argv, env] of fixtures) writeProcessFixture(procRoot, pid, argv, env);
  assert.deepEqual(sessionDaemonProcesses(artifacts.sessionId, home, { procRoot }).map(match => match.pid), [201, 202, 203]);
  assert.deepEqual(sessionDaemonProcesses(artifacts.sessionId, home, { procRoot, includeCliMain: true }).map(match => match.pid),
    [201, 202, 203, 207, 208, 211]);
  assert.deepEqual(sessionDaemonProcesses('', home, { procRoot }), []);
  assert.deepEqual(sessionDaemonProcesses(artifacts.sessionId, '', { procRoot }), []);
});

test('idle release stops all detached Codex components and retains reconnect and background work', async t => {
  const artifacts = createBridgeArtifacts('single:runtime-all-components');
  const other = createBridgeArtifacts('single:runtime-unrelated-components');
  const children = [];
  for (const role of ['daemon', 'pid-loop', 'code-mode']) {
    children.push(await spawnRuntimeComponent(t, artifacts, role, { stubborn: true }));
  }
  const unrelated = await spawnRuntimeComponent(t, other, 'pid-loop');
  const background = await spawnRuntimeComponent(t, artifacts, 'background');
  const result = await releaseBridgeSessionProcessAndWait('single:runtime-all-components', { graceMs: 30 });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.released.sort((a, b) => a - b), children.map(child => child.pid).sort((a, b) => a - b));
  for (const child of children) assert.equal(processRunning(child.pid), false);
  assert.equal(processRunning(unrelated.pid), true);
  assert.equal(processRunning(background.pid), true);
  assertArtifactsExist(artifacts);
  assert.equal(resolveBridgeSessionRuntime('single:runtime-all-components').threadId, artifacts.record.threadId);
});

test('task deletion waits for every Codex component to exit before removing runtime files', async t => {
  const sessionKey = 'single:runtime-delete-components';
  createTask('runtime-delete-components', sessionKey);
  const artifacts = createBridgeArtifacts(sessionKey);
  const children = [];
  for (const role of ['daemon', 'pid-loop', 'code-mode']) children.push(await spawnRuntimeComponent(t, artifacts, role));
  store.deleteSession('runtime-delete-components');
  const job = claimOne('runtime-delete-worker');
  const result = await store.processBridgeCleanupJob(job, 'runtime-delete-worker');
  assert.equal(result.ok, true, JSON.stringify(result));
  for (const child of children) assert.equal(processRunning(child.pid), false, `Leaked process ${child.pid}`);
  assertArtifactsRemoved(artifacts);
});

test('failed process release keeps the Session files for retry', async () => {
  const sessionKey = 'single:runtime-cleanup-retry';
  const artifacts = createBridgeArtifacts(sessionKey);
  const procRoot = path.join(tempDir, 'proc-cleanup-retry');
  writeProcessFixture(procRoot, 301, [path.join(artifacts.targets.codexHome, 'codex'), 'app-server', 'daemon', 'pid-update-loop'], {
    CODEX_HOME: artifacts.targets.codexHome, WECOM_BRIDGE_SESSION_ID: artifacts.sessionId,
  });
  await assert.rejects(cleanupBridgeSessionResources({ sessionKey, sourceDir: projectDir }, {
    procRoot, graceMs: 0, killWaitMs: 0,
    inspectProcess: pid => ({ pid, startTicks: '123', state: 'S' }),
    killProcess() { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); },
  }), /still running|permission denied/);
  assertArtifactsExist(artifacts);
});

test('release finds a helper created as the daemon exits', async () => {
  const sessionKey = 'single:runtime-late-helper';
  const artifacts = createBridgeArtifacts(sessionKey);
  const procRoot = path.join(tempDir, 'proc-late-helper');
  const environment = { CODEX_HOME: artifacts.targets.codexHome, WECOM_BRIDGE_SESSION_ID: artifacts.sessionId };
  writeProcessFixture(procRoot, 401, [path.join(artifacts.targets.codexHome, 'codex'), 'app-server', '--managed-daemon'], environment);
  const living = new Set([401]);
  const kills = [];
  const result = await releaseBridgeSessionProcessAndWait(sessionKey, {
    procRoot, graceMs: 0, killWaitMs: 0,
    inspectProcess: pid => living.has(pid) ? { pid, startTicks: String(pid), state: 'S' } : null,
    killProcess(pid, signal) {
      kills.push({ pid, signal });
      living.delete(pid);
      fs.rmSync(path.join(procRoot, String(pid)), { recursive: true });
      if (pid === 401) {
        writeProcessFixture(procRoot, 402, [path.join(artifacts.targets.codexHome, 'codex-code-mode-host')], environment);
        living.add(402);
      }
    },
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.released, [401, 402]);
  assert.deepEqual(kills, [{ pid: 401, signal: 'SIGTERM' }, { pid: 402, signal: 'SIGKILL' }]);
});

test('release does not signal a PID reused after process discovery', async () => {
  const sessionKey = 'single:runtime-pid-reuse';
  const artifacts = createBridgeArtifacts(sessionKey);
  const procRoot = path.join(tempDir, 'proc-pid-reuse');
  writeProcessFixture(procRoot, 501, [path.join(artifacts.targets.codexHome, 'codex'), 'app-server', 'daemon', 'pid-update-loop'], {
    CODEX_HOME: artifacts.targets.codexHome, WECOM_BRIDGE_SESSION_ID: artifacts.sessionId,
  });
  let inspections = 0;
  const result = await releaseBridgeSessionProcessAndWait(sessionKey, {
    procRoot,
    inspectProcess(pid) {
      inspections++;
      if (inspections > 1) fs.rmSync(path.join(procRoot, String(pid)), { recursive: true, force: true });
      return { pid, state: 'S', startTicks: inspections === 1 ? 'before' : 'after' };
    },
    killProcess() { assert.fail('A different process reused the discovered PID'); },
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.released, [501]);
});

test('cleanup releases orphan helpers even when the Session record and Codex home are missing', async t => {
  const sessionKey = 'single:runtime-missing-record';
  const artifacts = createBridgeArtifacts(sessionKey);
  const child = await spawnRuntimeComponent(t, artifacts, 'pid-loop');
  fs.unlinkSync(artifacts.targets.recordFile);
  fs.rmSync(artifacts.targets.codexHome, { recursive: true });
  const result = await cleanupBridgeSessionResources({ sessionKey, sourceDir: projectDir });
  assert.equal(result.recordFound, false);
  assert.deepEqual(result.released, [child.pid]);
  assert.equal(processRunning(child.pid), false);
  assertArtifactsRemoved(artifacts);
});

test('idle release recovers missing Session records without removing history or background work', async t => {
  const sessionKey = 'single:idle-release-missing-record';
  const artifacts = createBridgeArtifacts(sessionKey);
  const other = createBridgeArtifacts('single:idle-release-other-session');
  const components = [];
  for (const role of ['daemon', 'pid-loop', 'code-mode']) components.push(await spawnRuntimeComponent(t, artifacts, role));
  const unrelated = await spawnRuntimeComponent(t, other, 'pid-loop');
  const background = await spawnRuntimeComponent(t, artifacts, 'background');
  fs.unlinkSync(artifacts.targets.recordFile);
  const result = await releaseBridgeSessionProcessAndWait(sessionKey, { sourceDir: projectDir });
  assert.equal(result.sessionId, artifacts.sessionId);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(new Set(result.released), new Set(components.map(child => child.pid)));
  for (const child of components) assert.equal(processRunning(child.pid), false);
  assert.equal(processRunning(unrelated.pid), true);
  assert.equal(processRunning(background.pid), true);
  for (const directory of [artifacts.targets.codexHome, artifacts.targets.workspaceRoot, artifacts.targets.chatfileDir]) {
    assert.equal(fs.readFileSync(path.join(directory, 'evidence.txt'), 'utf8'), sessionKey);
  }
  assert.equal(fs.existsSync(artifacts.targets.recordFile), false);
});

test('idle release reports missing identity rather than treating it as a successful empty release', async () => {
  await assert.rejects(releaseBridgeSessionProcessAndWait('single:idle-release-unknown', {
    killProcess() { assert.fail('An unresolved Session must not signal any process'); },
  }), /source directory.*unavailable/i);
});

test('full deletion reclaims an orphan CLI while idle release preserves CLI processes', async t => {
  const key = 'single:explicit-delete-orphan-cli';
  const artifacts = createBridgeArtifacts(key);
  const other = createBridgeArtifacts('single:explicit-delete-other-cli');
  const cli = await spawnRuntimeComponent(t, artifacts, 'cli');
  const unrelated = await spawnRuntimeComponent(t, other, 'cli');
  const business = await spawnRuntimeComponent(t, artifacts, 'background');
  assert.deepEqual((await releaseBridgeSessionProcessAndWait(key)).released, []);
  assert.equal(processRunning(cli.pid), true);
  const result = await cleanupBridgeSessionResources({ sessionKey: key, sourceDir: projectDir });
  assert(result.released.includes(cli.pid));
  assert.equal(processRunning(cli.pid), false);
  assert.equal(processRunning(unrelated.pid), true);
  assert.equal(processRunning(business.pid), true);
});

test('explicit Task cleanup stops an unregistered process group even after its leader exits', async t => {
  const key = 'single:unregistered-owned-process';
  const artifacts = createBridgeArtifacts(key);
  const childCode = 'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},1000);process.stdout.write("ready");';
  const parentCode = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{env:{},stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>process.stdout.write(JSON.stringify({pid:child.pid})));`;
  const parent = spawn(process.execPath, ['-e', parentCode], { detached: true,
    env: { ...process.env, CODEX_HOME: artifacts.targets.codexHome, WECOM_BRIDGE_SESSION_ID: artifacts.sessionId },
    stdio: ['ignore', 'pipe', 'ignore'] });
  const identity = inspectProcess(parent.pid);
  t.after(() => signalVerifiedProcessGroup(identity, 'SIGKILL'));
  const childPid = await new Promise((resolve, reject) => {
    parent.stdout.once('data', data => resolve(JSON.parse(data.toString()).pid)); parent.once('error', reject);
  });
  assert.deepEqual((await releaseBridgeSessionProcessAndWait(key)).released, []);
  assert.equal(processRunning(parent.pid), true); assert.equal(processRunning(childPid), true);
  const result = await releaseBridgeSessionProcessAndWait(key, { includeTaskProcesses: true, graceMs: 30 });
  assert.deepEqual(result.errors, []);
  assert.equal(processRunning(parent.pid), false); assert.equal(processRunning(childPid), false);
  assertArtifactsExist(artifacts);
});

test('Task process cleanup binds SDK processes to the original Attempt when their Codex home changed', async () => {
  const key = 'single:attempt-bound-process'; const artifacts = createBridgeArtifacts(key);
  const procRoot = path.join(tempDir, 'proc-attempt-bound');
  for (const [pid, taskId, attemptId] of [[711, 'owned-task', 'old-attempt'], [712, 'owned-task', 'replacement-attempt'], [713, 'other-task', 'old-attempt']]) {
    writeProcessFixture(procRoot, pid, ['/usr/bin/python3', 'pytest'], { CODEX_TASK_ID: taskId,
      CODEX_TASK_ATTEMPT_ID: attemptId, CODEX_HOME: '/changed-sdk-home' });
  }
  const living = new Set([711, 712, 713]); const signalled = [];
  const result = await releaseBridgeSessionProcessAndWait(key, { procRoot, includeTaskProcesses: true,
    taskContext: { taskId: 'owned-task', attemptIds: ['old-attempt'] },
    inspectProcess: pid => living.has(pid) ? { pid, startTicks: String(pid), state: 'S' } : null,
    killProcess(pid) { signalled.push(pid); living.delete(pid); },
  });
  assert.deepEqual(result.errors, []); assert.deepEqual(signalled, [711]);
  assert(living.has(712)); assert(living.has(713)); assertArtifactsExist(artifacts);
});

test('orphan sweep releases deleted Task components without a Session record and retains files and business processes', async t => {
  const taskId = 'deleted-task-orphan-sweep';
  const sessionKey = `single:${taskId}`;
  createTask(taskId, sessionKey);
  const artifacts = createBridgeArtifacts(sessionKey);
  const components = [];
  for (const role of ['daemon', 'pid-loop', 'code-mode']) {
    components.push(await spawnRuntimeComponent(t, artifacts, role, { taskId, stubborn: true }));
  }
  const business = await spawnRuntimeComponent(t, artifacts, 'background', { taskId });
  const activeId = 'orphan-sweep-active-cli';
  createTask(activeId, `single:${activeId}`, 'running');
  t.after(() => setTaskRuntime(activeId, `single:${activeId}`, 'waiting_review'));
  const active = createBridgeArtifacts(`single:${activeId}`);
  const activeHost = await spawnRuntimeComponent(t, active, 'code-mode', { taskId: activeId });
  store.deleteSession(taskId);
  fs.unlinkSync(artifacts.targets.recordFile);
  const results = await store.releaseOrphanTaskRuntimes({ graceMs: 30 });
  assert.equal(results.length, 1);
  assert.equal(results[0].taskId, taskId);
  assert.deepEqual(results[0].errors, []);
  assert.deepEqual(new Set(results[0].released), new Set(components.map(child => child.pid)));
  assert.equal(processRunning(business.pid), true);
  assert.equal(processRunning(activeHost.pid), true);
  assertArtifactsExist(active);
  for (const directory of [artifacts.targets.codexHome, artifacts.targets.workspaceRoot, artifacts.targets.chatfileDir]) {
    assert.equal(fs.readFileSync(path.join(directory, 'evidence.txt'), 'utf8'), sessionKey);
  }
  const audit = getDatabase().prepare("SELECT * FROM audit_events WHERE kind='runtime.orphan.released' AND entity_id=?")
    .get(artifacts.sessionId);
  assert(audit);
  assert.deepEqual(JSON.parse(audit.payload_json).released, results[0].released);
  assert.deepEqual(await store.releaseOrphanTaskRuntimes(), []);
  const job = claimOne('orphan-sweep-delete-worker');
  assert.equal((await store.processBridgeCleanupJob(job, 'orphan-sweep-delete-worker')).ok, true);
});

test('orphan sweep validates platform ownership even when all native files are gone', async () => {
  const artifacts = createBridgeArtifacts('single:orphan-no-files');
  const procRoot = path.join(tempDir, 'proc-orphan-no-files');
  const environment = taskRuntimeEnvironment(artifacts, 'absent-task');
  const codex = path.join(artifacts.targets.codexHome, 'codex');
  const argv = [codex, 'app-server', 'daemon', 'pid-update-loop'];
  const fixtures = [
    [601, argv, environment],
    [602, argv, { ...environment, CODEX_TASK_ID: '' }],
    [603, argv, { ...environment, WECOM_BRIDGE_BOT_ID: 'other-bot' }],
    [604, argv, { ...environment, WECOM_BRIDGE_CHAT_KEY: 'single:other-session' }],
    [605, argv, { ...environment, WECOM_BRIDGE_SOURCE_DIR: '' }],
    [606, ['/usr/bin/python3', 'pytest'], environment],
    [607, [codex, 'resume', 'thread-id'], environment],
    [608, argv, { ...environment, WECOM_BRIDGE_CHAT_KEY: 'room:other-session' }],
  ];
  for (const [pid, args, env] of fixtures) writeProcessFixture(procRoot, pid, args, env);
  fs.unlinkSync(artifacts.targets.recordFile);
  fs.rmSync(artifacts.targets.codexHome, { recursive: true });
  const living = new Set(fixtures.map(([pid]) => pid));
  const kills = [];
  const result = await releaseOrphanTaskProcesses({
    procRoot, isReferenced: () => false,
    inspectProcess: pid => living.has(pid) ? { pid, startTicks: String(pid), state: 'S' } : null,
    killProcess(pid, signal) {
      kills.push({ pid, signal }); living.delete(pid);
      fs.rmSync(path.join(procRoot, String(pid)), { recursive: true });
    },
  });
  // Discovery rejects the other environments; release must also keep them excluded.
  assert.deepEqual(kills, [{ pid: 601, signal: 'SIGTERM' }]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].released, [601]);
  assert.deepEqual(result[0].errors, []);
});

test('orphan sweep checks both Task ID and Session key references and pauses for maintenance', async () => {
  const procRoot = path.join(tempDir, 'proc-orphan-references');
  const artifacts = createBridgeArtifacts('single:orphan-referenced-key');
  const environment = taskRuntimeEnvironment(artifacts, 'orphan-referenced-id');
  writeProcessFixture(procRoot, 611, [path.join(artifacts.targets.codexHome, 'codex'), 'app-server', '--managed-daemon'], environment);
  const options = { procRoot, inspectProcess: pid => ({ pid, startTicks: '1', state: 'S' }),
    killProcess() { assert.fail('A referenced or maintenance-protected runtime must stay alive'); },
  };
  store.saveSession('orphan-referenced-id', { name: 'reference by id', objective: 'fixture', workingDir: projectDir });
  assert.deepEqual(await store.releaseOrphanTaskRuntimes(options), []);
  getDatabase().prepare('UPDATE tasks SET persistent_session_key=? WHERE id=?')
    .run(artifacts.record.chatKey, 'orphan-referenced-id');
  writeProcessFixture(procRoot, 611, [path.join(artifacts.targets.codexHome, 'codex'), 'app-server', '--managed-daemon'],
    { ...environment, CODEX_TASK_ID: 'absent-orphan-task-id' });
  assert.deepEqual(await store.releaseOrphanTaskRuntimes(options), []);
  getDatabase().prepare("UPDATE tasks SET persistent_session_key='' WHERE id=?").run('orphan-referenced-id');
  const maintenance = store.acquirePlatformMaintenance('test_maintenance', 'test:orphan-sweep', 30000);
  try { assert.deepEqual(await store.releaseOrphanTaskRuntimes(options), []); }
  finally { store.releasePlatformMaintenance(maintenance.owner); }
});

test('orphan release stops signaling when a Task references the Session during shutdown', async () => {
  const artifacts = createBridgeArtifacts('single:orphan-new-reference');
  const procRoot = path.join(tempDir, 'proc-orphan-new-reference');
  const environment = taskRuntimeEnvironment(artifacts, 'orphan-new-reference');
  const codex = path.join(artifacts.targets.codexHome, 'codex');
  writeProcessFixture(procRoot, 621, [codex, 'app-server', '--managed-daemon'], environment);
  writeProcessFixture(procRoot, 622, [codex, 'app-server', 'daemon', 'pid-update-loop'], environment);
  let referenced = false;
  const kills = [];
  const result = await releaseOrphanTaskProcesses({
    procRoot, isReferenced: () => referenced,
    inspectProcess: pid => ({ pid, startTicks: String(pid), state: 'S' }),
    killProcess(pid, signal) { kills.push({ pid, signal }); referenced = true; },
    delay: async () => {}, graceMs: 0, killWaitMs: 0,
  });
  assert.deepEqual(kills, [{ pid: 621, signal: 'SIGTERM' }]);
  assert.equal(result[0].skipped, 'runtime_referenced');
  assert.deepEqual(result[0].errors, []);
});

test('orphan release skips a reused PID between process discovery and signaling', async () => {
  const artifacts = createBridgeArtifacts('single:orphan-reused-pid');
  const procRoot = path.join(tempDir, 'proc-orphan-reused-pid');
  writeProcessFixture(procRoot, 631, [path.join(artifacts.targets.codexHome, 'codex'), 'app-server', 'daemon', 'pid-update-loop'],
    taskRuntimeEnvironment(artifacts, 'orphan-reused-pid'));
  let inspections = 0;
  const result = await releaseOrphanTaskProcesses({
    procRoot, isReferenced: () => false,
    inspectProcess(pid) {
      inspections++;
      if (inspections > 2) fs.rmSync(path.join(procRoot, String(pid)), { recursive: true, force: true });
      return { pid, state: 'S', startTicks: inspections <= 2 ? 'before' : 'after' };
    },
    killProcess() { assert.fail('The PID now belongs to another process'); },
  });
  assert.deepEqual(result[0].errors, []);
});

test('cleanup rechecks Session references after asynchronous process release', async t => {
  const taskId = 'runtime-referenced-during-release';
  const sessionKey = `single:${taskId}`;
  createTask(taskId, sessionKey);
  const artifacts = createBridgeArtifacts(sessionKey);
  await spawnRuntimeComponent(t, artifacts, 'pid-loop', { stubborn: true });
  store.deleteSession(taskId);
  const job = claimOne('runtime-reference-worker');
  const pending = store.processBridgeCleanupJob(job, 'runtime-reference-worker');
  createTask(taskId, sessionKey);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /still referenced/);
  assertArtifactsExist(artifacts);
  assert.equal(getDatabase().prepare('SELECT status FROM bridge_cleanup_jobs WHERE id=?').get(job.id).status, 'retry');
  setTaskRuntime(taskId, '');
  store.deleteSession(taskId);
  makeRetryDue(job.id);
  const retry = claimOne('runtime-reference-retry');
  assert.equal((await store.processBridgeCleanupJob(retry, 'runtime-reference-retry')).ok, true);
  assertArtifactsRemoved(artifacts);
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

test('deleting a task durably releases only its own Bridge Session resources', async () => {
  const completedBefore = store.bridgeCleanupStatus().completed;
  const sessionKey = 'single:cleanup-delete-11111111-1111-4111-8111-111111111111';
  const otherKey = 'single:cleanup-other-22222222-2222-4222-8222-222222222222';
  createTask('cleanup-delete', sessionKey);
  const artifacts = createBridgeArtifacts(sessionKey);
  const other = createBridgeArtifacts(otherKey);

  assert.equal(store.deleteSession('cleanup-delete'), true);
  assert.equal(store.getSession('cleanup-delete'), null);
  const job = claimOne('cleanup-worker-delete');
  assert.equal(job.reason, 'deleted');
  assert.equal((await store.processBridgeCleanupJob(job, 'cleanup-worker-delete')).ok, true);
  assertArtifactsRemoved(artifacts);
  assertArtifactsExist(other);

  const status = store.bridgeCleanupStatus();
  assert.equal(status.queued, 0);
  assert.equal(status.completed, completedBefore + 1);
  const audit = store.listAudit({ sessionId: 'cleanup-delete', limit: 20 });
  assert.ok(audit.some((event) => event.kind === 'bridge.session.cleanup.queued'));
  assert.ok(audit.some((event) => event.kind === 'bridge.session.cleanup.completed'));
});

test('completion retains Runtime and restoration resumes the archived task idempotently', async () => {
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
  assert.equal((await store.processBridgeCleanupJob(job, 'cleanup-worker-complete')).ok, true);
  assertArtifactsRemoved(artifacts);
});

test('reset retains the Task and history, reclaims the old Runtime, and restore follows the latest Session', async () => {
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
  assert.equal((await store.processBridgeCleanupJob(oldCleanup, 'cleanup-worker-reset-old')).ok, true);
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
  assert.equal((await store.processBridgeCleanupJob(latestCleanup, 'cleanup-worker-reset-latest')).ok, true);
  assertArtifactsRemoved(latestArtifacts);
});

test('a replacement generation cannot make an old cleanup delete its live Session key', async () => {
  const sessionKey = 'single:cleanup-reuse-44444444-4444-4444-8444-444444444444';
  createTask('cleanup-reuse', sessionKey);
  const artifacts = createBridgeArtifacts(sessionKey);
  assert.equal(store.deleteSession('cleanup-reuse'), true);
  const replacement = store.saveSession('cleanup-reuse', {
    name: 'replacement', objective: 'Must survive stale cleanup.', workingDir: projectDir,
  });
  setTaskRuntime('cleanup-reuse', sessionKey, 'waiting_review');

  const firstClaim = claimOne('cleanup-worker-reuse-1');
  const blocked = await store.processBridgeCleanupJob(firstClaim, 'cleanup-worker-reuse-1');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /still referenced/);
  assertArtifactsExist(artifacts);
  assert.equal(store.getSession('cleanup-reuse').createdAt, replacement.createdAt);

  getDatabase().prepare("UPDATE tasks SET persistent_session_key='' WHERE id='cleanup-reuse'").run();
  makeRetryDue(firstClaim.id);
  const recovered = claimOne('cleanup-worker-reuse-2');
  assert.equal((await store.processBridgeCleanupJob(recovered, 'cleanup-worker-reuse-2')).ok, true);
  assertArtifactsRemoved(artifacts);
  store.deleteSession('cleanup-reuse');
});

test('expired cleanup ownership is reclaimed after a Worker interruption', async () => {
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
  assert.equal((await store.processBridgeCleanupJob(recovered, 'cleanup-worker-recovered')).ok, true);
  assert.equal(store.getPlatformActivityCounts().bridgeCleanups, 0);
  assertArtifactsRemoved(artifacts);
});

test('malformed, duplicate, and path-escaping records fail closed without partial deletion', async () => {
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
    const result = await store.processBridgeCleanupJob(job, `worker-${scenario.id}`);
    assert.equal(result.ok, false);
    assert.match(result.error, scenario.error);
    assertArtifactsExist(artifacts);
  }
});

test('a symbolic-link target is rejected without touching its destination', async () => {
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
  const result = await store.processBridgeCleanupJob(job, 'cleanup-worker-link');
  assert.equal(result.ok, false);
  assert.match(result.error, /symbolic link/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.lstatSync(artifacts.targets.workspaceRoot).isSymbolicLink(), true);
  assert.equal(fs.existsSync(artifacts.targets.recordFile), true);
});

test('Bridge Session inventory classifies resources and manual reclaim is exact, durable, and idempotent', async () => {
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
  assert.equal((await store.processBridgeCleanupJob(orphanClaim, 'inventory-worker-orphan')).ok, true);
  assertArtifactsRemoved(orphan);

  const completedJob = store.requestBridgeSessionReclaim(completed.sessionId, completed.sessionId);
  const completedClaim = claimOne('inventory-worker-completed');
  assert.equal(completedClaim.id, completedJob.id);
  assert.equal(completedClaim.reason, 'completed');
  assert.equal((await store.processBridgeCleanupJob(completedClaim, 'inventory-worker-completed')).ok, true);
  assertArtifactsRemoved(completed);
  assert.equal(store.getSession('inventory-completed').status, 'completed');
  assert.deepEqual(store.listSessionWorklogs('inventory-completed').map((event) => ({
    id: event.id, kind: event.kind, message: event.message,
  })), [{
    id: 'inventory-completed-worklog', kind: 'agent.message', message: 'Retained Agent evidence',
  }]);

  assert.equal(store.deleteSession('inventory-owned'), true);
  const ownedClaim = claimOne('inventory-worker-owned');
  assert.equal((await store.processBridgeCleanupJob(ownedClaim, 'inventory-worker-owned')).ok, true);
  assertArtifactsRemoved(owned);

  fs.writeFileSync(unsafe.targets.recordFile, JSON.stringify(unsafe.record));
  const repairedJob = store.requestBridgeSessionReclaim(unsafe.sessionId, unsafe.sessionId);
  const repairedClaim = claimOne('inventory-worker-repaired');
  assert.equal(repairedClaim.id, repairedJob.id);
  assert.equal((await store.processBridgeCleanupJob(repairedClaim, 'inventory-worker-repaired')).ok, true);
  assertArtifactsRemoved(unsafe);
});

test('an existing Bridge cleanup is reported instead of queued twice', async () => {
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
  assert.equal((await store.processBridgeCleanupJob(claimed, 'inventory-worker-queued')).ok, true);
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
