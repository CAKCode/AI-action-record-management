const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { WebSocket } = require('ws');
const yazl = require('yazl');
const { inspectProcess } = require('../src/process-identity');
const { stableBridgeSessionId, sessionTargets } = require('../src/bridge-runtime-cleanup');

const ROOT_DIR = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-sessions-'));
const dataDir = path.join(tempDir, 'data');
const runtimeDir = path.join(tempDir, 'runtime');
const workspaceRoot = path.join(tempDir, 'workspaces');
const projectDir = path.join(workspaceRoot, 'project');
const outsideDir = path.join(tempDir, 'outside');
const sourceCodexHome = path.join(tempDir, 'codex-home');
const workspaceCodexSkills = path.join(tempDir, 'workspace-codex-skills');
const fakeBridgeRunner = path.join(tempDir, 'session_runner.py');
const bridgeArgsFile = path.join(tempDir, 'runner-args.ndjson');
const auditCommand = `printf 'audit-sentinel' && ${'x'.repeat(2300)}`;
const auditOutput = 'audit-sentinel-output\nsecond line\n';
const port = 19000 + (process.pid % 1000);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let serverOutput = '';

for (const dir of [dataDir, runtimeDir, projectDir, outsideDir]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(projectDir, 'README.md'), '# Test workspace\n', 'utf8');

const systemSkillDir = path.join(sourceCodexHome, 'skills', '.system', 'system-check');
const parentSkillDir = path.join(sourceCodexHome, 'skills', 'nested-parent');
const childSkillDir = path.join(parentSkillDir, 'child');
const workspaceApiSkillDir = path.join(workspaceCodexSkills, 'workspace-api-check');
for (const dir of [systemSkillDir, parentSkillDir, childSkillDir, workspaceApiSkillDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(systemSkillDir, 'SKILL.md'), '---\nname: system-check\ndescription: System check\n---\n# System Check\n', 'utf8');
fs.writeFileSync(path.join(parentSkillDir, 'SKILL.md'), '---\nname: nested-parent\ndescription: Parent skill\n---\n# Parent\n', 'utf8');
fs.writeFileSync(path.join(childSkillDir, 'SKILL.md'), '---\nname: child\ndescription: Child skill\n---\n# Child\n', 'utf8');
fs.writeFileSync(path.join(workspaceApiSkillDir, 'SKILL.md'), [
  '---',
  'name: workspace-api-check',
  'description: Workspace API check',
  '---',
  '# Workspace API Check',
  '',
].join('\n'), 'utf8');

const legacySessionDir = path.join(dataDir, 'sessions', 'legacy-finished');
const legacyArchivedAt = new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString();
fs.mkdirSync(legacySessionDir, { recursive: true });
fs.writeFileSync(path.join(legacySessionDir, 'session.json'), JSON.stringify({
  id: 'legacy-finished',
  name: 'Legacy Finished',
  objective: 'Migrated history',
  workingDir: projectDir,
  status: 'finished',
  bridgeSessionKey: 'single:legacy-finished',
  archivedAt: legacyArchivedAt,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: legacyArchivedAt,
}, null, 2));
fs.writeFileSync(path.join(legacySessionDir, 'worklog.ndjson'), `${JSON.stringify({
  id: 'legacy-event',
  ts: '2026-07-01T00:00:00.000Z',
  sessionId: 'legacy-finished',
  level: 'info',
  kind: 'session.finished',
  message: 'Legacy task finished',
})}\n`, 'utf8');
fs.writeFileSync(path.join(dataDir, 'audit.ndjson'), '', 'utf8');

fs.writeFileSync(fakeBridgeRunner, [
  'import json',
  'import os',
  'import signal',
  'import subprocess',
  'import sys',
  'import time',
  'signal.signal(signal.SIGINT, lambda *_: sys.exit(130))',
  'args = sys.argv[1:]',
  'assert "CODEX_DESK_AUTH_USER" not in os.environ',
  'assert "CODEX_DESK_AUTH_PASSWORD" not in os.environ',
  'assert "CODEX_ALLOW_ROOT_EXECUTION" not in os.environ',
  'assert os.environ.get("CODEX_TASK_PERMISSION_MODE") == "danger-full-access"',
  'assert os.environ.get("CODEX_TASK_APPROVAL_POLICY") == "never"',
  'assert os.path.basename(os.environ.get("CODEX_BIN", "")) == "codex"',
  'assert os.environ.get("PATH", "").split(os.pathsep)[0].endswith(os.path.join("bin", "full-access"))',
  'output_file = args[args.index("--output-file") + 1]',
  'stdout_file = args[args.index("--stdout-file") + 1]',
  'stderr_file = args[args.index("--stderr-file") + 1]',
  'os.makedirs(os.path.dirname(output_file), exist_ok=True)',
  'message = args[args.index("--message") + 1]',
  'source_dir = args[args.index("--source-dir") + 1]',
  'assert os.getcwd() == source_dir',
  'runtime_cwd = os.path.join(source_dir, ".runtime-workfile")',
  'report_runtime_cwd = "RUNTIME_CWD_UNREPORTED" not in message',
  'if "IGNORE_TERM" in message:',
  '    signal.signal(signal.SIGTERM, lambda *_: None)',
  'if "EXIT_ZERO_ON_INTERRUPT" in message:',
  '    signal.signal(signal.SIGINT, lambda *_: sys.exit(0))',
  'snapshot_path = next(line.split(": ", 1)[1] for line in message.splitlines() if line.startswith("Skill snapshot: "))',
  'assert os.environ.get("CODEX_TASK_SKILL_SNAPSHOT") == snapshot_path',
  'assert os.path.isfile(os.path.join(snapshot_path, "manifest.json"))',
  'with open(os.environ["FAKE_BRIDGE_ARGS_FILE"], "a", encoding="utf-8") as handle:',
  '    handle.write(json.dumps(args) + "\\n")',
  'if "TRANSIENT_RETRY" in message:',
  '    with open(stderr_file, "w", encoding="utf-8") as handle:',
  '        handle.write("temporary failure\\n")',
  '    print("temporary failure", file=sys.stderr)',
  '    sys.exit(1)',
  'if "RUNTIME_RATE_LIMIT" in message:',
  '    failure_message = "exceeded retry limit, last status: 429 Too Many Requests, request id: rate-limit-request"',
  '    failure_events = [',
  '        {"type": "item.completed", "item": {"id": "command-rate-limit", "type": "command_execution", "command": "print a long timeout troubleshooting document", "aggregated_output": "timeout guidance that is not the runtime failure", "exit_code": 0, "status": "completed"}},',
  '        {"type": "error", "message": failure_message},',
  '        {"type": "turn.failed", "error": {"message": failure_message}},',
  '    ]',
  '    failure_stdout = "\\n".join(json.dumps(event) for event in failure_events) + "\\n"',
  '    with open(stdout_file, "w", encoding="utf-8") as handle:',
  '        handle.write(failure_stdout)',
  '    print(json.dumps({"returncode": 1, "stdout": failure_stdout, "stderr": ""}, indent=2))',
  '    sys.exit(1)',
  'if "NON_TRANSIENT_FAILURE_TEXT" in message:',
  '    failure_message = "tests/test_429.py: AssertionError: assert response.status_code == 503; expected timeout == 30; expected temporary failure mode"',
  '    with open(stderr_file, "w", encoding="utf-8") as handle:',
  '        handle.write(failure_message + "\\n")',
  '    print(failure_message, file=sys.stderr)',
  '    sys.exit(1)',
  'if "SLOW_TASK" in message:',
  '    time.sleep(30)',
  'if "LINGERING_CHILD" in message:',
  '    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
  '    with open(os.path.join(source_dir, "lingering-child.pid"), "w", encoding="utf-8") as handle:',
  '        handle.write(str(child.pid))',
  'with open(output_file, "w", encoding="utf-8") as handle:',
  '    handle.write("Task turn verified")',
  'if "OVERSIZED_OUTPUT" in message:',
  '    with open(stdout_file, "w", encoding="utf-8") as handle:',
  '        handle.write("x" * (5 * 1024 * 1024) + "\\n")',
  '    print("x" * (5 * 1024 * 1024))',
  '    sys.exit(0)',
  'full_command = "printf \'audit-sentinel\' && " + ("x" * 2300)',
  'if "SKILL_ATTRIBUTION" in message:',
  '    full_command = \'/bin/bash -lc "codex-skill-use converter-test run-in-background -- python3 -m pytest converter/test_smoke.py"\'',
  'started_command = full_command',
  'if "SKILL_ATTRIBUTION" in message:',
  '    started_command = \'/bin/bash -lc "codex-skill-use converter-test -- python3 -m pytest converter/test_smoke.py"\'',
  'command_output = "audit-sentinel-output\\nsecond line\\n"',
  'if "LARGE_STRUCTURED_OUTPUT" in message:',
  '    command_output = "z" * ((4 * 1024 * 1024) + 131072)',
  'events = [',
  '    {"type": "thread.started", "thread_id": "internal-thread"},',
  '    {"type": "turn.started"},',
  '    {"type": "item.started", "item": {"id": "command-1", "type": "command_execution", "command": started_command, "status": "in_progress", **({"cwd": runtime_cwd} if report_runtime_cwd else {})}},',
  '    {"type": "item.completed", "item": {"id": "command-1", "type": "command_execution", "command": full_command, "aggregated_output": command_output, "exit_code": 0, "status": "completed", **({"cwd": runtime_cwd} if report_runtime_cwd else {})}},',
  '    {"type": "item.completed", "item": {"type": "agent_message", "text": "Task turn verified"}},',
  '    {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}},',
  ']',
  'if "LIVE_STREAM_INTERRUPT" in message:',
  '    sys.stdout.write("{\\\"stdout\\\":\\\"")',
  '    sys.stdout.flush()',
  '    for event in events[:5]:',
  '        text = json.dumps(event) + "\\n"',
  '        with open(stdout_file, "a", encoding="utf-8") as handle:',
  '            handle.write(text)',
  '        sys.stdout.write(json.dumps(text)[1:-1])',
  '        sys.stdout.flush()',
  '        time.sleep(0.05)',
  '    time.sleep(30)',
  'with open(stdout_file, "w", encoding="utf-8") as handle:',
  '    handle.write("\\n".join(json.dumps(event) for event in events) + "\\n")',
  'print(json.dumps({"returncode": 0, "stdout": "\\n".join(json.dumps(event) for event in events), "stderr": ""}, indent=2))',
  '',
].join('\n'));

async function request(urlPath, options = {}, urlRoot = baseUrl) {
  const config = { ...options, headers: { ...(options.headers || {}) } };
  if (config.body && typeof config.body !== 'string') {
    config.headers['content-type'] = 'application/json';
    config.body = JSON.stringify(config.body);
  }
  const response = await fetch(`${urlRoot}${urlPath}`, config);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, payload };
}

function createSkillZip(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks = [];
    zip.outputStream.on('data', (chunk) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) {
      zip.addBuffer(Buffer.from(entry.content), entry.path, { mode: entry.mode ?? 0o100644 });
    }
    zip.end();
  });
}

