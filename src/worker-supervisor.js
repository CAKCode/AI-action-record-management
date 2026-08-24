const path = require('path');
const { fork } = require('child_process');
const { ROOT_DIR } = require('./paths');
const { inspectProcess, sameProcess, signalVerifiedProcessGroup } = require('./process-identity');

const WORKER_GRACEFUL_SHUTDOWN_MS = 4500;
const WORKER_FORCE_EXIT_WAIT_MS = 6500;

let worker = null;
let stopping = false;
let restartTimer = null;
let restartAttempts = 0;
let workerStartedAt = 0;
let stopPromise = null;
const executionGroups = new Map();

function killTrackedExecutionGroups() {
  for (const [registrationId, identity] of executionGroups) {
    try {
      const result = signalVerifiedProcessGroup(identity, 'SIGKILL');
      if (!result.signalled && result.reason === 'identity_mismatch') {
        console.error(`[codex-worker] skipped stale execution registration ${registrationId}`);
      }
    } catch (error) {
      console.error(`[codex-worker] failed to terminate execution ${registrationId}: ${error.message}`);
    }
  }
  executionGroups.clear();
}

function replyToWorker(child, message) {
  if (!child.connected) return;
  try { child.send(message); } catch {}
}

function registerExecution(child, message) {
  const registrationId = String(message?.registrationId || '');
  const supplied = message?.identity || {};
  const pid = Number(supplied.pid);
  const current = inspectProcess(pid);
  const identity = current && {
    pid,
    parentPid: Number(supplied.parentPid),
    processGroupId: Number(supplied.processGroupId),
    sessionId: Number(supplied.sessionId),
    startTicks: String(supplied.startTicks || ''),
  };
  const valid = registrationId
    && identity
    && sameProcess(identity, {
      requireGroupLeader: true,
      requireSessionLeader: true,
      parentPid: child.pid,
    });
  if (!valid) {
    replyToWorker(child, {
      type: 'supervisor.execution.rejected',
      registrationId,
      error: 'Execution process identity could not be verified',
    });
    return;
  }
  executionGroups.set(registrationId, identity);
  replyToWorker(child, { type: 'supervisor.execution.registered', registrationId });
}

function workerEnvironment() {
  const environment = { ...process.env };
  delete environment.CODEX_DESK_AUTH_USER;
  delete environment.CODEX_DESK_AUTH_PASSWORD;
  return environment;
}

function scheduleRestart() {
  restartAttempts += 1;
  const delay = Math.min(30000, 1000 * (2 ** Math.min(5, restartAttempts - 1)));
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startWorker();
  }, delay);
  restartTimer.unref();
}

function startWorker() {
  if (process.env.CODEX_DISABLE_WORKER === '1' || worker || stopping) return null;
  try {
    worker = fork(path.join(ROOT_DIR, 'worker.js'), [], {
      cwd: ROOT_DIR,
      env: workerEnvironment(),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
  } catch (error) {
    console.error(`[codex-worker] failed to start: ${error.stack || error.message}`);
    scheduleRestart();
    return null;
  }
  workerStartedAt = Date.now();
  const child = worker;
  worker.on('message', (message) => {
    if (message?.type === 'execution.register') {
      registerExecution(child, message);
      return;
    }
    if (message?.type === 'execution.finished') {
      executionGroups.delete(String(message.registrationId || ''));
    }
  });
  worker.on('error', (error) => {
    console.error(`[codex-worker] process error: ${error.stack || error.message}`);
  });
  worker.on('exit', (code, signal) => {
    const uptime = Date.now() - workerStartedAt;
    killTrackedExecutionGroups();
    worker = null;
    if (stopping) return;
    console.error(`[codex-worker] exited code=${code ?? 'null'} signal=${signal || 'none'}; restarting`);
    if (uptime >= 30000) restartAttempts = 0;
    scheduleRestart();
  });
  return worker;
}

function stopWorker() {
  if (stopPromise) return stopPromise;
  stopping = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (!worker || worker.exitCode != null) {
    stopPromise = Promise.resolve();
    return stopPromise;
  }
  stopPromise = new Promise((resolve, reject) => {
    const child = worker;
    let forceTimer;
    let failureTimer;
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(failureTimer);
      if (error) reject(error);
      else resolve();
    };
    child.once('exit', () => {
      worker = null;
      finish();
    });
    if (!child.kill('SIGTERM')) {
      finish(new Error('Worker could not be signalled for shutdown'));
      return;
    }
    // The worker gives its execution children up to four seconds to stop and
    // persist an interrupted state. Keep the supervisor deadline beyond that
    // window so it cannot kill the worker while its final transaction runs.
    forceTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }, WORKER_GRACEFUL_SHUTDOWN_MS);
    failureTimer = setTimeout(() => finish(new Error('Worker did not exit after SIGKILL')), WORKER_FORCE_EXIT_WAIT_MS);
  });
  return stopPromise;
}

module.exports = {
  startWorker,
  stopWorker,
};
