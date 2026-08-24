const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RotatingLog, supervisorLogOptions } = require('../src/rotating-log');

function orderedLogContent(filePath, retention) {
  const chunks = [];
  for (let index = retention; index >= 1; index -= 1) {
    const rotated = `${filePath}.${index}`;
    if (fs.existsSync(rotated)) chunks.push(fs.readFileSync(rotated));
  }
  if (fs.existsSync(filePath)) chunks.push(fs.readFileSync(filePath));
  return Buffer.concat(chunks);
}

test('rotating log bounds every private file and preserves the retained byte tail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rotating-log-'));
  const directory = path.join(root, 'runtime');
  const filePath = path.join(directory, 'web-supervisor.log');
  fs.mkdirSync(directory, { mode: 0o755 });
  const initial = Buffer.from('legacy-log-'.repeat(80));
  fs.writeFileSync(filePath, initial, { mode: 0o644 });
  fs.writeFileSync(`${filePath}.3`, 'outside new retention', { mode: 0o644 });
  fs.writeFileSync(`${filePath}.trim-999999-1`, 'interrupted trim', { mode: 0o600 });
  const payload = Buffer.from(Array.from({ length: 1400 }, (_, index) => String.fromCharCode(33 + (index % 90))).join(''));
  const log = new RotatingLog(filePath, { maxBytes: 256, retention: 2 });
  try {
    assert.equal(fs.statSync(`${filePath}.1`).size, 256);
    assert.equal(fs.existsSync(`${filePath}.3`), false);
    assert.equal(fs.existsSync(`${filePath}.trim-999999-1`), false);
    log.write(payload.subarray(0, 333));
    log.write(payload.subarray(333));
  } finally {
    log.close();
  }

  const files = fs.readdirSync(directory)
    .filter((name) => /^web-supervisor\.log(?:\.\d+)?$/.test(name))
    .sort();
  assert.deepEqual(files, ['web-supervisor.log', 'web-supervisor.log.1', 'web-supervisor.log.2']);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  for (const name of files) {
    const stat = fs.lstatSync(path.join(directory, name));
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.ok(stat.size <= 256, `${name} exceeded the configured bound`);
  }
  const retained = orderedLogContent(filePath, 2);
  const expected = Buffer.concat([initial, payload]).subarray(-retained.length);
  assert.deepEqual(retained, expected);
  fs.rmSync(root, { recursive: true, force: true });
});

test('rotating log rejects a symbolic-link destination', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rotating-log-link-'));
  const directory = path.join(root, 'runtime');
  const target = path.join(root, 'target.log');
  const filePath = path.join(directory, 'web-supervisor.log');
  fs.mkdirSync(directory);
  fs.writeFileSync(target, 'must not be touched');
  fs.symlinkSync(target, filePath);
  assert.throws(
    () => new RotatingLog(filePath, { maxBytes: 256, retention: 2 }),
    /not a regular file/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'must not be touched');
  fs.rmSync(root, { recursive: true, force: true });
});

test('supervisor log configuration rejects unsafe bounds', () => {
  const previousMax = process.env.CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES;
  const previousRetention = process.env.CODEX_WEB_SUPERVISOR_LOG_RETENTION;
  try {
    process.env.CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES = '255';
    assert.throws(() => supervisorLogOptions('/tmp/runtime'), /MAX_BYTES/);
    process.env.CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES = '1048576';
    process.env.CODEX_WEB_SUPERVISOR_LOG_RETENTION = '0';
    assert.throws(() => supervisorLogOptions('/tmp/runtime'), /RETENTION/);
    process.env.CODEX_WEB_SUPERVISOR_LOG_RETENTION = '3';
    assert.deepEqual(supervisorLogOptions('/tmp/runtime'), {
      filePath: '/tmp/runtime/web-supervisor.log',
      maxBytes: 1048576,
      retention: 3,
    });
  } finally {
    if (previousMax == null) delete process.env.CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES;
    else process.env.CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES = previousMax;
    if (previousRetention == null) delete process.env.CODEX_WEB_SUPERVISOR_LOG_RETENTION;
    else process.env.CODEX_WEB_SUPERVISOR_LOG_RETENTION = previousRetention;
  }
});
