const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const tar = require('tar');

const ROOT_DIR = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-checkpoint-'));
const dataDir = path.join(tempDir, 'data');
const runtimeDir = path.join(tempDir, 'runtime');
const backupDir = path.join(dataDir, 'backups');
const workspaceRoot = path.join(tempDir, 'workspaces');
const sourceHome = path.join(tempDir, 'source-home');
const workspaceSkills = path.join(tempDir, 'workspace-skills');

for (const directory of [dataDir, runtimeDir, workspaceRoot, sourceHome, workspaceSkills]) {
  fs.mkdirSync(directory, { recursive: true });
}

process.env.CODEX_DESK_DATA_DIR = dataDir;
process.env.CODEX_DESK_RUNTIME_DIR = runtimeDir;
process.env.CODEX_DESK_BACKUP_DIR = backupDir;
process.env.CODEX_TASK_WORKSPACE_ROOTS = workspaceRoot;
process.env.SOURCE_CODEX_HOME = sourceHome;
process.env.WORKSPACE_CODEX_SKILLS_DIR = workspaceSkills;
process.env.CODEX_DB_BACKUP_INTERVAL_HOURS = '0';
process.env.CODEX_DB_BACKUP_RETENTION = '30';
process.env.CODEX_RECOVERY_CHECKPOINT_RETENTION = '3';
process.env.CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS = '1';

const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
const {
  listRecoveryCheckpoints,
  createRecoveryCheckpoint,
  verifyRecoveryCheckpoint,
  recoveryCheckpointStatus,
} = require('../src/recovery-checkpoint');
const { RECOVERY_CHECKPOINT_DIR } = require('../src/paths');

const secret = 'OPENAI_API_KEY=recovery-secret-must-not-leak';
const runtimeSessionDir = path.join(
  runtimeDir,
  'bridge-sessions',
  '.bridge-codex-home',
  'sessions',
  'session-a',
);
const rawLog = Buffer.from('command stdout\0with raw bytes\n', 'utf8');
const archivedExternalLog = Buffer.from('pytest raw output\0preserved by platform\n', 'utf8');
fs.mkdirSync(runtimeSessionDir, { recursive: true });
fs.writeFileSync(path.join(runtimeSessionDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: secret }), { mode: 0o600 });
fs.writeFileSync(path.join(runtimeSessionDir, 'state_5.sqlite'), 'Bridge-owned SQLite database');
fs.writeFileSync(path.join(runtimeSessionDir, 'state_5.sqlite-wal'), 'Bridge-owned SQLite WAL');
fs.writeFileSync(path.join(runtimeSessionDir, 'state_5.sqlite-shm'), 'Bridge-owned SQLite shared memory');
fs.writeFileSync(path.join(runtimeDir, 'platform-runtime.json'), '{"platform":"managed"}');
fs.mkdirSync(path.join(dataDir, 'sessions', 'task-a', 'attempt-output'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'sessions', 'task-a', 'attempt-output', 'attempt-a.stdout.log'), rawLog);
fs.mkdirSync(path.join(dataDir, 'sessions', 'task-a', 'external-attempt-output'));
fs.writeFileSync(
  path.join(dataDir, 'sessions', 'task-a', 'external-attempt-output', 'external-a.log'),
  archivedExternalLog,
);
fs.mkdirSync(path.join(dataDir, 'sessions', 'task-a', 'skill-report-artifacts', 'report-a.resources'), { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'sessions', 'task-a', 'skill-report-artifacts', 'report-a.html'),
  '<html>managed report</html>',
);
fs.mkdirSync(path.join(dataDir, 'agents'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'agents', 'builder.json'), '{"legacy":true}');
fs.mkdirSync(path.join(runtimeSessionDir, 'tmp'), { recursive: true });
fs.writeFileSync(path.join(runtimeSessionDir, 'tmp', 'excluded.tmp'), 'temporary');
fs.mkdirSync(path.join(runtimeDir, 'bridge-sessions', 'locks'), { recursive: true });
fs.writeFileSync(path.join(runtimeDir, 'bridge-sessions', 'locks', 'session-a.lock'), 'lock');
fs.mkdirSync(path.join(runtimeDir, 'web-supervisor.lock'));
fs.writeFileSync(path.join(runtimeDir, 'web-supervisor.lock', 'owner.json'), '{}');
fs.mkdirSync(path.join(runtimeDir, 'web-launcher.lock'));
fs.writeFileSync(path.join(runtimeDir, 'web-launcher.lock', 'owner.json'), '{}');
fs.symlinkSync('/etc/passwd', path.join(dataDir, 'outside-link'));

let firstCheckpoint;

