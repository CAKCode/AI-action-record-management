const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectProcess } = require('../src/process-identity');

const ROOT_DIR = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-database-backup-'));
const dataDir = path.join(tempDir, 'data');
const runtimeDir = path.join(tempDir, 'runtime');
const backupDir = path.join(tempDir, 'backups');
const workspaceDir = path.join(tempDir, 'workspaces');

for (const directory of [dataDir, runtimeDir, backupDir, workspaceDir]) {
  fs.mkdirSync(directory, { recursive: true });
}

process.env.CODEX_DESK_DATA_DIR = dataDir;
process.env.CODEX_DESK_RUNTIME_DIR = runtimeDir;
process.env.CODEX_DESK_BACKUP_DIR = backupDir;
process.env.CODEX_TASK_WORKSPACE_ROOTS = workspaceDir;
process.env.CODEX_DB_BACKUP_INTERVAL_HOURS = '0';
process.env.CODEX_DB_BACKUP_RETENTION = '14';

const store = require('../src/store');
const { closeDatabase } = require('../src/database');
const {
  createDatabaseBackup,
  listDatabaseBackups,
  verifyDatabaseBackup,
  databaseBackupStatus,
  cancelDatabaseBackup,
} = require('../src/database-backup');

test.after(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('online backup publishes one private, self-verifying SQLite package', async () => {
  store.saveSession('backup-source', {
    name: 'Backup Source',
    objective: 'Prove online WAL backup consistency.',
    workingDir: workspaceDir,
  });

  const backup = await createDatabaseBackup();
  assert.equal(backup.status, 'available');
  assert.equal(backup.database.quickCheck, 'ok');
  assert.equal(backup.database.foreignKeyViolations, 0);
  assert.equal(backup.database.tableCounts.tasks, 1);
  assert.match(backup.database.sha256, /^[a-f0-9]{64}$/);

  const packageDir = path.join(backupDir, backup.id);
  assert.deepEqual(fs.readdirSync(packageDir).sort(), ['database.db', 'manifest.json']);
  assert.equal(fs.statSync(packageDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(packageDir, 'database.db')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(packageDir, 'manifest.json')).mode & 0o777, 0o600);

  const verification = await verifyDatabaseBackup(backup.id);
  assert.equal(verification.ok, true);
  assert.deepEqual(verification.checks, {
    packageLayout: true,
    permissions: true,
    sizeMatches: true,
    sha256Matches: true,
    quickCheck: 'ok',
    foreignKeyViolations: 0,
    foreignKeyCountMatches: true,
    pageCountMatches: true,
    pageSizeMatches: true,
    tableCountsMatch: true,
  });
  assert.deepEqual(fs.readdirSync(packageDir).sort(), ['database.db', 'manifest.json']);
  assert.equal(databaseBackupStatus().backupCount, 1);
  assert.equal(databaseBackupStatus().enabled, false);
});

test('v1 backups remain verifiable when later optional table counters are absent', async () => {
  const backup = await createDatabaseBackup({ retention: 30 });
  const manifestPath = path.join(backupDir, backup.id, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.database.tableCounts.skill_reports;
  delete manifest.database.tableCounts.skill_report_artifacts;
  delete manifest.database.tableCounts.skill_report_artifact_resources;
  delete manifest.database.tableCounts.skill_report_artifact_media_views;
  delete manifest.database.tableCounts.skill_report_artifact_jobs;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);

  const record = listDatabaseBackups().find((entry) => entry.id === backup.id);
  assert.equal(record.status, 'available');
  assert.equal(Object.hasOwn(record.database.tableCounts, 'skill_reports'), false);
  assert.equal(Object.hasOwn(record.database.tableCounts, 'skill_report_artifacts'), false);
  assert.equal(Object.hasOwn(record.database.tableCounts, 'skill_report_artifact_resources'), false);
  assert.equal(Object.hasOwn(record.database.tableCounts, 'skill_report_artifact_media_views'), false);
  assert.equal(Object.hasOwn(record.database.tableCounts, 'skill_report_artifact_jobs'), false);
  assert.equal((await verifyDatabaseBackup(backup.id)).ok, true);
});

test('v1 backup manifests still require the original table counters', async () => {
  const backup = await createDatabaseBackup({ retention: 30 });
  const manifestPath = path.join(backupDir, backup.id, 'manifest.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  delete manifest.database.tableCounts.tasks;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);

  assert.equal(listDatabaseBackups().find((entry) => entry.id === backup.id).status, 'invalid');
  await assert.rejects(verifyDatabaseBackup(backup.id), (error) => error.statusCode === 409);
  fs.writeFileSync(manifestPath, manifestText, { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);
});

test('online backup cannot start inside an unrelated maintenance lease', async () => {
  const owner = 'test:backup-maintenance-gate';
  store.acquirePlatformMaintenance('rolling_restart', owner, 30000);
  try {
    await assert.rejects(
      createDatabaseBackup(),
      (error) => error.statusCode === 503 && /Platform maintenance is active/.test(error.message),
    );
    assert.equal(fs.existsSync(path.join(backupDir, '.backup.lock')), false);
  } finally {
    store.releasePlatformMaintenance(owner);
  }
});

test('concurrent backup requests are rejected while the first snapshot is active', async () => {
  const first = createDatabaseBackup();
  assert.throws(
    () => createDatabaseBackup(),
    (error) => error.statusCode === 409 && /already in progress/i.test(error.message),
  );
  await first;
});

test('an in-flight backup can be cancelled without publishing partial state', async () => {
  const before = listDatabaseBackups().map((backup) => backup.id);
  let progressCalls = 0;
  const backup = createDatabaseBackup({
    onProgress() {
      progressCalls += 1;
      assert.equal(cancelDatabaseBackup(), true);
    },
  });

  await assert.rejects(backup, (error) => error.code === 'DATABASE_BACKUP_CANCELLED');
  assert.equal(progressCalls, 1);
  assert.equal(cancelDatabaseBackup(), false);
  assert.deepEqual(listDatabaseBackups().map((entry) => entry.id), before);
  assert.equal(fs.existsSync(path.join(backupDir, '.backup.lock')), false);
  assert.equal(fs.readdirSync(backupDir).some((name) => name.startsWith('.creating-')), false);
});

test('cross-process lock rejects a live owner and reclaims interrupted backup state', async () => {
  const lockDir = path.join(backupDir, '.backup.lock');
  const identity = inspectProcess(process.pid);
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    token: 'live-owner',
    pid: process.pid,
    startTicks: identity.startTicks,
    createdAt: new Date().toISOString(),
  }));
  await assert.rejects(
    createDatabaseBackup(),
    (error) => error.statusCode === 409 && /already in progress/i.test(error.message),
  );
  fs.rmSync(lockDir, { recursive: true, force: true });

  const interruptedPackage = path.join(backupDir, '.creating-interrupted');
  fs.mkdirSync(interruptedPackage);
  fs.writeFileSync(path.join(interruptedPackage, 'partial.db'), 'partial');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    token: 'stale-owner',
    pid: 999999999,
    startTicks: '1',
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  const recovered = await createDatabaseBackup();
  assert.equal((await verifyDatabaseBackup(recovered.id)).ok, true);
  assert.equal(fs.existsSync(interruptedPackage), false);
  assert.equal(fs.existsSync(lockDir), false);
});

