process.umask(0o077);

const os = require('os');
const {
  ensureStorage,
  claimPendingCommands,
  finishClaimedCommand,
  deferClaimedCommand,
  failClaimedCommand,
  acquireTaskLease,
  releaseTaskLease,
  recoverExpiredTasks,
  getSession,
  claimDueScheduledJobs,
  dispatchClaimedScheduledJob,
  claimExternalAttemptArchives,
  processExternalAttemptArchive,
  claimSkillReportArtifactJobs,
  processSkillReportArtifactJob,
  claimExternalArchiveVerifications,
  processExternalArchiveVerification,
  claimBridgeCleanupJobs,
  processBridgeCleanupJob,
  performTaskRetentionCleanup,
  reconcileRunningExternalAttempts,
} = require('./src/store');
const {
  syncBridgeRuntime,
  getRuntimeStatus,
  startSession,
  pollCancellations,
  heartbeatActive,
  listActiveSessions,
  shutdownWorker,
} = require('./src/orchestrator');
const { nowIso } = require('./src/utils');
const { closeDatabase } = require('./src/database');
const { resolveWorkingDir } = require('./src/workspaces');

const WORKER_ID = `${os.hostname()}:${process.pid}:${Date.now().toString(36)}`;
const COMMAND_CLAIM_BATCH_SIZE = 64;
const MAX_CONSECUTIVE_POLL_FAILURES = 20;
const MAX_CONSECUTIVE_CONTROL_FAILURES = 5;
const TASK_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
let stopping = false;
let ticking = false;
let cleanupTicking = false;
let archiveTicking = false;
let reconciliationTicking = false;
let retentionTicking = false;
let consecutivePollFailures = 0;
const controlFailures = new Map();

function exitWorker(code) {
  try { closeDatabase(); } catch {}
  process.exit(code);
}

function reportTimerFailure(name, error) {
  console.error(`[worker:${name}] ${error?.stack || error?.message || error}`);
}

function runTimer(name, callback) {
  try {
    Promise.resolve(callback())
      .then(() => recordControlSuccess(name))
      .catch((error) => recordControlFailure(name, error));
  } catch (error) {
    recordControlFailure(name, error);
  }
}

function recordControlSuccess(name) {
  const failures = Number(controlFailures.get(name) || 0);
  if (!failures) return;
  controlFailures.delete(name);
  if (!stopping) console.error(`[worker:${name}] recovered after ${failures} consecutive failures`);
}

function recordControlFailure(name, error) {
  const failures = Number(controlFailures.get(name) || 0) + 1;
  controlFailures.set(name, failures);
  if (failures === 1 || failures % MAX_CONSECUTIVE_CONTROL_FAILURES === 0) {
    reportTimerFailure(`${name}:${failures}`, error);
  }
  if (failures < MAX_CONSECUTIVE_CONTROL_FAILURES || stopping) return;
  console.error(`[worker:${name}] restarting after ${failures} consecutive failures`);
  shutdown(1, true);
}

function recordPollFailure(error) {
  consecutivePollFailures += 1;
  if (consecutivePollFailures === 1 || consecutivePollFailures % 5 === 0) {
    reportTimerFailure(`poll:${consecutivePollFailures}`, error);
  }
  if (consecutivePollFailures < MAX_CONSECUTIVE_POLL_FAILURES || stopping) return;
  console.error(`[worker:poll] restarting after ${consecutivePollFailures} consecutive poll failures`);
  shutdown(1, true);
}

function runPoll() {
  try {
    Promise.resolve(tick()).then((ran) => {
      if (!ran || consecutivePollFailures === 0) return;
      console.error(`[worker:poll] recovered after ${consecutivePollFailures} consecutive failures`);
      consecutivePollFailures = 0;
    }).catch(recordPollFailure);
  } catch (error) {
    recordPollFailure(error);
  }
}

ensureStorage();
syncBridgeRuntime();
recoverExpiredTasks();
heartbeatActive(WORKER_ID);

function failCommand(command, error) {
  failClaimedCommand(command.id, WORKER_ID, error);
}

async function tick() {
  if (ticking || stopping) return false;
  ticking = true;
  try {
    pollCancellations();
    const initialRuntime = getRuntimeStatus();
    if (!initialRuntime.ready) {
      heartbeatActive(WORKER_ID);
      return true;
    }
    const scheduledJobs = claimDueScheduledJobs(WORKER_ID, COMMAND_CLAIM_BATCH_SIZE);
    for (const job of scheduledJobs) {
      try {
        dispatchClaimedScheduledJob(job.id, WORKER_ID);
      } catch (error) {
        reportTimerFailure('scheduler-dispatch', error);
      }
    }
    const commands = claimPendingCommands(WORKER_ID, COMMAND_CLAIM_BATCH_SIZE);
    for (const command of commands) {
      const task = getSession(command.task_id);
      if (!task || task.status === 'stopping' || task.status === 'stopped') {
        finishClaimedCommand(command.id, WORKER_ID, 'cancelled', 'Task was stopped before execution');
        continue;
      }
      try {
        resolveWorkingDir(task.workingDir);
      } catch (error) {
        if (acquireTaskLease(command.task_id, WORKER_ID)) failCommand(command, error);
        else deferClaimedCommand(command.id, WORKER_ID, 'Waiting for the previous task lease to expire');
        continue;
      }
      if (!acquireTaskLease(command.task_id, WORKER_ID)) {
        deferClaimedCommand(command.id, WORKER_ID, 'Waiting for the previous task lease to expire');
        continue;
      }
      try {
        const runtime = getRuntimeStatus();
        if (!runtime.ready) {
          releaseTaskLease(command.task_id, WORKER_ID);
          deferClaimedCommand(command.id, WORKER_ID, `Execution readiness degraded: ${runtime.degradedReasons.join(', ')}`);
          continue;
        }
        await startSession(command, WORKER_ID);
        heartbeatActive(WORKER_ID);
      } catch (error) {
        failCommand(command, error);
      }
    }
    heartbeatActive(WORKER_ID);
  } finally {
    ticking = false;
  }
  return true;
}

