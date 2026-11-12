const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createCodexTerminalManager } = require('../src/codex-terminal');
const { inspectProcess } = require('../src/process-identity');

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; }
  send(_data, options, callback) { (typeof options === 'function' ? options : callback)?.(); }
  terminate() { this.readyState = 3; this.emit('close'); }
}

function alive(identity) {
  const current = inspectProcess(identity?.pid);
  return Boolean(current && current.state !== 'Z' && current.startTicks === identity.startTicks);
}

test('real CLI startup failure reclaims a stubborn launcher and detached native CLI', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-startup-failure-'));
  const runtime = { sessionId: 'session-40567890abcdef12', threadId: 'fixture-thread',
    cwdDir: path.join(root, 'work'), codexHome: path.join(root, 'home'), chatfileDir: path.join(root, 'chat') };
  for (const dir of [runtime.cwdDir, runtime.codexHome, runtime.chatfileDir, path.join(root, 'native')]) fs.mkdirSync(dir);
  const native = path.join(root, 'native', 'codex'); fs.symlinkSync(process.execPath, native);
  const executable = path.join(root, 'launcher'), ready = path.join(root, 'ready');
  const nativeReady = path.join(root, 'native-ready');
  const script = `process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});setInterval(()=>{},1000);require('fs').writeFileSync(${JSON.stringify(nativeReady)},'ready');`;
  fs.writeFileSync(executable, `#!${process.execPath}
const fs=require('fs'),{spawn}=require('child_process');
process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});
const child=spawn(${JSON.stringify(native)},['-e',${JSON.stringify(script)},'resume','fixture-thread'],{detached:true,stdio:'ignore'});child.unref();
const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(nativeReady)}))return;clearInterval(timer);fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify([process.pid,child.pid]));},10);
setInterval(()=>{},1000);
`, { mode: 0o700 });
  const identities = [];
  const manager = createCodexTerminalManager({
    getTask: () => ({ id: 'failed-start', createdAt: '2026-01-01T00:00:00.000Z', status: 'waiting_review',
      persistentSessionKey: 'single:failed-start' }),
    codexBinary: executable, resolveRuntime: () => runtime,
    transcripts: { start() {
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(ready) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      assert(fs.existsSync(ready), 'CLI fixture did not initialize before the simulated storage error');
      identities.push(...JSON.parse(fs.readFileSync(ready)).map(inspectProcess));
      assert(identities.every(Boolean));
      throw Object.assign(new Error('Simulated transcript storage full'), { code: 'ENOSPC' });
    } },
  });
  t.after(async () => {
    for (const identity of identities) if (alive(identity)) process.kill(identity.pid, 'SIGKILL');
    await manager.shutdown().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.throws(() => manager.attach('failed-start', new Socket()), error => error.statusCode === 507);
  assert.equal(manager.isRunning('failed-start'), true);
  await manager.shutdown();
  assert(identities.every(identity => !alive(identity)), 'Failed CLI startup left processes behind');
});
