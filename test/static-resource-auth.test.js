const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

function availablePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port;
      listener.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForService(url, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if ([200, 401].includes(response.status)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for static auth server');
}

async function stop(child) {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000)),
  ]);
}

test('authenticated deployments keep the application page and bundles behind the login shell', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-static-auth-'));
  const port = await availablePort();
  for (const name of ['data', 'runtime', 'workspaces', 'source', 'skills']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
  const environment = {
    ...process.env,
    HOST: '0.0.0.0',
    PORT: String(port),
    CODEX_DESK_DATA_DIR: path.join(root, 'data'),
    CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
    CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'workspaces'),
    SOURCE_CODEX_HOME: path.join(root, 'source'),
    WORKSPACE_CODEX_SKILLS_DIR: path.join(root, 'skills'),
    CODEX_ALLOW_ROOT_EXECUTION: '1',
    CODEX_DISABLE_WORKER: '1',
    CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
    CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    CODEX_DESK_AUTH_USER: 'test-user',
    CODEX_DESK_AUTH_PASSWORD: 'test-password',
  };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: environment,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(async () => {
    await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForService(baseUrl, child);
  for (const pathname of ['/', '/index.html', '/boot.js', '/app.js', '/vendor/xterm/xterm.js']) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 401, pathname);
    assert.match(response.headers.get('www-authenticate') || '', /Basic/);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.doesNotMatch(await response.text(), /<html|<script|<body/i);
  }

  const authorization = `Basic ${Buffer.from('test-user:test-password').toString('base64')}`;
  const login = await fetch(`${baseUrl}/api/auth/session`, {
    method: 'POST', headers: { authorization },
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';', 1)[0];
  assert.ok(cookie);

  const application = await fetch(`${baseUrl}/index.html`, { headers: { cookie } });
  assert.equal(application.status, 200);
  const bundle = await fetch(`${baseUrl}/app.js`, { headers: { cookie } });
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers.get('cache-control'), 'private, no-store');
  assert.match(bundle.headers.get('vary') || '', /Cookie/);
});
