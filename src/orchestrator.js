const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { parser: createJsonParser } = require('stream-json');
const {
  ROOT_DIR,
  RUNTIME_DIR,
} = require('./paths');
const {
  nowIso,
  deepClone,
  stripAnsi,
  tailSummary,
  sleep,
} = require('./utils');
const {
  pathEntryExists,
  ensureManagedDirectory,
  readManagedTextTail,
} = require('./managed-storage');
const {
  countSkills,
  countExecutingSessions,
  listActiveProcessIdentities,
  refreshSourceSkills,
  getSession,
  appendSessionWorklog,
  appendRuntimeWorklog,
  appendSessionLatestLog,
  beginSessionTurn,
  createAttempt,
  prepareSessionBridgeOutputFile,
  prepareAttemptOutputFiles,
  registerAttemptProcess,
  failClaimedCommand,
  prepareSessionRetry,
  renewTaskLease,
  ensureTaskSkillSnapshot,
  finalizeSessionTurn,
  setMetadata,
  getMetadata,
  getPlatformMaintenance,
} = require('./store');
const { ensureWorkspaceRoots, resolveWorkingDir, workspaceStatus } = require('./workspaces');
const { storageCapacityStatus } = require('./storage-capacity');
const {
  inspectProcess,
  sameProcess,
  processGroupStillBelongsTo,
  signalVerifiedProcessGroup,
} = require('./process-identity');
const {
  BRIDGE_BOT_ID,
  BRIDGE_RUNTIME_ROOT,
  BRIDGE_CHATFILE_ROOT,
  secureBridgeRuntimeStorage,
} = require('./bridge-runtime-cleanup');
const { createInteractiveCliTranscriptStore } = require('./interactive-cli-transcript');
const { recoverRollout } = require('../bin/recover-codex-rollout');

const activeSessions = new Map();
const BRIDGE_PYTHON = process.env.BRIDGE_PYTHON || 'python3';
const BRIDGE_RUNNER = process.env.BRIDGE_RUNNER || path.join(ROOT_DIR, 'bin', 'bridge-stream-runner.py');
const BRIDGE_BOT_NAME = process.env.BRIDGE_BOT_NAME || 'codex-task-sessions';
const FULL_ACCESS_CODEX_DIR = path.join(ROOT_DIR, 'bin', 'full-access');
const FULL_ACCESS_CODEX_BIN = path.join(FULL_ACCESS_CODEX_DIR, 'codex');
const EXECUTION_GATE = path.join(ROOT_DIR, 'bin', 'execution-gate.py');
const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;
const ROOT_EXECUTION_ALLOWED = process.env.CODEX_ALLOW_ROOT_EXECUTION === '1';
const WEB_SUPERVISOR_REQUIRED = process.env.CODEX_REQUIRE_WEB_SUPERVISOR === '1';
const HOST_LAUNCHER_REQUIRED = process.env.CODEX_REQUIRE_HOST_LAUNCHER === '1';
const MAX_ACTIVE_MESSAGES = 500;
const MAX_RUNTIME_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_STDERR_BUFFER_BYTES = 64 * 1024;
const MAX_TERMINAL_FAILURE_TAIL_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const RESIDUAL_PROCESS_GRACE_MS = 250;
const SUPERVISOR_REGISTRATION_TIMEOUT_MS = 3000;
const supervisorRegistrations = new Map();
const managedCliTranscripts = createInteractiveCliTranscriptStore();
const RUNNER_CONTROL_PREFIX = 'CODEX_TASK_CONTROL ';
const TRANSIENT_TRANSPORT_FAILURE_PATTERNS = [
  /\bstream disconnected before completion\b/i,
  /\b(?:request|connection|network|socket|stream|upstream|gateway)\s+(?:timed?\s*out|timeout)\b/i,
  /\b(?:timed?\s*out|timeout)\b[^.\n]{0,80}\b(?:request|connection|network|socket|stream|upstream|gateway)\b/i,
  /\bconnection (?:was )?reset\b/i,
  /^temporary failure[.!]?$/i,
  /\btemporary failure in name resolution\b/i,
  /^(?:temporarily unavailable|service unavailable)[.!]?$/i,
  /\b(?:service|server|upstream|endpoint|api|codex) (?:is )?temporarily unavailable\b/i,
  /\bnetwork error\b/i,
  /\beconnreset\b/i,
  /\beai_again\b/i,
  /\btoo many requests\b/i,
  /\brate limit(?:ed| exceeded)?\b/i,
  /\b502\s+bad gateway\b/i,
  /\b503\s+service unavailable\b/i,
  /\b504\s+gateway timeout\b/i,
  /\b(?:http(?:\/\d(?:\.\d)?)?(?: status)?|status code|response status|upstream status|last status)\s*[:=]?\s*(?:429|502|503|504)\b/i,
];

function resolveCodexBinary() {
  const configured = String(process.env.CODEX_TASK_REAL_CODEX_BIN || process.env.CODEX_BIN || '').trim();
  const candidates = configured
    ? [configured]
    : String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, 'codex'));
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      if (resolved === fs.realpathSync(FULL_ACCESS_CODEX_BIN)) continue;
      fs.accessSync(resolved, fs.constants.X_OK);
      return resolved;
    } catch {}
  }
  return '';
}

const REAL_CODEX_BIN = resolveCodexBinary();

function fullAccessAvailable() {
  try {
    fs.accessSync(FULL_ACCESS_CODEX_BIN, fs.constants.X_OK);
    return Boolean(REAL_CODEX_BIN);
  } catch {
    return false;
  }
}