async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for condition. Server output: ${serverOutput}`);
}

function processIsRunning(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const match = stat.match(/^.*\)\s+([A-Z])/);
    return !match || match[1] !== 'Z';
  } catch {
    return false;
  }
}

function countOpenFileDescriptors(pid, targetPath) {
  return fs.readdirSync(`/proc/${pid}/fd`).reduce((count, fd) => {
    try {
      return count + (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === targetPath ? 1 : 0);
    } catch {
      return count;
    }
  }, 0);
}

function createFakeBridgeRuntime(sessionKey, sourceDir, threadId) {
  const runtimeRoot = path.join(runtimeDir, 'bridge-sessions');
  const chatfileRoot = path.join(runtimeDir, 'bridge-chatfiles');
  const sessionId = stableBridgeSessionId(sessionKey, sourceDir);
  const targets = sessionTargets(sessionKey, sessionId, { runtimeRoot, chatfileRoot });
  for (const directory of [targets.workfileDir, targets.skillDir, targets.codexHome, targets.chatfileDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.mkdirSync(path.dirname(targets.recordFile), { recursive: true });
  fs.writeFileSync(targets.recordFile, JSON.stringify({
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
    threadId,
    lastRunAt: Date.now(),
    recentChat: [],
  }));
  return { sessionId, targets };
}

function abortDownloadAfterFirstChunk(urlPath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, statusCode) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(statusCode);
    };
    const requestStream = http.get(`${baseUrl}${urlPath}`, (response) => {
      response.once('data', () => {
        const statusCode = response.statusCode;
        response.destroy();
        requestStream.destroy();
        finish(null, statusCode);
      });
      response.on('error', (error) => {
        if (error.code !== 'ECONNRESET') finish(error);
      });
    });
    requestStream.on('error', (error) => {
      if (error.code !== 'ECONNRESET') finish(error);
    });
  });
}

function spawnServer(custom = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOST: custom.host || '127.0.0.1',
      PORT: String(custom.port || port),
      BRIDGE_RUNNER: custom.runner || fakeBridgeRunner,
      FAKE_BRIDGE_ARGS_FILE: custom.argsFile || bridgeArgsFile,
      CODEX_DESK_DATA_DIR: custom.dataDir || dataDir,
      CODEX_DESK_RUNTIME_DIR: custom.runtimeDir || runtimeDir,
      CODEX_TASK_WORKSPACE_ROOTS: custom.workspaceRoot || workspaceRoot,
      SOURCE_CODEX_HOME: sourceCodexHome,
      WORKSPACE_CODEX_SKILLS_DIR: workspaceCodexSkills,
      CODEX_ALLOW_ROOT_EXECUTION: custom.allowRootExecution === false ? '0' : '1',
      CODEX_DB_BACKUP_INTERVAL_HOURS: custom.backupIntervalHours ?? '0',
      CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: custom.recoveryIntervalHours ?? '0',
      ...(custom.apiMaxConcurrency != null
        ? { CODEX_API_MAX_CONCURRENCY: String(custom.apiMaxConcurrency) }
        : {}),
      ...(custom.apiIdleTimeoutMs != null
        ? { CODEX_API_IDLE_TIMEOUT_MS: String(custom.apiIdleTimeoutMs) }
        : {}),
      ...(custom.logStreamMaxConcurrency != null
        ? { CODEX_LOG_STREAM_MAX_CONCURRENCY: String(custom.logStreamMaxConcurrency) }
        : {}),
      ...(custom.logStreamIdleTimeoutMs != null
        ? { CODEX_LOG_STREAM_IDLE_TIMEOUT_MS: String(custom.logStreamIdleTimeoutMs) }
        : {}),
      ...(custom.minFreeBytes != null ? { CODEX_MIN_FREE_BYTES: String(custom.minFreeBytes) } : {}),
      ...(custom.minFreePercent != null ? { CODEX_MIN_FREE_PERCENT: String(custom.minFreePercent) } : {}),
      ...(custom.disableWorker ? { CODEX_DISABLE_WORKER: '1' } : {}),
      ...(custom.authUser ? { CODEX_DESK_AUTH_USER: custom.authUser } : {}),
      ...(custom.authPassword ? { CODEX_DESK_AUTH_PASSWORD: custom.authPassword } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Server did not stop')), 5000)),
  ]);
}

test.before(async () => {
  server = spawnServer();
  await waitFor(async () => {
    try {
      const result = await request('/api/health');
      return result.response.ok && result.payload.runtime.workerAvailable;
    } catch {
      return false;
    }
  });
});

test.after(async () => {
  await stopServer(server);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('health exposes the running release identity', async () => {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.release.version, '0.1.0');
  assert.equal(health.payload.release.releaseId, '');
  assert.equal(health.payload.release.releaseIdConfigured, false);
  assert.match(health.payload.release.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(health.payload.release.instanceId, /^[a-f0-9-]{36}$/);
});

test('Agent messages and commands are queryable before completion and survive an interrupted stream', async () => {
  const taskId = 'live-stream-interrupt';
  const created = await request('/api/sessions', {
    method: 'POST',
    body: {
      id: taskId,
      name: 'Live Agent Audit',
      objective: 'LIVE_STREAM_INTERRUPT',
      workingDir: projectDir,
      autoResume: false,
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal((await request(`/api/sessions/${taskId}/run`, {
    method: 'POST', body: { input: 'LIVE_STREAM_INTERRUPT' },
  })).response.status, 202);

  const liveEvidence = await waitFor(async () => {
    const [task, executions, worklogs] = await Promise.all([
      request(`/api/sessions/${taskId}`),
      request(`/api/sessions/${taskId}/executions`),
      request(`/api/sessions/${taskId}/worklogs`),
    ]);
    if (task.payload.status !== 'running' || executions.payload.length !== 1) return null;
    if (!worklogs.payload.some((event) => event.message === 'Task turn verified')) return null;
    return { task: task.payload, execution: executions.payload[0], worklogs: worklogs.payload };
  });
  assert.equal(liveEvidence.execution.command, auditCommand);
  assert.equal(liveEvidence.execution.output, auditOutput);
  assert.ok(liveEvidence.worklogs.some((event) => event.kind === 'runtime.item.completed'));

  assert.equal((await request(`/api/sessions/${taskId}/stop`, { method: 'POST' })).response.status, 200);
  await waitFor(async () => (await request(`/api/sessions/${taskId}`)).payload.status === 'stopped');
  const afterStop = await request(`/api/sessions/${taskId}/executions`);
  assert.equal(afterStop.payload.length, 1);
  assert.equal(afterStop.payload[0].command, auditCommand);
  assert.equal(afterStop.payload[0].output, auditOutput);
});

test('runtime rate-limit failures preserve the actual error as the task result', async () => {
  const taskId = 'runtime-rate-limit';
  const failureMessage = 'exceeded retry limit, last status: 429 Too Many Requests, request id: rate-limit-request';
  assert.equal((await request('/api/sessions', {
    method: 'POST',
    body: {
      id: taskId,
      name: 'Runtime Rate Limit',
      objective: 'RUNTIME_RATE_LIMIT',
      workingDir: projectDir,
      maxRetries: 0,
    },
  })).response.status, 201);
  assert.equal((await request(`/api/sessions/${taskId}/run`, {
    method: 'POST', body: { input: 'RUNTIME_RATE_LIMIT' },
  })).response.status, 202);

  const failedTask = await waitFor(async () => {
    const task = (await request(`/api/sessions/${taskId}`)).payload;
    return task.status === 'failed' ? task : null;
  });
  assert.equal(failedTask.summary, failureMessage);
  assert.equal(failedTask.lastError, failureMessage);
  assert.equal(failedTask.recoveryState, 'recoverable');

  const attempts = (await request(`/api/sessions/${taskId}/attempts`)).payload;
  assert.equal(attempts[0].error, failureMessage);
  const turns = (await request(`/api/sessions/${taskId}/turns`)).payload;
  assert.equal(turns[0].result, failureMessage);
  const worklogs = (await request(`/api/sessions/${taskId}/worklogs`)).payload;
  assert.ok(worklogs.some((event) => event.kind === 'runtime.error' && event.message === failureMessage));
});

test('business failure text containing status codes and timeout does not retry the turn', async () => {
  const taskId = 'non-transient-failure-text';
  const failureMessage = 'tests/test_429.py: AssertionError: assert response.status_code == 503; expected timeout == 30; expected temporary failure mode';
  assert.equal((await request('/api/sessions', {
    method: 'POST',
    body: {
      id: taskId,
      name: 'Non-transient Failure Text',
      objective: 'NON_TRANSIENT_FAILURE_TEXT',
      workingDir: projectDir,
      maxRetries: 2,
    },
  })).response.status, 201);
  assert.equal((await request(`/api/sessions/${taskId}/run`, {
    method: 'POST', body: { input: 'NON_TRANSIENT_FAILURE_TEXT' },
  })).response.status, 202);

  const failedTask = await waitFor(async () => {
    const task = (await request(`/api/sessions/${taskId}`)).payload;
    return task.status === 'failed' ? task : null;
  });
  assert.equal(failedTask.lastError, failureMessage);
  assert.equal(failedTask.retryCount, 0);
  assert.equal(failedTask.recoveryState, 'failed');
  assert.equal((await request(`/api/sessions/${taskId}/attempts`)).payload.length, 1);
  const worklogs = (await request(`/api/sessions/${taskId}/worklogs`)).payload;
  assert.equal(worklogs.some((event) => event.kind === 'session.retry.scheduled'), false);
});

test('a task persists across turns and becomes history only after explicit completion', async () => {
  await request('/api/skills', {
    method: 'POST',
    body: { id: 'release-check', name: 'Release Check', content: '# Release Check\n\nVerify every turn.' },
  });
  const created = await request('/api/sessions', {
    method: 'POST',
    body: {
      id: 'verify-task',
      name: 'Verify Task',
      objective: 'Verify the persistent task lifecycle.',
      workingDir: projectDir,
      model: 'must-not-be-stored',
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.status, 'idle');
  assert.equal('model' in created.payload, false);

  const started = await request('/api/sessions/verify-task/run', {
    method: 'POST',
    headers: { 'idempotency-key': 'verify-turn-1' },
    body: { input: 'Complete the first verification turn.' },
  });
  assert.equal(started.response.status, 202);
  const firstReview = await waitFor(async () => {
    const result = await request('/api/sessions/verify-task');
    return result.payload.status === 'waiting_review' ? result.payload : null;
  });
  assert.equal(firstReview.runCount, 1);
  assert.equal(firstReview.archivedAt, '');
  assert.ok(firstReview.persistentSessionKey);
  assert.ok(firstReview.skillSnapshotId);
  const runtimeHealth = (await request('/api/health')).payload.runtime;
  assert.equal(runtimeHealth.permissionMode, 'danger-full-access');
  assert.equal(runtimeHealth.approvalPolicy, 'never');
  assert.equal(runtimeHealth.fullAccessAvailable, true);

  const continued = await request('/api/sessions/verify-task/run', {
    method: 'POST',
    headers: { 'idempotency-key': 'verify-turn-2' },
    body: { input: 'Continue the same task with another verification turn.' },
  });
  assert.equal(continued.response.status, 202);
  const secondReview = await waitFor(async () => {
    const result = await request('/api/sessions/verify-task');
    return result.payload.status === 'waiting_review' && result.payload.runCount === 2 ? result.payload : null;
  });
  assert.equal(secondReview.persistentSessionKey, firstReview.persistentSessionKey);
  assert.equal(secondReview.skillSnapshotId, firstReview.skillSnapshotId);
  assert.equal(fs.existsSync(path.join(dataDir, 'sessions', 'verify-task', 'bridge-output.txt')), false);

  const turns = await request('/api/sessions/verify-task/turns');
  assert.equal(turns.payload.length, 2);
  assert.ok(turns.payload.every((turn) => turn.status === 'completed'));

  const executions = await request('/api/sessions/verify-task/executions?limit=10&offset=0');
  assert.equal(executions.response.status, 200);
  assert.equal(executions.payload.length, 2);
  assert.ok(executions.payload.every((execution) => execution.command === auditCommand));
  assert.ok(executions.payload.every((execution) => execution.output === auditOutput));
  assert.ok(executions.payload.every((execution) => execution.rawEvent.item.command === auditCommand));
  assert.ok(executions.payload.every((execution) => execution.rawEvent.item.aggregated_output === auditOutput));
  assert.ok(executions.payload.every((execution) => execution.turnId && execution.attemptId));
  assert.deepEqual(new Set(executions.payload.map((execution) => execution.turnSequence)), new Set([1, 2]));
  assert.deepEqual(new Set(executions.payload.map((execution) => execution.attemptNo)), new Set([1]));
  assert.ok(executions.payload.every((execution) => execution.turnInput));
  assert.ok(executions.payload.every((execution) => execution.configuredWorkingDirectory === projectDir));
  assert.ok(executions.payload.every((execution) => execution.workingDirectory === path.join(projectDir, '.runtime-workfile')));
  assert.ok(executions.payload.every((execution) => execution.workingDirectoryReported === true));
  assert.ok(executions.payload.every((execution) => !JSON.stringify(execution).includes('[REDACTED]')));

  const executionPage = await request('/api/sessions/verify-task/executions?limit=1&offset=1');
  assert.equal(executionPage.payload.length, 1);
  assert.notEqual(executionPage.payload[0].id, executions.payload[0].id);
  const attempts = await request('/api/sessions/verify-task/attempts?limit=10&offset=0');
  assert.equal(attempts.payload.length, 2);
  assert.ok(attempts.payload.every((attempt) => executions.payload.some((execution) => execution.attemptId === attempt.id)));
  assert.ok(attempts.payload.every((attempt) => attempt.turnSequence > 0 && attempt.turnInput));
  assert.ok(attempts.payload.every((attempt) => attempt.stdoutAvailable && attempt.stdoutBytes > 0));
  assert.ok(attempts.payload.every((attempt) => attempt.stderrAvailable && attempt.stderrBytes === 0));
  const rawStdout = await request(`/api/sessions/verify-task/attempts/${attempts.payload[0].id}/stdout`);
  assert.equal(rawStdout.response.status, 200);
  assert.equal(Number(rawStdout.response.headers.get('content-length')), Buffer.byteLength(rawStdout.payload));
  assert.match(rawStdout.payload, /^\{"type": "thread\.started"/);
  assert.match(rawStdout.payload, /audit-sentinel-output\\nsecond line\\n/);
  assert.doesNotMatch(rawStdout.payload, /^\{\s*"stdout"\s*:/);
  const rawStdoutBytes = Buffer.from(rawStdout.payload);
  const incrementalStdout = await request(
    `/api/sessions/verify-task/attempts/${attempts.payload[0].id}/stdout?offset=7&limit=29`,
  );
  assert.equal(incrementalStdout.response.status, 200);
  assert.equal(incrementalStdout.payload, rawStdoutBytes.subarray(7, 36).toString());
  assert.equal(incrementalStdout.response.headers.get('x-log-offset'), '7');
  assert.equal(incrementalStdout.response.headers.get('x-log-next-offset'), '36');
  assert.equal(incrementalStdout.response.headers.get('x-log-file-size'), String(rawStdoutBytes.length));
  assert.equal(incrementalStdout.response.headers.get('x-attempt-status'), attempts.payload[0].status);
  const webSocketEvidence = await new Promise((resolve, reject) => {
    const chunks = [];
    const controls = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/sessions/verify-task/attempts/${attempts.payload[0].id}/stdout/live?offset=7`,
    );
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out waiting for Attempt output WebSocket'));
    }, 5000);
    socket.on('message', (data, isBinary) => {
      if (isBinary) chunks.push(Buffer.from(data));
      else controls.push(JSON.parse(String(data)));
    });
    socket.once('error', reject);
    socket.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, output: Buffer.concat(chunks), controls });
    });
  });
  assert.equal(webSocketEvidence.code, 1000);
  assert.deepEqual(webSocketEvidence.output, rawStdoutBytes.subarray(7));
  assert.equal(webSocketEvidence.controls[0].type, 'ready');
  assert.equal(webSocketEvidence.controls[0].offset, 7);
  assert.equal(webSocketEvidence.controls.at(-1).type, 'end');
  assert.equal(webSocketEvidence.controls.at(-1).status, attempts.payload[0].status);
  const pastEndStdout = await request(
    `/api/sessions/verify-task/attempts/${attempts.payload[0].id}/stdout?offset=${rawStdoutBytes.length + 100}&limit=64`,
  );
  assert.equal(pastEndStdout.response.status, 200);
  assert.equal(pastEndStdout.payload, '');
  assert.equal(pastEndStdout.response.headers.get('x-log-offset'), String(rawStdoutBytes.length));
  assert.equal(pastEndStdout.response.headers.get('x-log-next-offset'), String(rawStdoutBytes.length));
  for (const query of ['offset=-1&limit=64', 'offset=1.5&limit=64', 'offset=0&limit=0', 'offset=0&limit=1048577']) {
    const invalidWindow = await request(
      `/api/sessions/verify-task/attempts/${attempts.payload[0].id}/stdout?${query}`,
    );
    assert.equal(invalidWindow.response.status, 400);
  }
  const emptyStderr = await request(`/api/sessions/verify-task/attempts/${attempts.payload[0].id}/stderr`);
  assert.equal(emptyStderr.response.status, 200);
  assert.equal(emptyStderr.payload, '');
  const crossSessionOutput = await request(`/api/sessions/live-stream-interrupt/attempts/${attempts.payload[0].id}/stdout`);
  assert.equal(crossSessionOutput.response.status, 404);

  const completed = await request('/api/sessions/verify-task/complete', { method: 'POST' });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.payload.status, 'completed');
  assert.ok(completed.payload.archivedAt);
  const completedAgain = await request('/api/sessions/verify-task/complete', { method: 'POST' });
  assert.equal(completedAgain.response.status, 200);
  assert.equal(completedAgain.payload.archivedAt, completed.payload.archivedAt);

  const committedRunReplay = await request('/api/sessions/verify-task/run', {
    method: 'POST',
    headers: { 'idempotency-key': 'verify-turn-2' },
    body: { input: 'Continue the same task with another verification turn.' },
  });
  assert.equal(committedRunReplay.response.status, 202);
  assert.equal(committedRunReplay.payload.status, 'completed');

  const rerun = await request('/api/sessions/verify-task/run', { method: 'POST', body: { input: 'Do unrelated work.' } });
  assert.equal(rerun.response.status, 409);
  const edited = await request('/api/sessions/verify-task', { method: 'PUT', body: { name: 'Changed' } });
  assert.equal(edited.response.status, 409);
  const storageEdit = spawnSync(process.execPath, ['-e', [
    "const store = require('./src/store');",
    "try { store.saveSession('verify-task', { name: 'Changed below HTTP' }); process.exit(2); }",
    "catch (error) { console.log(String(error.statusCode || '') + ':' + error.message); }",
  ].join('\n')], {
    cwd: ROOT_DIR,
    env: { ...process.env, CODEX_DESK_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.equal(storageEdit.status, 0, storageEdit.stderr);
  assert.match(storageEdit.stdout, /^409:Completed sessions are immutable history records/m);
  const deleted = await request('/api/sessions/verify-task', { method: 'DELETE' });
  assert.equal(deleted.response.status, 409);
  assert.equal((await request('/api/sessions/verify-task')).payload.status, 'completed');

  const retainedRuntime = createFakeBridgeRuntime(
    completed.payload.persistentSessionKey,
    projectDir,
    'thread-verify-task-restore',
  );
  const restoreHeaders = {
    'idempotency-key': 'verify-task-restore-1',
    'x-task-created-at': completed.payload.createdAt,
  };
  const restored = await request('/api/sessions/verify-task/restore', {
    method: 'POST', headers: restoreHeaders,
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.payload.status, 'waiting_input');
  assert.equal(restored.payload.archivedAt, '');
  assert.equal(restored.payload.persistentSessionKey, completed.payload.persistentSessionKey);
  assert.equal(fs.existsSync(retainedRuntime.targets.recordFile), true);
  const restoredReplay = await request('/api/sessions/verify-task/restore', {
    method: 'POST', headers: restoreHeaders,
  });
  assert.deepEqual(restoredReplay.payload, restored.payload);
  const rearchived = await request('/api/sessions/verify-task/complete', {
    method: 'POST',
    headers: {
      'idempotency-key': 'verify-task-complete-cycle-2',
      'x-task-created-at': completed.payload.createdAt,
    },
  });
  assert.equal(rearchived.response.status, 200);
  assert.equal(rearchived.payload.status, 'completed');
  assert.ok(rearchived.payload.archivedAt);

  const invocations = fs.readFileSync(bridgeArgsFile, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((args) => args[args.indexOf('--chat-key') + 1].startsWith('single:verify-task-'));
  assert.equal(invocations.length, 2);
  const sessionKeys = invocations.map((args) => args[args.indexOf('--chat-key') + 1]);
  assert.equal(new Set(sessionKeys).size, 1);
  assert.ok(invocations.every((args) => !args.includes('--model') && !args.includes('-m')));
  const taskMessages = invocations.map((args) => args[args.indexOf('--message') + 1]);
  assert.ok(taskMessages.every((message) => message.split('\n').length === 11));
  assert.ok(taskMessages.every((message) => message.includes('Runtime rules:')));
  assert.ok(taskMessages.every((message) => message.includes('codex-skill-use <skill-id>')));
  assert.ok(taskMessages.every((message) => message.includes('codex-background-track register')));
  assert.ok(taskMessages.every((message) => message.includes('without polling or analysis')));
  assert.ok(taskMessages.every((message) => message.includes('only the operator archives the task')));
  assert.ok(taskMessages.every((message) => !message.includes('Example:')));

  const worklog = await request('/api/sessions/verify-task/worklogs');
  assert.ok(worklog.payload.some((event) => event.kind === 'session.waiting_review'));
  assert.ok(worklog.payload.filter((event) => event.kind === 'session.runtime.started')
    .every((event) => event.payload.permissionMode === 'danger-full-access'
      && event.payload.approvalPolicy === 'never'));
  assert.equal(worklog.payload.filter((event) => event.kind === 'session.completed').length, 2);
  assert.equal(worklog.payload.filter((event) => event.kind === 'session.restored').length, 1);
  const snapshots = worklog.payload.filter((event) => event.kind === 'skill.snapshot.mounted');
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every((event) => event.payload.skills.some((skill) => skill.id === 'release-check' && skill.version === 1)));
  const commandEvents = worklog.payload.filter((event) => event.payload?.event?.item?.type === 'command_execution' && event.kind === 'runtime.item.completed');
  assert.equal(commandEvents.length, 2);
  assert.ok(commandEvents.every((event) => event.payload.event.item.command === auditCommand));
  assert.ok(commandEvents.every((event) => event.payload.event.item.aggregated_output === auditOutput));
  const queuedEvents = worklog.payload.filter((event) => event.kind === 'session.queued');
  assert.deepEqual(queuedEvents.map((event) => event.payload.input), [
    'Complete the first verification turn.',
    'Continue the same task with another verification turn.',
  ]);
  const dashboard = await request('/api/dashboard');
  assert.ok(dashboard.payload.recentAudit.every((event) => event.payload === null));

  const db = new Database(path.join(dataDir, 'codex-tasks.db'));
  const commandRows = db.prepare("SELECT status, claim_expires_at FROM commands WHERE task_id='verify-task'").all();
  const attemptRows = db.prepare("SELECT status, finished_at FROM attempts WHERE task_id='verify-task'").all();
  const taskRow = db.prepare("SELECT lease_owner, lease_expires_at FROM tasks WHERE id='verify-task'").get();
  db.close();
  assert.ok(commandRows.every((row) => row.status === 'completed' && row.claim_expires_at === ''));
  assert.ok(attemptRows.every((row) => row.status === 'completed' && row.finished_at));
  assert.equal(taskRow.lease_owner, null);
  assert.equal(taskRow.lease_expires_at, null);
});

test('reset keeps the Task while later runs and archive restoration use the latest Session', async () => {
  await waitFor(async () => {
    try { return (await request('/api/ready')).response.ok; } catch { return false; }
  });
  const taskId = 'reset-latest-session';
  const taskBody = {
    id: taskId,
    name: 'Reset Latest Session',
    objective: 'Verify reset, new context, and latest-session restoration.',
    workingDir: projectDir,
    notes: 'Configuration must survive reset.',
    maxRetries: 4,
    autoResume: false,
  };
  const created = await request('/api/sessions/start', {
    method: 'POST',
    headers: { 'idempotency-key': 'reset-latest-create' },
    body: taskBody,
  });
  assert.equal(created.response.status, 202);
  const firstReview = await waitFor(async () => {
    const current = await request(`/api/sessions/${taskId}`);
    return current.payload.status === 'waiting_review' ? current.payload : null;
  });
  const firstSessionKey = firstReview.persistentSessionKey;
  assert.ok(firstSessionKey);

  const resetHeaders = {
    'idempotency-key': 'reset-latest-cycle-1',
    'x-task-created-at': firstReview.createdAt,
  };
  const reset = await request(`/api/sessions/${taskId}/reset`, {
    method: 'POST', headers: resetHeaders,
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.payload.id, taskId);
  assert.equal(reset.payload.name, taskBody.name);
  assert.equal(reset.payload.objective, taskBody.objective);
  assert.equal(reset.payload.notes, taskBody.notes);
  assert.equal(reset.payload.maxRetries, 4);
  assert.equal(reset.payload.autoResume, false);
  assert.equal(reset.payload.status, 'idle');
  assert.equal(reset.payload.persistentSessionKey, '');
  assert.equal(reset.payload.runCount, 1);
  const resetReplay = await request(`/api/sessions/${taskId}/reset`, {
    method: 'POST', headers: resetHeaders,
  });
  assert.deepEqual(resetReplay.payload, reset.payload);

  const continued = await request(`/api/sessions/${taskId}/run`, {
    method: 'POST',
    headers: { 'idempotency-key': 'reset-latest-turn-2' },
    body: { input: 'Start a clean Session after reset.' },
  });
  assert.equal(continued.response.status, 202);
  const latestReview = await waitFor(async () => {
    const current = await request(`/api/sessions/${taskId}`);
    return current.payload.status === 'waiting_review' && current.payload.runCount === 2
      ? current.payload
      : null;
  });
  assert.ok(latestReview.persistentSessionKey);
  assert.notEqual(latestReview.persistentSessionKey, firstSessionKey);

  const invocations = fs.readFileSync(bridgeArgsFile, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((args) => args[args.indexOf('--chat-key') + 1].startsWith(`single:${taskId}-`));
  assert.equal(invocations.length, 2);
  assert.deepEqual(
    invocations.map((args) => args[args.indexOf('--chat-key') + 1]),
    [firstSessionKey, latestReview.persistentSessionKey],
  );

  createFakeBridgeRuntime(
    latestReview.persistentSessionKey,
    projectDir,
    'thread-reset-latest-session',
  );
  const completed = await request(`/api/sessions/${taskId}/complete`, {
    method: 'POST',
    headers: {
      'idempotency-key': 'reset-latest-complete',
      'x-task-created-at': firstReview.createdAt,
    },
  });
  assert.equal(completed.payload.status, 'completed');
  const restored = await request(`/api/sessions/${taskId}/restore`, {
    method: 'POST',
    headers: {
      'idempotency-key': 'reset-latest-restore',
      'x-task-created-at': firstReview.createdAt,
    },
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.payload.status, 'waiting_input');
  assert.equal(restored.payload.persistentSessionKey, latestReview.persistentSessionKey);

  const worklog = await request(`/api/sessions/${taskId}/worklogs`);
  assert.equal(worklog.payload.filter((event) => event.kind === 'session.reset').length, 1);
  assert.equal(worklog.payload.filter((event) => event.kind === 'session.restored').length, 1);
});

test('converter commands retain multi-Skill attribution and append-only operator corrections', async () => {
  for (const skill of [
    { id: 'converter-test', name: 'Converter Test' },
    { id: 'run-in-background', name: 'Run In Background' },
  ]) {
    const createdSkill = await request('/api/skills', {
      method: 'POST',
      body: {
        ...skill,
        description: `${skill.name} workflow`,
        content: `---\nname: ${skill.id}\ndescription: ${skill.name} workflow\n---\n# ${skill.name}\n`,
      },
    });
    assert.equal(createdSkill.response.status, 201);
  }

  await request('/api/sessions', {
    method: 'POST',
    body: {
      id: 'converter-attribution',
      name: 'Converter Attribution',
      objective: 'SKILL_ATTRIBUTION',
      workingDir: projectDir,
    },
  });
  await request('/api/sessions/converter-attribution/run', {
    method: 'POST',
    body: { input: 'SKILL_ATTRIBUTION' },
  });
  await waitFor(async () => (await request('/api/sessions/converter-attribution')).payload.status === 'waiting_review');

  let executions = await request('/api/sessions/converter-attribution/executions');
  assert.equal(executions.response.status, 200);
  assert.equal(executions.payload.length, 1);
  const execution = executions.payload[0];
  assert.deepEqual(execution.declaredSkillIds, ['converter-test', 'run-in-background']);
  assert.deepEqual(execution.skills.map((skill) => skill.skillId), ['converter-test', 'run-in-background']);
  assert.ok(execution.skills.every((skill) => skill.source === 'runtime' && skill.version === 1 && skill.contentHash.length === 64));
  assert.equal(execution.skillAttributionHistory.length, 2);

  const usage = await request('/api/sessions/converter-attribution/skill-usage');
  assert.equal(usage.response.status, 200);
  assert.ok(usage.payload.snapshot.id);
  assert.equal(usage.payload.attributedCommandCount, 1);
  assert.equal(usage.payload.skills.find((skill) => skill.id === 'converter-test').commandCount, 1);

  const missingReason = await request(`/api/sessions/converter-attribution/executions/${execution.id}/skills`, {
    method: 'PUT',
    body: { skillIds: ['converter-test'], reason: '' },
  });
  assert.equal(missingReason.response.status, 400);
  const invalidSkill = await request(`/api/sessions/converter-attribution/executions/${execution.id}/skills`, {
    method: 'PUT',
    body: { skillIds: ['not-in-snapshot'], reason: 'Validate snapshot membership.' },
  });
  assert.equal(invalidSkill.response.status, 400);

  assert.equal((await request('/api/sessions/converter-attribution/complete', { method: 'POST' })).response.status, 200);
  const corrected = await request(`/api/sessions/converter-attribution/executions/${execution.id}/skills`, {
    method: 'PUT',
    body: { skillIds: ['converter-test', 'system-check'], reason: 'Background helper was not used; system validation applied.' },
  });
  assert.equal(corrected.response.status, 200);
  assert.deepEqual(corrected.payload.skills.map((skill) => skill.skillId), ['converter-test', 'system-check']);
  assert.equal(corrected.payload.skillAttributionHistory.length, 4);
  assert.equal(corrected.payload.skillAttributionHistory.filter((item) => item.source === 'runtime').length, 2);
  assert.equal(corrected.payload.skillAttributionHistory.filter((item) => item.source === 'operator').length, 2);

  executions = await request('/api/sessions/converter-attribution/executions');
  assert.deepEqual(executions.payload[0].skills.map((skill) => skill.skillId), ['converter-test', 'system-check']);
  const worklog = await request('/api/sessions/converter-attribution/worklogs');
  assert.ok(worklog.payload.some((event) => event.kind === 'command.skills.corrected'
    && event.payload.reason === 'Background helper was not used; system validation applied.'));
  const audit = await request('/api/audit?sessionId=converter-attribution&kind=command.skills.corrected');
  assert.equal(audit.payload.length, 1);
});

test('execution audit distinguishes configured directories from unreported runtime directories', async () => {
  const id = 'unreported-runtime-cwd';
  const created = await request('/api/sessions', {
    method: 'POST',
    body: {
      id,
      name: 'Unreported Runtime CWD',
      objective: 'RUNTIME_CWD_UNREPORTED audit event',
      workingDir: projectDir,
    },
  });
  assert.equal(created.response.status, 201);
  const started = await request(`/api/sessions/${id}/run`, {
    method: 'POST',
    headers: { 'idempotency-key': 'unreported-runtime-cwd-turn-1' },
    body: { input: 'RUNTIME_CWD_UNREPORTED audit event' },
  });
  assert.equal(started.response.status, 202);
  await waitFor(async () => {
    const result = await request(`/api/sessions/${id}`);
    return result.payload.status === 'waiting_review';
  });

  const executions = await request(`/api/sessions/${id}/executions`);
  assert.equal(executions.payload.length, 1);
  assert.equal(executions.payload[0].configuredWorkingDirectory, projectDir);
  assert.equal(executions.payload[0].workingDirectory, '');
  assert.equal(executions.payload[0].workingDirectoryReported, false);
  assert.equal(Object.hasOwn(executions.payload[0].rawEvent.item, 'cwd'), false);

  const deleted = await request(`/api/sessions/${id}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
});

test('recreating a deleted task id starts a distinct persistent session generation', async () => {
  const id = 'reused-task-id';
  const createAndRun = async () => {
    const created = await request('/api/sessions', {
      method: 'POST',
      body: { id, name: 'Reused Task ID', objective: 'Verify generation isolation.', workingDir: projectDir },
    });
    assert.equal(created.response.status, 201);
    assert.equal((await request(`/api/sessions/${id}/run`, {
      method: 'POST', body: { input: 'Verify generation isolation.' },
    })).response.status, 202);
    return waitFor(async () => {
      const task = (await request(`/api/sessions/${id}`)).payload;
      return task.status === 'waiting_review' ? task : null;
    });
  };

  const first = await createAndRun();
  assert.match(first.persistentSessionKey, /^single:reused-task-id-[0-9a-f-]{36}$/);
  assert.equal((await request(`/api/sessions/${id}`, { method: 'DELETE' })).response.status, 200);
  const second = await createAndRun();
  assert.notEqual(second.persistentSessionKey, first.persistentSessionKey);
  assert.equal((await request(`/api/sessions/${id}`, { method: 'DELETE' })).response.status, 200);
});

test('terminal task operations are idempotent across response loss and task id reuse', async () => {
  const stopCreated = await request('/api/sessions', {
    method: 'POST',
    body: {
      id: 'terminal-stop-replay', name: 'Terminal Stop Replay',
      objective: 'Verify durable stop receipts.', workingDir: projectDir,
    },
  });
  assert.equal(stopCreated.response.status, 201);
  const db = new Database(path.join(dataDir, 'codex-tasks.db'));
  db.prepare("UPDATE tasks SET status='queued', version=version+1 WHERE id='terminal-stop-replay'").run();
  const stopHeaders = {
    'idempotency-key': 'terminal-stop-key',
    'x-task-created-at': stopCreated.payload.createdAt,
  };
  const stopped = await request('/api/sessions/terminal-stop-replay/stop', {
    method: 'POST', headers: stopHeaders,
  });
  assert.equal(stopped.response.status, 200);
  assert.deepEqual(stopped.payload, { ok: true });
  const stoppedReplay = await request('/api/sessions/terminal-stop-replay/stop', {
    method: 'POST', headers: stopHeaders,
  });
  assert.equal(stoppedReplay.response.status, 200);
  assert.deepEqual(stoppedReplay.payload, stopped.payload);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM worklog_events
    WHERE task_id='terminal-stop-replay' AND kind='session.stop.requested'
  `).get().count, 1);
  const reboundStopKey = await request('/api/sessions/terminal-stop-replay/complete', {
    method: 'POST', headers: stopHeaders,
  });
  assert.equal(reboundStopKey.response.status, 409);

  const deleteHeaders = {
    'idempotency-key': 'terminal-delete-key',
    'x-task-created-at': stopCreated.payload.createdAt,
  };
  const deleted = await request('/api/sessions/terminal-stop-replay', {
    method: 'DELETE', headers: deleteHeaders,
  });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.payload, { ok: true });
  const deletedReplay = await request('/api/sessions/terminal-stop-replay', {
    method: 'DELETE', headers: deleteHeaders,
  });
  assert.equal(deletedReplay.response.status, 200);
  assert.deepEqual(deletedReplay.payload, deleted.payload);

  await new Promise((resolve) => setTimeout(resolve, 5));
  const replacement = await request('/api/sessions', {
    method: 'POST',
    body: {
      id: 'terminal-stop-replay', name: 'Replacement Generation',
      objective: 'Must survive replay of the old delete.', workingDir: projectDir,
    },
  });
  assert.equal(replacement.response.status, 201);
  assert.notEqual(replacement.payload.createdAt, stopCreated.payload.createdAt);
  assert.equal((await request('/api/sessions/terminal-stop-replay', {
    method: 'DELETE', headers: deleteHeaders,
  })).response.status, 200);
  assert.equal((await request('/api/sessions/terminal-stop-replay')).payload.createdAt, replacement.payload.createdAt);
  const staleGenerationDelete = await request('/api/sessions/terminal-stop-replay', {
    method: 'DELETE',
    headers: {
      'idempotency-key': 'terminal-delete-stale-generation',
      'x-task-created-at': stopCreated.payload.createdAt,
    },
  });
  assert.equal(staleGenerationDelete.response.status, 409);
  assert.equal((await request('/api/sessions/terminal-stop-replay', {
    method: 'DELETE',
    headers: {
      'idempotency-key': 'terminal-delete-replacement',
      'x-task-created-at': replacement.payload.createdAt,
    },
  })).response.status, 200);

  const completeCreated = await request('/api/sessions', {
    method: 'POST',
    body: {
      id: 'terminal-complete-replay', name: 'Terminal Complete Replay',
      objective: 'Verify durable completion receipts.', workingDir: projectDir,
    },
  });
  db.prepare("UPDATE tasks SET status='waiting_review', version=version+1 WHERE id='terminal-complete-replay'").run();
  const completeHeaders = {
    'idempotency-key': 'terminal-complete-key',
    'x-task-created-at': completeCreated.payload.createdAt,
  };
  const completed = await request('/api/sessions/terminal-complete-replay/complete', {
    method: 'POST', headers: completeHeaders,
  });
  const completedReplay = await request('/api/sessions/terminal-complete-replay/complete', {
    method: 'POST', headers: completeHeaders,
  });
  assert.equal(completed.response.status, 200);
  assert.deepEqual(completedReplay.payload, completed.payload);
  assert.equal(completed.payload.status, 'completed');
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM worklog_events
    WHERE task_id='terminal-complete-replay' AND kind='session.completed'
  `).get().count, 1);
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM session_operation_receipts
    WHERE idempotency_key IN ('terminal-stop-key','terminal-delete-key','terminal-complete-key')
  `).get().count, 3);
  db.close();
});

test('create-and-run is atomic and idempotent across response loss and key loss', async () => {
  const body = {
    id: 'atomic-create-run',
    name: 'Atomic Create Run',
    objective: 'Verify one atomic task creation and execution.',
    workingDir: projectDir,
    notes: 'The create request and run command share one transaction.',
    maxRetries: 3,
    autoResume: false,
    idempotencyKey: 'atomic-create-run-key',
  };
  const created = await request('/api/sessions/start', { method: 'POST', body });
  assert.equal(created.response.status, 202);
  assert.equal(created.payload.id, body.id);
  assert.equal(created.payload.status, 'queued');
  assert.equal(created.payload.version, 2);

  const sameKeyRetry = await request('/api/sessions/start', { method: 'POST', body });
  assert.equal(sameKeyRetry.response.status, 200);
  assert.equal(sameKeyRetry.payload.id, body.id);
  const lostKeyRetry = await request('/api/sessions/start', {
    method: 'POST', body: { ...body, idempotencyKey: 'atomic-create-run-key-after-reload' },
  });
  assert.equal(lostKeyRetry.response.status, 200);
  assert.equal(lostKeyRetry.payload.id, body.id);

  const changedInput = await request('/api/sessions/start', {
    method: 'POST', body: { ...body, objective: 'A different first instruction.' },
  });
  assert.equal(changedInput.response.status, 409);
  const changedConfiguration = await request('/api/sessions/start', {
    method: 'POST', body: { ...body, notes: 'Different configuration.', idempotencyKey: 'atomic-create-run-other-key' },
  });
  assert.equal(changedConfiguration.response.status, 409);

  const audit = await request(`/api/audit?sessionId=${body.id}&limit=100`);
  assert.equal(audit.payload.filter((event) => event.kind === 'session.created').length, 1);
  const worklogs = await request(`/api/sessions/${body.id}/worklogs?limit=100`);
  assert.equal(worklogs.payload.filter((event) => event.kind === 'session.queued').length, 1);
  await waitFor(async () => {
    const task = (await request(`/api/sessions/${body.id}`)).payload;
    return task.status === 'waiting_review' ? task : null;
  });
  assert.equal((await request(`/api/sessions/${body.id}/complete`, { method: 'POST' })).response.status, 200);
  const completedReplay = await request('/api/sessions/start', { method: 'POST', body });
  assert.equal(completedReplay.response.status, 200);
  assert.equal(completedReplay.payload.status, 'completed');

  const disabled = await request('/api/sessions/start', {
    method: 'POST',
    body: {
      id: 'atomic-disabled', name: 'Atomic Disabled', objective: 'Must roll back.',
      workingDir: projectDir, enabled: false, idempotencyKey: 'atomic-disabled-key',
    },
  });
  assert.equal(disabled.response.status, 400);
  assert.equal((await request('/api/sessions/atomic-disabled')).response.status, 404);
});

test('documented task APIs support create, list, detail, update, log queries, and delete', async () => {
  const created = await request('/api/sessions', {
    method: 'POST',
    headers: { 'x-request-id': 'api-docs-create' },
    body: {
      id: 'api-docs-task',
      name: 'API Docs Task',
      objective: 'Verify documented task management endpoints.',
      workingDir: projectDir,
      notes: 'Created by the API documentation contract test.',
      maxRetries: 3,
      autoResume: false,
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.response.headers.get('x-request-id'), 'api-docs-create');
  assert.equal(created.payload.id, 'api-docs-task');
  assert.equal(created.payload.status, 'idle');
  assert.equal(created.payload.runCount, 0);
  assert.equal(created.payload.maxRetries, 3);
  assert.equal(created.payload.autoResume, false);
  const duplicateCreate = await request('/api/sessions', {
    method: 'POST',
    body: {
      id: 'api-docs-task', name: 'Must Not Replace',
      objective: 'A duplicate POST must not update the existing task.', workingDir: projectDir,
    },
  });
  assert.equal(duplicateCreate.response.status, 409);

  const listed = await request('/api/sessions');
  assert.equal(listed.response.status, 200);
  assert.ok(listed.payload.some((session) => session.id === 'api-docs-task'));
  const firstPage = await request('/api/sessions?limit=1&offset=0');
  const secondPage = await request('/api/sessions?limit=1&offset=1');
  assert.equal(firstPage.payload.length, 1);
  assert.equal(secondPage.payload.length, 1);
  assert.notEqual(firstPage.payload[0].id, secondPage.payload[0].id);
  const completedPage = await request('/api/sessions?limit=20&offset=0&status=completed');
  assert.ok(completedPage.payload.length > 0);
  assert.ok(completedPage.payload.every((session) => session.status === 'completed'));
  const invalidStatus = await request('/api/sessions?status=completed,not-a-real-status');
  assert.equal(invalidStatus.response.status, 400);

  const detail = await request('/api/sessions/api-docs-task');
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.objective, 'Verify documented task management endpoints.');
  assert.equal(detail.payload.notes, 'Created by the API documentation contract test.');

  const updated = await request('/api/sessions/api-docs-task', {
    method: 'PUT',
    body: { name: 'Updated API Docs Task', maxRetries: 1, autoResume: true },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.name, 'Updated API Docs Task');
  assert.equal(updated.payload.maxRetries, 1);
  assert.equal(updated.payload.autoResume, true);
  assert.ok(updated.payload.version > created.payload.version);

  const turns = await request('/api/sessions/api-docs-task/turns?limit=20');
  assert.equal(turns.response.status, 200);
  assert.deepEqual(turns.payload, []);

  const steps = await request('/api/sessions/api-docs-task/steps');
  assert.equal(steps.response.status, 200);
  assert.deepEqual(steps.payload, []);

  const attempts = await request('/api/sessions/api-docs-task/attempts?limit=20&offset=0');
  assert.equal(attempts.response.status, 200);
  assert.deepEqual(attempts.payload, []);

  const executions = await request('/api/sessions/api-docs-task/executions?limit=20&offset=0');
  assert.equal(executions.response.status, 200);
  assert.deepEqual(executions.payload, []);

  const skillInvocations = await request('/api/sessions/api-docs-task/skill-invocations?limit=20&offset=0');
  assert.equal(skillInvocations.response.status, 200);
  assert.deepEqual(skillInvocations.payload, []);

  const worklogs = await request('/api/sessions/api-docs-task/worklogs?limit=100&q=test');
  assert.equal(worklogs.response.status, 200);
  assert.deepEqual(worklogs.payload, []);

  const latestLog = await request('/api/sessions/api-docs-task/latest-log');
  assert.equal(latestLog.response.status, 200);
  assert.match(latestLog.response.headers.get('content-type'), /^text\/plain/);
  assert.equal(latestLog.payload, '');

  const deleted = await request('/api/sessions/api-docs-task', { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual(deleted.payload, { ok: true });
  assert.equal((await request('/api/sessions/api-docs-task')).response.status, 404);

  const audit = await request('/api/audit?sessionId=api-docs-task&limit=20');
  assert.ok(audit.payload.some((event) => event.kind === 'session.created'));
  assert.ok(audit.payload.some((event) => event.kind === 'session.updated'));
  assert.ok(audit.payload.some((event) => event.kind === 'session.deleted'));
  const auditPage = await request('/api/audit?sessionId=api-docs-task&limit=1&offset=1');
  assert.equal(auditPage.payload.length, 1);
  const createdAudit = audit.payload.find((event) => event.kind === 'session.created');
  assert.equal(createdAudit.requestId, 'api-docs-create');
  assert.equal(createdAudit.actor, 'operator');
  assert.equal(createdAudit.payload.objective, 'Verify documented task management endpoints.');
  assert.equal(createdAudit.payload.notes, 'Created by the API documentation contract test.');
});

test('external attempt log API prefers the preserved terminal copy over the business path', async () => {
  const taskId = 'api-preserved-external-log';
  const attemptId = 'external-api-preserved';
  const sourcePath = path.join(projectDir, 'api-external-source.log');
  const archiveDirectory = path.join(dataDir, 'sessions', taskId, 'external-attempt-output');
  const archivePath = path.join(archiveDirectory, `${attemptId}.log`);
  const source = 'business path must not win\n';
  const preserved = Buffer.from('complete preserved pytest output\0\n', 'utf8');
  await request('/api/sessions', {
    method: 'POST',
    body: {
      id: taskId, name: 'Preserved external log API',
      objective: 'Serve the managed terminal copy.', workingDir: projectDir,
    },
  });
  fs.writeFileSync(sourcePath, source, { mode: 0o600 });
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(archivePath, preserved, { mode: 0o600 });
  const now = new Date().toISOString();
  const nextVerificationAt = new Date(Date.now() + 86400000).toISOString();
  const sha256 = crypto.createHash('sha256').update(preserved).digest('hex');
  const db = new Database(path.join(dataDir, 'codex-tasks.db'));
  try {
    db.prepare(`
      INSERT INTO external_attempts(
        id, task_id, chain_key, generation, status, log_path,
        archived_log_path, archived_log_bytes, archived_log_sha256, archive_status, archived_at,
        archive_verify_status, archive_verified_at, archive_verify_next_at,
        started_at, finished_at, created_at, updated_at
      ) VALUES (?, ?, 'api-preserved', 1, 'succeeded', ?, ?, ?, ?, 'archived', ?, 'verified', ?, ?, ?, ?, ?, ?)
    `).run(
      attemptId, taskId, sourcePath, archivePath, preserved.length, sha256,
      now, now, nextVerificationAt, now, now, now, now,
    );
  } finally {
    db.close();
  }

  const attempts = await request(`/api/sessions/${taskId}/external-attempts`);
  assert.equal(attempts.response.status, 200);
  assert.equal(attempts.payload[0].archiveStatus, 'archived');
  assert.equal(attempts.payload[0].archivedLogSha256, sha256);
  const log = await request(`/api/sessions/${taskId}/external-attempts/${attemptId}/log`);
  if (log.response.status !== 200) {
    const refreshedAttempts = await request(`/api/sessions/${taskId}/external-attempts`);
    assert.fail(JSON.stringify({
      logStatus: log.response.status,
      logPayload: log.payload,
      externalAttempt: refreshedAttempts.payload[0],
    }));
  }
  assert.equal(log.payload, preserved.toString('utf8'));
  assert.notEqual(log.payload, source);
  const incrementalLog = await request(
    `/api/sessions/${taskId}/external-attempts/${attemptId}/log?offset=9&limit=12`,
  );
  assert.equal(incrementalLog.response.status, 200);
  assert.equal(incrementalLog.payload, preserved.subarray(9, 21).toString('utf8'));
  assert.equal(incrementalLog.response.headers.get('x-log-offset'), '9');
  assert.equal(incrementalLog.response.headers.get('x-log-next-offset'), '21');
  assert.equal(incrementalLog.response.headers.get('x-log-file-size'), String(preserved.length));
  assert.equal(incrementalLog.response.headers.get('x-attempt-status'), 'succeeded');
  const liveLog = await new Promise((resolve, reject) => {
    const chunks = [];
    const controls = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/sessions/${taskId}/external-attempts/${attemptId}/log/live?offset=7`,
    );
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out waiting for background task output WebSocket'));
    }, 5000);
    socket.on('message', (data, isBinary) => {
      if (isBinary) chunks.push(Buffer.from(data));
      else controls.push(JSON.parse(String(data)));
    });
    socket.once('error', reject);
    socket.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, output: Buffer.concat(chunks), controls });
    });
  });
  assert.equal(liveLog.code, 1000);
  assert.deepEqual(liveLog.output, preserved.subarray(7));
  assert.equal(liveLog.controls[0].type, 'ready');
  assert.equal(liveLog.controls[0].offset, 7);
  assert.equal(liveLog.controls.at(-1).type, 'end');
  assert.equal(liveLog.controls.at(-1).status, 'succeeded');

  assert.equal((await request(`/api/sessions/${taskId}`, { method: 'DELETE' })).response.status, 200);
  assert.equal(fs.existsSync(archivePath), false);
  fs.rmSync(sourcePath, { force: true });
});

test('aborting a large external log response promptly closes the server file handle', {
  skip: process.platform !== 'linux',
}, async () => {
  const taskId = 'api-aborted-external-log';
  const attemptId = 'external-api-aborted';
  const sourcePath = path.join(projectDir, 'api-aborted-source.log');
  const archiveDirectory = path.join(dataDir, 'sessions', taskId, 'external-attempt-output');
  const archivePath = path.join(archiveDirectory, `${attemptId}.log`);
  await request('/api/sessions', {
    method: 'POST',
    body: {
      id: taskId, name: 'Aborted external log API',
      objective: 'Release a large managed log when its reader disconnects.', workingDir: projectDir,
    },
  });
  fs.writeFileSync(sourcePath, 'source evidence\n', { mode: 0o600 });
  fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  const chunk = Buffer.alloc(1024 * 1024, 0x78);
  const hash = crypto.createHash('sha256');
  const archiveFd = fs.openSync(archivePath, 'w', 0o600);
  try {
    for (let index = 0; index < 16; index += 1) {
      fs.writeSync(archiveFd, chunk);
      hash.update(chunk);
    }
  } finally {
    fs.closeSync(archiveFd);
  }
  const now = new Date().toISOString();
  const nextVerificationAt = new Date(Date.now() + 86400000).toISOString();
  const db = new Database(path.join(dataDir, 'codex-tasks.db'));
  try {
    db.prepare(`
      INSERT INTO external_attempts(
        id, task_id, chain_key, generation, status, log_path,
        archived_log_path, archived_log_bytes, archived_log_sha256, archive_status, archived_at,
        archive_verify_status, archive_verified_at, archive_verify_next_at,
        started_at, finished_at, created_at, updated_at
      ) VALUES (?, ?, 'api-aborted', 1, 'succeeded', ?, ?, ?, ?, 'archived', ?,
        'verified', ?, ?, ?, ?, ?, ?)
    `).run(
      attemptId, taskId, sourcePath, archivePath, 16 * 1024 * 1024, hash.digest('hex'), now,
      now, nextVerificationAt, now, now, now, now,
    );
  } finally {
    db.close();
  }

  assert.equal(countOpenFileDescriptors(server.pid, archivePath), 0);
  const statusCode = await abortDownloadAfterFirstChunk(
    `/api/sessions/${taskId}/external-attempts/${attemptId}/log`,
  );
  assert.equal(statusCode, 200);
  await waitFor(() => countOpenFileDescriptors(server.pid, archivePath) === 0);
  assert.equal((await request('/api/health')).response.status, 200);
  assert.equal((await request(`/api/sessions/${taskId}`, { method: 'DELETE' })).response.status, 200);
  fs.rmSync(sourcePath, { force: true });
});

test('log downloads bound concurrency, expire stalled clients, and recover capacity', async () => {
  const isolatedDataDir = path.join(tempDir, 'log-stream-limit', 'data');
  const isolatedRuntimeDir = path.join(tempDir, 'log-stream-limit', 'runtime');
  const isolatedPort = port + 4;
  const root = `http://127.0.0.1:${isolatedPort}`;
  const child = spawnServer({
    port: isolatedPort,
    dataDir: isolatedDataDir,
    runtimeDir: isolatedRuntimeDir,
    workspaceRoot,
    logStreamMaxConcurrency: 1,
    logStreamIdleTimeoutMs: 1000,
  });
  let pausedRequest = null;
  let pausedResponse = null;
  try {
    await waitFor(async () => {
      try {
        const health = await request('/api/health', {}, root);
        return health.response.status === 200 && health.payload.runtime.workerAvailable;
      } catch {
        return false;
      }
    });

    const taskId = 'bounded-log-streams';
    const attemptId = 'external-bounded-log';
    const sourcePath = path.join(projectDir, 'bounded-log-source.log');
    const archiveDirectory = path.join(
      isolatedDataDir, 'sessions', taskId, 'external-attempt-output',
    );
    const archivePath = path.join(archiveDirectory, `${attemptId}.log`);
    const created = await request('/api/sessions', {
      method: 'POST',
      body: {
        id: taskId,
        name: 'Bounded log streams',
        objective: 'Keep large log downloads within bounded resources.',
        workingDir: projectDir,
      },
    }, root);
    assert.equal(created.response.status, 201);
    const queued = await request(`/api/sessions/${taskId}/run`, {
      method: 'POST',
      headers: { 'idempotency-key': 'bounded-log-streams-run' },
      body: { input: 'Create an Attempt output stream for shared capacity verification.' },
    }, root);
    assert.equal(queued.response.status, 202);
    await waitFor(async () => (
      await request(`/api/sessions/${taskId}`, {}, root)
    ).payload.status === 'waiting_review');
    const attempts = await request(`/api/sessions/${taskId}/attempts`, {}, root);
    assert.equal(attempts.payload.length, 1);
    assert.equal(attempts.payload[0].stdoutAvailable, true);
    const attemptStdoutPath = `/api/sessions/${taskId}/attempts/${attempts.payload[0].id}/stdout`;
    fs.writeFileSync(sourcePath, 'source evidence\n', { mode: 0o600 });
    fs.mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
    const chunk = Buffer.alloc(1024 * 1024, 0x6c);
    const hash = crypto.createHash('sha256');
    const archiveFd = fs.openSync(archivePath, 'w', 0o600);
    const archiveBytes = 32 * chunk.length;
    try {
      for (let index = 0; index < 32; index += 1) {
        fs.writeSync(archiveFd, chunk);
        hash.update(chunk);
      }
    } finally {
      fs.closeSync(archiveFd);
    }
    const now = new Date().toISOString();
    const database = new Database(path.join(isolatedDataDir, 'codex-tasks.db'));
    try {
      database.prepare(`
        INSERT INTO external_attempts(
          id, task_id, chain_key, generation, status, log_path,
          archived_log_path, archived_log_bytes, archived_log_sha256, archive_status, archived_at,
          archive_verify_status, archive_verified_at, archive_verify_next_at,
          started_at, finished_at, created_at, updated_at
        ) VALUES (?, ?, 'bounded-log', 1, 'succeeded', ?, ?, ?, ?, 'archived', ?,
          'verified', ?, ?, ?, ?, ?, ?)
      `).run(
        attemptId, taskId, sourcePath, archivePath, archiveBytes, hash.digest('hex'), now,
        now, new Date(Date.now() + 86400000).toISOString(), now, now, now, now,
      );
    } finally {
      database.close();
    }

    const logPath = `/api/sessions/${taskId}/external-attempts/${attemptId}/log`;
    const paused = await new Promise((resolve, reject) => {
      const requestStream = http.get(`${root}${logPath}`, (response) => {
        response.pause();
        response.on('error', () => {});
        resolve({ requestStream, response });
      });
      requestStream.once('error', reject);
    });
    pausedRequest = paused.requestStream;
    pausedResponse = paused.response;

    await waitFor(async () => {
      const health = await request('/api/health', {}, root);
      return health.payload.logStreams.active === 1 && health.payload.logStreams.saturated;
    });
    const saturatedHealth = await request('/api/health', {}, root);
    assert.deepEqual(saturatedHealth.payload.logStreams, {
      active: 1,
      maxConcurrency: 1,
      saturated: true,
      idleTimeoutMs: 1000,
      idleTimeoutCount: 0,
    });
    const refused = await request(attemptStdoutPath, {}, root);
    assert.equal(refused.response.status, 429);
    assert.equal(refused.response.headers.get('retry-after'), '1');
    assert.match(refused.payload.error, /concurrency limit/i);

    await waitFor(async () => {
      const health = await request('/api/health', {}, root);
      return health.payload.logStreams.active === 0
        && !health.payload.logStreams.saturated
        && health.payload.logStreams.idleTimeoutCount === 1;
    });
    pausedResponse.destroy();
    pausedRequest.destroy();
    pausedResponse = null;
    pausedRequest = null;

    const completed = await fetch(`${root}${logPath}`);
    assert.equal(completed.status, 200);
    assert.equal((await completed.arrayBuffer()).byteLength, archiveBytes);
    const releasedHealth = await request('/api/health', {}, root);
    assert.deepEqual(releasedHealth.payload.logStreams, {
      active: 0,
      maxConcurrency: 1,
      saturated: false,
      idleTimeoutMs: 1000,
      idleTimeoutCount: 1,
    });
  } finally {
    pausedResponse?.destroy();
    pausedRequest?.destroy();
    await stopServer(child);
  }
});

test('API requests bound concurrency while diagnostics stay available and idle capacity recovers', async () => {
  const isolatedDataDir = path.join(tempDir, 'api-request-limit', 'data');
  const isolatedRuntimeDir = path.join(tempDir, 'api-request-limit', 'runtime');
  const isolatedPort = port + 12;
  const root = `http://127.0.0.1:${isolatedPort}`;
  const child = spawnServer({
    port: isolatedPort,
    dataDir: isolatedDataDir,
    runtimeDir: isolatedRuntimeDir,
    workspaceRoot,
    apiMaxConcurrency: 1,
    apiIdleTimeoutMs: 1000,
  });
  let heldRequest = null;
  try {
    await waitFor(async () => {
      try {
        const health = await request('/api/health', {}, root);
        return health.response.status === 200 && health.payload.runtime.workerAvailable;
      } catch {
        return false;
      }
    });

    const heldClosed = new Promise((resolve) => {
      heldRequest = http.request({
        host: '127.0.0.1',
        port: isolatedPort,
        path: '/api/sessions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '4096',
        },
      });
      heldRequest.on('response', (response) => response.resume());
      heldRequest.once('error', resolve);
      heldRequest.once('close', resolve);
      heldRequest.write('{"id":"partial-request"');
    });

    const saturatedHealth = await waitFor(async () => {
      const health = await request('/api/health', {}, root);
      return health.payload.apiRequests.active === 1
        && health.payload.apiRequests.saturated ? health : null;
    });
    assert.deepEqual(saturatedHealth.payload.apiRequests, {
      active: 1,
      maxConcurrency: 1,
      saturated: true,
      rejectedCount: 0,
      idleTimeoutMs: 1000,
      idleTimeoutCount: 0,
    });

    const refused = await request('/api/dashboard', {}, root);
    assert.equal(refused.response.status, 429);
    assert.equal(refused.response.headers.get('retry-after'), '1');
    assert.match(refused.payload.error, /API request concurrency limit/i);

    await heldClosed;
    heldRequest = null;
    const recoveredHealth = await waitFor(async () => {
      const health = await request('/api/health', {}, root);
      return health.payload.apiRequests.active === 0
        && !health.payload.apiRequests.saturated
        && health.payload.apiRequests.rejectedCount === 1
        && health.payload.apiRequests.idleTimeoutCount === 1 ? health : null;
    });
    assert.deepEqual(recoveredHealth.payload.apiRequests, {
      active: 0,
      maxConcurrency: 1,
      saturated: false,
      rejectedCount: 1,
      idleTimeoutMs: 1000,
      idleTimeoutCount: 1,
    });

    const dashboard = await request('/api/dashboard', {}, root);
    assert.equal(dashboard.response.status, 200);
    assert.deepEqual(dashboard.payload.apiRequests, recoveredHealth.payload.apiRequests);
  } finally {
    heldRequest?.destroy();
    await stopServer(child);
  }
});

test('an aborted API request immediately releases its concurrency slot', async () => {
  const isolatedDataDir = path.join(tempDir, 'api-request-abort', 'data');
  const isolatedRuntimeDir = path.join(tempDir, 'api-request-abort', 'runtime');
  const isolatedPort = port + 13;
  const root = `http://127.0.0.1:${isolatedPort}`;
  const child = spawnServer({
    port: isolatedPort,
    dataDir: isolatedDataDir,
    runtimeDir: isolatedRuntimeDir,
    workspaceRoot,
    apiMaxConcurrency: 1,
    apiIdleTimeoutMs: 10000,
  });
  let partialRequest = null;
  try {
    await waitFor(async () => {
      try {
        return (await request('/api/health', {}, root)).response.status === 200;
      } catch {
        return false;
      }
    });
    await new Promise((resolve, reject) => {
      partialRequest = http.request({
        host: '127.0.0.1',
        port: isolatedPort,
        path: '/api/sessions',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '4096' },
      });
      partialRequest.once('error', () => resolve());
      partialRequest.once('close', () => resolve());
      partialRequest.once('response', (response) => {
        response.resume();
        reject(new Error('Aborted request unexpectedly received a response'));
      });
      partialRequest.write('{"id":"aborted-request"');
      setImmediate(() => partialRequest.destroy());
    });
    partialRequest = null;
    await waitFor(async () => {
      const health = await request('/api/health', {}, root);
      return health.payload.apiRequests.active === 0 ? health : null;
    }, 2000);
    const dashboard = await request('/api/dashboard', {}, root);
    assert.equal(dashboard.response.status, 200);
  } finally {
    partialRequest?.destroy();
    await stopServer(child);
  }
});

test('task ids, field types, and enabled state are enforced at the API boundary', async () => {
  const invalidId = await request('/api/sessions', {
    method: 'POST',
    body: { id: 'Invalid ID', name: 'Invalid', objective: 'Must be rejected.', workingDir: projectDir },
  });
  assert.equal(invalidId.response.status, 400);

  const invalidType = await request('/api/sessions', {
    method: 'POST',
    body: { id: 'invalid-type', name: 123, objective: 'Must be rejected.', workingDir: projectDir },
  });
  assert.equal(invalidType.response.status, 400);

  const numericId = await request('/api/sessions', {
    method: 'POST',
    body: { id: 123, name: 'Numeric ID', objective: 'Must be rejected.', workingDir: projectDir },
  });
  assert.equal(numericId.response.status, 400);

  const numericSkillId = await request('/api/skills', {
    method: 'POST', body: { id: 123, name: 'Numeric Skill ID', content: '# Invalid' },
  });
  assert.equal(numericSkillId.response.status, 400);

  const disabled = await request('/api/sessions', {
    method: 'POST',
    body: { id: 'disabled-task', name: 'Disabled', objective: 'Must not run.', workingDir: projectDir, enabled: false },
  });
  assert.equal(disabled.response.status, 201);
  assert.equal(disabled.payload.enabled, false);
  const run = await request('/api/sessions/disabled-task/run', { method: 'POST', body: {} });
  assert.equal(run.response.status, 409);
  const nonCanonicalLookup = await request('/api/sessions/Disabled-task');
  assert.equal(nonCanonicalLookup.response.status, 400);
  assert.equal((await request('/api/sessions/disabled-task', { method: 'DELETE' })).response.status, 200);
});

test('HTTP boundaries reject malformed and oversized inputs without exposing host paths', async () => {
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.ok, true);
  assert.equal(health.payload.ready, true);
  assert.equal('root' in health.payload, false);
  assert.equal(health.payload.storage.quickCheck, 'ok');
  assert.equal(health.payload.storage.foreignKeyViolations, 0);
  assert.equal(health.payload.backups.enabled, false);
  assert.equal(health.payload.backups.inProgress, false);
  assert.equal(JSON.stringify(health.payload.backups).includes(tempDir), false);
  assert.equal(health.payload.taskRetention.enabled, true);
  assert.equal(health.payload.taskRetention.retentionDays, 30);
  assert.equal(health.payload.taskRetention.dueTasks, 0);
  assert.equal(JSON.stringify(health.payload.taskRetention).includes(tempDir), false);
  assert.equal(health.payload.state.ok, true);
  assert.ok(Object.values(health.payload.state.violations).every((count) => count === 0));
  assert.equal(health.payload.runtime.ready, true);
  assert.equal(health.payload.runtime.workerProcessVerified, true);
  assert.deepEqual(health.payload.runtime.degradedReasons, []);
  assert.deepEqual(health.payload.runtime.executionProcesses, {
    ok: true, tracked: 0, verified: 0, unverified: 0, issues: [],
  });
  const contentSecurityPolicy = health.response.headers.get('content-security-policy');
  assert.match(contentSecurityPolicy, /base-uri 'self'/);
  assert.match(contentSecurityPolicy, /object-src 'none'/);
  assert.match(contentSecurityPolicy, /style-src 'self' 'unsafe-inline'/);
  assert.match(contentSecurityPolicy, /script-src 'self'/);
  assert.doesNotMatch(contentSecurityPolicy, /script-src[^;]*'unsafe-inline'/);

  const malformed = await request('/api/sessions/%E0%A4%A');
  assert.equal(malformed.response.status, 400);
  assert.match(malformed.payload.error, /malformed url/i);
  assert.equal((await request('/api/health')).response.status, 200);
  assert.equal((await request('/api/audit?limit=1.5&offset=not-a-number')).response.status, 200);

  const longName = await request('/api/sessions', {
    method: 'POST',
    body: { id: 'long-name', name: 'n'.repeat(201), objective: 'Rejected.', workingDir: projectDir },
  });
  assert.equal(longName.response.status, 400);

  const invalidSkill = await request('/api/skills', {
    method: 'POST', body: { id: 'Invalid Skill', name: 'Invalid', content: '# Invalid' },
  });
  assert.equal(invalidSkill.response.status, 400);
  const invalidSkillContent = await request('/api/skills', {
    method: 'POST', body: { id: 'invalid-content', name: 'Invalid', content: { markdown: '# Invalid' } },
  });
  assert.equal(invalidSkillContent.response.status, 400);
  const wrongContentType = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
  });
  assert.equal(wrongContentType.status, 415);
  const staticWrite = await request('/not-an-api-route', { method: 'POST' });
  assert.equal(staticWrite.response.status, 405);
  assert.equal(staticWrite.response.headers.get('allow'), 'GET, HEAD');
  const staticHead = await fetch(`${baseUrl}/` , { method: 'HEAD' });
  assert.equal(staticHead.status, 200);
  assert.equal(await staticHead.text(), '');

  const longKeyTask = await request('/api/sessions', {
    method: 'POST', body: { id: 'long-key', name: 'Long Key', objective: 'Rejected run.', workingDir: projectDir },
  });
  assert.equal(longKeyTask.response.status, 201);
  const longKeyRun = await request('/api/sessions/long-key/run', {
    method: 'POST', body: { input: 'Run', idempotencyKey: 'k'.repeat(257) },
  });
  assert.equal(longKeyRun.response.status, 400);
  assert.equal((await request('/api/sessions/long-key', { method: 'DELETE' })).response.status, 200);
});

test('database backup APIs create, list, and independently verify an online snapshot', async () => {
  const created = await request('/api/backups', { method: 'POST' });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.ok, true);
  assert.equal(created.payload.auditRecorded, true);
  assert.equal(created.payload.backup.database.quickCheck, 'ok');
  assert.equal(created.payload.backup.database.foreignKeyViolations, 0);
  assert.match(created.payload.backup.database.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(created.payload).includes(tempDir), false);

  const listed = await request('/api/backups');
  assert.equal(listed.response.status, 200);
  assert.ok(listed.payload.backups.some((backup) => backup.id === created.payload.backup.id));
  assert.equal(listed.payload.status.backupCount, listed.payload.backups.length);

  const verified = await request(`/api/backups/${created.payload.backup.id}/verify`, { method: 'POST' });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.payload.ok, true);
  assert.equal(verified.payload.auditRecorded, true);
  assert.equal(verified.payload.checks.sha256Matches, true);
  assert.equal(verified.payload.checks.tableCountsMatch, true);

  const audit = await request('/api/audit?kind=database.backup');
  assert.ok(audit.payload.some((event) => event.kind === 'database.backup.created'));
  assert.ok(audit.payload.some((event) => event.kind === 'database.backup.verified'));
});

