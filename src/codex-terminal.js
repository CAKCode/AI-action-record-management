'use strict';

const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const { resolveBridgeSessionRuntime, releaseSessionRuntimeProcessesAndWait } = require('./bridge-runtime-cleanup');
const { inspectProcess, signalVerifiedProcessGroup, processGroupStillBelongsTo } = require('./process-identity');

const DEFAULT_MAX_TERMINALS = 6;
const DEFAULT_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_BYTES = 128 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;
const DEFAULT_TERMINATION_TIMEOUT_MS = 5000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 60 * 1000;

function terminalError(message, statusCode = 409) {
  return Object.assign(new Error(message), { statusCode, expected: true });
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function optionalBoundedInteger(value, minimum, maximum, fallback) {
  if (value === 0 || String(value).trim() === '0') return 0;
  return boundedInteger(value, minimum, maximum, fallback);
}

function resolveCodexBinary(environment = process.env) {
  const configured = String(environment.CODEX_TASK_REAL_CODEX_BIN || environment.CODEX_BIN || '').trim();
  const candidates = configured
    ? [configured]
    : String(environment.PATH || '').split(path.delimiter).filter(Boolean)
      .map((directory) => path.join(directory, 'codex'));
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      fs.accessSync(resolved, fs.constants.X_OK);
      return resolved;
    } catch {}
  }
  return '';
}

function sendControl(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function sendOutput(socket, chunk) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      resolve(false);
      return;
    }
    socket.send(Buffer.from(chunk), { binary: true }, (error) => {
      if (error) reject(error);
      else resolve(true);
    });
  });
}

