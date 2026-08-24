#!/usr/bin/env node

process.umask(0o077);

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT_DIR, RUNTIME_DIR } = require('../src/paths');
const {
  inspectProcess,
  sameProcess,
  signalVerifiedProcessGroup,
} = require('../src/process-identity');

const LOCK_DIRECTORY = path.join(RUNTIME_DIR, 'web-supervisor.lock');
const OWNER_FILE = path.join(LOCK_DIRECTORY, 'owner.json');
const STABLE_UPTIME_MS = 30000;
const MAX_RESTART_DELAY_MS = 30000;
const SHUTDOWN_TIMEOUT_MS = 310000;
const ORPHAN_GROUP_GRACE_MS = 5000;

let releaseLock = null;
let serverProcess = null;
let serverIdentity = null;
let serverStartedAt = 0;
let restartAttempts = 0;
let restartTimer = null;
const orphanCleanupTimers = new Set();
let shutdownTimer = null;
let stopping = false;
let finished = false;
let shutdownExitCode = 0;

function syncPath(targetPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(targetPath, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Web supervisor runtime storage is not a private directory');
  }
  fs.chmodSync(directory, 0o700);
}

function writePrivateJson(filePath, value) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readLockOwner() {
  try {
    const stat = fs.lstatSync(OWNER_FILE);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'));
    return owner && typeof owner === 'object' && !Array.isArray(owner) ? owner : null;
  } catch {
    return null;
  }
}

function acquireSupervisorLock() {
  ensurePrivateDirectory(RUNTIME_DIR);
  const identity = inspectProcess(process.pid);
  if (!identity) throw new Error('Cannot establish web supervisor process identity');
  const owner = {
    token: crypto.randomUUID(),
    ...identity,
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    let created = false;
    try {
      fs.mkdirSync(LOCK_DIRECTORY, { mode: 0o700 });
      created = true;
      fs.chmodSync(LOCK_DIRECTORY, 0o700);
      writePrivateJson(OWNER_FILE, owner);
      syncPath(LOCK_DIRECTORY);
      syncPath(RUNTIME_DIR);
      return () => {
        const currentOwner = readLockOwner();
        if (currentOwner?.token !== owner.token) return;
        fs.rmSync(LOCK_DIRECTORY, { recursive: true, force: true });
        syncPath(RUNTIME_DIR);
      };
    } catch (error) {
      if (created) {
        try { fs.rmSync(LOCK_DIRECTORY, { recursive: true, force: true }); } catch {}
        throw error;
      }
      if (error.code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(LOCK_DIRECTORY);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Web supervisor lock is unsafe');
      }
      const existingOwner = readLockOwner();
      if (sameProcess(existingOwner)
        || (!existingOwner && Date.now() - stat.mtimeMs < 30000)) {
        const activeError = new Error('A web supervisor is already running');
        activeError.code = 'WEB_SUPERVISOR_ACTIVE';
        throw activeError;
      }
      const staleDirectory = path.join(
        RUNTIME_DIR,
        `.stale-web-supervisor-lock-${crypto.randomUUID()}`,
      );
      try {
        fs.renameSync(LOCK_DIRECTORY, staleDirectory);
        fs.rmSync(staleDirectory, { recursive: true, force: true });
        syncPath(RUNTIME_DIR);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') throw cleanupError;
      }
    }
  }
  throw new Error('Web supervisor lock could not be acquired');
}

function childEnvironment() {
  const identity = inspectProcess(process.pid);
  if (!identity) throw new Error('Web supervisor identity became unavailable');
  const environment = {
    ...process.env,
    CODEX_REQUIRE_WEB_SUPERVISOR: '1',
    CODEX_WEB_SUPERVISOR_PID: String(identity.pid),
    CODEX_WEB_SUPERVISOR_START_TICKS: identity.startTicks,
  };
  delete environment.CODEX_HOST_LAUNCHER_PID;
  delete environment.CODEX_HOST_LAUNCHER_START_TICKS;
  if (process.env.CODEX_REQUIRE_HOST_LAUNCHER === '1') {
    const launcher = inspectProcess(identity.parentPid);
    if (!launcher) throw new Error('Host launcher identity is unavailable');
    environment.CODEX_HOST_LAUNCHER_PID = String(launcher.pid);
    environment.CODEX_HOST_LAUNCHER_START_TICKS = launcher.startTicks;
  }
  return environment;
}

