#!/usr/bin/env node

process.umask(0o077);

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  ROOT_DIR,
  DATA_DIR,
  RUNTIME_DIR,
  BACKUP_DIR,
} = require('../src/paths');
const {
  acquirePlatformMaintenance,
  appendAuditEvent,
  getPlatformActivityCounts,
  releasePlatformMaintenance,
  renewPlatformMaintenance,
} = require('../src/store');
const { closeDatabase } = require('../src/database');
const { databaseBackupOperationActive } = require('../src/database-backup');
const { inspectProcess, sameProcess } = require('../src/process-identity');
const { validRestartEnvironment } = require('../src/launcher-environment');
const {
  expectedReleaseId,
  matchesExpectedRelease,
  releaseExpectationMismatch,
} = require('../src/release-info');

const LAUNCHER = path.join(ROOT_DIR, 'bin', 'web-launcher.js');
const LAUNCHER_OWNER_FILE = path.join(RUNTIME_DIR, 'web-launcher.lock', 'owner.json');
const SUPERVISOR_OWNER_FILE = path.join(RUNTIME_DIR, 'web-supervisor.lock', 'owner.json');
const POLL_MS = 100;
const LEASE_TTL_MS = 120000;
const LEASE_RENEW_MS = 30000;

function integerSetting(name, fallback, minimum, maximum) {
  const raw = String(process.env[name] ?? fallback).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

const RESTART_TIMEOUT_MS = integerSetting('CODEX_ROLLING_RESTART_TIMEOUT_MS', 60000, 10000, 300000);
const DRAIN_MS = integerSetting('CODEX_ROLLING_RESTART_DRAIN_MS', 500, 0, 10000);

let interruptedSignal = '';
let leaseFailure = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { interruptedSignal = signal; });
}

function assertContinuity() {
  if (interruptedSignal) throw new Error(`Rolling restart interrupted by ${interruptedSignal}`);
  if (leaseFailure) throw leaseFailure;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(description, timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    assertContinuity();
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_MS);
  }
  const suffix = lastError ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

function readOwner(filePath, required = true) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) {
      throw new Error(`Unsafe process owner file: ${path.basename(path.dirname(filePath))}`);
    }
    const owner = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)) throw new Error('Invalid process owner');
    return owner;
  } catch (error) {
    if (!required && error.code === 'ENOENT') return null;
    throw error;
  }
}

function verifiedOwner(filePath, label) {
  const owner = readOwner(filePath);
  if (!sameProcess(owner, { requireGroupLeader: label === 'launcher', requireSessionLeader: label === 'launcher' })) {
    throw new Error(`The ${label} lock owner is not the live process it identifies`);
  }
  return owner;
}

function readProcessEnvironment(pid) {
  const content = fs.readFileSync(`/proc/${pid}/environ`);
  if (content.length > 1024 * 1024) throw new Error('Launcher environment is unexpectedly large');
  const environment = {};
  for (const entry of content.toString('utf8').split('\0')) {
    if (!entry) continue;
    const separator = entry.indexOf('=');
    if (separator < 1) throw new Error('Launcher environment contains an invalid entry');
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  for (const name of [
    'CODEX_REQUIRE_HOST_LAUNCHER',
    'CODEX_HOST_LAUNCHER_PID',
    'CODEX_HOST_LAUNCHER_START_TICKS',
    'CODEX_REQUIRE_WEB_SUPERVISOR',
    'CODEX_WEB_SUPERVISOR_PID',
    'CODEX_WEB_SUPERVISOR_START_TICKS',
    'CODEX_MANAGED_WEB_SUPERVISOR_LOG',
  ]) delete environment[name];
  return environment;
}

function restartEnvironment(owner) {
  if (validRestartEnvironment(owner.restartEnvironment)) {
    return { ...process.env, ...owner.restartEnvironment };
  }
  try {
    return readProcessEnvironment(owner.pid);
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw new Error('Launcher restart configuration is unavailable; deploy a Launcher version that records restart configuration before retrying');
    }
    throw error;
  }
}

