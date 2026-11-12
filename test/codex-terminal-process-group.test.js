const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const pty = require('node-pty');
const { createCodexTerminalManager } = require('../src/codex-terminal');
const { inspectProcess, signalVerifiedProcessGroup } = require('../src/process-identity');

class FixtureSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.output = ''; }
  send(data, options, callback) {
    if (Buffer.isBuffer(data)) {
      this.output += data.toString();
      const match = /fixture-ready:(\{[^\r\n]+\})/.exec(this.output);
      if (match) this.emit('fixture-ready', JSON.parse(match[1]));
    } else if (JSON.parse(data).state === 'ended') this.emit('ended');
    (typeof options === 'function' ? options : callback)?.();
  }
  terminate() { this.readyState = 3; this.emit('close'); }
}

function alive(identity) {
  const current = inspectProcess(identity.pid);
  return Boolean(current && current.state !== 'Z' && current.startTicks === identity.startTicks);
}

for (const disconnected of [false, true]) test(disconnected
  ? 'shutdown reclaims detached native CLI after its process group and last browser have gone'
  : 'CLI shutdown waits for surviving group members and detached native CLI without stopping independent work',
  { timeout: 15000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-process-group-'));
    const runtime = { sessionId: 'session-1723456789abcdef', threadId: 'fixture-thread',
      cwdDir: path.join(root, 'work'), codexHome: path.join(root, 'home'), chatfileDir: path.join(root, 'chat') };
    for (const directory of [runtime.cwdDir, runtime.codexHome, runtime.chatfileDir, path.join(root, 'native')]) fs.mkdirSync(directory);
    const native = path.join(root, 'native', 'codex');
    fs.symlinkSync(process.execPath, native);
    const executable = path.join(root, 'fixture-launcher');
    const pidFile = path.join(root, 'processes.json');
    fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('fs'), { spawn } = require('child_process');
process.on('SIGTERM', () => process.exit(0));
const children = {}, readyFiles = [];
for (const role of ['native', 'opaque', 'independent']) {
  const ready = ${JSON.stringify(root)} + '/' + role + '.ready'; readyFiles.push(ready);
  const script = 'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},1000);require("fs").writeFileSync(' + JSON.stringify(ready) + ',"ready");';
  const child = spawn(role === 'native' ? ${JSON.stringify(native)} : process.execPath,
    ['-e', script, ...(role === 'native' ? ['resume', 'fixture-thread'] : [])],
    { detached: role !== 'opaque', stdio: 'ignore', env: role === 'opaque' ? {} : process.env });
  children[role] = child.pid;
}
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid, ...children }));
const timer = setInterval(() => {
  if (!readyFiles.every(file => fs.existsSync(file))) return;
  clearInterval(timer);
  process.stdout.write('fixture-ready:' + JSON.stringify({ pid: process.pid, ...children }) + '\\n');
}, 10);
setInterval(()=>{},1000);
`, { mode: 0o700 });
    let handle;
    let identities = [];
    const manager = createCodexTerminalManager({
      getTask: () => ({ id: 'group-task', status: 'waiting_review', version: 1,
        persistentSessionKey: 'single:group-task' }),
      codexBinary: executable, resolveRuntime: () => runtime,
      pty: { spawn(...args) { handle = pty.spawn(...args); return handle; } },
    });
    t.after(async () => {
      if (handle) {
        const leader = inspectProcess(handle.pid);
        if (leader && leader.processGroupId === leader.pid) signalVerifiedProcessGroup(leader, 'SIGKILL');
      }
      if (!identities.length && fs.existsSync(pidFile)) identities = Object.values(JSON.parse(fs.readFileSync(pidFile))).map(inspectProcess).filter(Boolean);
      for (const identity of identities) if (alive(identity)) process.kill(identity.pid, 'SIGKILL');
      await manager.shutdown().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    });
    const socket = new FixtureSocket();
    const ready = once(socket, 'fixture-ready');
    manager.attach('group-task', socket);
    const [processes] = await ready;
    const leader = inspectProcess(processes.pid);
    const nativeIdentity = inspectProcess(processes.native);
    const opaque = inspectProcess(processes.opaque);
    const independent = inspectProcess(processes.independent);
    identities = [leader, nativeIdentity, opaque, independent];
    assert(identities.every(Boolean));
    assert.equal(opaque.processGroupId, leader.pid);
    assert.notEqual(nativeIdentity.processGroupId, leader.pid);

    if (disconnected) {
      const ended = once(socket, 'ended');
      manager.terminate('group-task');
      await ended; socket.terminate();
      await manager.terminateAndWait('group-task');
      assert.equal(alive(opaque), false);
    }
    await manager.shutdown();
    assert.equal(alive(leader), false);
    assert.equal(alive(nativeIdentity), false, 'Detached native Codex CLI survived shutdown');
    assert.equal(alive(opaque), false, 'Shutdown returned before the terminal process group exited');
    assert(alive(independent), 'Shutdown stopped independent business work');
  });