test('health checks fail closed when persisted execution identity is inconsistent', async () => {
  const taskId = 'health-state-invariant';
  await request('/api/sessions', {
    method: 'POST',
    body: { id: taskId, name: 'Health State Invariant', objective: 'Probe health invariants.', workingDir: projectDir },
  });
  const db = new Database(path.join(dataDir, 'codex-tasks.db'));
  try {
    db.prepare(`
      UPDATE tasks SET current_pid=?, current_pid_start_ticks='stale', current_process_group_id=? WHERE id=?
    `).run(process.pid, process.pid, taskId);
    const degraded = await request('/api/health');
    assert.equal(degraded.response.status, 503);
    assert.equal(degraded.payload.ok, false);
    assert.equal(degraded.payload.storage.ok, true);
    assert.ok(degraded.payload.state.violations.activeProcessIdentityMismatches >= 1);
    db.prepare(`
      UPDATE tasks SET current_pid=NULL, current_pid_start_ticks='', current_process_group_id=NULL WHERE id=?
    `).run(taskId);
    assert.equal((await request('/api/health')).response.status, 200);
  } finally {
    db.close();
    await request(`/api/sessions/${taskId}`, { method: 'DELETE' });
  }
});

test('health checks fail closed when completed tasks retain active work or execution leases', async () => {
  const taskId = 'health-completed-active-work';
  await request('/api/sessions', {
    method: 'POST',
    body: {
      id: taskId,
      name: 'Completed Active Work Invariant',
      objective: 'Probe completed task state invariants.',
      workingDir: projectDir,
    },
  });
  const db = new Database(path.join(dataDir, 'codex-tasks.db'));
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + 60000).toISOString();
  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE tasks
        SET status='queued', recovery_state='queued',
            lease_owner='starting-worker', lease_expires_at=?
        WHERE id=?
      `).run(leaseExpiresAt, taskId);
      db.prepare(`
        INSERT INTO commands (
          id, task_id, type, input, idempotency_key, status, worker_id, error,
          created_at, claimed_at, claim_expires_at
        ) VALUES (?, ?, 'run', '', ?, 'processing', 'starting-worker', '', ?, ?, ?)
      `).run(
        'health-active-command', taskId, 'health-active-command-key',
        now, now, leaseExpiresAt,
      );
    }).immediate();
    assert.equal((await request('/api/health')).response.status, 200);

    db.transaction(() => {
      db.prepare(`
        UPDATE tasks
        SET status='completed', recovery_state='completed', archived_at=?,
            lease_owner='stale-worker', lease_expires_at=?
        WHERE id=?
      `).run(now, now, taskId);
      db.prepare(`
        UPDATE commands
        SET status='pending', worker_id='', claimed_at='', claim_expires_at=''
        WHERE id='health-active-command'
      `).run();
      db.prepare(`
        INSERT INTO external_attempts (
          id, task_id, chain_key, generation, status, log_path,
          started_at, created_at, updated_at
        ) VALUES (?, ?, ?, 1, 'running', ?, ?, ?, ?)
      `).run(
        'health-active-external', taskId, 'health-active-chain',
        path.join(projectDir, 'health-active.log'), now, now, now,
      );
      db.prepare(`
        INSERT INTO scheduled_jobs (
          id, task_id, external_attempt_id, generation, sequence, kind, due_at,
          idempotency_key, status, created_at, updated_at
        ) VALUES (?, ?, ?, 1, 1, 'external_check', ?, ?, 'pending', ?, ?)
      `).run(
        'health-active-schedule', taskId, 'health-active-external', now,
        'health-active-schedule-key', now, now,
      );
    }).immediate();

    const degraded = await request('/api/health');
    assert.equal(degraded.response.status, 503);
    assert.equal(degraded.payload.ok, false);
    assert.equal(degraded.payload.storage.ok, true);
    assert.equal(degraded.payload.state.violations.unexpectedTaskLeases, 1);
    assert.equal(degraded.payload.state.violations.completedTasksWithActiveCommands, 1);
    assert.equal(degraded.payload.state.violations.completedTasksWithActiveSchedules, 1);
    assert.equal(degraded.payload.state.violations.completedTasksWithActiveExternalAttempts, 1);

    db.transaction(() => {
      db.prepare('DELETE FROM scheduled_jobs WHERE task_id=?').run(taskId);
      db.prepare('DELETE FROM external_attempts WHERE task_id=?').run(taskId);
      db.prepare('DELETE FROM commands WHERE task_id=?').run(taskId);
      db.prepare(`
        UPDATE tasks
        SET status='idle', recovery_state='idle', archived_at='',
            lease_owner=NULL, lease_expires_at=NULL
        WHERE id=?
      `).run(taskId);
    }).immediate();
    assert.equal((await request('/api/health')).response.status, 200);
  } finally {
    db.close();
    await request(`/api/sessions/${taskId}`, { method: 'DELETE' });
  }
});

test('readiness verifies active execution identities against procfs', async () => {
  const taskId = 'runtime-process-readiness';
  await request('/api/sessions', {
    method: 'POST',
    body: { id: taskId, name: 'Runtime Process Readiness', objective: 'SLOW_TASK', workingDir: projectDir },
  });
  await request(`/api/sessions/${taskId}/run`, { method: 'POST', body: { input: 'SLOW_TASK' } });
  const running = await waitFor(async () => {
    const task = (await request(`/api/sessions/${taskId}`)).payload;
    return task.currentPid ? task : null;
  });
  const [attempt] = (await request(`/api/sessions/${taskId}/attempts`)).payload;
  const staleStartTicks = String(BigInt(running.currentPidStartTicks) + 1n);
  const db = new Database(path.join(dataDir, 'codex-tasks.db'));
  try {
    db.transaction(() => {
      db.prepare('UPDATE tasks SET current_pid_start_ticks=? WHERE id=?')
        .run(staleStartTicks, taskId);
      db.prepare('UPDATE attempts SET pid_start_ticks=? WHERE id=?')
        .run(staleStartTicks, attempt.id);
    })();
    const live = await request('/api/health');
    assert.equal(live.response.status, 200);
    assert.equal(live.payload.ok, true);
    assert.equal(live.payload.state.ok, true);
    assert.equal(live.payload.ready, false);
    assert.equal(live.payload.runtime.ready, false);
    assert.deepEqual(live.payload.runtime.degradedReasons, ['execution_process_mismatch']);
    assert.equal(live.payload.runtime.executionProcesses.unverified, 1);
    assert.deepEqual(live.payload.runtime.executionProcesses.issues[0], {
      taskId,
      attemptId: attempt.id,
      pid: running.currentPid,
      reason: 'identity_mismatch',
    });
    assert.equal((await request('/api/ready')).response.status, 503);
    db.transaction(() => {
      db.prepare('UPDATE tasks SET current_pid_start_ticks=? WHERE id=?')
        .run(running.currentPidStartTicks, taskId);
      db.prepare('UPDATE attempts SET pid_start_ticks=? WHERE id=?')
        .run(running.currentPidStartTicks, attempt.id);
    })();
    const restored = await request('/api/ready');
    assert.equal(restored.response.status, 200);
    assert.equal(restored.payload.ready, true);
  } finally {
    db.prepare('UPDATE tasks SET current_pid_start_ticks=? WHERE id=?')
      .run(running.currentPidStartTicks, taskId);
    db.prepare('UPDATE attempts SET pid_start_ticks=? WHERE id=?')
      .run(running.currentPidStartTicks, attempt.id);
    db.close();
    await request(`/api/sessions/${taskId}/stop`, { method: 'POST' });
    await waitFor(async () => (await request(`/api/sessions/${taskId}`)).payload.status === 'stopped');
  }
});

test('the Skill command wrapper validates frozen snapshot membership before execution', () => {
  const snapshotDir = path.join(tempDir, 'wrapper-snapshot');
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify({
    skills: [{ id: 'converter-test' }, { id: 'run-in-background' }],
  }));
  const wrapper = path.join(ROOT_DIR, 'bin', 'full-access', 'codex-skill-use');
  const valid = spawnSync(wrapper, [
    'converter-test', 'run-in-background', '--', process.execPath, '-e', 'process.stdout.write("WRAPPED_OK")',
  ], {
    env: { ...process.env, CODEX_TASK_SKILL_SNAPSHOT: snapshotDir },
    encoding: 'utf8',
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, 'WRAPPED_OK');
  const invalid = spawnSync(wrapper, [
    'not-in-snapshot', '--', process.execPath, '-e', 'process.stdout.write("MUST_NOT_RUN")',
  ], {
    env: { ...process.env, CODEX_TASK_SKILL_SNAPSHOT: snapshotDir },
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 65);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /not present in this task snapshot/);
});

test('the documented start script is compatible with /bin/sh from another directory', () => {
  const startScript = path.join(ROOT_DIR, 'start.sh');
  assert.match(fs.readFileSync(startScript, 'utf8'), /^#!\/bin\/sh\n/);
  assert.notEqual(fs.statSync(startScript).mode & 0o111, 0);
  const result = spawnSync('/bin/sh', [startScript], {
    cwd: tempDir,
    env: {
      ...process.env,
      PORT: 'not-a-port',
      CODEX_DESK_DATA_DIR: path.join(tempDir, 'start-script-data'),
      CODEX_DESK_RUNTIME_DIR: path.join(tempDir, 'start-script-runtime'),
      CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
      SOURCE_CODEX_HOME: sourceCodexHome,
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /bad substitution/i);
  assert.match(`${result.stdout}\n${result.stderr}`, /PORT must be an integer/);
});

test('API reference lists every public task management route', () => {
  const apiReference = fs.readFileSync(path.join(ROOT_DIR, 'docs', 'API.md'), 'utf8');
  const routes = [
    'GET /api/sessions',
    'POST /api/sessions',
    'POST /api/sessions/start',
    'GET /api/sessions/:id',
    'PUT /api/sessions/:id',
    'DELETE /api/sessions/:id',
    'POST /api/sessions/:id/run',
    'POST /api/sessions/:id/stop',
    'POST /api/sessions/:id/complete',
    'POST /api/sessions/:id/restore',
    'POST /api/sessions/:id/reset',
    'GET /api/sessions/:id/turns',
    'GET /api/sessions/:id/steps',
    'GET /api/sessions/:id/attempts',
    'GET /api/sessions/:id/attempts/:attemptId/:stream',
    'GET /api/sessions/:id/external-attempts/:attemptId/log',
    'GET|HEAD /api/sessions/:id/external-attempts/:attemptId/artifacts/:artifactKey',
    'GET|HEAD /api/sessions/:id/external-attempts/:attemptId/artifacts/:artifactKey/resources/:resourcePath',
    'GET /api/sessions/:id/executions',
    'GET /api/sessions/:id/skill-invocations',
    'PUT /api/sessions/:id/executions/:executionId/skills',
    'GET /api/sessions/:id/skill-usage',
    'GET /api/sessions/:id/skill-reports',
    'GET /api/sessions/:id/worklogs',
    'GET /api/sessions/:id/latest-log',
    'GET /api/runtime/bridge-sessions',
    'POST /api/runtime/bridge-sessions/:sessionId/reclaim',
  ];
  for (const route of routes) assert.ok(apiReference.includes(route), `Missing API documentation for ${route}`);
  assert.match(apiReference, /GET \/api\/ready/);
  assert.match(apiReference, /curl -fsS/);
  assert.match(apiReference, /Idempotency-Key/);
});

test('Bridge Session inventory API is read-only and reclaim requires an exact body confirmation', async () => {
  const inventory = await request('/api/runtime/bridge-sessions');
  assert.equal(inventory.response.status, 200);
  assert.equal(typeof inventory.payload.summary.total, 'number');
  assert.equal(Array.isArray(inventory.payload.sessions), true);

  for (const body of [
    {},
    { confirmationSessionId: 'session-0123456789abcdef', extra: true },
    { confirmationSessionId: 123 },
  ]) {
    const invalid = await request('/api/runtime/bridge-sessions/session-0123456789abcdef/reclaim', {
      method: 'POST', body,
    });
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.payload.error, /only confirmationSessionId/);
  }

  const mismatch = await request('/api/runtime/bridge-sessions/session-0123456789abcdef/reclaim', {
    method: 'POST', body: { confirmationSessionId: 'session-fedcba9876543210' },
  });
  assert.equal(mismatch.response.status, 400);
  assert.match(mismatch.payload.error, /exact confirmationSessionId/);

  const missing = await request('/api/runtime/bridge-sessions/session-0123456789abcdef/reclaim', {
    method: 'POST', body: { confirmationSessionId: 'session-0123456789abcdef' },
  });
  assert.equal(missing.response.status, 404);
});

test('legacy finished sessions migrate to completed immutable history', async () => {
  const migrated = await request('/api/sessions/legacy-finished');
  assert.equal(migrated.response.status, 200);
  assert.equal(migrated.payload.status, 'completed');
  assert.equal(migrated.payload.persistentSessionKey, 'single:legacy-finished');
  const rerun = await request('/api/sessions/legacy-finished/run', { method: 'POST', body: {} });
  assert.equal(rerun.response.status, 409);
});

test('the control plane stays available when the session executor is unavailable', async () => {
  const isolatedPort = port + 1;
  const isolatedRoot = path.join(tempDir, 'unavailable');
  const child = spawnServer({
    port: isolatedPort,
    runner: path.join(tempDir, 'missing-runner.py'),
    dataDir: path.join(isolatedRoot, 'data'),
    runtimeDir: path.join(isolatedRoot, 'runtime'),
    workspaceRoot,
    argsFile: path.join(isolatedRoot, 'args.ndjson'),
  });
  const root = `http://127.0.0.1:${isolatedPort}`;
  try {
    const health = await waitFor(async () => {
      try {
        const result = await request('/api/health', {}, root);
        return result.response.ok && result.payload;
      } catch {
        return null;
      }
    });
    assert.equal(health.ok, true);
    assert.equal(health.ready, false);
    assert.equal(health.runtime.bridgeAvailable, false);
    assert.equal(health.runtime.ready, false);
    assert.ok(health.runtime.degradedReasons.includes('executor_unavailable'));
    assert.equal((await request('/api/ready', {}, root)).response.status, 503);
    const atomic = await request('/api/sessions/start', {
      method: 'POST',
      body: {
        id: 'unavailable-atomic', name: 'Unavailable Atomic', objective: 'Must not be partially created.',
        workingDir: projectDir, idempotencyKey: 'unavailable-atomic-key',
      },
    }, root);
    assert.equal(atomic.response.status, 503);
    assert.equal((await request('/api/sessions/unavailable-atomic', {}, root)).response.status, 404);
    const created = await request('/api/sessions', {
      method: 'POST',
      body: { id: 'unavailable-task', name: 'Unavailable', objective: 'Wait for runtime.', workingDir: projectDir },
    }, root);
    assert.equal(created.response.status, 201);
    const run = await request('/api/sessions/unavailable-task/run', { method: 'POST', body: {} }, root);
    assert.equal(run.response.status, 503);

    const isolatedDb = new Database(path.join(isolatedRoot, 'data', 'codex-tasks.db'));
    const committedAt = new Date().toISOString();
    isolatedDb.transaction(() => {
      isolatedDb.prepare(`
        INSERT INTO commands(
          id, task_id, type, input, idempotency_key, status, created_at, finished_at
        ) VALUES (?, ?, 'run', ?, ?, 'completed', ?, ?)
      `).run(
        'unavailable-committed-command',
        'unavailable-task',
        'Wait for runtime.',
        'unavailable-committed-key',
        committedAt,
        committedAt,
      );
      isolatedDb.prepare(`
        UPDATE tasks SET status='waiting_review', recovery_state='completed',
          version=version+1, updated_at=? WHERE id='unavailable-task'
      `).run(committedAt);
    }).immediate();
    isolatedDb.close();

    const replay = await request('/api/sessions/unavailable-task/run', {
      method: 'POST',
      headers: { 'idempotency-key': 'unavailable-committed-key' },
      body: { input: 'Wait for runtime.' },
    }, root);
    assert.equal(replay.response.status, 202);
    assert.equal(replay.payload.status, 'waiting_review');
    const mismatchedReplay = await request('/api/sessions/unavailable-task/run', {
      method: 'POST',
      headers: { 'idempotency-key': 'unavailable-committed-key' },
      body: { input: 'Different input.' },
    }, root);
    assert.equal(mismatchedReplay.response.status, 409);
    const unavailableNewRun = await request('/api/sessions/unavailable-task/run', {
      method: 'POST',
      headers: { 'idempotency-key': 'unavailable-new-key' },
      body: { input: 'Wait for runtime.' },
    }, root);
    assert.equal(unavailableNewRun.response.status, 503);
    const verifyDb = new Database(path.join(isolatedRoot, 'data', 'codex-tasks.db'), { readonly: true });
    assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM commands WHERE task_id='unavailable-task'").get().count, 1);
    verifyDb.close();
  } finally {
    await stopServer(child);
  }
});

