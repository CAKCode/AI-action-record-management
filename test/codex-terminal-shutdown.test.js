const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-shutdown-'));
for (const name of ['project', 'source', 'skills']) fs.mkdirSync(path.join(root, name));
Object.assign(process.env, {
  CODEX_DESK_DATA_DIR: path.join(root, 'data'), CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
  CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'project'), CODEX_TASK_SESSIONS_DIR: path.join(root, 'task-sessions'),
  SOURCE_CODEX_HOME: path.join(root, 'source'), CODEX_SOURCE_HOME: path.join(root, 'source'),
  WORKSPACE_CODEX_SKILLS_DIR: path.join(root, 'skills'),
  BRIDGE_RUNTIME_ROOT: path.join(root, 'bridge'), BRIDGE_CHATFILE_ROOT: path.join(root, 'chatfiles'),
  BRIDGE_BOT_ID: 'codex-task-sessions',
});
const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
const { stableBridgeSessionId, sessionTargets } = require('../src/bridge-runtime-cleanup');
const { inspectProcess } = require('../src/process-identity');

function alive(identity) {
  const current = inspectProcess(identity.pid);
  return current && current.state !== 'Z' && current.startTicks === identity.startTicks;
}

function createTask(id) {
  const sourceDir = path.join(root, 'project');
  const sessionKey = `single:${id}`;
  store.saveSession(id, { name: id, objective: 'isolated terminal lifecycle fixture', workingDir: sourceDir });
  getDatabase().prepare(`UPDATE tasks SET persistent_session_key=?,status='waiting_review',last_finished_at=? WHERE id=?`)
    .run(sessionKey, new Date(Date.now() + 3600000).toISOString(), id);
  const sessionId = stableBridgeSessionId(sessionKey, sourceDir);
  const targets = sessionTargets(sessionKey, sessionId);
  for (const directory of [targets.workfileDir, targets.skillDir, targets.codexHome, targets.chatfileDir, path.dirname(targets.recordFile)]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const record = { sessionId, botId: 'codex-task-sessions', chatKey: sessionKey,
    workspaceId: `user:codex-task-sessions:${id}`, workspaceScope: 'user', workspaceMode: 'team',
    cwdDir: targets.workfileDir, workfileDir: targets.workfileDir, skillDir: targets.skillDir,
    chatfileDir: targets.chatfileDir, threadId: `retained-thread-${id}` };
  fs.writeFileSync(targets.recordFile, JSON.stringify(record));
  fs.mkdirSync(path.join(targets.codexHome, 'sessions'));
  fs.writeFileSync(path.join(targets.codexHome, 'sessions', 'rollout.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: record.threadId } }) + '\n');
  for (const name of ['codex', 'codex-code-mode-host']) fs.symlinkSync(process.execPath, path.join(targets.codexHome, name));
  return { targets, record };
}

function openTerminal(base, id) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/sessions/${id}/codex-terminal/live`, {
    headers: { authorization: `Basic ${Buffer.from('fixture:fixture-password').toString('base64')}`, origin: base },
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Terminal fixture did not start')), 10000);
    let output = '';
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('message', (data, binary) => {
      if (!binary) {
        const message = JSON.parse(data.toString());
        if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)); }
        return;
      }
      output += data.toString();
      const match = /fixture-ready:(\{[^\r\n]+\})/.exec(output);
      if (match) { clearTimeout(timer); resolve(JSON.parse(match[1])); }
    });
  });
  return { socket, ready };
}

test('real PTY shutdown reclaims CLI and detached helpers, retains business work and resumes after restart', { timeout: 30000 }, async t => {
  const first = createTask('terminal-first');
  const second = createTask('terminal-second');
  const cycle = store.createReleaseCycle({ id: 'terminal-delete-cycle', name: 'CLI deletion fixture',
    taskTemplate: { name: 'fixture', objective: 'local fixture', workingDir: '.', workspaceMode: 'shared' } });
  for (const id of ['terminal-first', 'terminal-second']) store.linkTaskToReleaseCycle(id, cycle.id);
  store.saveSession('unrelated-terminal-task', { name: 'keep unrelated', objective: 'fixture', workingDir: '.' });
  const businessProcesses = [];
  const independent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
  const independentIdentity = inspectProcess(independent.pid);
  const executable = path.join(root, 'fixture-codex');
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('fs'), path = require('path'), {spawn} = require('child_process');
process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {});
const home = process.env.CODEX_HOME;
const children = [];
const readyFiles = [];
for (const [name, args] of [['codex',['app-server','--managed-daemon']],['codex',['app-server','daemon','pid-update-loop']],['codex-code-mode-host',[]]]) {
  const ready = path.join(home, 'ready-' + process.pid + '-' + children.length);
  const script = 'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},1000);require("fs").writeFileSync(' + JSON.stringify(ready) + ',"ready");';
  const child = spawn(path.join(home,name), ['-e',script,...args], {detached:true,stdio:'ignore'});
  child.unref(); children.push(child.pid); readyFiles.push(ready);
}
const nativeReady = path.join(home, 'ready-native-' + process.pid);
const nativeScript = 'process.on("SIGTERM",()=>{});process.on("SIGHUP",()=>{});setInterval(()=>{},1000);require("fs").writeFileSync(' + JSON.stringify(nativeReady) + ',"ready");';
const native = spawn(path.join(home,'codex'), ['-e',nativeScript,'resume',process.argv.at(-1)], {stdio:'ignore'});
native.unref(); children.push(native.pid); readyFiles.push(nativeReady);
const business = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'}); business.unref();
fs.writeFileSync(path.join(home,'fixture-pids-' + process.pid + '.json'),JSON.stringify([process.pid,...children,business.pid]));
const timer = setInterval(() => {
  if (!readyFiles.every(file=>fs.existsSync(file))) return;
  clearInterval(timer);
  process.stdout.write('fixture-ready:' + JSON.stringify({pid:process.pid,helpers:children.slice(0,3),native:native.pid,business:business.pid,threadId:process.argv.at(-1)}) + '\\n');
},10);
process.stdin.on('data', data => { if (data.toString().includes('exit')) { native.kill('SIGKILL'); native.once('exit',()=>process.exit(0)); } });
`, { mode: 0o700 });
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const environment = { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_DISABLE_WORKER: '1',
    CODEX_ALLOW_ROOT_EXECUTION: '1', CODEX_DB_BACKUP_INTERVAL_HOURS: '0', CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    CODEX_DESK_AUTH_USER: 'fixture', CODEX_DESK_AUTH_PASSWORD: 'fixture-password', CODEX_TASK_REAL_CODEX_BIN: executable,
    CODEX_INTERACTIVE_MAX_TERMINALS: '1' };
  for (const key of Object.keys(environment)) if (/^CODEX_(REQUIRE_|HOST_LAUNCHER_|WEB_SUPERVISOR_|MANAGED_WEB_SUPERVISOR_)/.test(key)) delete environment[key];
  const headers = { authorization: `Basic ${Buffer.from('fixture:fixture-password').toString('base64')}` };
  const sockets = [];
  let server;
  let logs = '';
  async function start() {
    server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', chunk => { logs += chunk.toString(); });
    server.stderr.on('data', chunk => { logs += chunk.toString(); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error(`Isolated server exited: ${logs}`);
      try { const response = await fetch(`${base}/api/sessions`, { headers }); if (response.ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Isolated server failed to start: ${logs}`);
  }
  async function stop() {
    const exited = new Promise(resolve => server.once('exit', (code, signal) => resolve({ code, signal })));
    server.kill('SIGTERM');
    const result = await exited;
    assert.equal(result.code, 0, logs);
  }
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (server?.exitCode === null) {
      const exited = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGKILL'); await exited;
    }
    for (const identity of businessProcesses) if (alive(identity)) process.kill(identity.pid, 'SIGKILL');
    if (alive(independentIdentity)) process.kill(independentIdentity.pid, 'SIGKILL');
    for (const task of [first, second]) {
      if (!fs.existsSync(task.targets.codexHome)) continue;
      for (const file of fs.readdirSync(task.targets.codexHome).filter(name => name.startsWith('fixture-pids-'))) {
        for (const pid of JSON.parse(fs.readFileSync(path.join(task.targets.codexHome, file)))) {
          const identity = inspectProcess(pid);
          if (!identity || identity.state === 'Z') continue;
          try {
            const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
            if (env.includes(`CODEX_HOME=${task.targets.codexHome}`) && alive(identity)) process.kill(pid, 'SIGKILL');
          } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
        }
      }
    }
    closeDatabase(); fs.rmSync(root, { recursive: true, force: true });
  });
  await start();
  const oldTerminal = openTerminal(base, 'terminal-first'); sockets.push(oldTerminal.socket);
  const initial = await oldTerminal.ready;
  assert.equal(initial.threadId, first.record.threadId);
  const ended = new Promise(resolve => oldTerminal.socket.on('message', (data, binary) => {
    if (!binary && JSON.parse(data.toString()).state === 'ended') resolve();
  }));
  oldTerminal.socket.send(JSON.stringify({ type: 'input', data: 'exit\n' })); await ended;
  assert.equal(oldTerminal.socket.readyState, WebSocket.OPEN);
  const activeTerminal = openTerminal(base, 'terminal-second'); sockets.push(activeTerminal.socket);
  const active = await activeTerminal.ready;
  const native = [active.pid, active.native, ...initial.helpers, ...active.helpers].map(pid => inspectProcess(pid));
  const business = [initial.business, active.business].map(pid => inspectProcess(pid));
  businessProcesses.push(...business);
  assert(native.every(Boolean)); assert(business.every(Boolean));
  await stop();
  assert(native.every(identity => !alive(identity)), `Shutdown left native CLI or helper processes alive: ${JSON.stringify(native.filter(alive))}`);
  assert(business.every(alive), 'Shutdown stopped independent business processes');
  for (const task of [first, second]) {
    assert.equal(JSON.parse(fs.readFileSync(task.targets.recordFile)).threadId, task.record.threadId);
    assert(fs.existsSync(path.join(task.targets.codexHome, 'sessions', 'rollout.jsonl')));
  }
  await start();
  const resumedTerminal = openTerminal(base, 'terminal-first'); sockets.push(resumedTerminal.socket);
  const resumed = await resumedTerminal.ready;
  assert.equal(resumed.threadId, initial.threadId);
  assert.notEqual(resumed.pid, initial.pid);
  const resumedNative = [resumed.pid, resumed.native, ...resumed.helpers].map(pid => inspectProcess(pid));
  businessProcesses.push(inspectProcess(resumed.business));
  const deletionResponse = await fetch(`${base}/api/release-cycles/${cycle.id}`, { method: 'DELETE',
    headers: { ...headers, 'Idempotency-Key': 'terminal-cycle-delete', 'X-Release-Cycle-Created-At': cycle.createdAt } });
  assert.equal(deletionResponse.status, 202);
  const deletion = await deletionResponse.json();
  const late = openTerminal(base, 'terminal-first'); sockets.push(late.socket);
  await assert.rejects(late.ready, /being deleted/);
  let progress;
  for (let attempt = 0; attempt < 150; attempt++) {
    progress = await (await fetch(`${base}/api/release-cycle-deletions/${deletion.deletionId}`, { headers })).json();
    if (progress.deleted) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(progress.deleted, true, JSON.stringify(progress));
  assert.equal(progress.deletedTasks, 2);
  for (const id of ['terminal-first', 'terminal-second']) {
    assert.equal((await fetch(`${base}/api/sessions/${id}`, { headers })).status, 404);
  }
  assert.equal((await fetch(`${base}/api/sessions/unrelated-terminal-task`, { headers })).status, 200);
  for (const task of [first, second]) {
    assert.equal(fs.existsSync(task.targets.codexHome), false);
    assert.equal(fs.existsSync(task.targets.recordFile), false);
  }
  assert(resumedNative.every(identity => !alive(identity)), 'Cycle deletion left CLI processes alive');
  assert(businessProcesses.every(identity => !alive(identity)), 'Cycle deletion left unregistered Task-owned work alive');
  assert(alive(independentIdentity), 'Cycle deletion stopped unrelated work');
  await stop();
  assert(resumedNative.every(identity => !alive(identity)));
});