function resolvedEnvironmentPath(environment, name, fallback) {
  return path.resolve(environment[name] || fallback);
}

function verifyLauncherDeployment(owner, environment) {
  const expectedRoot = fs.realpathSync(ROOT_DIR);
  if (Object.hasOwn(owner, 'deploymentRoot')) {
    if (typeof owner.deploymentRoot !== 'string' || fs.realpathSync(owner.deploymentRoot) !== expectedRoot) {
      throw new Error('Launcher deployment root differs from this restart process');
    }
  } else {
    const workingDirectory = fs.realpathSync(`/proc/${owner.pid}/cwd`);
    if (workingDirectory !== expectedRoot) throw new Error('Launcher working directory differs from this deployment');
    const command = fs.readFileSync(`/proc/${owner.pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
    const ownsExpectedScript = command.slice(1).some((argument) => path.resolve(workingDirectory, argument) === LAUNCHER);
    if (!ownsExpectedScript) throw new Error('Launcher command does not belong to this deployment');
  }
  const expected = {
    data: DATA_DIR,
    runtime: RUNTIME_DIR,
    backup: BACKUP_DIR,
  };
  const actual = {
    data: resolvedEnvironmentPath(environment, 'CODEX_DESK_DATA_DIR', path.join(ROOT_DIR, 'data')),
    runtime: resolvedEnvironmentPath(
      environment,
      'CODEX_DESK_RUNTIME_DIR',
      path.join(path.dirname(ROOT_DIR), `.${path.basename(ROOT_DIR)}-runtime`),
    ),
    backup: resolvedEnvironmentPath(environment, 'CODEX_DESK_BACKUP_DIR', path.join(DATA_DIR, 'backups')),
  };
  for (const key of Object.keys(expected)) {
    if (actual[key] !== path.resolve(expected[key])) throw new Error(`Launcher ${key} path differs from this restart process`);
  }
}

function probeAddress(environment, pathname) {
  const configuredHost = String(environment.HOST || '127.0.0.1');
  const host = configuredHost === '0.0.0.0'
    ? '127.0.0.1'
    : (configuredHost === '::' ? '::1' : configuredHost);
  const hostname = host.includes(':') ? `[${host}]` : host;
  const port = Number(environment.PORT || 8091);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Launcher PORT is invalid');
  return `http://${hostname}:${port}${pathname}`;
}

async function probe(environment, pathname) {
  const headers = {};
  const user = String(environment.CODEX_DESK_AUTH_USER || '');
  const password = String(environment.CODEX_DESK_AUTH_PASSWORD || '');
  if (Boolean(user) !== Boolean(password)) throw new Error('Launcher authentication environment is incomplete');
  if (user) headers.authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const response = await fetch(probeAddress(environment, pathname), {
    headers,
    signal: AbortSignal.timeout(2000),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`Health endpoint returned HTTP ${response.status} without JSON`); }
  return { status: response.status, payload };
}

function healthyRuntime(payload, maintenanceExpected, environment) {
  const runtime = payload?.runtime || {};
  const reasons = Array.isArray(runtime.degradedReasons) ? runtime.degradedReasons : [];
  const expectedReasons = maintenanceExpected ? ['platform_maintenance'] : [];
  return payload?.ok === true
    && runtime.permissionMode === 'danger-full-access'
    && runtime.approvalPolicy === 'never'
    && runtime.fullAccessAvailable === true
    && runtime.executionUserSafe === true
    && runtime.workerAvailable === true
    && runtime.workerProcessVerified === true
    && runtime.hostLauncher?.processVerified === true
    && runtime.webSupervisor?.processVerified === true
    && JSON.stringify(reasons) === JSON.stringify(expectedReasons)
    && payload.state?.ok === true
    && matchesExpectedRelease(payload.release, environment);
}

function releaseMismatchError(payload, environment) {
  const mismatch = releaseExpectationMismatch(payload?.release, environment);
  if (!mismatch) return null;
  return Object.assign(
    new Error(`Expected replacement release ID ${mismatch.expectedReleaseId}, received ${mismatch.actualReleaseId || 'no release ID'}`),
    { releaseMismatch: mismatch },
  );
}

async function waitForReadyRuntime(environment) {
  return waitFor('the current service to be ready', 10000, async () => {
    const result = await probe(environment, '/api/ready');
    if (result.status === 200 && result.payload.ready === true && healthyRuntime(result.payload, false, environment)) {
      return result.payload;
    }
    const mismatch = releaseMismatchError(result.payload, environment);
    if (mismatch) throw mismatch;
    return null;
  });
}

async function waitForMaintenanceRuntime(environment) {
  return waitFor('the replacement service tree during maintenance', RESTART_TIMEOUT_MS, async () => {
    const result = await probe(environment, '/api/health');
    const maintenance = result.payload?.runtime?.maintenance;
    if (result.status === 200
      && result.payload.ready === false
      && maintenance?.active === true
      && maintenance.kind === 'rolling_restart'
      && healthyRuntime(result.payload, true, environment)) {
      return result.payload;
    }
    const mismatch = releaseMismatchError(result.payload, environment);
    if (mismatch) throw mismatch;
    return null;
  });
}

async function spawnReplacement(environment) {
  const child = spawn(process.execPath, [LAUNCHER], {
    cwd: ROOT_DIR,
    env: environment,
    detached: true,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return child.pid;
}

async function main() {
  if (process.argv.length > 2) throw new Error('rolling-restart.js does not accept command-line arguments');
  if (process.platform !== 'linux') throw new Error('Rolling restart requires Linux process identity support');

  let phase = 'preflight';
  let lease = null;
  let leaseReleased = false;
  let renewalTimer = null;
  let shutdownStarted = false;
  let replacementHealthy = false;
  let oldLauncher = null;
  let oldSupervisor = null;
  let newLauncherPid = null;
  let environment = null;
  const owner = `rolling-restart:${process.pid}:${crypto.randomUUID()}`;

  try {
    oldLauncher = verifiedOwner(LAUNCHER_OWNER_FILE, 'launcher');
    oldSupervisor = verifiedOwner(SUPERVISOR_OWNER_FILE, 'supervisor');
    if (Number(oldSupervisor.parentPid) !== Number(oldLauncher.pid)) {
      throw new Error('Supervisor is not a direct child of the locked Launcher');
    }
    environment = restartEnvironment(oldLauncher);
    verifyLauncherDeployment(oldLauncher, environment);
    await waitForReadyRuntime(environment);
    if (databaseBackupOperationActive()) throw new Error('A database backup is already in progress');

    phase = 'maintenance';
    lease = acquirePlatformMaintenance('rolling_restart', owner, LEASE_TTL_MS);
    renewalTimer = setInterval(() => {
      try {
        const renewed = renewPlatformMaintenance(owner, LEASE_TTL_MS);
        if (!renewed) leaseFailure = new Error('Rolling restart maintenance lease was lost');
        else lease = renewed;
      } catch (error) {
        leaseFailure = error;
      }
    }, LEASE_RENEW_MS);
    renewalTimer.unref();
    appendAuditEvent({
      scope: 'runtime', entityType: 'platform', entityId: 'runtime',
      kind: 'platform.rolling_restart.started', actor: 'operator:rolling-restart',
      message: 'Started a guarded rolling restart.',
      payload: { oldLauncherPid: oldLauncher.pid, activity: getPlatformActivityCounts() },
    });
    if (DRAIN_MS) await delay(DRAIN_MS);
    assertContinuity();
    if (databaseBackupOperationActive()) throw new Error('A database backup started before the maintenance gate settled');

    phase = 'shutdown';
    shutdownStarted = true;
    if (!sameProcess(oldLauncher, { requireGroupLeader: true, requireSessionLeader: true })) {
      throw new Error('Launcher identity changed before shutdown');
    }
    process.kill(oldLauncher.pid, 'SIGTERM');
    await waitFor('the previous service tree to stop', RESTART_TIMEOUT_MS, () => (
      !sameProcess(oldLauncher) && !sameProcess(oldSupervisor)
    ));

    phase = 'startup';
    newLauncherPid = await spawnReplacement(environment);
    await waitFor('the replacement Launcher lock', RESTART_TIMEOUT_MS, () => {
      const current = readOwner(LAUNCHER_OWNER_FILE, false);
      return current?.pid === newLauncherPid
        && sameProcess(current, { requireGroupLeader: true, requireSessionLeader: true })
        ? current
        : null;
    });
    const maintenanceHealth = await waitForMaintenanceRuntime(environment);
    replacementHealthy = true;

    phase = 'release';
    appendAuditEvent({
      scope: 'runtime', entityType: 'platform', entityId: 'runtime',
      kind: 'platform.rolling_restart.completed', actor: 'operator:rolling-restart',
      message: 'Completed a guarded rolling restart.',
      payload: {
        oldLauncherPid: oldLauncher.pid,
        newLauncherPid,
        workerPidVerified: maintenanceHealth.runtime.workerProcessVerified,
        releaseId: maintenanceHealth.release.releaseId,
        instanceId: maintenanceHealth.release.instanceId,
      },
    });
    if (!releasePlatformMaintenance(owner)) throw new Error('Rolling restart maintenance lease could not be released');
    leaseReleased = true;
    clearInterval(renewalTimer);
    renewalTimer = null;

    phase = 'verification';
    const ready = await waitFor('the replacement service to become ready', RESTART_TIMEOUT_MS, async () => {
      const result = await probe(environment, '/api/ready');
      return result.status === 200 && result.payload.ready === true && healthyRuntime(result.payload, false, environment)
        ? result.payload
        : null;
    });
    const activity = getPlatformActivityCounts();
    if (Object.values(activity).some((count) => count !== 0)) {
      throw new Error(`Platform activity changed during restart: ${JSON.stringify(activity)}`);
    }
    return {
      ok: true,
      oldLauncherPid: oldLauncher.pid,
      newLauncherPid,
      ready: ready.ready,
      releaseId: ready.release.releaseId,
      instanceId: ready.release.instanceId,
      activity,
    };
  } catch (error) {
    let failedAuditRecorded = false;
    if (lease) {
      try {
        appendAuditEvent({
          scope: 'runtime', entityType: 'platform', entityId: 'runtime',
          kind: 'platform.rolling_restart.failed', level: 'error', actor: 'operator:rolling-restart',
          message: 'Guarded rolling restart failed.',
          payload: {
            phase,
            error: error.message,
            oldLauncherPid: oldLauncher?.pid || null,
            newLauncherPid,
            expectedReleaseId: expectedReleaseId(environment || {}),
            releaseMismatch: error.releaseMismatch || null,
          },
        });
        failedAuditRecorded = true;
      } catch {}
    }
    if (lease && !leaseReleased && (!shutdownStarted || replacementHealthy)) {
      try { leaseReleased = releasePlatformMaintenance(owner); } catch {}
    }
    error.rollingRestart = {
      phase,
      failedAuditRecorded,
      maintenanceReleased: leaseReleased,
      maintenanceExpiresAt: leaseReleased ? '' : String(lease?.expiresAt || ''),
    };
    throw error;
  } finally {
    if (renewalTimer) clearInterval(renewalTimer);
    closeDatabase();
  }
}

main().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error.message,
    ...(error.rollingRestart || {}),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
