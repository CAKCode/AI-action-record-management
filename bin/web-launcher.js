#!/usr/bin/env node

process.umask(0o077);

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT_DIR, RUNTIME_DIR } = require('../src/paths');
const { inspectProcess, sameProcess } = require('../src/process-identity');
const { RotatingLog, supervisorLogOptions } = require('../src/rotating-log');
const { restartEnvironment } = require('../src/launcher-environment');

const SUPERVISOR = path.join(ROOT_DIR, 'bin', 'web-supervisor.js');
const LOCK_DIRECTORY = path.join(RUNTIME_DIR, 'web-launcher.lock');
const OWNER_FILE = path.join(LOCK_DIRECTORY, 'owner.json');
const STABLE_UPTIME_MS = 30000;
const MAX_RESTART_DELAY_MS = 30000;
const SHUTDOWN_TIMEOUT_MS = 315000;

let releaseLock = null;
let managedLog = null;
let supervisor = null;
let supervisorStartedAt = 0;
let restartAttempts = 0;
let restartTimer = null;
let shutdownTimer = null;
let stopping = false;
let finished = false;
let shutdownExitCode = 0;

function syncPath(targetPath) {
  const descriptor = fs.openSync(targetPath, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Web launcher runtime storage is not a private directory');
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
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return null;
    const owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'));
    return owner && typeof owner === 'object' && !Array.isArray(owner) ? owner : null;
  } catch {
    return null;
  }
}

function acquireLauncherLock() {
  ensurePrivateDirectory(RUNTIME_DIR);
  const identity = inspectProcess(process.pid);
  if (!identity) throw new Error('Cannot establish web launcher process identity');
  const owner = {
    token: crypto.randomUUID(),
    ...identity,
    createdAt: new Date().toISOString(),
    deploymentRoot: fs.realpathSync(ROOT_DIR),
    restartEnvironment: restartEnvironment(),
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
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Web launcher lock is unsafe');
      const existingOwner = readLockOwner();
      if (sameProcess(existingOwner)
        || (!existingOwner && Date.now() - stat.mtimeMs < 30000)) {
        const activeError = new Error('A web launcher is already running');
        activeError.code = 'WEB_LAUNCHER_ACTIVE';
        throw activeError;
      }
      const staleDirectory = path.join(RUNTIME_DIR, `.stale-web-launcher-lock-${crypto.randomUUID()}`);
      try {
        fs.renameSync(LOCK_DIRECTORY, staleDirectory);
        fs.rmSync(staleDirectory, { recursive: true, force: true });
        syncPath(RUNTIME_DIR);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') throw cleanupError;
      }
    }
  }
  throw new Error('Web launcher lock could not be acquired');
}

function writeOutput(value, error = false) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  if (managedLog) {
    try {
      managedLog.write(content);
      return;
    } catch (logError) {
      try { managedLog.close(); } catch {}
      managedLog = null;
      try { process.stderr.write(`[web-launcher] managed log failed: ${logError.message}\n`); } catch {}
    }
  }
  try { (error ? process.stderr : process.stdout).write(content); } catch {}
}

function logError(message) {
  writeOutput(`${message}\n`, true);
}

function supervisorExitStatus(code, signal) {
  if (code != null) return code;
  const signalNumber = Number(os.constants.signals[signal] || 0);
  return signalNumber ? 128 + signalNumber : 1;
}

function completeShutdown(exitCode = 0) {
  if (finished) return;
  finished = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (shutdownTimer) clearTimeout(shutdownTimer);
  restartTimer = null;
  shutdownTimer = null;
  try { releaseLock?.(); } catch (error) {
    logError(`[web-launcher] lock release failed: ${error.message}`);
    exitCode = 1;
  }
  try { managedLog?.close(); } catch (error) {
    try { process.stderr.write(`[web-launcher] managed log close failed: ${error.message}\n`); } catch {}
    exitCode = 1;
  }
  managedLog = null;
  process.exit(exitCode);
}

function scheduleRestart(status) {
  if (stopping || restartTimer) return;
  if (status === 78) {
    completeShutdown(78);
    return;
  }
  restartAttempts += 1;
  const delay = Math.min(
    MAX_RESTART_DELAY_MS,
    1000 * (2 ** Math.min(5, restartAttempts - 1)),
  );
  logError(`[web-launcher] web supervisor exited status=${status}; restarting in ${delay / 1000}s`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startSupervisor();
  }, delay);
}

function startSupervisor() {
  if (stopping || supervisor) return;
  const environment = { ...process.env, CODEX_REQUIRE_HOST_LAUNCHER: '1' };
  delete environment.CODEX_MANAGED_WEB_SUPERVISOR_LOG;
  let child;
  try {
    child = spawn(process.execPath, [SUPERVISOR], {
      cwd: ROOT_DIR,
      env: environment,
      stdio: managedLog ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
  } catch (error) {
    logError(`[web-launcher] web supervisor spawn failed: ${error.stack || error.message}`);
    scheduleRestart(1);
    return;
  }
  supervisor = child;
  supervisorStartedAt = Date.now();
  writeOutput(`[web-launcher] started web supervisor pid=${child.pid}\n`);
  if (managedLog) {
    child.stdout.on('data', (chunk) => writeOutput(chunk));
    child.stderr.on('data', (chunk) => writeOutput(chunk, true));
  }
  child.on('error', (error) => {
    logError(`[web-launcher] web supervisor process error: ${error.stack || error.message}`);
  });
  child.on('close', (code, signal) => {
    if (supervisor !== child) return;
    const uptime = Date.now() - supervisorStartedAt;
    const status = supervisorExitStatus(code, signal);
    supervisor = null;
    supervisorStartedAt = 0;
    if (stopping) {
      const childExitCode = code === 0 || signal === 'SIGTERM' ? 0 : 1;
      completeShutdown(Math.max(shutdownExitCode, childExitCode));
      return;
    }
    if (uptime >= STABLE_UPTIME_MS) restartAttempts = 0;
    scheduleRestart(status);
  });
}

function shutdown(exitCode = 0) {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  if (!supervisor || supervisor.exitCode != null || supervisor.signalCode != null) {
    completeShutdown(shutdownExitCode);
    return;
  }
  const child = supervisor;
  if (!child.kill('SIGTERM')) {
    completeShutdown(1);
    return;
  }
  shutdownTimer = setTimeout(() => {
    shutdownTimer = null;
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }, SHUTDOWN_TIMEOUT_MS);
  shutdownTimer.unref();
}

try {
  releaseLock = acquireLauncherLock();
  if (process.env.CODEX_WEB_SUPERVISOR_LOG_STDIO !== '1') {
    const options = supervisorLogOptions(RUNTIME_DIR);
    managedLog = new RotatingLog(options.filePath, options);
  }
  writeOutput(`[web-launcher] started pid=${process.pid} logging=${managedLog ? 'managed' : 'stdio'}\n`);
  startSupervisor();
} catch (error) {
  try { managedLog?.close(); } catch {}
  try { releaseLock?.(); } catch {}
  process.stderr.write(`[web-launcher] ${error.stack || error.message}\n`);
  process.exit(error.code === 'WEB_LAUNCHER_ACTIVE' ? 78 : 1);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('uncaughtException', (error) => {
  logError(`[web-launcher] uncaught exception: ${error.stack || error.message}`);
  shutdown(1);
});
process.on('unhandledRejection', (error) => {
  logError(`[web-launcher] unhandled rejection: ${error?.stack || error?.message || error}`);
  shutdown(1);
});
