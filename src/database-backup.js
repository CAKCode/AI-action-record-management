const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { BACKUP_DIR } = require('./paths');
const { getDatabase } = require('./database');
const { inspectProcess } = require('./process-identity');
const { getPlatformMaintenance } = require('./store');
const {
  MIN_FREE_BYTES,
  MIN_FREE_PERCENT,
  capacityTarget,
} = require('./storage-capacity');

const BACKUP_FORMAT = 'codex-task-platform.sqlite-backup';
const BACKUP_VERSION = 1;
const DEFAULT_RETENTION = 1;
const DEFAULT_INTERVAL_HOURS = 24;
const DEFAULT_MAX_DURATION_MINUTES = 120;
const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1000;
const BACKUP_ID_PATTERN = /^db-\d{8}T\d{9}Z-[a-f0-9]{8}$/;
const PACKAGE_FILES = new Set(['database.db', 'manifest.json']);
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

const BACKUP_RETENTION = integerSetting('CODEX_DB_BACKUP_RETENTION', DEFAULT_RETENTION, 1, 365);
const BACKUP_INTERVAL_HOURS = integerSetting(
  'CODEX_DB_BACKUP_INTERVAL_HOURS',
  DEFAULT_INTERVAL_HOURS,
  0,
  8760,
);
const BACKUP_MAX_DURATION_MS = integerSetting(
  'CODEX_DB_BACKUP_MAX_DURATION_MINUTES',
  DEFAULT_MAX_DURATION_MINUTES,
  1,
  1440,
) * 60 * 1000;

let backupInFlight = null;
let backupAbortController = null;
let schedulerTimer = null;
let schedulerStopped = true;
let schedulerGeneration = 0;
let schedulerCallbacks = {};
let schedulerState = {
  lastAttemptAt: '',
  lastSuccessAt: '',
  lastDeferredAt: '',
  lastDeferredReason: '',
  lastErrorAt: '',
  lastError: '',
  nextRunAt: '',
};

function statusError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Database backup storage is not a private directory');
  }
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