test('low storage capacity pauses queued work until execution readiness recovers', async () => {
  const isolatedPort = port + 7;
  const isolatedRoot = path.join(tempDir, 'low-storage-capacity');
  const isolatedData = path.join(isolatedRoot, 'data');
  const isolatedRuntime = path.join(isolatedRoot, 'runtime');
  const root = `http://127.0.0.1:${isolatedPort}`;
  const prepare = spawnSync(process.execPath, ['-e', [
    "const store = require('./src/store');",
    "store.ensureStorage();",
    `store.saveSession('capacity-queued-task', { name: 'Capacity Queued Task', objective: 'Run after capacity recovers.', workingDir: ${JSON.stringify(projectDir)} });`,
    "store.queueSessionRun('capacity-queued-task', 'Run after capacity recovers.', 'capacity-prequeued');",
    "require('./src/database').closeDatabase();",
  ].join('\n')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CODEX_DESK_DATA_DIR: isolatedData,
      CODEX_DESK_RUNTIME_DIR: isolatedRuntime,
      CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
      SOURCE_CODEX_HOME: sourceCodexHome,
      WORKSPACE_CODEX_SKILLS_DIR: workspaceCodexSkills,
    },
    encoding: 'utf8',
  });
  assert.equal(prepare.status, 0, prepare.stderr);

  let child = spawnServer({
    port: isolatedPort,
    dataDir: isolatedData,
    runtimeDir: isolatedRuntime,
    workspaceRoot,
    argsFile: path.join(isolatedRoot, 'args.ndjson'),
    minFreeBytes: Number.MAX_SAFE_INTEGER,
  });
  try {
    const health = await waitFor(async () => {
      try {
        const result = await request('/api/health', {}, root);
        return result.response.ok && result.payload.runtime.workerAvailable ? result.payload : null;
      } catch {
        return null;
      }
    });
    assert.equal(health.ok, true);
    assert.equal(health.ready, false);
    assert.equal(health.runtime.storageCapacity.ok, false);
    assert.ok(health.runtime.storageCapacity.low > 0);
    assert.equal(health.runtime.storageCapacity.minimumFreeBytes, Number.MAX_SAFE_INTEGER);
    assert.ok(health.runtime.storageCapacity.targets.every((target) => !('path' in target)));
    assert.ok(health.runtime.degradedReasons.includes('storage_capacity_low'));
    assert.equal((await request('/api/ready', {}, root)).response.status, 503);

    assert.equal((await request('/api/sessions', {
      method: 'POST',
      body: {
        id: 'capacity-blocked-task', name: 'Capacity Blocked Task',
        objective: 'Do not queue while storage is low.', workingDir: projectDir,
      },
    }, root)).response.status, 201);
    const blockedRun = await request('/api/sessions/capacity-blocked-task/run', {
      method: 'POST', body: {},
    }, root);
    assert.equal(blockedRun.response.status, 503);
    assert.ok(blockedRun.payload.degradedReasons.includes('storage_capacity_low'));

    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal((await request('/api/sessions/capacity-queued-task', {}, root)).payload.status, 'queued');
    assert.equal((await request('/api/sessions/capacity-blocked-task', {}, root)).payload.status, 'idle');
    const db = new Database(path.join(isolatedData, 'codex-tasks.db'));
    assert.equal(db.prepare("SELECT status FROM commands WHERE task_id='capacity-queued-task'").get().status, 'pending');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM attempts WHERE task_id='capacity-queued-task'").get().count, 0);
    db.close();

    await stopServer(child);
    child = spawnServer({
      port: isolatedPort,
      dataDir: isolatedData,
      runtimeDir: isolatedRuntime,
      workspaceRoot,
      argsFile: path.join(isolatedRoot, 'args.ndjson'),
    });
    await waitFor(async () => {
      try { return (await request('/api/ready', {}, root)).response.ok; } catch { return false; }
    });
    await waitFor(async () => (
      (await request('/api/sessions/capacity-queued-task', {}, root)).payload.status === 'waiting_review'
    ));
    assert.equal((await request('/api/sessions/capacity-blocked-task', {}, root)).payload.status, 'idle');
    assert.equal((await request('/api/sessions/capacity-queued-task/attempts', {}, root)).payload[0].status, 'completed');
  } finally {
    if (child.exitCode == null) await stopServer(child);
  }
});

