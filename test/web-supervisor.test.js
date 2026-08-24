const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { inspectProcess } = require('../src/process-identity');

const ROOT_DIR = path.resolve(__dirname, '..');
const SUPERVISOR = path.join(ROOT_DIR, 'bin', 'web-supervisor.js');
const START_SCRIPT = path.join(ROOT_DIR, 'start-supervised.sh');

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

async function waitFor(predicate, timeoutMs = 10000) {
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
  throw lastError || new Error('Timed out waiting for supervisor condition');
}

function directChildren(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((childPid) => inspectProcess(childPid));
  } catch {
    return [];
  }
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

function managedLogText(runtimeDir, retention = 20) {
  const filePath = path.join(runtimeDir, 'web-supervisor.log');
  const chunks = [];
  for (let index = retention; index >= 1; index -= 1) {
    const rotated = `${filePath}.${index}`;
    if (fs.existsSync(rotated)) chunks.push(fs.readFileSync(rotated, 'utf8'));
  }
  if (fs.existsSync(filePath)) chunks.push(fs.readFileSync(filePath, 'utf8'));
  return chunks.join('');
}

test('web supervisor reclaims stale state, rejects duplicates, and restarts a killed web process', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-web-supervisor-'));
  const dataDir = path.join(tempDir, 'data');
  const runtimeDir = path.join(tempDir, 'runtime');
  const workspaceRoot = path.join(tempDir, 'workspace');
  const sourceHome = path.join(tempDir, 'source-home');
  const workspaceSkills = path.join(tempDir, 'workspace-skills');
  for (const directory of [dataDir, runtimeDir, workspaceRoot, sourceHome, workspaceSkills]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const staleLock = path.join(runtimeDir, 'web-supervisor.lock');
  fs.mkdirSync(staleLock, { mode: 0o700 });
  fs.writeFileSync(path.join(staleLock, 'owner.json'), JSON.stringify({
    token: 'stale', pid: 999999, parentPid: 1, processGroupId: 999999,
    sessionId: 999999, startTicks: '1', createdAt: '2000-01-01T00:00:00.000Z',
  }), { mode: 0o600 });

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    CODEX_DESK_DATA_DIR: dataDir,
    CODEX_DESK_RUNTIME_DIR: runtimeDir,
    CODEX_DESK_BACKUP_DIR: path.join(dataDir, 'backups'),
    CODEX_SERVICE_ENV_FILE: path.join(tempDir, 'missing-service.env'),
    CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
    SOURCE_CODEX_HOME: sourceHome,
    WORKSPACE_CODEX_SKILLS_DIR: workspaceSkills,
    CODEX_ALLOW_ROOT_EXECUTION: '1',
    CODEX_DISABLE_WORKER: '1',
    CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
    CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
  };
  let output = '';
  const supervisor = spawn(process.execPath, [SUPERVISOR], {
    cwd: ROOT_DIR,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  supervisor.stdout.on('data', (chunk) => { output += chunk.toString(); });
  supervisor.stderr.on('data', (chunk) => { output += chunk.toString(); });
  let firstWebPid;
  let restartedWebPid;
  let replacement = null;
  let replacementWebPid;

  try {
    const firstHealth = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      if (!response.ok) return null;
      const payload = await response.json();
      return payload.runtime.webSupervisor.processVerified ? payload : null;
    });
    assert.deepEqual(firstHealth.runtime.webSupervisor, {
      mode: 'process', required: true, processVerified: true,
    });
    firstWebPid = await waitFor(() => directChildren(supervisor.pid)[0] || null);
    assert.equal(fs.statSync(staleLock).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(staleLock, 'owner.json')).mode & 0o777, 0o600);

    let duplicateOutput = '';
    const duplicate = spawn(process.execPath, [SUPERVISOR], {
      cwd: ROOT_DIR,
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    duplicate.stderr.on('data', (chunk) => { duplicateOutput += chunk.toString(); });
    const duplicateExit = await Promise.race([
      waitForExit(duplicate),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Duplicate supervisor did not exit')), 4000)),
    ]);
    assert.equal(duplicateExit.code, 78, duplicateOutput);
    assert.match(duplicateOutput, /already running/);
    assert.ok(inspectProcess(supervisor.pid));

    process.kill(firstWebPid, 'SIGKILL');
    restartedWebPid = await waitFor(() => {
      const childPid = directChildren(supervisor.pid)[0];
      return childPid && childPid !== firstWebPid ? childPid : null;
    });
    const recoveredHealth = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      if (!response.ok) return null;
      const payload = await response.json();
      return payload.runtime.webSupervisor.processVerified ? payload : null;
    });
    assert.equal(recoveredHealth.runtime.webSupervisor.processVerified, true);
    assert.ok(inspectProcess(supervisor.pid));
    assert.ok(inspectProcess(restartedWebPid));
    assert.match(output, /web process exited code=null signal=SIGKILL/);
    assert.match(output, /restarting web process in 1000 ms/);

    supervisor.kill('SIGKILL');
    const crashed = await Promise.race([
      waitForExit(supervisor),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Supervisor did not crash: ${output}`)), 4000)),
    ]);
    assert.equal(crashed.signal, 'SIGKILL', output);
    await waitFor(() => !inspectProcess(restartedWebPid));
    assert.match(output, /required web supervisor disappeared; shutting down/);
    let replacementOutput = '';
    replacement = spawn(process.execPath, [SUPERVISOR], {
      cwd: ROOT_DIR,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    replacement.stdout.on('data', (chunk) => { replacementOutput += chunk.toString(); });
    replacement.stderr.on('data', (chunk) => { replacementOutput += chunk.toString(); });
    const restoredHealth = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      if (!response.ok) return null;
      const payload = await response.json();
      return payload.runtime.webSupervisor.processVerified ? payload : null;
    });
    assert.equal(restoredHealth.runtime.webSupervisor.processVerified, true);
    replacementWebPid = await waitFor(() => directChildren(replacement.pid)[0] || null);
    replacement.kill('SIGTERM');
    const stopped = await Promise.race([
      waitForExit(replacement),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Replacement did not stop: ${replacementOutput}`)), 7000)),
    ]);
    assert.equal(stopped.code, 0, replacementOutput);
    await waitFor(() => !inspectProcess(replacementWebPid));
    assert.equal(fs.existsSync(staleLock), false);
  } finally {
    if (inspectProcess(supervisor.pid)) supervisor.kill('SIGKILL');
    await waitForExit(supervisor);
    if (replacement && inspectProcess(replacement.pid)) replacement.kill('SIGKILL');
    if (replacement) await waitForExit(replacement);
    for (const pid of [firstWebPid, restartedWebPid, replacementWebPid]) {
      if (!pid || !inspectProcess(pid)) continue;
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('host launcher restores the complete service tree after the web supervisor is killed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-web-launcher-'));
  const dataDir = path.join(tempDir, 'data');
  const runtimeDir = path.join(tempDir, 'runtime');
  const workspaceRoot = path.join(tempDir, 'workspace');
  const sourceHome = path.join(tempDir, 'source-home');
  const workspaceSkills = path.join(tempDir, 'workspace-skills');
  for (const directory of [dataDir, runtimeDir, workspaceRoot, sourceHome, workspaceSkills]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const staleLauncherLock = path.join(runtimeDir, 'web-launcher.lock');
  fs.mkdirSync(staleLauncherLock, { mode: 0o700 });
  fs.writeFileSync(path.join(staleLauncherLock, 'owner.json'), JSON.stringify({
    token: 'stale-launcher', pid: 999999, parentPid: 1, processGroupId: 999999,
    sessionId: 999999, startTicks: '1', createdAt: '2000-01-01T00:00:00.000Z',
  }), { mode: 0o600 });
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    CODEX_DESK_DATA_DIR: dataDir,
    CODEX_DESK_RUNTIME_DIR: runtimeDir,
    CODEX_DESK_BACKUP_DIR: path.join(dataDir, 'backups'),
    CODEX_SERVICE_ENV_FILE: path.join(tempDir, 'missing-service.env'),
    CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
    SOURCE_CODEX_HOME: sourceHome,
    WORKSPACE_CODEX_SKILLS_DIR: workspaceSkills,
    CODEX_ALLOW_ROOT_EXECUTION: '1',
    CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
    CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES: '256',
    CODEX_WEB_SUPERVISOR_LOG_RETENTION: '2',
  };
  let output = '';
  const launcher = spawn('/bin/sh', [START_SCRIPT], {
    cwd: ROOT_DIR,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  launcher.stdout.on('data', (chunk) => { output += chunk.toString(); });
  launcher.stderr.on('data', (chunk) => { output += chunk.toString(); });
  let firstSupervisorPid;
  let firstWebPid;
  let firstWorkerPid;
  let replacementSupervisorPid;
  let replacementWebPid;
  let replacementWorkerPid;

  try {
    const firstHealth = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/ready`);
      if (!response.ok) return null;
      const payload = await response.json();
      return payload.runtime.hostLauncher.processVerified
        && payload.runtime.webSupervisor.processVerified
        && payload.runtime.workerAvailable
        ? payload
        : null;
    }, 15000);
    assert.deepEqual(firstHealth.runtime.hostLauncher, {
      mode: 'process', required: true, processVerified: true,
    });
    assert.equal(fs.statSync(staleLauncherLock).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(staleLauncherLock, 'owner.json')).mode & 0o777, 0o600);
    firstSupervisorPid = await waitFor(() => directChildren(launcher.pid)
      .find((pid) => directChildren(pid).length > 0) || null);
    firstWebPid = await waitFor(() => directChildren(firstSupervisorPid)[0] || null);
    firstWorkerPid = await waitFor(() => directChildren(firstWebPid)[0] || null);
    const startupOutput = await waitFor(() => {
      const content = managedLogText(runtimeDir, 2);
      return content.includes(`[web-launcher] started pid=${launcher.pid} logging=managed`)
        && content.includes(`[web-launcher] started web supervisor pid=${firstSupervisorPid}`)
        ? content
        : null;
    });
    assert.match(startupOutput, /\[web-launcher\] started pid=\d+ logging=managed/);

    let duplicateOutput = '';
    const duplicate = spawn('/bin/sh', [START_SCRIPT], {
      cwd: ROOT_DIR,
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    duplicate.stderr.on('data', (chunk) => { duplicateOutput += chunk.toString(); });
    const duplicateExit = await Promise.race([
      waitForExit(duplicate),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Duplicate launcher did not exit')), 5000)),
    ]);
    assert.equal(duplicateExit.code, 78, duplicateOutput);
    assert.match(duplicateOutput, /already running/);

    process.kill(firstSupervisorPid, 'SIGKILL');
    const recoveredHealth = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/ready`);
      if (!response.ok) return null;
      const payload = await response.json();
      const supervisorPid = directChildren(launcher.pid)
        .find((pid) => pid !== firstSupervisorPid && directChildren(pid).length > 0);
      if (!supervisorPid || !payload.runtime.hostLauncher.processVerified
        || !payload.runtime.webSupervisor.processVerified
        || !payload.runtime.workerAvailable) return null;
      replacementSupervisorPid = supervisorPid;
      return payload;
    }, 20000);
    assert.equal(recoveredHealth.ready, true);
    replacementWebPid = await waitFor(() => directChildren(replacementSupervisorPid)[0] || null);
    replacementWorkerPid = await waitFor(() => directChildren(replacementWebPid)[0] || null);
    await waitFor(() => !inspectProcess(firstWebPid) && !inspectProcess(firstWorkerPid), 12000);
    const managedOutput = await waitFor(() => {
      const content = managedLogText(runtimeDir, 2);
      return /required web supervisor disappeared; shutting down/.test(content)
        && /web supervisor exited status=137; restarting in 1s/.test(content)
        && content.includes(`[web-launcher] started web supervisor pid=${replacementSupervisorPid}`)
        ? content
        : null;
    });
    assert.match(managedOutput, /required web supervisor disappeared; shutting down/);
    assert.match(managedOutput, /web supervisor exited status=137; restarting in 1s/);
    assert.ok(inspectProcess(launcher.pid));
    assert.ok(inspectProcess(replacementSupervisorPid));
    assert.ok(inspectProcess(replacementWebPid));
    assert.ok(inspectProcess(replacementWorkerPid));

    launcher.kill('SIGTERM');
    const stopped = await Promise.race([
      waitForExit(launcher),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Launcher did not stop: ${output}`)), 12000)),
    ]);
    assert.equal(stopped.code, 0, output);
    await waitFor(() => !inspectProcess(replacementSupervisorPid)
      && !inspectProcess(replacementWebPid) && !inspectProcess(replacementWorkerPid), 12000);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'web-supervisor.lock')), false);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'web-launcher.lock')), false);
    const managedFiles = fs.readdirSync(runtimeDir)
      .filter((name) => /^web-supervisor\.log(?:\.\d+)?$/.test(name));
    assert.ok(managedFiles.length >= 2 && managedFiles.length <= 3);
    for (const name of managedFiles) {
      const stat = fs.lstatSync(path.join(runtimeDir, name));
      assert.equal(stat.mode & 0o777, 0o600);
      assert.ok(stat.size <= 256, `${name} exceeded the configured bound`);
    }
  } finally {
    if (inspectProcess(launcher.pid)) {
      try { process.kill(-launcher.pid, 'SIGKILL'); } catch {}
    }
    await waitForExit(launcher);
    for (const pid of [
      firstSupervisorPid, firstWebPid, firstWorkerPid,
      replacementSupervisorPid, replacementWebPid, replacementWorkerPid,
    ]) {
      if (!pid || !inspectProcess(pid)) continue;
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('host launcher loss makes readiness fail while the surviving service tree remains inspectable', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-web-launcher-loss-'));
  const dataDir = path.join(tempDir, 'data');
  const runtimeDir = path.join(tempDir, 'runtime');
  const workspaceRoot = path.join(tempDir, 'workspace');
  const sourceHome = path.join(tempDir, 'source-home');
  const workspaceSkills = path.join(tempDir, 'workspace-skills');
  for (const directory of [dataDir, runtimeDir, workspaceRoot, sourceHome, workspaceSkills]) {
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
    CODEX_DESK_BACKUP_DIR: path.join(dataDir, 'backups'),
    CODEX_SERVICE_ENV_FILE: path.join(tempDir, 'missing-service.env'),
    CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
    SOURCE_CODEX_HOME: sourceHome,
    WORKSPACE_CODEX_SKILLS_DIR: workspaceSkills,
    CODEX_ALLOW_ROOT_EXECUTION: '1',
    CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
    CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
  };
  let output = '';
  const launcher = spawn('/bin/sh', [START_SCRIPT], {
    cwd: ROOT_DIR,
    env: environment,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  launcher.stdout.on('data', (chunk) => { output += chunk.toString(); });
  launcher.stderr.on('data', (chunk) => { output += chunk.toString(); });
  let supervisorPid;
  let webPid;
  let workerPid;
  let replacement = null;
  let replacementSupervisorPid;
  let replacementWebPid;
  let replacementWorkerPid;

  try {
    const initialHealth = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/ready`);
      if (!response.ok) return null;
      const payload = await response.json();
      return payload.runtime.hostLauncher.processVerified
        && payload.runtime.webSupervisor.processVerified
        && payload.runtime.workerAvailable
        ? payload
        : null;
    }, 15000);
    assert.equal(initialHealth.ready, true);
    assert.deepEqual(initialHealth.runtime.hostLauncher, {
      mode: 'process', required: true, processVerified: true,
    });
    supervisorPid = await waitFor(() => directChildren(launcher.pid)
      .find((pid) => directChildren(pid).length > 0) || null);
    webPid = await waitFor(() => directChildren(supervisorPid)[0] || null);
    workerPid = await waitFor(() => directChildren(webPid)[0] || null);

    launcher.kill('SIGKILL');
    const launcherExit = await Promise.race([
      waitForExit(launcher),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Launcher did not exit: ${output}`)), 4000)),
    ]);
    assert.equal(launcherExit.signal, 'SIGKILL', output);

    const degradedHealth = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      if (!response.ok) return null;
      const payload = await response.json();
      return payload.runtime.hostLauncher.processVerified === false
        ? { response, payload }
        : null;
    });
    assert.equal(degradedHealth.response.status, 200);
    assert.equal(degradedHealth.payload.ok, true);
    assert.equal(degradedHealth.payload.ready, false);
    assert.equal(degradedHealth.payload.runtime.ready, false);
    assert.deepEqual(degradedHealth.payload.runtime.hostLauncher, {
      mode: 'process', required: true, processVerified: false,
    });
    assert.equal(degradedHealth.payload.runtime.webSupervisor.processVerified, true);
    assert.equal(degradedHealth.payload.runtime.workerAvailable, true);
    assert.ok(degradedHealth.payload.runtime.degradedReasons.includes('host_launcher_unavailable'));

    const readyResponse = await fetch(`${baseUrl}/api/ready`);
    const readyPayload = await readyResponse.json();
    assert.equal(readyResponse.status, 503);
    assert.equal(readyPayload.ready, false);
    assert.ok(readyPayload.runtime.degradedReasons.includes('host_launcher_unavailable'));
    assert.ok(inspectProcess(supervisorPid));
    assert.ok(inspectProcess(webPid));
    assert.ok(inspectProcess(workerPid));

    process.kill(supervisorPid, 'SIGTERM');
    await waitFor(() => !inspectProcess(supervisorPid)
      && !inspectProcess(webPid) && !inspectProcess(workerPid), 12000);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'web-supervisor.lock')), false);

    replacement = spawn('/bin/sh', [START_SCRIPT], {
      cwd: ROOT_DIR,
      env: environment,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const recovered = await waitFor(async () => {
      const response = await fetch(`${baseUrl}/api/ready`);
      if (!response.ok) return null;
      const payload = await response.json();
      return payload.runtime.hostLauncher.processVerified
        && payload.runtime.webSupervisor.processVerified
        && payload.runtime.workerAvailable
        ? payload
        : null;
    }, 15000);
    assert.equal(recovered.ready, true);
    replacementSupervisorPid = await waitFor(() => directChildren(replacement.pid)[0] || null);
    replacementWebPid = await waitFor(() => directChildren(replacementSupervisorPid)[0] || null);
    replacementWorkerPid = await waitFor(() => directChildren(replacementWebPid)[0] || null);
    replacement.kill('SIGTERM');
    const replacementExit = await Promise.race([
      waitForExit(replacement),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Replacement launcher did not stop')), 12000)),
    ]);
    assert.equal(replacementExit.code, 0);
    await waitFor(() => !inspectProcess(replacementSupervisorPid)
      && !inspectProcess(replacementWebPid) && !inspectProcess(replacementWorkerPid), 12000);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'web-launcher.lock')), false);
  } finally {
    if (inspectProcess(launcher.pid)) {
      try { process.kill(-launcher.pid, 'SIGKILL'); } catch {}
    }
    await waitForExit(launcher);
    if (replacement && inspectProcess(replacement.pid)) {
      try { process.kill(-replacement.pid, 'SIGKILL'); } catch {}
    }
    if (replacement) await waitForExit(replacement);
    for (const pid of [
      supervisorPid, webPid, workerPid,
      replacementSupervisorPid, replacementWebPid, replacementWorkerPid,
    ]) {
      if (!pid || !inspectProcess(pid)) continue;
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