test('a pre-publication fault preserves previous backups and removes its temporary package', async () => {
  const before = listDatabaseBackups().map((backup) => backup.id);
  await assert.rejects(
    createDatabaseBackup({
      faultInjector(stage) {
        if (stage === 'before_publish') throw new Error('injected publish failure');
      },
    }),
    /injected publish failure/,
  );
  assert.deepEqual(listDatabaseBackups().map((backup) => backup.id), before);
  assert.equal(fs.readdirSync(backupDir).some((name) => name.startsWith('.creating-')), false);
});

test('successful backups rotate only after publication and keep the configured newest count', async () => {
  const first = await createDatabaseBackup({ retention: 2 });
  const second = await createDatabaseBackup({ retention: 2 });
  const third = await createDatabaseBackup({ retention: 2 });
  const records = listDatabaseBackups();
  assert.equal(records.length, 2);
  assert.deepEqual(new Set(records.map((record) => record.id)), new Set([second.id, third.id]));
  assert.equal(fs.existsSync(path.join(backupDir, first.id)), false);
  assert.ok(third.removedBackupIds.length >= 1);
  const status = databaseBackupStatus();
  assert.equal(status.retentionExcessCount, Math.max(0, status.backupCount - status.retention));
  assert.equal(status.retentionSatisfied, true);
});