test('a fresh heartbeat from an unrelated or reused PID is not accepted as the worker', async () => {
  const isolatedPort = port + 11;
  const isolatedRoot = path.join(tempDir, 'forged-worker-heartbeat');
  const root = `http://127.0.0.1:${isolatedPort}`;
  const isolatedData = path.join(isolatedRoot, 'data');
  const child = spawnServer({
    port: isolatedPort,
    dataDir: isolatedData,
    runtimeDir: path.join(isolatedRoot, 'runtime'),
    workspaceRoot,
    argsFile: path.join(isolatedRoot, 'args.ndjson'),
    disableWorker: true,
  });
  try {
    await waitFor(async () => {
      try { return (await request('/api/health', {}, root)).response.status === 200; } catch { return false; }
    });
    const identity = inspectProcess(process.pid);
    assert.ok(identity);
    const db = new Database(path.join(isolatedData, 'codex-tasks.db'));
    db.prepare(`
      INSERT INTO metadata(key, value) VALUES ('worker_heartbeat', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(JSON.stringify({
      workerId: 'forged-worker', pid: identity.pid, processIdentity: identity,
      ts: new Date().toISOString(), active: 0, maxConcurrency: 4,
    }));
    db.close();
    const health = (await request('/api/health', {}, root)).payload;
    assert.equal(health.ok, true);
    assert.equal(health.ready, false);
    assert.equal(health.runtime.workerAvailable, false);
    assert.equal(health.runtime.workerProcessVerified, false);
    assert.ok(health.runtime.workerHeartbeatAgeMs < 10000);
    assert.ok(health.runtime.degradedReasons.includes('worker_unavailable'));
    assert.equal((await request('/api/ready', {}, root)).response.status, 503);
  } finally {
    await stopServer(child);
  }
});

test('root execution stays disabled unless the deployment explicitly overrides it', {
  skip: typeof process.getuid !== 'function' || process.getuid() !== 0,
}, async () => {
  const isolatedPort = port + 6;
  const isolatedRoot = path.join(tempDir, 'root-execution-disabled');
  const root = `http://127.0.0.1:${isolatedPort}`;
  const child = spawnServer({
    port: isolatedPort,
    dataDir: path.join(isolatedRoot, 'data'),
    runtimeDir: path.join(isolatedRoot, 'runtime'),
    workspaceRoot,
    argsFile: path.join(isolatedRoot, 'args.ndjson'),
    allowRootExecution: false,
  });
  try {
    const health = await waitFor(async () => {
      try {
        const result = await request('/api/health', {}, root);
        return result.payload.runtime.workerAvailable ? result.payload : null;
      } catch {
        return null;
      }
    });
    assert.equal(health.ok, true);
    assert.equal(health.runtime.executionUserSafe, false);
    assert.equal(health.runtime.rootExecutionOverride, false);

    const created = await request('/api/sessions', {
      method: 'POST',
      body: {
        id: 'root-execution-disabled',
        name: 'Root Execution Disabled',
        objective: 'Verify the production execution guard.',
        workingDir: projectDir,
      },
    }, root);
    assert.equal(created.response.status, 201);
    const run = await request('/api/sessions/root-execution-disabled/run', {
      method: 'POST', body: { input: 'Must not execute.' },
    }, root);
    assert.equal(run.response.status, 503);
    assert.equal((await request('/api/sessions/root-execution-disabled', {}, root)).payload.status, 'idle');
  } finally {
    await stopServer(child);
  }
});

test('authentication and same-origin checks protect remote-capable deployments', async () => {
  const remotePort = port + 2;
  const authRoot = path.join(tempDir, 'auth');
  const child = spawnServer({
    port: remotePort,
    dataDir: path.join(authRoot, 'data'),
    runtimeDir: path.join(authRoot, 'runtime'),
    workspaceRoot,
    authUser: 'operator',
    authPassword: 'strong-test-password',
  });
  const root = `http://127.0.0.1:${remotePort}`;
  const authorization = `Basic ${Buffer.from('operator:strong-test-password').toString('base64')}`;
  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`${root}/api/health`);
        return response.status === 401;
      } catch {
        return false;
      }
    });
    const unauthorized = await request('/api/health', {}, root);
    assert.equal(unauthorized.response.status, 401);
    const unauthenticatedSession = await fetch(`${root}/api/auth/session`);
    assert.equal(unauthenticatedSession.status, 200);
    assert.deepEqual(await unauthenticatedSession.json(), { ok: false });
    const authorized = await waitFor(async () => {
      const result = await request('/api/health', { headers: { authorization } }, root);
      return result.payload.runtime.workerAvailable ? result : null;
    });
    assert.equal(authorized.response.status, 200);

    const login = await fetch(`${root}/api/auth/session`, {
      method: 'POST',
      headers: { authorization },
    });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie') || '', /codex_task_session=[^;]+/);
    assert.match(login.headers.get('set-cookie') || '', /HttpOnly/);
    assert.match(login.headers.get('set-cookie') || '', /SameSite=Strict/);
    const sessionCookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
    const cookieAuthorized = await fetch(`${root}/api/health`, {
      headers: { cookie: sessionCookie },
    });
    assert.equal(cookieAuthorized.status, 200);
    const sessionStatus = await fetch(`${root}/api/auth/session`, {
      headers: { cookie: sessionCookie },
    });
    assert.deepEqual(await sessionStatus.json(), { ok: true });

    const logout = await fetch(`${root}/api/auth/session`, {
      method: 'DELETE',
      headers: { cookie: sessionCookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') || '', /codex_task_session=;/);
    const unauthenticatedAfterLogout = await fetch(`${root}/api/health`);
    assert.equal(unauthenticatedAfterLogout.status, 401);

    const authCreated = await request('/api/sessions', {
      method: 'POST',
      headers: { authorization, 'x-request-id': 'authenticated-create' },
      body: { id: 'authenticated-task', name: 'Authenticated Task', objective: 'Verify execution isolation.', workingDir: projectDir },
    }, root);
    assert.equal(authCreated.response.status, 201);
    assert.equal((await request('/api/sessions/authenticated-task/run', {
      method: 'POST', headers: { authorization }, body: { input: 'Verify execution isolation.' },
    }, root)).response.status, 202);
    await waitFor(async () => {
      const task = await request('/api/sessions/authenticated-task', { headers: { authorization } }, root);
      return task.payload.status === 'waiting_review';
    });
    const authAudit = await request('/api/audit?sessionId=authenticated-task', { headers: { authorization } }, root);
    const authCreateEvent = authAudit.payload.find((event) => event.kind === 'session.created');
    assert.equal(authCreateEvent.actor, 'user:operator');
    assert.equal(authCreateEvent.requestId, 'authenticated-create');
    const crossOrigin = await request('/api/runtime/sync', {
      method: 'POST',
      headers: { authorization, origin: 'https://example.invalid' },
    }, root);
    assert.equal(crossOrigin.response.status, 403);
    assert.equal(authorized.response.headers.get('x-frame-options'), 'SAMEORIGIN');
  } finally {
    await stopServer(child);
  }

  const refused = spawnServer({
    port: port + 3,
    host: '0.0.0.0',
    dataDir: path.join(tempDir, 'remote-refused', 'data'),
    runtimeDir: path.join(tempDir, 'remote-refused', 'runtime'),
    workspaceRoot,
  });
  const exitCode = await new Promise((resolve) => refused.once('exit', resolve));
  assert.notEqual(exitCode, 0);

  const partialAuth = spawnServer({
    port: port + 3,
    dataDir: path.join(tempDir, 'partial-auth-refused', 'data'),
    runtimeDir: path.join(tempDir, 'partial-auth-refused', 'runtime'),
    workspaceRoot,
    authUser: 'operator',
  });
  const partialAuthExit = await new Promise((resolve) => partialAuth.once('exit', resolve));
  assert.notEqual(partialAuthExit, 0);

  const invalidLogStreamConcurrency = spawnServer({
    port: port + 3,
    dataDir: path.join(tempDir, 'invalid-log-stream-concurrency-refused', 'data'),
    runtimeDir: path.join(tempDir, 'invalid-log-stream-concurrency-refused', 'runtime'),
    workspaceRoot,
    logStreamMaxConcurrency: 0,
  });
  const invalidLogStreamConcurrencyExit = await new Promise(
    (resolve) => invalidLogStreamConcurrency.once('exit', resolve),
  );
  assert.notEqual(invalidLogStreamConcurrencyExit, 0);

  const invalidApiConcurrency = spawnServer({
    port: port + 3,
    dataDir: path.join(tempDir, 'invalid-api-concurrency-refused', 'data'),
    runtimeDir: path.join(tempDir, 'invalid-api-concurrency-refused', 'runtime'),
    workspaceRoot,
    apiMaxConcurrency: 257,
  });
  const invalidApiConcurrencyExit = await new Promise(
    (resolve) => invalidApiConcurrency.once('exit', resolve),
  );
  assert.notEqual(invalidApiConcurrencyExit, 0);

  const invalidApiResponseIdleTimeout = spawnServer({
    port: port + 3,
    dataDir: path.join(tempDir, 'invalid-api-timeout-refused', 'data'),
    runtimeDir: path.join(tempDir, 'invalid-api-timeout-refused', 'runtime'),
    workspaceRoot,
    apiIdleTimeoutMs: 999,
  });
  const invalidApiResponseIdleTimeoutExit = await new Promise(
    (resolve) => invalidApiResponseIdleTimeout.once('exit', resolve),
  );
  assert.notEqual(invalidApiResponseIdleTimeoutExit, 0);

  const invalidLogStreamIdleTimeout = spawnServer({
    port: port + 3,
    dataDir: path.join(tempDir, 'invalid-log-stream-timeout-refused', 'data'),
    runtimeDir: path.join(tempDir, 'invalid-log-stream-timeout-refused', 'runtime'),
    workspaceRoot,
    logStreamIdleTimeoutMs: 999,
  });
  const invalidLogStreamIdleTimeoutExit = await new Promise(
    (resolve) => invalidLogStreamIdleTimeout.once('exit', resolve),
  );
  assert.notEqual(invalidLogStreamIdleTimeoutExit, 0);
});