function createCodexTerminalManager(options) {
  if (typeof options?.getTask !== 'function') throw new TypeError('getTask is required');
  const environment = options.environment || process.env;
  const pty = options.pty || require('node-pty');
  const codexBinary = options.codexBinary || resolveCodexBinary(environment);
  const activeStatuses = new Set(options.activeStatuses || []);
  const maxTerminals = boundedInteger(
    options.maxTerminals ?? environment.CODEX_INTERACTIVE_MAX_TERMINALS,
    1,
    32,
    DEFAULT_MAX_TERMINALS,
  );
  const maxOpenTerminals = boundedInteger(
    options.maxOpenTerminals ?? environment.CODEX_INTERACTIVE_MAX_OPEN_TERMINALS,
    1,
    32,
    maxTerminals,
  );
  const maxReplayBytes = boundedInteger(
    options.maxReplayBytes ?? environment.CODEX_INTERACTIVE_REPLAY_BYTES,
    64 * 1024,
    MAX_REPLAY_BYTES,
    DEFAULT_REPLAY_BYTES,
  );
  const terminationTimeoutMs = boundedInteger(
    options.terminationTimeoutMs,
    100,
    30000,
    DEFAULT_TERMINATION_TIMEOUT_MS,
  );
  const disconnectTimeoutMs = optionalBoundedInteger(
    options.disconnectTimeoutMs ?? environment.CODEX_INTERACTIVE_DISCONNECT_TIMEOUT_MS,
    1000,
    24 * 60 * 60 * 1000,
    DEFAULT_DISCONNECT_TIMEOUT_MS,
  );
  const scheduleTimer = options.setTimeout || setTimeout;
  const cancelTimer = options.clearTimeout || clearTimeout;
  const terminals = new Map();
  // Browser history can be discarded before detached native CLI processes exit.
  // Retain only their ownership context, without keeping replay buffers alive.
  const runtimeRecords = new Map();
  const completionOperations = new Map();
  const transcriptFailures = new Map();
  const releaseRuntime = options.releaseRuntime || releaseSessionRuntimeProcessesAndWait;
  let stopping = false;
  let shutdownPromise = null;

  function terminalProcessGroupIsAlive(entry) {
    if (entry.groupExited) return false;
    const identity = entry.processIdentity;
    const alive = Boolean(identity && identity.processGroupId === identity.pid && identity.sessionId === identity.pid
      && processGroupStillBelongsTo(identity));
    if (entry.exited && !alive) entry.groupExited = true;
    return alive;
  }

  function terminalHasLiveProcesses(entry) {
    return Boolean(entry && ((!entry.exited && entry.process) || terminalProcessGroupIsAlive(entry)));
  }

  function releaseExitedEntry(entry) {
    if (entry.exited && !terminalHasLiveProcesses(entry) && entry.clients.size === 0
      && terminals.get(entry.taskId) === entry) terminals.delete(entry.taskId);
  }

  function rememberRuntime(task, runtime) {
    const key = JSON.stringify([task.id, task.createdAt || '', runtime.sessionId, runtime.codexHome]);
    runtimeRecords.set(key, { key, taskId: task.id, taskCreatedAt: task.createdAt || '',
      sessionKey: task.persistentSessionKey, runtime, cleanupPromise: null });
    return key;
  }

  function releaseRecordedRuntime(record) {
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = Promise.resolve().then(() => releaseRuntime(record.runtime, { includeCliMain: true }))
      .then(result => {
        if (result.errors.length) {
          throw new Error(`Codex runtime release failed for ${record.taskId}: ${result.errors.map(item => item.error).join('; ')}`);
        }
        if (runtimeRecords.get(record.key) === record) runtimeRecords.delete(record.key);
        return result;
      }).finally(() => { record.cleanupPromise = null; });
    return record.cleanupPromise;
  }

  function forgetReleasedRuntime(lease, result) {
    if (result.errors.length || result.skipped) return;
    for (const record of runtimeRecords.values()) {
      if (record.taskId !== lease.taskId || record.taskCreatedAt !== lease.taskCreatedAt
        || record.sessionKey !== lease.sessionKey || record.runtime.sessionId !== result.sessionId) continue;
      const entry = terminals.get(record.taskId);
      if (entry?.runtimeRecordKey === record.key && terminalHasLiveProcesses(entry)) continue;
      runtimeRecords.delete(record.key);
    }
  }

  function audit(taskId, kind, message, payload = {}) {
    try {
      options.appendWorklog?.(taskId, { kind, message, payload });
    } catch (error) {
      options.onError?.(error);
    }
  }

  function appendReplay(entry, chunk) {
    const bytes = Buffer.from(chunk);
    entry.replayChunks.push(bytes);
    entry.replayBytes += bytes.length;
    while (entry.replayBytes > maxReplayBytes && entry.replayChunks.length > 1) {
      entry.replayBytes -= entry.replayChunks.shift().length;
    }
  }

  function broadcastControl(entry, payload) {
    for (const client of entry.clients) sendControl(client, payload);
  }

  function broadcastOutput(entry, chunk) {
    const output = Buffer.from(chunk);
    for (const client of entry.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(output, { binary: true });
    }
  }

  function clearDisconnectTimer(entry) {
    if (!entry.disconnectTimer) return;
    cancelTimer(entry.disconnectTimer);
    entry.disconnectTimer = null;
  }

  function scheduleDisconnectedTermination(entry) {
    if (stopping || disconnectTimeoutMs === 0 || entry.exited || entry.clients.size > 0 || entry.disconnectTimer) return;
    entry.disconnectTimer = scheduleTimer(() => {
      entry.disconnectTimer = null;
      if (entry.exited || entry.clients.size > 0) return;
      terminateEntry(entry, 'client_disconnect_timeout');
    }, disconnectTimeoutMs);
    entry.disconnectTimer.unref?.();
  }

  function launchContext(task) {
    if (!task.persistentSessionKey) {
      throw terminalError('Start this task once before opening its interactive Codex CLI');
    }
    const runtime = (options.resolveRuntime || resolveBridgeSessionRuntime)(task.persistentSessionKey);
    if (!runtime) throw terminalError('The task Bridge Session runtime is not available');
    if (!runtime.threadId) throw terminalError('The task does not have a resumable Codex thread yet');
    options.prepareRuntime?.(task.id, runtime);
    for (const [target, label] of [[runtime.cwdDir, 'workspace'], [runtime.codexHome, 'Codex home']]) {
      let stat;
      try { stat = fs.statSync(target); } catch {}
      if (!stat?.isDirectory()) {
        if (label === 'Codex home') {
          throw terminalError(
            'The task Codex Home has expired; run the task once to recreate its Runtime before reconnecting',
          );
        }
        throw terminalError(`The task ${label} is not available`);
      }
    }
    return runtime;
  }

  function recordTranscriptFailure(entry, error) {
    if (entry.transcriptError) return;
    entry.transcriptError = error;
    transcriptFailures.set(entry.taskId, error);
    options.onError?.(Object.assign(
      new Error(`Interactive Codex CLI transcript failed for ${entry.taskId}`),
      { cause: error },
    ));
    terminateEntry(entry, 'transcript_failed');
  }

  function spawnTerminal(task, cols, rows) {
    if (!codexBinary) throw terminalError('Codex CLI executable is not available', 503);
    if (activeStatuses.has(task.status)) {
      throw terminalError('Wait for the managed task turn to finish before opening interactive CLI');
    }
    if ([...terminals.values()].filter(terminalHasLiveProcesses).length >= maxTerminals) {
      throw terminalError('Interactive terminal capacity has been reached', 503);
    }
    const openTerminalCount = [...terminals.values()]
      .filter(entry => terminalHasLiveProcesses(entry) && entry.clients.size > 0).length;
    if (openTerminalCount >= maxOpenTerminals) {
      throw terminalError('Interactive terminal connection capacity has been reached', 503);
    }
    const runtime = launchContext(task);
    const environment = {
      ...process.env,
      CODEX_HOME: runtime.codexHome,
      WECOM_BRIDGE_SESSION_ID: runtime.sessionId,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TMPDIR: runtime.chatfileDir,
      TMP: runtime.chatfileDir,
      TEMP: runtime.chatfileDir,
    };
    delete environment.NO_COLOR;
    delete environment.CODEX_DESK_AUTH_USER;
    delete environment.CODEX_DESK_AUTH_PASSWORD;
    const args = [
      '--dangerously-bypass-approvals-and-sandbox',
      '-c', `projects.${JSON.stringify(runtime.cwdDir)}.trust_level="trusted"`,
      '-C', runtime.cwdDir,
      'resume', runtime.threadId,
    ];
    const processHandle = pty.spawn(codexBinary, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: runtime.cwdDir,
      env: environment,
    });
    const identity = inspectProcess(processHandle.pid);
    // forkpty owns a new session/group with this PID, but can return before
    // setsid completes. Keep that group identity even if the launcher exits.
    const processIdentity = identity?.parentPid === process.pid
      ? { ...identity, processGroupId: identity.pid, sessionId: identity.pid } : null;
    let resolveExit;
    const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
    const entry = {
      taskId: task.id,
      taskVersion: task.version,
      taskCreatedAt: task.createdAt || '',
      runtimeRecordKey: rememberRuntime(task, runtime),
      runtime,
      process: processHandle,
      processIdentity,
      clients: new Set(),
      replayChunks: [],
      replayBytes: 0,
      cols,
      rows,
      exited: false,
      groupExited: false,
      exitWaitPromise: null,
      terminationRequested: false,
      transcript: null,
      transcriptError: null,
      startupError: null,
      disconnectTimer: null,
      forceKillTimer: null,
      exitPromise,
      resolveExit,
    };
    terminals.set(task.id, entry);
    processHandle.onData((chunk) => {
      if (entry.startupError) return;
      try {
        entry.transcript?.append(chunk);
      } catch (error) {
        recordTranscriptFailure(entry, error);
        return;
      }
      appendReplay(entry, chunk);
      broadcastOutput(entry, chunk);
    });
    processHandle.onExit(({ exitCode, signal }) => {
      clearDisconnectTimer(entry);
      entry.exited = true;
      entry.process = null;
      // The launcher can exit while its native CLI children still own the PTY
      // process group. Keep escalation until the whole group has exited.
      if (entry.forceKillTimer && !terminalProcessGroupIsAlive(entry)) {
        cancelTimer(entry.forceKillTimer);
        entry.forceKillTimer = null;
      }
      try {
        entry.transcript?.seal({ exitCode, signal });
      } catch (error) {
        recordTranscriptFailure(entry, error);
      }
      broadcastControl(entry, { type: 'status', state: 'ended', exitCode, signal });
      audit(task.id, 'session.interactive_cli.ended', `Interactive Codex CLI ended for ${task.id}`, {
        exitCode,
        signal,
        threadId: runtime.threadId,
      });
      entry.resolveExit({ exitCode, signal, transcriptError: entry.transcriptError });
      if (terminalHasLiveProcesses(entry)) {
        terminateEntry(entry, 'launcher_exited');
        waitForExit(entry).catch(error => options.onError?.(error));
      } else releaseExitedEntry(entry);
    });
    try {
      entry.transcript = options.transcripts?.start(task.id, {
        threadId: runtime.threadId,
        pid: processHandle.pid,
      }) || null;
    } catch (error) {
      entry.startupError = terminalError(`Interactive Codex CLI transcript could not be started: ${error.message}`, 507);
      audit(task.id, 'session.interactive_cli.start_failed', `Interactive Codex CLI transcript could not be initialized for ${task.id}`, {
        pid: processHandle.pid, threadId: runtime.threadId,
      });
      terminateEntry(entry, 'transcript_initialization_failed');
      waitForExit(entry).catch(cleanupError => options.onError?.(cleanupError));
      throw entry.startupError;
    }
    audit(task.id, 'session.interactive_cli.started', `Interactive Codex CLI started for ${task.id}`, {
      pid: processHandle.pid,
      threadId: runtime.threadId,
      bridgeSessionId: runtime.sessionId,
    });
    return entry;
  }

  function currentOrSpawn(task, cols, rows) {
    const taskId = task.id;
    let entry = terminals.get(taskId);
    if (entry?.startupError) throw entry.startupError;
    if (entry?.exited) {
      if (terminalHasLiveProcesses(entry)) throw terminalError('Previous CLI process group is still exiting; reconnect again', 503);
      if (terminals.get(taskId) === entry) terminals.delete(taskId);
      entry = null;
    }
    return entry || spawnTerminal(task, cols, rows);
  }

  function attachArchived(task, socket) {
    let disconnected = false;
    const release = () => { disconnected = true; };
    socket.once('close', release);
    socket.once('error', release);
    sendControl(socket, { type: 'status', state: 'connected', pid: null, threadId: '' });
    Promise.resolve(options.transcripts?.replay(
      task.id,
      (chunk) => sendOutput(socket, chunk),
      { cancelled: () => disconnected },
    ))
      .then(() => {
        if (!disconnected) sendControl(socket, { type: 'status', state: 'ended', exitCode: null, signal: null });
      })
      .catch((error) => {
        if (disconnected) return;
        options.onError?.(error);
        sendControl(socket, { type: 'error', message: 'Archived Codex CLI transcript is unavailable' });
        socket.close(1011, 'Archived transcript unavailable');
      });
  }

  function resize(entry, cols, rows) {
    const nextCols = boundedInteger(cols, MIN_COLS, MAX_COLS, entry.cols);
    const nextRows = boundedInteger(rows, MIN_ROWS, MAX_ROWS, entry.rows);
    if (nextCols === entry.cols && nextRows === entry.rows) return;
    entry.cols = nextCols;
    entry.rows = nextRows;
    entry.process?.resize(nextCols, nextRows);
  }

  function terminateEntry(entry, reason) {
    if (!terminalHasLiveProcesses(entry)) return false;
    if (entry.terminationRequested && entry.forceKillTimer) return true;
    const signal = name => {
      // Older Codex launchers keep a native CLI child in the PTY's process group.
      // forkpty may return before its child has completed setsid(). Bind the PID
      // at spawn, then inspect its final group when sending the signal.
      const original = entry.processIdentity;
      const current = original ? inspectProcess(original.pid) : null;
      if (original && current && current.startTicks !== original.startTicks) return;
      if (current?.parentPid === process.pid && current.processGroupId === current.pid && current.sessionId === current.pid) {
        entry.processIdentity = current;
      }
      if (terminalProcessGroupIsAlive(entry)) {
        signalVerifiedProcessGroup(entry.processIdentity, name);
      } else if (!entry.exited && entry.process) entry.process.kill(name);
    };
    try {
      signal('SIGTERM');
      entry.terminationRequested = true;
      clearDisconnectTimer(entry);
      entry.forceKillTimer = scheduleTimer(() => {
        entry.forceKillTimer = null;
        if ((entry.exited || !entry.process) && !terminalProcessGroupIsAlive(entry)) return;
        try { signal('SIGKILL'); } catch (error) { options.onError?.(error); }
      }, 2000);
      entry.forceKillTimer.unref?.();
    } catch (error) {
      options.onError?.(Object.assign(
        new Error(`Failed to terminate interactive Codex CLI for ${entry.taskId}`),
        { cause: error },
      ));
      return false;
    }
    audit(
      entry.taskId,
      'session.interactive_cli.termination_requested',
      `Interactive Codex CLI termination requested for ${entry.taskId}`,
      { reason, threadId: entry.runtime.threadId },
    );
    return true;
  }

  function attach(taskId, socket, dimensions = {}) {
    if (stopping) throw terminalError('Interactive terminals are shutting down', 503);
    if (completionOperations.has(taskId)) throw terminalError('Task completion is in progress; reconnect after it finishes', 503);
    const task = options.getTask(taskId);
    if (!task) throw terminalError('Task not found', 404);
    if (task.releaseCycleStatus === 'deleting') throw terminalError('Task is being deleted with its release cycle');
    if (task.status === 'completed') {
      attachArchived(task, socket);
      return;
    }
    const cols = boundedInteger(dimensions.cols, MIN_COLS, MAX_COLS, 100);
    const rows = boundedInteger(dimensions.rows, MIN_ROWS, MAX_ROWS, 30);
    const entry = currentOrSpawn(task, cols, rows);
    clearDisconnectTimer(entry);
    entry.clients.add(socket);
    resize(entry, cols, rows);
    sendControl(socket, {
      type: 'status',
      state: entry.exited ? 'ended' : 'connected',
      pid: entry.process?.pid || null,
      threadId: entry.runtime.threadId,
    });
    for (const chunk of entry.replayChunks) {
      if (socket.readyState === WebSocket.OPEN) socket.send(chunk, { binary: true });
    }

    const release = () => {
      entry.clients.delete(socket);
      if (entry.exited) {
        releaseExitedEntry(entry);
        return;
      }
      scheduleDisconnectedTermination(entry);
    };
    socket.once('close', release);
    socket.once('error', release);
    socket.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > MAX_INPUT_BYTES) {
        socket.close(1009, 'Terminal message is too large');
        return;
      }
      let message;
      try { message = JSON.parse(raw.toString('utf8')); } catch {
        socket.close(1007, 'Terminal message must be valid JSON');
        return;
      }
      if (message.type === 'input') {
        const input = String(message.data || '');
        if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
          socket.close(1009, 'Terminal input is too large');
          return;
        }
        entry.process?.write(input);
      } else if (message.type === 'resize') {
        resize(entry, message.cols, message.rows);
      } else if (message.type === 'interrupt') {
        entry.process?.write('\x03');
      } else if (message.type === 'terminate') {
        terminateEntry(entry, 'operator');
      }
    });
  }

  async function attachWhenReady(taskId, socket, dimensions = {}) {
    let runtimeReady = false;
    while (socket.readyState === WebSocket.OPEN) {
      const completion = completionOperations.get(taskId);
      if (completion) {
        // The HTTP caller receives a completion failure. A waiting browser can
        // resume the still-reviewable Task when that operation has finished.
        await completion.catch(() => {});
        runtimeReady = false;
        continue;
      }
      const entry = terminals.get(taskId);
      if (entry && (entry.terminationRequested || entry.exited) && terminalHasLiveProcesses(entry)) {
        terminateEntry(entry, 'reconnect');
        await waitForExit(entry);
        runtimeReady = false;
        continue;
      }
      if (!runtimeReady && options.beforeConnect) {
        await options.beforeConnect(taskId);
        runtimeReady = true;
        continue;
      }
      attach(taskId, socket, dimensions);
      return;
    }
  }

  function withTaskCompletion(taskId, operation) {
    if (stopping) return Promise.reject(terminalError('Interactive terminals are shutting down', 503));
    const previous = completionOperations.get(taskId) || Promise.resolve();
    const completion = previous.catch(() => {}).then(operation).finally(() => {
      if (completionOperations.get(taskId) === completion) completionOperations.delete(taskId);
    });
    completionOperations.set(taskId, completion);
    return completion;
  }

  function terminate(taskId, reason = 'operator') {
    return terminateEntry(terminals.get(taskId), reason);
  }

  function assertTranscriptHealthy(taskId) {
    const error = transcriptFailures.get(taskId) || terminals.get(taskId)?.transcriptError;
    if (error) throw terminalError(`Interactive Codex CLI transcript is incomplete: ${error.message}`, 507);
  }

  function waitForExit(entry) {
    if (entry.exitWaitPromise) return entry.exitWaitPromise;
    entry.exitWaitPromise = (async () => {
      let timer;
      let cancelled = false;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(terminalError('Timed out waiting for the interactive Codex CLI to end', 504)), terminationTimeoutMs);
      });
      const exited = entry.exitPromise.then(async result => {
        while (!cancelled && terminalProcessGroupIsAlive(entry)) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        return result;
      });
      try { return await Promise.race([exited, timeout]); }
      finally { cancelled = true; clearTimeout(timer); }
    })().finally(() => {
      entry.exitWaitPromise = null;
      if (!terminalHasLiveProcesses(entry) && entry.forceKillTimer) {
        cancelTimer(entry.forceKillTimer);
        entry.forceKillTimer = null;
      }
      releaseExitedEntry(entry);
    });
    return entry.exitWaitPromise;
  }

  async function terminateAndWait(taskId, reason = 'operator', expectedCreatedAt = '') {
    const entry = terminals.get(taskId);
    if (expectedCreatedAt && entry?.taskCreatedAt && entry.taskCreatedAt !== expectedCreatedAt) return false;
    if (!terminalHasLiveProcesses(entry)) {
      assertTranscriptHealthy(taskId);
      return false;
    }
    if (!terminateEntry(entry, reason)) {
      throw terminalError('Interactive Codex CLI could not be terminated', 503);
    }
    const result = await waitForExit(entry);
    if (result.transcriptError) {
      throw terminalError(`Interactive Codex CLI transcript is incomplete: ${result.transcriptError.message}`, 507);
    }
    assertTranscriptHealthy(taskId);
    return true;
  }

  function isRunning(taskId) {
    return terminalHasLiveProcesses(terminals.get(taskId));
  }

  async function terminateForDeletion(taskId, expectedCreatedAt = '') {
    const entry = terminals.get(taskId);
    if (!entry) {
      const current = options.getTask(taskId);
      if (!expectedCreatedAt || !current || current.createdAt === expectedCreatedAt) transcriptFailures.delete(taskId);
      return;
    }
    if (expectedCreatedAt && entry.taskCreatedAt && entry.taskCreatedAt !== expectedCreatedAt) return;
    if (terminalHasLiveProcesses(entry)) {
      if (!terminateEntry(entry, 'release_cycle_deleted')) throw terminalError('Interactive CLI could not be terminated', 503);
      await waitForExit(entry);
    }
    clearDisconnectTimer(entry);
    for (const client of entry.clients) client.terminate();
    if (terminals.get(taskId) === entry) terminals.delete(taskId);
    transcriptFailures.delete(taskId);
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    const entries = [...terminals.values()];
    shutdownPromise = (async () => {
      if (completionOperations.size) await Promise.allSettled([...completionOperations.values()]);
      const terminalsStopped = await Promise.allSettled(entries.map(async entry => {
        clearDisconnectTimer(entry);
        for (const client of entry.clients) client.terminate();
        if (terminalHasLiveProcesses(entry)) {
          if (!terminateEntry(entry, 'server_shutdown')) {
            throw terminalError(`Interactive Codex CLI could not be terminated for ${entry.taskId}`, 503);
          }
          await waitForExit(entry);
        }
        assertTranscriptHealthy(entry.taskId);
      }));
      const runtimesStopped = await Promise.allSettled([...runtimeRecords.values()]
        .filter(record => !entries.some(entry => entry.runtimeRecordKey === record.key && terminalHasLiveProcesses(entry)))
        .map(releaseRecordedRuntime));
      const errors = [...terminalsStopped, ...runtimesStopped]
        .filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, `Interactive Codex shutdown failed: ${errors.map(error => error.message).join('; ')}`);
      terminals.clear();
    })();
    return shutdownPromise;
  }

  return { attach, attachWhenReady, withTaskCompletion, isRunning, terminate, terminateAndWait, terminateForDeletion,
    forgetReleasedRuntime, assertTranscriptHealthy, shutdown };
}

module.exports = {
  boundedInteger,
  createCodexTerminalManager,
  DEFAULT_REPLAY_BYTES,
  MAX_REPLAY_BYTES,
  resolveCodexBinary,
};