test('verification detects byte-for-byte tampering without deleting evidence', async () => {
  const backup = await createDatabaseBackup({ retention: 2 });
  const databaseFile = path.join(backupDir, backup.id, 'database.db');
  fs.appendFileSync(databaseFile, 'tampered');
  const verification = await verifyDatabaseBackup(backup.id);
  assert.equal(verification.ok, false);
  assert.equal(verification.checks.sizeMatches, false);
  assert.equal(verification.checks.sha256Matches, false);
  assert.equal(fs.existsSync(databaseFile), true);
});

test('verification does not remove unexpected SQLite sidecars from a backup package', async () => {
  const backup = await createDatabaseBackup({ retention: 30 });
  const sidecar = path.join(backupDir, backup.id, 'database.db-wal');
  const evidence = Buffer.from('unexpected SQLite sidecar evidence');
  fs.writeFileSync(sidecar, evidence, { mode: 0o600 });

  const verification = await verifyDatabaseBackup(backup.id);
  assert.equal(verification.ok, false);
  assert.equal(verification.checks.packageLayout, false);
  assert.deepEqual(fs.readFileSync(sidecar), evidence);
  fs.unlinkSync(sidecar);
});

test('automatic scheduler creates and verifies an overdue backup', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data', 'runtime', 'backups', 'workspaces']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const backup = require('./src/database-backup');",
    "const { closeDatabase } = require('./src/database');",
    "const hold = setTimeout(() => { console.error('scheduler timeout'); process.exit(2); }, 5000);",
    "backup.startDatabaseBackupScheduler({",
    "  onSuccess(result) {",
    "    const status = backup.databaseBackupStatus();",
    "    backup.stopDatabaseBackupScheduler();",
    "    backup.verifyDatabaseBackup(result.id).then((verified) => {",
    "      clearTimeout(hold);",
    "      closeDatabase();",
    "      console.log(JSON.stringify({ created: result.id, completedAt: result.completedAt, status, verified: verified.ok }));",
    "    }).catch((error) => { console.error(error); process.exit(3); });",
    "  },",
    "  onError(error) { console.error(error); process.exit(4); },",
    "}, { initialDelayMs: 10 });",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      TEST_ROOT: schedulerRoot,
      CODEX_DESK_DATA_DIR: path.join(schedulerRoot, 'data'),
      CODEX_DESK_RUNTIME_DIR: path.join(schedulerRoot, 'runtime'),
      CODEX_DESK_BACKUP_DIR: path.join(schedulerRoot, 'backups'),
      CODEX_TASK_WORKSPACE_ROOTS: path.join(schedulerRoot, 'workspaces'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '1',
      CODEX_DB_BACKUP_RETENTION: '2',
    },
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, JSON.stringify({
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message || '',
  }));
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.verified, true);
  assert.ok(Math.abs(Date.parse(output.status.nextRunAt)
    - Date.parse(output.completedAt) - (60 * 60 * 1000)) < 1000);
});