test('workspace roots allow their own directories and reject symlink escapes', async () => {
  const broadRootResolution = spawnSync(process.execPath, [
    '-e',
    "process.stdout.write(require('./src/workspaces').resolveWorkingDir(process.argv[1]))",
    ROOT_DIR,
  ], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CODEX_TASK_WORKSPACE_ROOTS: path.dirname(ROOT_DIR),
      CODEX_DESK_DATA_DIR: path.join(tempDir, 'broad-root-data'),
      CODEX_DESK_RUNTIME_DIR: path.join(tempDir, 'broad-root-runtime'),
    },
    encoding: 'utf8',
  });
  assert.equal(broadRootResolution.status, 0, broadRootResolution.stderr);
  assert.equal(broadRootResolution.stdout, fs.realpathSync(ROOT_DIR));

  const platform = await request('/api/sessions', {
    method: 'POST',
    body: { id: 'platform-root', name: 'Platform Root', objective: 'Must pass.', workingDir: workspaceRoot },
  });
  assert.equal(platform.response.status, 201);
  assert.equal(platform.payload.workingDir, fs.realpathSync(workspaceRoot));

  const escapePath = path.join(workspaceRoot, 'escape');
  fs.symlinkSync(outsideDir, escapePath, 'dir');
  const escaped = await request('/api/sessions', {
    method: 'POST',
    body: { id: 'escaped-root', name: 'Escaped Root', objective: 'Must fail.', workingDir: escapePath },
  });
  assert.equal(escaped.response.status, 400);
  assert.match(escaped.payload.error, /outside the configured/i);
  assert.equal((await request('/api/sessions/platform-root', { method: 'DELETE' })).response.status, 200);
});

