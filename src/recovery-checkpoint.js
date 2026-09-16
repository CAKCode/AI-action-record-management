const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const tar = require('tar');
const {
  DATA_DIR,
  DB_FILE,
  RUNTIME_DIR,
  BACKUP_DIR,
  RECOVERY_CHECKPOINT_DIR,
} = require('./paths');
const {
  createDatabaseBackup,
  copyDatabaseBackupFile,
  databaseBackupStatus,
} = require('./database-backup');
const {
  acquirePlatformMaintenance,
  getPlatformActivityCounts,
  getPlatformMaintenance,
  renewPlatformMaintenance,
  releasePlatformMaintenance,
} = require('./store');
const {
  MIN_FREE_BYTES,
  MIN_FREE_PERCENT,
  capacityTarget,
} = require('./storage-capacity');

const CHECKPOINT_FORMAT = 'codex-task-platform.recovery-checkpoint';
const CHECKPOINT_VERSION = 1;
const DEFAULT_RETENTION = 1;
const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1000;
const CHECKPOINT_ID_PATTERN = /^recovery-\d{8}T\d{9}Z-[a-f0-9]{8}$/;
const BACKUP_ID_PATTERN = /^db-\d{8}T\d{9}Z-[a-f0-9]{8}$/;
const PACKAGE_FILES = new Set(['database.db', 'payload.tar.gz', 'manifest.json']);
const MAX_ARCHIVE_ENTRIES = 100000;
const MAINTENANCE_TTL_MS = 600000;
const MAINTENANCE_RENEW_MS = 30000;
const EXCLUDED_COUNT_KEYS = [
  'symlinks',
  'specialFiles',
  'databaseRuntime',
  'backupRecursive',
  'legacyMigration',
  'bridgeCodexSessions',
  'platformReportArtifacts',
  'runtimeLocks',
  'runtimeTemp',
  'stagedTemporary',
];
const REQUIRED_LEGACY_EXCLUDED_COUNT_KEYS = [
  'symlinks',
  'specialFiles',
  'databaseRuntime',
  'backupRecursive',
  'runtimeLocks',
  'runtimeTemp',
  'stagedTemporary',
];
const CHECKPOINT_COVERAGE = Object.freeze({
  sqliteDatabase: true,
  platformDataFiles: true,
  platformRuntimeFiles: true,
  taskWorkingDirectories: false,
  externallyLocatedLogs: false,
});
const COUNT_TABLES = [
  'tasks',
  'turns',
  'attempts',
  'task_steps',
  'step_runs',
  'external_attempts',
  'scheduled_jobs',
  'commands',
  'command_executions',
  'skill_invocations',
  'skill_reports',
  'skill_report_artifacts',
  'skill_report_artifact_resources',
  'skill_report_artifact_media_views',
  'skill_report_artifact_jobs',
  'worklog_events',
  'audit_events',
  'skills',
];
const REQUIRED_LEGACY_COUNT_TABLES = [
  'tasks',
  'turns',
  'attempts',
  'external_attempts',
  'scheduled_jobs',
  'commands',
  'command_executions',
  'worklog_events',
  'audit_events',
  'skills',
];

function integerSetting(name, fallback, minimum, maximum) {
  const raw = String(process.env[name] ?? fallback).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const CHECKPOINT_RETENTION = integerSetting(
  'CODEX_RECOVERY_CHECKPOINT_RETENTION',
  DEFAULT_RETENTION,
  1,
  30,
);
const CHECKPOINT_INTERVAL_HOURS = integerSetting(
  'CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS',
  DEFAULT_INTERVAL_HOURS,
  0,
  8760,
);

let checkpointInFlight = null;
let schedulerTimer = null;
let schedulerStopped = true;
let schedulerGeneration = 0;
let schedulerRetryDelayMs = DEFAULT_RETRY_DELAY_MS;
let schedulerCallbacks = {};
let schedulerState = {
  lastAttemptAt: '',
  lastSuccessAt: '',
  lastDeferredAt: '',
  lastDeferredReason: '',
  nextRunAt: '',
};
let lastCheckpointErrorAt = '';
let lastCheckpointError = '';

function statusError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Recovery checkpoint storage is invalid');
  fs.chmodSync(directory, 0o700);
}