test('automatic backup defers maintenance without recording a failure', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-maintenance-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data', 'runtime', 'backups', 'workspaces']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const store = require('./src/store');",
    "const backup = require('./src/database-backup');",
    "const { closeDatabase } = require('./src/database');",
    "const owner = 'test:automatic-backup-maintenance';",
    "store.acquirePlatformMaintenance('test_maintenance', owner, 30000);",
    "const hold = setTimeout(() => { console.error('scheduler timeout'); process.exit(2); }, 5000);",
    "backup.startDatabaseBackupScheduler({",
    "  onDeferred(info) {",
    "    const status = backup.databaseBackupStatus();",
    "    backup.stopDatabaseBackupScheduler();",
    "    store.releasePlatformMaintenance(owner);",
    "    clearTimeout(hold);",
    "    closeDatabase();",
    "    console.log(JSON.stringify({ info, status, packages: fs.readdirSync(process.env.CODEX_DESK_BACKUP_DIR) }));",
    "  },",
    "  onSuccess() { console.error('backup ran during maintenance'); process.exit(3); },",
    "  onError(error) { console.error(error); process.exit(4); },",
    "}, { initialDelayMs: 10 });",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      TEST_ROOT: schedulerRoot,
      CODEX_DESK_DATA_DIR: path.join(schedulerRoot, 'data'),
      CODEX_DESK_RUNTIME_DIR: path.join(schedulerRoot, 'runtime'),
      CODEX_DESK_BACKUP_DIR: path.join(schedulerRoot, 'backups'),
      CODEX_TASK_WORKSPACE_ROOTS: path.join(schedulerRoot, 'workspaces'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '1',
    },
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.info.reason, 'platform_maintenance');
  assert.equal(output.status.lastDeferredReason, 'platform_maintenance');
  assert.ok(Date.parse(output.status.lastDeferredAt) > 0);
  assert.equal(output.status.lastError, '');
  assert.ok(Date.parse(output.status.nextRunAt) > Date.now());
  assert.deepEqual(output.packages, []);
});

test('a successful manual backup clears a prior automatic backup failure', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-storage-failure-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data', 'runtime', 'backups', 'workspaces']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const backup = require('./src/database-backup');",
    "const { closeDatabase } = require('./src/database');",
    "const backupDir = path.resolve(process.env.CODEX_DESK_BACKUP_DIR);",
    "const originalReaddir = fs.readdirSync;",
    "const hold = setTimeout(() => { console.error('scheduler timeout'); process.exit(2); }, 5000);",
    "backup.startDatabaseBackupScheduler({",
    "  onSuccess() { console.error('backup unexpectedly succeeded'); process.exit(3); },",
    "  onDeferred() { console.error('storage failure was misclassified as deferred'); process.exit(4); },",
    "  onError(error) {",
    "    const failedStatus = backup.databaseBackupStatus();",
    "    fs.readdirSync = originalReaddir;",
    "    backup.createDatabaseBackup().then(() => {",
    "      const recoveredStatus = backup.databaseBackupStatus();",
    "      backup.stopDatabaseBackupScheduler();",
    "      clearTimeout(hold);",
    "      closeDatabase();",
    "      console.log(JSON.stringify({ message: error.message, failedStatus, recoveredStatus }));",
    "    }).catch((manualError) => { console.error(manualError); process.exit(5); });",
    "  },",
    "}, { initialDelayMs: 30 });",
    "fs.readdirSync = (target, ...args) => {",
    "  if (path.resolve(String(target)) === backupDir) throw Object.assign(new Error('injected backup storage failure'), { code: 'EACCES' });",
    "  return originalReaddir(target, ...args);",
    "};",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      TEST_ROOT: schedulerRoot,
      CODEX_DESK_DATA_DIR: path.join(schedulerRoot, 'data'),
      CODEX_DESK_RUNTIME_DIR: path.join(schedulerRoot, 'runtime'),
      CODEX_DESK_BACKUP_DIR: path.join(schedulerRoot, 'backups'),
      CODEX_TASK_WORKSPACE_ROOTS: path.join(schedulerRoot, 'workspaces'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '1',
    },
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.match(output.message, /injected backup storage failure/);
  assert.equal(output.failedStatus.lastError, 'Automatic database backup failed');
  assert.ok(Date.parse(output.failedStatus.lastErrorAt) > 0);
  assert.ok(Date.parse(output.failedStatus.nextRunAt) > Date.now());
  assert.equal(output.recoveredStatus.lastError, '');
  assert.equal(output.recoveredStatus.lastErrorAt, '');
  assert.ok(Date.parse(output.recoveredStatus.lastSuccessAt) > 0);
  assert.equal(output.recoveredStatus.backupCount, 1);
});