test('imports are rejected while a task is active and stop remains recoverable', async () => {
  const created = await request('/api/sessions', {
    method: 'POST',
    body: { id: 'slow-task', name: 'Slow Task', objective: 'SLOW_TASK', workingDir: projectDir },
  });
  assert.equal(created.response.status, 201);
  await request('/api/sessions/slow-task/run', {
    method: 'POST', headers: { 'idempotency-key': 'slow-task-run' }, body: { input: 'SLOW_TASK' },
  });
  await waitFor(async () => (await request('/api/sessions/slow-task')).payload.status === 'running');

  const idempotent = await request('/api/sessions/slow-task/run', {
    method: 'POST', headers: { 'idempotency-key': 'slow-task-run' }, body: { input: 'SLOW_TASK' },
  });
  assert.equal(idempotent.response.status, 202);
  const mismatchedIdempotent = await request('/api/sessions/slow-task/run', {
    method: 'POST', headers: { 'idempotency-key': 'slow-task-run' }, body: { input: 'DIFFERENT_TASK' },
  });
  assert.equal(mismatchedIdempotent.response.status, 409);
  assert.match(mismatchedIdempotent.payload.error, /does not match the original run request/i);
  const conflictingRun = await request('/api/sessions/slow-task/run', {
    method: 'POST', headers: { 'idempotency-key': 'slow-task-run-2' }, body: { input: 'SLOW_TASK' },
  });
  assert.equal(conflictingRun.response.status, 409);

  const imported = await request('/api/import', {
    method: 'POST',
    body: { bundle: { format: 'codex-ops-bundle', version: 3, skills: [], sessions: [] }, mode: 'merge' },
  });
  assert.equal(imported.response.status, 409);

  const stopped = await request('/api/sessions/slow-task/stop', { method: 'POST' });
  assert.equal(stopped.payload.ok, true);
  const final = await waitFor(async () => {
    const result = await request('/api/sessions/slow-task');
    return result.payload.status === 'stopped' ? result.payload : null;
  });
  assert.ok(final.persistentSessionKey);
});

test('configuration imports validate before an atomic transaction', async () => {
  const before = await request('/api/sessions/verify-task');
  assert.equal(before.response.status, 200);
  const invalid = await request('/api/import', {
    method: 'POST',
    body: {
      mode: 'replace',
      bundle: {
        format: 'codex-ops-bundle',
        version: 3,
        skills: [{ id: 'invalid-without-name' }],
        sessions: [],
      },
    },
  });
  assert.equal(invalid.response.status, 400);
  const after = await request('/api/sessions/verify-task');
  assert.equal(after.response.status, 200);

  const invalidTask = await request('/api/import', {
    method: 'POST',
    body: {
      mode: 'merge',
      bundle: {
        format: 'codex-ops-bundle', version: 3, skills: [],
        sessions: [{ id: 'bad-import', name: 'Bad Import', objective: 'Bad type.', workingDir: projectDir, autoResume: 'yes' }],
      },
    },
  });
  assert.equal(invalidTask.response.status, 400);

  const invalidSkillFields = await request('/api/import', {
    method: 'POST',
    body: {
      mode: 'merge',
      bundle: {
        format: 'codex-ops-bundle', version: 3,
        skills: [{ id: 'bad-skill-content', name: 'Bad Skill', content: { markdown: '# Invalid' } }],
        sessions: [],
      },
    },
  });
  assert.equal(invalidSkillFields.response.status, 400);

  const invalidCollections = await request('/api/import', {
    method: 'POST',
    body: { bundle: { format: 'codex-ops-bundle', version: 3, skills: {}, sessions: [] }, mode: 'merge' },
  });
  assert.equal(invalidCollections.response.status, 400);

  const stringVersion = await request('/api/import', {
    method: 'POST',
    body: { bundle: { format: 'codex-ops-bundle', version: '3', skills: [], sessions: [] }, mode: 'merge' },
  });
  assert.equal(stringVersion.response.status, 400);

  const merged = await request('/api/import', {
    method: 'POST',
    body: {
      mode: 'merge',
      bundle: {
        format: 'codex-ops-bundle',
        version: 3,
        skills: [{ id: 'imported-skill', name: 'Imported Skill', content: '# Imported' }],
        sessions: [],
      },
    },
  });
  assert.equal(merged.response.status, 200);
  assert.equal(merged.payload.ok, true);
  assert.equal(merged.payload.runtimeSync.ok, true);
  assert.equal((await request('/api/skills/imported-skill')).payload.version, 1);
});

test('expired processing command claims are recovered exactly once', () => {
  const isolatedRoot = path.join(tempDir, 'stale-command');
  const result = spawnSync(process.execPath, ['-e', [
    "const store = require('./src/store');",
    "const { getDatabase } = require('./src/database');",
    "store.ensureStorage();",
    "store.saveSession('stale-command-task', { name: 'Stale Command', objective: 'Recover claim.', workingDir: '.' });",
    "store.queueSessionRun('stale-command-task', 'Recover claim.', 'stale-command-key');",
    "const first = store.claimPendingCommands('dead-worker', 1);",
    "getDatabase().prepare(\"UPDATE commands SET claim_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?\").run(first[0].id);",
    "const recovered = store.claimPendingCommands('live-worker', 1);",
    "const duplicate = store.claimPendingCommands('other-worker', 1);",
    "console.log(JSON.stringify({ first, recovered, duplicate }));",
  ].join('\n')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CODEX_DESK_DATA_DIR: path.join(isolatedRoot, 'data'),
      CODEX_DESK_RUNTIME_DIR: path.join(isolatedRoot, 'runtime'),
      CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
      SOURCE_CODEX_HOME: sourceCodexHome,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.first.length, 1);
  assert.equal(payload.recovered.length, 1);
  assert.equal(payload.recovered[0].id, payload.first[0].id);
  assert.equal(payload.recovered[0].worker_id, 'live-worker');
  assert.deepEqual(payload.duplicate, []);
});

test('worker starts all runnable tasks without concurrency or working-directory limits', async () => {
  const isolatedPort = port + 4;
  const isolatedRoot = path.join(tempDir, 'concurrency');
  const root = `http://127.0.0.1:${isolatedPort}`;
  const child = spawnServer({
    port: isolatedPort,
    dataDir: path.join(isolatedRoot, 'data'),
    runtimeDir: path.join(isolatedRoot, 'runtime'),
    argsFile: path.join(isolatedRoot, 'runner-args.ndjson'),
    workspaceRoot,
  });
  fs.mkdirSync(isolatedRoot, { recursive: true });
  try {
    const health = await waitFor(async () => {
      try {
        const result = await request('/api/health', {}, root);
        return result.payload.runtime.workerAvailable ? result.payload : null;
      } catch {
        return null;
      }
    });
    assert.equal(health.runtime.workerMaxConcurrency, 0);
    for (let index = 1; index <= 3; index += 1) {
      const id = `concurrency-${index}`;
      assert.equal((await request('/api/sessions', {
        method: 'POST',
        body: { id, name: id, objective: 'SLOW_TASK', workingDir: projectDir },
      }, root)).response.status, 201);
      assert.equal((await request(`/api/sessions/${id}/run`, { method: 'POST', body: { input: 'SLOW_TASK' } }, root)).response.status, 202);
    }
    await waitFor(async () => {
      const sessions = (await request('/api/sessions?limit=10', {}, root)).payload;
      return sessions.length === 3 && sessions.every((session) => session.status === 'running');
    });
    const capacity = (await request('/api/health', {}, root)).payload.runtime;
    assert.equal(capacity.workerActive, 3);
    assert.equal(capacity.workerMaxConcurrency, 0);
    for (let index = 1; index <= 3; index += 1) {
      await request(`/api/sessions/concurrency-${index}/stop`, { method: 'POST' }, root);
    }
    await waitFor(async () => {
      const sessions = (await request('/api/sessions?limit=10', {}, root)).payload;
      return sessions.length === 3 && sessions.every((session) => session.status === 'stopped');
    });
  } finally {
    await stopServer(child);
  }
});

test('the supervisor kills execution process groups when a worker is force-terminated', async () => {
  const isolatedPort = port + 10;
  const isolatedRoot = path.join(tempDir, 'worker-crash-cleanup');
  const root = `http://127.0.0.1:${isolatedPort}`;
  const child = spawnServer({
    port: isolatedPort,
    dataDir: path.join(isolatedRoot, 'data'),
    runtimeDir: path.join(isolatedRoot, 'runtime'),
    argsFile: path.join(isolatedRoot, 'runner-args.ndjson'),
    workspaceRoot,
  });
  let executionPid;
  let workerPid;
  try {
    await waitFor(async () => {
      try {
        return (await request('/api/health', {}, root)).payload.runtime.workerAvailable;
      } catch {
        return false;
      }
    });
    await request('/api/sessions', {
      method: 'POST',
      body: {
        id: 'worker-crash-task', name: 'Worker Crash Task', objective: 'SLOW_TASK',
        workingDir: projectDir, autoResume: false,
      },
    }, root);
    await request('/api/sessions/worker-crash-task/run', {
      method: 'POST', body: { input: 'SLOW_TASK' },
    }, root);
    executionPid = await waitFor(async () => {
      const task = (await request('/api/sessions/worker-crash-task', {}, root)).payload;
      return task.status === 'running' && task.currentPid ? task.currentPid : null;
    });
    workerPid = await waitFor(() => {
      try {
        const children = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim();
        return children ? Number(children.split(/\s+/)[0]) : null;
      } catch {
        return null;
      }
    });
    process.kill(workerPid, 'SIGKILL');
    await waitFor(() => !processIsRunning(executionPid), 4000);
    await waitFor(async () => {
      try {
        const health = (await request('/api/health', {}, root)).payload;
        return health.runtime.workerAvailable;
      } catch {
        return false;
      }
    }, 5000);
  } finally {
    if (child.exitCode == null) await stopServer(child);
    if (executionPid) {
      try { process.kill(-executionPid, 'SIGKILL'); } catch {}
    }
    if (workerPid) {
      try { process.kill(workerPid, 'SIGKILL'); } catch {}
    }
  }
});

test('normal session completion terminates non-detached residual process-group children', async () => {
  const pidFile = path.join(projectDir, 'lingering-child.pid');
  let residualPid;
  try { fs.unlinkSync(pidFile); } catch {}
  try {
    await request('/api/sessions', {
      method: 'POST',
      body: {
        id: 'residual-process-task', name: 'Residual Process Task', objective: 'LINGERING_CHILD',
        workingDir: projectDir, autoResume: false,
      },
    });
    await request('/api/sessions/residual-process-task/run', {
      method: 'POST', body: { input: 'LINGERING_CHILD' },
    });
    residualPid = await waitFor(() => {
      try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) || null; } catch { return null; }
    });
    await waitFor(async () => (await request('/api/sessions/residual-process-task')).payload.status === 'waiting_review');
    await waitFor(() => !processIsRunning(residualPid), 3000);
    const worklogs = await request('/api/sessions/residual-process-task/worklogs');
    assert.ok(worklogs.payload.some((event) => event.kind === 'session.runtime.residual_processes.terminated'));
  } finally {
    if (residualPid && processIsRunning(residualPid)) {
      try { process.kill(residualPid, 'SIGKILL'); } catch {}
    }
  }
});

