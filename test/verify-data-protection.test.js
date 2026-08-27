const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const VERIFY_COMMAND = path.join(ROOT_DIR, 'bin', 'verify-data-protection.js');

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

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function waitFor(predicate, timeoutMs = 15000) {
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
  throw lastError || new Error('Timed out waiting for service');
}

async function stop(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    waitForExit(child),
    new Promise((resolve) => setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000)),
  ]);
}

function capture(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { stdout: () => stdout, stderr: () => stderr };
}

async function runVerifier(environment) {
  const verifier = spawn(process.execPath, [VERIFY_COMMAND], {
    cwd: ROOT_DIR,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = capture(verifier);
  const result = await waitForExit(verifier);
  return {
    code: result.code,
    payload: output.stdout() ? JSON.parse(output.stdout()) : null,
    stderr: output.stderr(),
  };
}

async function request(baseUrl, authorization, pathname, method = 'GET') {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { authorization },
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

test('data-protection verification gate authenticates and verifies every available package', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-protection-gate-'));
  const dataDir = path.join(root, 'data');
  const runtimeDir = path.join(root, 'runtime');
  const workspaceDir = path.join(root, 'workspace');
  const sourceHome = path.join(root, 'source-home');
  const workspaceSkills = path.join(root, 'workspace-skills');
  for (const directory of [dataDir, runtimeDir, workspaceDir, sourceHome, workspaceSkills]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const port = await availablePort();
  const authorization = `Basic ${Buffer.from('gate-user:gate-password').toString('base64')}`;
  const environment = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    CODEX_DESK_DATA_DIR: dataDir,
    CODEX_DESK_RUNTIME_DIR: runtimeDir,
    CODEX_TASK_WORKSPACE_ROOTS: workspaceDir,
    SOURCE_CODEX_HOME: sourceHome,
    WORKSPACE_CODEX_SKILLS_DIR: workspaceSkills,
    CODEX_ALLOW_ROOT_EXECUTION: '1',
    CODEX_DISABLE_WORKER: '1',
    CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
    CODEX_DB_BACKUP_RETENTION: '2',
    CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    CODEX_DESK_AUTH_USER: 'gate-user',
    CODEX_DESK_AUTH_PASSWORD: 'gate-password',
    CODEX_RELEASE_ID: 'protection-gate-test',
  };
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await request(baseUrl, authorization, '/api/health')).response.status === 200);
    assert.equal((await request(baseUrl, authorization, '/api/backups', 'POST')).response.status, 201);
    assert.equal((await request(baseUrl, authorization, '/api/recovery-checkpoints', 'POST')).response.status, 201);

    const successful = await runVerifier(environment);
    assert.equal(successful.code, 0, successful.stderr);
    const verification = successful.payload;
    assert.equal(verification.ok, true);
    assert.equal(verification.release.releaseId, 'protection-gate-test');
    assert.equal(verification.backups.total, 2);
    assert.equal(verification.backups.available, 2);
    assert.equal(verification.backups.invalid, 0);
    assert.equal(verification.backups.verified, 2);
    assert.equal(verification.backups.failed, 0);
    assert.equal(verification.backups.results.every((record) => record.ok), true);
    assert.deepEqual(verification.recoveryCheckpoints, {
      total: 1, available: 1, invalid: 0, verified: 1, failed: 0,
      results: [{ id: verification.recoveryCheckpoints.results[0].id, ok: true }],
    });

    const corruptedBackup = verification.backups.results[0].id;
    fs.writeFileSync(
      path.join(dataDir, 'backups', corruptedBackup, 'manifest.json'),
      '{}\n',
      { mode: 0o600 },
    );
    const failed = await runVerifier(environment);
    assert.equal(failed.code, 1, failed.stderr);
    assert.equal(failed.payload.ok, false);
    assert.equal(failed.payload.backups.invalid, 1);
    assert.equal(failed.payload.backups.results.some((record) => (
      record.id === corruptedBackup && record.ok === false && record.error === 'manifest_invalid'
    )), true);
    assert.equal(failed.payload.recoveryCheckpoints.verified, 1);
  } finally {
    await stop(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
