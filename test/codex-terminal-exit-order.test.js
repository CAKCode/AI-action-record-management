const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const pty = require('node-pty');
const { WebSocket } = require('ws');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-exit-order-'));
for (const name of ['workspace', 'source', 'skills']) fs.mkdirSync(path.join(root, name));
Object.assign(process.env, {
  CODEX_DESK_DATA_DIR: path.join(root, 'data'), CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
  CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'workspace'), CODEX_TASK_SESSIONS_DIR: path.join(root, 'task-sessions'),
  SOURCE_CODEX_HOME: path.join(root, 'source'), WORKSPACE_CODEX_SKILLS_DIR: path.join(root, 'skills'),
  BRIDGE_RUNTIME_ROOT: path.join(root, 'bridge'), BRIDGE_CHATFILE_ROOT: path.join(root, 'chatfiles'),
  BRIDGE_BOT_ID: 'codex-task-sessions',
});
const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
const { stableBridgeSessionId, sessionTargets } = require('../src/bridge-runtime-cleanup');
const { createCodexTerminalManager } = require('../src/codex-terminal');
const { inspectProcess, signalVerifiedProcessGroup } = require('../src/process-identity');
test.after(() => { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

class FixtureSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.output = ''; }
  send(data, options, callback) {
    if (Buffer.isBuffer(data)) {
      this.output += data.toString();
      const match = /fixture-ready:(\{[^\r\n]+\})/.exec(this.output);
      if (match) this.emit('ready', JSON.parse(match[1]));
    } else if (JSON.parse(data).state === 'ended') this.emit('ended');
    (typeof options === 'function' ? options : callback)?.();
  }
  terminate() { this.readyState = 3; this.emit('close'); }
}

function alive(identity) {
  const current = inspectProcess(identity.pid);
  return Boolean(current && current.state !== 'Z' && current.startTicks === identity.startTicks);
}

