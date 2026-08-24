const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { inspectProcess, sameProcess } = require('../src/process-identity');

const ROOT_DIR = path.resolve(__dirname, '..');
const START_SCRIPT = path.join(ROOT_DIR, 'start-supervised.sh');
const ROLLING_RESTART = path.join(ROOT_DIR, 'bin', 'rolling-restart.js');

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError || new Error('Timed out waiting for rolling restart condition');
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function waitForExitWithin(child, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    waitForExit(child).then((result) => {
      clearTimeout(timer);
      resolve(result);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function capture(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  return {
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function readOwner(runtimeDir) {
  return JSON.parse(fs.readFileSync(path.join(runtimeDir, 'web-launcher.lock', 'owner.json'), 'utf8'));
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  return { response, text, payload: text ? JSON.parse(text) : null };
}

async function createFixture(drainMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rolling-restart-'));
  const dataDir = path.join(root, 'data');
  const runtimeDir = path.join(root, 'runtime');
  const backupDir = path.join(dataDir, 'backups');
  const workspaceRoot = path.join(root, 'workspace');
  const sourceHome = path.join(root, 'source-home');
  const workspaceSkills = path.join(root, 'workspace-skills');
  for (const directory of [dataDir, runtimeDir, backupDir, workspaceRoot, sourceHome, workspaceSkills]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    CODEX_DESK_DATA_DIR: dataDir,
    CODEX_DESK_RUNTIME_DIR: runtimeDir,
    CODEX_DESK_BACKUP_DIR: backupDir,
    CODEX_SERVICE_ENV_FILE: path.join(root, 'missing-service.env'),
    CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
    SOURCE_CODEX_HOME: sourceHome,
    WORKSPACE_CODEX_SKILLS_DIR: workspaceSkills,
    CODEX_ALLOW_ROOT_EXECUTION: '1',
    CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
    CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    CODEX_RELEASE_ID: 'rolling-restart-test',
    CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES: '4096',
    CODEX_WEB_SUPERVISOR_LOG_RETENTION: '2',
    CODEX_ROLLING_RESTART_TIMEOUT_MS: '30000',
    CODEX_ROLLING_RESTART_DRAIN_MS: String(drainMs),
    UNRELATED_RESTART_SECRET: 'must-not-be-persisted',
  };
  const launcher = spawn('/bin/sh', [START_SCRIPT], {
    cwd: ROOT_DIR,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const launcherOutput = capture(launcher);
  await waitFor(async () => {
    const result = await request(baseUrl, '/api/ready');
    return result.response.status === 200 && result.payload.ready ? result.payload : null;
  });
  return {
    root, dataDir, runtimeDir, baseUrl, environment, launcher, launcherOutput,
  };
}

async function stopFixture(fixture) {
  let owner;
  try { owner = readOwner(fixture.runtimeDir); } catch {}
  if (owner && sameProcess(owner, { requireGroupLeader: true, requireSessionLeader: true })) {
    try { process.kill(owner.pid, 'SIGTERM'); } catch {}
    try { await waitFor(() => !inspectProcess(owner.pid), 12000); } catch {
      try { process.kill(-owner.processGroupId, 'SIGKILL'); } catch {}
    }
  }
  if (inspectProcess(fixture.launcher.pid)) {
    try { process.kill(-fixture.launcher.pid, 'SIGKILL'); } catch {}
  }
  await waitForExit(fixture.launcher);
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test('guarded rolling restart blocks new work and verifies the replacement process tree', async () => {
  const fixture = await createFixture(1000);
  let restart = null;
  try {
    const oldOwner = readOwner(fixture.runtimeDir);
    assert.equal(oldOwner.deploymentRoot, fs.realpathSync(ROOT_DIR));
    assert.equal(oldOwner.restartEnvironment.CODEX_DESK_DATA_DIR, fixture.dataDir);
    assert.equal(oldOwner.restartEnvironment.CODEX_RELEASE_ID, fixture.environment.CODEX_RELEASE_ID);
    assert.equal(oldOwner.restartEnvironment.UNRELATED_RESTART_SECRET, undefined);
    restart = spawn(process.execPath, [ROLLING_RESTART], {
      cwd: ROOT_DIR,
      env: fixture.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = capture(restart);
    const maintenance = await waitFor(async () => {
      const result = await request(fixture.baseUrl, '/api/health');
      return result.payload.runtime?.maintenance?.kind === 'rolling_restart' ? result : null;
    });
    assert.equal(maintenance.payload.ready, false);
    assert.deepEqual(maintenance.payload.runtime.degradedReasons, ['platform_maintenance']);

    const blocked = await request(fixture.baseUrl, '/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'rolling-race-task', name: 'Rolling race task',
        objective: 'Must not enter during maintenance.', workingDir: '.',
      }),
    });
    assert.equal(blocked.response.status, 503, blocked.text);
    assert.match(blocked.payload.error, /Platform maintenance is active/);

    const restarted = await waitForExitWithin(restart, 40000, `Restart did not exit: ${output.stderr()}`);
    assert.equal(restarted.code, 0, output.stderr());
    const result = JSON.parse(output.stdout());
    assert.equal(result.ok, true);
    assert.equal(result.oldLauncherPid, oldOwner.pid);
    assert.notEqual(result.newLauncherPid, oldOwner.pid);
    assert.equal(result.releaseId, fixture.environment.CODEX_RELEASE_ID);
    assert.match(result.instanceId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(result.activity, {
      tasks: 0, attempts: 0, commands: 0, scheduledJobs: 0, externalAttempts: 0,
      externalArchives: 0, externalArchiveVerifications: 0, reportArtifactArchives: 0,
      bridgeCleanups: 0,
    });
    await waitForExit(fixture.launcher);
    const newOwner = readOwner(fixture.runtimeDir);
    assert.equal(newOwner.pid, result.newLauncherPid);
    assert.ok(sameProcess(newOwner, { requireGroupLeader: true, requireSessionLeader: true }));
    const ready = await waitFor(async () => {
      const current = await request(fixture.baseUrl, '/api/ready');
      return current.response.status === 200 && current.payload.ready ? current.payload : null;
    });
    assert.equal(ready.runtime.hostLauncher.processVerified, true);
    assert.equal(ready.runtime.webSupervisor.processVerified, true);
    assert.equal(ready.runtime.workerProcessVerified, true);
    assert.equal(ready.release.releaseIdConfigured, true);
    assert.equal(ready.release.releaseId, fixture.environment.CODEX_RELEASE_ID);
    assert.equal(ready.release.instanceId, result.instanceId);
    assert.deepEqual(ready.runtime.degradedReasons, []);
    assert.equal((await request(fixture.baseUrl, '/api/sessions/rolling-race-task')).response.status, 404);

    const db = new Database(path.join(fixture.dataDir, 'codex-tasks.db'), { readonly: true, fileMustExist: true });
    const audits = db.prepare(`
      SELECT kind FROM audit_events
      WHERE kind LIKE 'platform.rolling_restart.%' ORDER BY ts, id
    `).all().map((row) => row.kind);
    db.close();
    assert.deepEqual(audits, [
      'platform.rolling_restart.started',
      'platform.rolling_restart.completed',
    ]);
  } finally {
    if (restart && inspectProcess(restart.pid)) restart.kill('SIGKILL');
    if (restart) await waitForExit(restart);
    await stopFixture(fixture);
  }
});

test('interrupting the restart before shutdown releases maintenance and preserves the old tree', async () => {
  const fixture = await createFixture(1500);
  let restart = null;
  try {
    const oldOwner = readOwner(fixture.runtimeDir);
    restart = spawn(process.execPath, [ROLLING_RESTART], {
      cwd: ROOT_DIR,
      env: fixture.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = capture(restart);
    await waitFor(async () => {
      const result = await request(fixture.baseUrl, '/api/health');
      return result.payload.runtime?.maintenance?.kind === 'rolling_restart';
    });
    restart.kill('SIGTERM');
    const interrupted = await waitForExitWithin(restart, 10000, 'Interrupted restart did not exit');
    assert.equal(interrupted.code, 1, output.stderr());
    const failure = JSON.parse(output.stderr());
    assert.equal(failure.ok, false);
    assert.equal(failure.phase, 'maintenance');
    assert.equal(failure.maintenanceReleased, true);
    assert.ok(sameProcess(oldOwner, { requireGroupLeader: true, requireSessionLeader: true }));

    const ready = await waitFor(async () => {
      const result = await request(fixture.baseUrl, '/api/ready');
      return result.response.status === 200 && result.payload.ready ? result.payload : null;
    });
    assert.deepEqual(ready.runtime.degradedReasons, []);
    assert.equal(readOwner(fixture.runtimeDir).pid, oldOwner.pid);
  } finally {
    if (restart && inspectProcess(restart.pid)) restart.kill('SIGKILL');
    if (restart) await waitForExit(restart);
    await stopFixture(fixture);
  }
});

test('rolling restart rejects a Launcher owner from a different deployment before maintenance', async () => {
  const fixture = await createFixture(0);
  let restart = null;
  try {
    const ownerPath = path.join(fixture.runtimeDir, 'web-launcher.lock', 'owner.json');
    const owner = readOwner(fixture.runtimeDir);
    fs.writeFileSync(ownerPath, `${JSON.stringify({ ...owner, deploymentRoot: fixture.root }, null, 2)}\n`, { mode: 0o600 });
    restart = spawn(process.execPath, [ROLLING_RESTART], {
      cwd: ROOT_DIR,
      env: fixture.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = capture(restart);
    const result = await waitForExitWithin(restart, 10000, 'Rejected restart did not exit');
    assert.equal(result.code, 1);
    assert.match(output.stderr(), /deployment root differs/);
    const ready = await waitFor(async () => {
      const current = await request(fixture.baseUrl, '/api/ready');
      return current.response.status === 200 && current.payload.ready ? current.payload : null;
    });
    assert.deepEqual(ready.runtime.degradedReasons, []);
  } finally {
    if (restart && inspectProcess(restart.pid)) restart.kill('SIGKILL');
    if (restart) await waitForExit(restart);
    await stopFixture(fixture);
  }
});