function syncPath(targetPath) {
  let fd;
  try {
    fd = fs.openSync(targetPath, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function removeSqliteSidecars(filePath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      const sidecar = `${filePath}${suffix}`;
      const stat = fs.lstatSync(sidecar);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(sidecar);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function writePrivateJson(filePath, value) {
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(filePath, 0o600);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function checkpointId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  return `recovery-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function canonicalCheckpointId(value) {
  const id = String(value || '');
  if (!CHECKPOINT_ID_PATTERN.test(id)) throw statusError('Invalid recovery checkpoint id', 400);
  return id;
}

function packagePaths(id, checkpointDirectory = RECOVERY_CHECKPOINT_DIR) {
  const normalizedId = canonicalCheckpointId(id);
  const directory = path.join(checkpointDirectory, normalizedId);
  return {
    id: normalizedId,
    directory,
    database: path.join(directory, 'database.db'),
    archive: path.join(directory, 'payload.tar.gz'),
    manifest: path.join(directory, 'manifest.json'),
  };
}

function normalizeArchivePath(value) {
  const original = String(value || '');
  if (!original || original.includes('\0') || original.includes('\\') || path.posix.isAbsolute(original)) {
    throw new Error('Recovery archive contains an unsafe path');
  }
  const parts = original.replace(/^\.\//, '').replace(/\/$/, '').split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Recovery archive contains path traversal');
  }
  const normalized = parts.join('/');
  if (parts[0] !== 'data' && parts[0] !== 'runtime') {
    throw new Error('Recovery archive entry is outside the supported roots');
  }
  return normalized;
}

function relativeBackupPrefix() {
  const relative = path.relative(DATA_DIR, BACKUP_DIR);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative)
    ? ''
    : relative.split(path.sep).join('/');
}

function excludedSourcePath(role, relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  if (role === 'data') {
    if (['codex-tasks.db', 'codex-tasks.db-wal', 'codex-tasks.db-shm', 'codex-tasks.db-journal'].includes(normalized)) {
      return 'database_runtime';
    }
    const backupPrefix = relativeBackupPrefix();
    if (backupPrefix && (normalized === backupPrefix || normalized.startsWith(`${backupPrefix}/`))) return 'backup_recursive';
    if (normalized === 'agents' || normalized.startsWith('agents/')) return 'legacy_migration';
    if (/^sessions\/[^/]+\/skill-report-artifacts(?:\/|$)/.test(normalized)) return 'platform_report_artifacts';
  }
  if (role === 'runtime') {
    if (normalized === 'bridge-sessions/.bridge-codex-home/sessions'
      || normalized.startsWith('bridge-sessions/.bridge-codex-home/sessions/')) return 'bridge_codex_session';
    if (normalized === 'bridge-sessions/locks' || normalized.startsWith('bridge-sessions/locks/')) return 'runtime_lock';
    if (normalized === 'web-supervisor.lock' || normalized.startsWith('web-supervisor.lock/')) return 'runtime_lock';
    if (normalized === 'web-launcher.lock' || normalized.startsWith('web-launcher.lock/')) return 'runtime_lock';
    if (/^bridge-sessions\/\.bridge-codex-home\/sessions\/[^/]+\/tmp(?:\/|$)/.test(normalized)) return 'runtime_temp';
  }
  if (normalized.split('/').some((part) => /^\..+\.(?:materializing|stale|deleting)-/.test(part))) {
    return 'staged_temporary';
  }
  return '';
}

function fingerprint(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function directoryIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
  };
}

function collectInventory() {
  const entries = [];
  const excluded = {
    symlinks: 0,
    specialFiles: 0,
    databaseRuntime: 0,
    backupRecursive: 0,
    legacyMigration: 0,
    bridgeCodexSessions: 0,
    platformReportArtifacts: 0,
    runtimeLocks: 0,
    runtimeTemp: 0,
    stagedTemporary: 0,
  };
  const roots = [
    { role: 'data', directory: DATA_DIR },
    { role: 'runtime', directory: RUNTIME_DIR },
  ];
  const visit = (root, absolutePath, relativePath = '') => {
    const exclusion = relativePath ? excludedSourcePath(root.role, relativePath) : '';
    if (exclusion) {
      const key = {
        database_runtime: 'databaseRuntime',
        backup_recursive: 'backupRecursive',
        legacy_migration: 'legacyMigration',
        bridge_codex_session: 'bridgeCodexSessions',
        platform_report_artifacts: 'platformReportArtifacts',
        runtime_lock: 'runtimeLocks',
        runtime_temp: 'runtimeTemp',
        staged_temporary: 'stagedTemporary',
      }[exclusion];
      excluded[key] += 1;
      return false;
    }
    const stat = fs.lstatSync(absolutePath, { bigint: true });
    if (stat.isSymbolicLink()) {
      excluded.symlinks += 1;
      return false;
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      excluded.specialFiles += 1;
      return false;
    }
    const archivePath = relativePath
      ? `${root.role}/${relativePath.split(path.sep).join('/')}`
      : root.role;
    const entry = {
      role: root.role,
      relativePath,
      archivePath,
      absolutePath,
      type: stat.isDirectory() ? 'Directory' : 'File',
      size: stat.isFile() ? Number(stat.size) : 0,
      fingerprint: fingerprint(stat),
      directoryIdentity: stat.isDirectory() ? directoryIdentity(stat) : null,
      includedChildren: [],
    };
    entries.push(entry);
    if (!stat.isDirectory()) return true;
    for (const item of fs.readdirSync(absolutePath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelativePath = relativePath ? path.join(relativePath, item.name) : item.name;
      if (visit(root, path.join(absolutePath, item.name), childRelativePath)) {
        entry.includedChildren.push(item.name);
      }
    }
    return true;
  };
  for (const root of roots) visit(root, root.directory);
  const files = entries.filter((entry) => entry.type === 'File');
  return {
    entries,
    excluded,
    fileCount: files.length,
    directoryCount: entries.length - files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
  };
}

function assertInventoryStable(inventory) {
  for (const entry of inventory.entries) {
    let current;
    try {
      current = fs.lstatSync(entry.absolutePath, { bigint: true });
    } catch {
      throw new Error(`Recovery source changed while checkpointing: ${entry.archivePath}`);
    }
    const stable = entry.type === 'File'
      ? JSON.stringify(fingerprint(current)) === JSON.stringify(entry.fingerprint)
      : current.isDirectory()
        && JSON.stringify(directoryIdentity(current)) === JSON.stringify(entry.directoryIdentity);
    if (!stable) {
      throw new Error(`Recovery source changed while checkpointing: ${entry.archivePath}`);
    }
    if (entry.type !== 'Directory') continue;
    const includedChildren = [];
    for (const item of fs.readdirSync(entry.absolutePath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelativePath = entry.relativePath
        ? path.join(entry.relativePath, item.name)
        : item.name;
      if (excludedSourcePath(entry.role, childRelativePath)) continue;
      let childStat;
      try {
        childStat = fs.lstatSync(path.join(entry.absolutePath, item.name));
      } catch {
        throw new Error(`Recovery source changed while checkpointing: ${entry.archivePath}`);
      }
      if (childStat.isFile() || childStat.isDirectory()) includedChildren.push(item.name);
    }
    if (JSON.stringify(includedChildren) !== JSON.stringify(entry.includedChildren)) {
      throw new Error(`Recovery source changed while checkpointing: ${entry.archivePath}`);
    }
  }
}

function assertCheckpointCapacity(estimatedBytes) {
  const capacity = capacityTarget('backup', RECOVERY_CHECKPOINT_DIR);
  if (capacity.status === 'unavailable') throw statusError('Recovery checkpoint storage is unavailable', 507);
  const projectedBytes = capacity.availableBytes - estimatedBytes;
  const projectedPercent = capacity.totalBytes > 0 ? (projectedBytes / capacity.totalBytes) * 100 : 0;
  if (projectedBytes < MIN_FREE_BYTES || projectedPercent < MIN_FREE_PERCENT) {
    throw statusError('Insufficient storage capacity for a recovery checkpoint', 507);
  }
}

async function createPayloadArchive(archivePath, stagingDirectory, inventory) {
  const allowed = new Set(inventory.entries.map((entry) => entry.archivePath));
  fs.symlinkSync(DATA_DIR, path.join(stagingDirectory, 'data'), 'dir');
  fs.symlinkSync(RUNTIME_DIR, path.join(stagingDirectory, 'runtime'), 'dir');
  await tar.create({
    cwd: stagingDirectory,
    file: archivePath,
    gzip: { level: 6 },
    follow: true,
    strict: true,
    filter(entryPath) {
      try { return allowed.has(normalizeArchivePath(entryPath)); } catch { return false; }
    },
  }, ['data', 'runtime']);
  fs.chmodSync(archivePath, 0o600);
  syncPath(archivePath);
}

function archiveEntryDigest(entries) {
  const hash = crypto.createHash('sha256');
  for (const entry of entries) {
    hash.update(`${entry.type}\0${entry.path}\0${entry.size}\0${entry.mode}\0${entry.mtime}\n`);
  }
  return hash.digest('hex');
}

async function inspectPayloadArchive(archivePath) {
  const entries = [];
  const seen = new Set();
  await tar.list({
    file: archivePath,
    strict: true,
    maxDecompressionRatio: 1000,
    onReadEntry(entry) {
      if (entries.length >= MAX_ARCHIVE_ENTRIES) throw new Error('Recovery archive contains too many entries');
      const entryPath = normalizeArchivePath(entry.path);
      if (seen.has(entryPath)) throw new Error('Recovery archive contains duplicate paths');
      if (!['File', 'Directory'].includes(entry.type)) throw new Error('Recovery archive contains a link or special file');
      seen.add(entryPath);
      entries.push({
        path: entryPath,
        type: entry.type,
        size: entry.type === 'File' ? Number(entry.size || 0) : 0,
        mode: Number(entry.mode || 0) & 0o777,
        mtime: entry.mtime instanceof Date ? entry.mtime.toISOString() : '',
      });
    },
  });
  if (!seen.has('data') || !seen.has('runtime')) throw new Error('Recovery archive is missing a required root');
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const files = entries.filter((entry) => entry.type === 'File');
  return {
    entryCount: entries.length,
    fileCount: files.length,
    directoryCount: entries.length - files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
    inventorySha256: archiveEntryDigest(entries),
  };
}

function inspectCheckpointDatabase(filePath) {
  let db;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    const quickCheck = db.pragma('quick_check', { simple: true });
    const foreignKeyViolations = db.pragma('foreign_key_check').length;
    const metadataExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get();
    const maintenanceLeaseCount = metadataExists
      ? Number(db.prepare("SELECT COUNT(*) AS count FROM metadata WHERE key='platform_maintenance'").get().count)
      : 0;
    const tableCounts = {};
    for (const table of COUNT_TABLES) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      tableCounts[table] = exists ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count) : 0;
    }
    return {
      ok: quickCheck === 'ok' && foreignKeyViolations === 0 && maintenanceLeaseCount === 0,
      quickCheck,
      foreignKeyViolations,
      maintenanceLeaseCount,
      tableCounts,
    };
  } finally {
    db?.close();
    removeSqliteSidecars(filePath);
  }
}

function clearCheckpointMaintenanceLease(filePath) {
  let db;
  try {
    db = new Database(filePath, { fileMustExist: true });
    db.pragma('journal_mode = DELETE');
    db.transaction(() => {
      const metadataExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get();
      if (metadataExists) db.prepare("DELETE FROM metadata WHERE key='platform_maintenance'").run();
    }).immediate();
  } finally {
    db?.close();
    removeSqliteSidecars(filePath);
  }
  syncPath(filePath);
}

function inspectCheckpointDatabaseWithoutMutation(filePath, checkpointDirectory) {
  ensurePrivateDirectory(checkpointDirectory);
  const scratchDirectory = path.join(
    checkpointDirectory,
    `.verifying-${process.pid}-${crypto.randomUUID()}`,
  );
  const scratchDatabase = path.join(scratchDirectory, 'database.db');
  fs.mkdirSync(scratchDirectory, { mode: 0o700 });
  try {
    fs.copyFileSync(filePath, scratchDatabase, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(scratchDatabase, 0o600);
    return inspectCheckpointDatabase(scratchDatabase);
  } finally {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validDeclaredCounts(value, requiredKeys, allowedKeys) {
  return isRecord(value)
    && requiredKeys.every((key) => validCount(value[key]))
    && Object.entries(value).every(([key, count]) => allowedKeys.includes(key) && validCount(count));
}

function declaredCountsMatch(actual, declared) {
  return Object.entries(declared).every(([key, count]) => actual[key] === count);
}

function selectedCounts(value, keys) {
  return Object.fromEntries(keys
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .map((key) => [key, Number(value[key])]));
}

function readManifest(directory, expectedId) {
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('Invalid checkpoint directory');
  const manifestPath = path.join(directory, 'manifest.json');
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Invalid checkpoint manifest');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.format !== CHECKPOINT_FORMAT || manifest?.version !== CHECKPOINT_VERSION || manifest?.id !== expectedId) {
    throw new Error('Unsupported checkpoint manifest');
  }
  const database = manifest.database;
  const archive = manifest.archive;
  const source = manifest.source;
  const coverage = manifest.coverage;
  if (!Number.isFinite(Date.parse(manifest.createdAt)) || !Number.isFinite(Date.parse(manifest.completedAt))
    || !validCount(manifest.durationMs) || manifest.sensitive !== true
    || !isRecord(database) || !BACKUP_ID_PATTERN.test(String(database.backupId || ''))
    || !validCount(database.sizeBytes) || !/^[a-f0-9]{64}$/.test(String(database.sha256 || ''))
    || database.quickCheck !== 'ok' || database.foreignKeyViolations !== 0
    || database.maintenanceLeaseCount !== 0 || database.maintenanceLeaseCleared !== true
    || !validDeclaredCounts(database.tableCounts, REQUIRED_LEGACY_COUNT_TABLES, COUNT_TABLES)
    || !isRecord(archive) || !validCount(archive.sizeBytes)
    || !/^[a-f0-9]{64}$/.test(String(archive.sha256 || ''))
    || !/^[a-f0-9]{64}$/.test(String(archive.inventorySha256 || ''))
    || !validCount(archive.entryCount) || !validCount(archive.fileCount)
    || !validCount(archive.directoryCount) || !validCount(archive.totalBytes)
    || archive.entryCount !== archive.fileCount + archive.directoryCount
    || !isRecord(source) || !validCount(source.fileCount) || !validCount(source.directoryCount)
    || !validCount(source.totalBytes)
    || !validDeclaredCounts(source.excluded, REQUIRED_LEGACY_EXCLUDED_COUNT_KEYS, EXCLUDED_COUNT_KEYS)
    || source.fileCount !== archive.fileCount || source.directoryCount !== archive.directoryCount
    || source.totalBytes !== archive.totalBytes
    || !isRecord(coverage)
    || Object.entries(CHECKPOINT_COVERAGE).some(([key, expected]) => coverage[key] !== expected)) {
    throw new Error('Invalid checkpoint manifest fields');
  }
  return manifest;
}

function publicManifest(manifest) {
  return {
    format: manifest.format,
    version: manifest.version,
    id: manifest.id,
    createdAt: manifest.createdAt,
    completedAt: manifest.completedAt,
    durationMs: manifest.durationMs,
    sensitive: true,
    database: {
      backupId: manifest.database.backupId,
      sizeBytes: manifest.database.sizeBytes,
      sha256: manifest.database.sha256,
      quickCheck: manifest.database.quickCheck,
      foreignKeyViolations: manifest.database.foreignKeyViolations,
      maintenanceLeaseCount: manifest.database.maintenanceLeaseCount,
      maintenanceLeaseCleared: manifest.database.maintenanceLeaseCleared,
      tableCounts: selectedCounts(manifest.database.tableCounts, COUNT_TABLES),
    },
    archive: {
      sizeBytes: manifest.archive.sizeBytes,
      sha256: manifest.archive.sha256,
      entryCount: manifest.archive.entryCount,
      fileCount: manifest.archive.fileCount,
      directoryCount: manifest.archive.directoryCount,
      totalBytes: manifest.archive.totalBytes,
      inventorySha256: manifest.archive.inventorySha256,
    },
    source: {
      fileCount: manifest.source.fileCount,
      directoryCount: manifest.source.directoryCount,
      totalBytes: manifest.source.totalBytes,
      excluded: selectedCounts(manifest.source.excluded, EXCLUDED_COUNT_KEYS),
    },
    coverage: { ...CHECKPOINT_COVERAGE },
  };
}

function listRecoveryCheckpoints(options = {}) {
  const checkpointDirectory = options.checkpointDirectory || RECOVERY_CHECKPOINT_DIR;
  let entries;
  try {
    const stat = fs.lstatSync(checkpointDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    entries = fs.readdirSync(checkpointDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !CHECKPOINT_ID_PATTERN.test(entry.name)) continue;
    try {
      records.push({ ...publicManifest(readManifest(path.join(checkpointDirectory, entry.name), entry.name)), status: 'available' });
    } catch {
      records.push({ id: entry.name, status: 'invalid' });
    }
  }
  return records.sort((left, right) => String(right.createdAt || right.id).localeCompare(String(left.createdAt || left.id)));
}

function rotateRecoveryCheckpoints(checkpointDirectory, retention) {
  const records = listRecoveryCheckpoints({ checkpointDirectory }).filter((record) => record.status === 'available');
  const removed = [];
  for (const record of records.slice(retention)) {
    const target = packagePaths(record.id, checkpointDirectory).directory;
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(record.id);
  }
  if (removed.length) syncPath(checkpointDirectory);
  return removed;
}

function cleanupInterruptedCheckpoints(checkpointDirectory) {
  for (const entry of fs.readdirSync(checkpointDirectory, { withFileTypes: true })) {
    if (!entry.name.startsWith('.creating-')) continue;
    const target = path.join(checkpointDirectory, entry.name);
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }
}

async function performRecoveryCheckpoint(options = {}) {
  const retention = options.retention ?? CHECKPOINT_RETENTION;
  if (!Number.isInteger(retention) || retention < 1 || retention > 30) {
    throw statusError('Recovery checkpoint retention must be between 1 and 30', 400);
  }
  ensurePrivateDirectory(BACKUP_DIR);
  ensurePrivateDirectory(RECOVERY_CHECKPOINT_DIR);
  const owner = `recovery:${process.pid}:${crypto.randomUUID()}`;
  const maintenanceLease = acquirePlatformMaintenance('recovery_checkpoint', owner, MAINTENANCE_TTL_MS);
  let maintenanceLeaseExpiresAt = maintenanceLease.expiresAt;
  let leaseLost = null;
  let snapshottingDatabase = false;
  const renewalTimer = setInterval(() => {
    if (snapshottingDatabase) return;
    try {
      const renewed = renewPlatformMaintenance(owner, MAINTENANCE_TTL_MS);
      if (!renewed) leaseLost = new Error('Recovery checkpoint maintenance lease was lost');
      else maintenanceLeaseExpiresAt = renewed.expiresAt;
    } catch (error) {
      leaseLost = error;
    }
  }, MAINTENANCE_RENEW_MS);
  renewalTimer.unref();
  const assertLease = () => {
    if (leaseLost) throw leaseLost;
    const renewed = renewPlatformMaintenance(owner, MAINTENANCE_TTL_MS);
    if (!renewed) throw new Error('Recovery checkpoint maintenance lease was lost');
    maintenanceLeaseExpiresAt = renewed.expiresAt;
  };
  let checkpointError = null;
  let publishedResult = null;

  try {
    const startedAtMs = Date.now();
    const createdAt = new Date(startedAtMs).toISOString();
    cleanupInterruptedCheckpoints(RECOVERY_CHECKPOINT_DIR);
    const inventory = collectInventory();
    const databaseSize = fs.statSync(DB_FILE).size;
    assertCheckpointCapacity(inventory.totalBytes + (databaseSize * 2) + (4 * 1024 * 1024));
    options.faultInjector?.('after_inventory');
    assertLease();

    let databaseBackup;
    snapshottingDatabase = true;
    try {
      databaseBackup = await createDatabaseBackup({ maintenanceOwner: owner });
    } finally {
      snapshottingDatabase = false;
    }
    // The snapshot must complete within the initial maintenance window. Renew
    // only after it returns so lease writes cannot make SQLite chase its WAL.
    assertLease();
    const id = checkpointId(new Date(startedAtMs));
    const finalPaths = packagePaths(id);
    const temporaryDirectory = path.join(RECOVERY_CHECKPOINT_DIR, `.creating-${id}-${crypto.randomUUID()}`);
    const temporaryDatabase = path.join(temporaryDirectory, 'database.db');
    const temporaryArchive = path.join(temporaryDirectory, 'payload.tar.gz');
    const temporaryManifest = path.join(temporaryDirectory, 'manifest.json');
    const stagingDirectory = path.join(temporaryDirectory, '.archive-roots');
    let published = false;

    try {
      fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
      fs.mkdirSync(stagingDirectory, { mode: 0o700 });
      const copiedDatabase = await copyDatabaseBackupFile(databaseBackup.id, temporaryDatabase);
      clearCheckpointMaintenanceLease(temporaryDatabase);
      const databaseInspection = inspectCheckpointDatabase(temporaryDatabase);
      if (!databaseInspection.ok) throw new Error('Recovery checkpoint database failed consistency checks');
      const databaseStat = fs.lstatSync(temporaryDatabase);
      const databaseSha256 = await hashFile(temporaryDatabase);
      options.faultInjector?.('after_database');
      assertLease();
      await createPayloadArchive(temporaryArchive, stagingDirectory, inventory);
      fs.rmSync(stagingDirectory, { recursive: true, force: true });
      assertInventoryStable(inventory);
      const archiveInspection = await inspectPayloadArchive(temporaryArchive);
      if (archiveInspection.fileCount !== inventory.fileCount
        || archiveInspection.directoryCount !== inventory.directoryCount
        || archiveInspection.totalBytes !== inventory.totalBytes) {
        throw new Error('Recovery archive inventory does not match its sources');
      }
      const archiveStat = fs.lstatSync(temporaryArchive);
      const archiveSha256 = await hashFile(temporaryArchive);
      options.faultInjector?.('after_archive');
      assertLease();

      const completedAtMs = Date.now();
      const manifest = {
        format: CHECKPOINT_FORMAT,
        version: CHECKPOINT_VERSION,
        id,
        createdAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
        sensitive: true,
        database: {
          backupId: copiedDatabase.id,
          sizeBytes: databaseStat.size,
          sha256: databaseSha256,
          quickCheck: databaseInspection.quickCheck,
          foreignKeyViolations: databaseInspection.foreignKeyViolations,
          maintenanceLeaseCount: databaseInspection.maintenanceLeaseCount,
          maintenanceLeaseCleared: true,
          tableCounts: databaseInspection.tableCounts,
        },
        archive: {
          sizeBytes: archiveStat.size,
          sha256: archiveSha256,
          ...archiveInspection,
        },
        source: {
          fileCount: inventory.fileCount,
          directoryCount: inventory.directoryCount,
          totalBytes: inventory.totalBytes,
          excluded: inventory.excluded,
        },
        coverage: { ...CHECKPOINT_COVERAGE },
      };
      writePrivateJson(temporaryManifest, manifest);
      fs.chmodSync(temporaryDatabase, 0o600);
      fs.chmodSync(temporaryArchive, 0o600);
      syncPath(temporaryDirectory);
      options.faultInjector?.('before_publish');
      assertLease();
      fs.renameSync(temporaryDirectory, finalPaths.directory);
      published = true;
      syncPath(RECOVERY_CHECKPOINT_DIR);
      const removedCheckpointIds = rotateRecoveryCheckpoints(RECOVERY_CHECKPOINT_DIR, retention);
      lastCheckpointErrorAt = '';
      lastCheckpointError = '';
      publishedResult = {
        ...publicManifest(manifest),
        status: 'available',
        retention,
        removedCheckpointIds,
      };
      return publishedResult;
    } catch (error) {
      if (!published) {
        try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); } catch {}
      }
      throw error;
    }
  } catch (error) {
    checkpointError = error;
    if (!checkpointDeferralReason(error)) {
      lastCheckpointErrorAt = new Date().toISOString();
      lastCheckpointError = 'Recovery checkpoint creation failed';
    }
    throw error;
  } finally {
    clearInterval(renewalTimer);
    try {
      (options.releaseMaintenance || releasePlatformMaintenance)(owner);
    } catch (releaseError) {
      if (checkpointError) {
        console.error(`[recovery-checkpoint] maintenance release failed after checkpoint error: ${releaseError.message}`);
      } else {
        lastCheckpointErrorAt = new Date().toISOString();
        lastCheckpointError = 'Recovery checkpoint published; maintenance release could not be confirmed';
        if (publishedResult) {
          publishedResult.maintenanceReleaseUnconfirmed = true;
          publishedResult.maintenanceLeaseExpiresAt = maintenanceLeaseExpiresAt;
        }
        console.error(`[recovery-checkpoint] published checkpoint maintenance release could not be confirmed: ${releaseError.message}`);
      }
    }
  }
}

function createRecoveryCheckpoint(options = {}) {
  if (checkpointInFlight) throw statusError('A recovery checkpoint is already in progress', 409);
  checkpointInFlight = performRecoveryCheckpoint(options)
    .then((result) => {
      if (!schedulerStopped && CHECKPOINT_INTERVAL_HOURS > 0) {
        schedulerState.lastSuccessAt = result.completedAt;
        const dueAt = Date.parse(result.completedAt) + (CHECKPOINT_INTERVAL_HOURS * 60 * 60 * 1000);
        scheduleAutomaticRecoveryCheckpoint(Math.max(1, dueAt - Date.now()), schedulerGeneration);
      }
      return result;
    })
    .finally(() => {
      checkpointInFlight = null;
    });
  return checkpointInFlight;
}

async function verifyRecoveryCheckpoint(value, options = {}) {
  const checkpointDirectory = options.checkpointDirectory || RECOVERY_CHECKPOINT_DIR;
  const paths = packagePaths(value, checkpointDirectory);
  if (!fs.existsSync(paths.directory)) throw statusError(`Recovery checkpoint ${paths.id} not found`, 404);
  let manifest;
  try {
    manifest = readManifest(paths.directory, paths.id);
  } catch {
    throw statusError('Recovery checkpoint manifest is invalid', 409);
  }
  let packageLayout = false;
  let permissions = false;
  let databaseInspection = null;
  let archiveInspection = null;
  let databaseSize = null;
  let archiveSize = null;
  let databaseSha256 = '';
  let archiveSha256 = '';
  let error = '';
  try {
    const names = fs.readdirSync(paths.directory).sort();
    packageLayout = names.length === PACKAGE_FILES.size && names.every((name) => PACKAGE_FILES.has(name));
    const directoryStat = fs.lstatSync(paths.directory);
    const databaseStat = fs.lstatSync(paths.database);
    const archiveStat = fs.lstatSync(paths.archive);
    const manifestStat = fs.lstatSync(paths.manifest);
    permissions = (directoryStat.mode & 0o777) === 0o700
      && [databaseStat, archiveStat, manifestStat].every((stat) => stat.isFile()
        && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600);
    databaseSize = databaseStat.size;
    archiveSize = archiveStat.size;
    [databaseSha256, archiveSha256] = await Promise.all([hashFile(paths.database), hashFile(paths.archive)]);
    databaseInspection = inspectCheckpointDatabaseWithoutMutation(paths.database, checkpointDirectory);
    archiveInspection = await inspectPayloadArchive(paths.archive);
  } catch (verificationError) {
    error = String(verificationError?.code || 'verification_failed');
  }
  const tableCountsMatch = databaseInspection
    ? declaredCountsMatch(databaseInspection.tableCounts, manifest.database.tableCounts)
    : false;
  const archiveInventoryMatches = archiveInspection
    ? ['entryCount', 'fileCount', 'directoryCount', 'totalBytes', 'inventorySha256']
      .every((key) => archiveInspection[key] === manifest.archive[key])
    : false;
  const checks = {
    packageLayout,
    permissions,
    databaseSizeMatches: databaseSize === manifest.database.sizeBytes,
    databaseSha256Matches: databaseSha256 === manifest.database.sha256,
    databaseQuickCheck: databaseInspection?.quickCheck || '',
    databaseForeignKeyViolations: databaseInspection?.foreignKeyViolations ?? null,
    databaseMaintenanceLeaseCleared: databaseInspection?.maintenanceLeaseCount === 0,
    databaseTableCountsMatch: tableCountsMatch,
    archiveSizeMatches: archiveSize === manifest.archive.sizeBytes,
    archiveSha256Matches: archiveSha256 === manifest.archive.sha256,
    archiveInventoryMatches,
  };
  const result = {
    id: paths.id,
    ok: Object.entries(checks).every(([key, value]) => key === 'databaseQuickCheck'
      ? value === 'ok'
      : (key === 'databaseForeignKeyViolations' ? value === 0 : value === true)),
    checkedAt: new Date().toISOString(),
    sensitive: true,
    checks,
  };
  if (error) result.error = error;
  return result;
}

function latestSuccessfulCheckpoint() {
  return listRecoveryCheckpoints().find((record) => record.status === 'available') || null;
}

function checkpointDeferralReason(error) {
  if (error?.activityCounts) return 'platform_activity';
  const message = String(error?.message || '');
  if (message.includes('A recovery checkpoint is already in progress')) return 'checkpoint_in_progress';
  if (message.includes('A database backup is already in progress')) return 'database_backup_in_progress';
  if (message.includes('Platform maintenance is already active')) return 'platform_maintenance';
  return '';
}

function currentCheckpointDeferral() {
  if (getPlatformMaintenance()) return { reason: 'platform_maintenance' };
  const activityCounts = getPlatformActivityCounts();
  if (Object.values(activityCounts).some((count) => count > 0)) {
    return { reason: 'platform_activity', activityCounts };
  }
  if (checkpointInFlight) return { reason: 'checkpoint_in_progress' };
  if (databaseBackupStatus().inProgress) return { reason: 'database_backup_in_progress' };
  return null;
}

function invokeSchedulerCallback(name, ...args) {
  try {
    schedulerCallbacks[name]?.(...args);
  } catch (error) {
    console.error(`[recovery-checkpoint] ${name} callback failed: ${error.message}`);
  }
}

function publishAutomaticRecoveryFailure(error, generation) {
  const failedAt = new Date().toISOString();
  schedulerState.lastAttemptAt = failedAt;
  lastCheckpointErrorAt = failedAt;
  lastCheckpointError = 'Automatic recovery checkpoint failed';
  scheduleAutomaticRecoveryCheckpoint(schedulerRetryDelayMs, generation);
  invokeSchedulerCallback('onError', error);
}

async function runAutomaticRecoveryCheckpointTick(generation) {
  if (schedulerStopped || generation !== schedulerGeneration) return;
  schedulerState.nextRunAt = '';
  const latest = latestSuccessfulCheckpoint();
  const intervalMs = CHECKPOINT_INTERVAL_HOURS * 60 * 60 * 1000;
  const lastCompletedAt = Date.parse(latest?.completedAt || '');
  const remainingMs = Number.isFinite(lastCompletedAt)
    ? lastCompletedAt + intervalMs - Date.now()
    : 0;
  if (remainingMs > 0) {
    scheduleAutomaticRecoveryCheckpoint(remainingMs, generation);
    return;
  }

  schedulerState.lastAttemptAt = new Date().toISOString();
  const preflightDeferral = currentCheckpointDeferral();
  if (preflightDeferral) {
    schedulerState.lastDeferredAt = schedulerState.lastAttemptAt;
    schedulerState.lastDeferredReason = preflightDeferral.reason;
    const retryAt = new Date(Date.now() + schedulerRetryDelayMs).toISOString();
    scheduleAutomaticRecoveryCheckpoint(schedulerRetryDelayMs, generation);
    invokeSchedulerCallback('onDeferred', { ...preflightDeferral, retryAt });
    return;
  }

  try {
    const checkpoint = await createRecoveryCheckpoint();
    schedulerState.lastSuccessAt = checkpoint.completedAt;
    const dueAt = Date.parse(checkpoint.completedAt) + intervalMs;
    scheduleAutomaticRecoveryCheckpoint(Math.max(1, dueAt - Date.now()), generation);
    invokeSchedulerCallback('onSuccess', checkpoint);
  } catch (error) {
    const reason = checkpointDeferralReason(error);
    if (reason) {
      schedulerState.lastDeferredAt = new Date().toISOString();
      schedulerState.lastDeferredReason = reason;
      const retryAt = new Date(Date.now() + schedulerRetryDelayMs).toISOString();
      scheduleAutomaticRecoveryCheckpoint(schedulerRetryDelayMs, generation);
      invokeSchedulerCallback('onDeferred', { reason, retryAt });
    } else {
      publishAutomaticRecoveryFailure(error, generation);
    }
  }
}

function scheduleAutomaticRecoveryCheckpoint(delayMs, generation) {
  if (schedulerStopped || CHECKPOINT_INTERVAL_HOURS === 0 || generation !== schedulerGeneration) return;
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerState.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  const timer = setTimeout(() => {
    if (schedulerTimer === timer) schedulerTimer = null;
    runAutomaticRecoveryCheckpointTick(generation).catch((error) => {
      if (schedulerStopped || generation !== schedulerGeneration) return;
      publishAutomaticRecoveryFailure(error, generation);
    });
  }, Math.max(1, Math.min(delayMs, 0x7fffffff)));
  schedulerTimer = timer;
  timer.unref();
}

function startRecoveryCheckpointScheduler(callbacks = {}, options = {}) {
  schedulerGeneration += 1;
  const generation = schedulerGeneration;
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  schedulerState.nextRunAt = '';
  schedulerStopped = false;
  schedulerCallbacks = callbacks;
  try {
    ensurePrivateDirectory(BACKUP_DIR);
    ensurePrivateDirectory(RECOVERY_CHECKPOINT_DIR);
    const initialDelayMs = options.initialDelayMs ?? 10000;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 1) {
      throw new Error('Recovery checkpoint initial delay must be a positive integer');
    }
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) {
      throw new Error('Recovery checkpoint retry delay must be a positive integer');
    }
    schedulerRetryDelayMs = retryDelayMs;
    if (CHECKPOINT_INTERVAL_HOURS > 0) {
      const latest = latestSuccessfulCheckpoint();
      const intervalMs = CHECKPOINT_INTERVAL_HOURS * 60 * 60 * 1000;
      const lastCompletedAt = Date.parse(latest?.completedAt || '');
      const remainingMs = Number.isFinite(lastCompletedAt)
        ? lastCompletedAt + intervalMs - Date.now()
        : 0;
      scheduleAutomaticRecoveryCheckpoint(remainingMs > 0 ? remainingMs : initialDelayMs, generation);
    }
  } catch (error) {
    schedulerState.lastAttemptAt = new Date().toISOString();
    lastCheckpointErrorAt = schedulerState.lastAttemptAt;
    lastCheckpointError = 'Automatic recovery checkpoint initialization failed';
    if (CHECKPOINT_INTERVAL_HOURS > 0) {
      scheduleAutomaticRecoveryCheckpoint(DEFAULT_RETRY_DELAY_MS, generation);
    }
    invokeSchedulerCallback('onError', error);
  }
  return recoveryCheckpointStatus();
}

function stopRecoveryCheckpointScheduler() {
  schedulerStopped = true;
  schedulerGeneration += 1;
  schedulerState.nextRunAt = '';
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  schedulerCallbacks = {};
}

function recoveryCheckpointStatus() {
  const records = listRecoveryCheckpoints();
  const available = records.filter((record) => record.status === 'available');
  const latest = available[0] || null;
  const retentionExcessCount = Math.max(0, available.length - CHECKPOINT_RETENTION);
  const intervalMs = CHECKPOINT_INTERVAL_HOURS * 60 * 60 * 1000;
  const lastSuccessAt = schedulerState.lastSuccessAt || latest?.completedAt || '';
  const lastSuccessMs = Date.parse(lastSuccessAt);
  return {
    enabled: CHECKPOINT_INTERVAL_HOURS > 0,
    intervalHours: CHECKPOINT_INTERVAL_HOURS,
    retention: CHECKPOINT_RETENTION,
    inProgress: Boolean(checkpointInFlight),
    overdue: CHECKPOINT_INTERVAL_HOURS > 0
      && (!Number.isFinite(lastSuccessMs) || Date.now() >= lastSuccessMs + intervalMs),
    lastSuccessAt,
    lastAttemptAt: schedulerState.lastAttemptAt,
    lastDeferredAt: schedulerState.lastDeferredAt,
    lastDeferredReason: schedulerState.lastDeferredReason,
    lastErrorAt: lastCheckpointErrorAt,
    lastError: lastCheckpointError,
    nextRunAt: schedulerState.nextRunAt,
    checkpointCount: available.length,
    retentionExcessCount,
    retentionSatisfied: retentionExcessCount === 0,
    unreadableCheckpointCount: records.length - available.length,
    sensitive: true,
  };
}

async function waitForRecoveryCheckpoint() {
  if (checkpointInFlight) await checkpointInFlight;
}

module.exports = {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  CHECKPOINT_RETENTION,
  CHECKPOINT_INTERVAL_HOURS,
  canonicalCheckpointId,
  listRecoveryCheckpoints,
  createRecoveryCheckpoint,
  verifyRecoveryCheckpoint,
  recoveryCheckpointStatus,
  startRecoveryCheckpointScheduler,
  stopRecoveryCheckpointScheduler,
  waitForRecoveryCheckpoint,
};
