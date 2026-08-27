'use strict';

const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const { resolveBridgeSessionRuntime } = require('./bridge-runtime-cleanup');

const DEFAULT_MAX_TERMINALS = 6;
const DEFAULT_REPLAY_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY_BYTES = 128 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;
const DEFAULT_TERMINATION_TIMEOUT_MS = 5000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 15 * 60 * 1000;

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
  const transcriptFailures = new Map();

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
    if (disconnectTimeoutMs === 0 || entry.exited || entry.clients.size > 0 || entry.disconnectTimer) return;
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
    if (terminals.size >= maxTerminals) {
      throw terminalError('Interactive terminal capacity has been reached', 503);
    }
    const runtime = launchContext(task);
    const environment = {
      ...process.env,
      CODEX_HOME: runtime.codexHome,
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
    let transcript = null;
    try {
      transcript = options.transcripts?.start(task.id, {
        threadId: runtime.threadId,
        pid: processHandle.pid,
      }) || null;
    } catch (error) {
      try { processHandle.kill('SIGTERM'); } catch {}
      throw terminalError(`Interactive Codex CLI transcript could not be started: ${error.message}`, 507);
    }
    let resolveExit;
    const exitPromise = new Promise((resolve) => { resolveExit = resolve; });
    const entry = {
      taskId: task.id,
      taskVersion: task.version,
      runtime,
      process: processHandle,
      clients: new Set(),
      replayChunks: [],
      replayBytes: 0,
      cols,
      rows,
      exited: false,
      terminationRequested: false,
      transcript,
      transcriptError: null,
      disconnectTimer: null,
      exitPromise,
      resolveExit,
    };
    terminals.set(task.id, entry);
    processHandle.onData((chunk) => {
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
      if (entry.clients.size === 0 && terminals.get(task.id) === entry) terminals.delete(task.id);
    });
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
    if (entry?.exited) {
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
    if (!entry || entry.exited || !entry.process) return false;
    if (entry.terminationRequested) return true;
    try {
      entry.process.kill('SIGTERM');
      entry.terminationRequested = true;
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
    const task = options.getTask(taskId);
    if (!task) throw terminalError('Task not found', 404);
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
      if (entry.exited && entry.clients.size === 0 && terminals.get(taskId) === entry) {
        terminals.delete(taskId);
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

  function terminate(taskId, reason = 'operator') {
    return terminateEntry(terminals.get(taskId), reason);
  }

  function assertTranscriptHealthy(taskId) {
    const error = transcriptFailures.get(taskId) || terminals.get(taskId)?.transcriptError;
    if (error) throw terminalError(`Interactive Codex CLI transcript is incomplete: ${error.message}`, 507);
  }

  async function terminateAndWait(taskId, reason = 'operator') {
    const entry = terminals.get(taskId);
    if (!entry || entry.exited || !entry.process) {
      assertTranscriptHealthy(taskId);
      return false;
    }
    if (!terminateEntry(entry, reason)) {
      throw terminalError('Interactive Codex CLI could not be terminated', 503);
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(terminalError('Timed out waiting for the interactive Codex CLI to end', 504)), terminationTimeoutMs);
    });
    try {
      const result = await Promise.race([entry.exitPromise, timeout]);
      if (result.transcriptError) {
        throw terminalError(`Interactive Codex CLI transcript is incomplete: ${result.transcriptError.message}`, 507);
      }
      assertTranscriptHealthy(taskId);
      return true;
    } finally {
      clearTimeout(timer);
    }
  }

  function isRunning(taskId) {
    const entry = terminals.get(taskId);
    return Boolean(entry && !entry.exited && entry.process);
  }

  function shutdown() {
    for (const entry of terminals.values()) {
      clearDisconnectTimer(entry);
      for (const client of entry.clients) client.terminate();
      try { entry.process?.kill('SIGTERM'); } catch {}
    }
    terminals.clear();
  }

  return { attach, isRunning, terminate, terminateAndWait, assertTranscriptHealthy, shutdown };
}

module.exports = {
  boundedInteger,
  createCodexTerminalManager,
  DEFAULT_REPLAY_BYTES,
  MAX_REPLAY_BYTES,
  resolveCodexBinary,
};
