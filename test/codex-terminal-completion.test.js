const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-completion-http-'));
for (const name of ['project', 'source', 'skills']) fs.mkdirSync(path.join(root, name));
Object.assign(process.env, {
  CODEX_DESK_DATA_DIR: path.join(root, 'data'), CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
  CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'project'), SOURCE_CODEX_HOME: path.join(root, 'source'),
  CODEX_SOURCE_HOME: path.join(root, 'source'), WORKSPACE_CODEX_SKILLS_DIR: path.join(root, 'skills'),
  BRIDGE_RUNTIME_ROOT: path.join(root, 'bridge'), BRIDGE_CHATFILE_ROOT: path.join(root, 'chatfiles'),
  BRIDGE_BOT_ID: 'codex-task-sessions',
});
const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
const { stableBridgeSessionId, sessionTargets } = require('../src/bridge-runtime-cleanup');
const { inspectProcess } = require('../src/process-identity');
const repo = path.resolve(__dirname, '..');
test.after(() => { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

function createTask(id) {
  const sessionKey = `single:${id}`;
  store.saveSession(id, { name: id, objective: 'Completion concurrency fixture', workingDir: '.' });
  getDatabase().prepare(`UPDATE tasks SET status='waiting_review',persistent_session_key=?,last_finished_at=? WHERE id=?`)
    .run(sessionKey, new Date(Date.now() + 3600000).toISOString(), id);
  const sessionId = stableBridgeSessionId(sessionKey, path.join(root, 'project'));
  const targets = sessionTargets(sessionKey, sessionId);
  for (const dir of [targets.workfileDir, targets.skillDir, targets.codexHome, targets.chatfileDir,
    path.dirname(targets.recordFile), path.join(targets.codexHome, 'sessions')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(targets.recordFile, JSON.stringify({ sessionId, chatKey: sessionKey, botId: 'codex-task-sessions',
    workspaceId: `user:codex-task-sessions:${targets.userId}`, workspaceScope: 'user', workspaceMode: 'team',
    cwdDir: targets.workfileDir, workfileDir: targets.workfileDir, skillDir: targets.skillDir,
    chatfileDir: targets.chatfileDir, threadId: `thread-${id}` }));
  fs.writeFileSync(path.join(targets.codexHome, 'sessions', 'rollout.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: `thread-${id}` } }) + '\n');
}

async function until(read, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test('HTTP completion queues concurrent WebSocket reconnects through verification and failure', { timeout: 30000 }, async t => {
  const executable = path.join(root, 'fixture-codex');
  fs.writeFileSync(executable, `#!${process.execPath}
process.on('SIGTERM',()=>process.exit(0));
process.stdout.write('fixture-ready:'+JSON.stringify({pid:process.pid,threadId:process.argv.at(-1)})+'\\n');
setInterval(()=>{},1000);
`, { mode: 0o700 });
  const preload = path.join(root, 'preload.cjs');
  const spawnLog = path.join(root, 'spawns.log');
  fs.writeFileSync(preload, `
const fs=require('fs'),path=require('path');
const pty=require(${JSON.stringify(require.resolve('node-pty'))});
const spawn=pty.spawn;
pty.spawn=function(...args){fs.appendFileSync(${JSON.stringify(spawnLog)},args[1].at(-1)+'\\n');return spawn(...args);};
const modulePath=${JSON.stringify(path.join(repo, 'src/interactive-cli-transcript'))};
const transcripts=require(modulePath),create=transcripts.createInteractiveCliTranscriptStore;
transcripts.createInteractiveCliTranscriptStore=(...args)=>{
  const result=create(...args),verify=result.verify;
  result.verify=async id=>{
    const marker=path.join(${JSON.stringify(root)},id);
    fs.writeFileSync(marker+'.verifying','');
    while(!fs.existsSync(marker+'.release'))await new Promise(resolve=>setTimeout(resolve,10));
    if(fs.existsSync(marker+'.fail'))throw new Error('Fixture transcript verification failed');
    return verify(id);
  };
  return result;
};
`);
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Basic ${Buffer.from('fixture:fixture-password').toString('base64')}` };
  const environment = { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_DISABLE_WORKER: '1',
    CODEX_ALLOW_ROOT_EXECUTION: '1', CODEX_DB_BACKUP_INTERVAL_HOURS: '0', CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    CODEX_DESK_AUTH_USER: 'fixture', CODEX_DESK_AUTH_PASSWORD: 'fixture-password',
    CODEX_TASK_REAL_CODEX_BIN: executable };
  for (const key of Object.keys(environment)) if (/^CODEX_(REQUIRE_|HOST_LAUNCHER_|WEB_SUPERVISOR_|MANAGED_WEB_SUPERVISOR_)/.test(key)) delete environment[key];
  const server = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: repo, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk.toString(); });
  server.stderr.on('data', chunk => { output += chunk.toString(); });
  const sockets = [];
  const cliIdentities = [];
  t.after(async () => {
    for (const id of ['complete-success', 'complete-failure']) fs.writeFileSync(path.join(root, id + '.release'), '');
    for (const socket of sockets) socket.terminate();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0, output);
    }
    for (const identity of cliIdentities) {
      const current = inspectProcess(identity?.pid);
      if (current && identity && current.state !== 'Z' && current.startTicks === identity.startTicks) process.kill(identity.pid, 'SIGKILL');
    }
  });
  await until(async () => {
    if (server.exitCode !== null) throw new Error(output);
    try { return (await fetch(base + '/api/sessions', { headers })).ok; } catch { return false; }
  }, 'isolated server');

  function connect(id) {
    const socket = new WebSocket(base.replace('http:', 'ws:') + `/api/sessions/${id}/codex-terminal/live`, {
      headers: { ...headers, origin: base },
    });
    sockets.push(socket);
    const result = { socket, output: '', controls: [] };
    socket.on('message', (data, binary) => {
      if (binary) result.output += data.toString();
      else result.controls.push(JSON.parse(data));
    });
    return result;
  }
  const spawnCount = () => fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8').trim().split('\n').length : 0;
  for (const fail of [false, true]) {
    const id = fail ? 'complete-failure' : 'complete-success';
    createTask(id);
    const original = connect(id);
    await until(() => original.output.includes('fixture-ready:'), 'original CLI');
    const initialPid = JSON.parse(/fixture-ready:(\{[^\r\n]+\})/.exec(original.output)[1]).pid;
    cliIdentities.push(inspectProcess(initialPid));
    const complete = fetch(base + `/api/sessions/${id}/complete`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': `${id}-once` },
    });
    await until(() => fs.existsSync(path.join(root, id + '.verifying')), 'completion verification');
    const repeated = fail ? null : fetch(base + `/api/sessions/${id}/complete`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': `${id}-once` },
    });
    const before = spawnCount();
    const reconnect = connect(id);
    await once(reconnect.socket, 'open');
    assert.equal((await (await fetch(base + `/api/sessions/${id}`, { headers })).json()).status, 'waiting_review');
    assert.equal(spawnCount(), before, 'A new CLI started during completion verification');
    assert.equal(reconnect.controls.length, 0);
    if (fail) fs.writeFileSync(path.join(root, id + '.fail'), '');
    fs.writeFileSync(path.join(root, id + '.release'), '');
    const response = await complete;
    assert.equal(response.status, fail ? 500 : 200);
    if (fail) {
      await until(() => reconnect.output.includes('fixture-ready:'), 'resumed CLI');
      const resumed = JSON.parse(/fixture-ready:(\{[^\r\n]+\})/.exec(reconnect.output)[1]);
      cliIdentities.push(inspectProcess(resumed.pid));
      assert.equal(resumed.threadId, `thread-${id}`);
      assert.equal(spawnCount(), before + 1);
      assert.equal((await (await fetch(base + `/api/sessions/${id}`, { headers })).json()).status, 'waiting_review');
    } else {
      await until(() => reconnect.controls.some(control => control.state === 'ended'), 'archived replay');
      assert(reconnect.output.includes('fixture-ready:'));
      assert.equal(spawnCount(), before);
      const completed = await response.json();
      assert.equal(completed.status, 'completed');
      const replay = await repeated;
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), completed);
    }
    assert(!inspectProcess(initialPid) || inspectProcess(initialPid).state === 'Z');
  }
});