test('service shutdown force-terminates execution processes that ignore SIGTERM', async () => {
  const isolatedPort = port + 5;
  const isolatedRoot = path.join(tempDir, 'shutdown');
  const root = `http://127.0.0.1:${isolatedPort}`;
  const child = spawnServer({
    port: isolatedPort,
    dataDir: path.join(isolatedRoot, 'data'),
    runtimeDir: path.join(isolatedRoot, 'runtime'),
    argsFile: path.join(isolatedRoot, 'runner-args.ndjson'),
    workspaceRoot,
  });
  let executionPid;
  try {
    await waitFor(async () => {
      try {
        return (await request('/api/health', {}, root)).payload.runtime.workerAvailable;
      } catch {
        return false;
      }
    });
    await request('/api/sessions', {
      method: 'POST',
      body: { id: 'shutdown-task', name: 'Shutdown Task', objective: 'IGNORE_TERM SLOW_TASK', workingDir: projectDir },
    }, root);
    await request('/api/sessions/shutdown-task/run', {
      method: 'POST', body: { input: 'IGNORE_TERM SLOW_TASK' },
    }, root);
    executionPid = await waitFor(async () => {
      const task = (await request('/api/sessions/shutdown-task', {}, root)).payload;
      return task.status === 'running' && task.currentPid ? task.currentPid : null;
    });
    await stopServer(child);
    await waitFor(() => !processIsRunning(executionPid), 3000);
    const db = new Database(path.join(isolatedRoot, 'data', 'codex-tasks.db'));
    assert.equal(db.prepare("SELECT status FROM tasks WHERE id='shutdown-task'").get().status, 'interrupted');
    assert.equal(db.prepare("SELECT status FROM attempts WHERE task_id='shutdown-task'").get().status, 'interrupted');
    db.close();
  } finally {
    if (child.exitCode == null) await stopServer(child);
    if (executionPid) {
      try { process.kill(-executionPid, 'SIGKILL'); } catch {}
    }
  }
});

test('an operator stop wins even when the execution process exits with code zero', async () => {
  await request('/api/sessions', {
    method: 'POST',
    body: {
      id: 'zero-exit-stop', name: 'Zero Exit Stop',
      objective: 'EXIT_ZERO_ON_INTERRUPT SLOW_TASK', workingDir: projectDir,
    },
  });
  await request('/api/sessions/zero-exit-stop/run', {
    method: 'POST', body: { input: 'EXIT_ZERO_ON_INTERRUPT SLOW_TASK' },
  });
  await waitFor(async () => (await request('/api/sessions/zero-exit-stop')).payload.status === 'running');
  assert.equal((await request('/api/sessions/zero-exit-stop/stop', { method: 'POST' })).payload.ok, true);
  const stopped = await waitFor(async () => {
    const task = (await request('/api/sessions/zero-exit-stop')).payload;
    return task.status === 'stopped' ? task : null;
  });
  assert.equal(stopped.status, 'stopped');
  assert.equal((await request('/api/sessions/zero-exit-stop/turns')).payload[0].status, 'stopped');
  assert.equal((await request('/api/sessions/zero-exit-stop/attempts')).payload[0].status, 'cancelled');
});

test('stopping during retry backoff finalizes the prepared attempt and turn', async () => {
  await request('/api/sessions', {
    method: 'POST',
    body: {
      id: 'retry-backoff-stop', name: 'Retry Backoff Stop', objective: 'TRANSIENT_RETRY',
      workingDir: projectDir, maxRetries: 2,
    },
  });
  await request('/api/sessions/retry-backoff-stop/run', {
    method: 'POST', body: { input: 'TRANSIENT_RETRY' },
  });
  await waitFor(async () => (await request('/api/sessions/retry-backoff-stop')).payload.recoveryState === 'retry_scheduled');
  assert.equal((await request('/api/sessions/retry-backoff-stop/stop', { method: 'POST' })).payload.ok, true);
  const stopped = await waitFor(async () => {
    const task = (await request('/api/sessions/retry-backoff-stop')).payload;
    return task.status === 'stopped' ? task : null;
  });
  assert.equal(stopped.status, 'stopped');
  assert.equal((await request('/api/sessions/retry-backoff-stop/turns')).payload[0].status, 'stopped');
  const attempts = (await request('/api/sessions/retry-backoff-stop/attempts')).payload;
  assert.deepEqual(attempts.map((attempt) => attempt.status), ['cancelled', 'failed']);
  assert.equal(attempts[0].pid, null);
});

test('deleting a reviewable task removes logs, command executions, and skill snapshots', async () => {
  await request('/api/sessions', {
    method: 'POST',
    body: { id: 'delete-audit-task', name: 'Delete Audit Task', objective: 'SKILL_ATTRIBUTION', workingDir: projectDir },
  });
  await request('/api/sessions/delete-audit-task/run', { method: 'POST', body: { input: 'SKILL_ATTRIBUTION' } });
  await waitFor(async () => (await request('/api/sessions/delete-audit-task')).payload.status === 'waiting_review');
  const sessionFiles = path.join(dataDir, 'sessions', 'delete-audit-task');
  const snapshotFiles = path.join(runtimeDir, 'skill-snapshots', 'delete-audit-task');
  assert.equal(fs.existsSync(sessionFiles), true);
  assert.equal(fs.existsSync(snapshotFiles), true);
  assert.equal((await request('/api/sessions/delete-audit-task', { method: 'DELETE' })).response.status, 200);
  assert.equal(fs.existsSync(sessionFiles), false);
  assert.equal(fs.existsSync(snapshotFiles), false);
  const db = new Database(path.join(dataDir, 'codex-tasks.db'));
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM command_executions WHERE task_id='delete-audit-task'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM command_skill_attributions WHERE task_id='delete-audit-task'").get().count, 0);
  db.close();
});

test('expired worker leases become interrupted without duplicate execution', async () => {
  await request('/api/sessions', {
    method: 'POST',
    body: { id: 'lease-task', name: 'Lease Task', objective: 'Recover lease.', workingDir: projectDir, autoResume: false },
  });
  const db = new Database(path.join(dataDir, 'codex-tasks.db'));
  db.prepare(`
    UPDATE tasks SET status='running', recovery_state='running', lease_owner='dead-worker',
      lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id='lease-task'
  `).run();
  db.close();
  const interrupted = await waitFor(async () => {
    const result = await request('/api/sessions/lease-task');
    return result.payload.status === 'interrupted' ? result.payload : null;
  }, 8000);
  assert.equal(interrupted.recoveryState, 'recoverable');
});

test('an interrupted task automatically resumes after a full service restart', async () => {
  const created = await request('/api/sessions', {
    method: 'POST',
    body: {
      id: 'restart-recovery-task',
      name: 'Restart Recovery Task',
      objective: 'Verify that an interrupted task resumes after service restart.',
      workingDir: projectDir,
      autoResume: true,
    },
  });
  assert.equal(created.response.status, 201);

  const queued = await request('/api/sessions/restart-recovery-task/run', {
    method: 'POST',
    body: { input: 'SLOW_TASK' },
  });
  assert.equal(queued.response.status, 202);
  const running = await waitFor(async () => {
    const result = await request('/api/sessions/restart-recovery-task');
    return result.payload.status === 'running' && result.payload.currentPid ? result.payload : null;
  });
  assert.ok(running.persistentSessionKey);

  await stopServer(server);
  server = spawnServer();
  await waitFor(async () => {
    try {
      const result = await request('/api/health');
      return result.response.ok && result.payload.runtime.workerAvailable;
    } catch {
      return false;
    }
  });

  const resumed = await waitFor(async () => {
    const result = await request('/api/sessions/restart-recovery-task');
    return result.payload.status === 'waiting_review' ? result.payload : null;
  }, 12000);
  assert.equal(resumed.persistentSessionKey, running.persistentSessionKey);
  assert.equal(resumed.runCount, 2);

  const turns = await request('/api/sessions/restart-recovery-task/turns');
  assert.equal(turns.payload.length, 2);
  assert.equal(turns.payload[0].status, 'completed');
  assert.equal(turns.payload[1].status, 'interrupted');

  const worklog = await request('/api/sessions/restart-recovery-task/worklogs');
  assert.ok(worklog.payload.some((event) => event.kind === 'session.interrupted'));
  assert.ok(worklog.payload.some((event) => event.kind === 'session.resume.queued'));
  assert.ok(worklog.payload.some((event) => event.kind === 'session.waiting_review'));
});

test('runtime output, raw logs, and audit storage stay bounded and indexed', async () => {
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(runtimeDir).mode & 0o777, 0o700);
  await request('/api/sessions', {
    method: 'POST',
    body: { id: 'large-structured', name: 'Large Structured Output', objective: 'LARGE_STRUCTURED_OUTPUT', workingDir: projectDir },
  });
  await request('/api/sessions/large-structured/run', { method: 'POST', body: { input: 'LARGE_STRUCTURED_OUTPUT' } });
  await waitFor(async () => (await request('/api/sessions/large-structured')).payload.status === 'waiting_review', 12000);
  const largeExecutions = await request('/api/sessions/large-structured/executions?limit=1');
  assert.equal(largeExecutions.payload.length, 1);
  assert.equal(largeExecutions.payload[0].command, auditCommand);
  assert.equal(largeExecutions.payload[0].output.length, (4 * 1024 * 1024) + 131072);

  await request('/api/sessions', {
    method: 'POST',
    body: { id: 'bounded-output', name: 'Bounded Output', objective: 'OVERSIZED_OUTPUT', workingDir: projectDir },
  });
  await request('/api/sessions/bounded-output/run', { method: 'POST', body: { input: 'OVERSIZED_OUTPUT' } });
  await waitFor(async () => (await request('/api/sessions/bounded-output')).payload.status === 'waiting_review');
  const worklog = await request('/api/sessions/bounded-output/worklogs');
  assert.ok(worklog.payload.some((event) => /output exceeded .* bytes and was truncated/i.test(event.message)));

  const latestPath = path.join(dataDir, 'sessions', 'bounded-output', 'latest.log');
  fs.writeFileSync(latestPath, 'y'.repeat((1024 * 1024) + 4096), 'utf8');
  const latest = await request('/api/sessions/bounded-output/latest-log');
  assert.ok(latest.payload.length <= 1024 * 1024);

  const db = new Database(path.join(dataDir, 'codex-tasks.db'));
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((row) => row.name);
  assert.ok(indexes.includes('idx_audit_task_ts'));
  assert.ok(indexes.includes('idx_worklog_task_sequence'));
  db.close();
});

test('skills are recursive, versioned, lightweight, and read-only at the API boundary', async () => {
  const listed = await request('/api/skills');
  assert.ok(listed.payload.some((skill) => skill.id === 'system-check' && skill.origin === 'codex'));
  assert.ok(listed.payload.some((skill) => skill.id === 'nested-parent'));
  assert.ok(listed.payload.some((skill) => skill.id === 'child'));
  assert.ok(listed.payload.some((skill) => skill.id === 'workspace-api-check'
    && skill.sourceKey === 'workspace:workspace-api-check'
    && skill.origin === 'codex'
    && skill.readOnly));
  assert.ok(listed.payload.every((skill) => !('content' in skill) && !('sourcePath' in skill)));

  const created = await request('/api/skills', {
    method: 'POST',
    body: { id: 'versioned-skill', name: 'Versioned Skill', content: '# Version 1' },
  });
  assert.equal(created.payload.version, 1);
  const duplicate = await request('/api/skills', {
    method: 'POST',
    body: { id: 'versioned-skill', name: 'Must Not Replace', content: '# Replaced' },
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal((await request('/api/skills/versioned-skill')).payload.content, '# Version 1');
  const updated = await request('/api/skills/versioned-skill', {
    method: 'PUT',
    body: { name: 'Versioned Skill', content: '# Version 2' },
  });
  assert.equal(updated.payload.version, 2);
  assert.match(updated.payload.content, /Version 2/);
  const exactContent = '\n# Exact Skill\n\nKeep surrounding whitespace.\n';
  const exact = await request('/api/skills', {
    method: 'POST', body: { id: 'exact-skill', name: 'Exact Skill', content: exactContent },
  });
  assert.equal(exact.response.status, 201);
  assert.equal((await request('/api/skills/exact-skill')).payload.content, exactContent);

  const readonlyUpdate = await request('/api/skills/system-check', {
    method: 'PUT',
    body: { name: 'Changed', content: '# Changed' },
  });
  assert.equal(readonlyUpdate.response.status, 409);
  const readonlyDelete = await request('/api/skills/system-check', { method: 'DELETE' });
  assert.equal(readonlyDelete.response.status, 409);
});

test('Skill ZIP import, enablement, overwrite, and deletion are available through the API', async () => {
  const markdown = '---\nname: api-zip-skill\ndescription: API ZIP import test.\n---\n# API ZIP Skill\n';
  const archive = await createSkillZip([
    { path: 'api-zip-skill/SKILL.md', content: markdown },
    { path: 'api-zip-skill/scripts/run.sh', content: '#!/bin/sh\nprintf ok\n', mode: 0o100755 },
  ]);
  const upload = async (zip, overwrite = false) => {
    const response = await fetch(`${baseUrl}/api/skills/import?overwrite=${overwrite}`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: zip,
    });
    return { response, payload: await response.json() };
  };

  const imported = await upload(archive);
  assert.equal(imported.response.status, 201);
  assert.equal(imported.payload.count, 1);
  const detail = await request('/api/skills/api-zip-skill');
  assert.equal(detail.payload.fileCount, 2);
  assert.equal(detail.payload.enabled, true);

  const disabled = await request('/api/skills/api-zip-skill/enabled', {
    method: 'PATCH', body: { enabled: false },
  });
  assert.equal(disabled.payload.enabled, false);
  assert.equal((await request('/api/skills/api-zip-skill')).payload.enabled, false);

  const conflict = await upload(archive);
  assert.equal(conflict.response.status, 409);
  const changedMarkdown = markdown.replace('# API ZIP Skill', '# API ZIP Skill v2');
  const changedArchive = await createSkillZip([
    { path: 'api-zip-skill/SKILL.md', content: changedMarkdown },
    { path: 'api-zip-skill/scripts/run.sh', content: '#!/bin/sh\nprintf changed\n', mode: 0o100755 },
  ]);
  const overwritten = await upload(changedArchive, true);
  assert.equal(overwritten.response.status, 201);
  assert.equal(overwritten.payload.skills[0].version, 2);

  const atomicArchive = await createSkillZip([
    { path: 'atomic-fresh/SKILL.md', content: '---\nname: atomic-fresh\ndescription: Must roll back.\n---\n# Atomic Fresh\n' },
    { path: 'versioned-skill/SKILL.md', content: '---\nname: versioned-skill\ndescription: Existing conflict.\n---\n# Conflict\n' },
  ]);
  assert.equal((await upload(atomicArchive)).response.status, 409);
  assert.equal((await request('/api/skills/atomic-fresh')).response.status, 404);

  const sourceDisabled = await request('/api/skills/system-check/enabled', {
    method: 'PATCH', body: { enabled: false },
  });
  assert.equal(sourceDisabled.payload.enabled, false);
  assert.equal((await request('/api/skills/system-check')).payload.enabled, false);
  await request('/api/skills/system-check/enabled', { method: 'PATCH', body: { enabled: true } });

  const deleted = await request('/api/skills/api-zip-skill', { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.equal((await request('/api/skills/api-zip-skill')).response.status, 404);
});

test('removed Agent APIs and model configuration remain unavailable', async () => {
  const removed = await request('/api/agents');
  assert.equal(removed.response.status, 404);
  assert.equal(removed.payload.error, 'Not found');
  const sessions = await request('/api/sessions');
  assert.ok(sessions.payload.every((session) => !('model' in session) && !('agentId' in session)));
  const health = await request('/api/health');
  assert.equal('defaultModel' in health.payload.runtime, false);
});
