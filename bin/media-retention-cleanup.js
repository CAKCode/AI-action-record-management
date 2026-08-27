#!/usr/bin/env node

/*
 * Retains generated pytest media only until the configured age. The command
 * is deliberately dry-run by default; production timers must opt into
 * --apply after configuring explicit video roots.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_QUARANTINE_DAYS = 3;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,240}$/;
const TERMINAL_TASK_STATUSES = new Set(['completed', 'stopped']);
const TERMINAL_ATTEMPT_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled']);

function cleanupError(message, code = 'MEDIA_RETENTION_FAILED') {
  return Object.assign(new Error(message), { code });
}

function parsePositiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw cleanupError(`${name} must be a positive integer`, 'MEDIA_RETENTION_CONFIG');
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw cleanupError(`${name} must be between 1 and ${maximum}`, 'MEDIA_RETENTION_CONFIG');
  }
  return parsed;
}

function resolveExistingDirectory(value, label) {
  const target = path.resolve(String(value || '').trim());
  if (!target || target === path.parse(target).root) {
    throw cleanupError(`${label} must be a non-root directory`, 'MEDIA_RETENTION_CONFIG');
  }
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    throw cleanupError(`${label} does not exist: ${target}`, error.code || 'MEDIA_RETENTION_CONFIG');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw cleanupError(`${label} must be a regular directory: ${target}`, 'MEDIA_RETENTION_CONFIG');
  }
  return fs.realpathSync(target);
}

function resolveConfiguredRoots(value) {
  const roots = String(value || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolveExistingDirectory(entry, 'Media cleanup root'));
  if (!roots.length) {
    throw cleanupError(
      'CODEX_MEDIA_CLEANUP_ROOTS must list one or more explicit videos directories',
      'MEDIA_RETENTION_CONFIG',
    );
  }
  const unique = [...new Set(roots)];
  for (const root of unique) {
    if (path.basename(root) === 'standard_videos') {
      throw cleanupError('standard_videos cannot be a media cleanup root', 'MEDIA_RETENTION_CONFIG');
    }
  }
  for (let index = 0; index < unique.length; index += 1) {
    for (let other = index + 1; other < unique.length; other += 1) {
      if (pathsOverlap(unique[index], unique[other])) {
        throw cleanupError('Media cleanup roots must not overlap', 'MEDIA_RETENTION_CONFIG');
      }
    }
  }
  return unique;
}

function pathsOverlap(left, right) {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  const leftToRight = path.relative(leftPath, rightPath);
  const rightToLeft = path.relative(rightPath, leftPath);
  return leftToRight === '' || rightToLeft === ''
    || (!leftToRight.startsWith('..') && !path.isAbsolute(leftToRight))
    || (!rightToLeft.startsWith('..') && !path.isAbsolute(rightToLeft));
}

function assertRootIsNotPlatformStorage(root, options) {
  const protectedRoots = [
    options.dataDir,
    options.backupDir,
    options.runtimeDir,
  ].filter(Boolean).map((entry) => path.resolve(entry));
  for (const protectedRoot of protectedRoots) {
    if (pathsOverlap(root, protectedRoot)) {
      throw cleanupError(`Media cleanup root overlaps protected platform storage: ${root}`, 'MEDIA_RETENTION_CONFIG');
    }
  }
}

function regularStat(target, label) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isSymbolicLink()) throw cleanupError(`${label} contains a symbolic link`, 'MEDIA_RETENTION_UNSAFE');
  if (!stat.isDirectory() && !stat.isFile()) {
    throw cleanupError(`${label} contains a special file`, 'MEDIA_RETENTION_UNSAFE');
  }
  return stat;
}

function treeBytes(target, label) {
  const stat = regularStat(target, label);
  if (!stat) return 0;
  if (stat.isFile()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    total += treeBytes(path.join(target, entry.name), label);
  }
  return total;
}

function listVideoCandidates(root, cutoffMs, protectedPaths) {
  const candidates = [];
  const skipped = [];
  const quarantineName = '.retention-quarantine';
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === quarantineName || entry.name === 'standard_videos' || entry.name.startsWith('.')) continue;
    const sourcePath = path.join(root, entry.name);
    if (!SAFE_NAME.test(entry.name)) {
      skipped.push({ sourcePath, reason: 'unsafe_run_id' });
      continue;
    }
    let stat;
    try { stat = regularStat(sourcePath, `Media candidate ${sourcePath}`); } catch (error) {
      skipped.push({ sourcePath, reason: error.code || 'unsafe_tree' });
      continue;
    }
    if (!stat?.isDirectory()) {
      skipped.push({ sourcePath, reason: 'not_run_directory' });
      continue;
    }
    if (stat.mtimeMs > cutoffMs) {
      skipped.push({ sourcePath, reason: 'younger_than_retention' });
      continue;
    }
    if (protectedPaths.some((protectedPath) => pathsOverlap(sourcePath, protectedPath))) {
      skipped.push({ sourcePath, reason: 'active_or_pending_reference' });
      continue;
    }
    try {
      candidates.push({
        sourcePath,
        root,
        runId: entry.name,
        bytes: treeBytes(sourcePath, `Media candidate ${sourcePath}`),
        mtimeMs: stat.mtimeMs,
      });
    } catch (error) {
      skipped.push({ sourcePath, reason: error.code || 'unsafe_tree' });
    }
  }
  return { candidates, skipped };
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function addProtectedPath(paths, value) {
  const normalized = String(value || '').trim();
  if (!normalized) return;
  const resolved = path.resolve(normalized);
  if (!paths.includes(resolved)) paths.push(resolved);
}

function databaseProtectedPaths(dbPath) {
  const protectedPaths = [];
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    if (tableExists(db, 'tasks')) {
      for (const row of db.prepare(`
        SELECT working_dir FROM tasks WHERE status NOT IN ('completed', 'stopped')
      `).all()) addProtectedPath(protectedPaths, row.working_dir);
    }
    if (tableExists(db, 'external_attempts')) {
      const columns = new Set(db.pragma('table_info(external_attempts)').map((column) => column.name));
      const hasTasks = tableExists(db, 'tasks');
      const hasExecutions = tableExists(db, 'command_executions')
        && columns.has('source_command_execution_id');
      const select = ['external_attempts.status', 'external_attempts.task_id'];
      if (columns.has('working_directory')) select.push('external_attempts.working_directory');
      if (columns.has('configured_working_directory')) select.push('external_attempts.configured_working_directory');
      if (columns.has('archive_status')) select.push('external_attempts.archive_status');
      if (columns.has('archive_verify_status')) select.push('external_attempts.archive_verify_status');
      if (hasTasks) select.push('tasks.working_dir AS task_working_dir');
      if (hasExecutions) {
        select.push('command_executions.working_directory AS execution_working_dir');
        select.push('command_executions.configured_working_directory AS execution_configured_working_dir');
      }
      const joins = [
        hasTasks ? 'LEFT JOIN tasks ON tasks.id=external_attempts.task_id' : '',
        hasExecutions ? 'LEFT JOIN command_executions ON command_executions.id=external_attempts.source_command_execution_id' : '',
      ].filter(Boolean).join(' ');
      for (const row of db.prepare(`SELECT ${select.join(', ')} FROM external_attempts ${joins}`).all()) {
        const archivePending = ('archive_status' in row && row.archive_status !== 'archived')
          || ('archive_verify_status' in row && row.archive_verify_status !== 'verified');
        if (!TERMINAL_ATTEMPT_STATUSES.has(String(row.status || '')) || archivePending) {
          addProtectedPath(protectedPaths, row.working_directory);
          addProtectedPath(protectedPaths, row.configured_working_directory);
          addProtectedPath(protectedPaths, row.task_working_dir);
          addProtectedPath(protectedPaths, row.execution_working_dir);
          addProtectedPath(protectedPaths, row.execution_configured_working_dir);
        }
      }
    }
    if (tableExists(db, 'skill_report_artifact_jobs') && tableExists(db, 'tasks')) {
      for (const row of db.prepare(`
        SELECT tasks.working_dir
        FROM skill_report_artifact_jobs
        JOIN tasks ON tasks.id=skill_report_artifact_jobs.task_id
        WHERE skill_report_artifact_jobs.status <> 'completed'
      `).all()) addProtectedPath(protectedPaths, row.working_dir);
    }
  } catch (error) {
    throw cleanupError(`Cannot inspect platform database: ${error.message}`, 'MEDIA_RETENTION_DB_UNAVAILABLE');
  } finally {
    db?.close();
  }
  return protectedPaths;
}

function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() })}\n`);
    return () => {
      try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(lockPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    };
  } catch (error) {
    if (error.code === 'EEXIST') throw cleanupError(`Media cleanup is already running: ${lockPath}`, 'MEDIA_RETENTION_LOCKED');
    throw error;
  }
}

function appendAudit(auditPath, event) {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
  })}\n`;
  fs.appendFileSync(auditPath, line, { encoding: 'utf8', mode: 0o600 });
}

function quarantineDirectory(root) {
  const directory = path.join(root, '.retention-quarantine');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw cleanupError(`Invalid quarantine directory: ${directory}`, 'MEDIA_RETENTION_UNSAFE');
  }
  return directory;
}

function quarantineName(candidate) {
  const suffix = crypto.createHash('sha256').update(candidate.sourcePath).digest('hex').slice(0, 12);
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${candidate.runId.slice(0, 120)}-${suffix}`;
}

function moveToQuarantine(candidate, auditPath, nowMs = Date.now()) {
  const directory = quarantineDirectory(candidate.root);
  const target = path.join(directory, quarantineName(candidate));
  fs.renameSync(candidate.sourcePath, target);
  // Rename preserves the source mtime; quarantine age must start at the move.
  const now = new Date(nowMs);
  fs.utimesSync(target, now, now);
  appendAudit(auditPath, {
    action: 'quarantined',
    sourcePath: candidate.sourcePath,
    quarantinePath: target,
    runId: candidate.runId,
    bytes: candidate.bytes,
  });
  return target;
}

function purgeQuarantine(root, cutoffMs, auditPath) {
  const directory = quarantineDirectory(root);
  const purged = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      appendAudit(auditPath, { action: 'skipped_quarantine_entry', target, reason: 'unsafe_entry' });
      continue;
    }
    const stat = regularStat(target, `Quarantine entry ${target}`);
    if (stat.mtimeMs > cutoffMs) continue;
    const bytes = treeBytes(target, `Quarantine entry ${target}`);
    fs.rmSync(target, { recursive: true, force: false });
    appendAudit(auditPath, { action: 'deleted', target, bytes });
    purged.push({ target, bytes });
  }
  return purged;
}

function buildOptions(overrides = {}) {
  const dataDir = path.resolve(overrides.dataDir || process.env.CODEX_DESK_DATA_DIR || path.join(process.cwd(), 'data'));
  const runtimeDir = path.resolve(overrides.runtimeDir || process.env.CODEX_DESK_RUNTIME_DIR || path.join(process.cwd(), '.runtime'));
  const backupDir = path.resolve(overrides.backupDir || process.env.CODEX_DESK_BACKUP_DIR || path.join(dataDir, 'backups'));
  const roots = overrides.roots || resolveConfiguredRoots(overrides.rootValue || process.env.CODEX_MEDIA_CLEANUP_ROOTS);
  for (const root of roots) assertRootIsNotPlatformStorage(root, {
    dataDir,
    backupDir,
    runtimeDir,
  });
  const retentionDays = overrides.retentionDays ?? parsePositiveInteger(
    process.env.CODEX_MEDIA_RETENTION_DAYS || DEFAULT_RETENTION_DAYS,
    'retentionDays',
  );
  const quarantineDays = overrides.quarantineDays ?? parsePositiveInteger(
    process.env.CODEX_MEDIA_QUARANTINE_DAYS || DEFAULT_QUARANTINE_DAYS,
    'quarantineDays',
  );
  return {
    roots,
    dataDir,
    runtimeDir,
    backupDir,
    dbPath: path.resolve(overrides.dbPath || process.env.CODEX_MEDIA_RETENTION_DB || path.join(dataDir, 'codex-tasks.db')),
    auditPath: path.resolve(overrides.auditPath || process.env.CODEX_MEDIA_RETENTION_AUDIT || path.join(runtimeDir, 'media-retention.ndjson')),
    lockPath: path.resolve(overrides.lockPath || process.env.CODEX_MEDIA_RETENTION_LOCK || path.join(runtimeDir, 'media-retention.lock')),
    retentionDays,
    quarantineDays,
    nowMs: overrides.nowMs ?? Date.now(),
    apply: Boolean(overrides.apply),
  };
}

function runCleanup(overrides = {}) {
  const options = buildOptions(overrides);
  const releaseLock = acquireLock(options.lockPath);
  try {
    const protectedPaths = databaseProtectedPaths(options.dbPath);
    const cutoffMs = options.nowMs - options.retentionDays * DAY_MS;
    const quarantineCutoffMs = options.nowMs - options.quarantineDays * DAY_MS;
    const result = {
      ok: true,
      mode: options.apply ? 'apply' : 'dry-run',
      retentionDays: options.retentionDays,
      quarantineDays: options.quarantineDays,
      cutoff: new Date(cutoffMs).toISOString(),
      protectedPathCount: protectedPaths.length,
      roots: [],
      quarantined: [],
      deleted: [],
    };
    for (const root of options.roots) {
      const scanned = listVideoCandidates(root, cutoffMs, protectedPaths);
      const rootResult = {
        root,
        candidateCount: scanned.candidates.length,
        skippedCount: scanned.skipped.length,
        candidates: scanned.candidates.map((candidate) => ({
          path: candidate.sourcePath,
          runId: candidate.runId,
          bytes: candidate.bytes,
          mtime: new Date(candidate.mtimeMs).toISOString(),
        })),
        skipped: scanned.skipped,
      };
      result.roots.push(rootResult);
      if (!options.apply) continue;
      for (const candidate of scanned.candidates) {
        try {
          result.quarantined.push(moveToQuarantine(candidate, options.auditPath, options.nowMs));
        } catch (error) {
          result.ok = false;
          appendAudit(options.auditPath, {
            action: 'quarantine_failed',
            sourcePath: candidate.sourcePath,
            code: error.code || 'MEDIA_RETENTION_FAILED',
          });
        }
      }
      try {
        result.deleted.push(...purgeQuarantine(root, quarantineCutoffMs, options.auditPath));
      } catch (error) {
        result.ok = false;
        appendAudit(options.auditPath, { action: 'delete_failed', root, code: error.code || 'MEDIA_RETENTION_FAILED' });
      }
    }
    appendAudit(options.auditPath, {
      action: 'run',
      mode: options.apply ? 'apply' : 'dry-run',
      ok: result.ok,
      candidateCount: result.roots.reduce((sum, item) => sum + item.candidateCount, 0),
      quarantinedCount: result.quarantined.length,
      deletedCount: result.deleted.length,
    });
    return result;
  } finally {
    releaseLock();
  }
}

function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') options.apply = false;
    else if (argument === '--root') {
      options.rootValue = argv[++index];
      if (!options.rootValue) throw cleanupError('--root requires a path', 'MEDIA_RETENTION_CONFIG');
    } else if (argument === '--retention-days') {
      options.retentionDays = parsePositiveInteger(argv[++index], 'retentionDays');
    } else if (argument === '--quarantine-days') {
      options.quarantineDays = parsePositiveInteger(argv[++index], 'quarantineDays');
    } else if (argument === '--help' || argument === '-h') {
      console.log('Usage: media-retention-cleanup.js [--apply] [--root PATH] [--retention-days N] [--quarantine-days N]');
      return null;
    } else {
      throw cleanupError(`Unknown option: ${argument}`, 'MEDIA_RETENTION_CONFIG');
    }
  }
  if (options.rootValue) options.roots = resolveConfiguredRoots(options.rootValue);
  return options;
}

if (require.main === module) {
  try {
    const cliOptions = parseArgs(process.argv.slice(2));
    if (cliOptions == null) process.exit(0);
    const result = runCleanup(cliOptions);
    console.log(JSON.stringify({
      ...result,
      roots: result.roots.map(({ root, candidateCount, skippedCount, candidates }) => ({
        root,
        candidateCount,
        skippedCount,
        candidates,
      })),
    }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(`[media-retention] ${error.code || 'failed'}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DAY_MS,
  buildOptions,
  databaseProtectedPaths,
  listVideoCandidates,
  pathsOverlap,
  runCleanup,
};