test('automatic backup contains unexpected preflight rejection and keeps its scheduler alive', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-preflight-failure-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data', 'runtime', 'backups', 'workspaces']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const storePath = require.resolve('./src/store');",
    "const store = require(storePath);",
    "require.cache[storePath].exports = { ...store, getPlatformMaintenance() { throw new Error('injected backup preflight failure'); } };",
    "const backup = require('./src/database-backup');",
    "const { closeDatabase } = require('./src/database');",
    "process.once('unhandledRejection', (error) => { console.error(`unhandled: ${error.message}`); process.exit(5); });",
    "const hold = setTimeout(() => { console.error('scheduler timeout'); process.exit(2); }, 5000);",
    "backup.startDatabaseBackupScheduler({",
    "  onSuccess() { console.error('backup unexpectedly succeeded'); process.exit(3); },",
    "  onDeferred() { console.error('preflight failure was misclassified as deferred'); process.exit(4); },",
    "  onError(error) {",
    "    const status = backup.databaseBackupStatus();",
    "    backup.stopDatabaseBackupScheduler();",
    "    clearTimeout(hold);",
    "    closeDatabase();",
    "    console.log(JSON.stringify({ message: error.message, status }));",
    "  },",
    "}, { initialDelayMs: 10 });",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      TEST_ROOT: schedulerRoot,
      CODEX_DESK_DATA_DIR: path.join(schedulerRoot, 'data'),
      CODEX_DESK_RUNTIME_DIR: path.join(schedulerRoot, 'runtime'),
      CODEX_DESK_BACKUP_DIR: path.join(schedulerRoot, 'backups'),
      CODEX_TASK_WORKSPACE_ROOTS: path.join(schedulerRoot, 'workspaces'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '1',
    },
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.message, 'injected backup preflight failure');
  assert.equal(output.status.lastError, 'Automatic database backup failed');
  assert.ok(Date.parse(output.status.lastAttemptAt) > 0);
  assert.ok(Date.parse(output.status.lastErrorAt) > 0);
  assert.ok(Date.parse(output.status.nextRunAt) > Date.now());
});

test('restarting the backup scheduler replaces its pending timer', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-restart-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data', 'runtime', 'backups', 'workspaces']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const realSetTimeout = global.setTimeout;",
    "const realClearTimeout = global.clearTimeout;",
    "const timers = new Set();",
    "global.setTimeout = (callback, delay, ...args) => {",
    "  let timer;",
    "  timer = realSetTimeout(() => { timers.delete(timer); callback(...args); }, delay);",
    "  timers.add(timer);",
    "  return timer;",
    "};",
    "global.clearTimeout = (timer) => { timers.delete(timer); return realClearTimeout(timer); };",
    "const backup = require('./src/database-backup');",
    "backup.startDatabaseBackupScheduler({}, { initialDelayMs: 5000 });",
    "backup.startDatabaseBackupScheduler({}, { initialDelayMs: 6000 });",
    "const activeAfterRestart = timers.size;",
    "const nextRunAt = backup.databaseBackupStatus().nextRunAt;",
    "backup.stopDatabaseBackupScheduler();",
    "console.log(JSON.stringify({ activeAfterRestart, activeAfterStop: timers.size, nextRunAt }));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      TEST_ROOT: schedulerRoot,
      CODEX_DESK_DATA_DIR: path.join(schedulerRoot, 'data'),
      CODEX_DESK_RUNTIME_DIR: path.join(schedulerRoot, 'runtime'),
      CODEX_DESK_BACKUP_DIR: path.join(schedulerRoot, 'backups'),
      CODEX_TASK_WORKSPACE_ROOTS: path.join(schedulerRoot, 'workspaces'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.activeAfterRestart, 1);
  assert.equal(output.activeAfterStop, 0);
  assert.ok(Date.parse(output.nextRunAt) > Date.now());
});

