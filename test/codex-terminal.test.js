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

test('interactive Codex terminal resumes the isolated task thread and replays output on reconnect', async () => {
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
  assert.equal(spawnCalls[0].options.env.WECOM_BRIDGE_SESSION_ID, 'session-1234567890abcdef');
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
  await manager.shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('interactive Codex replay window honors the configured high-water mark', async () => {
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
  processHandle.emitExit({ exitCode: 0, signal: 0 });
  await manager.shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('interactive Codex terminal explains when its expired home must be recreated', async () => {
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
  await manager.shutdown();
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

  await manager.shutdown();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('a disconnected terminal exits before reconnect resumes the same thread', async () => {
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
  const nextProcess = new FakePtyProcess();
  let spawns = 0;
  const timers = [];
  const manager = createCodexTerminalManager({
    getTask: () => ({
      id: 'disconnect-task', status: 'waiting_review', version: 1,
      persistentSessionKey: 'single:disconnect-task',
    }),
    codexBinary: '/usr/bin/codex-test',
    pty: { spawn(_command, args) {
      assert.equal(args.at(-1), runtime.threadId);
      return spawns++ === 0 ? processHandle : nextProcess;
    } },
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
  const reconnecting = manager.attachWhenReady('disconnect-task', reconnectingSocket);
  assert.equal(spawns, 1);
  processHandle.emitExit({ exitCode: 0, signal: 15 });
  await reconnecting;
  assert.equal(spawns, 2);
  reconnectingSocket.emit('close');
  assert.equal(timers.length, 3);
  const resumedSocket = new FakeSocket();
  manager.attach('disconnect-task', resumedSocket);
  assert.equal(timers[2].cancelled, true);

  nextProcess.emitExit({ exitCode: 0, signal: 15 });
  await manager.shutdown();
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
  await manager.shutdown();
});

for (const completionFails of [false, true]) {
  test(`reconnect waits for Task completion and follows its result (failed=${completionFails})`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-completion-'));
    const runtime = { sessionId: 'session-1234567890abcdef', threadId: 'fixture-thread',
      cwdDir: directory, codexHome: directory, chatfileDir: directory };
    const task = { id: 'completion-task', createdAt: '2026-01-01T00:00:00Z', status: 'waiting_review',
      persistentSessionKey: 'single:completion-task' };
    const processes = [];
    const replayed = Buffer.from('archived terminal output');
    let finishedCompletion = false;
    let runtimeWaits = 0;
    let releaseRuntimeLease;
    const runtimeReleased = new Promise(resolve => { releaseRuntimeLease = resolve; });
    const manager = createCodexTerminalManager({ getTask: () => task, resolveRuntime: () => runtime,
      codexBinary: '/usr/bin/fixture-codex',
      pty: { spawn() { const process = new FakePtyProcess(); processes.push(process); return process; } },
      transcripts: { start() { return { append() {}, seal() {} }; },
        async replay(_id, send) { await send(replayed); } },
      beforeConnect: async () => {
        assert.equal(finishedCompletion, true);
        runtimeWaits++;
        await runtimeReleased;
      },
      releaseRuntime: async () => ({ released: [], errors: [] }),
    });
    t.after(async () => {
      for (const process of processes) process.emitExit({ exitCode: 0, signal: 15 });
      await manager.shutdown();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    manager.attach(task.id, new FakeSocket());
    let continueCompletion;
    const blocked = new Promise(resolve => { continueCompletion = resolve; });
    let verificationStarted;
    const verifying = new Promise(resolve => { verificationStarted = resolve; });
    const completion = manager.withTaskCompletion(task.id, async () => {
      await manager.terminateAndWait(task.id, 'task_completed', task.createdAt);
      verificationStarted();
      await blocked;
      finishedCompletion = true;
      if (completionFails) throw new Error('Fixture transcript verification failed');
      task.status = 'completed';
    });
    const outcome = completion.then(() => null, error => error);
    await new Promise(resolve => setImmediate(resolve));
    processes[0].emitExit({ exitCode: 0, signal: 15 });
    await verifying;
    const socket = new FakeSocket();
    let connected = false;
    const reconnect = manager.attachWhenReady(task.id, socket).then(() => { connected = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(connected, false);
    assert.equal(processes.length, 1);
    assert.equal(runtimeWaits, 0);
    continueCompletion();
    const error = await outcome;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtimeWaits, 1);
    assert.equal(processes.length, 1);
    releaseRuntimeLease();
    await reconnect;
    await new Promise(resolve => setImmediate(resolve));
    if (completionFails) {
      assert.match(error.message, /verification failed/);
      assert.equal(task.status, 'waiting_review');
      assert.equal(processes.length, 2);
      assert.equal(manager.isRunning(task.id), true);
    } else {
      assert.equal(error, null);
      assert.equal(processes.length, 1);
      assert.equal(manager.isRunning(task.id), false);
      assert(socket.messages.some(message => Buffer.isBuffer(message) && message.equals(replayed)));
    }
  });
}

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

function terminalFixture(t, options = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-lifecycle-'));
  const runtime = { sessionId: 'session-1234567890abcdef', threadId: 'retained-thread',
    cwdDir: path.join(temp, 'workfile'), codexHome: path.join(temp, 'home'), chatfileDir: path.join(temp, 'chatfiles') };
  for (const directory of [runtime.cwdDir, runtime.codexHome, runtime.chatfileDir]) fs.mkdirSync(directory);
  const processes = [];
  const manager = createCodexTerminalManager({
    getTask: id => ({ id, status: 'waiting_review', persistentSessionKey: `single:${id}` }),
    codexBinary: '/usr/bin/codex-test', resolveRuntime: () => runtime,
    pty: { spawn() { const processHandle = new FakePtyProcess(); processes.push(processHandle); return processHandle; } },
    ...options,
  });
  t.after(async () => {
    for (const processHandle of processes) processHandle.emitExit({ exitCode: 0, signal: 0 });
    await manager.shutdown().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return { manager, processes, runtime };
}

test('exited terminals release capacity while their browser connections remain open', async t => {
  const { manager, processes } = terminalFixture(t, { maxTerminals: 1 });
  const historySocket = new FakeSocket();
  manager.attach('old-task', historySocket);
  processes[0].emitData('retained output');
  processes[0].emitExit({ exitCode: 0, signal: 0 });
  assert.equal(manager.isRunning('old-task'), false);
  assert.equal(historySocket.readyState, 1);
  assert.equal(JSON.parse(historySocket.messages.at(-1)).state, 'ended');
  manager.attach('new-task', new FakeSocket());
  assert.equal(processes.length, 2);
  assert.equal(manager.isRunning('new-task'), true);
  assert.throws(() => manager.attach('third-task', new FakeSocket()), /capacity has been reached/);
  historySocket.emit('close');
  assert.equal(manager.isRunning('new-task'), true);
});

test('detached CLI retains process safety while releasing the open terminal slot', async t => {
  const { manager, processes } = terminalFixture(t, {
    maxTerminals: 2,
    maxOpenTerminals: 1,
    disconnectTimeoutMs: 0,
  });
  const firstSocket = new FakeSocket();
  manager.attach('detached-task', firstSocket);
  firstSocket.emit('close');

  const secondSocket = new FakeSocket();
  manager.attach('new-open-task', secondSocket);
  assert.equal(processes.length, 2);
  assert.equal(manager.isRunning('detached-task'), true);
  assert.equal(manager.isRunning('new-open-task'), true);
});

test('shutdown waits for CLI exit and helper release and refuses late reconnects', async t => {
  let finishRelease;
  const { manager, processes, runtime } = terminalFixture(t, { releaseRuntime: target => {
    assert.equal(target, runtime);
    return new Promise(resolve => { finishRelease = resolve; });
  } });
  const socket = new FakeSocket();
  manager.attach('shutdown-task', socket);
  let finished = false;
  const shutdown = manager.shutdown();
  assert.equal(typeof shutdown?.then, 'function');
  shutdown.then(() => { finished = true; });
  assert.equal(manager.shutdown(), shutdown);
  assert.equal(socket.terminated, true);
  assert.deepEqual(processes[0].kills, ['SIGTERM']);
  assert.equal(manager.isRunning('shutdown-task'), true);
  assert.throws(() => manager.attach('late-task', new FakeSocket()), error => error.statusCode === 503);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  processes[0].emitExit({ exitCode: 0, signal: 15 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  finishRelease({ released: [123], errors: [] });
  await shutdown;
  assert.equal(finished, true);
  assert.equal(manager.isRunning('shutdown-task'), false);
  await assert.rejects(manager.attachWhenReady('shutdown-task', new FakeSocket()), error => error.statusCode === 503);
});

test('shutdown keeps the force-kill timer alive until a stubborn CLI confirms exit', async t => {
  const timers = [];
  const { manager, processes } = terminalFixture(t, {
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, cancelled: false, unref() {} };
      timers.push(timer); return timer;
    },
    clearTimeout(timer) { timer.cancelled = true; },
  });
  manager.attach('stubborn-task', new FakeSocket());
  const shutdown = manager.shutdown();
  assert.deepEqual(processes[0].kills, ['SIGTERM']);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].milliseconds, 2000);
  assert.equal(timers[0].cancelled, false);
  timers[0].callback();
  assert.deepEqual(processes[0].kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(manager.isRunning('stubborn-task'), true);
  processes[0].emitExit({ exitCode: 0, signal: 9 });
  await shutdown;
  assert.equal(manager.isRunning('stubborn-task'), false);
});

test('shutdown reports a failed CLI exit after the other terminals have finished', async t => {
  const released = [];
  const { manager, processes } = terminalFixture(t, { terminationTimeoutMs: 100,
    releaseRuntime: async runtime => { released.push(runtime); return { released: [], errors: [] }; },
  });
  manager.attach('stuck-task', new FakeSocket());
  manager.attach('healthy-task', new FakeSocket());
  const shutdown = manager.shutdown();
  assert.deepEqual(processes.map(handle => handle.kills), [['SIGTERM'], ['SIGTERM']]);
  processes[1].emitExit({ exitCode: 0, signal: 15 });
  await assert.rejects(shutdown, error => error instanceof AggregateError && /Timed out/.test(error.message));
  assert.equal(manager.isRunning('stuck-task'), true);
  assert.equal(manager.isRunning('healthy-task'), false);
  assert.equal(released.length, 1);
});

test('shutdown reports helper release failures instead of returning success', async t => {
  const { manager, processes } = terminalFixture(t, {
    releaseRuntime: async () => ({ released: [], errors: [{ pid: 123, error: 'process is still running' }] }),
  });
  manager.attach('helper-failure-task', new FakeSocket());
  const shutdown = manager.shutdown();
  processes[0].emitExit({ exitCode: 0, signal: 15 });
  await assert.rejects(shutdown, /Codex runtime release failed.*process is still running/);
});

test('a prepared stop cannot terminate a CLI opened for a replacement Task generation', async t => {
  const { manager, processes } = terminalFixture(t, {
    getTask: id => ({ id, createdAt: '2099-01-01T00:00:00.000Z', status: 'waiting_review',
      persistentSessionKey: `single:${id}` }),
  });
  manager.attach('replaced-cli-task', new FakeSocket());
  assert.equal(await manager.terminateAndWait('replaced-cli-task', 'task_stopped', '2026-01-01T00:00:00.000Z'), false);
  assert.deepEqual(processes[0].kills, []);
  assert.equal(manager.isRunning('replaced-cli-task'), true);
});

for (const outcome of ['released', 'wrong-generation', 'failed']) {
  test(`idle runtime ${outcome} only forgets a verified matching CLI ownership record`, async t => {
    const taskCreatedAt = '2099-01-01T00:00:00.000Z';
    let releases = 0;
    const { manager, processes, runtime } = terminalFixture(t, {
      getTask: id => ({ id, createdAt: taskCreatedAt, status: 'waiting_review', persistentSessionKey: `single:${id}` }),
      releaseRuntime: async () => { releases++; return { released: [], errors: [] }; },
    });
    const socket = new FakeSocket();
    manager.attach('idle-record', socket);
    processes[0].emitExit({ exitCode: 0, signal: 0 }); socket.terminate();
    manager.forgetReleasedRuntime({ taskId: 'idle-record', sessionKey: 'single:idle-record',
      taskCreatedAt: outcome === 'wrong-generation' ? '2026-01-01T00:00:00.000Z' : taskCreatedAt },
    { sessionId: runtime.sessionId, released: [], errors: outcome === 'failed' ? [{ error: 'retry needed' }] : [] });
    await manager.shutdown();
    assert.equal(releases, outcome === 'released' ? 0 : 1);
  });
}

test('transcript initialization failure keeps the CLI tracked until shutdown and forced exit finish', async t => {
  const timers = [];
  const { manager, processes } = terminalFixture(t, {
    transcripts: { start() { throw Object.assign(new Error('Transcript storage is full'), { code: 'ENOSPC' }); } },
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds, unref() {} }; timers.push(timer); return timer;
    },
    clearTimeout() {},
  });
  assert.throws(() => manager.attach('failed-start', new FakeSocket()), error => error.statusCode === 507);
  assert.equal(manager.isRunning('failed-start'), true);
  assert.deepEqual(processes[0].kills, ['SIGTERM']);
  let finished = false;
  const shutdown = manager.shutdown().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  timers.find(timer => timer.milliseconds === 2000).callback();
  assert.deepEqual(processes[0].kills, ['SIGTERM', 'SIGKILL']);
  processes[0].emitExit({ exitCode: 0, signal: 9 });
  await shutdown;
  assert.equal(manager.isRunning('failed-start'), false);
});

test('a new CLI can reconnect after failed transcript initialization has been cleaned up', async t => {
  let fail = true;
  const chunks = [];
  const { manager, processes } = terminalFixture(t, {
    transcripts: { start() {
      if (fail) throw new Error('Temporary transcript allocation failure');
      return { append(chunk) { chunks.push(chunk); }, seal() {} };
    } },
  });
  assert.throws(() => manager.attach('retry-start', new FakeSocket()), error => error.statusCode === 507);
  const stopped = manager.terminateAndWait('retry-start');
  processes[0].emitExit({ exitCode: 0, signal: 15 });
  await stopped;
  fail = false;
  await manager.attachWhenReady('retry-start', new FakeSocket());
  assert.equal(processes.length, 2);
  processes[1].emitData('Recovered transcript');
  assert.deepEqual(chunks, ['Recovered transcript']);
  processes[1].emitExit({ exitCode: 0, signal: 0 });
  await manager.shutdown();
});