test.after(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('recovery checkpoint is private, complete for platform roots, and omits transient paths', async () => {
  store.ensureStorage();
  firstCheckpoint = await createRecoveryCheckpoint();
  assert.equal(firstCheckpoint.status, 'available');
  assert.equal(firstCheckpoint.sensitive, true);
  assert.deepEqual(firstCheckpoint.coverage, {
    sqliteDatabase: true,
    platformDataFiles: true,
    platformRuntimeFiles: true,
    taskWorkingDirectories: false,
    externallyLocatedLogs: false,
  });
  assert.equal(firstCheckpoint.database.maintenanceLeaseCount, 0);
  assert.equal(firstCheckpoint.database.maintenanceLeaseCleared, true);
  assert.equal(store.getPlatformMaintenance(), null);

  const packageDir = path.join(RECOVERY_CHECKPOINT_DIR, firstCheckpoint.id);
  assert.equal(fs.statSync(RECOVERY_CHECKPOINT_DIR).mode & 0o777, 0o700);
  assert.equal(fs.statSync(packageDir).mode & 0o777, 0o700);
  for (const name of ['database.db', 'payload.tar.gz', 'manifest.json']) {
    assert.equal(fs.statSync(path.join(packageDir, name)).mode & 0o777, 0o600);
  }

  const checkpointDb = new Database(path.join(packageDir, 'database.db'), { readonly: true });
  assert.equal(
    checkpointDb.prepare("SELECT COUNT(*) AS count FROM metadata WHERE key='platform_maintenance'").get().count,
    0,
  );
  checkpointDb.close();

  const archiveEntries = [];
  await tar.list({
    file: path.join(packageDir, 'payload.tar.gz'),
    onReadEntry(entry) { archiveEntries.push(entry.path.replace(/^\.\//, '').replace(/\/$/, '')); },
  });
  assert.ok(archiveEntries.includes('runtime/platform-runtime.json'));
  assert.ok(archiveEntries.includes('data/sessions/task-a/attempt-output/attempt-a.stdout.log'));
  assert.ok(archiveEntries.includes('data/sessions/task-a/external-attempt-output/external-a.log'));
  assert.equal(archiveEntries.some((entry) => entry.includes('skill-report-artifacts')), false);
  assert.equal(archiveEntries.some((entry) => entry.includes('/tmp/') || entry.endsWith('/tmp')), false);
  assert.equal(archiveEntries.some((entry) => entry.startsWith('runtime/bridge-sessions/locks')), false);
  assert.equal(archiveEntries.some((entry) => entry.startsWith('runtime/web-supervisor.lock')), false);
  assert.equal(archiveEntries.some((entry) => entry.startsWith('runtime/web-launcher.lock')), false);
  assert.equal(archiveEntries.some((entry) => entry.startsWith('runtime/bridge-sessions/.bridge-codex-home/sessions')), false);
  assert.equal(archiveEntries.some((entry) => entry === 'data/outside-link'), false);
  assert.equal(archiveEntries.some((entry) => entry.startsWith('data/backups')), false);
  assert.equal(archiveEntries.some((entry) => entry.startsWith('data/agents')), false);
  assert.equal(firstCheckpoint.source.excluded.legacyMigration, 1);
  assert.equal(firstCheckpoint.source.excluded.bridgeCodexSessions, 1);
  assert.equal(firstCheckpoint.source.excluded.platformReportArtifacts, 1);

  const extracted = path.join(tempDir, 'extracted');
  fs.mkdirSync(extracted);
  await tar.extract({ cwd: extracted, file: path.join(packageDir, 'payload.tar.gz'), strict: true });
  assert.equal(fs.existsSync(path.join(
    extracted,
    'runtime',
    'bridge-sessions',
    '.bridge-codex-home',
    'sessions',
    'session-a',
    'auth.json',
  )), false);
  assert.deepEqual(
    fs.readFileSync(path.join(extracted, 'data', 'sessions', 'task-a', 'attempt-output', 'attempt-a.stdout.log')),
    rawLog,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(extracted, 'data', 'sessions', 'task-a', 'external-attempt-output', 'external-a.log')),
    archivedExternalLog,
  );

  const verification = await verifyRecoveryCheckpoint(firstCheckpoint.id);
  assert.equal(verification.ok, true, JSON.stringify(verification));
  assert.equal(verification.checks.databaseMaintenanceLeaseCleared, true);
});

test('public checkpoint records use a fixed whitelist and never expose package content or host paths', () => {
  const manifestPath = path.join(RECOVERY_CHECKPOINT_DIR, firstCheckpoint.id, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.source.secret = secret;
  manifest.source.hostPath = runtimeDir;
  manifest.database.hostPath = path.join(dataDir, 'codex-tasks.db');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const serialized = JSON.stringify(listRecoveryCheckpoints());
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes(runtimeDir), false);
  assert.equal(serialized.includes('hostPath'), false);
});

test('v1 checkpoints remain verifiable when later optional counters are absent', async () => {
  const checkpoint = await createRecoveryCheckpoint({ retention: 30 });
  const manifestPath = path.join(RECOVERY_CHECKPOINT_DIR, checkpoint.id, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.database.tableCounts.skill_reports;
  delete manifest.database.tableCounts.skill_report_artifacts;
  delete manifest.database.tableCounts.skill_report_artifact_resources;
  delete manifest.database.tableCounts.skill_report_artifact_jobs;
  delete manifest.source.excluded.legacyMigration;
  delete manifest.source.excluded.bridgeCodexSessions;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);

  const record = listRecoveryCheckpoints().find((entry) => entry.id === checkpoint.id);
  assert.equal(record.status, 'available');
  assert.equal(Object.hasOwn(record.database.tableCounts, 'skill_reports'), false);
  assert.equal(Object.hasOwn(record.database.tableCounts, 'skill_report_artifacts'), false);
  assert.equal(Object.hasOwn(record.database.tableCounts, 'skill_report_artifact_resources'), false);
  assert.equal(Object.hasOwn(record.database.tableCounts, 'skill_report_artifact_jobs'), false);
  assert.equal(Object.hasOwn(record.source.excluded, 'legacyMigration'), false);
  assert.equal(Object.hasOwn(record.source.excluded, 'bridgeCodexSessions'), false);
  assert.equal((await verifyRecoveryCheckpoint(checkpoint.id)).ok, true);
});

test('v1 checkpoint manifests still require the original table counters', async () => {
  const checkpoint = await createRecoveryCheckpoint({ retention: 30 });
  const manifestPath = path.join(RECOVERY_CHECKPOINT_DIR, checkpoint.id, 'manifest.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  delete manifest.database.tableCounts.tasks;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);

  assert.equal(listRecoveryCheckpoints().find((entry) => entry.id === checkpoint.id).status, 'invalid');
  await assert.rejects(verifyRecoveryCheckpoint(checkpoint.id), (error) => error.statusCode === 409);
  fs.writeFileSync(manifestPath, manifestText, { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);
});

test('verification detects database, archive, and permission tampering', async () => {
  const packageDir = path.join(RECOVERY_CHECKPOINT_DIR, firstCheckpoint.id);
  const databasePath = path.join(packageDir, 'database.db');
  const archivePath = path.join(packageDir, 'payload.tar.gz');
  const database = fs.readFileSync(databasePath);
  const archive = fs.readFileSync(archivePath);

  fs.appendFileSync(databasePath, 'tampered');
  let verification = await verifyRecoveryCheckpoint(firstCheckpoint.id);
  assert.equal(verification.ok, false);
  assert.equal(verification.checks.databaseSha256Matches, false);
  fs.writeFileSync(databasePath, database, { mode: 0o600 });

  const modifiedArchive = Buffer.from(archive);
  modifiedArchive[Math.max(0, modifiedArchive.length - 16)] ^= 0xff;
  fs.writeFileSync(archivePath, modifiedArchive, { mode: 0o600 });
  verification = await verifyRecoveryCheckpoint(firstCheckpoint.id);
  assert.equal(verification.ok, false);
  assert.equal(verification.checks.archiveSha256Matches, false);
  fs.writeFileSync(archivePath, archive, { mode: 0o600 });

  fs.chmodSync(databasePath, 0o644);
  verification = await verifyRecoveryCheckpoint(firstCheckpoint.id);
  assert.equal(verification.ok, false);
  assert.equal(verification.checks.permissions, false);
  fs.chmodSync(databasePath, 0o600);

  const unexpectedSidecar = `${databasePath}-wal`;
  const sidecarEvidence = Buffer.from('unexpected sidecar evidence');
  fs.writeFileSync(unexpectedSidecar, sidecarEvidence, { mode: 0o600 });
  verification = await verifyRecoveryCheckpoint(firstCheckpoint.id);
  assert.equal(verification.ok, false);
  assert.equal(verification.checks.packageLayout, false);
  assert.deepEqual(fs.readFileSync(unexpectedSidecar), sidecarEvidence);
  fs.unlinkSync(unexpectedSidecar);

  assert.equal((await verifyRecoveryCheckpoint(firstCheckpoint.id)).ok, true);
  assert.equal(
    fs.readdirSync(RECOVERY_CHECKPOINT_DIR).some((name) => name.startsWith('.verifying-')),
    false,
  );
});

test('a pre-publication failure preserves prior packages and releases maintenance', async () => {
  const before = listRecoveryCheckpoints().map((checkpoint) => checkpoint.id);
  await assert.rejects(
    createRecoveryCheckpoint({
      faultInjector(point) {
        if (point === 'before_publish') throw new Error('injected publication failure');
      },
    }),
    /injected publication failure/,
  );
  assert.deepEqual(listRecoveryCheckpoints().map((checkpoint) => checkpoint.id), before);
  assert.equal(
    fs.readdirSync(RECOVERY_CHECKPOINT_DIR).some((name) => name.startsWith('.creating-')),
    false,
  );
  assert.equal(store.getPlatformMaintenance(), null);
});

test('maintenance release cleanup cannot mask the original checkpoint failure', async () => {
  const originalConsoleError = console.error;
  let cleanupMessage = '';
  console.error = (message) => { cleanupMessage += String(message); };
  try {
    await assert.rejects(
      createRecoveryCheckpoint({
        faultInjector(point) {
          if (point === 'after_inventory') throw new Error('primary checkpoint failure');
        },
        releaseMaintenance(owner) {
          store.releasePlatformMaintenance(owner);
          throw new Error('secondary release failure');
        },
      }),
      /primary checkpoint failure/,
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.match(cleanupMessage, /secondary release failure/);
  assert.equal(store.getPlatformMaintenance(), null);
});

test('a published checkpoint remains successful when maintenance release cannot be confirmed', async () => {
  const originalConsoleError = console.error;
  let releaseOwner = '';
  let cleanupMessage = '';
  console.error = (message) => { cleanupMessage += String(message); };
  let checkpoint;
  try {
    checkpoint = await createRecoveryCheckpoint({
      retention: 30,
      releaseMaintenance(owner) {
        releaseOwner = owner;
        throw new Error('injected post-publication release failure');
      },
    });
    assert.equal(checkpoint.status, 'available');
    assert.equal(checkpoint.maintenanceReleaseUnconfirmed, true);
    assert.ok(Date.parse(checkpoint.maintenanceLeaseExpiresAt) > Date.now());
    assert.equal(listRecoveryCheckpoints().some((record) => record.id === checkpoint.id), true);
    assert.equal((await verifyRecoveryCheckpoint(checkpoint.id)).ok, true);
    assert.equal(store.getPlatformMaintenance()?.kind, 'recovery_checkpoint');
    assert.match(cleanupMessage, /post-publication release failure/);
    assert.match(recoveryCheckpointStatus().lastError, /published.*release could not be confirmed/i);
  } finally {
    console.error = originalConsoleError;
    if (releaseOwner) store.releasePlatformMaintenance(releaseOwner);
  }
  assert.equal(store.getPlatformMaintenance(), null);
});

test('an included source added after inventory invalidates the temporary checkpoint', async () => {
  const lateFile = path.join(dataDir, 'late-source.txt');
  try {
    await assert.rejects(
      createRecoveryCheckpoint({
        faultInjector(point) {
          if (point === 'after_database') fs.writeFileSync(lateFile, 'created after inventory');
        },
      }),
      /Recovery source changed while checkpointing: data/,
    );
  } finally {
    fs.rmSync(lateFile, { force: true });
  }
  assert.equal(store.getPlatformMaintenance(), null);
  assert.equal(
    fs.readdirSync(RECOVERY_CHECKPOINT_DIR).some((name) => name.startsWith('.creating-')),
    false,
  );
});

test('changes under the Bridge-owned Codex Session home do not enter or invalidate a checkpoint', async () => {
  const liveState = path.join(runtimeSessionDir, 'sessions', 'live-rollout.jsonl');
  try {
    const checkpoint = await createRecoveryCheckpoint({
      faultInjector(point) {
        if (point === 'after_database') {
          fs.mkdirSync(path.dirname(liveState), { recursive: true });
          fs.writeFileSync(liveState, 'changed after inventory');
        }
      },
    });
    const entries = [];
    await tar.list({
      file: path.join(RECOVERY_CHECKPOINT_DIR, checkpoint.id, 'payload.tar.gz'),
      onReadEntry(entry) { entries.push(entry.path.replace(/^\.\//, '').replace(/\/$/, '')); },
    });
    assert.equal(entries.some((entry) => entry.includes('live-rollout.jsonl')), false);
    assert.equal(checkpoint.source.excluded.bridgeCodexSessions, 1);
  } finally {
    fs.rmSync(path.join(runtimeSessionDir, 'sessions'), { recursive: true, force: true });
  }
});

test('retention removes only older published checkpoints after a successful replacement', async () => {
  for (let index = 0; index < 3; index += 1) await createRecoveryCheckpoint({ retention: 2 });
  const checkpoints = listRecoveryCheckpoints();
  assert.equal(checkpoints.length, 2);
  assert.ok(checkpoints.every((checkpoint) => checkpoint.status === 'available'));
  assert.equal(checkpoints.some((checkpoint) => checkpoint.id === firstCheckpoint.id), false);
  const status = recoveryCheckpointStatus();
  assert.equal(status.retentionExcessCount, Math.max(0, status.checkpointCount - status.retention));
  assert.equal(status.retentionSatisfied, true);
});

test('maintenance requires all runtime activity classes to be idle', () => {
  store.saveSession('orphan-activity', {
    name: 'Orphan activity', objective: 'Exercise independent maintenance gates.', workingDir: '.',
  });
  const now = new Date().toISOString();
  const db = getDatabase();
  db.prepare(`
    INSERT INTO external_attempts(
      id, task_id, chain_key, generation, log_path, started_at, created_at, updated_at
    ) VALUES ('external-orphan', 'orphan-activity', 'orphan', 1, '/tmp/external.log', ?, ?, ?)
  `).run(now, now, now);
  db.prepare(`
    INSERT INTO scheduled_jobs(
      id, task_id, generation, sequence, due_at, idempotency_key, created_at, updated_at
    ) VALUES ('schedule-orphan', 'orphan-activity', 1, 1, ?, 'schedule-orphan-key', ?, ?)
  `).run(now, now, now);
  const activity = store.getPlatformActivityCounts();
  assert.equal(activity.externalAttempts, 1);
  assert.equal(activity.scheduledJobs, 1);
  assert.throws(
    () => store.acquirePlatformMaintenance('test_maintenance', 'test:activity', 30000),
    (error) => error.statusCode === 409 && error.activityCounts.externalAttempts === 1,
  );
  db.prepare("DELETE FROM scheduled_jobs WHERE id='schedule-orphan'").run();
  db.prepare("DELETE FROM external_attempts WHERE id='external-orphan'").run();
});

test('maintenance blocks queue and claim paths until its durable lease expires', () => {
  store.saveSession('maintenance-gate', {
    name: 'Maintenance gate', objective: 'Verify queue and command claim behavior.', workingDir: '.',
  });
  store.saveSession('schedule-gate', {
    name: 'Schedule gate', objective: 'Verify scheduled claim behavior.', workingDir: '.',
  });
  const owner = 'test:claim-gates';
  store.acquirePlatformMaintenance('test_maintenance', owner, 30000);
  assert.throws(
    () => store.queueSessionRun('maintenance-gate', 'blocked', 'maintenance-gate-blocked'),
    (error) => error.statusCode === 503,
  );

  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO commands(id, task_id, type, input, idempotency_key, status, created_at)
    VALUES ('maintenance-command', 'maintenance-gate', 'run', 'queued before claim',
      'maintenance-command-key', 'pending', ?)
  `).run(now);
  db.prepare("UPDATE tasks SET status='queued' WHERE id='maintenance-gate'").run();
  const replay = store.queueSessionRun(
    'maintenance-gate',
    'queued before claim',
    'maintenance-command-key',
    {},
    { allowEnqueue: false },
  );
  assert.equal(replay.status, 'queued');
  assert.equal(store.queueSessionRun(
    'maintenance-gate',
    'new request',
    'maintenance-new-key',
    {},
    { allowEnqueue: false },
  ), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM commands WHERE task_id='maintenance-gate'").get().count, 1);
  db.prepare(`
    INSERT INTO scheduled_jobs(
      id, task_id, generation, sequence, due_at, idempotency_key, status, created_at, updated_at
    ) VALUES ('maintenance-schedule', 'schedule-gate', 1, 1, ?,
      'maintenance-schedule-key', 'pending', ?, ?)
  `).run(now, now, now);
  db.prepare("UPDATE tasks SET status='waiting_scheduled' WHERE id='schedule-gate'").run();

  assert.deepEqual(store.claimPendingCommands('maintenance-worker', 10), []);
  assert.deepEqual(store.claimDueScheduledJobs('maintenance-worker', 10), []);

  const lease = JSON.parse(db.prepare("SELECT value FROM metadata WHERE key='platform_maintenance'").get().value);
  lease.expiresAt = '2000-01-01T00:00:00.000Z';
  db.prepare("UPDATE metadata SET value=? WHERE key='platform_maintenance'").run(JSON.stringify(lease));
  assert.equal(store.getPlatformMaintenance(), null);
  assert.deepEqual(store.claimPendingCommands('maintenance-worker', 10).map((command) => command.id), ['maintenance-command']);
  assert.deepEqual(store.claimDueScheduledJobs('maintenance-worker', 10).map((job) => job.id), ['maintenance-schedule']);

  store.releasePlatformMaintenance(owner);
  db.prepare("UPDATE commands SET status='cancelled' WHERE id='maintenance-command'").run();
  db.prepare("UPDATE scheduled_jobs SET status='cancelled' WHERE id='maintenance-schedule'").run();
  db.prepare("UPDATE tasks SET status='stopped' WHERE id IN ('maintenance-gate','schedule-gate')").run();
});

test('maintenance transactionally blocks configuration writes and source refreshes', () => {
  const existingTaskId = 'maintenance-config-existing';
  const managedSkillId = 'maintenance-config-skill';
  store.saveSession(existingTaskId, {
    name: 'Maintenance config', objective: 'Verify transactional configuration gates.', workingDir: '.',
  });
  store.saveSkill(managedSkillId, {
    name: 'Maintenance config Skill', description: 'Must remain unchanged.', content: '# Maintenance config Skill\n',
  });
  const db = getDatabase();
  const auditCount = () => Number(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count);
  const beforeAuditCount = auditCount();
  const sourceSkillDirectory = path.join(sourceHome, 'skills', 'maintenance-lease-source');
  const owner = 'test:configuration-gates';
  store.acquirePlatformMaintenance('test_maintenance', owner, 30000);
  try {
    const blocked = (operation) => assert.throws(
      operation,
      (error) => error.statusCode === 503 && /Platform maintenance is active/.test(error.message),
    );
    blocked(() => store.saveSession('maintenance-config-new', {
      name: 'Blocked task', objective: 'Must not be created.', workingDir: '.',
    }));
    blocked(() => store.saveSession(existingTaskId, { name: 'Blocked rename' }));
    blocked(() => store.deleteSession(existingTaskId));
    blocked(() => store.saveSkill(managedSkillId, { name: 'Blocked Skill rename' }));
    blocked(() => store.setSkillEnabled(managedSkillId, false));
    blocked(() => store.deleteSkill(managedSkillId));
    blocked(() => store.importSkillArchive([{
      id: 'maintenance-archive-skill', name: 'Blocked archive Skill',
      description: 'Must not be imported.', content: '# Blocked archive Skill\n',
    }]));
    blocked(() => store.importConfigBundle({
      format: 'codex-ops-bundle', version: 4, skills: [], sessions: [],
    }));
    blocked(() => store.setCommandExecutionSkills('missing-task', 'missing-command', [], 'Maintenance gate'));

    fs.mkdirSync(sourceSkillDirectory, { recursive: true });
    fs.writeFileSync(path.join(sourceSkillDirectory, 'SKILL.md'), [
      '---',
      'name: Maintenance Lease Source',
      'description: Must not refresh while maintenance is active.',
      '---',
      '# Maintenance Lease Source',
      '',
    ].join('\n'));
    store.refreshSourceSkills(true);
    assert.equal(store.listSkills().some((skill) => skill.name === 'Maintenance Lease Source'), false);
    assert.equal(auditCount(), beforeAuditCount);
    assert.equal(store.getSession(existingTaskId).name, 'Maintenance config');
    assert.equal(store.getSkill(managedSkillId).enabled, true);
  } finally {
    store.releasePlatformMaintenance(owner);
  }

  store.refreshSourceSkills(true);
  assert.equal(store.listSkills().some((skill) => skill.name === 'Maintenance Lease Source'), true);
  fs.rmSync(sourceSkillDirectory, { recursive: true, force: true });
  store.refreshSourceSkills(true);
  store.deleteSession(existingTaskId);
  store.deleteSkill(managedSkillId);
});

test('invalid recovery scheduling configuration fails before service startup', () => {
  for (const [name, value] of [
    ['CODEX_RECOVERY_CHECKPOINT_RETENTION', '0'],
    ['CODEX_RECOVERY_CHECKPOINT_RETENTION', '31'],
    ['CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS', '-1'],
    ['CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS', 'not-a-number'],
  ]) {
    const result = spawnSync(process.execPath, ['-e', "require('./src/recovery-checkpoint')"], {
      cwd: ROOT_DIR,
      env: { ...process.env, [name]: value },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(name));
  }
});

test('recovery checkpoint retention defaults to one package', () => {
  const environment = { ...process.env };
  delete environment.CODEX_RECOVERY_CHECKPOINT_RETENTION;
  const result = spawnSync(
    process.execPath,
    ['-e', "process.stdout.write(String(require('./src/recovery-checkpoint').CHECKPOINT_RETENTION))"],
    {
      cwd: ROOT_DIR,
      env: environment,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '1');
});

test('automatic recovery defers active work, succeeds when idle, and resumes its due time after restart', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data','runtime','backups','workspaces','source-home','workspace-skills']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const store = require('./src/store');",
    "const recovery = require('./src/recovery-checkpoint');",
    "const { closeDatabase } = require('./src/database');",
    "store.saveSession('scheduler-active', { name: 'Scheduler active', objective: 'Block one attempt.', workingDir: '.' });",
    "store.queueSessionRun('scheduler-active', 'hold until deferred', 'scheduler-active-run');",
    "let deferred = null;",
    "let completed = false;",
    "const hold = setTimeout(() => { console.error('recovery scheduler timeout'); process.exit(2); }, 8000);",
    "recovery.startRecoveryCheckpointScheduler({",
    "  onDeferred(info) {",
    "    deferred = info;",
    "    store.requestSessionStop('scheduler-active');",
    "  },",
    "  onSuccess(checkpoint) {",
    "    if (completed) return;",
    "    completed = true;",
    "    recovery.verifyRecoveryCheckpoint(checkpoint.id).then((verification) => {",
    "      const beforeRestart = recovery.recoveryCheckpointStatus();",
    "      recovery.stopRecoveryCheckpointScheduler();",
    "      recovery.startRecoveryCheckpointScheduler({",
    "        onSuccess() { console.error('scheduler duplicated a recent checkpoint'); process.exit(3); },",
    "        onError(error) { console.error(error); process.exit(4); },",
    "      }, { initialDelayMs: 10, retryDelayMs: 20 });",
    "      const afterRestart = recovery.recoveryCheckpointStatus();",
    "      setTimeout(() => {",
    "        recovery.stopRecoveryCheckpointScheduler();",
    "        clearTimeout(hold);",
    "        closeDatabase();",
    "        console.log(JSON.stringify({ deferred, verification, beforeRestart, afterRestart }));",
    "      }, 80);",
    "    }).catch((error) => { console.error(error); process.exit(5); });",
    "  },",
    "  onError(error) { console.error(error); process.exit(6); },",
    "}, { initialDelayMs: 10, retryDelayMs: 30 });",
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
      SOURCE_CODEX_HOME: path.join(schedulerRoot, 'source-home'),
      WORKSPACE_CODEX_SKILLS_DIR: path.join(schedulerRoot, 'workspace-skills'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
      CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '1',
      CODEX_RECOVERY_CHECKPOINT_RETENTION: '2',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.deferred.reason, 'platform_activity');
  assert.equal(output.deferred.activityCounts.tasks, 1);
  assert.equal(output.deferred.activityCounts.commands, 1);
  assert.equal(output.verification.ok, true);
  assert.equal(output.beforeRestart.overdue, false);
  assert.equal(output.beforeRestart.lastDeferredReason, 'platform_activity');
  assert.equal(output.afterRestart.enabled, true);
  assert.equal(output.afterRestart.intervalHours, 1);
  assert.equal(output.afterRestart.overdue, false);
  assert.ok(Date.parse(output.afterRestart.nextRunAt) > Date.now() + (50 * 60 * 1000));
});

test('automatic recovery defers an existing maintenance lease without creating a package', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-maintenance-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data','runtime','backups','workspaces','source-home','workspace-skills']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const store = require('./src/store');",
    "const recovery = require('./src/recovery-checkpoint');",
    "const { closeDatabase } = require('./src/database');",
    "const owner = 'test:automatic-recovery-maintenance';",
    "store.acquirePlatformMaintenance('test_maintenance', owner, 30000);",
    "const hold = setTimeout(() => { console.error('scheduler timeout'); process.exit(2); }, 5000);",
    "recovery.startRecoveryCheckpointScheduler({",
    "  onDeferred(info) {",
    "    const status = recovery.recoveryCheckpointStatus();",
    "    recovery.stopRecoveryCheckpointScheduler();",
    "    store.releasePlatformMaintenance(owner);",
    "    clearTimeout(hold);",
    "    closeDatabase();",
    "    const checkpointDir = path.join(process.env.CODEX_DESK_BACKUP_DIR, 'recovery-checkpoints');",
    "    console.log(JSON.stringify({ info, status, packages: fs.existsSync(checkpointDir) ? fs.readdirSync(checkpointDir) : [] }));",
    "  },",
    "  onSuccess() { console.error('checkpoint ran during maintenance'); process.exit(3); },",
    "  onError(error) { console.error(error); process.exit(4); },",
    "}, { initialDelayMs: 10, retryDelayMs: 100 });",
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
      SOURCE_CODEX_HOME: path.join(schedulerRoot, 'source-home'),
      WORKSPACE_CODEX_SKILLS_DIR: path.join(schedulerRoot, 'workspace-skills'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
      CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '1',
    },
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.info.reason, 'platform_maintenance');
  assert.equal(output.status.lastDeferredReason, 'platform_maintenance');
  assert.ok(Date.parse(output.status.lastDeferredAt) > 0);
  assert.ok(Date.parse(output.status.nextRunAt) > Date.now());
  assert.deepEqual(output.packages, []);
});

test('automatic recovery contains unexpected preflight rejection and keeps its scheduler alive', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-preflight-failure-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data','runtime','backups','workspaces','source-home','workspace-skills']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const storePath = require.resolve('./src/store');",
    "const store = require(storePath);",
    "require.cache[storePath].exports = { ...store, getPlatformMaintenance() { throw new Error('injected recovery preflight failure'); } };",
    "const recovery = require('./src/recovery-checkpoint');",
    "const { closeDatabase } = require('./src/database');",
    "process.once('unhandledRejection', (error) => { console.error(`unhandled: ${error.message}`); process.exit(5); });",
    "const hold = setTimeout(() => { console.error('scheduler timeout'); process.exit(2); }, 5000);",
    "recovery.startRecoveryCheckpointScheduler({",
    "  onSuccess() { console.error('checkpoint unexpectedly succeeded'); process.exit(3); },",
    "  onDeferred() { console.error('preflight failure was misclassified as deferred'); process.exit(4); },",
    "  onError(error) {",
    "    const status = recovery.recoveryCheckpointStatus();",
    "    recovery.stopRecoveryCheckpointScheduler();",
    "    clearTimeout(hold);",
    "    closeDatabase();",
    "    console.log(JSON.stringify({ message: error.message, status }));",
    "  },",
    "}, { initialDelayMs: 10, retryDelayMs: 100 });",
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
      SOURCE_CODEX_HOME: path.join(schedulerRoot, 'source-home'),
      WORKSPACE_CODEX_SKILLS_DIR: path.join(schedulerRoot, 'workspace-skills'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
      CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '1',
    },
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.message, 'injected recovery preflight failure');
  assert.equal(output.status.lastError, 'Automatic recovery checkpoint failed');
  assert.ok(Date.parse(output.status.lastAttemptAt) > 0);
  assert.ok(Date.parse(output.status.lastErrorAt) > 0);
  assert.ok(Date.parse(output.status.nextRunAt) > Date.now());
});

test('restarting the recovery scheduler replaces its pending timer', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-restart-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data','runtime','backups','workspaces','source-home','workspace-skills']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
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
    "const recovery = require('./src/recovery-checkpoint');",
    "recovery.startRecoveryCheckpointScheduler({}, { initialDelayMs: 5000, retryDelayMs: 1000 });",
    "recovery.startRecoveryCheckpointScheduler({}, { initialDelayMs: 6000, retryDelayMs: 2000 });",
    "const activeAfterRestart = timers.size;",
    "const nextRunAt = recovery.recoveryCheckpointStatus().nextRunAt;",
    "recovery.stopRecoveryCheckpointScheduler();",
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
      SOURCE_CODEX_HOME: path.join(schedulerRoot, 'source-home'),
      WORKSPACE_CODEX_SKILLS_DIR: path.join(schedulerRoot, 'workspace-skills'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
      CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.activeAfterRestart, 1);
  assert.equal(output.activeAfterStop, 0);
  assert.ok(Date.parse(output.nextRunAt) > Date.now());
});

test('a manual recovery checkpoint immediately reanchors the automatic due time', () => {
  const schedulerRoot = path.join(tempDir, 'scheduler-manual-child');
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "for (const name of ['data','runtime','backups','workspaces','source-home','workspace-skills']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const recovery = require('./src/recovery-checkpoint');",
    "const { closeDatabase } = require('./src/database');",
    "recovery.startRecoveryCheckpointScheduler({}, { initialDelayMs: 1000, retryDelayMs: 1000 });",
    "const before = recovery.recoveryCheckpointStatus().nextRunAt;",
    "recovery.createRecoveryCheckpoint().then((created) => {",
    "  const after = recovery.recoveryCheckpointStatus().nextRunAt;",
    "  recovery.stopRecoveryCheckpointScheduler();",
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
      SOURCE_CODEX_HOME: path.join(schedulerRoot, 'source-home'),
      WORKSPACE_CODEX_SKILLS_DIR: path.join(schedulerRoot, 'workspace-skills'),
      CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
      CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '1',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.ok(Date.parse(output.after) > Date.parse(output.before) + (50 * 60 * 1000));
  assert.ok(Math.abs(Date.parse(output.after) - Date.parse(output.completedAt) - (60 * 60 * 1000)) < 1000);
});

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHttp(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      await response.arrayBuffer();
      return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

test('HTTP recovery lifecycle works and maintenance returns Retry-After for writes', async () => {
  const serverRoot = path.join(tempDir, 'http-server');
  const serverData = path.join(serverRoot, 'data');
  const serverRuntime = path.join(serverRoot, 'runtime');
  const serverWorkspace = path.join(serverRoot, 'workspace');
  const serverSourceHome = path.join(serverRoot, 'source-home');
  const serverWorkspaceSkills = path.join(serverRoot, 'workspace-skills');
  for (const directory of [serverData, serverRuntime, serverWorkspace, serverSourceHome, serverWorkspaceSkills]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(serverRuntime, 'auth.json'), secret, { mode: 0o600 });
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CODEX_DESK_DATA_DIR: serverData,
      CODEX_DESK_RUNTIME_DIR: serverRuntime,
      CODEX_DESK_BACKUP_DIR: path.join(serverData, 'backups'),
      CODEX_TASK_WORKSPACE_ROOTS: serverWorkspace,
      SOURCE_CODEX_HOME: serverSourceHome,
      WORKSPACE_CODEX_SKILLS_DIR: serverWorkspaceSkills,
      CODEX_DISABLE_WORKER: '1',
      CODEX_ALLOW_ROOT_EXECUTION: '1',
      CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
      CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    await waitForHttp(`${baseUrl}/api/health`);
    let response = await fetch(`${baseUrl}/api/recovery-checkpoints`, { method: 'POST' });
    const createdText = await response.text();
    assert.equal(response.status, 201, `${createdText}\n${output}`);
    const created = JSON.parse(createdText);
    assert.equal(created.ok, true);
    assert.equal(created.auditRecorded, true);
    assert.equal(JSON.stringify(created).includes(secret), false);

    response = await fetch(`${baseUrl}/api/recovery-checkpoints`);
    const listed = await response.json();
    assert.equal(listed.status.enabled, false);
    assert.equal(listed.status.nextRunAt, '');
    assert.equal(listed.status.checkpointCount, 1);
    assert.equal(listed.checkpoints[0].id, created.checkpoint.id);

    response = await fetch(`${baseUrl}/api/recovery-checkpoints/${created.checkpoint.id}/verify`, { method: 'POST' });
    assert.equal(response.status, 200);
    const verified = await response.json();
    assert.equal(verified.ok, true);
    assert.equal(verified.auditRecorded, true);

    const db = new Database(path.join(serverData, 'codex-tasks.db'));
    const backupAudit = db.prepare(`
      SELECT entity_id, payload_json FROM audit_events
      WHERE kind='database.backup.created' AND entity_type='database_backup'
      ORDER BY ts DESC LIMIT 1
    `).get();
    const backupManifest = JSON.parse(fs.readFileSync(path.join(
      serverData,
      'backups',
      backupAudit.entity_id,
      'manifest.json',
    ), 'utf8'));
    assert.equal(JSON.parse(backupAudit.payload_json).sha256, backupManifest.database.sha256);
    assert.notEqual(backupManifest.database.sha256, created.checkpoint.database.sha256);

    const replayCreatedAt = new Date().toISOString();
    const insertReplayTask = db.prepare(`
      INSERT INTO tasks(id, name, objective, working_dir, status, created_at, updated_at)
      VALUES (?, ?, ?, '.', ?, ?, ?)
    `);
    insertReplayTask.run(
      'maintenance-replay-run', 'Maintenance replay run', 'Replay existing run.',
      'queued', replayCreatedAt, replayCreatedAt,
    );
    insertReplayTask.run(
      'maintenance-replay-start', 'Maintenance replay start', 'Replay existing start.',
      'queued', replayCreatedAt, replayCreatedAt,
    );
    insertReplayTask.run(
      'maintenance-replay-stop', 'Maintenance replay stop', 'Replay existing stop.',
      'stopped', replayCreatedAt, replayCreatedAt,
    );
    insertReplayTask.run(
      'maintenance-replay-complete', 'Maintenance replay complete', 'Replay existing completion.',
      'completed', replayCreatedAt, replayCreatedAt,
    );
    db.prepare(`
      INSERT INTO commands(id, task_id, type, input, idempotency_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      'maintenance-replay-run-command', 'maintenance-replay-run', 'run',
      'Replay existing run.', 'maintenance-replay-run-key', replayCreatedAt,
    );
    db.prepare(`
      INSERT INTO commands(id, task_id, type, input, idempotency_key, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      'maintenance-replay-start-command', 'maintenance-replay-start', 'create_run',
      'Replay existing start.', 'maintenance-replay-start-key', replayCreatedAt,
    );
    const insertReceipt = db.prepare(`
      INSERT INTO session_operation_receipts(
        idempotency_key, operation, task_id, task_created_at, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertReceipt.run(
      'maintenance-replay-stop-key', 'stop', 'maintenance-replay-stop', replayCreatedAt,
      JSON.stringify({ ok: true }), replayCreatedAt,
    );
    insertReceipt.run(
      'maintenance-replay-complete-key', 'complete', 'maintenance-replay-complete', replayCreatedAt,
      JSON.stringify({ id: 'maintenance-replay-complete', status: 'completed' }), replayCreatedAt,
    );
    insertReceipt.run(
      'maintenance-replay-delete-key', 'delete', 'maintenance-replay-delete', replayCreatedAt,
      JSON.stringify({ ok: true }), replayCreatedAt,
    );

    const lease = {
      kind: 'test_maintenance',
      owner: 'http:test',
      startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    db.prepare(`
      INSERT INTO metadata(key, value) VALUES ('platform_maintenance', ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(JSON.stringify(lease));

    response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        id: 'blocked-task', name: 'Blocked task', objective: 'Should wait.', workingDir: '.',
      }),
    });
    assert.equal(response.status, 503);
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
    assert.match((await response.json()).error, /Platform maintenance is active/);

    response = await fetch(`${baseUrl}/api/sessions/maintenance-replay-run/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'maintenance-replay-run-key' },
      body: JSON.stringify({ input: 'Replay existing run.' }),
    });
    const runReplayText = await response.text();
    assert.equal(response.status, 202, runReplayText);
    assert.equal(JSON.parse(runReplayText).id, 'maintenance-replay-run');

    response = await fetch(`${baseUrl}/api/sessions/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'maintenance-replay-start-key' },
      body: JSON.stringify({
        id: 'maintenance-replay-start',
        name: 'Maintenance replay start',
        objective: 'Replay existing start.',
        workingDir: '.',
        idempotencyKey: 'maintenance-replay-start-key',
      }),
    });
    const startReplayText = await response.text();
    assert.equal(response.status, 200, startReplayText);
    assert.equal(JSON.parse(startReplayText).id, 'maintenance-replay-start');

    for (const [operation, taskId, key] of [
      ['stop', 'maintenance-replay-stop', 'maintenance-replay-stop-key'],
      ['complete', 'maintenance-replay-complete', 'maintenance-replay-complete-key'],
    ]) {
      response = await fetch(`${baseUrl}/api/sessions/${taskId}/${operation}`, {
        method: 'POST', headers: { 'idempotency-key': key },
      });
      assert.equal(response.status, 200, await response.text());
    }
    response = await fetch(`${baseUrl}/api/sessions/maintenance-replay-delete`, {
      method: 'DELETE', headers: { 'idempotency-key': 'maintenance-replay-delete-key' },
    });
    const deleteReplayText = await response.text();
    assert.equal(response.status, 200, deleteReplayText);
    assert.deepEqual(JSON.parse(deleteReplayText), { ok: true });

    response = await fetch(`${baseUrl}/api/sessions/maintenance-replay-stop`, {
      method: 'DELETE', headers: { 'idempotency-key': 'maintenance-new-delete-key' },
    });
    assert.equal(response.status, 503);
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
    const maintenanceBlocked = await response.json();
    assert.match(maintenanceBlocked.error, /Platform maintenance is active/);
    assert.equal(maintenanceBlocked.maintenance.kind, 'test_maintenance');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE id='maintenance-replay-stop'").get().count,
      1,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM commands WHERE idempotency_key='maintenance-new-run-key'").get().count,
      0,
    );

    response = await fetch(`${baseUrl}/api/recovery-checkpoints`);
    assert.equal(response.status, 200);

    lease.expiresAt = '2000-01-01T00:00:00.000Z';
    db.prepare("UPDATE metadata SET value=? WHERE key='platform_maintenance'").run(JSON.stringify(lease));
    db.close();

    response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'unblocked-task', name: 'Unblocked task', objective: 'Lease expired.', workingDir: '.',
      }),
    });
    assert.equal(response.status, 201, await response.text());
  } finally {
    await stopChild(child);
  }
});

test('published recovery persists its failed audit batch and replays it after service restart', async () => {
  const serverRoot = path.join(tempDir, 'audit-failure-server');
  const serverData = path.join(serverRoot, 'data');
  const serverRuntime = path.join(serverRoot, 'runtime');
  const serverWorkspace = path.join(serverRoot, 'workspace');
  const serverSourceHome = path.join(serverRoot, 'source-home');
  const serverWorkspaceSkills = path.join(serverRoot, 'workspace-skills');
  for (const directory of [serverData, serverRuntime, serverWorkspace, serverSourceHome, serverWorkspaceSkills]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const preload = path.join(ROOT_DIR, 'test', 'fixtures', 'fail-storage-audit-preload.js');
  const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' ');
  let output = '';
  const baseEnvironment = {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      CODEX_DESK_DATA_DIR: serverData,
      CODEX_DESK_RUNTIME_DIR: serverRuntime,
      CODEX_DESK_BACKUP_DIR: path.join(serverData, 'backups'),
      CODEX_TASK_WORKSPACE_ROOTS: serverWorkspace,
      SOURCE_CODEX_HOME: serverSourceHome,
      WORKSPACE_CODEX_SKILLS_DIR: serverWorkspaceSkills,
      CODEX_DISABLE_WORKER: '1',
      CODEX_ALLOW_ROOT_EXECUTION: '1',
      CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
      CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
  };
  const launch = (extraEnvironment = {}) => {
    const processHandle = spawn(process.execPath, ['server.js'], {
      cwd: ROOT_DIR,
      env: { ...baseEnvironment, ...extraEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processHandle.stdout.on('data', (chunk) => { output += chunk; });
    processHandle.stderr.on('data', (chunk) => { output += chunk; });
    return processHandle;
  };
  let child = launch({
    NODE_OPTIONS: nodeOptions,
    CODEX_TEST_STORAGE_AUDIT_KIND: 'recovery.checkpoint.created',
    CODEX_TEST_STORAGE_AUDIT_FAILURES: '1',
  });

  try {
    await waitForHttp(`${baseUrl}/api/health`);
    let response = await fetch(`${baseUrl}/api/recovery-checkpoints`, { method: 'POST' });
    const createdText = await response.text();
    assert.equal(response.status, 201, `${createdText}\n${output}`);
    const created = JSON.parse(createdText);
    assert.equal(created.ok, true);
    assert.equal(created.auditRecorded, false);

    response = await fetch(`${baseUrl}/api/recovery-checkpoints`);
    let listed = await response.json();
    assert.equal(listed.status.auditFailureCount, 1);
    assert.equal(listed.status.unrecordedAuditEventCount, 2);
    assert.equal(listed.status.auditQueueDurable, true);
    assert.match(listed.status.lastAuditError, /audit persistence failed/i);
    assert.equal(listed.checkpoints.some((checkpoint) => checkpoint.id === created.checkpoint.id), true);
    const outboxPath = path.join(serverData, 'storage-audit-outbox.json');
    assert.equal(fs.statSync(outboxPath).mode & 0o777, 0o600);

    let db = new Database(path.join(serverData, 'codex-tasks.db'));
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE kind IN ('database.backup.created', 'recovery.checkpoint.created')
    `).get().count, 0);
    db.close();

    await stopChild(child);
    child = launch();
    await waitForHttp(`${baseUrl}/api/health`);

    response = await fetch(`${baseUrl}/api/recovery-checkpoints`);
    listed = await response.json();
    assert.equal(listed.status.unrecordedAuditEventCount, 0);
    assert.ok(Date.parse(listed.status.lastAuditRecoveryAt) > 0);
    assert.equal(fs.existsSync(outboxPath), false);
    db = new Database(path.join(serverData, 'codex-tasks.db'));
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE kind IN ('database.backup.created', 'recovery.checkpoint.created')
    `).get().count, 2);

    response = await fetch(`${baseUrl}/api/recovery-checkpoints/${created.checkpoint.id}/verify`, { method: 'POST' });
    const verified = await response.json();
    assert.equal(response.status, 200);
    assert.equal(verified.ok, true);
    assert.equal(verified.auditRecorded, true);

    response = await fetch(`${baseUrl}/api/recovery-checkpoints`);
    listed = await response.json();
    assert.equal(listed.status.unrecordedAuditEventCount, 0);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE kind IN (
        'database.backup.created',
        'recovery.checkpoint.created',
        'recovery.checkpoint.verified'
      )
    `).get().count, 3);
    db.close();
    assert.match(output, /Injected storage audit failure/);
  } finally {
    await stopChild(child);
  }
});