function runBridgeCleanupCycle() {
  if (cleanupTicking || stopping) return;
  cleanupTicking = true;
  try {
    const jobs = claimBridgeCleanupJobs(WORKER_ID, 1);
    for (const job of jobs) {
      const result = processBridgeCleanupJob(job, WORKER_ID);
      if (!result.ok) reportTimerFailure('bridge-cleanup', new Error(result.error));
    }
  } finally {
    cleanupTicking = false;
  }
}

async function runExternalArchiveCycle() {
  if (archiveTicking || stopping) return;
  archiveTicking = true;
  try {
    const [artifactJob] = claimSkillReportArtifactJobs(WORKER_ID, 1);
    if (artifactJob) {
      const result = await processSkillReportArtifactJob(artifactJob.report_id, WORKER_ID);
      if (!result.ok && !result.lostLease && result.exhausted) {
        reportTimerFailure('report-artifact', new Error(result.error || 'Report artifact archival failed'));
      }
      return;
    }
    const [attempt] = claimExternalAttemptArchives(WORKER_ID, 1);
    if (attempt) {
      const result = await processExternalAttemptArchive(attempt.id, WORKER_ID);
      if (!result.ok && !result.lostLease) {
        reportTimerFailure('external-archive', new Error(result.error || 'Background log preservation failed'));
      }
      return;
    }
    const [verification] = claimExternalArchiveVerifications(WORKER_ID, 1);
    if (!verification) return;
    const result = await processExternalArchiveVerification(verification.id, WORKER_ID);
    if (!result.ok && !result.lostLease) {
      reportTimerFailure('external-archive', new Error(result.error || 'Background log integrity verification failed'));
    }
  } finally {
    archiveTicking = false;
  }
}

function runExternalReconciliationCycle() {
  if (reconciliationTicking || stopping) return;
  reconciliationTicking = true;
  try {
    reconcileRunningExternalAttempts();
  } finally {
    reconciliationTicking = false;
  }
}

function runTaskRetentionCycle() {
  if (retentionTicking || stopping) return;
  retentionTicking = true;
  try {
    const result = performTaskRetentionCleanup({ owner: `retention:${WORKER_ID}` });
    if (!result.ok) {
      reportTimerFailure(
        'retention',
        new Error(`Task retention cleanup was incomplete: failedTasks=${result.failedTasks || 0}`),
      );
    }
  } finally {
    retentionTicking = false;
  }
}

const pollTimer = setInterval(runPoll, 250);
const heartbeatTimer = setInterval(() => runTimer('heartbeat', () => heartbeatActive(WORKER_ID)), 2000);
const bridgeCleanupTimer = setInterval(() => runTimer('bridge-cleanup', runBridgeCleanupCycle), 1000);
const externalArchiveTimer = setInterval(() => runTimer('external-archive', runExternalArchiveCycle), 1000);
const externalReconciliationTimer = setInterval(
  () => runTimer('external-reconciliation', runExternalReconciliationCycle),
  1000,
);
const taskRetentionTimer = setInterval(
  () => runTimer('retention', runTaskRetentionCycle),
  TASK_RETENTION_INTERVAL_MS,
);
const recoveryTimer = setInterval(() => runTimer('recovery', () => {
  if (!stopping) recoverExpiredTasks();
}), 5000);

runPoll();
runBridgeCleanupCycle();
runTimer('external-reconciliation', runExternalReconciliationCycle);
runTimer('external-archive', runExternalArchiveCycle);
runTimer('retention', runTaskRetentionCycle);
console.log(`[codex-worker] ready ${WORKER_ID} at ${nowIso()}`);

function shutdown(exitCode = 0, force = false) {
  if (stopping) return;
  stopping = true;
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);
  clearInterval(bridgeCleanupTimer);
  clearInterval(externalArchiveTimer);
  clearInterval(externalReconciliationTimer);
  clearInterval(taskRetentionTimer);
  clearInterval(recoveryTimer);
  shutdownWorker(force);
  const deadline = Date.now() + 4000;
  const shutdownTimer = setInterval(() => {
    if (!listActiveSessions().length && !archiveTicking) {
      clearInterval(shutdownTimer);
      exitWorker(exitCode);
    }
    if (Date.now() >= deadline) {
      clearInterval(shutdownTimer);
      shutdownWorker(true);
      setTimeout(() => exitWorker(1), 250).unref();
    }
  }, 50);
}

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('disconnect', () => shutdown());
process.on('uncaughtException', (error) => {
  reportTimerFailure('fatal', error);
  shutdown(1, true);
});
process.on('unhandledRejection', (error) => {
  reportTimerFailure('fatal', error);
  shutdown(1, true);
});
