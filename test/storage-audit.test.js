const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-storage-audit-'));
process.env.CODEX_DESK_DATA_DIR = path.join(tempDir, 'data');
process.env.CODEX_DESK_RUNTIME_DIR = path.join(tempDir, 'runtime');
process.env.CODEX_DESK_BACKUP_DIR = path.join(tempDir, 'backups');
process.env.CODEX_TASK_WORKSPACE_ROOTS = path.join(tempDir, 'workspaces');
process.env.SOURCE_CODEX_HOME = path.join(tempDir, 'source-home');
process.env.WORKSPACE_CODEX_SKILLS_DIR = path.join(tempDir, 'workspace-skills');

for (const directory of [
  process.env.CODEX_DESK_DATA_DIR,
  process.env.CODEX_DESK_RUNTIME_DIR,
  process.env.CODEX_DESK_BACKUP_DIR,
  process.env.CODEX_TASK_WORKSPACE_ROOTS,
  process.env.SOURCE_CODEX_HOME,
  process.env.WORKSPACE_CODEX_SKILLS_DIR,
]) fs.mkdirSync(directory, { recursive: true });

const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
const { createStorageAuditRecorder } = require('../src/storage-audit');
const { createStorageAuditOutbox } = require('../src/storage-audit-outbox');

test.after(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('multiple audit events commit atomically', () => {
  store.ensureStorage();
  store.appendAuditEvent({ id: 'audit-existing', kind: 'test.existing' });
  assert.throws(() => store.appendAuditEvents([
    { id: 'audit-must-rollback', kind: 'test.first' },
    { id: 'audit-existing', kind: 'test.duplicate' },
  ]), /UNIQUE constraint failed/);
  const row = getDatabase().prepare("SELECT id FROM audit_events WHERE id='audit-must-rollback'").get();
  assert.equal(row, undefined);
});

test('idempotent audit batches accept an exact replay and reject changed content', () => {
  const event = {
    id: 'audit-11111111-1111-4111-8111-111111111111',
    ts: '2026-08-03T07:00:00.000Z',
    kind: 'database.backup.created',
    message: 'Stable event',
    payload: { id: 'db-stable' },
  };
  store.appendAuditEventsIdempotent([event]);
  store.appendAuditEventsIdempotent([event]);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) AS count FROM audit_events WHERE id=?').get(event.id).count, 1);
  assert.throws(
    () => store.appendAuditEventsIdempotent([{ ...event, message: 'Changed event' }]),
    /conflicts with existing content/,
  );
});

test('failed storage audits stay visible and retry as one complete batch', () => {
  const batches = [];
  let fail = true;
  const recorder = createStorageAuditRecorder((events) => {
    batches.push(events.map((event) => event.kind));
    if (fail) throw new Error('injected audit failure');
  }, { now: () => '2026-08-03T07:00:00.000Z' });

  assert.equal(recorder.record('database_backup', [
    { kind: 'database.backup.created' },
    { kind: 'database.backup.verified' },
  ], { publicMessage: 'Database backup audit persistence failed' }), false);
  assert.deepEqual(recorder.status('database_backup'), {
    auditFailureCount: 1,
    unrecordedAuditEventCount: 2,
    lastAuditErrorAt: '2026-08-03T07:00:00.000Z',
    lastAuditError: 'Database backup audit persistence failed',
    lastAuditRecoveryAt: '',
    auditQueueDurable: false,
    outboxFailureCount: 0,
    lastOutboxErrorAt: '',
    lastOutboxError: '',
  });

  fail = false;
  assert.equal(recorder.retry('database_backup'), true);
  assert.deepEqual(batches, [
    ['database.backup.created', 'database.backup.verified'],
    ['database.backup.created', 'database.backup.verified'],
  ]);
  assert.equal(recorder.status('database_backup').unrecordedAuditEventCount, 0);
  assert.equal(recorder.status('database_backup').lastAuditRecoveryAt, '2026-08-03T07:00:00.000Z');
});

test('a private outbox survives restart and clears after idempotent replay', () => {
  const outboxPath = path.join(tempDir, 'durable-outbox.json');
  const outbox = createStorageAuditOutbox(outboxPath);
  const first = createStorageAuditRecorder(() => {
    throw new Error('database temporarily unavailable');
  }, { outbox });
  assert.equal(first.record('recovery_checkpoint', [
    { kind: 'database.backup.created' },
    { kind: 'recovery.checkpoint.created' },
  ]), false);
  assert.equal(first.status('recovery_checkpoint').auditQueueDurable, true);
  assert.equal(fs.statSync(outboxPath).mode & 0o777, 0o600);

  const replayed = [];
  const second = createStorageAuditRecorder((events) => replayed.push(...events), { outbox });
  assert.equal(second.status('recovery_checkpoint').unrecordedAuditEventCount, 2);
  assert.equal(second.retryAll(), true);
  assert.equal(replayed.length, 2);
  assert.equal(new Set(replayed.map((event) => event.id)).size, 2);
  assert.equal(second.status('recovery_checkpoint').unrecordedAuditEventCount, 0);
  assert.equal(fs.existsSync(outboxPath), false);
});

test('unsafe or corrupt outbox files fail closed without deleting evidence', () => {
  const corruptPath = path.join(tempDir, 'corrupt-outbox.json');
  fs.writeFileSync(corruptPath, '{not-json', { mode: 0o644 });
  assert.throws(() => createStorageAuditOutbox(corruptPath).load(), SyntaxError);
  assert.equal(fs.readFileSync(corruptPath, 'utf8'), '{not-json');
  assert.equal(fs.statSync(corruptPath).mode & 0o777, 0o600);

  const oversizedPath = path.join(tempDir, 'oversized-outbox.json');
  fs.writeFileSync(oversizedPath, Buffer.alloc((4 * 1024 * 1024) + 1, 0x20), { mode: 0o600 });
  assert.throws(
    () => createStorageAuditOutbox(oversizedPath).load(),
    /exceeds its size limit/,
  );
  assert.equal(fs.statSync(oversizedPath).size, (4 * 1024 * 1024) + 1);

  const targetPath = path.join(tempDir, 'outbox-symlink-target.json');
  const symlinkPath = path.join(tempDir, 'outbox-symlink.json');
  fs.writeFileSync(targetPath, 'target-evidence', { mode: 0o640 });
  fs.symlinkSync(targetPath, symlinkPath);
  assert.throws(
    () => createStorageAuditOutbox(symlinkPath).load(),
    /not a regular file/,
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'target-evidence');
  assert.equal(fs.statSync(targetPath).mode & 0o777, 0o640);
  assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);
});
