const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { DAY_MS, runCleanup } = require('../bin/media-retention-cleanup');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-media-retention-'));
  const videos = path.join(root, 'project', 'videos');
  const dataDir = path.join(root, 'data');
  const runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(videos, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const dbPath = path.join(dataDir, 'codex-tasks.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, working_dir TEXT NOT NULL);
    CREATE TABLE external_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      working_directory TEXT NOT NULL DEFAULT '',
      configured_working_directory TEXT NOT NULL DEFAULT '',
      archive_status TEXT NOT NULL DEFAULT 'pending',
      archive_verify_status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE skill_report_artifact_jobs (task_id TEXT NOT NULL, status TEXT NOT NULL);
  `);
  db.close();
  return { root, videos, dataDir, runtimeDir, dbPath };
}

function writeRun(videos, name, ageMs, nowMs) {
  const run = path.join(videos, name);
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'clip.mp4'), 'video');
  const mtime = new Date(nowMs - ageMs);
  fs.utimesSync(run, mtime, mtime);
  fs.utimesSync(path.join(run, 'clip.mp4'), mtime, mtime);
  return run;
}

function cleanupFixture(item) {
  fs.rmSync(item.root, { recursive: true, force: true });
}

test('dry run protects active work and leaves all source directories untouched', () => {
  const item = fixture();
  const nowMs = Date.parse('2026-08-24T00:00:00.000Z');
  const activeRoot = path.join(item.root, 'active-project');
  const activeVideos = path.join(activeRoot, 'videos');
  fs.mkdirSync(activeVideos, { recursive: true });
  const activeRun = writeRun(activeVideos, 'active-run', 31 * DAY_MS, nowMs);
  const db = new Database(item.dbPath);
  db.prepare('INSERT INTO tasks(id, status, working_dir) VALUES (?, ?, ?)')
    .run('active-task', 'running', activeRoot);
  db.close();

  try {
    const result = runCleanup({
      roots: [item.videos, activeVideos],
      dataDir: item.dataDir,
      runtimeDir: item.runtimeDir,
      backupDir: path.join(item.dataDir, 'backups'),
      dbPath: item.dbPath,
      auditPath: path.join(item.runtimeDir, 'audit.ndjson'),
      lockPath: path.join(item.runtimeDir, 'cleanup.lock'),
      nowMs,
    });
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.roots[0].candidateCount, 0);
    assert.equal(result.roots[1].skipped[0].reason, 'active_or_pending_reference');
    assert.equal(fs.existsSync(activeRun), true);
  } finally {
    cleanupFixture(item);
  }
});

test('apply moves old runs to quarantine and purges only after the quarantine window', () => {
  const item = fixture();
  const nowMs = Date.parse('2026-08-24T00:00:00.000Z');
  const oldRun = writeRun(item.videos, 'old-run', 31 * DAY_MS, nowMs);
  const standard = path.join(item.videos, 'standard_videos');
  fs.mkdirSync(standard, { recursive: true });
  fs.writeFileSync(path.join(standard, 'fixture.mp4'), 'fixture');
  const auditPath = path.join(item.runtimeDir, 'audit.ndjson');
  const lockPath = path.join(item.runtimeDir, 'cleanup.lock');

  try {
    const first = runCleanup({
      roots: [item.videos],
      dataDir: item.dataDir,
      runtimeDir: item.runtimeDir,
      backupDir: path.join(item.dataDir, 'backups'),
      dbPath: item.dbPath,
      auditPath,
      lockPath,
      nowMs,
      apply: true,
    });
    assert.equal(first.ok, true);
    assert.equal(first.quarantined.length, 1);
    assert.equal(fs.existsSync(oldRun), false);
    assert.equal(fs.existsSync(standard), true);

    const second = runCleanup({
      roots: [item.videos],
      dataDir: item.dataDir,
      runtimeDir: item.runtimeDir,
      backupDir: path.join(item.dataDir, 'backups'),
      dbPath: item.dbPath,
      auditPath,
      lockPath,
      nowMs: nowMs + 4 * DAY_MS,
      apply: true,
    });
    assert.equal(second.deleted.length, 1);
    assert.equal(fs.readdirSync(path.join(item.videos, '.retention-quarantine')).length, 0);
    assert.match(fs.readFileSync(auditPath, 'utf8'), /"action":"quarantined"/);
    assert.match(fs.readFileSync(auditPath, 'utf8'), /"action":"deleted"/);
  } finally {
    cleanupFixture(item);
  }
});

test('rejects roots that overlap platform storage', () => {
  const item = fixture();
  try {
    assert.throws(
      () => runCleanup({
        roots: [item.dataDir],
        dataDir: item.dataDir,
        runtimeDir: item.runtimeDir,
        backupDir: path.join(item.dataDir, 'backups'),
        dbPath: item.dbPath,
        auditPath: path.join(item.runtimeDir, 'audit.ndjson'),
        lockPath: path.join(item.runtimeDir, 'cleanup.lock'),
      }),
      (error) => error.code === 'MEDIA_RETENTION_CONFIG',
    );
  } finally {
    cleanupFixture(item);
  }
});