function backupId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  return `db-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function canonicalBackupId(value) {
  const id = String(value || '');
  if (!BACKUP_ID_PATTERN.test(id)) throw statusError('Invalid database backup id', 400);
  return id;
}

function packagePaths(id, backupDirectory = BACKUP_DIR) {
  const normalizedId = canonicalBackupId(id);
  const directory = path.join(backupDirectory, normalizedId);
  return {
    id: normalizedId,
    directory,
    database: path.join(directory, 'database.db'),
    manifest: path.join(directory, 'manifest.json'),
  };
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

function tableCounts(db) {
  const result = {};
  for (const table of COUNT_TABLES) {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    result[table] = exists ? Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count) : 0;
  }
  return result;
}

function validDeclaredCounts(value, requiredKeys, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const validCount = (count) => Number.isSafeInteger(count) && count >= 0;
  return requiredKeys.every((key) => validCount(value[key]))
    && Object.entries(value).every(([key, count]) => allowedKeys.includes(key) && validCount(count));
}

function declaredCountsMatch(actual, declared) {
  return Object.entries(declared).every(([table, count]) => actual[table] === count);
}

function inspectDatabase(filePath) {
  let db;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    const quickCheck = db.pragma('quick_check', { simple: true });
    const foreignKeyViolations = db.pragma('foreign_key_check').length;
    return {
      ok: quickCheck === 'ok' && foreignKeyViolations === 0,
      quickCheck,
      foreignKeyViolations,
      pageCount: Number(db.pragma('page_count', { simple: true })),
      pageSize: Number(db.pragma('page_size', { simple: true })),
      tableCounts: tableCounts(db),
    };
  } finally {
    db?.close();
    for (const sidecar of [`${filePath}-wal`, `${filePath}-shm`]) {
      try {
        const stat = fs.lstatSync(sidecar);
        if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(sidecar);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

function inspectDatabaseWithoutMutation(filePath, backupDirectory) {
  ensurePrivateDirectory(backupDirectory);
  const scratchDirectory = path.join(
    backupDirectory,
    `.verifying-${process.pid}-${crypto.randomUUID()}`,
  );
  const scratchDatabase = path.join(scratchDirectory, 'database.db');
  fs.mkdirSync(scratchDirectory, { mode: 0o700 });
  try {
    fs.copyFileSync(filePath, scratchDatabase, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(scratchDatabase, 0o600);
    return inspectDatabase(scratchDatabase);
  } finally {
    fs.rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

function readManifest(packageDirectory, expectedId) {
  const stat = fs.lstatSync(packageDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid backup package directory');
  const manifestPath = path.join(packageDirectory, 'manifest.json');
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 128 * 1024) {
    throw new Error('Invalid backup package manifest');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.format !== BACKUP_FORMAT || manifest?.version !== BACKUP_VERSION || manifest?.id !== expectedId) {
    throw new Error('Unsupported backup package manifest');
  }
  const database = manifest.database;
  const validTimestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
  if (!validTimestamp(manifest.createdAt)
    || !validTimestamp(manifest.completedAt)
    || !validCount(manifest.durationMs)
    || !database || typeof database !== 'object' || Array.isArray(database)
    || database.file !== 'database.db'
    || !validCount(database.sizeBytes)
    || !/^[a-f0-9]{64}$/.test(String(database.sha256 || ''))
    || database.quickCheck !== 'ok'
    || database.foreignKeyViolations !== 0
    || !validCount(database.pageCount)
    || !validCount(database.pageSize)
    || !validDeclaredCounts(database.tableCounts, REQUIRED_LEGACY_COUNT_TABLES, COUNT_TABLES)) {
    throw new Error('Invalid backup package manifest fields');
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
    database: {
      sizeBytes: manifest.database.sizeBytes,
      sha256: manifest.database.sha256,
      quickCheck: manifest.database.quickCheck,
      foreignKeyViolations: manifest.database.foreignKeyViolations,
      pageCount: manifest.database.pageCount,
      pageSize: manifest.database.pageSize,
      tableCounts: manifest.database.tableCounts,
    },
  };
}

function listDatabaseBackups(options = {}) {
  const backupDirectory = options.backupDirectory || BACKUP_DIR;
  let entries;
  try {
    const stat = fs.lstatSync(backupDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    entries = fs.readdirSync(backupDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !BACKUP_ID_PATTERN.test(entry.name)) continue;
    try {
      records.push({ ...publicManifest(readManifest(path.join(backupDirectory, entry.name), entry.name)), status: 'available' });
    } catch {
      records.push({ id: entry.name, status: 'invalid' });
    }
  }
  return records.sort((left, right) => String(right.createdAt || right.id).localeCompare(String(left.createdAt || left.id)));
}

function removeStaleTemporaryPackages(backupDirectory) {
  for (const entry of fs.readdirSync(backupDirectory, { withFileTypes: true })) {
    if (!entry.name.startsWith('.creating-')) continue;
    const target = path.join(backupDirectory, entry.name);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isSymbolicLink()) fs.rmSync(target, { recursive: true, force: true });
      else fs.unlinkSync(target);
    } catch {}
  }
}

function readLockOwner(lockDirectory) {
  try {
    const ownerPath = path.join(lockDirectory, 'owner.json');
    const stat = fs.lstatSync(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    return owner && typeof owner === 'object' ? owner : null;
  } catch {
    return null;
  }
}

function lockOwnerIsAlive(owner) {
  const current = inspectProcess(owner?.pid);
  return Boolean(current && current.startTicks === String(owner?.startTicks || ''));
}

function databaseBackupOperationActive(backupDirectory = BACKUP_DIR) {
  const lockDirectory = path.join(path.resolve(backupDirectory), '.backup.lock');
  try {
    const stat = fs.lstatSync(lockDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
    const owner = readLockOwner(lockDirectory);
    return lockOwnerIsAlive(owner) || (!owner && Date.now() - stat.mtimeMs < 30000);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    return true;
  }
}

function acquireBackupLock(backupDirectory) {
  const lockDirectory = path.join(backupDirectory, '.backup.lock');
  const identity = inspectProcess(process.pid);
  if (!identity) throw new Error('Cannot establish database backup process identity');
  const token = crypto.randomUUID();
  const owner = {
    token,
    pid: process.pid,
    startTicks: identity.startTicks,
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let createdLock = false;
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
      createdLock = true;
      fs.chmodSync(lockDirectory, 0o700);
      writePrivateJson(path.join(lockDirectory, 'owner.json'), owner);
      syncPath(lockDirectory);
      syncPath(backupDirectory);
      return () => {
        const currentOwner = readLockOwner(lockDirectory);
        if (currentOwner?.token !== token) return;
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        syncPath(backupDirectory);
      };
    } catch (error) {
      if (createdLock) {
        try {
          fs.rmSync(lockDirectory, { recursive: true, force: true });
          syncPath(backupDirectory);
        } catch {}
        throw error;
      }
      if (error.code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(lockDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw statusError('Database backup lock is invalid', 507);
      }
      const existingOwner = readLockOwner(lockDirectory);
      if (lockOwnerIsAlive(existingOwner) || (!existingOwner && Date.now() - stat.mtimeMs < 30000)) {
        throw statusError('A database backup is already in progress', 409);
      }
      const staleLock = path.join(backupDirectory, `.stale-backup-lock-${crypto.randomUUID()}`);
      try {
        fs.renameSync(lockDirectory, staleLock);
        fs.rmSync(staleLock, { recursive: true, force: true });
        syncPath(backupDirectory);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') throw cleanupError;
      }
    }
  }
  throw statusError('Database backup lock could not be acquired', 409);
}

function assertBackupCapacity(backupDirectory, estimatedBytes) {
  const capacity = capacityTarget('backup', backupDirectory);
  if (capacity.status === 'unavailable') {
    throw statusError('Database backup storage is unavailable', 507);
  }
  const projectedBytes = capacity.availableBytes - estimatedBytes;
  const projectedPercent = capacity.totalBytes > 0
    ? (projectedBytes / capacity.totalBytes) * 100
    : 0;
  if (projectedBytes < MIN_FREE_BYTES || projectedPercent < MIN_FREE_PERCENT) {
    throw statusError('Insufficient storage capacity for a verified database backup', 507);
  }
}

function rotateDatabaseBackups(backupDirectory, retention) {
  const records = listDatabaseBackups({ backupDirectory }).filter((record) => record.status === 'available');
  const removed = [];
  for (const record of records.slice(retention)) {
    const paths = packagePaths(record.id, backupDirectory);
    const stat = fs.lstatSync(paths.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    fs.rmSync(paths.directory, { recursive: true, force: true });
    removed.push(record.id);
  }
  if (removed.length) syncPath(backupDirectory);
  return removed;
}

async function performDatabaseBackup(options = {}) {
  const backupDirectory = options.backupDirectory || BACKUP_DIR;
  const retention = options.retention ?? BACKUP_RETENTION;
  if (!Number.isInteger(retention) || retention < 1 || retention > 365) {
    throw statusError('Backup retention must be an integer between 1 and 365', 400);
  }
  ensurePrivateDirectory(backupDirectory);
  const releaseBackupLock = acquireBackupLock(backupDirectory);

  try {
    const maintenance = getPlatformMaintenance();
    if (maintenance && maintenance.owner !== String(options.maintenanceOwner || '')) {
      throw statusError(`Platform maintenance is active: ${maintenance.kind}`, 503);
    }
    removeStaleTemporaryPackages(backupDirectory);
    const source = getDatabase();
    const estimatedBytes = Number(source.pragma('page_count', { simple: true }))
      * Number(source.pragma('page_size', { simple: true }));
    assertBackupCapacity(backupDirectory, Math.ceil(estimatedBytes * 1.1) + 1024 * 1024);

    const startedAtMs = Date.now();
    const maxDurationMs = options.maxDurationMs ?? BACKUP_MAX_DURATION_MS;
    if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1) {
      throw statusError('Database backup max duration must be a positive integer', 400);
    }
    const createdAt = new Date(startedAtMs).toISOString();
    const id = backupId(new Date(startedAtMs));
    const finalPaths = packagePaths(id, backupDirectory);
    const temporaryDirectory = path.join(backupDirectory, `.creating-${id}-${crypto.randomUUID()}`);
    const temporaryDatabase = path.join(temporaryDirectory, 'database.db');
    const temporaryManifest = path.join(temporaryDirectory, 'manifest.json');
    let published = false;

    try {
      fs.mkdirSync(temporaryDirectory, { mode: 0o700 });
      fs.chmodSync(temporaryDirectory, 0o700);
      options.faultInjector?.('before_backup');
      const assertBackupMayContinue = () => {
        if (options.signal?.aborted) {
          const error = new Error('Database backup was cancelled');
          error.code = 'DATABASE_BACKUP_CANCELLED';
          throw error;
        }
        if (Date.now() - startedAtMs >= maxDurationMs) {
          const error = new Error(`Database backup exceeded ${maxDurationMs} ms`);
          error.code = 'DATABASE_BACKUP_TIMEOUT';
          throw error;
        }
      };
      await source.backup(temporaryDatabase, {
        progress(progress) {
          assertBackupMayContinue();
          options.onProgress?.(progress);
          assertBackupMayContinue();
          return 256;
        },
      });
      fs.chmodSync(temporaryDatabase, 0o600);
      syncPath(temporaryDatabase);
      options.faultInjector?.('after_backup');

      const inspection = inspectDatabase(temporaryDatabase);
      if (!inspection.ok) throw new Error('The generated database backup failed consistency checks');
      const databaseStat = fs.lstatSync(temporaryDatabase);
      if (!databaseStat.isFile() || databaseStat.isSymbolicLink()) throw new Error('Invalid generated database backup');
      const sha256 = await hashFile(temporaryDatabase);
      options.faultInjector?.('after_verification');

      const completedAtMs = Date.now();
      const manifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        id,
        createdAt,
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: completedAtMs - startedAtMs,
        database: {
          file: 'database.db',
          sizeBytes: databaseStat.size,
          sha256,
          quickCheck: inspection.quickCheck,
          foreignKeyViolations: inspection.foreignKeyViolations,
          pageCount: inspection.pageCount,
          pageSize: inspection.pageSize,
          tableCounts: inspection.tableCounts,
        },
      };
      writePrivateJson(temporaryManifest, manifest);
      syncPath(temporaryDirectory);
      options.faultInjector?.('before_publish');
      fs.renameSync(temporaryDirectory, finalPaths.directory);
      published = true;
      syncPath(backupDirectory);
      options.faultInjector?.('after_publish');

      const removedBackupIds = rotateDatabaseBackups(backupDirectory, retention);
      return {
        ...publicManifest(manifest),
        status: 'available',
        retention,
        removedBackupIds,
      };
    } catch (error) {
      if (!published) {
        try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); } catch {}
      }
      throw error;
    }
  } finally {
    releaseBackupLock();
  }
}

function createDatabaseBackup(options = {}) {
  if (backupInFlight) throw statusError('A database backup is already in progress', 409);
  const usesPrimaryDirectory = path.resolve(options.backupDirectory || BACKUP_DIR) === path.resolve(BACKUP_DIR);
  const controller = new AbortController();
  backupAbortController = controller;
  backupInFlight = performDatabaseBackup({ ...options, signal: controller.signal })
    .then((result) => {
      if (usesPrimaryDirectory) {
        schedulerState.lastSuccessAt = result.completedAt;
        schedulerState.lastErrorAt = '';
        schedulerState.lastError = '';
        if (!schedulerStopped && BACKUP_INTERVAL_HOURS > 0) {
          const dueAt = Date.parse(result.completedAt) + (BACKUP_INTERVAL_HOURS * 60 * 60 * 1000);
          scheduleAutomaticBackup(Math.max(1, dueAt - Date.now()), schedulerCallbacks, schedulerGeneration);
        }
      }
      return result;
    })
    .finally(() => {
      backupInFlight = null;
      if (backupAbortController === controller) backupAbortController = null;
    });
  return backupInFlight;
}

function cancelDatabaseBackup() {
  if (!backupAbortController || backupAbortController.signal.aborted) return false;
  backupAbortController.abort();
  return true;
}

async function verifyDatabaseBackup(value, options = {}) {
  const backupDirectory = options.backupDirectory || BACKUP_DIR;
  const paths = packagePaths(value, backupDirectory);
  if (!fs.existsSync(paths.directory)) throw statusError(`Database backup ${paths.id} not found`, 404);
  let manifest;
  try {
    manifest = readManifest(paths.directory, paths.id);
  } catch {
    throw statusError('Database backup package manifest is invalid', 409);
  }
  const checkedAt = new Date().toISOString();
  let inspection = null;
  let actualSize = null;
  let actualSha256 = '';
  let packageLayout = false;
  let permissions = false;
  let error = '';
  try {
    const names = fs.readdirSync(paths.directory).sort();
    packageLayout = names.length === PACKAGE_FILES.size && names.every((name) => PACKAGE_FILES.has(name));
    const directoryStat = fs.lstatSync(paths.directory);
    const databaseStat = fs.lstatSync(paths.database);
    const manifestStat = fs.lstatSync(paths.manifest);
    permissions = (directoryStat.mode & 0o777) === 0o700
      && (databaseStat.mode & 0o777) === 0o600
      && (manifestStat.mode & 0o777) === 0o600
      && databaseStat.isFile() && !databaseStat.isSymbolicLink()
      && manifestStat.isFile() && !manifestStat.isSymbolicLink();
    actualSize = databaseStat.size;
    actualSha256 = await hashFile(paths.database);
    inspection = inspectDatabaseWithoutMutation(paths.database, backupDirectory);
  } catch (verificationError) {
    error = String(verificationError?.code || 'verification_failed');
  }
  const result = {
    id: paths.id,
    ok: packageLayout
      && permissions
      && actualSize === manifest.database.sizeBytes
      && actualSha256 === manifest.database.sha256
      && inspection?.ok === true,
    checkedAt,
    checks: {
      packageLayout,
      permissions,
      sizeMatches: actualSize === manifest.database.sizeBytes,
      sha256Matches: actualSha256 === manifest.database.sha256,
      quickCheck: inspection?.quickCheck || '',
      foreignKeyViolations: inspection?.foreignKeyViolations ?? null,
      foreignKeyCountMatches: inspection
        ? inspection.foreignKeyViolations === manifest.database.foreignKeyViolations
        : false,
      pageCountMatches: inspection ? inspection.pageCount === manifest.database.pageCount : false,
      pageSizeMatches: inspection ? inspection.pageSize === manifest.database.pageSize : false,
      tableCountsMatch: inspection
        ? declaredCountsMatch(inspection.tableCounts, manifest.database.tableCounts)
        : false,
    },
  };
  if (error) result.error = error;
  result.ok = result.ok
    && result.checks.foreignKeyCountMatches
    && result.checks.pageCountMatches
    && result.checks.pageSizeMatches
    && result.checks.tableCountsMatch;
  return result;
}

async function copyDatabaseBackupFile(value, destination, options = {}) {
  const backupDirectory = options.backupDirectory || BACKUP_DIR;
  const paths = packagePaths(value, backupDirectory);
  let manifest;
  try {
    manifest = readManifest(paths.directory, paths.id);
    const stat = fs.lstatSync(paths.database);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid database backup file');
    fs.copyFileSync(paths.database, destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
    syncPath(destination);
    const copiedStat = fs.lstatSync(destination);
    const copiedHash = await hashFile(destination);
    if (copiedStat.size !== manifest.database.sizeBytes || copiedHash !== manifest.database.sha256) {
      throw new Error('Copied database backup does not match its manifest');
    }
    return publicManifest(manifest);
  } catch (error) {
    try { fs.rmSync(destination, { force: true }); } catch {}
    if (error.statusCode) throw error;
    throw statusError('Database backup could not be copied into a recovery checkpoint', 409);
  }
}

function latestSuccessfulBackup() {
  return listDatabaseBackups().find((record) => record.status === 'available') || null;
}

function databaseBackupStatus() {
  const records = listDatabaseBackups();
  const validRecords = records.filter((record) => record.status === 'available');
  const latest = validRecords[0] || null;
  const retentionExcessCount = Math.max(0, validRecords.length - BACKUP_RETENTION);
  return {
    enabled: BACKUP_INTERVAL_HOURS > 0,
    intervalHours: BACKUP_INTERVAL_HOURS,
    retention: BACKUP_RETENTION,
    inProgress: Boolean(backupInFlight),
    lastSuccessAt: schedulerState.lastSuccessAt || latest?.completedAt || '',
    lastAttemptAt: schedulerState.lastAttemptAt,
    lastDeferredAt: schedulerState.lastDeferredAt,
    lastDeferredReason: schedulerState.lastDeferredReason,
    lastErrorAt: schedulerState.lastErrorAt,
    lastError: schedulerState.lastError,
    nextRunAt: schedulerState.nextRunAt,
    backupCount: validRecords.length,
    retentionExcessCount,
    retentionSatisfied: retentionExcessCount === 0,
    unreadableBackupCount: records.length - validRecords.length,
  };
}

function automaticBackupDeferral() {
  const maintenance = getPlatformMaintenance();
  if (maintenance) return { reason: 'platform_maintenance' };
  if (backupInFlight || databaseBackupOperationActive()) return { reason: 'database_backup_in_progress' };
  return null;
}

function backupDeferralReason(error) {
  const message = String(error?.message || '');
  if (message.includes('Platform maintenance is active')) return 'platform_maintenance';
  if (message.includes('A database backup is already in progress')) return 'database_backup_in_progress';
  return '';
}

function publishAutomaticBackupFailure(error, callbacks, generation) {
  const failedAt = new Date().toISOString();
  schedulerState.lastAttemptAt = failedAt;
  schedulerState.lastErrorAt = failedAt;
  schedulerState.lastError = 'Automatic database backup failed';
  const intervalMs = BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
  scheduleAutomaticBackup(Math.min(intervalMs, DEFAULT_RETRY_DELAY_MS), callbacks, generation);
  try { callbacks.onError?.(error); } catch (callbackError) {
    console.error(`[database-backup] failure callback failed: ${callbackError.message}`);
  }
}

async function runAutomaticBackupTick(callbacks, generation) {
  if (schedulerStopped || generation !== schedulerGeneration) return;
  schedulerState.nextRunAt = '';
  const latest = latestSuccessfulBackup();
  const intervalMs = BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
  const lastCompletedAt = Date.parse(latest?.completedAt || '');
  const remainingMs = Number.isFinite(lastCompletedAt) ? lastCompletedAt + intervalMs - Date.now() : 0;
  if (remainingMs > 0) {
    scheduleAutomaticBackup(remainingMs, callbacks, generation);
    return;
  }
  schedulerState.lastAttemptAt = new Date().toISOString();
  const preflightDeferral = automaticBackupDeferral();
  if (preflightDeferral) {
    schedulerState.lastDeferredAt = schedulerState.lastAttemptAt;
    schedulerState.lastDeferredReason = preflightDeferral.reason;
    const retryDelayMs = Math.min(intervalMs, DEFAULT_RETRY_DELAY_MS);
    const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
    scheduleAutomaticBackup(retryDelayMs, callbacks, generation);
    try { callbacks.onDeferred?.({ ...preflightDeferral, retryAt }); } catch (callbackError) {
      console.error(`[database-backup] deferred callback failed: ${callbackError.message}`);
    }
    return;
  }
  try {
    const result = await createDatabaseBackup();
    const dueAt = Date.parse(result.completedAt) + intervalMs;
    scheduleAutomaticBackup(Math.max(1, dueAt - Date.now()), callbacks, generation);
    try { callbacks.onSuccess?.(result); } catch (callbackError) {
      console.error(`[database-backup] success callback failed: ${callbackError.message}`);
    }
  } catch (error) {
    const deferredReason = backupDeferralReason(error);
    if (deferredReason) {
      schedulerState.lastDeferredAt = new Date().toISOString();
      schedulerState.lastDeferredReason = deferredReason;
      const retryDelayMs = Math.min(intervalMs, DEFAULT_RETRY_DELAY_MS);
      const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
      scheduleAutomaticBackup(retryDelayMs, callbacks, generation);
      try { callbacks.onDeferred?.({ reason: deferredReason, retryAt }); } catch (callbackError) {
        console.error(`[database-backup] deferred callback failed: ${callbackError.message}`);
      }
      return;
    }
    publishAutomaticBackupFailure(error, callbacks, generation);
  }
}

function scheduleAutomaticBackup(delayMs, callbacks, generation) {
  if (schedulerStopped || BACKUP_INTERVAL_HOURS === 0 || generation !== schedulerGeneration) return;
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerState.nextRunAt = new Date(Date.now() + delayMs).toISOString();
  const timer = setTimeout(() => {
    if (schedulerTimer === timer) schedulerTimer = null;
    runAutomaticBackupTick(callbacks, generation).catch((error) => {
      if (schedulerStopped || generation !== schedulerGeneration) return;
      publishAutomaticBackupFailure(error, callbacks, generation);
    });
  }, Math.max(1, Math.min(delayMs, 0x7fffffff)));
  schedulerTimer = timer;
  timer.unref();
}

function startDatabaseBackupScheduler(callbacks = {}, options = {}) {
  schedulerGeneration += 1;
  const generation = schedulerGeneration;
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  schedulerState.nextRunAt = '';
  schedulerStopped = false;
  schedulerCallbacks = callbacks;
  try {
    ensurePrivateDirectory(BACKUP_DIR);
    const initialDelayMs = options.initialDelayMs ?? 5000;
    if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 1) {
      throw new Error('Database backup initial delay must be a positive integer');
    }
    if (BACKUP_INTERVAL_HOURS > 0) {
      const latest = latestSuccessfulBackup();
      const intervalMs = BACKUP_INTERVAL_HOURS * 60 * 60 * 1000;
      const lastCompletedAt = Date.parse(latest?.completedAt || '');
      const remainingMs = Number.isFinite(lastCompletedAt)
        ? lastCompletedAt + intervalMs - Date.now()
        : 0;
      scheduleAutomaticBackup(remainingMs > 0 ? remainingMs : initialDelayMs, callbacks, generation);
    }
  } catch (error) {
    schedulerState.lastAttemptAt = new Date().toISOString();
    schedulerState.lastErrorAt = schedulerState.lastAttemptAt;
    schedulerState.lastError = 'Automatic database backup initialization failed';
    if (BACKUP_INTERVAL_HOURS > 0) scheduleAutomaticBackup(DEFAULT_RETRY_DELAY_MS, callbacks, generation);
    try { callbacks.onError?.(error); } catch (callbackError) {
      console.error(`[database-backup] failure callback failed: ${callbackError.message}`);
    }
  }
  return databaseBackupStatus();
}

function stopDatabaseBackupScheduler() {
  schedulerStopped = true;
  schedulerGeneration += 1;
  schedulerState.nextRunAt = '';
  if (schedulerTimer) clearTimeout(schedulerTimer);
  schedulerTimer = null;
  schedulerCallbacks = {};
}

async function waitForDatabaseBackup() {
  if (backupInFlight) await backupInFlight;
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BACKUP_RETENTION,
  BACKUP_INTERVAL_HOURS,
  BACKUP_MAX_DURATION_MS,
  canonicalBackupId,
  listDatabaseBackups,
  createDatabaseBackup,
  verifyDatabaseBackup,
  copyDatabaseBackupFile,
  databaseBackupStatus,
  databaseBackupOperationActive,
  cancelDatabaseBackup,
  startDatabaseBackupScheduler,
  stopDatabaseBackupScheduler,
  waitForDatabaseBackup,
};
