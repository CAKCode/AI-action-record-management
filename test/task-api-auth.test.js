const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { writeTaskApiAuthentication, taskApiEnvironment } = require('../src/task-api-auth');

test('local Task API authentication stays private, refreshes atomically and preserves explicit credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-api-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime', 'task-api-auth.json');
  const auth = { baseUrl: 'http://127.0.0.1:12345', user: 'fixture', password: 'fixture-secret' };
  const environment = { CODEX_TASK_ID: 'task-fixture', OTHER: 'preserved' };
  assert.equal(taskApiEnvironment(environment, [], file), environment);
  writeTaskApiAuthentication(auth, file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(taskApiEnvironment(environment, [], file), { ...environment,
    CODEX_TASK_API_URL: auth.baseUrl, CODEX_TASK_API_USER: auth.user, CODEX_TASK_API_PASSWORD: auth.password });
  const explicit = { ...environment, CODEX_TASK_API_USER: 'custom', CODEX_TASK_API_PASSWORD: 'custom-secret' };
  assert.equal(taskApiEnvironment(explicit, [], file), explicit);
  assert.equal(taskApiEnvironment(environment, ['--base-url', 'https://other.example'], file), environment);
  assert.equal(taskApiEnvironment(environment, ['--base-url=https://other.example'], file), environment);
  const remote = { ...environment, CODEX_TASK_API_URL: 'https://other.example' };
  assert.equal(taskApiEnvironment(remote, [], file), remote);
  writeTaskApiAuthentication({ ...auth, password: 'updated-fixture-secret' }, file);
  assert.equal(taskApiEnvironment(environment, [], file).CODEX_TASK_API_PASSWORD, 'updated-fixture-secret');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['task-api-auth.json']);
});

test('disabling HTTP authentication removes the stale local context', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-api-auth-disabled-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'runtime', 'task-api-auth.json');
  writeTaskApiAuthentication({
    baseUrl: 'http://127.0.0.1:12345', user: 'fixture', password: 'stale-secret',
  }, file);
  assert.equal(fs.existsSync(file), true);
  writeTaskApiAuthentication({ baseUrl: 'http://127.0.0.1:12345', user: '', password: '' }, file);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(taskApiEnvironment({}, [], file), {});
});

test('invalid authentication context errors never disclose file contents', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-api-auth-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'auth.json');
  fs.writeFileSync(file, '{"password":"do-not-disclose-invalid-json', { mode: 0o600 });
  assert.throws(() => taskApiEnvironment({}, [], file), error => !error.message.includes('do-not-disclose'));
  fs.writeFileSync(file, JSON.stringify({ user: 'fixture', password: 'private', baseUrl: 'http://127.0.0.1' }));
  fs.chmodSync(file, 0o644);
  assert.throws(() => taskApiEnvironment({}, [], file), /could not be read/);
});

test('managed API wrapper authenticates its child without putting credentials in output or arguments', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-api-auth-wrapper-'));
  for (const name of ['runtime', 'data', 'workspace', 'source', 'skills', 'snapshot']) fs.mkdirSync(path.join(root, name));
  const password = 'fixture-private-value';
  let authenticated = false;
  const server = http.createServer((request, response) => {
    authenticated = request.headers.authorization === `Basic ${Buffer.from(`fixture:${password}`).toString('base64')}`;
    response.writeHead(authenticated ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: authenticated }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  writeTaskApiAuthentication({ baseUrl: `http://127.0.0.1:${server.address().port}`, user: 'fixture', password },
    path.join(root, 'runtime', 'task-api-auth.json'));
  fs.writeFileSync(path.join(root, 'snapshot', 'manifest.json'), JSON.stringify({ skills: [{ id: 'codex-task-platform-api' }] }));
  const client = path.join(root, 'client.js');
  fs.writeFileSync(client, `
    fetch(process.env.CODEX_TASK_API_URL, {headers:{authorization:'Basic '+Buffer.from(process.env.CODEX_TASK_API_USER+':'+process.env.CODEX_TASK_API_PASSWORD).toString('base64')}})
      .then(async response=>{if(!response.ok)process.exitCode=1;process.stdout.write(await response.text());});
  `);
  const environment = { ...process.env, CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
    CODEX_DESK_DATA_DIR: path.join(root, 'data'), CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'workspace'),
    SOURCE_CODEX_HOME: path.join(root, 'source'), WORKSPACE_CODEX_SKILLS_DIR: path.join(root, 'skills'),
    BRIDGE_RUNTIME_ROOT: path.join(root, 'bridge'), CODEX_TASK_ID: 'auth-fixture-task',
    CODEX_TASK_TURN_ID: 'auth-fixture-turn', CODEX_TASK_ATTEMPT_ID: 'auth-fixture-attempt',
    CODEX_TASK_SKILL_SNAPSHOT: path.join(root, 'snapshot') };
  delete environment.CODEX_TASK_API_USER; delete environment.CODEX_TASK_API_PASSWORD; delete environment.CODEX_TASK_API_URL;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(path.resolve(__dirname, '../bin/full-access/codex-skill-use'),
      ['codex-task-platform-api', '--', process.execPath, client], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('exit', code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(authenticated, true);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
  assert.equal((result.stdout + result.stderr).includes(password), false);
});

test('non-managed API wrapper use injects the local authentication context', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-api-auth-chat-'));
  const runtime = path.join(root, 'runtime');
  const snapshot = path.join(root, 'snapshot');
  fs.mkdirSync(runtime);
  fs.mkdirSync(snapshot);
  const password = 'chat-fixture-secret';
  writeTaskApiAuthentication({
    baseUrl: 'http://127.0.0.1:12345', user: 'chat-fixture', password,
  }, path.join(runtime, 'task-api-auth.json'));
  fs.writeFileSync(path.join(snapshot, 'manifest.json'), JSON.stringify({
    skills: [{ id: 'codex-task-platform-api' }],
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = path.join(root, 'client.js');
  fs.writeFileSync(client, 'process.stdout.write(JSON.stringify({ user: process.env.CODEX_TASK_API_USER || null, password: process.env.CODEX_TASK_API_PASSWORD || null }));');
  const environment = {
    ...process.env,
    CODEX_DESK_RUNTIME_DIR: runtime,
    CODEX_TASK_SKILL_SNAPSHOT: snapshot,
  };
  for (const name of [
    'CODEX_TASK_ID', 'CODEX_TASK_TURN_ID', 'CODEX_TASK_ATTEMPT_ID',
    'CODEX_TASK_API_URL', 'CODEX_TASK_API_USER', 'CODEX_TASK_API_PASSWORD',
  ]) delete environment[name];

  const result = await new Promise((resolve, reject) => {
    const child = spawn(path.resolve(__dirname, '../bin/full-access/codex-skill-use'),
      ['codex-task-platform-api', '--', process.execPath, client], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { user: 'chat-fixture', password });
  assert.equal(result.stderr, '');
});