function previewText(value, maxLength = 1000) {
  const text = String(value || '');
  return text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength)} [preview truncated; full value is in the event payload]`;
}

function workerHeartbeatStatus() {
  const heartbeat = getMetadata('worker_heartbeat', null);
  const timestamp = Date.parse(heartbeat?.ts || '');
  const ageMs = Number.isFinite(timestamp) ? Date.now() - timestamp : null;
  const identity = heartbeat?.processIdentity || null;
  const current = inspectProcess(identity?.pid);
  const ownershipMatches = current && (process.send
    ? current.pid === process.pid
    : current.parentPid === process.pid);
  const processVerified = Boolean(
    identity
    && ownershipMatches
    && sameProcess(identity),
  );
  const fresh = ageMs != null && ageMs >= -5000 && ageMs < 10000;
  return {
    heartbeat,
    ageMs,
    processVerified,
    available: Boolean(fresh && processVerified),
  };
}

function executionProcessStatus() {
  const records = listActiveProcessIdentities();
  const issues = [];
  let verified = 0;
  for (const record of records) {
    const identity = {
      pid: Number(record.pid),
      processGroupId: Number(record.processGroupId),
      sessionId: Number(record.pid),
      startTicks: String(record.pidStartTicks || ''),
    };
    if (sameProcess(identity, { requireGroupLeader: true, requireSessionLeader: true })) {
      verified += 1;
      continue;
    }
    issues.push({
      taskId: record.taskId,
      attemptId: record.attemptId,
      pid: record.pid,
      reason: inspectProcess(record.pid) ? 'identity_mismatch' : 'not_running',
    });
  }
  return {
    ok: issues.length === 0,
    tracked: records.length,
    verified,
    unverified: issues.length,
    issues: issues.slice(0, 20),
  };
}

function webSupervisorStatus() {
  const supervisorPid = Number(process.env.CODEX_WEB_SUPERVISOR_PID);
  const supervisorStartTicks = String(process.env.CODEX_WEB_SUPERVISOR_START_TICKS || '');
  const configured = Number.isInteger(supervisorPid) && supervisorPid >= 2 && /^\d+$/.test(supervisorStartTicks);
  if (!configured) {
    return {
      mode: 'external',
      required: WEB_SUPERVISOR_REQUIRED,
      processVerified: null,
    };
  }
  const supervisor = inspectProcess(supervisorPid);
  const current = inspectProcess(process.pid);
  const parent = current ? inspectProcess(current.parentPid) : null;
  const ownedProcess = current?.parentPid === supervisorPid || parent?.parentPid === supervisorPid;
  return {
    mode: 'process',
    required: WEB_SUPERVISOR_REQUIRED,
    processVerified: Boolean(
      supervisor
      && supervisor.startTicks === supervisorStartTicks
      && ownedProcess
    ),
  };
}

function hostLauncherStatus() {
  const launcherPid = Number(process.env.CODEX_HOST_LAUNCHER_PID);
  const launcherStartTicks = String(process.env.CODEX_HOST_LAUNCHER_START_TICKS || '');
  const configured = Number.isInteger(launcherPid) && launcherPid >= 2 && /^\d+$/.test(launcherStartTicks);
  if (!configured) {
    return {
      mode: 'external',
      required: HOST_LAUNCHER_REQUIRED,
      processVerified: null,
    };
  }
  const supervisorPid = Number(process.env.CODEX_WEB_SUPERVISOR_PID);
  const launcher = inspectProcess(launcherPid);
  const supervisor = inspectProcess(supervisorPid);
  return {
    mode: 'process',
    required: HOST_LAUNCHER_REQUIRED,
    processVerified: Boolean(
      launcher
      && launcher.startTicks === launcherStartTicks
      && supervisor
      && supervisor.parentPid === launcherPid
    ),
  };
}

function getRuntimeStatus(skillsMounted = null) {
  const worker = workerHeartbeatStatus();
  const executionProcesses = executionProcessStatus();
  const fullAccess = fullAccessAvailable();
  const workspace = workspaceStatus();
  const storageCapacity = storageCapacityStatus();
  const maintenance = getPlatformMaintenance();
  const webSupervisor = webSupervisorStatus();
  const hostLauncher = hostLauncherStatus();
  const platformSupported = process.platform === 'linux';
  const bridgeAvailable = platformSupported
    && fs.existsSync(BRIDGE_RUNNER)
    && fs.existsSync(EXECUTION_GATE)
    && fullAccess;
  const executionUserSafe = !RUNNING_AS_ROOT || ROOT_EXECUTION_ALLOWED;
  const workerActive = worker.available ? countExecutingSessions() : 0;
  const degradedReasons = [];
  if (!platformSupported) degradedReasons.push('unsupported_platform');
  if (!bridgeAvailable) degradedReasons.push('executor_unavailable');
  if (!worker.available) degradedReasons.push('worker_unavailable');
  if (!executionUserSafe) degradedReasons.push('execution_user_unsafe');
  if (!workspace.available) degradedReasons.push('workspace_unavailable');
  if (storageCapacity.unavailable) degradedReasons.push('storage_capacity_unavailable');
  if (storageCapacity.low) degradedReasons.push('storage_capacity_low');
  if (!executionProcesses.ok) degradedReasons.push('execution_process_mismatch');
  if (webSupervisor.required && !webSupervisor.processVerified) {
    degradedReasons.push('web_supervisor_unavailable');
  }
  if (hostLauncher.required && !hostLauncher.processVerified) {
    degradedReasons.push('host_launcher_unavailable');
  }
  if (maintenance) degradedReasons.push('platform_maintenance');
  return {
    runtimeMode: 'bridge',
    ready: degradedReasons.length === 0,
    degradedReasons,
    platformSupported,
    bridgeAvailable,
    permissionMode: 'danger-full-access',
    approvalPolicy: 'never',
    fullAccessAvailable: fullAccess,
    executionUserSafe,
    rootExecutionOverride: RUNNING_AS_ROOT && ROOT_EXECUTION_ALLOWED,
    workerAvailable: worker.available,
    workerProcessVerified: worker.processVerified,
    workerHeartbeatAt: worker.heartbeat?.ts || '',
    workerHeartbeatAgeMs: worker.ageMs,
    workerActive,
    workerReportedActive: Number(worker.heartbeat?.active || 0),
    workerMaxConcurrency: Number(worker.heartbeat?.maxConcurrency || 0),
    hostLauncher,
    webSupervisor,
    executionProcesses,
    storageCapacity,
    maintenance: maintenance ? {
      active: true,
      kind: maintenance.kind,
      startedAt: maintenance.startedAt,
      expiresAt: maintenance.expiresAt,
    } : { active: false },
    skillsMounted: skillsMounted ?? countSkills(),
    workspace,
  };
}

function syncBridgeRuntime() {
  ensureManagedDirectory(RUNTIME_DIR, {
    recursive: true,
    label: 'Platform runtime directory',
  });
  ensureManagedDirectory(BRIDGE_RUNTIME_ROOT, {
    recursive: true,
    label: 'Bridge session runtime directory',
  });
  ensureManagedDirectory(BRIDGE_CHATFILE_ROOT, {
    recursive: true,
    label: 'Bridge chatfile runtime directory',
  });
  secureBridgeRuntimeStorage();
  ensureWorkspaceRoots();
  refreshSourceSkills(true);
  return getRuntimeStatus();
}

function bridgeSessionKey(sessionId) {
  return `single:${sessionId}-${crypto.randomUUID()}`;
}

function settleSupervisorRegistration(message) {
  const registrationId = String(message?.registrationId || '');
  const pending = supervisorRegistrations.get(registrationId);
  if (!pending) return;
  if (message.type === 'supervisor.execution.registered') pending.resolve();
  if (message.type === 'supervisor.execution.rejected') {
    pending.reject(new Error(message.error || 'Execution registration was rejected by the supervisor'));
  }
}

process.on('message', settleSupervisorRegistration);
process.on('disconnect', () => {
  for (const pending of supervisorRegistrations.values()) {
    pending.reject(new Error('Worker supervisor IPC disconnected during execution registration'));
  }
  supervisorRegistrations.clear();
});

function registerWithSupervisor(registrationId, identity, sessionId) {
  if (!process.send || !process.connected) {
    return Promise.reject(new Error('Execution requires the platform worker supervisor'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      supervisorRegistrations.delete(registrationId);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error('Timed out waiting for execution registration acknowledgement'));
    }, SUPERVISOR_REGISTRATION_TIMEOUT_MS);
    timer.unref();
    supervisorRegistrations.set(registrationId, {
      resolve: () => finish(),
      reject: (error) => finish(error),
    });
    try {
      process.send({
        type: 'execution.register', registrationId, identity, sessionId,
      }, (error) => {
        if (error) finish(error);
      });
    } catch (error) {
      finish(error);
    }
  });
}

function unregisterFromSupervisor(registrationId, sessionId) {
  if (!process.send || !process.connected || !registrationId) return;
  try {
    process.send({ type: 'execution.finished', registrationId, sessionId });
  } catch {}
}

async function terminateResidualProcessGroup(identity) {
  if (!processGroupStillBelongsTo(identity)) return { found: false, forceKilled: false };
  try { signalVerifiedProcessGroup(identity, 'SIGTERM'); } catch {}
  await sleep(RESIDUAL_PROCESS_GRACE_MS);
  const forceKilled = processGroupStillBelongsTo(identity);
  if (forceKilled) {
    try { signalVerifiedProcessGroup(identity, 'SIGKILL'); } catch {}
  }
  return { found: true, forceKilled };
}

function failActiveSession(active, error) {
  try {
    failClaimedCommand(active.command.id, active.workerId, error);
  } catch (failureError) {
    console.error(`[session-fail] ${active.session.id}: ${failureError.stack || failureError.message}`);
  }
}

function buildTaskMessage(session, brief, continuing, snapshot) {
  const skillIds = snapshot.skills.map((skill) => skill.id);
  const skillWrapper = path.join(FULL_ACCESS_CODEX_DIR, 'codex-skill-use');
  const backgroundWrapper = path.join(FULL_ACCESS_CODEX_DIR, 'codex-background-track');
  const sessionRule = continuing
    ? 'Continue this persistent Session and preserve completed work.'
    : 'This persistent Session belongs only to this task; work end to end.';
  return [
    `Task: ${session.name} (${session.id})`,
    `Objective: ${session.objective || 'Complete the requested task.'}`,
    `Request: ${brief || session.objective || 'Complete the requested task.'}`,
    `Skill snapshot: ${snapshot.path}`,
    `Available Skill IDs: ${skillIds.join(', ') || '(none)'}`,
    'Runtime rules:',
    `- Read applicable snapshot SKILL.md files. Skill-driven shell commands must start with: ${skillWrapper} <skill-id> [skill-id ...] -- <command>`,
    `- Register every detached PID/LOG/DONE/STATE/META with explicit business identity before replying: ${backgroundWrapper} register --pid <PID> --log <LOG> --done <DONE> --state <STATE> --meta <META> --step-key <stable-scope> --step-label <label> --run-key <initial|rerun-N> --run-kind <initial|rerun> [--source-run-key <initial>] [--selection-mode <mode>] [--target-count <N>]. A Step is stable business scope; a rerun creates a new Run in the same Step. A technical retry reuses the returned STEP_RUN_ID with --step-run-id <ID>.`,
    '- Register every known HTML output with the External Attempt by repeating --artifact pytest-html:<stable-key>:<absolute-path>. This registration is required even when a wrapper command receives the report path through another option. After registration, report STEP_ID, STEP_RUN_ID, TRACKING_ID, the command, and artifacts, then end the launch Turn without polling or analysis; the scheduled Turn collects the result.',
    `- When an applicable Skill requires a Platform Skill Report, publish its running and terminal Schema v2 revisions with: ${skillWrapper} <skill-id> -- codex-skill-report publish --file <report.json>. Each Run uses its own stable reportKey; every running or terminal Run report sets executionEvidence.externalAttemptId to its TRACKING_ID and contains an explicit artifacts array. The platform merges launch-registered HTML outputs into every terminal revision and archives them after DONE/STATE/META become terminal. A terminal report explicitly adds artifacts created after launch, such as failure-analysis Markdown. Do not rely on display commands or Section fields for artifact discovery. Confirm STEP_RUN_ID in the publish output before ending the Turn.`,
    `- Host full access, no approvals. ${sessionRule} A successful Turn waits for review; only the operator archives the task.`,
  ].join('\n');
}

function buildBridgeArgs(session, message, attemptOutput, outputFile) {
  return [
    BRIDGE_RUNNER,
    '--bot-id', BRIDGE_BOT_ID,
    '--bot-name', BRIDGE_BOT_NAME,
    '--runtime-root', BRIDGE_RUNTIME_ROOT,
    '--source-dir', resolveWorkingDir(session.workingDir),
    '--chatfile-root', BRIDGE_CHATFILE_ROOT,
    '--chat-key', session.persistentSessionKey,
    '--message', message,
    '--output-file', outputFile,
    '--stdout-file', attemptOutput.stdout,
    '--stderr-file', attemptOutput.stderr,
  ];
}

function summarizeRuntimeEvent(event) {
  if (!event || typeof event !== 'object') return { level: 'info', message: String(event || '').trim() };
  if (event.type === 'error') return { level: 'error', message: event.message || 'Session error' };
  if (event.type === 'turn.failed') return { level: 'error', message: event.error?.message || 'Session turn failed' };
  if (event.type === 'thread.started') return { level: 'info', message: 'Persistent session initialized' };
  if (event.type === 'turn.started') return { level: 'info', message: 'Task turn started' };
  if (event.type === 'turn.completed') return { level: 'info', message: 'Task turn completed' };
  if (event.type === 'item.completed' && event.item) {
    if (event.item.type === 'agent_message') return { level: 'info', message: event.item.text || 'Task response completed' };
    if (event.item.type === 'command_execution') {
      const suffix = event.item.exit_code == null ? '' : ` (exit ${event.item.exit_code})`;
      return { level: event.item.exit_code ? 'warn' : 'info', message: `${previewText(event.item.command || 'Command completed')}${suffix}` };
    }
    if (event.item.message) return { level: event.item.type === 'error' ? 'error' : 'info', message: event.item.message };
  }
  if (typeof event.message === 'string' && event.message.trim()) return { level: 'info', message: event.message.trim() };
  return { level: 'info', message: event.type || 'runtime.event' };
}

function runtimeEventPayload(event, active) {
  return event && typeof event === 'object'
    ? { turnId: active.turnId, attemptId: active.attemptId, event }
    : null;
}

function safeRuntimeLine(rawLine) {
  const line = String(rawLine || '').replace(/\r$/, '');
  if (!line.trim()) return '';
  return line;
}

function isTransientFailure(text) {
  const normalized = String(text || '').trim();
  return Boolean(normalized
    && TRANSIENT_TRANSPORT_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized)));
}

function rememberMessage(active, message) {
  active.messages.push(message);
  if (active.messages.length > MAX_ACTIVE_MESSAGES) {
    active.messages.splice(0, active.messages.length - MAX_ACTIVE_MESSAGES);
  }
}

function rememberFailureMessage(active, message) {
  const normalized = String(message || '').trim();
  if (!normalized || active.failureMessages.at(-1) === normalized) return;
  active.failureMessages.push(normalized);
  if (active.failureMessages.length > MAX_ACTIVE_MESSAGES) {
    active.failureMessages.splice(0, active.failureMessages.length - MAX_ACTIVE_MESSAGES);
  }
}

async function startSession(command, workerId) {
  const session = getSession(command.task_id);
  if (!session) throw new Error(`Session ${command.task_id} not found`);
  if (!session.enabled) throw new Error(`Session ${command.task_id} is disabled`);
  if (session.status !== 'queued') throw new Error(`Session ${command.task_id} is no longer queued`);
  if (session.status === 'completed') throw new Error(`Session ${command.task_id} is completed and archived`);
  if (RUNNING_AS_ROOT && !ROOT_EXECUTION_ALLOWED) {
    throw new Error('Task execution is disabled while the service is running as root');
  }
  if (!fs.existsSync(BRIDGE_RUNNER) || !fs.existsSync(EXECUTION_GATE) || !fullAccessAvailable()) {
    throw new Error('Persistent full-access session executor is not available');
  }
  if (activeSessions.has(session.id)) return deepClone(activeSessions.get(session.id).session);

  const configuredWorkingDirectory = resolveWorkingDir(session.workingDir);
  const snapshot = ensureTaskSkillSnapshot(session.id);
  const continuing = Boolean(session.persistentSessionKey);
  const sessionKey = session.persistentSessionKey || bridgeSessionKey(session.id);
  const taskBrief = command.input !== ''
    ? String(command.input)
    : String(session.lastBrief || session.objective || '');
  const hydrated = {
    ...session,
    persistentSessionKey: sessionKey,
    bridgeSessionKey: sessionKey,
    skillSnapshotId: snapshot.id,
  };
  const message = buildTaskMessage(hydrated, taskBrief, continuing, snapshot);
  const outputFile = prepareSessionBridgeOutputFile(session.id);
  try {
    appendSessionLatestLog(session.id, `${continuing ? 'CONTINUE' : 'START'} PERSISTENT SESSION\n\n`, true);
  } catch (error) {
    try { fs.unlinkSync(outputFile); } catch {}
    throw error;
  }
  let started;
  try {
    started = beginSessionTurn({
      taskId: session.id,
      commandId: command.id,
      workerId,
      input: taskBrief,
      persistentSessionKey: sessionKey,
      skillSnapshotId: snapshot.id,
      createInitialAttempt: true,
    });
  } catch (error) {
    try { fs.unlinkSync(outputFile); } catch {}
    throw error;
  }
  const runtimeSession = started.session;
  const turn = started.turn;
  const active = {
    session: runtimeSession,
    command,
    workerId,
    turnId: turn.id,
    proc: null,
    message,
    messages: [],
    failureMessages: [],
    stopRequested: false,
    shutdownRequested: false,
    leaseLost: false,
    forceKillTimer: null,
    retryCount: 0,
    maxRetries: Number(runtimeSession.maxRetries || 0),
    runtimeReturnCode: null,
    managedPty: false,
    rollout: null,
    transcript: null,
    transcriptError: null,
    controlError: '',
    attemptId: started.attemptId,
    outputFile,
    skillSnapshotPath: snapshot.path,
    configuredWorkingDirectory,
  };
  activeSessions.set(session.id, active);
  try {
    appendSessionWorklog(session.id, {
      turnId: turn.id,
      kind: continuing ? 'session.continued' : 'session.started',
      message: `${continuing ? 'Continued' : 'Started'} persistent task session ${runtimeSession.name}`,
      payload: { trigger: 'command', runtime: 'bridge', commandId: command.id },
    });
    appendSessionWorklog(session.id, {
      turnId: turn.id,
      kind: 'skill.snapshot.mounted',
      message: `Mounted immutable skill snapshot ${snapshot.id}`,
      payload: {
        snapshotId: snapshot.id,
        contentHash: snapshot.contentHash,
        skills: snapshot.skills.map(({ id, version, origin, contentHash }) => ({ id, version, origin, contentHash })),
      },
    });
    await launchAttempt(active, true);
  } catch (error) {
    activeSessions.delete(session.id);
    try { fs.unlinkSync(outputFile); } catch {}
    throw error;
  }
  return deepClone(runtimeSession);
}

async function launchAttempt(active, initialAttemptPrepared = false) {
  const sessionId = active.session.id;
  if (!initialAttemptPrepared) {
    active.attemptId = createAttempt(sessionId, active.turnId, active.retryCount + 1, active.workerId);
  } else if (!active.attemptId) {
    throw new Error(`Session ${sessionId} did not prepare its initial attempt`);
  }
  active.outputFile = prepareSessionBridgeOutputFile(sessionId);
  const attemptOutput = prepareAttemptOutputFiles(sessionId, active.attemptId);
  const args = buildBridgeArgs(active.session, active.message, attemptOutput, active.outputFile);
  active.managedPty = false;
  active.rollout = null;
  active.transcript = null;
  active.transcriptError = null;
  active.controlError = '';
  const executionEnvironment = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    CODEX_TASK_SKILL_SNAPSHOT: active.skillSnapshotPath,
    CODEX_TASK_ID: sessionId,
    CODEX_TASK_TURN_ID: active.turnId,
    CODEX_TASK_ATTEMPT_ID: active.attemptId,
    CODEX_TASK_PERMISSION_MODE: 'danger-full-access',
    CODEX_TASK_APPROVAL_POLICY: 'never',
    CODEX_TASK_REAL_CODEX_BIN: REAL_CODEX_BIN,
    CODEX_BIN: FULL_ACCESS_CODEX_BIN,
    PATH: `${FULL_ACCESS_CODEX_DIR}${path.delimiter}${process.env.PATH || ''}`,
  };
  delete executionEnvironment.CODEX_DESK_AUTH_USER;
  delete executionEnvironment.CODEX_DESK_AUTH_PASSWORD;
  delete executionEnvironment.CODEX_ALLOW_ROOT_EXECUTION;
  delete executionEnvironment.NO_COLOR;
  const proc = spawn(BRIDGE_PYTHON, [EXECUTION_GATE, '--', BRIDGE_PYTHON, ...args], {
    cwd: active.configuredWorkingDirectory,
    env: executionEnvironment,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  active.proc = proc;
  let gateSpawnError = null;
  proc.on('error', (error) => { gateSpawnError = error; });
  proc.stdin.on('error', () => {});
  active.messages = [];
  active.failureMessages = [];
  active.runtimeReturnCode = null;
  const executionIdentity = inspectProcess(proc.pid);
  if (!executionIdentity
    || executionIdentity.parentPid !== process.pid
    || executionIdentity.processGroupId !== proc.pid
    || executionIdentity.sessionId !== proc.pid) {
    if (proc.pid) {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    }
    throw new Error(`Session ${sessionId} execution process identity could not be established`);
  }
  const supervisorRegistrationId = active.attemptId;
  active.executionIdentity = executionIdentity;
  active.supervisorRegistrationId = supervisorRegistrationId;
  try {
    active.session = registerAttemptProcess({
      taskId: sessionId,
      turnId: active.turnId,
      attemptId: active.attemptId,
      workerId: active.workerId,
      pid: executionIdentity.pid,
      pidStartTicks: executionIdentity.startTicks,
      processGroupId: executionIdentity.processGroupId,
      retryCount: active.retryCount,
    });
    appendSessionWorklog(sessionId, {
      turnId: active.turnId,
      kind: 'session.runtime.started',
      message: `Launching task turn for ${sessionId}`,
      payload: {
        runtime: 'bridge',
        retryCount: active.retryCount,
        attemptId: active.attemptId,
        processIdentity: {
          pid: executionIdentity.pid,
          processGroupId: executionIdentity.processGroupId,
          startTicks: executionIdentity.startTicks,
        },
        configuredWorkingDirectory: active.configuredWorkingDirectory,
        permissionMode: 'danger-full-access',
        approvalPolicy: 'never',
      },
    });
    await registerWithSupervisor(supervisorRegistrationId, executionIdentity, sessionId);
    if (gateSpawnError || proc.exitCode != null || proc.signalCode != null) {
      throw new Error(`Session ${sessionId} execution gate exited before supervisor acknowledgement`);
    }
    active.transcript = managedCliTranscripts.start(sessionId, {
      pid: executionIdentity.pid,
      attemptId: active.attemptId,
      mode: 'managed',
    });
  } catch (error) {
    try { signalVerifiedProcessGroup(executionIdentity, 'SIGKILL'); } catch {}
    unregisterFromSupervisor(supervisorRegistrationId, sessionId);
    active.proc = null;
    throw error;
  }

  let stdoutBuffer = '';
  let stderrBuffer = '';
  let stdoutBytes = 0;
  let stdoutTruncated = false;
  let terminalFailureTail = Buffer.alloc(0);
  let envelopeKey = '';
  let envelopeStream = '';
  let envelopeDetected = false;
  let envelopeParserFailed = false;
  const envelopeBuffers = { stdout: [], stderr: [] };
  const envelopeParser = createJsonParser({ packKeys: true, packStrings: false, packNumbers: true });

  function handleEnvelopeText(stream, value, final = false) {
    const parts = String(value || '').split('\n');
    envelopeBuffers[stream].push(parts[0]);
    for (let index = 1; index < parts.length; index += 1) {
      handleLine(envelopeBuffers[stream].join(''), stream);
      envelopeBuffers[stream] = [parts[index]];
    }
    if (final) {
      const tail = envelopeBuffers[stream].join('');
      if (tail) handleLine(tail, stream);
      envelopeBuffers[stream] = [];
    }
  }

  envelopeParser.on('data', (token) => {
    if (token.name === 'keyValue') envelopeKey = token.value;
    if (token.name === 'numberValue' && envelopeKey === 'returncode') {
      const runtimeCode = Number(token.value);
      if (Number.isInteger(runtimeCode)) active.runtimeReturnCode = runtimeCode;
    }
    if (token.name === 'startString' && ['stdout', 'stderr'].includes(envelopeKey)) {
      envelopeStream = envelopeKey;
      envelopeDetected = true;
    } else if (token.name === 'stringChunk' && envelopeStream) {
      handleEnvelopeText(envelopeStream, token.value);
    } else if (token.name === 'endString' && envelopeStream) {
      handleEnvelopeText(envelopeStream, '', true);
      envelopeStream = '';
    }
  });
  envelopeParser.on('error', () => {
    envelopeParserFailed = true;
  });

  function handleRunnerControl(line) {
    if (!line.startsWith(RUNNER_CONTROL_PREFIX)) return false;
    let control;
    try { control = JSON.parse(line.slice(RUNNER_CONTROL_PREFIX.length)); } catch {
      active.controlError = 'Codex PTY runner emitted malformed control metadata.';
      rememberFailureMessage(active, active.controlError);
      return true;
    }
    if (control?.type === 'pty.started') {
      active.managedPty = true;
      appendSessionWorklog(sessionId, {
        turnId: active.turnId,
        kind: 'session.runtime.pty.started',
        message: `Attached managed Codex turn ${active.attemptId} to its canonical PTY`,
        payload: {
          attemptId: active.attemptId,
          codexPid: Number(control.pid) || null,
          cols: Number(control.cols) || null,
          rows: Number(control.rows) || null,
        },
      });
      return true;
    }
    if (control?.type === 'rollout.ready') {
      active.managedPty = true;
      const offset = Number(control.offset);
      if (!String(control.path || '').trim() || !Number.isSafeInteger(offset) || offset < 0) {
        active.controlError = 'Codex PTY runner emitted invalid rollout metadata.';
        rememberFailureMessage(active, active.controlError);
        return true;
      }
      active.rollout = {
        path: path.resolve(String(control.path)),
        offset,
        threadId: String(control.threadId || '').trim(),
      };
      return true;
    }
    return true;
  }

  function handleLine(rawLine, stream) {
    const line = safeRuntimeLine(rawLine);
    if (!line) return;
    if (stream === 'stderr' && handleRunnerControl(line)) return;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch {}
    if (parsed?.type) {
      const summary = summarizeRuntimeEvent(parsed);
      rememberMessage(active, summary.message);
      if (summary.level === 'error') rememberFailureMessage(active, summary.message);
      appendSessionLatestLog(sessionId, `${line}\n`);
      appendRuntimeWorklog(sessionId, {
        turnId: active.turnId,
        kind: `runtime.${parsed.type}`,
        level: summary.level,
        message: summary.message,
        payload: runtimeEventPayload(parsed, active),
      }, parsed, active.attemptId, active.configuredWorkingDirectory);
      return;
    }
    rememberMessage(active, line);
    if (stream === 'stderr') rememberFailureMessage(active, line);
    appendSessionLatestLog(sessionId, `${line}\n`);
    if (stream === 'stderr') return;
    appendSessionWorklog(sessionId, {
      turnId: active.turnId,
      kind: `runtime.${stream}`,
      level: stream === 'audit' ? 'warn' : 'info',
      message: line,
    });
  }

  function flush(stream, final = false) {
    if (stream === 'stdout') {
      if (!final) return;
      if (envelopeDetected) {
        stdoutBuffer = '';
        stdoutBytes = 0;
        if (envelopeParserFailed) {
          handleLine('Structured runtime envelope could not be parsed completely.', 'audit');
        }
        return;
      }
      if (active.managedPty) {
        stdoutBuffer = '';
        stdoutBytes = 0;
        return;
      }
      const output = stdoutBuffer.trim();
      stdoutBuffer = '';
      stdoutBytes = 0;
      if (stdoutTruncated) {
        handleLine(`Runtime event output exceeded ${MAX_RUNTIME_STDOUT_BYTES} bytes and was truncated.`, 'audit');
        return;
      }
      if (!output) return;
      let envelope = null;
      try { envelope = JSON.parse(output); } catch {}
      if (envelope && typeof envelope === 'object' && Object.prototype.hasOwnProperty.call(envelope, 'returncode')) {
        const runtimeCode = Number(envelope.returncode);
        if (Number.isInteger(runtimeCode)) active.runtimeReturnCode = runtimeCode;
        String(envelope.stdout || '').split('\n').forEach((line) => handleLine(line, 'stdout'));
        String(envelope.stderr || '').split('\n').forEach((line) => handleLine(line, 'stderr'));
        return;
      }
      output.split('\n').forEach((line) => handleLine(line, stream));
      return;
    }
    const parts = stderrBuffer.split('\n');
    stderrBuffer = final ? '' : parts.pop() || '';
    parts.forEach((line) => handleLine(line, stream));
  }

  proc.stdout.on('data', (chunk) => {
    if (!active.transcriptError) {
      try {
        active.transcript?.append(chunk);
      } catch (error) {
        active.transcriptError = error;
        handleLine(`Managed Codex CLI transcript failed: ${error.message}`, 'stderr');
        try { signalVerifiedProcessGroup(executionIdentity, 'SIGTERM'); } catch {}
      }
    }
    terminalFailureTail = chunk.length >= MAX_TERMINAL_FAILURE_TAIL_BYTES
      ? Buffer.from(chunk.subarray(chunk.length - MAX_TERMINAL_FAILURE_TAIL_BYTES))
      : Buffer.concat([terminalFailureTail, chunk]).subarray(-MAX_TERMINAL_FAILURE_TAIL_BYTES);
    if (!envelopeParserFailed) {
      try { envelopeParser.write(chunk); } catch { envelopeParserFailed = true; }
    }
    if (!envelopeDetected && !stdoutTruncated) {
      if (stdoutBytes + chunk.length > MAX_RUNTIME_STDOUT_BYTES) {
        stdoutBuffer = '';
        stdoutBytes = 0;
        stdoutTruncated = true;
        return;
      }
      stdoutBuffer += chunk.toString('utf8');
      stdoutBytes += chunk.length;
    }
  });
  proc.stdout.on('end', () => {
    if (!envelopeParserFailed) {
      try { envelopeParser.end(); } catch { envelopeParserFailed = true; }
    }
  });
  proc.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString('utf8');
    if (Buffer.byteLength(stderrBuffer) > MAX_RUNTIME_STDERR_BUFFER_BYTES && !stderrBuffer.includes('\n')) {
      handleLine(stderrBuffer, 'stderr');
      stderrBuffer = '';
    } else {
      flush('stderr');
    }
  });
  proc.on('error', (error) => handleLine(`Failed to start persistent session: ${error.message}`, 'stderr'));
  proc.on('close', (code, signal) => {
    const executionPid = proc.pid;
    const registeredIdentity = executionIdentity;
    const registrationId = supervisorRegistrationId;
    Promise.resolve().then(async () => {
    if (active.forceKillTimer) {
      clearTimeout(active.forceKillTimer);
      active.forceKillTimer = null;
    }
    active.proc = null;
    const residualCleanup = await terminateResidualProcessGroup(registeredIdentity);
    if (residualCleanup.found) {
      appendSessionWorklog(sessionId, {
        turnId: active.turnId,
        kind: 'session.runtime.residual_processes.terminated',
        level: 'warn',
        message: `Terminated residual processes from execution group ${executionPid}`,
        payload: {
          attemptId: active.attemptId,
          processGroupId: executionPid,
          forceKilled: residualCleanup.forceKilled,
        },
      });
    }
    flush('stderr', true);
    flush('stdout', true);
    let exitCode = Number.isInteger(active.runtimeReturnCode) ? active.runtimeReturnCode : code;
    if (active.managedPty && exitCode !== 0) {
      const terminalFailure = stripAnsi(terminalFailureTail.toString('utf8'))
        .replace(/\r/g, '')
        .trim();
      if (terminalFailure) rememberFailureMessage(active, terminalFailure);
    }
    try {
      active.transcript?.seal({
        exitCode,
        signal,
        threadId: active.rollout?.threadId || '',
      });
    } catch (error) {
      active.transcriptError ||= error;
      handleLine(`Managed Codex CLI transcript could not be sealed: ${error.message}`, 'stderr');
    }
    active.transcript = null;
    if ((active.transcriptError || active.controlError) && exitCode === 0) exitCode = 74;
    if (active.managedPty && active.rollout) {
      try {
        recoverRollout({
          '--task': sessionId,
          '--turn': active.turnId,
          '--attempt': active.attemptId,
          '--rollout': active.rollout.path,
          '--offset': String(active.rollout.offset),
          '--working-dir': active.configuredWorkingDirectory,
        });
      } catch (error) {
        handleLine(`Codex rollout audit recovery failed: ${error.message}`, 'stderr');
        if (exitCode === 0) exitCode = 74;
      }
    }
    let resultText = '';
    if (pathEntryExists(active.outputFile)) {
      try {
        resultText = readManagedTextTail(active.outputFile, MAX_RESULT_BYTES, {
          label: 'Bridge result file',
        });
      } catch (error) {
        handleLine(`Task result file could not be read: ${error.message}`, 'stderr');
      } finally {
        try { fs.unlinkSync(active.outputFile); } catch {}
      }
    }
    if (resultText) {
      rememberMessage(active, resultText);
      appendSessionLatestLog(sessionId, `${resultText}\n`);
    }
    const summaryLines = exitCode !== 0 && active.failureMessages.length
      ? active.failureMessages
      : (resultText ? resultText.split(/\r?\n/) : active.messages);
    const summary = tailSummary(summaryLines)
      || (exitCode === 0 ? 'Task turn completed.' : `Session turn exited with code ${exitCode ?? 'unknown'}`);
    const transient = exitCode !== 0 && active.failureMessages.some(isTransientFailure);
    const canRetry = transient && !active.stopRequested && !active.shutdownRequested && active.retryCount < active.maxRetries;
    let attemptAlreadyFinalized = false;
    if (canRetry) {
      active.retryCount += 1;
      const delayMs = Math.min(2000 * active.retryCount, 10000);
      active.session = prepareSessionRetry({
        taskId: sessionId,
        turnId: active.turnId,
        attemptId: active.attemptId,
        workerId: active.workerId,
        exitCode,
        signal: signal || null,
        summary,
        finishedAt: nowIso(),
        retryCount: active.retryCount,
        maxRetries: active.maxRetries,
        delayMs,
      });
      attemptAlreadyFinalized = true;
      active.attemptId = createAttempt(sessionId, active.turnId, active.retryCount + 1, active.workerId);
      attemptAlreadyFinalized = false;
      await sleep(delayMs);
      if (!active.stopRequested && !active.shutdownRequested) {
        active.message = buildTaskMessage(active.session, 'Recover from the interrupted action and continue this task.', true, ensureTaskSkillSnapshot(sessionId));
        await launchAttempt(active, true);
        return;
      }
    }

    const latest = getSession(sessionId);
    const operatorStopped = active.stopRequested || latest?.cancelRequested || latest?.status === 'stopping';
    const finalStatus = active.shutdownRequested
      ? 'interrupted'
      : (operatorStopped ? 'stopped' : (exitCode === 0 ? 'waiting_review' : 'failed'));
    const finishedAt = nowIso();
    try {
      if (active.leaseLost) return;
      active.session = finalizeSessionTurn({
        taskId: sessionId,
        turnId: active.turnId,
        attemptId: active.attemptId,
        commandId: active.command.id,
        workerId: active.workerId,
        exitCode,
        signal,
        summary,
        resultText,
        finalStatus,
        finishedAt,
        retryCount: active.retryCount,
        transient,
        shutdownRequested: active.shutdownRequested,
        attemptAlreadyFinalized,
      });
    } catch (error) {
      console.error(`[session-finalize] ${sessionId}: ${error.stack || error.message}`);
      failActiveSession(active, error);
    } finally {
      activeSessions.delete(sessionId);
    }
    }).catch((error) => {
      console.error(`[session-close] ${sessionId}: ${error.stack || error.message}`);
      failActiveSession(active, error);
      activeSessions.delete(sessionId);
    }).finally(() => {
      unregisterFromSupervisor(registrationId, sessionId);
    });
  });
  proc.stdin.end(Buffer.from([1]));
}

function stopSession(sessionId, shutdown = false) {
  const active = activeSessions.get(sessionId);
  if (!active) return false;
  if (shutdown) active.shutdownRequested = true;
  else active.stopRequested = true;
  if (active.proc?.pid) {
    const pid = active.proc.pid;
    try { signalVerifiedProcessGroup(active.executionIdentity, shutdown ? 'SIGTERM' : 'SIGINT'); } catch {}
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => {
        if (active.proc?.pid !== pid) return;
        try { signalVerifiedProcessGroup(active.executionIdentity, 'SIGKILL'); } catch {}
      }, 2000);
      active.forceKillTimer.unref();
    }
  }
  return true;
}

function stopSessionAfterLeaseLoss(sessionId) {
  const active = activeSessions.get(sessionId);
  if (!active || active.leaseLost) return false;
  active.leaseLost = true;
  console.error(`[session-lease] ${sessionId}: lease ownership lost; terminating the active process`);
  return stopSession(sessionId, true);
}

function pollCancellations() {
  for (const [sessionId, active] of activeSessions) {
    const latest = getSession(sessionId);
    if (latest?.cancelRequested && !active.stopRequested) stopSession(sessionId);
  }
}

function heartbeatActive(workerId) {
  // A recovery checkpoint needs a quiet SQLite snapshot. Maintenance already
  // prevents active work, so heartbeats must not extend leases or write metadata.
  if (getPlatformMaintenance()?.kind === 'recovery_checkpoint') return;
  for (const sessionId of [...activeSessions.keys()]) {
    if (!renewTaskLease(sessionId, workerId)) stopSessionAfterLeaseLoss(sessionId);
  }
  const processIdentity = inspectProcess(process.pid);
  setMetadata('worker_heartbeat', {
    workerId,
    pid: process.pid,
    processIdentity,
    ts: nowIso(),
    active: activeSessions.size,
    maxConcurrency: 0,
  });
}

function listActiveSessions() {
  return [...activeSessions.values()].map(({
    session, turnId, workerId, configuredWorkingDirectory,
  }) => ({
    id: session.id,
    name: session.name,
    status: session.status,
    summary: session.summary,
    currentPid: session.currentPid,
    lastRunAt: session.lastRunAt,
    runCount: session.runCount,
    turnId,
    workerId,
    workingDirectory: configuredWorkingDirectory,
  }));
}

function shutdownWorker(force = false) {
  for (const [sessionId, active] of activeSessions) {
    // A fatal worker shutdown is still an interruption, not a task failure.
    // Set this before SIGKILL so the close handler persists a recoverable state.
    active.shutdownRequested = true;
    if (force && active.proc?.pid) {
      try { signalVerifiedProcessGroup(active.executionIdentity, 'SIGKILL'); } catch {}
    } else {
      stopSession(sessionId, true);
    }
  }
}

module.exports = {
  syncBridgeRuntime,
  getRuntimeStatus,
  hostLauncherStatus,
  webSupervisorStatus,
  startSession,
  stopSession,
  pollCancellations,
  heartbeatActive,
  listActiveSessions,
  shutdownWorker,
};
