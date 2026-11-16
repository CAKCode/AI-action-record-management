const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { packageVersion, syncSessionDaemonPackage } = require('../src/codex-session-package-sync');

function makePackage(root, version) {
  const packageRoot = path.join(root, 'packages', 'app-server-daemon');
  const release = path.join(packageRoot, 'releases', version);
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, 'codex-package.json'), JSON.stringify({ version }), 'utf8');
  fs.symlinkSync(path.relative(packageRoot, release), path.join(packageRoot, 'current'));
  return packageRoot;
}

test('synchronizes an idle Session daemon package from the global package', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-package-'));
  const sourceHome = path.join(root, 'global');
  const sessionHome = path.join(root, 'session');
  makePackage(sourceHome, '0.169.0');
  makePackage(sessionHome, '0.164.0');
  const result = await syncSessionDaemonPackage({
    runtime: { sessionId: 'session-test', codexHome: sessionHome },
    sourceHome,
    listProcesses: () => [],
    codexBinary: '/codex',
    execute: async () => ({ code: 0, stdout: 'codex-cli 0.169.0', stderr: '' }),
  });
  assert.deepEqual(result, { status: 'updated', previousVersion: '0.164.0', version: '0.169.0' });
  assert.equal(packageVersion(path.join(sessionHome, 'packages', 'app-server-daemon')), '0.169.0');
  fs.rmSync(root, { recursive: true, force: true });
});

test('leaves a matching Session package untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-package-'));
  const sourceHome = path.join(root, 'global');
  const sessionHome = path.join(root, 'session');
  makePackage(sourceHome, '0.169.0');
  makePackage(sessionHome, '0.169.0');
  const result = await syncSessionDaemonPackage({
    runtime: { sessionId: 'session-test', codexHome: sessionHome },
    sourceHome,
    listProcesses: () => [],
    codexBinary: '/codex',
    execute: async () => ({ code: 0, stdout: 'codex-cli 0.169.0', stderr: '' }),
  });
  assert.deepEqual(result, { status: 'current', version: '0.169.0' });
  fs.rmSync(root, { recursive: true, force: true });
});

test('fails closed when the global CLI and daemon package versions differ', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-package-'));
  const sourceHome = path.join(root, 'global');
  const sessionHome = path.join(root, 'session');
  makePackage(sourceHome, '0.169.0');
  await assert.rejects(
    syncSessionDaemonPackage({
      runtime: { sessionId: 'session-test', codexHome: sessionHome },
      sourceHome,
      codexBinary: '/codex',
      execute: async () => ({ code: 0, stdout: 'codex-cli 0.170.0', stderr: '' }),
      listProcesses: () => [],
    }),
    /Global Codex CLI 0\.170\.0 and daemon package 0\.169\.0 differ/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('creates a missing Session package parent before acquiring the sync lock', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-package-'));
  const sourceHome = path.join(root, 'global');
  const sessionHome = path.join(root, 'session');
  makePackage(sourceHome, '0.169.0');
  fs.mkdirSync(sessionHome, { recursive: true });
  const result = await syncSessionDaemonPackage({
    runtime: { sessionId: 'session-test', codexHome: sessionHome },
    sourceHome,
    listProcesses: () => [],
  });
  assert.equal(result.status, 'updated');
  assert.equal(packageVersion(path.join(sessionHome, 'packages', 'app-server-daemon')), '0.169.0');
  fs.rmSync(root, { recursive: true, force: true });
});

test('reclaims a stale package lock without leaving it in the active path', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-package-'));
  const sourceHome = path.join(root, 'global');
  const sessionHome = path.join(root, 'session');
  makePackage(sourceHome, '0.169.0');
  makePackage(sessionHome, '0.164.0');
  const lockPath = path.join(sessionHome, 'packages', '.app-server-daemon.sync.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, createdAt: Date.now() - 300000 }), 'utf8');
  const result = await syncSessionDaemonPackage({
    runtime: { sessionId: 'session-test', codexHome: sessionHome },
    sourceHome,
    listProcesses: () => [],
  });
  assert.equal(result.status, 'updated');
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(packageVersion(path.join(sessionHome, 'packages', 'app-server-daemon')), '0.169.0');
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects daemon packages containing absolute symbolic links', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-package-'));
  const sourceHome = path.join(root, 'global');
  const sessionHome = path.join(root, 'session');
  const sourcePackage = path.join(sourceHome, 'packages', 'app-server-daemon');
  const release = path.join(sourcePackage, 'releases', '0.169.0');
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(path.join(release, 'codex-package.json'), JSON.stringify({ version: '0.169.0' }), 'utf8');
  fs.symlinkSync(release, path.join(sourcePackage, 'current'));
  await assert.rejects(
    syncSessionDaemonPackage({
      runtime: { sessionId: 'session-test', codexHome: sessionHome },
      sourceHome,
      listProcesses: () => [],
    }),
    /absolute symbolic link/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});
