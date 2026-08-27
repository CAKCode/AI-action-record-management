'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  DEFAULT_REPLAY_BYTES,
  MAX_REPLAY_BYTES,
  createCodexTerminalManager,
} = require('../src/codex-terminal');

class FakePtyProcess {
  constructor() {
    this.pid = 4812;
    this.writes = [];
    this.resizes = [];
    this.kills = [];
    this.dataListeners = [];
    this.exitListeners = [];
  }

  onData(listener) { this.dataListeners.push(listener); }
  onExit(listener) { this.exitListeners.push(listener); }
  write(value) { this.writes.push(value); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  kill(signal) { this.kills.push(signal); }
  emitData(value) { this.dataListeners.forEach((listener) => listener(value)); }
  emitExit(value) { this.exitListeners.forEach((listener) => listener(value)); }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.messages = [];
    this.closeCalls = [];
    this.terminated = false;
  }

  send(value, options, callback) {
    this.messages.push(value);
    const done = typeof options === 'function' ? options : callback;
    done?.();
  }
  close(code, reason) { this.closeCalls.push([code, reason]); this.readyState = 3; this.emit('close'); }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close'); }
}

function message(socket, payload) {
  socket.emit('message', Buffer.from(JSON.stringify(payload)), false);
}

test('interactive Codex terminal resumes the isolated task thread and replays output on reconnect', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-'));
  const cwdDir = path.join(tempDir, 'workfile');
  const codexHome = path.join(tempDir, 'codex-home');
  const chatfileDir = path.join(tempDir, 'chatfiles');
  for (const directory of [cwdDir, codexHome, chatfileDir]) fs.mkdirSync(directory);
  const processHandle = new FakePtyProcess();
  const spawnCalls = [];
  const auditEvents = [];
  const transcriptChunks = [];
  const transcriptSeals = [];
  const manager = createCodexTerminalManager({
    getTask: () => ({
      id: 'terminal-task', status: 'waiting_review', version: 3,
      persistentSessionKey: 'single:terminal-task-1234',
    }),
    activeStatuses: ['queued', 'running'],
    codexBinary: '/usr/bin/codex-test',
    pty: {
      spawn(command, args, options) {
        spawnCalls.push({ command, args, options });
        return processHandle;
      },
    },
    resolveRuntime: () => ({
      sessionId: 'session-1234567890abcdef',
      threadId: '019f-thread-id',
      cwdDir,
      codexHome,
      chatfileDir,
    }),
    transcripts: {
      start(taskId, metadata) {
        assert.equal(taskId, 'terminal-task');
        assert.equal(metadata.threadId, '019f-thread-id');
        return {
          append(chunk) { transcriptChunks.push(Buffer.from(chunk)); },
          seal(result) { transcriptSeals.push(result); },
        };
      },
    },
    appendWorklog(taskId, event) { auditEvents.push({ taskId, event }); },
  });

  const firstSocket = new FakeSocket();
  manager.attach('terminal-task', firstSocket, { cols: 120, rows: 38 });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, '/usr/bin/codex-test');
  assert.deepEqual(spawnCalls[0].args, [
    '--dangerously-bypass-approvals-and-sandbox',
    '-c', `projects.${JSON.stringify(cwdDir)}.trust_level="trusted"`,
    '-C', cwdDir,
    'resume', '019f-thread-id',
  ]);
  assert.equal(spawnCalls[0].options.env.CODEX_HOME, codexHome);
  assert.equal(spawnCalls[0].options.env.TERM, 'xterm-256color');
  assert.equal(JSON.parse(firstSocket.messages[0]).state, 'connected');

  message(firstSocket, { type: 'input', data: '/model\r' });
  message(firstSocket, { type: 'resize', cols: 132, rows: 44 });
  message(firstSocket, { type: 'interrupt' });
  assert.deepEqual(processHandle.writes, ['/model\r', '\x03']);
  assert.deepEqual(processHandle.resizes, [[132, 44]]);

  processHandle.emitData('\u001b[32mCodex ready\u001b[0m');
  assert.equal(Buffer.concat(transcriptChunks).toString(), '\u001b[32mCodex ready\u001b[0m');
  assert.ok(Buffer.isBuffer(firstSocket.messages.at(-1)));
  const secondSocket = new FakeSocket();
  manager.attach('terminal-task', secondSocket, { cols: 132, rows: 44 });
  assert.equal(spawnCalls.length, 1);
  assert.equal(Buffer.concat(secondSocket.messages.filter(Buffer.isBuffer)).toString(), '\u001b[32mCodex ready\u001b[0m');
  assert.equal(auditEvents[0].event.kind, 'session.interactive_cli.started');

  message(secondSocket, { type: 'terminate' });
  assert.deepEqual(processHandle.kills, ['SIGTERM']);
  assert.equal(auditEvents.at(-1).event.kind, 'session.interactive_cli.termination_requested');
  assert.equal(auditEvents.at(-1).event.payload.reason, 'operator');
  processHandle.emitExit({ exitCode: 0, signal: 15 });
  assert.deepEqual(transcriptSeals, [{ exitCode: 0, signal: 15 }]);
  assert.equal(JSON.parse(firstSocket.messages.at(-1)).state, 'ended');
  assert.equal(auditEvents.at(-1).event.kind, 'session.interactive_cli.ended');
  manager.shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('interactive Codex replay window honors the configured high-water mark', () => {
  assert.equal(DEFAULT_REPLAY_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_REPLAY_BYTES, 128 * 1024 * 1024);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-replay-window-'));
  const runtime = {
    sessionId: 'session-replay-window',
    threadId: '019f-replay-window-thread',
    cwdDir: path.join(tempDir, 'workfile'),
    codexHome: path.join(tempDir, 'codex-home'),
    chatfileDir: path.join(tempDir, 'chatfiles'),
  };
  for (const directory of [runtime.cwdDir, runtime.codexHome, runtime.chatfileDir]) fs.mkdirSync(directory);
  const processHandle = new FakePtyProcess();
  const manager = createCodexTerminalManager({
    getTask: () => ({
      id: 'replay-window-task', status: 'waiting_review', version: 1,
      persistentSessionKey: 'single:replay-window-task',
    }),
    environment: {
      CODEX_INTERACTIVE_REPLAY_BYTES: String(64 * 1024),
      CODEX_INTERACTIVE_DISCONNECT_TIMEOUT_MS: '0',
    },
    codexBinary: '/usr/bin/codex-test',
    pty: { spawn: () => processHandle },
    resolveRuntime: () => runtime,
    transcripts: { start: () => ({ append() {}, seal() {} }) },
  });
  const firstSocket = new FakeSocket();
  manager.attach('replay-window-task', firstSocket);
  const firstChunk = Buffer.alloc(40 * 1024, 'a');
  const secondChunk = Buffer.alloc(40 * 1024, 'b');
  processHandle.emitData(firstChunk);
  processHandle.emitData(secondChunk);
  const reconnectSocket = new FakeSocket();
  manager.attach('replay-window-task', reconnectSocket);
  const replay = Buffer.concat(reconnectSocket.messages.filter(Buffer.isBuffer));
  assert.equal(replay.length, secondChunk.length);
  assert.equal(replay[0], 'b'.charCodeAt(0));
  manager.shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('interactive Codex terminal explains when its expired home must be recreated', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-expired-home-'));
  const runtime = {
    sessionId: 'session-expired-home',
    threadId: '019f-expired-home-thread',
    cwdDir: path.join(tempDir, 'workfile'),
    codexHome: path.join(tempDir, 'codex-home'),
    chatfileDir: path.join(tempDir, 'chatfiles'),
  };
  fs.mkdirSync(runtime.cwdDir, { recursive: true });
  fs.mkdirSync(runtime.chatfileDir, { recursive: true });
  const manager = createCodexTerminalManager({
    getTask: () => ({
      id: 'expired-home-task', status: 'waiting_review', version: 1,
      persistentSessionKey: 'single:expired-home-task',
    }),
    codexBinary: '/usr/bin/codex-test',
    resolveRuntime: () => runtime,
  });

  assert.throws(
    () => manager.attach('expired-home-task', new FakeSocket()),
    /Codex Home has expired; run the task once to recreate its Runtime before reconnecting/,
  );
  manager.shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('reconnecting after exit starts a new terminal without stale cleanup removing it', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-reconnect-'));
  const runtime = {
    sessionId: 'session-reconnect',
    threadId: '019f-reconnect-thread',
    cwdDir: path.join(tempDir, 'workfile'),
    codexHome: path.join(tempDir, 'codex-home'),
    chatfileDir: path.join(tempDir, 'chatfiles'),
  };
  for (const directory of [runtime.cwdDir, runtime.codexHome, runtime.chatfileDir]) fs.mkdirSync(directory);
  const processes = [];
  const manager = createCodexTerminalManager({
    getTask: () => ({
      id: 'reconnect-task', status: 'waiting_review', version: 1,
      persistentSessionKey: 'single:reconnect-task',
    }),
    codexBinary: '/usr/bin/codex-test',
    pty: {
      spawn() {
        const processHandle = new FakePtyProcess();
        processes.push(processHandle);
        return processHandle;
      },
    },
    resolveRuntime: () => runtime,
  });

  const staleSocket = new FakeSocket();
  manager.attach('reconnect-task', staleSocket);
  processes[0].emitExit({ exitCode: 0, signal: 0 });

  const activeSocket = new FakeSocket();
  manager.attach('reconnect-task', activeSocket);
  assert.equal(processes.length, 2);
  assert.equal(manager.isRunning('reconnect-task'), true);
  assert.equal(JSON.parse(activeSocket.messages[0]).state, 'connected');

  staleSocket.emit('close');
  assert.equal(manager.isRunning('reconnect-task'), true);
  processes[0].emitExit({ exitCode: 0, signal: 0 });
  assert.equal(manager.isRunning('reconnect-task'), true);
  const sharedSocket = new FakeSocket();
  manager.attach('reconnect-task', sharedSocket);
  assert.equal(processes.length, 2);

  const terminated = manager.terminateAndWait('reconnect-task', 'task_completed');
  assert.equal(manager.terminate('reconnect-task', 'task_completed'), true);
  assert.deepEqual(processes[1].kills, ['SIGTERM']);
  processes[1].emitExit({ exitCode: 0, signal: 15 });
  assert.equal(await terminated, true);

  manager.shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a disconnected interactive terminal is terminated after its reconnect grace period', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-disconnect-'));
  const runtime = {
    sessionId: 'session-disconnect',
    threadId: '019f-disconnect-thread',
    cwdDir: path.join(tempDir, 'workfile'),
    codexHome: path.join(tempDir, 'codex-home'),
    chatfileDir: path.join(tempDir, 'chatfiles'),
  };
  for (const directory of [runtime.cwdDir, runtime.codexHome, runtime.chatfileDir]) fs.mkdirSync(directory);
  const processHandle = new FakePtyProcess();
  const timers = [];
  const manager = createCodexTerminalManager({
    getTask: () => ({
      id: 'disconnect-task', status: 'waiting_review', version: 1,
      persistentSessionKey: 'single:disconnect-task',
    }),
    codexBinary: '/usr/bin/codex-test',
    pty: { spawn() { return processHandle; } },
    resolveRuntime: () => runtime,
    environment: { CODEX_INTERACTIVE_DISCONNECT_TIMEOUT_MS: '' },
    setTimeout(callback) {
      const timer = { callback, cancelled: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cancelled = true; },
  });

  const disconnectedSocket = new FakeSocket();
  manager.attach('disconnect-task', disconnectedSocket);
  disconnectedSocket.emit('close');
  assert.equal(timers.length, 1);
  timers[0].callback();
  assert.deepEqual(processHandle.kills, ['SIGTERM']);

  const reconnectingSocket = new FakeSocket();
  manager.attach('disconnect-task', reconnectingSocket);
  reconnectingSocket.emit('close');
  assert.equal(timers.length, 2);
  const resumedSocket = new FakeSocket();
  manager.attach('disconnect-task', resumedSocket);
  assert.equal(timers[1].cancelled, true);

  processHandle.emitExit({ exitCode: 0, signal: 15 });
  manager.shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('completed tasks replay archived CLI output without spawning Codex', async () => {
  const replayed = Buffer.from('\u001b[32mfull archived transcript\u001b[0m\r\n');
  const manager = createCodexTerminalManager({
    getTask: () => ({ id: 'archived-task', status: 'completed' }),
    codexBinary: '/usr/bin/codex-test',
    pty: { spawn() { throw new Error('must not spawn for completed task'); } },
    transcripts: {
      async replay(taskId, onChunk) {
        assert.equal(taskId, 'archived-task');
        await onChunk(replayed);
      },
    },
  });
  const socket = new FakeSocket();
  manager.attach('archived-task', socket);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(socket.messages.some((entry) => Buffer.isBuffer(entry) && entry.equals(replayed)));
  assert.equal(JSON.parse(socket.messages.at(-1)).state, 'ended');
  assert.equal(manager.isRunning('archived-task'), false);
  manager.shutdown();
});

test('interactive terminal refuses to overlap a managed task turn', () => {
  const manager = createCodexTerminalManager({
    getTask: () => ({ id: 'running-task', status: 'running', persistentSessionKey: 'single:running-task' }),
    activeStatuses: ['running'],
    codexBinary: '/usr/bin/codex-test',
    pty: { spawn() { throw new Error('must not spawn'); } },
  });
  assert.throws(
    () => manager.attach('running-task', new FakeSocket()),
    (error) => error.statusCode === 409 && /managed task turn/.test(error.message),
  );
});