test('scheduler startup immediately publishes the deadline of an existing successful backup', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-existing-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data', 'runtime', 'backups', 'workspaces']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const backup = require('./src/database-backup');",
    "const { closeDatabase } = require('./src/database');",
    "backup.createDatabaseBackup().then((created) => {",
    "  backup.startDatabaseBackupScheduler({}, { initialDelayMs: 10 });",
    "  const status = backup.databaseBackupStatus();",
    "  backup.stopDatabaseBackupScheduler();",
    "  closeDatabase();",
    "  console.log(JSON.stringify({ completedAt: created.completedAt, status }));",
    "}).catch((error) => { console.error(error); process.exit(2); });",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      TEST_ROOT: schedulerRoot,
      CODEX_DESK_DATA_DIR: path.join(schedulerRoot, 'data'),
      CODEX_DESK_RUNTIME_DIR: path.join(schedulerRoot, 'runtime'),
      CODEX_DESK_BACKUP_DIR: path.join(schedulerRoot, 'backups'),
      CODEX_TASK_WORKSPACE_ROOTS: path.join(schedulerRoot, 'workspaces'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '1',
    },
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.status.lastSuccessAt, output.completedAt);
  assert.ok(Math.abs(Date.parse(output.status.nextRunAt)
    - Date.parse(output.completedAt) - (60 * 60 * 1000)) < 1000);
  assert.ok(Date.parse(output.status.nextRunAt) > Date.now() + (50 * 60 * 1000));
});

test('a manual backup immediately reanchors the automatic due time', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-manual-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data', 'runtime', 'backups', 'workspaces']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const backup = require('./src/database-backup');",
    "const { closeDatabase } = require('./src/database');",
    "backup.startDatabaseBackupScheduler({}, { initialDelayMs: 1000 });",
    "const before = backup.databaseBackupStatus().nextRunAt;",
    "backup.createDatabaseBackup().then((created) => {",
    "  const after = backup.databaseBackupStatus().nextRunAt;",
    "  backup.stopDatabaseBackupScheduler();",
    "  closeDatabase();",
    "  console.log(JSON.stringify({ before, after, completedAt: created.completedAt }));",
    "}).catch((error) => { console.error(error); process.exit(2); });",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      TEST_ROOT: schedulerRoot,
      CODEX_DESK_DATA_DIR: path.join(schedulerRoot, 'data'),
      CODEX_DESK_RUNTIME_DIR: path.join(schedulerRoot, 'runtime'),
      CODEX_DESK_BACKUP_DIR: path.join(schedulerRoot, 'backups'),
      CODEX_TASK_WORKSPACE_ROOTS: path.join(schedulerRoot, 'workspaces'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '1',
    },
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.ok(Date.parse(output.after) > Date.parse(output.before) + (50 * 60 * 1000));
  assert.ok(Math.abs(Date.parse(output.after) - Date.parse(output.completedAt) - (60 * 60 * 1000)) < 1000);
});

test('invalid backup scheduling and retention values fail during service configuration', () => {
  for (const [name, value] of [
    ['CODEX_DB_BACKUP_INTERVAL_HOURS', '-1'],
    ['CODEX_DB_BACKUP_RETENTION', '0'],
    ['CODEX_DB_BACKUP_MAX_DURATION_MINUTES', '0'],
  ]) {
    const result = spawnSync(process.execPath, ['-e', "require('./src/database-backup')"], {
      cwd: ROOT_DIR,
      env: { ...process.env, [name]: value },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(name));
  }
});

test('database backup retention defaults to one package', () => {
  const environment = { ...process.env };
  delete environment.CODEX_DB_BACKUP_RETENTION;
  const result = spawnSync(
    process.execPath,
    ['-e', "process.stdout.write(String(require('./src/database-backup').BACKUP_RETENTION))"],
    {
      cwd: ROOT_DIR,
      env: environment,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '1');
});