function scheduleOrphanGroupCleanup(identity) {
  if (!identity) return;
  const timer = setTimeout(() => {
    orphanCleanupTimers.delete(timer);
    try {
      const result = signalVerifiedProcessGroup(identity, 'SIGKILL');
      if (result.signalled) {
        console.error(`[web-supervisor] force-terminated residual server group ${identity.processGroupId}`);
      }
    } catch (error) {
      console.error(`[web-supervisor] residual server cleanup failed: ${error.message}`);
    }
  }, ORPHAN_GROUP_GRACE_MS);
  orphanCleanupTimers.add(timer);
  timer.unref();
}

function scheduleRestart() {
  if (stopping || restartTimer) return;
  restartAttempts += 1;
  const delay = Math.min(
    MAX_RESTART_DELAY_MS,
    1000 * (2 ** Math.min(5, restartAttempts - 1)),
  );
  console.error(`[web-supervisor] restarting web process in ${delay} ms`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startServer();
  }, delay);
}

function completeShutdown(exitCode = 0) {
  if (finished) return;
  finished = true;
  if (restartTimer) clearTimeout(restartTimer);
  for (const timer of orphanCleanupTimers) clearTimeout(timer);
  orphanCleanupTimers.clear();
  if (shutdownTimer) clearTimeout(shutdownTimer);
  restartTimer = null;
  shutdownTimer = null;
  try { releaseLock?.(); } catch (error) {
    console.error(`[web-supervisor] lock release failed: ${error.message}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

function startServer() {
  if (stopping || serverProcess) return;
  let child;
  try {
    child = spawn(process.execPath, [path.join(ROOT_DIR, 'server.js')], {
      cwd: ROOT_DIR,
      env: childEnvironment(),
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    });
  } catch (error) {
    console.error(`[web-supervisor] web process spawn failed: ${error.stack || error.message}`);
    scheduleRestart();
    return;
  }
  serverProcess = child;
  serverStartedAt = Date.now();
  serverIdentity = inspectProcess(child.pid);
  console.log(`[web-supervisor] started web process ${child.pid}`);
  child.once('spawn', () => {
    serverIdentity = inspectProcess(child.pid);
  });
  child.on('error', (error) => {
    console.error(`[web-supervisor] web process error: ${error.stack || error.message}`);
  });
  child.on('exit', (code, signal) => {
    if (serverProcess !== child) return;
    const uptime = Date.now() - serverStartedAt;
    const exitedIdentity = serverIdentity;
    serverProcess = null;
    serverIdentity = null;
    serverStartedAt = 0;
    if (stopping) {
      const childExitCode = code === 0 || signal === 'SIGTERM' ? 0 : 1;
      completeShutdown(Math.max(shutdownExitCode, childExitCode));
      return;
    }
    console.error(`[web-supervisor] web process exited code=${code ?? 'null'} signal=${signal || 'none'}`);
    if (uptime >= STABLE_UPTIME_MS) restartAttempts = 0;
    scheduleOrphanGroupCleanup(exitedIdentity);
    scheduleRestart();
  });
}

function shutdown(exitCode = 0) {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  if (!serverProcess || serverProcess.exitCode != null || serverProcess.signalCode != null) {
    completeShutdown(shutdownExitCode);
    return;
  }
  const child = serverProcess;
  if (!child.kill('SIGTERM')) {
    completeShutdown(1);
    return;
  }
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    try {
      const result = signalVerifiedProcessGroup(serverIdentity, 'SIGKILL');
      if (!result.signalled && child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    } catch (error) {
      console.error(`[web-supervisor] forced shutdown failed: ${error.message}`);
      try { child.kill('SIGKILL'); } catch {}
    }
  }, SHUTDOWN_TIMEOUT_MS);
  shutdownTimer.unref();
}

try {
  releaseLock = acquireSupervisorLock();
  startServer();
} catch (error) {
  console.error(`[web-supervisor] ${error.stack || error.message}`);
  try { releaseLock?.(); } catch {}
  process.exit(error.code === 'WEB_SUPERVISOR_ACTIVE' ? 78 : 1);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('uncaughtException', (error) => {
  console.error(`[web-supervisor] uncaught exception: ${error.stack || error.message}`);
  shutdown(1);
});
process.on('unhandledRejection', (error) => {
  console.error(`[web-supervisor] unhandled rejection: ${error?.stack || error?.message || error}`);
  shutdown(1);
});