async function fixture(t, id, generation = '') {
  const cycle = store.createReleaseCycle({ id: `${id}${generation}-cycle`, taskTemplate: {
    name: id, objective: 'Local exit-order fixture', workingDir: '.', workspaceMode: 'shared',
  } });
  const sessionKey = `single:${id}${generation}`;
  store.saveSession(id, { name: id, objective: 'fixture', workingDir: '.',
    persistentSessionKey: sessionKey, releaseCycleId: cycle.id });
  getDatabase().prepare("UPDATE tasks SET status='waiting_review' WHERE id=?").run(id);
  const sessionId = stableBridgeSessionId(sessionKey, path.join(root, 'workspace'));
  const targets = sessionTargets(sessionKey, sessionId);
  for (const dir of [targets.workfileDir, targets.skillDir, targets.codexHome, targets.chatfileDir, path.dirname(targets.recordFile)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(targets.recordFile, JSON.stringify({ sessionId, botId: 'codex-task-sessions', chatKey: sessionKey,
    workspaceId: `user:codex-task-sessions:${targets.userId}`, workspaceScope: 'user', workspaceMode: 'team',
    cwdDir: targets.workfileDir, workfileDir: targets.workfileDir, skillDir: targets.skillDir,
    chatfileDir: targets.chatfileDir, threadId: `thread-${id}` }));
  const file = path.join(root, 'data', 'sessions', id, 'writer.log');
  const executable = path.join(root, `${id}-launcher`);
  const writerScript = `const fs=require('fs'),path=require('path');
process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});
const file=${JSON.stringify(file)};
const write=()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.appendFileSync(file,'tick\\n');};
write();setInterval(write,10);process.send('ready');`;
  fs.writeFileSync(executable, `#!${process.execPath}
const {spawn}=require('child_process');
process.on('SIGTERM',()=>process.exit(0));
const child=spawn(process.execPath,['-e',${JSON.stringify(writerScript)}],{env:{},stdio:['ignore','ignore','ignore','ipc']});
child.once('message',()=>process.stdout.write('fixture-ready:'+JSON.stringify({leader:process.pid,writer:child.pid})+'\\n'));
process.stdin.on('data',()=>process.exit(0));setInterval(()=>{},1000);
`, { mode: 0o700 });
  const identities = [];
  const handles = [];
  const errors = [];
  const manager = createCodexTerminalManager({ getTask: store.getSession, codexBinary: executable, maxTerminals: 1,
    resolveRuntime: () => ({ sessionId, threadId: `thread-${id}`, cwdDir: targets.workfileDir,
      codexHome: targets.codexHome, chatfileDir: targets.chatfileDir }),
    pty: { spawn(...args) { const handle = pty.spawn(...args); handles.push(handle); return handle; } },
    onError: error => errors.push(error),
  });
  t.after(async () => {
    for (const identity of identities) if (alive(identity)) process.kill(identity.pid, 'SIGKILL');
    for (const handle of handles) {
      const identity = inspectProcess(handle.pid);
      if (identity?.parentPid === process.pid) signalVerifiedProcessGroup(identity, 'SIGKILL');
    }
    await manager.shutdown().catch(() => {});
    assert.deepEqual(errors, []);
  });
  async function connect(reconnect = false) {
    const socket = new FixtureSocket();
    const ready = once(socket, 'ready');
    if (reconnect) await manager.attachWhenReady(id, socket);
    else manager.attach(id, socket);
    const [pids] = await ready;
    const leader = inspectProcess(pids.leader), writer = inspectProcess(pids.writer);
    assert(leader && writer); identities.push(leader, writer);
    return { socket, leader, writer };
  }
  return { manager, cycle, id, file, connect, executable, targets };
}

test('cycle deletion waits for the process group after the CLI launcher and browser have exited', { timeout: 15000 }, async t => {
  const task = await fixture(t, 'delete-after-cli-exit');
  const cli = await task.connect();
  const ended = once(cli.socket, 'ended');
  task.manager.terminate(task.id); await ended;
  cli.socket.terminate();
  const deletion = store.deleteReleaseCycle(task.cycle.id);
  const job = store.claimReleaseCycleDeletions('exit-order-delete').find(item => item.id === deletion.deletionId);
  const result = await store.processReleaseCycleDeletion(job, 'exit-order-delete', {
    terminateInteractive: (...args) => task.manager.terminateForDeletion(...args),
  });
  assert.equal(result.deleted, true);
  assert.equal(alive(cli.writer), false, 'Cycle deletion returned while the writer was still alive');
  assert.equal(fs.existsSync(path.dirname(task.file)), false);
  assert.equal(store.getSession(task.id), null);
});

test('reconnect waits for the previous process group and releases its capacity only after exit', { timeout: 15000 }, async t => {
  const task = await fixture(t, 'reconnect-after-cli-exit');
  const cli = await task.connect();
  const ended = once(cli.socket, 'ended');
  task.manager.terminate(task.id); await ended;
  assert.equal(task.manager.isRunning(task.id), true);
  assert.throws(() => task.manager.attach(task.id, new FixtureSocket()), error => error.statusCode === 503);
  const next = await task.connect(true);
  assert.equal(alive(cli.writer), false, 'New CLI overlapped the previous process group');
  assert(alive(next.writer));
  assert.notEqual(next.leader.pid, cli.leader.pid);
});

test('shutdown waits for an already exited launcher group after its last browser disconnects', { timeout: 15000 }, async t => {
  const task = await fixture(t, 'shutdown-after-cli-exit');
  const cli = await task.connect();
  const ended = once(cli.socket, 'ended');
  task.manager.terminate(task.id); await ended;
  cli.socket.terminate();
  await task.manager.shutdown();
  assert.equal(alive(cli.writer), false);
});

test('natural launcher exit also drains surviving children before terminateAndWait returns', { timeout: 15000 }, async t => {
  const task = await fixture(t, 'natural-cli-exit');
  const cli = await task.connect();
  const ended = once(cli.socket, 'ended');
  cli.socket.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'exit\n' })), false);
  await ended;
  await task.manager.terminateAndWait(task.id);
  assert.equal(alive(cli.writer), false);
});

