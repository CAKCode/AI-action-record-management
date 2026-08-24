const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, spawn } = require('node:child_process');

const {
  inspectProcess,
  sameProcess,
  signalVerifiedProcessGroup,
} = require('../src/process-identity');
const {
  inspectVerifiedTaskCgroup,
  killVerifiedTaskCgroup,
  taskCgroupName,
} = require('../src/task-cgroup');

const ROOT_DIR = path.resolve(__dirname, '..');
const GATE = path.join(ROOT_DIR, 'bin', 'execution-gate.py');

function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      const value = predicate();
      if (value) resolve(value);
      else if (Date.now() >= deadline) reject(new Error('Timed out waiting for process condition'));
      else setTimeout(poll, 20);
    };
    poll();
  });
}

function processIsRunning(pid) {
  if (!inspectProcess(pid)) return false;
  try {
    return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function spawnWorkerPollHarness({
  failuresBeforeSuccess = null,
  exitAfterMs = 0,
  controlFailure = '',
  controlFailuresBeforeSuccess = null,
}) {
  const workerPath = path.join(ROOT_DIR, 'worker.js');
  const source = [
    "const Module = require('module');",
    `const workerPath = ${JSON.stringify(workerPath)};`,
    "const originalLoad = Module._load;",
    "let claims = 0;",
    "let controlCalls = 0;",
    "function maybeFailControl(name) {",
    `  if (name !== ${JSON.stringify(controlFailure)}) return;`,
    "  controlCalls += 1;",
    "  if (controlCalls === 1) return;",
    "  const failureNumber = controlCalls - 1;",
    controlFailuresBeforeSuccess == null
      ? "  throw new Error('injected persistent ' + name + ' failure');"
      : `  if (failureNumber <= ${controlFailuresBeforeSuccess}) throw new Error('injected transient ' + name + ' failure');`,
    "}",
    "const store = {",
    "  ensureStorage() {},",
    "  claimPendingCommands() {",
    "    claims += 1;",
    controlFailure
      ? "    return [];"
      : failuresBeforeSuccess == null
      ? "    throw new Error('injected persistent poll failure');"
      : `    if (claims <= ${failuresBeforeSuccess}) throw new Error('injected transient poll failure');`,
    "    return [];",
    "  },",
    "  finishClaimedCommand() {}, deferClaimedCommand() {}, failClaimedCommand() {},",
    "  acquireTaskLease() { return true; }, releaseTaskLease() { return true; },",
    "  recoverExpiredTasks() { maybeFailControl('recovery'); return []; }, getSession() { return null; },",
    "  claimDueScheduledJobs() { return []; }, dispatchClaimedScheduledJob() {},",
    "  claimExternalAttemptArchives() { maybeFailControl('external-archive'); return []; },",
    "  async processExternalAttemptArchive() { return { ok: true }; },",
    "  claimExternalArchiveVerifications() { return []; },",
    "  async processExternalArchiveVerification() { return { ok: true }; },",
    "  claimSkillReportArtifactJobs() { return []; },",
    "  async processSkillReportArtifactJob() { return { ok: true }; },",
    "  reconcileRunningExternalAttempts() { return []; },",
    "  performTaskRetentionCleanup() { return { skipped: true }; },",
    "  claimBridgeCleanupJobs() { maybeFailControl('bridge-cleanup'); return []; },",
    "  processBridgeCleanupJob() { return { ok: true }; },",
    "};",
    "const orchestrator = {",
    "  syncBridgeRuntime() {}, getRuntimeStatus() { return { ready: true, degradedReasons: [] }; },",
    "  async startSession() {}, pollCancellations() {}, heartbeatActive() { maybeFailControl('heartbeat'); },",
    "  listActiveSessions() { return []; }, shutdownWorker() {},",
    "};",
    "Module._load = function(request, parent, isMain) {",
    "  if (parent?.filename === workerPath) {",
    "    if (request === './src/store') return store;",
    "    if (request === './src/orchestrator') return orchestrator;",
    "    if (request === './src/utils') return { nowIso: () => new Date().toISOString() };",
    "    if (request === './src/database') return { closeDatabase() {} };",
    "    if (request === './src/workspaces') return { resolveWorkingDir: (value) => value };",
    "  }",
    "  return originalLoad.call(this, request, parent, isMain);",
    "};",
    "require(workerPath);",
    ...(exitAfterMs > 0 ? [
      `setTimeout(() => { console.log('claims=' + claims + ' controlCalls=' + controlCalls); process.exit(0); }, ${exitAfterMs});`,
    ] : []),
  ].join('\n');
  return spawn(process.execPath, ['-e', source], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function collectChildExit(child, timeoutMs) {
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  let timeout;
  try {
    const result = await Promise.race([
      waitForExit(child),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for worker harness: ${output}`)), timeoutMs);
      }),
    ]);
    return { ...result, output };
  } finally {
    clearTimeout(timeout);
  }
}

test('task cgroup kill requires the configured path and persisted inode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-cgroup-'));
  const previousRoot = process.env.CODEX_TASK_CGROUP_ROOT;
  const taskId = 'cgroup-identity-test';
  const cgroupPath = path.join(root, taskCgroupName(taskId));
  try {
    fs.writeFileSync(path.join(root, 'cgroup.procs'), '', 'utf8');
    fs.writeFileSync(path.join(root, 'cgroup.controllers'), 'pids', 'utf8');
    fs.mkdirSync(cgroupPath);
    fs.writeFileSync(path.join(cgroupPath, 'cgroup.procs'), '101\n202\n', 'utf8');
    fs.writeFileSync(path.join(cgroupPath, 'cgroup.threads'), '101\n102\n202\n', 'utf8');
    fs.writeFileSync(path.join(cgroupPath, 'cgroup.kill'), '', 'utf8');
    process.env.CODEX_TASK_CGROUP_ROOT = root;
    const inode = String(fs.lstatSync(cgroupPath).ino);

    assert.deepEqual(inspectVerifiedTaskCgroup({ taskId, cgroupPath, cgroupInode: inode }, { cgroupMount: root }), {
      verified: true, active: true, reason: '', processes: 2, threads: 3,
    });

    assert.deepEqual(killVerifiedTaskCgroup({ taskId, cgroupPath, cgroupInode: inode }, { cgroupMount: root }), {
      killed: true, reason: '', members: 2,
    });
    assert.equal(fs.readFileSync(path.join(cgroupPath, 'cgroup.kill'), 'utf8'), '1\n');
    assert.deepEqual(killVerifiedTaskCgroup({ taskId, cgroupPath, cgroupInode: '0' }, { cgroupMount: root }), {
      killed: false, reason: 'cgroup_identity_mismatch',
    });
    assert.deepEqual(killVerifiedTaskCgroup({ taskId, cgroupPath: root, cgroupInode: inode }, { cgroupMount: root }), {
      killed: false, reason: 'cgroup_unavailable_or_mismatch',
    });
  } finally {
    if (previousRoot == null) delete process.env.CODEX_TASK_CGROUP_ROOT;
    else process.env.CODEX_TASK_CGROUP_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('verified process-group signalling rejects a reused or stale PID identity', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  try {
    const identity = await waitFor(() => inspectProcess(child.pid));
    assert.equal(identity.processGroupId, child.pid);
    assert.equal(identity.sessionId, child.pid);
    assert.equal(sameProcess(identity, { requireGroupLeader: true, requireSessionLeader: true }), true);
    const stale = { ...identity, startTicks: String(BigInt(identity.startTicks) + 1n) };
    assert.deepEqual(signalVerifiedProcessGroup(stale), { signalled: false, reason: 'identity_mismatch' });
    assert.equal(processIsRunning(child.pid), true);
    assert.equal(signalVerifiedProcessGroup(identity).signalled, true);
    await waitForExit(child);
  } finally {
    if (processIsRunning(child.pid)) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }
});

test('the execution gate cannot run its target before an explicit release', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-execution-gate-'));
  const marker = path.join(tempDir, 'released');
  const child = spawn('python3', [
    GATE,
    '--',
    process.execPath,
    '-e',
    `require('fs').writeFileSync(${JSON.stringify(marker)}, 'released')`,
  ], {
    detached: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    await waitFor(() => inspectProcess(child.pid));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fs.existsSync(marker), false);
    child.stdin.end(Buffer.from([1]));
    const result = await waitForExit(child);
    assert.equal(result.code, 0, stderr);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'released');
  } finally {
    if (processIsRunning(child.pid)) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('an unreleased execution gate exits when its worker parent is killed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-parent-death-'));
  const pidFile = path.join(tempDir, 'gate.pid');
  const marker = path.join(tempDir, 'unexpected-target');
  const target = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')`;
  const helperSource = [
    "const fs = require('fs');",
    "const { spawn } = require('child_process');",
    `const child = spawn('python3', [${JSON.stringify(GATE)}, '--', process.execPath, '-e', ${JSON.stringify(target)}], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n');
  const helper = spawn(process.execPath, ['-e', helperSource], { stdio: 'ignore' });
  let gatePid;
  try {
    gatePid = await waitFor(() => {
      try { return Number(fs.readFileSync(pidFile, 'utf8')) || null; } catch { return null; }
    });
    await waitFor(() => inspectProcess(gatePid));
    helper.kill('SIGKILL');
    await waitForExit(helper);
    await waitFor(() => !processIsRunning(gatePid));
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (helper.exitCode == null && helper.signalCode == null) helper.kill('SIGKILL');
    if (gatePid && processIsRunning(gatePid)) {
      try { process.kill(-gatePid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('worker poll failures reset after a successful control-loop iteration', async () => {
  const child = spawnWorkerPollHarness({ failuresBeforeSuccess: 5, exitAfterMs: 2200 });
  try {
    const result = await collectChildExit(child, 5000);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.signal, null);
    assert.match(result.output, /recovered after 5 consecutive failures/);
    assert.match(result.output, /claims=\d+/);
    assert.doesNotMatch(result.output, /restarting after/);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await waitForExit(child);
  }
});

test('worker exits recoverably after sustained control-loop failures', async () => {
  const child = spawnWorkerPollHarness({});
  try {
    const result = await collectChildExit(child, 8000);
    assert.equal(result.code, 1, result.output);
    assert.equal(result.signal, null);
    assert.match(result.output, /restarting after 20 consecutive poll failures/);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await waitForExit(child);
  }
});

test('worker auxiliary control failures reset after a successful cycle', async () => {
  const child = spawnWorkerPollHarness({
    controlFailure: 'bridge-cleanup',
    controlFailuresBeforeSuccess: 2,
    exitAfterMs: 4200,
  });
  try {
    const result = await collectChildExit(child, 7000);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.signal, null);
    assert.match(result.output, /worker:bridge-cleanup.*recovered after 2 consecutive failures/);
    assert.match(result.output, /controlCalls=/);
    assert.doesNotMatch(result.output, /restarting after/);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await waitForExit(child);
  }
});

test('worker exits for supervisor recovery after sustained auxiliary control failures', async () => {
  const child = spawnWorkerPollHarness({ controlFailure: 'bridge-cleanup' });
  try {
    const result = await collectChildExit(child, 9000);
    assert.equal(result.code, 1, result.output);
    assert.equal(result.signal, null);
    assert.match(result.output, /worker:bridge-cleanup.*restarting after 5 consecutive failures/);
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await waitForExit(child);
  }
});

test('a forced worker shutdown stays recoverable and the next attempt completes', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fatal-recovery-'));
  const dataDir = path.join(tempDir, 'data');
  const runtimeDir = path.join(tempDir, 'runtime');
  const workspaceRoot = path.join(tempDir, 'workspace');
  const sourceHome = path.join(tempDir, 'codex-home');
  const workspaceSkills = path.join(tempDir, 'workspace-skills');
  const runnerPath = path.join(tempDir, 'runner.py');
  const helperPath = path.join(tempDir, 'helper.js');
  const markerPath = path.join(tempDir, 'first-attempt');
  for (const directory of [dataDir, runtimeDir, workspaceRoot, sourceHome, workspaceSkills]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(runnerPath, [
    'import json, os, sys, time',
    'args = sys.argv[1:]',
    'output_file = args[args.index("--output-file") + 1]',
    'stdout_file = args[args.index("--stdout-file") + 1]',
    'stderr_file = args[args.index("--stderr-file") + 1]',
    'marker = os.environ["FATAL_RECOVERY_MARKER"]',
    'if not os.path.exists(marker):',
    '    with open(marker, "w", encoding="utf-8") as handle: handle.write("started")',
    '    time.sleep(30)',
    'os.makedirs(os.path.dirname(output_file), exist_ok=True)',
    'with open(output_file, "w", encoding="utf-8") as handle: handle.write("RECOVERED_OK")',
    'line = json.dumps({"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}}) + "\\n"',
    'with open(stdout_file, "w", encoding="utf-8") as handle: handle.write(line)',
    'with open(stderr_file, "w", encoding="utf-8") as handle: handle.write("")',
    'print(json.dumps({"returncode": 0, "stdout": line, "stderr": ""}))',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(helperPath, [
    "const fs = require('fs');",
    "const store = require(process.env.PLATFORM_ROOT + '/src/store');",
    "const { closeDatabase } = require(process.env.PLATFORM_ROOT + '/src/database');",
    "const { startSession, shutdownWorker, listActiveSessions } = require(process.env.PLATFORM_ROOT + '/src/orchestrator');",
    "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
    "async function waitFor(predicate, timeoutMs = 8000) {",
    "  const deadline = Date.now() + timeoutMs;",
    "  while (Date.now() < deadline) { if (predicate()) return; await sleep(20); }",
    "  throw new Error('Timed out waiting for orchestrator state');",
    "}",
    "(async () => {",
    "  const taskId = 'fatal-recovery-task';",
    "  const workerId = 'fatal-recovery-worker';",
    "  store.ensureStorage();",
    "  store.saveSession(taskId, { name: 'Fatal Recovery', objective: 'Recover after fatal shutdown.', workingDir: '.', autoResume: true, maxRetries: 2 });",
    "  store.queueSessionRun(taskId, 'Start the first attempt.', 'fatal-recovery-first');",
    "  const [firstCommand] = store.claimPendingCommands(workerId, 1);",
    "  if (!firstCommand || !store.acquireTaskLease(taskId, workerId)) throw new Error('Could not claim the first attempt');",
    "  await startSession(firstCommand, workerId);",
    "  await waitFor(() => fs.existsSync(process.env.FATAL_RECOVERY_MARKER));",
    "  const forceRequested = new Promise((resolve) => {",
    "    const listener = (message) => {",
    "      if (message?.type !== 'test.force.shutdown') return;",
    "      process.off('message', listener);",
    "      resolve();",
    "    };",
    "    process.on('message', listener);",
    "  });",
    "  process.send({ type: 'test.execution.active' });",
    "  await forceRequested;",
    "  shutdownWorker(true);",
    "  await waitFor(() => listActiveSessions().length === 0);",
    "  const interrupted = store.getSession(taskId);",
    "  const firstTurns = store.listTurns(taskId);",
    "  const firstAttempts = store.listAttempts(taskId);",
    "  const recovered = store.recoverExpiredTasks();",
    "  const [secondCommand] = store.claimPendingCommands(workerId, 1);",
    "  if (!secondCommand || !store.acquireTaskLease(taskId, workerId)) throw new Error('Interrupted task was not recoverable');",
    "  await startSession(secondCommand, workerId);",
    "  await waitFor(() => listActiveSessions().length === 0);",
    "  process.send({",
    "    type: 'test.result',",
    "    interruptedStatus: interrupted.status,",
    "    firstTurnStatus: firstTurns[0]?.status,",
    "    firstAttemptStatus: firstAttempts[0]?.status,",
    "    recovered,",
    "    finalStatus: store.getSession(taskId).status,",
    "    turnStatuses: store.listTurns(taskId).map((turn) => turn.status),",
    "    attemptStatuses: store.listAttempts(taskId).map((attempt) => attempt.status),",
    "    worklogKinds: store.listSessionWorklogs(taskId).map((event) => event.kind),",
    "  });",
    "  closeDatabase();",
    "  process.exit(0);",
    "})().catch((error) => {",
    "  process.send?.({ type: 'test.error', error: error.stack || error.message });",
    "  process.exit(1);",
    "});",
    '',
  ].join('\n'), 'utf8');

  const child = fork(helperPath, [], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PLATFORM_ROOT: ROOT_DIR,
      BRIDGE_RUNNER: runnerPath,
      CODEX_DESK_DATA_DIR: dataDir,
      CODEX_DESK_RUNTIME_DIR: runtimeDir,
      CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
      SOURCE_CODEX_HOME: sourceHome,
      WORKSPACE_CODEX_SKILLS_DIR: workspaceSkills,
      CODEX_TASK_REAL_CODEX_BIN: process.execPath,
      CODEX_ALLOW_ROOT_EXECUTION: '1',
      FATAL_RECOVERY_MARKER: markerPath,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  const executionIdentities = [];
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for recovery result: ${output}`)), 12000);
      child.on('message', (message) => {
        if (message?.type === 'execution.register') {
          executionIdentities.push(message.identity);
          child.send({ type: 'supervisor.execution.registered', registrationId: message.registrationId });
        } else if (message?.type === 'test.execution.active') {
          child.send({ type: 'test.force.shutdown' });
        } else if (message?.type === 'test.error') {
          clearTimeout(timeout);
          reject(new Error(message.error));
        } else if (message?.type === 'test.result') {
          clearTimeout(timeout);
          resolve(message);
        }
      });
      child.once('exit', (code, signal) => {
        if (code === 0) return;
        clearTimeout(timeout);
        reject(new Error(`Recovery helper exited code=${code} signal=${signal || 'none'}: ${output}`));
      });
    });
    assert.equal(result.interruptedStatus, 'interrupted');
    assert.equal(result.firstTurnStatus, 'interrupted');
    assert.equal(result.firstAttemptStatus, 'interrupted');
    assert.deepEqual(result.recovered, [{ id: 'fatal-recovery-task', resumed: true, status: 'queued' }]);
    assert.equal(result.finalStatus, 'waiting_review');
    assert.deepEqual(result.turnStatuses, ['completed', 'interrupted']);
    assert.deepEqual(result.attemptStatuses, ['completed', 'interrupted']);
    assert.ok(result.worklogKinds.includes('session.interrupted'));
    assert.ok(result.worklogKinds.includes('session.resume.queued'));
    assert.ok(result.worklogKinds.includes('session.waiting_review'));
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    await waitForExit(child);
    for (const identity of executionIdentities) {
      try { signalVerifiedProcessGroup(identity, 'SIGKILL'); } catch {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
