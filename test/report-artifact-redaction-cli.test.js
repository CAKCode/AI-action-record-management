const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT_DIR, 'bin', 'redact-skill-report-artifacts.js');
const HISTORICAL_REPORT_SCRIPT = path.join(ROOT_DIR, 'bin', 'redact-historical-skill-reports.js');

function run(script, environment, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT_DIR,
    env: environment,
    encoding: 'utf8',
  });
}

test('legacy artifact redaction CLI is read-only and does not reject an active runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-report-redaction-cli-'));
  const dataDir = path.join(root, 'data');
  const runtimeDir = path.join(root, 'runtime');
  const environment = {
    ...process.env,
    CODEX_DESK_DATA_DIR: dataDir,
    CODEX_DESK_RUNTIME_DIR: runtimeDir,
  };
  try {
    const preview = run(SCRIPT, environment);
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(JSON.parse(preview.stdout), {
      ok: true, applied: false, scanned: 0, redacted: 0, unchanged: 0,
    });

    const apply = run(SCRIPT, environment, ['--apply']);
    assert.equal(apply.status, 0, apply.stderr);
    assert.deepEqual(JSON.parse(apply.stdout), {
      ok: true, applied: true, scanned: 0, redacted: 0, unchanged: 0,
    });

    const lockDirectory = path.join(runtimeDir, 'web-supervisor.lock');
    fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
    const active = run(SCRIPT, environment);
    assert.equal(active.status, 0, active.stderr);
    assert.deepEqual(JSON.parse(active.stdout), {
      ok: true, applied: false, scanned: 0, redacted: 0, unchanged: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy historical report redaction CLI is read-only and does not reject an active runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-historical-report-redaction-cli-'));
  const dataDir = path.join(root, 'data');
  const runtimeDir = path.join(root, 'runtime');
  const environment = {
    ...process.env,
    CODEX_DESK_DATA_DIR: dataDir,
    CODEX_DESK_RUNTIME_DIR: runtimeDir,
  };
  try {
    const preview = run(HISTORICAL_REPORT_SCRIPT, environment);
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(JSON.parse(preview.stdout), {
      ok: true, applied: false, scanned: 0, redacted: 0, unchanged: 0,
    });

    const apply = run(HISTORICAL_REPORT_SCRIPT, environment, ['--apply']);
    assert.equal(apply.status, 0, apply.stderr);
    assert.deepEqual(JSON.parse(apply.stdout), {
      ok: true, applied: true, scanned: 0, redacted: 0, unchanged: 0,
    });

    const lockDirectory = path.join(runtimeDir, 'web-launcher.lock');
    fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
    const active = run(HISTORICAL_REPORT_SCRIPT, environment);
    assert.equal(active.status, 0, active.stderr);
    assert.deepEqual(JSON.parse(active.stdout), {
      ok: true, applied: false, scanned: 0, redacted: 0, unchanged: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
