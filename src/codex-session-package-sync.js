const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const PACKAGE_LOCK_TIMEOUT_MS = 30000;
const PACKAGE_LOCK_STALE_MS = 120000;
const PACKAGE_KILL_GRACE_MS = 2000;

const {
  resolveBridgeSessionRuntime,
  sessionDaemonProcesses,
  releaseSessionRuntimeProcessesAndWait,
} = require('./bridge-runtime-cleanup');

function runCommand(command, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    let forceKillTimer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch {}
      }, PACKAGE_KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', error => {
      finish(error);
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(new Error(`Codex version command timed out: ${command} ${args.join(' ')}`));
        return;
      }
      finish(null, {
        code: code == null ? 1 : code,
        signal: signal || '',
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function cliVersion(output) {
  const match = String(output || '').match(/(?:codex-cli|codex)\s+([0-9]+\.[0-9]+\.[0-9]+)/i);
  return match?.[1] || '';
}

function packageVersion(packageRoot) {
  const manifestPath = path.join(packageRoot, 'current', 'codex-package.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '';
  } catch {
    return '';
  }
}

function removePath(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (stat.isSymbolicLink() || stat.isFile()) fs.unlinkSync(target);
  else if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else throw new Error(`Daemon package target is not a regular path: ${target}`);
}

function ensureDirectoryChain(target) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Daemon package parent is not a private directory: ${current}`);
    }
  }
}

function assertPackageLinksStayInside(source) {
  const root = fs.realpathSync(source);
  const visit = target => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      const link = fs.readlinkSync(target);
      if (path.isAbsolute(link)) throw new Error(`Daemon package contains an absolute symbolic link: ${target}`);
      const resolved = fs.realpathSync(target);
      const relative = path.relative(root, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Daemon package symbolic link escapes its source: ${target}`);
      }
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
  };
  visit(source);
}

function copyPackage(source, target) {
  const parent = path.dirname(target);
  ensureDirectoryChain(parent);
  assertPackageLinksStayInside(source);
  const temporary = path.join(parent, `.${path.basename(target)}.sync-${process.pid}-${Date.now()}`);
  removePath(temporary);
  try {
    fs.cpSync(source, temporary, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    if (!packageVersion(temporary)) throw new Error('Synchronized daemon package has no valid version manifest');
    const backup = path.join(parent, `.${path.basename(target)}.old-${process.pid}-${Date.now()}`);
    removePath(backup);
    if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) fs.renameSync(target, backup);
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, target);
      throw error;
    }
    removePath(backup);
  } catch (error) {
    removePath(temporary);
    throw error;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function restorePackageLock(quarantinePath, lockPath) {
  try {
    fs.linkSync(quarantinePath, lockPath);
    fs.unlinkSync(quarantinePath);
  } catch (error) {
    if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
    removePath(quarantinePath);
  }
}

function reclaimStalePackageLock(lockPath, observed) {
  const quarantinePath = `${lockPath}.stale-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockPath, quarantinePath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  try {
    const quarantinedStat = fs.lstatSync(quarantinePath, { bigint: true });
    if (String(quarantinedStat.dev) !== String(observed.dev)
      || String(quarantinedStat.ino) !== String(observed.ino)) {
      restorePackageLock(quarantinePath, lockPath);
      return false;
    }
    removePath(quarantinePath);
    return true;
  } catch (error) {
    restorePackageLock(quarantinePath, lockPath);
    throw error;
  }
}

async function withPackageLock(targetPackage, action, delay = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const lockPath = path.join(path.dirname(targetPackage), '.app-server-daemon.sync.lock');
  const deadline = Date.now() + PACKAGE_LOCK_TIMEOUT_MS;
  let descriptor;
  while (Date.now() < deadline) {
    let lockCreated = false;
    try {
      descriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      lockCreated = true;
      fs.writeFileSync(descriptor, JSON.stringify({
        pid: process.pid,
        createdAt: Date.now(),
      }));
      fs.closeSync(descriptor);
      descriptor = undefined;
      try { return await action(); } finally { removePath(lockPath); }
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
        descriptor = undefined;
      }
      if (lockCreated && error.code !== 'EEXIST') removePath(lockPath);
      if (error.code !== 'EEXIST') throw error;
      try {
        const lockStat = fs.lstatSync(lockPath, { bigint: true });
        const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (Date.now() - Number(lock.createdAt) > PACKAGE_LOCK_STALE_MS && !processAlive(Number(lock.pid))) {
          if (reclaimStalePackageLock(lockPath, lockStat)) continue;
        }
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
      }
      await delay(100);
    }
  }
  throw new Error(`Timed out waiting for Session daemon package lock: ${lockPath}`);
}

async function syncSessionDaemonPackage({
  sessionKey,
  runtime,
  codexBinary = '',
  sourceHome = process.env.CODEX_SOURCE_HOME || process.env.SOURCE_CODEX_HOME || '/home/jenkins/.codex',
  listProcesses = sessionDaemonProcesses,
  releaseProcesses = releaseSessionRuntimeProcessesAndWait,
  execute = runCommand,
  isLeaseValid = () => true,
} = {}) {
  const assertLease = () => {
    if (!isLeaseValid()) throw new Error('Session startup lease was lost during daemon package synchronization');
  };
  const sourcePackage = path.join(path.resolve(sourceHome), 'packages', 'app-server-daemon');
  const sourceVersion = packageVersion(sourcePackage);
  if (!sourceVersion) return { status: 'skipped', reason: 'global_package_unavailable' };
  assertLease();
  if (codexBinary) {
    const versionResult = await execute(codexBinary, ['--version']);
    assertLease();
    const globalCliVersion = versionResult.code === 0 ? cliVersion(versionResult.stdout) : '';
    if (!globalCliVersion || globalCliVersion !== sourceVersion) {
      throw new Error(
        `Global Codex CLI ${globalCliVersion || 'unknown'} and daemon package ${sourceVersion} differ; `
        + 'run `codex app-server daemon update --from-cli -y` before starting a new Task',
      );
    }
  }
  const sessionRuntime = runtime || (sessionKey ? resolveBridgeSessionRuntime(sessionKey) : null);
  if (!sessionRuntime?.codexHome) return { status: 'deferred', reason: 'session_runtime_unavailable', version: sourceVersion };
  const targetPackage = path.join(path.resolve(sessionRuntime.codexHome), 'packages', 'app-server-daemon');
  ensureDirectoryChain(path.dirname(targetPackage));
  return withPackageLock(targetPackage, async () => {
    assertLease();
    const targetVersion = packageVersion(targetPackage);
    if (targetVersion === sourceVersion) return { status: 'current', version: sourceVersion };

    const active = listProcesses(sessionRuntime.sessionId, sessionRuntime.codexHome, { includeIdentity: true });
    if (active.length) {
      const released = await releaseProcesses(sessionRuntime, {
        includeCliMain: true,
        canRelease: isLeaseValid,
      });
      if (released.errors.length) {
        throw new Error(`Session daemon could not be drained: ${released.errors.map(item => `${item.pid}: ${item.error}`).join('; ')}`);
      }
    }
    assertLease();
    copyPackage(sourcePackage, targetPackage);
    return { status: 'updated', previousVersion: targetVersion || null, version: sourceVersion };
  });
}

module.exports = {
  packageVersion,
  syncSessionDaemonPackage,
};