for (const operation of ['stop', 'complete']) test(`HTTP ${operation} validates stale requests before touching a replacement Task interactive CLI`, { timeout: 20000 }, async t => {
  const id = `http-${operation}-replacement`;
  await fixture(t, id);
  const original = store.getSession(id);
  const originalContext = { idempotencyKey: `http-old-${operation}`, expectedTaskCreatedAt: original.createdAt };
  if (operation === 'stop') assert.equal(store.requestSessionStop(id, originalContext), false);
  else store.completeSession(id, originalContext);
  store.deleteSession(id);
  const task = await fixture(t, id, '-replacement');
  getDatabase().prepare('UPDATE tasks SET created_at=? WHERE id=?').run('2099-01-01T00:00:00.000Z', id);
  const replacement = store.getSession(id);
  const sessions = path.join(task.targets.codexHome, 'sessions');
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: `thread-${id}` } }) + '\n');
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const environment = { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_DISABLE_WORKER: '1',
    CODEX_ALLOW_ROOT_EXECUTION: '1', CODEX_DB_BACKUP_INTERVAL_HOURS: '0', CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    CODEX_DESK_AUTH_USER: 'fixture', CODEX_DESK_AUTH_PASSWORD: 'fixture-password', CODEX_TASK_REAL_CODEX_BIN: task.executable };
  for (const key of Object.keys(environment)) if (/^CODEX_(REQUIRE_|HOST_LAUNCHER_|WEB_SUPERVISOR_|MANAGED_WEB_SUPERVISOR_)/.test(key)) delete environment[key];
  const headers = { authorization: `Basic ${Buffer.from('fixture:fixture-password').toString('base64')}` };
  const server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: environment,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  let socket;
  const identities = [];
  t.after(async () => {
    socket?.terminate();
    if (server.exitCode === null && server.signalCode === null) {
      const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended;
    }
    for (const identity of identities) if (alive(identity)) process.kill(identity.pid, 'SIGKILL');
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Isolated server exited: ${output}`);
    try { if ((await fetch(`${base}/api/sessions`, { headers })).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert(ready, output);
  socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/sessions/${id}/codex-terminal/live`, {
    headers: { ...headers, origin: base },
  });
  const pids = await new Promise((resolve, reject) => {
    let terminalOutput = '';
    socket.on('error', reject);
    socket.on('message', (data, binary) => {
      if (!binary) {
        const message = JSON.parse(data.toString());
        if (message.type === 'error') reject(new Error(message.message));
        return;
      }
      terminalOutput += data.toString();
      const match = /fixture-ready:(\{[^\r\n]+\})/.exec(terminalOutput);
      if (match) resolve(JSON.parse(match[1]));
    });
  });
  identities.push(inspectProcess(pids.leader), inspectProcess(pids.writer));
  assert(identities.every(Boolean));
  const requestOperation = (key, createdAt) => fetch(`${base}/api/sessions/${id}/${operation}`, { method: 'POST',
    headers: { ...headers, 'Idempotency-Key': key, 'X-Task-Created-At': createdAt } });
  const replay = await requestOperation(originalContext.idempotencyKey, original.createdAt);
  assert.equal(replay.status, 200);
  const replayResult = await replay.json();
  if (operation === 'stop') assert.deepEqual(replayResult, { ok: false });
  else {
    assert.equal(replayResult.createdAt, original.createdAt);
    assert.equal(replayResult.status, 'completed');
  }
  assert(identities.every(alive), `Old ${operation} replay terminated the replacement CLI`);
  const stale = await requestOperation(`http-new-stale-${operation}`, original.createdAt);
  assert.equal(stale.status, 409);
  assert(identities.every(alive), `Rejected ${operation} request terminated the replacement CLI`);
  const current = await requestOperation(`http-current-${operation}`, replacement.createdAt);
  assert.equal(current.status, 200);
  if (operation === 'complete') {
    assert.equal(store.getSession(id).status, 'completed');
    assert.equal(store.getSession(id).createdAt, replacement.createdAt);
  }
  assert(identities.every(identity => !alive(identity)));
});
