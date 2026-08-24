const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ROOT_DIR,
  DATA_DIR,
  RUNTIME_DIR,
  SKILLS_DIR,
  SESSIONS_DIR,
  AUDIT_FILE,
  CODEX_SOURCE_SKILLS_DIR,
  WORKSPACE_CODEX_SKILLS_DIR,
  SKILL_SNAPSHOTS_DIR,
} = require('./paths');
const { getDatabase } = require('./database');
const { pathContains, resolveWorkingDir } = require('./workspaces');
const { validateTaskBody, validateSkillBody } = require('./validation');
const { normalizeArtifactDeclarations, normalizeSkillReport } = require('./skill-report');
const {
  nowIso,
  readJson,
  safeId,
  unique,
  toArray,
} = require('./utils');
const {
  pathEntryExists,
  ensureManagedDirectory,
  writeManagedFile,
  readManagedFile,
  readManagedTextTail,
  secureManagedTree,
} = require('./managed-storage');
const {
  cleanupBridgeSessionResources,
  listBridgeSessionRecords,
} = require('./bridge-runtime-cleanup');
const {
  archiveFileAtomically,
  digestRegularFile,
  fsyncDirectory,
  openDigestedRegularFile,
  openRegularFileForRead,
} = require('./external-attempt-archive');
const {
  inspectProcess,
  processGroupStillBelongsTo,
  signalVerifiedProcessGroup,
} = require('./process-identity');
const {
  placeExternalAttemptInTaskCgroup,
  killVerifiedTaskCgroup,
  inspectVerifiedTaskCgroup,
} = require('./task-cgroup');

const SKILL_CACHE_TTL_MS = 15000;
const MAX_QUERY_LIMIT = 500;
const MAX_SESSION_PAGE_SIZE = 500;
const MAX_LATEST_LOG_BYTES = 1024 * 1024;
const LATEST_LOG_TRIM_THRESHOLD = MAX_LATEST_LOG_BYTES + (256 * 1024);
const COMMAND_CLAIM_TTL_MS = 15000;
const MAX_TASK_RETRIES = 20;
const MAX_SKILL_FILES = 256;
const MAX_SKILL_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_ATTRIBUTION_REASON_LENGTH = 2000;
const MAX_SKILL_REPORT_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_PYTEST_MEDIA_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_PYTEST_MEDIA_RESOURCES = 10000;
const SCHEDULE_CLAIM_TTL_MS = 15000;
const DEFAULT_EXTERNAL_CHECK_SECONDS = 300;
const MIN_EXTERNAL_CHECK_SECONDS = 5;
const MAX_EXTERNAL_CHECK_SECONDS = 7 * 24 * 60 * 60;
const ACTIVE_EXTERNAL_STATUSES = ['running'];
const ACTIVE_SCHEDULE_STATUSES = ['pending', 'leased', 'dispatched'];
const ACTIVE_STATUSES = ['queued', 'running', 'recovering', 'stopping', 'waiting_scheduled'];
const PLATFORM_MAINTENANCE_KEY = 'platform_maintenance';
const skillReportResourceVerificationCache = new Map();
const TASK_RETENTION_STATUS_KEY = 'task_retention_status';
const TASK_RETENTION_DAYS = 30;
const TASK_RETENTION_BATCH_SIZE = 50;
const TASK_RETENTION_MAINTENANCE_TTL_MS = 120000;
const BRIDGE_CLEANUP_LEASE_MS = 30000;
const BRIDGE_CLEANUP_MAX_RETRY_MS = 60 * 60 * 1000;
const EXTERNAL_ARCHIVE_LEASE_MS = 30000;
const EXTERNAL_ARCHIVE_MAX_CLAIM = 4;
const EXTERNAL_ARCHIVE_MAX_RETRY_MS = 24 * 60 * 60 * 1000;
const EXTERNAL_ARCHIVE_VERIFY_LEASE_MS = 30000;
const EXTERNAL_ARCHIVE_VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REPORT_ARTIFACT_JOB_LEASE_MS = 30000;
const REPORT_ARTIFACT_JOB_MAX_ATTEMPTS = 20;
const REPORT_ARTIFACT_JOB_MAX_RETRY_MS = 60 * 60 * 1000;
const EXTERNAL_STOP_GRACE_MS = 2000;
const PLATFORM_REPORT_SKILL_IDS = new Set([
  'cloud-recording-test',
  'cloud-recording-gw-deploy',
]);
const SESSION_STATUSES = [
  'idle', 'queued', 'running', 'recovering', 'stopping', 'waiting_scheduled', 'waiting_review',
  'waiting_input', 'failed', 'interrupted', 'stopped', 'completed',
];
let skillsCacheExpiresAt = 0;
let initializedDatabase = null;

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function isRegularDirectory(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function removeTree(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fs.unlinkSync(filePath);
    return;
  }
  fs.chmodSync(filePath, 0o700);
  for (const entry of fs.readdirSync(filePath)) removeTree(path.join(filePath, entry));
  fs.rmdirSync(filePath);
}

function eventId(prefix = 'evt') {
  return `${prefix}-${crypto.randomUUID()}`;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function hashBuffer(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeSkillFilePath(input) {
  const value = String(input || '');
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw statusError(`Unsafe Skill file path: ${value || '(empty)'}`, 400);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw statusError(`Unsafe Skill file path: ${value}`, 400);
  }
  return segments.join('/');
}

function normalizeSkillFiles(input, content = undefined) {
  const source = input == null
    ? [{ path: 'SKILL.md', content: Buffer.from(String(content ?? ''), 'utf8'), mode: 0o644 }]
    : input;
  if (!Array.isArray(source) || !source.length) throw statusError('Skill files must be a non-empty array', 400);
  if (source.length > MAX_SKILL_FILES) throw statusError(`Skill exceeds the ${MAX_SKILL_FILES}-file limit`, 400);
  const paths = new Set();
  let totalSize = 0;
  const files = source.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
      throw statusError('Every Skill file must be an object', 400);
    }
    const filePath = normalizeSkillFilePath(file.path);
    if (paths.has(filePath)) throw statusError(`Duplicate Skill file path: ${filePath}`, 400);
    paths.add(filePath);
    const fileContent = Buffer.isBuffer(file.content)
      ? Buffer.from(file.content)
      : Buffer.from(String(file.content ?? ''), 'utf8');
    if (fileContent.length > MAX_SKILL_FILE_BYTES) {
      throw statusError(`Skill file exceeds the 4 MiB limit: ${filePath}`, 400);
    }
    totalSize += fileContent.length;
    if (totalSize > MAX_SKILL_TOTAL_BYTES) throw statusError('Skill exceeds the 16 MiB total-size limit', 400);
    return {
      path: filePath,
      content: fileContent,
      mode: Number(file.mode) & 0o111 ? 0o755 : 0o644,
      contentHash: hashBuffer(fileContent),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const markdown = files.find((file) => file.path === 'SKILL.md');
  if (!markdown) throw statusError('Skill files must contain SKILL.md', 400);
  if (content !== undefined && !markdown.content.equals(Buffer.from(String(content), 'utf8'))) {
    throw statusError('Skill content does not match files entry SKILL.md', 400);
  }
  return files;
}

function hashSkillFiles(files) {
  return hashContent(JSON.stringify(files.map((file) => [file.path, file.mode, file.contentHash])));
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function boundedLimit(value, fallback) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : Number(fallback);
  return Math.min(MAX_QUERY_LIMIT, Math.max(1, normalized));
}

function boundedOffset(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function boundedExternalCheckSeconds(value, fallback = DEFAULT_EXTERNAL_CHECK_SECONDS) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.floor(parsed) : Number(fallback);
  return Math.min(MAX_EXTERNAL_CHECK_SECONDS, Math.max(MIN_EXTERNAL_CHECK_SECONDS, normalized));
}

function statusError(message, statusCode = 409) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertNoPlatformMaintenance(db) {
  const maintenance = platformMaintenanceFromDatabase(db);
  if (!maintenance) return;
  const error = statusError(`Platform maintenance is active: ${maintenance.kind}`, 503);
  error.expose = true;
  error.expected = true;
  error.retryAfterSeconds = Math.max(
    1,
    Math.ceil((Date.parse(maintenance.expiresAt) - Date.now()) / 1000),
  );
  error.maintenance = maintenance;
  throw error;
}

function sessionOperationIdentity(operation, taskId, context = {}) {
  const idempotencyKey = String(context.idempotencyKey || '').trim();
  const expectedTaskCreatedAt = String(context.expectedTaskCreatedAt || '').trim();
  if (idempotencyKey.length > 256) throw statusError('Idempotency key exceeds the 256-character limit', 400);
  if (expectedTaskCreatedAt.length > 128) throw statusError('Expected task creation time is too long', 400);
  return {
    operation,
    taskId,
    idempotencyKey,
    expectedTaskCreatedAt,
  };
}

function readSessionOperationReceipt(db, identity) {
  if (!identity.idempotencyKey) return null;
  const row = db.prepare(`
    SELECT operation, task_id, expected_task_created_at, response_json
    FROM session_operation_receipts WHERE idempotency_key=?
  `).get(identity.idempotencyKey);
  if (!row) return null;
  if (row.operation !== identity.operation || row.task_id !== identity.taskId
    || row.expected_task_created_at !== identity.expectedTaskCreatedAt) {
    throw statusError('Idempotency key is already bound to a different task operation', 409);
  }
  const response = parseJson(row.response_json, null);
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw statusError('Stored task operation receipt is invalid', 500);
  }
  return response;
}

function assertExpectedTaskGeneration(task, identity) {
  if (identity.expectedTaskCreatedAt && task.created_at !== identity.expectedTaskCreatedAt) {
    throw statusError('Task was replaced after this operation was prepared', 409);
  }
}

function writeSessionOperationReceipt(db, identity, taskCreatedAt, response, context = {}) {
  if (!identity.idempotencyKey) return;
  db.prepare(`
    INSERT INTO session_operation_receipts(
      idempotency_key, operation, task_id, task_created_at, expected_task_created_at,
      response_json, actor, request_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    identity.idempotencyKey,
    identity.operation,
    identity.taskId,
    String(taskCreatedAt || ''),
    identity.expectedTaskCreatedAt,
    JSON.stringify(response),
    context.actor || 'operator',
    context.requestId || '',
    nowIso(),
  );
}

function canonicalTaskId(input) {
  const value = String(input || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw statusError('Task id must match ^[a-z0-9][a-z0-9_-]{0,63}$', 400);
  }
  return value;
}

function canonicalManagedSkillId(input) {
  const value = String(input || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw statusError('Managed skill id must match ^[a-z0-9][a-z0-9_-]{0,63}$', 400);
  }
  return value;
}

function boundedSourceSkillId(candidate, sourceKey, forceHash, occupiedIds) {
  const normalized = safeId(candidate);
  if (!forceHash && normalized.length <= 64 && !occupiedIds.has(normalized)) return normalized;
  for (let salt = 0; ; salt += 1) {
    const suffix = `-${hashContent(`${sourceKey}:${salt}`).slice(0, 8)}`;
    const prefix = normalized.slice(0, 64 - suffix.length).replace(/-+$/g, '') || 'codex';
    const id = `${prefix}${suffix}`;
    if (!occupiedIds.has(id)) return id;
  }
}

function preserveString(value) {
  return String(value || '');
}

function preserveValue(value) {
  return value;
}

function normalizeLegacyStatus(status) {
  if (status === 'finished') return 'completed';
  if (status === 'running') return 'interrupted';
  return status || 'idle';
}

function readLegacyJson(filePath, fallback = null) {
  try {
    const content = readManagedFile(filePath, {
      encoding: 'utf8',
      label: 'Legacy JSON source',
    });
    return content == null ? fallback : JSON.parse(content);
  } catch {
    return fallback;
  }
}

function readLegacyNdjson(filePath) {
  let content;
  try {
    content = readManagedFile(filePath, {
      encoding: 'utf8',
      label: 'Legacy NDJSON source',
    });
  } catch {
    return [];
  }
  if (!content?.trim()) return [];
  return content.split('\n').map((line) => {
    try {
      return line ? JSON.parse(line) : null;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function sessionDir(id) {
  return path.join(SESSIONS_DIR, safeId(id));
}

function sessionLatestLogFile(id) {
  return path.join(sessionDir(id), 'latest.log');
}

function sessionAttemptOutputDir(id) {
  return path.join(sessionDir(id), 'attempt-output');
}

function sessionExternalAttemptOutputDir(id) {
  return path.join(sessionDir(id), 'external-attempt-output');
}

function sessionSkillReportArtifactDir(id, reportId = '') {
  const root = path.join(sessionDir(id), 'skill-report-artifacts');
  return reportId ? path.join(root, safeId(reportId)) : root;
}

function skillReportArtifactExtension(kind) {
  return kind === 'failure-analysis-markdown' ? '.md' : '.html';
}

function skillReportArtifactFile(taskId, reportId, artifactId, kind = 'pytest-html') {
  return path.join(
    sessionSkillReportArtifactDir(taskId, reportId),
    `${safeId(artifactId)}${skillReportArtifactExtension(kind)}`,
  );
}

function skillReportArtifactResourceDir(taskId, reportId, artifactId) {
  return path.join(
    sessionSkillReportArtifactDir(taskId, reportId),
    `${safeId(artifactId)}.resources`,
  );
}

function skillReportArtifactResourceFile(taskId, reportId, artifactId, resourceId, extension = '') {
  return path.join(
    skillReportArtifactResourceDir(taskId, reportId, artifactId),
    `${safeId(resourceId)}${extension}`,
  );
}

function externalAttemptArchiveFile(taskId, attemptId) {
  return path.join(sessionExternalAttemptOutputDir(taskId), `${safeId(attemptId)}.log`);
}

function sessionAttemptOutputFile(id, attemptId, stream) {
  if (!['stdout', 'stderr'].includes(stream)) throw statusError('Attempt output stream must be stdout or stderr', 400);
  return path.join(sessionAttemptOutputDir(id), `${safeId(attemptId)}.${stream}.log`);
}

function ensureSessionStorage(id) {
  ensureManagedDirectory(SESSIONS_DIR, {
    label: 'Session storage root',
  });
  ensureManagedDirectory(sessionDir(id), {
    label: 'Session storage directory',
  });
}

function attemptOutputEvidence(taskId, attemptId) {
  const evidence = {};
  for (const stream of ['stdout', 'stderr']) {
    const filePath = sessionAttemptOutputFile(taskId, attemptId, stream);
    try {
      const stat = fs.lstatSync(filePath);
      evidence[`${stream}Available`] = stat.isFile() && !stat.isSymbolicLink();
      evidence[`${stream}Bytes`] = evidence[`${stream}Available`] ? stat.size : 0;
    } catch {
      evidence[`${stream}Available`] = false;
      evidence[`${stream}Bytes`] = 0;
    }
  }
  evidence.stdoutFormat = detectAttemptStdoutFormat(
    sessionAttemptOutputFile(taskId, attemptId, 'stdout'),
    evidence.stdoutAvailable,
  );
  return evidence;
}

function detectAttemptStdoutFormat(filePath, available) {
  if (!available) return 'raw';
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) return 'raw';
    const buffer = Buffer.allocUnsafe(Math.min(stat.size, 4096));
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, length).toString('utf8').split(/\r?\n/, 1)[0].trim();
    if (!firstLine) return 'raw';
    const event = JSON.parse(firstLine);
    return event && typeof event === 'object' && [
      'thread.started',
      'turn.started',
      'item.started',
      'item.completed',
      'turn.completed',
      'turn.failed',
      'error',
    ].includes(event.type) ? 'codex-jsonl' : 'raw';
  } catch {
    return 'raw';
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function prepareAttemptOutputFiles(taskId, attemptId) {
  const normalizedTaskId = safeId(taskId);
  const normalizedAttemptId = String(attemptId || '');
  const attempt = ensureStorage().prepare('SELECT id FROM attempts WHERE id=? AND task_id=?')
    .get(normalizedAttemptId, normalizedTaskId);
  if (!attempt) throw statusError(`Attempt ${normalizedAttemptId} does not belong to session ${normalizedTaskId}`, 404);
  ensureSessionStorage(normalizedTaskId);
  ensureManagedDirectory(sessionAttemptOutputDir(normalizedTaskId), {
    label: 'Attempt output directory',
  });
  const result = {};
  for (const stream of ['stdout', 'stderr']) {
    const filePath = sessionAttemptOutputFile(normalizedTaskId, normalizedAttemptId, stream);
    writeManagedFile(filePath, '', {
      mode: 0o600,
      label: `Attempt ${stream} output file`,
    });
    result[stream] = filePath;
  }
  return result;
}

function prepareSessionBridgeOutputFile(taskId) {
  const normalizedTaskId = safeId(taskId);
  ensureSessionStorage(normalizedTaskId);
  ensureManagedDirectory(sessionAttemptOutputDir(normalizedTaskId), {
    label: 'Attempt output directory',
  });
  const filePath = path.join(sessionDir(normalizedTaskId), 'bridge-output.txt');
  writeManagedFile(filePath, '', {
    mode: 0o600,
    label: 'Bridge result file',
  });
  return filePath;
}

function getAttemptOutput(taskId, attemptId, stream) {
  const normalizedTaskId = safeId(taskId);
  const normalizedAttemptId = String(attemptId || '');
  const attempt = ensureStorage().prepare('SELECT id, status FROM attempts WHERE id=? AND task_id=?')
    .get(normalizedAttemptId, normalizedTaskId);
  if (!attempt) return null;
  const filePath = sessionAttemptOutputFile(normalizedTaskId, normalizedAttemptId, stream);
  const evidence = attemptOutputEvidence(normalizedTaskId, normalizedAttemptId);
  return evidence[`${stream}Available`] ? { filePath, status: attempt.status } : null;
}

function getAttemptOutputFile(taskId, attemptId, stream) {
  return getAttemptOutput(taskId, attemptId, stream)?.filePath || '';
}

function parseFrontmatter(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: String(content || '') };
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const part = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!part) continue;
    frontmatter[part[1]] = part[2].replace(/^"(.*)"$/, '$1').trim();
  }
  return { frontmatter, body: String(content || '').slice(match[0].length) };
}

function summarizeSkillContent(body) {
  return String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#')) || '';
}

function readSkillMarkdownFile(baseDir) {
  const fileName = ['SKILL.md', 'skill.md'].find((name) => fileExists(path.join(baseDir, name)));
  if (!fileName) return null;
  const filePath = path.join(baseDir, fileName);
  let raw;
  let stat;
  try {
    stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  const title = body.match(/^#\s+(.+)$/m);
  return {
    filePath,
    stat,
    raw,
    frontmatter,
    inferredName: title ? title[1].trim() : '',
    inferredDescription: summarizeSkillContent(body),
  };
}

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    objective: row.objective,
    workingDir: row.working_dir,
    notes: row.notes,
    enabled: Boolean(row.enabled),
    status: row.status,
    summary: row.summary,
    lastRunAt: row.last_run_at,
    lastFinishedAt: row.last_finished_at,
    archivedAt: row.archived_at,
    runCount: Number(row.run_count),
    currentPid: row.current_pid,
    currentPidStartTicks: row.current_pid_start_ticks || '',
    currentProcessGroupId: row.current_process_group_id,
    persistentSessionKey: row.persistent_session_key,
    bridgeSessionKey: row.persistent_session_key,
    autoResume: Boolean(row.auto_resume),
    maxRetries: Number(row.max_retries),
    retryCount: Number(row.retry_count),
    recoveryCount: Number(row.recovery_count || 0),
    lastBrief: row.last_brief,
    lastError: row.last_error,
    recoveryState: row.recovery_state,
    skillSnapshotId: row.skill_snapshot_id || '',
    version: Number(row.version),
    leaseOwner: row.lease_owner || '',
    leaseExpiresAt: row.lease_expires_at || '',
    cancelRequested: Boolean(row.cancel_requested),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function enrichSessionsWithScheduling(db, sessions) {
  if (!sessions.length) return sessions;
  const ids = sessions.map((session) => session.id);
  const placeholders = ids.map(() => '?').join(',');
  const externalCounts = new Map(db.prepare(`
    SELECT task_id, COUNT(*) AS count
    FROM external_attempts
    WHERE status IN (${ACTIVE_EXTERNAL_STATUSES.map(() => '?').join(',')})
      AND task_id IN (${placeholders})
    GROUP BY task_id
  `).all(...ACTIVE_EXTERNAL_STATUSES, ...ids).map((row) => [row.task_id, Number(row.count)]));
  const schedules = new Map(db.prepare(`
    SELECT task_id, COUNT(*) AS count, MIN(due_at) AS next_due_at
    FROM scheduled_jobs
    WHERE status IN (${ACTIVE_SCHEDULE_STATUSES.map(() => '?').join(',')})
      AND task_id IN (${placeholders})
    GROUP BY task_id
  `).all(...ACTIVE_SCHEDULE_STATUSES, ...ids)
    .map((row) => [row.task_id, { count: Number(row.count), nextDueAt: row.next_due_at || '' }]));
  return sessions.map((session) => ({
    ...session,
    activeExternalAttempts: externalCounts.get(session.id) || 0,
    activeScheduledJobs: schedules.get(session.id)?.count || 0,
    nextScheduledAt: schedules.get(session.id)?.nextDueAt || '',
  }));
}

function rowToSkill(row, content = undefined) {
  if (!row) return null;
  const skill = {
    id: row.id,
    sourceKey: row.source_key,
    name: row.name,
    category: row.category,
    description: row.description,
    tags: parseJson(row.tags_json, []),
    enabled: Boolean(row.enabled),
    origin: row.origin,
    readOnly: Boolean(row.read_only),
    version: Number(row.current_version),
    fileCount: Number(row.file_count || 1),
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (content !== undefined) skill.content = content;
  return skill;
}

function skillVersionFiles(db, skillId, version) {
  const rows = db.prepare(`
    SELECT file_path, content, mode, content_hash
    FROM skill_version_files
    WHERE skill_id=? AND version=?
    ORDER BY file_path
  `).all(skillId, Number(version));
  return rows.map((row) => ({
    path: row.file_path,
    content: Buffer.from(row.content),
    mode: Number(row.mode),
    contentHash: row.content_hash,
  }));
}

function insertSkillVersionFiles(db, skillId, version, files) {
  const insert = db.prepare(`
    INSERT INTO skill_version_files(skill_id, version, file_path, content, mode, content_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const file of files) {
    insert.run(skillId, Number(version), file.path, file.content, file.mode, file.contentHash);
  }
}

function isLegacyExecutionEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.agentId || event.runId || event.phaseId || event.stepId) return true;
  if (['agent', 'orchestration', 'run', 'phase', 'step'].includes(event.scope)) return true;
  if (['agent', 'orchestration', 'run', 'phase', 'step'].includes(event.entityType)) return true;
  if (/^(agent|orchestration|run|phase|step|codex)\./.test(String(event.kind || ''))) return true;
  if (/^session\.codex\./.test(String(event.kind || ''))) return true;
  return Boolean(event.payload?.session && (
    event.payload.session.agentId
    || event.payload.session.lastThreadId
    || Object.prototype.hasOwnProperty.call(event.payload.session, 'model')
  ));
}

function migrateLegacyData(db) {
  const migrated = db.prepare("SELECT value FROM metadata WHERE key = 'legacy_migration_v3'").get();
  if (migrated) return;

  const insertTask = db.prepare(`
    INSERT OR IGNORE INTO tasks (
      id, name, objective, working_dir, notes, enabled, status, summary,
      last_run_at, last_finished_at, archived_at, run_count, current_pid,
      persistent_session_key, auto_resume, max_retries, retry_count,
      last_brief, last_error, recovery_state, created_at, updated_at
    ) VALUES (
      @id, @name, @objective, @working_dir, @notes, @enabled, @status, @summary,
      @last_run_at, @last_finished_at, @archived_at, @run_count, NULL,
      @persistent_session_key, @auto_resume, @max_retries, @retry_count,
      @last_brief, @last_error, @recovery_state, @created_at, @updated_at
    )
  `);
  const insertWorklog = db.prepare(`
    INSERT OR IGNORE INTO worklog_events
      (id, task_id, turn_id, sequence, ts, level, kind, message, payload_json)
    VALUES (@id, @task_id, NULL, @sequence, @ts, @level, @kind, @message, @payload_json)
  `);
  const insertAudit = db.prepare(`
    INSERT OR IGNORE INTO audit_events
      (id, ts, actor, request_id, level, scope, kind, message, task_id, entity_type, entity_id, payload_json)
    VALUES (@id, @ts, 'migration', '', @level, @scope, @kind, @message, @task_id, @entity_type, @entity_id, @payload_json)
  `);

  db.transaction(() => {
    if (fileExists(SESSIONS_DIR)) {
      for (const entry of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const legacy = readLegacyJson(path.join(SESSIONS_DIR, entry.name, 'session.json'), null);
        if (!legacy?.id) continue;
        const now = nowIso();
        const status = normalizeLegacyStatus(legacy.status);
        insertTask.run({
          id: safeId(legacy.id),
          name: String(legacy.name || legacy.id),
          objective: String(legacy.objective || ''),
          working_dir: String(legacy.workingDir || '.'),
          notes: String(legacy.notes || ''),
          enabled: legacy.enabled === false ? 0 : 1,
          status,
          summary: String(legacy.summary || ''),
          last_run_at: String(legacy.lastRunAt || ''),
          last_finished_at: String(legacy.lastFinishedAt || ''),
          archived_at: status === 'completed' ? String(legacy.archivedAt || legacy.lastFinishedAt || now) : '',
          run_count: Number(legacy.runCount || 0),
          persistent_session_key: String(legacy.persistentSessionKey || legacy.bridgeSessionKey || ''),
          auto_resume: legacy.autoResume === false ? 0 : 1,
          max_retries: Number(legacy.maxRetries ?? 2),
          retry_count: Number(legacy.retryCount || 0),
          last_brief: String(legacy.lastBrief || ''),
          last_error: String(legacy.lastError || ''),
          recovery_state: status === 'completed' ? 'archived' : String(legacy.recoveryState || status),
          created_at: String(legacy.createdAt || now),
          updated_at: String(legacy.updatedAt || now),
        });
        const events = readLegacyNdjson(path.join(SESSIONS_DIR, entry.name, 'worklog.ndjson'))
          .filter((event) => !isLegacyExecutionEvent(event));
        events.forEach((event, index) => insertWorklog.run({
          id: String(event.id || eventId('migrated-worklog')),
          task_id: safeId(legacy.id),
          sequence: index + 1,
          ts: String(event.ts || now),
          level: String(event.level || 'info'),
          kind: String(event.kind || 'event'),
          message: preserveString(event.message || ''),
          payload_json: event.payload ? JSON.stringify(preserveValue(event.payload)) : null,
        }));
      }
    }

    if (fileExists(AUDIT_FILE)) {
      for (const event of readLegacyNdjson(AUDIT_FILE).filter((item) => !isLegacyExecutionEvent(item))) {
        insertAudit.run({
          id: String(event.id || eventId('migrated-audit')),
          ts: String(event.ts || nowIso()),
          level: String(event.level || 'info'),
          scope: String(event.scope || 'session'),
          kind: String(event.kind || 'event'),
          message: preserveString(event.message || ''),
          task_id: String(event.sessionId || ''),
          entity_type: String(event.entityType || ''),
          entity_id: String(event.entityId || ''),
          payload_json: event.payload ? JSON.stringify(preserveValue(event.payload)) : null,
        });
      }
    }

    if (isRegularDirectory(SKILLS_DIR)) {
      for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const meta = readLegacyJson(path.join(SKILLS_DIR, entry.name, 'meta.json'), null);
        if (!meta) continue;
        const contentPath = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
        let content = '';
        try {
          content = readManagedFile(contentPath, {
            encoding: 'utf8',
            label: 'Legacy Skill source',
          }) || '';
        } catch {}
        const id = safeId(meta.id || entry.name);
        const now = String(meta.updatedAt || meta.createdAt || nowIso());
        const hash = hashContent(content);
        db.prepare(`
          INSERT OR IGNORE INTO skills
            (id, source_key, origin, name, category, description, tags_json, enabled, read_only,
             current_version, source_path, content_hash, created_at, updated_at)
          VALUES (?, ?, 'managed', ?, ?, ?, ?, ?, 0, 1, '', ?, ?, ?)
        `).run(
          id, `managed:${id}`, String(meta.name || id), String(meta.category || 'General'),
          String(meta.description || ''), JSON.stringify(unique(toArray(meta.tags))), meta.enabled === false ? 0 : 1,
          hash, String(meta.createdAt || now), now,
        );
        db.prepare(`
          INSERT OR IGNORE INTO skill_versions(skill_id, version, content, content_hash, created_at)
          VALUES (?, 1, ?, ?, ?)
        `).run(id, content, hash, now);
      }
    }

    db.prepare("INSERT INTO metadata(key, value) VALUES ('legacy_migration_v3', ?)").run(nowIso());
  }).immediate();
}

function reconcileStagedTaskFiles(db) {
  const getTaskGeneration = db.prepare('SELECT created_at FROM tasks WHERE id=?');
  for (const parent of [SESSIONS_DIR, SKILL_SNAPSHOTS_DIR]) {
    ensureManagedDirectory(parent, {
      label: 'Staged task storage root',
    });
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^([a-z0-9][a-z0-9_-]{0,63})\.deleting-(?:([0-9a-f]{16})-)?[0-9a-f-]+$/i);
      if (!match) continue;
      const taskId = match[1].toLowerCase();
      const stagedGeneration = match[2] || '';
      const tombstone = path.join(parent, entry.name);
      const target = path.join(parent, taskId);
      const current = getTaskGeneration.get(taskId);
      const sameGeneration = current && (!stagedGeneration
        || hashContent(current.created_at).slice(0, 16) === stagedGeneration.toLowerCase());
      if (sameGeneration && !fileExists(target)) {
        fs.renameSync(tombstone, target);
      } else {
        removeTree(tombstone);
      }
    }
  }
}

function ensureStorage() {
  ensureManagedDirectory(DATA_DIR, {
    recursive: true,
    label: 'Platform data directory',
  });
  ensureManagedDirectory(SESSIONS_DIR, {
    label: 'Session storage root',
  });
  ensureManagedDirectory(RUNTIME_DIR, {
    recursive: true,
    label: 'Platform runtime directory',
  });
  ensureManagedDirectory(SKILL_SNAPSHOTS_DIR, {
    label: 'Skill snapshot storage root',
  });
  const db = getDatabase();
  if (initializedDatabase !== db) {
    secureManagedTree(DATA_DIR);
    migrateLegacyData(db);
    reconcileStagedTaskFiles(db);
    repairPlaceholderExternalAttemptDetections(db);
    initializedDatabase = db;
  }
  return db;
}

function discoverSourceSkillFiles() {
  const found = [];
  const seenRoots = new Set();
  const roots = [
    { directory: CODEX_SOURCE_SKILLS_DIR, sourcePrefix: 'codex', qualifiedPrefix: 'codex', category: 'Codex' },
    {
      directory: WORKSPACE_CODEX_SKILLS_DIR,
      sourcePrefix: 'workspace',
      qualifiedPrefix: 'workspace',
      category: 'Workspace Codex',
    },
  ].filter(({ directory }) => {
    const root = path.resolve(directory);
    if (!fileExists(root) || seenRoots.has(root)) return false;
    seenRoots.add(root);
    return true;
  });
  const visit = (rootConfig, root, dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const markdown = readSkillMarkdownFile(dir);
    if (markdown && dir !== root) {
      found.push({
        ...rootConfig,
        relativeDir: path.relative(root, dir),
        directory: dir,
        markdown,
      });
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue;
      const child = path.resolve(dir, entry.name);
      if (child.startsWith(`${root}${path.sep}`)) visit(rootConfig, root, child);
    }
  };
  for (const rootConfig of roots) {
    const root = path.resolve(rootConfig.directory);
    visit(rootConfig, root, root);
  }
  return found.sort((left, right) => {
    const leftKey = `${left.sourcePrefix}:${left.relativeDir}`;
    const rightKey = `${right.sourcePrefix}:${right.relativeDir}`;
    return leftKey.localeCompare(rightKey);
  });
}

function readSourceSkillDirectory(directory, markdownPath, skillRoots) {
  const files = [];
  const visit = (current) => {
    if (current !== directory && skillRoots.has(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        const relativePath = absolutePath === markdownPath
          ? 'SKILL.md'
          : path.relative(directory, absolutePath).split(path.sep).join('/');
        files.push({ path: relativePath, content: fs.readFileSync(absolutePath), mode: fs.statSync(absolutePath).mode });
      }
    }
  };
  visit(directory);
  return normalizeSkillFiles(files);
}

function refreshSourceSkills(force = false) {
  const db = ensureStorage();
  if (!force && Date.now() < skillsCacheExpiresAt) return;
  if (platformMaintenanceFromDatabase(db)) return;
  const discovered = discoverSourceSkillFiles();
  const baseCounts = new Map();
  for (const item of discovered) {
    const base = safeId(path.basename(item.relativeDir));
    baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
  }
  const managedIds = new Set(db.prepare("SELECT id FROM skills WHERE origin = 'managed'").all().map((row) => row.id));
  const existingSources = new Map(db.prepare("SELECT id, source_key FROM skills WHERE origin = 'codex'").all()
    .map((row) => [row.source_key, row.id]));
  const skillRoots = new Set(discovered.map((item) => item.directory));
  const drafts = discovered.map(({
    relativeDir, directory, markdown, sourcePrefix, qualifiedPrefix, category,
  }) => {
    const base = safeId(path.basename(relativeDir));
    const qualified = `${qualifiedPrefix}-${safeId(relativeDir.replace(/[\\/]+/g, '-'))}`;
    const candidateId = baseCounts.get(base) === 1 && !managedIds.has(base) ? base : qualified;
    const { frontmatter, raw, inferredName, inferredDescription, stat } = markdown;
    const files = readSourceSkillDirectory(directory, markdown.filePath, skillRoots);
    return {
      candidateId,
      sourceKey: `${sourcePrefix}:${relativeDir.split(path.sep).join('/')}`,
      name: frontmatter.name || inferredName || candidateId,
      category: frontmatter.category || category,
      description: frontmatter.description || inferredDescription || '',
      tags: unique(toArray(frontmatter.tags)),
      content: raw,
      files,
      contentHash: hashSkillFiles(files),
      sourcePath: markdown.filePath,
      createdAt: stat.birthtime?.toISOString?.() || stat.mtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
    };
  });
  const candidateCounts = new Map();
  for (const draft of drafts) {
    candidateCounts.set(draft.candidateId, (candidateCounts.get(draft.candidateId) || 0) + 1);
  }
  const occupiedIds = new Set(managedIds);
  const records = drafts.map(({ candidateId, ...record }) => {
    const forceHash = candidateCounts.get(candidateId) !== 1
      || managedIds.has(candidateId)
      || candidateId.length > 64;
    const existingId = existingSources.get(record.sourceKey);
    const id = existingId && !occupiedIds.has(existingId)
      ? existingId
      : boundedSourceSkillId(candidateId, record.sourceKey, forceHash, occupiedIds);
    occupiedIds.add(id);
    return { ...record, id };
  });

  db.transaction(() => {
    assertNoPlatformMaintenance(db);
    const sourceKeys = new Set(records.map((record) => record.sourceKey));
    const deleteSource = db.prepare("DELETE FROM skills WHERE origin='codex' AND source_key=?");
    for (const sourceKey of existingSources.keys()) {
      if (!sourceKeys.has(sourceKey)) deleteSource.run(sourceKey);
    }
    const insertSkill = db.prepare(`
      INSERT INTO skills
        (id, source_key, origin, name, category, description, tags_json, enabled, read_only,
         current_version, source_path, content_hash, created_at, updated_at)
      VALUES (@id, @sourceKey, 'codex', @name, @category, @description, @tags, 1, 1,
              1, @sourcePath, @contentHash, @createdAt, @updatedAt)
      ON CONFLICT(source_key) DO UPDATE SET
        name=excluded.name, category=excluded.category, description=excluded.description,
        tags_json=excluded.tags_json, read_only=1, current_version=1,
        source_path=excluded.source_path, content_hash=excluded.content_hash,
        created_at=excluded.created_at, updated_at=excluded.updated_at
    `);
    const insertVersion = db.prepare(`
      INSERT INTO skill_versions(skill_id, version, content, content_hash, created_at)
      VALUES (?, 1, ?, ?, ?)
    `);
    for (const record of records) {
      const previous = db.prepare('SELECT id, content_hash FROM skills WHERE source_key=?').get(record.sourceKey);
      insertSkill.run({ ...record, tags: JSON.stringify(record.tags) });
      const skillId = previous?.id || record.id;
      if (!previous || previous.content_hash !== record.contentHash) {
        db.prepare('DELETE FROM skill_versions WHERE skill_id=?').run(skillId);
        insertVersion.run(skillId, record.content, record.contentHash, record.updatedAt);
        insertSkillVersionFiles(db, skillId, 1, record.files);
      }
    }
  }).immediate();
  skillsCacheExpiresAt = Date.now() + SKILL_CACHE_TTL_MS;
}

function skillContent(id, version = null) {
  const db = ensureStorage();
  const skillId = String(id || '').trim();
  if (version == null) {
    return db.prepare(`
      SELECT v.content FROM skills s
      JOIN skill_versions v ON v.skill_id = s.id AND v.version = s.current_version
      WHERE s.id = ?
    `).get(skillId)?.content ?? '';
  }
  return db.prepare('SELECT content FROM skill_versions WHERE skill_id = ? AND version = ?')
    .get(skillId, Number(version))?.content ?? '';
}

function listSkills() {
  refreshSourceSkills();
  const db = ensureStorage();
  return db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM skill_version_files f
      WHERE f.skill_id=s.id AND f.version=s.current_version) AS file_count
    FROM skills s ORDER BY updated_at DESC, id ASC
  `).all()
    .map((row) => rowToSkill(row, skillContent(row.id)));
}

function listSkillSummaries() {
  refreshSourceSkills();
  return ensureStorage().prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM skill_version_files f
      WHERE f.skill_id=s.id AND f.version=s.current_version) AS file_count
    FROM skills s ORDER BY updated_at DESC, id ASC
  `).all()
    .map((row) => rowToSkill(row));
}

function listManagedSkills() {
  return ensureStorage().prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM skill_version_files f
      WHERE f.skill_id=s.id AND f.version=s.current_version) AS file_count
    FROM skills s WHERE origin = 'managed' ORDER BY updated_at DESC
  `).all()
    .map((row) => rowToSkill(row, skillContent(row.id)));
}

function countSkills() {
  refreshSourceSkills();
  return Number(ensureStorage().prepare('SELECT COUNT(*) AS count FROM skills').get().count);
}

function getSkill(id) {
  refreshSourceSkills();
  const row = ensureStorage().prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM skill_version_files f
      WHERE f.skill_id=s.id AND f.version=s.current_version) AS file_count
    FROM skills s WHERE id = ?
  `).get(String(id || '').trim());
  return rowToSkill(row, row ? skillContent(row.id) : undefined);
}

function saveSkill(id, data, context = {}) {
  const db = ensureStorage();
  assertNoPlatformMaintenance(db);
  refreshSourceSkills();
  const normalizedId = canonicalManagedSkillId(id);
  let saved;
  db.transaction(() => {
    assertNoPlatformMaintenance(db);
    const existing = db.prepare('SELECT * FROM skills WHERE id = ?').get(normalizedId);
    if (existing && context.createOnly) throw statusError(`Skill ${normalizedId} already exists`, 409);
    if (existing?.origin === 'codex') throw statusError(`Codex skill ${normalizedId} is read-only`, 409);
    validateSkillBody({ ...data, id: normalizedId }, { creating: !existing, requireId: true });
    const now = nowIso();
    let files;
    if (data.files != null) {
      files = normalizeSkillFiles(data.files, data.content);
    } else if (existing) {
      const currentFiles = skillVersionFiles(db, normalizedId, existing.current_version);
      const existingFiles = currentFiles.length
        ? currentFiles
        : normalizeSkillFiles(null, skillContent(normalizedId, existing.current_version));
      files = data.content === undefined
        ? existingFiles
        : normalizeSkillFiles(existingFiles.map((file) => (
          file.path === 'SKILL.md' ? { ...file, content: Buffer.from(String(data.content), 'utf8') } : file
        )));
    } else {
      files = normalizeSkillFiles(null, data.content);
    }
    const content = files.find((file) => file.path === 'SKILL.md').content.toString('utf8');
    const contentHash = hashSkillFiles(files);
    const version = existing && existing.content_hash === contentHash
      ? Number(existing.current_version)
      : Number(existing?.current_version || 0) + 1;
    const payload = {
      id: normalizedId,
      sourceKey: `managed:${normalizedId}`,
      name: String(data.name ?? existing?.name ?? normalizedId).trim(),
      category: String(data.category ?? existing?.category ?? 'General').trim(),
      description: String(data.description ?? existing?.description ?? '').trim(),
      tags: JSON.stringify(unique(toArray(data.tags ?? parseJson(existing?.tags_json, [])))),
      enabled: (data.enabled ?? (existing ? Boolean(existing.enabled) : true)) ? 1 : 0,
      version,
      contentHash,
      createdAt: existing?.created_at || now,
      updatedAt: now,
    };
    db.prepare(`
      INSERT INTO skills
        (id, source_key, origin, name, category, description, tags_json, enabled, read_only,
         current_version, source_path, content_hash, created_at, updated_at)
      VALUES (@id, @sourceKey, 'managed', @name, @category, @description, @tags, @enabled, 0,
              @version, '', @contentHash, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, category = excluded.category, description = excluded.description,
        tags_json = excluded.tags_json, enabled = excluded.enabled,
        current_version = excluded.current_version, content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `).run(payload);
    if (!existing || existing.content_hash !== contentHash) {
      db.prepare(`
        INSERT INTO skill_versions(skill_id, version, content, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(normalizedId, version, content, contentHash, now);
      insertSkillVersionFiles(db, normalizedId, version, files);
    }
    appendAuditEvent({
      scope: 'config', entityType: 'skill', entityId: normalizedId,
      kind: existing ? 'skill.updated' : 'skill.created',
      message: `${existing ? 'Updated' : 'Created'} skill ${normalizedId}`,
      payload: { version, contentHash, fileCount: files.length },
      actor: context.actor || 'operator', requestId: context.requestId || '',
    }, db);
    saved = rowToSkill({ ...db.prepare('SELECT * FROM skills WHERE id=?').get(normalizedId), file_count: files.length }, content);
  }).immediate();
  skillsCacheExpiresAt = 0;
  return saved;
}

function deleteSkill(id, context = {}) {
  const db = ensureStorage();
  const normalizedId = String(id || '').trim();
  let deleted = false;
  db.transaction(() => {
    assertNoPlatformMaintenance(db);
    const existing = db.prepare('SELECT origin FROM skills WHERE id = ?').get(normalizedId);
    if (!existing) return;
    if (existing.origin === 'codex') throw statusError(`Codex skill ${normalizedId} is read-only`, 409);
    db.prepare('DELETE FROM skills WHERE id = ?').run(normalizedId);
    appendAuditEvent({
      scope: 'config', entityType: 'skill', entityId: normalizedId,
      kind: 'skill.deleted', level: 'warn', message: `Deleted skill ${normalizedId}`,
      actor: context.actor || 'operator', requestId: context.requestId || '',
    }, db);
    deleted = true;
  }).immediate();
  skillsCacheExpiresAt = 0;
  return deleted;
}

function setSkillEnabled(id, enabled, context = {}) {
  if (typeof enabled !== 'boolean') throw statusError('enabled must be a boolean', 400);
  refreshSourceSkills();
  const db = ensureStorage();
  const normalizedId = String(id || '').trim();
  let updated;
  db.transaction(() => {
    assertNoPlatformMaintenance(db);
    const existing = db.prepare('SELECT * FROM skills WHERE id=?').get(normalizedId);
    if (!existing) throw statusError(`Skill ${normalizedId} not found`, 404);
    const now = nowIso();
    db.prepare('UPDATE skills SET enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, now, normalizedId);
    appendAuditEvent({
      scope: 'config', entityType: 'skill', entityId: normalizedId,
      kind: enabled ? 'skill.enabled' : 'skill.disabled',
      message: `${enabled ? 'Enabled' : 'Disabled'} skill ${normalizedId}`,
      payload: { origin: existing.origin, enabled },
      actor: context.actor || 'operator', requestId: context.requestId || '',
    }, db);
    updated = rowToSkill({ ...existing, enabled: enabled ? 1 : 0, updated_at: now });
  }).immediate();
  return updated;
}

function importSkillArchive(skills, options = {}, context = {}) {
  if (!Array.isArray(skills) || !skills.length) throw statusError('Skill archive contains no Skills', 400);
  const overwrite = options.overwrite === true;
  const ids = new Set();
  const prepared = skills.map((skill) => {
    validateSkillBody(skill, { creating: true, requireId: true });
    const id = canonicalManagedSkillId(skill.id);
    if (ids.has(id)) throw statusError(`Duplicate imported skill id: ${id}`, 400);
    ids.add(id);
    return { ...skill, id, files: normalizeSkillFiles(skill.files, skill.content) };
  });
  refreshSourceSkills();
  const db = ensureStorage();
  let imported;
  db.transaction(() => {
    assertNoPlatformMaintenance(db);
    for (const skill of prepared) {
      const existing = db.prepare('SELECT origin FROM skills WHERE id=?').get(skill.id);
      if (existing?.origin === 'codex') throw statusError(`Codex skill ${skill.id} is read-only`, 409);
      if (existing && !overwrite) throw statusError(`Skill ${skill.id} already exists`, 409);
    }
    imported = prepared.map((skill) => saveSkill(skill.id, skill, {
      ...context,
      createOnly: !overwrite,
    }));
    appendAuditEvent({
      scope: 'config', entityType: 'skill_archive', entityId: 'zip',
      kind: 'skill.archive.imported',
      message: `Imported ${imported.length} Skill${imported.length === 1 ? '' : 's'} from ZIP`,
      payload: { overwrite, skills: imported.map((skill) => ({ id: skill.id, version: skill.version, fileCount: skill.fileCount })) },
      actor: context.actor || 'operator', requestId: context.requestId || '',
    }, db);
  }).immediate();
  skillsCacheExpiresAt = 0;
  return imported;
}

function listSessions(options = null) {
  const db = ensureStorage();
  if (!options) {
    return enrichSessionsWithScheduling(
      db,
      db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC, id ASC').all().map(rowToSession),
    );
  }
  const clauses = [];
  const params = [];
  const statuses = Array.isArray(options.statuses)
    ? options.statuses.filter(Boolean)
    : String(options.status || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (statuses.length) {
    clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  const maxPageSize = options.internal ? MAX_QUERY_LIMIT : MAX_SESSION_PAGE_SIZE;
  const limit = Math.min(maxPageSize, boundedLimit(options.limit, 100));
  const offset = boundedOffset(options.offset);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return enrichSessionsWithScheduling(
    db,
    db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map(rowToSession),
  );
}

function sessionStats() {
  const counts = Object.fromEntries(ensureStorage().prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status')
    .all().map((row) => [row.status, Number(row.count)]));
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const count = (...statuses) => statuses.reduce((sum, status) => sum + Number(counts[status] || 0), 0);
  return {
    sessions: total,
    currentSessions: total - count('completed'),
    activeSessions: count(...ACTIVE_STATUSES),
    completedSessions: count('completed'),
    recoverableSessions: count('failed', 'interrupted', 'stopped'),
    reviewSessions: count('waiting_review', 'waiting_input'),
  };
}

function countExecutingSessions() {
  return Number(ensureStorage().prepare(`
    SELECT COUNT(*) AS count FROM tasks WHERE status IN ('running','recovering','stopping')
  `).get().count);
}

function checkStateInvariants() {
  const db = ensureStorage();
  const scalar = (sql) => Number(db.prepare(sql).get().count);
  const violations = {
    activeTasksWithoutSingleRunningAttempt: scalar(`
      SELECT COUNT(*) AS count FROM tasks t
      WHERE (
        t.status IN ('running','recovering')
        OR (t.status='stopping' AND t.lease_owner IS NOT NULL AND t.lease_owner<>'')
      )
        AND (SELECT COUNT(*) FROM attempts a WHERE a.task_id=t.id AND a.status='running') <> 1
    `),
    activeTasksWithoutLease: scalar(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE status IN ('running','recovering')
        AND (lease_owner IS NULL OR lease_owner='' OR lease_expires_at IS NULL OR lease_expires_at='')
    `),
    orphanRunningAttempts: scalar(`
      SELECT COUNT(*) AS count FROM attempts a
      JOIN tasks t ON t.id=a.task_id
      WHERE a.status='running'
        AND (t.status NOT IN ('running','recovering','stopping') OR t.lease_owner<>a.worker_id)
    `),
    activeProcessIdentityMismatches: scalar(`
      SELECT COUNT(*) AS count FROM tasks t
      WHERE t.current_pid IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM attempts a
          WHERE a.task_id=t.id AND a.status='running'
            AND a.pid=t.current_pid
            AND a.pid_start_ticks=t.current_pid_start_ticks
            AND a.process_group_id=t.current_process_group_id
            AND a.pid_start_ticks<>''
        )
    `),
    unexpectedTaskLeases: scalar(`
      SELECT COUNT(*) AS count FROM tasks t
      WHERE t.status NOT IN ('running','recovering','stopping')
        AND (
          (t.lease_owner IS NOT NULL AND t.lease_owner<>'')
          OR (t.lease_expires_at IS NOT NULL AND t.lease_expires_at<>'')
        )
        AND NOT (
          t.status='queued'
          AND EXISTS (
            SELECT 1 FROM commands c
            WHERE c.task_id=t.id AND c.status='processing' AND c.worker_id=t.lease_owner
          )
        )
    `),
    completedTasksWithActiveCommands: scalar(`
      SELECT COUNT(*) AS count FROM tasks t
      WHERE t.status='completed'
        AND EXISTS (
          SELECT 1 FROM commands c
          WHERE c.task_id=t.id AND c.status IN ('pending','processing')
        )
    `),
    completedTasksWithActiveSchedules: scalar(`
      SELECT COUNT(*) AS count FROM tasks t
      WHERE t.status='completed'
        AND EXISTS (
          SELECT 1 FROM scheduled_jobs j
          WHERE j.task_id=t.id AND j.status IN ('pending','leased','dispatched')
        )
    `),
    completedTasksWithActiveExternalAttempts: scalar(`
      SELECT COUNT(*) AS count FROM tasks t
      WHERE t.status='completed'
        AND EXISTS (
          SELECT 1 FROM external_attempts e
          WHERE e.task_id=t.id AND e.status='running'
        )
    `),
    waitingExternalWithoutSchedule: scalar(`
      SELECT COUNT(*) AS count FROM external_attempts e
      JOIN tasks t ON t.id=e.task_id
      WHERE t.status='waiting_scheduled' AND e.status='running'
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_jobs j
          WHERE j.external_attempt_id=e.id AND j.generation=e.generation
            AND j.status IN ('pending','leased','dispatched')
        )
    `),
    emptyWaitingScheduledTasks: scalar(`
      SELECT COUNT(*) AS count FROM tasks t
      WHERE t.status='waiting_scheduled'
        AND NOT EXISTS (SELECT 1 FROM external_attempts e WHERE e.task_id=t.id AND e.status='running')
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_jobs j
          WHERE j.task_id=t.id AND j.status IN ('pending','leased','dispatched')
        )
    `),
    archivedExternalAttemptsWithoutEvidence: scalar(`
      SELECT COUNT(*) AS count FROM external_attempts
      WHERE archive_status='archived'
        AND (archived_log_path='' OR archived_log_bytes IS NULL
          OR archived_log_sha256 NOT GLOB '[0-9a-f][0-9a-f]*'
          OR archived_log_sha256 GLOB '*[^0-9a-f]*'
          OR LENGTH(archived_log_sha256)<>64 OR archived_at='')
    `),
    unexpectedExternalArchiveLeases: scalar(`
      SELECT COUNT(*) AS count FROM external_attempts
      WHERE archive_status<>'archiving'
        AND (archive_lease_owner<>'' OR archive_lease_expires_at<>'')
    `),
    verifiedExternalArchivesWithoutVerificationEvidence: scalar(`
      SELECT COUNT(*) AS count FROM external_attempts
      WHERE archive_verify_status='verified'
        AND (archive_status<>'archived' OR archive_verified_at='' OR archive_verify_next_at='')
    `),
    unexpectedExternalArchiveVerificationLeases: scalar(`
      SELECT COUNT(*) AS count FROM external_attempts
      WHERE archive_verify_status<>'verifying'
        AND (archive_verify_lease_owner<>'' OR archive_verify_lease_expires_at<>'')
    `),
  };
  return {
    ok: Object.values(violations).every((count) => count === 0),
    violations,
    checkedAt: nowIso(),
  };
}

function listActiveProcessIdentities() {
  return ensureStorage().prepare(`
    SELECT
      t.id AS task_id,
      t.current_pid,
      t.current_pid_start_ticks,
      t.current_process_group_id,
      t.lease_owner,
      t.updated_at,
      a.id AS attempt_id
    FROM tasks t
    LEFT JOIN attempts a
      ON a.task_id=t.id AND a.status='running' AND a.pid=t.current_pid
    WHERE t.status IN ('running','recovering','stopping')
      AND t.current_pid IS NOT NULL
    ORDER BY t.updated_at, t.id
  `).all().map((row) => ({
    taskId: row.task_id,
    attemptId: row.attempt_id || '',
    workerId: row.lease_owner || '',
    pid: row.current_pid,
    pidStartTicks: row.current_pid_start_ticks || '',
    processGroupId: row.current_process_group_id,
    updatedAt: row.updated_at,
  }));
}

function getSession(id) {
  const db = ensureStorage();
  const session = rowToSession(db.prepare('SELECT * FROM tasks WHERE id = ?').get(safeId(id)));
  return session ? enrichSessionsWithScheduling(db, [session])[0] : null;
}

function saveSessionInTransaction(db, id, data, context = {}) {
  const normalizedId = canonicalTaskId(id);
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(normalizedId);
  if (existing && context.createOnly) throw statusError(`Session ${normalizedId} already exists`, 409);
  validateTaskBody({ ...data, id: normalizedId }, { creating: !existing, requireId: true });
  const now = nowIso();
  if (existing) {
    if (existing.status === 'completed') {
      throw statusError('Completed sessions are immutable history records', 409);
    }
    if (ACTIVE_STATUSES.includes(existing.status)) {
      throw statusError('Active sessions cannot be edited', 409);
    }
    resolveWorkingDir(data.workingDir ?? existing.working_dir);
    db.prepare(`
      UPDATE tasks SET
        name = ?, objective = ?, working_dir = ?, notes = ?, enabled = ?,
        auto_resume = ?, max_retries = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(
      String(data.name ?? existing.name).trim(),
      String(data.objective ?? existing.objective).trim(),
      String(data.workingDir ?? existing.working_dir).trim() || '.',
      String(data.notes ?? existing.notes).trim(),
      (data.enabled ?? Boolean(existing.enabled)) ? 1 : 0,
      (data.autoResume ?? Boolean(existing.auto_resume)) ? 1 : 0,
      Math.min(MAX_TASK_RETRIES, Math.max(0, Number(data.maxRetries ?? existing.max_retries ?? 2))),
      now,
      normalizedId,
    );
  } else {
    const status = normalizeLegacyStatus(data.status || 'idle');
    if (!['idle', 'completed'].includes(status)) throw statusError('New sessions must start in idle state', 400);
    resolveWorkingDir(data.workingDir || '.');
    db.prepare(`
      INSERT INTO tasks (
        id, name, objective, working_dir, notes, enabled, status, summary,
        last_run_at, last_finished_at, archived_at, run_count, current_pid,
        persistent_session_key, auto_resume, max_retries, retry_count, recovery_count,
        last_brief, last_error, recovery_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedId, String(data.name || normalizedId).trim(), String(data.objective || '').trim(),
      String(data.workingDir || '.').trim() || '.', String(data.notes || '').trim(), data.enabled === false ? 0 : 1,
      status, String(data.summary || ''), String(data.lastRunAt || ''), String(data.lastFinishedAt || ''),
      status === 'completed' ? String(data.archivedAt || data.lastFinishedAt || now) : '', Number(data.runCount || 0),
      String(data.persistentSessionKey || data.bridgeSessionKey || ''), data.autoResume === false ? 0 : 1,
      Math.min(MAX_TASK_RETRIES, Math.max(0, Number(data.maxRetries ?? 2))), Number(data.retryCount || 0),
      Number(data.recoveryCount || 0), String(data.lastBrief || ''),
      String(data.lastError || ''), status === 'completed' ? 'archived' : String(data.recoveryState || status),
      String(data.createdAt || now), now,
    );
  }
  appendAuditEvent({
    scope: 'config', taskId: normalizedId, entityType: 'session', entityId: normalizedId,
    kind: existing ? 'session.updated' : 'session.created',
    message: `${existing ? 'Updated' : 'Created'} session ${normalizedId}`,
    payload: {
      id: normalizedId,
      ...(data.name != null ? { name: data.name } : {}),
      ...(data.objective != null ? { objective: data.objective } : {}),
      ...(data.workingDir != null ? { workingDir: data.workingDir } : {}),
      ...(data.notes != null ? { notes: data.notes } : {}),
      ...(data.enabled != null ? { enabled: data.enabled } : {}),
      ...(data.autoResume != null ? { autoResume: data.autoResume } : {}),
      ...(data.maxRetries != null ? { maxRetries: data.maxRetries } : {}),
    },
    actor: context.actor || 'operator', requestId: context.requestId || '',
  }, db);
  return rowToSession(db.prepare('SELECT * FROM tasks WHERE id=?').get(normalizedId));
}

function saveSession(id, data, context = {}) {
  const db = ensureStorage();
  return db.transaction(() => {
    assertNoPlatformMaintenance(db);
    return saveSessionInTransaction(db, id, data, context);
  }).immediate();
}

function updateSession(session, expectedWorkerId = '') {
  const db = ensureStorage();
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(safeId(session.id));
  if (!existing) throw statusError(`Session ${session.id} not found`, 404);
  const merged = { ...rowToSession(existing), ...session };
  const now = nowIso();
  const changed = db.prepare(`
    UPDATE tasks SET
      name=@name, objective=@objective, working_dir=@workingDir, notes=@notes, enabled=@enabled,
      status=@status, summary=@summary, last_run_at=@lastRunAt, last_finished_at=@lastFinishedAt,
      archived_at=@archivedAt, run_count=@runCount, current_pid=@currentPid,
      current_pid_start_ticks=@currentPidStartTicks, current_process_group_id=@currentProcessGroupId,
      persistent_session_key=@persistentSessionKey, auto_resume=@autoResume, max_retries=@maxRetries,
      retry_count=@retryCount, recovery_count=@recoveryCount, last_brief=@lastBrief, last_error=@lastError,
      recovery_state=@recoveryState, skill_snapshot_id=@skillSnapshotId,
      lease_owner=@leaseOwner, lease_expires_at=@leaseExpiresAt,
      cancel_requested=@cancelRequested, version=version+1, updated_at=@updatedAt
    WHERE id=@id
      AND (@expectedWorkerId = '' OR (
        lease_owner=@expectedWorkerId
        AND status IN ('running','recovering')
        AND cancel_requested=0
      ))
  `).run({
    ...merged,
    id: safeId(merged.id),
    enabled: merged.enabled === false ? 0 : 1,
    autoResume: merged.autoResume === false ? 0 : 1,
    cancelRequested: merged.cancelRequested ? 1 : 0,
    currentPid: merged.currentPid || null,
    currentPidStartTicks: merged.currentPid ? String(merged.currentPidStartTicks || '') : '',
    currentProcessGroupId: merged.currentPid ? (merged.currentProcessGroupId || null) : null,
    leaseOwner: merged.leaseOwner || null,
    leaseExpiresAt: merged.leaseExpiresAt || null,
    persistentSessionKey: merged.persistentSessionKey || merged.bridgeSessionKey || '',
    maxRetries: Math.min(MAX_TASK_RETRIES, Math.max(0, Number(merged.maxRetries || 0))),
    recoveryCount: Math.max(0, Number(merged.recoveryCount || 0)),
    skillSnapshotId: merged.skillSnapshotId || null,
    expectedWorkerId: String(expectedWorkerId || ''),
    updatedAt: now,
  });
  if (changed.changes !== 1) {
    throw statusError(`Session ${merged.id} lease or state changed before the worker update`, 409);
  }
  return getSession(merged.id);
}

function deleteSession(id, context = {}) {
  const db = ensureStorage();
  const normalizedId = safeId(id);
  const identity = sessionOperationIdentity('delete', normalizedId, context);
  const existingReceipt = readSessionOperationReceipt(db, identity);
  if (existingReceipt) return Boolean(existingReceipt.ok);
  assertNoPlatformMaintenance(db);
  const existing = getSession(normalizedId);
  if (!existing) return false;
  if (identity.expectedTaskCreatedAt && existing.createdAt !== identity.expectedTaskCreatedAt) {
    throw statusError('Task was replaced after this operation was prepared', 409);
  }
  if (existing.status === 'completed') throw statusError('Completed sessions are immutable history records', 409);
  if (ACTIVE_STATUSES.includes(existing.status)) throw statusError('Stop the active session before deleting it', 409);
  let stagedFiles = [];
  let replayedReceipt = null;
  try {
    db.transaction(() => {
      replayedReceipt = readSessionOperationReceipt(db, identity);
      if (replayedReceipt) return;
      assertNoPlatformMaintenance(db);
      const latest = db.prepare('SELECT * FROM tasks WHERE id = ?').get(normalizedId);
      if (!latest) throw statusError(`Session ${normalizedId} not found`, 404);
      assertExpectedTaskGeneration(latest, identity);
      if (latest.status === 'completed' || ACTIVE_STATUSES.includes(latest.status)) {
        throw statusError('Session state changed before deletion', 409);
      }
      if (db.prepare(`
        SELECT 1 FROM external_attempts
        WHERE task_id=? AND (archive_status='archiving' OR archive_verify_status='verifying') LIMIT 1
      `).get(normalizedId)) {
        throw statusError('Session background log archival or verification is still in progress', 409);
      }
      stagedFiles = stageTaskFilesForDeletion(normalizedId, latest.created_at);
      enqueueBridgeCleanupJob(db, latest, 'deleted', context);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(normalizedId);
      appendAuditEvent({
        scope: 'config', taskId: normalizedId, entityType: 'session', entityId: normalizedId,
        kind: 'session.deleted', level: 'warn', message: `Deleted session ${normalizedId}`,
        actor: context.actor || 'operator', requestId: context.requestId || '',
      }, db);
      writeSessionOperationReceipt(db, identity, latest.created_at, { ok: true }, context);
    }).immediate();
  } catch (error) {
    restoreStagedTaskFiles(stagedFiles);
    throw error;
  }
  if (replayedReceipt) {
    restoreStagedTaskFiles(stagedFiles);
    return Boolean(replayedReceipt.ok);
  }
  discardStagedTaskFiles(stagedFiles, normalizedId);
  return true;
}

function retentionReferenceTime(value = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw statusError('Invalid task retention reference time', 400);
  return date;
}

function retentionCutoff(value = new Date()) {
  const reference = retentionReferenceTime(value);
  return new Date(reference.getTime() - (TASK_RETENTION_DAYS * 24 * 60 * 60 * 1000)).toISOString();
}

function retentionStateFromDatabase(db) {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(TASK_RETENTION_STATUS_KEY);
  const state = row ? parseJson(row.value, {}) : {};
  return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

function writeRetentionState(db, state) {
  db.prepare(`
    INSERT INTO metadata(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(TASK_RETENTION_STATUS_KEY, JSON.stringify(state));
}

function dueRetentionTaskCount(db, cutoff) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count FROM tasks
    WHERE status='completed' AND archived_at<>'' AND archived_at<=?
  `).get(cutoff).count);
}

function taskRetentionStatus(now = new Date()) {
  const db = ensureStorage();
  const reference = retentionReferenceTime(now);
  const cutoff = retentionCutoff(reference);
  const state = retentionStateFromDatabase(db);
  const maintenance = platformMaintenanceFromDatabase(db);
  return {
    enabled: true,
    retentionDays: TASK_RETENTION_DAYS,
    batchSize: TASK_RETENTION_BATCH_SIZE,
    cutoff,
    dueTasks: dueRetentionTaskCount(db, cutoff),
    inProgress: maintenance?.kind === 'retention_cleanup',
    lastRunAt: String(state.lastRunAt || ''),
    lastSuccessAt: String(state.lastSuccessAt || ''),
    lastDeferredAt: String(state.lastDeferredAt || ''),
    lastDeferredReason: String(state.lastDeferredReason || ''),
    lastFailureAt: String(state.lastFailureAt || ''),
    lastFailureCode: String(state.lastFailureCode || ''),
    lastPurgedTasks: Number(state.lastPurgedTasks || 0),
    totalPurgedTasks: Number(state.totalPurgedTasks || 0),
    lastDeletedAuditEvents: Number(state.lastDeletedAuditEvents || 0),
    lastDeletedOperationReceipts: Number(state.lastDeletedOperationReceipts || 0),
    lastDeletedCleanupJobs: Number(state.lastDeletedCleanupJobs || 0),
  };
}

function recordRetentionDeferral(db, reference, reason) {
  const previous = retentionStateFromDatabase(db);
  writeRetentionState(db, {
    ...previous,
    lastDeferredAt: reference.toISOString(),
    lastDeferredReason: reason,
  });
}

function purgeCompletedTaskGeneration(db, candidate, cutoff, maintenanceOwner) {
  let stagedFiles = [];
  let purged = false;
  try {
    db.transaction(() => {
      const maintenance = platformMaintenanceFromDatabase(db);
      if (!maintenance || maintenance.kind !== 'retention_cleanup' || maintenance.owner !== maintenanceOwner) {
        throw statusError('Task retention maintenance lease was lost', 409);
      }
      const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(candidate.id);
      if (!task || task.created_at !== candidate.created_at
        || task.status !== 'completed' || !task.archived_at || task.archived_at > cutoff) return;
      if (taskRuntimeActivity(db, task.id).active) {
        throw statusError('Completed task still has owned runtime activity', 409);
      }
      if (db.prepare(`
        SELECT 1 FROM external_attempts
        WHERE task_id=? AND (archive_status='archiving' OR archive_verify_status='verifying') LIMIT 1
      `).get(task.id)) {
        throw statusError('Completed task log archival or verification is still in progress', 409);
      }
      if (db.prepare(`
        SELECT 1 FROM bridge_cleanup_jobs
        WHERE task_id=? AND task_created_at=? AND status='processing' LIMIT 1
      `).get(task.id, task.created_at)) {
        throw statusError('Completed task Runtime cleanup is still in progress', 409);
      }

      stagedFiles = stageTaskFilesForDeletion(task.id, task.created_at);
      const cleanupJobId = enqueueBridgeCleanupJob(db, task, 'deleted', { actor: 'system' });
      if (cleanupJobId) {
        db.prepare(`
          UPDATE bridge_cleanup_jobs SET reason='deleted', updated_at=?
          WHERE task_id=? AND task_created_at=? AND session_key=?
            AND status IN ('pending','retry')
        `).run(nowIso(), task.id, task.created_at, task.persistent_session_key);
      }
      db.prepare(`
        DELETE FROM session_operation_receipts WHERE task_id=? AND task_created_at=?
      `).run(task.id, task.created_at);
      db.prepare('DELETE FROM audit_events WHERE task_id=?').run(task.id);
      db.prepare('DELETE FROM tasks WHERE id=? AND created_at=?').run(task.id, task.created_at);
      appendAuditEvent({
        scope: 'storage', entityType: 'task_retention', entityId: 'completed_task',
        kind: 'retention.task_data.deleted',
        message: `Deleted one completed task generation after the ${TASK_RETENTION_DAYS}-day retention window.`,
        payload: { retentionDays: TASK_RETENTION_DAYS, archivedAt: task.archived_at },
      }, db);
      purged = true;
    }).immediate();
  } catch (error) {
    restoreStagedTaskFiles(stagedFiles);
    throw error;
  }
  if (purged) discardStagedTaskFiles(stagedFiles, candidate.id);
  else restoreStagedTaskFiles(stagedFiles);
  return purged;
}

function cleanupExpiredDetachedRecords(db, cutoff) {
  const deletedOperationReceipts = db.prepare(`
    DELETE FROM session_operation_receipts
    WHERE created_at<=? AND NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id=session_operation_receipts.task_id
        AND tasks.created_at=session_operation_receipts.task_created_at
    )
  `).run(cutoff).changes;
  const deletedAuditEvents = db.prepare(`
    DELETE FROM audit_events
    WHERE ts<=? AND (
      task_id='' OR NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id=audit_events.task_id)
    )
  `).run(cutoff).changes;
  const deletedCleanupJobs = db.prepare(`
    DELETE FROM bridge_cleanup_jobs
    WHERE status='completed' AND completed_at<>'' AND completed_at<=?
  `).run(cutoff).changes;
  return { deletedAuditEvents, deletedOperationReceipts, deletedCleanupJobs };
}

function retentionWorkCounts(db, cutoff) {
  const scalar = (sql) => Number(db.prepare(sql).get(cutoff).count);
  return {
    tasks: scalar(`
      SELECT COUNT(*) AS count FROM tasks
      WHERE status='completed' AND archived_at<>'' AND archived_at<=?
    `),
    detachedOperationReceipts: scalar(`
      SELECT COUNT(*) AS count FROM session_operation_receipts
      WHERE created_at<=? AND NOT EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.id=session_operation_receipts.task_id
          AND tasks.created_at=session_operation_receipts.task_created_at
      )
    `),
    detachedAuditEvents: scalar(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE ts<=? AND (
        task_id='' OR NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.id=audit_events.task_id)
      )
    `),
    completedCleanupJobs: scalar(`
      SELECT COUNT(*) AS count FROM bridge_cleanup_jobs
      WHERE status='completed' AND completed_at<>'' AND completed_at<=?
    `),
  };
}

function performTaskRetentionCleanup(options = {}) {
  const db = ensureStorage();
  const reference = retentionReferenceTime(options.now || new Date());
  const cutoff = retentionCutoff(reference);
  const owner = String(options.owner || `retention:${process.pid}`).trim();
  const limit = Math.min(TASK_RETENTION_BATCH_SIZE, boundedLimit(options.limit, TASK_RETENTION_BATCH_SIZE));
  const currentMaintenance = platformMaintenanceFromDatabase(db);
  if (currentMaintenance) {
    return {
      ok: true,
      deferred: true,
      reason: 'platform_maintenance',
      cutoff,
      purgedTasks: 0,
    };
  }

  const workCounts = retentionWorkCounts(db, cutoff);
  if (Object.values(workCounts).every((count) => count === 0)) {
    db.transaction(() => {
      if (platformMaintenanceFromDatabase(db)) return;
      const previous = retentionStateFromDatabase(db);
      const runAt = reference.toISOString();
      writeRetentionState(db, {
        ...previous,
        lastRunAt: runAt,
        lastSuccessAt: runAt,
        lastFailureCode: '',
        lastDeferredReason: '',
        lastPurgedTasks: 0,
        lastDeletedAuditEvents: 0,
        lastDeletedOperationReceipts: 0,
        lastDeletedCleanupJobs: 0,
      });
    }).immediate();
    return {
      ok: true,
      deferred: false,
      skipped: true,
      cutoff,
      purgedTasks: 0,
      failedTasks: 0,
      releaseConfirmed: true,
      deletedAuditEvents: 0,
      deletedOperationReceipts: 0,
      deletedCleanupJobs: 0,
    };
  }

  try {
    acquirePlatformMaintenance('retention_cleanup', owner, TASK_RETENTION_MAINTENANCE_TTL_MS);
  } catch (error) {
    if (!error.activityCounts) throw error;
    db.transaction(() => recordRetentionDeferral(db, reference, 'platform_activity')).immediate();
    return {
      ok: true,
      deferred: true,
      reason: 'platform_activity',
      activityCounts: error.activityCounts,
      cutoff,
      purgedTasks: 0,
    };
  }

  let purgedTasks = 0;
  let failedTasks = 0;
  let lastFailureCode = '';
  let detached = { deletedAuditEvents: 0, deletedOperationReceipts: 0, deletedCleanupJobs: 0 };
  let releaseConfirmed = false;
  try {
    const candidates = db.prepare(`
      SELECT id, created_at, archived_at FROM tasks
      WHERE status='completed' AND archived_at<>'' AND archived_at<=?
      ORDER BY archived_at, id LIMIT ?
    `).all(cutoff, limit);
    for (const candidate of candidates) {
      if (!renewPlatformMaintenance(owner, TASK_RETENTION_MAINTENANCE_TTL_MS)) {
        throw statusError('Task retention maintenance lease was lost', 409);
      }
      try {
        if (purgeCompletedTaskGeneration(db, candidate, cutoff, owner)) purgedTasks += 1;
      } catch (error) {
        failedTasks += 1;
        lastFailureCode = String(error.code || 'TASK_PURGE_FAILED').slice(0, 128);
      }
    }

    db.transaction(() => {
      const maintenance = platformMaintenanceFromDatabase(db);
      if (!maintenance || maintenance.owner !== owner || maintenance.kind !== 'retention_cleanup') {
        throw statusError('Task retention maintenance lease was lost', 409);
      }
      detached = cleanupExpiredDetachedRecords(db, cutoff);
      const previous = retentionStateFromDatabase(db);
      const runAt = reference.toISOString();
      writeRetentionState(db, {
        ...previous,
        lastRunAt: runAt,
        ...(failedTasks === 0
          ? { lastSuccessAt: runAt, lastFailureCode: '' }
          : { lastFailureAt: runAt, lastFailureCode }),
        lastDeferredReason: '',
        lastPurgedTasks: purgedTasks,
        totalPurgedTasks: Number(previous.totalPurgedTasks || 0) + purgedTasks,
        lastDeletedAuditEvents: detached.deletedAuditEvents,
        lastDeletedOperationReceipts: detached.deletedOperationReceipts,
        lastDeletedCleanupJobs: detached.deletedCleanupJobs,
      });
    }).immediate();
  } finally {
    releaseConfirmed = releasePlatformMaintenance(owner);
  }

  return {
    ok: failedTasks === 0 && releaseConfirmed,
    deferred: false,
    cutoff,
    purgedTasks,
    failedTasks,
    releaseConfirmed,
    ...detached,
  };
}

function bridgeCleanupSourceDir(db, task) {
  const execution = db.prepare(`
    SELECT configured_working_directory FROM command_executions
    WHERE task_id=? AND configured_working_directory<>''
    ORDER BY started_at DESC, id DESC LIMIT 1
  `).get(task.id);
  if (execution?.configured_working_directory) {
    return path.resolve(execution.configured_working_directory);
  }
  try {
    return resolveWorkingDir(task.working_dir);
  } catch {
    return '';
  }
}

function bridgeCleanupJobId(taskId, taskCreatedAt, sessionKey) {
  return `bridge-cleanup-${crypto.createHash('sha256')
    .update(`${taskId}\0${taskCreatedAt}\0${sessionKey}`)
    .digest('hex')
    .slice(0, 24)}`;
}

function enqueueBridgeCleanupJob(db, task, reason, context = {}, options = {}) {
  const sessionKey = String(options.sessionKey ?? task.persistent_session_key ?? '').trim();
  if (!sessionKey) return null;
  const now = nowIso();
  const job = {
    id: bridgeCleanupJobId(options.taskId || task.id, options.taskCreatedAt || task.created_at, sessionKey),
    taskId: options.taskId || task.id,
    taskCreatedAt: options.taskCreatedAt || task.created_at,
    reason,
    sessionKey,
    sourceDir: Object.prototype.hasOwnProperty.call(options, 'sourceDir')
      ? String(options.sourceDir || '')
      : bridgeCleanupSourceDir(db, task),
    sessionId: String(options.sessionId || ''),
    now,
  };
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO bridge_cleanup_jobs(
      id, task_id, task_created_at, reason, session_key, source_dir, session_id,
      status, next_attempt_at, created_at, updated_at
    ) VALUES (
      @id, @taskId, @taskCreatedAt, @reason, @sessionKey, @sourceDir, @sessionId,
      'pending', @now, @now, @now
    )
  `).run(job);
  if (inserted.changes) {
    appendAuditEvent({
      scope: 'runtime', taskId: job.taskId, entityType: 'bridge_cleanup', entityId: job.id,
      kind: 'bridge.session.cleanup.queued', message: `Queued Bridge Session cleanup after task ${reason}`,
      actor: context.actor || 'system', requestId: context.requestId || '',
      payload: {
        reason,
        sessionKey,
        taskCreatedAt: job.taskCreatedAt,
        ...(options.manual ? { manual: true, inventoryCategory: options.inventoryCategory || '' } : {}),
      },
    }, db);
  }
  return job.id;
}

function rowToBridgeCleanupJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    taskCreatedAt: row.task_created_at,
    reason: row.reason,
    sessionKey: row.session_key,
    sourceDir: row.source_dir,
    sessionId: row.session_id,
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    result: parseJson(row.result_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function claimBridgeCleanupJobs(workerId, limit = 2) {
  const owner = String(workerId || '').trim();
  if (!owner) throw new Error('Bridge cleanup worker id is required');
  const db = ensureStorage();
  return db.transaction(() => {
    const now = nowIso();
    if (platformMaintenanceFromDatabase(db, now)) return [];
    db.prepare(`
      UPDATE bridge_cleanup_jobs
      SET status='retry', lease_owner='', lease_expires_at='', next_attempt_at=?,
        last_error=CASE WHEN last_error='' THEN 'Recovered an expired cleanup lease' ELSE last_error END,
        updated_at=?
      WHERE status='processing' AND (lease_expires_at='' OR lease_expires_at<?)
    `).run(now, now, now);
    const rows = db.prepare(`
      SELECT * FROM bridge_cleanup_jobs
      WHERE status IN ('pending','retry') AND (next_attempt_at='' OR next_attempt_at<=?)
      ORDER BY created_at, id LIMIT ?
    `).all(now, Math.min(20, Math.max(1, Number(limit || 2))));
    const claimed = [];
    const expiresAt = new Date(Date.now() + BRIDGE_CLEANUP_LEASE_MS).toISOString();
    const claim = db.prepare(`
      UPDATE bridge_cleanup_jobs
      SET status='processing', attempt_count=attempt_count+1,
        lease_owner=?, lease_expires_at=?, updated_at=?
      WHERE id=? AND status IN ('pending','retry')
    `);
    for (const row of rows) {
      if (!claim.run(owner, expiresAt, now, row.id).changes) continue;
      claimed.push(rowToBridgeCleanupJob(db.prepare('SELECT * FROM bridge_cleanup_jobs WHERE id=?').get(row.id)));
    }
    return claimed;
  }).immediate();
}

function assertBridgeCleanupOwnership(db, jobId, workerId) {
  const row = db.prepare(`
    SELECT * FROM bridge_cleanup_jobs
    WHERE id=? AND status='processing' AND lease_owner=?
  `).get(jobId, workerId);
  if (!row) throw new Error(`Bridge cleanup job ${jobId} is no longer owned by ${workerId}`);
  return row;
}

function processBridgeCleanupJob(job, workerId) {
  const db = ensureStorage();
  try {
    const current = assertBridgeCleanupOwnership(db, job.id, workerId);
    const references = db.prepare(`
      SELECT id, created_at, status FROM tasks WHERE persistent_session_key=?
    `).all(current.session_key);
    if (current.reason === 'deleted') {
      if (references.length) throw new Error('Bridge Session key is still referenced by a platform task');
    } else {
      const matching = references.filter((task) => task.id === current.task_id
        && task.created_at === current.task_created_at && task.status === 'completed');
      if (references.length !== 1 || matching.length !== 1) {
        throw new Error('Completed task generation no longer exclusively owns the Bridge Session key');
      }
    }
    const result = cleanupBridgeSessionResources({
      sessionKey: current.session_key,
      sourceDir: current.source_dir,
      sessionId: current.session_id,
    }, {
      onResolved(sessionId) {
        const changed = db.prepare(`
          UPDATE bridge_cleanup_jobs SET session_id=?, updated_at=?
          WHERE id=? AND status='processing' AND lease_owner=?
        `).run(sessionId, nowIso(), current.id, workerId);
        if (!changed.changes) throw new Error('Bridge cleanup ownership changed before resource deletion');
      },
    });
    db.transaction(() => {
      assertBridgeCleanupOwnership(db, current.id, workerId);
      const completedAt = nowIso();
      db.prepare(`
        UPDATE bridge_cleanup_jobs
        SET status='completed', lease_owner='', lease_expires_at='', next_attempt_at='',
          last_error='', result_json=?, completed_at=?, updated_at=?
        WHERE id=? AND status='processing' AND lease_owner=?
      `).run(JSON.stringify(result), completedAt, completedAt, current.id, workerId);
      appendAuditEvent({
        scope: 'runtime', taskId: current.task_id, entityType: 'bridge_cleanup', entityId: current.id,
        kind: 'bridge.session.cleanup.completed',
        message: `Released Bridge Session runtime for ${current.task_id}`,
        payload: { reason: current.reason, ...result, attemptCount: Number(current.attempt_count) },
      }, db);
    }).immediate();
    return { ok: true, ...result };
  } catch (error) {
    const message = preserveString(error?.message || error || 'Bridge Session cleanup failed').slice(0, 4000);
    db.transaction(() => {
      const current = db.prepare(`
        SELECT * FROM bridge_cleanup_jobs
        WHERE id=? AND status='processing' AND lease_owner=?
      `).get(job.id, workerId);
      if (!current) return;
      const exponent = Math.min(10, Math.max(0, Number(current.attempt_count || 1) - 1));
      const delayMs = Math.min(BRIDGE_CLEANUP_MAX_RETRY_MS, 5000 * (2 ** exponent));
      const now = nowIso();
      const retryAt = new Date(Date.now() + delayMs).toISOString();
      db.prepare(`
        UPDATE bridge_cleanup_jobs
        SET status='retry', lease_owner='', lease_expires_at='', next_attempt_at=?,
          last_error=?, updated_at=?
        WHERE id=? AND status='processing' AND lease_owner=?
      `).run(retryAt, message, now, current.id, workerId);
      appendAuditEvent({
        scope: 'runtime', taskId: current.task_id, entityType: 'bridge_cleanup', entityId: current.id,
        kind: 'bridge.session.cleanup.retry', level: 'error',
        message: `Bridge Session cleanup will retry: ${message}`,
        payload: {
          reason: current.reason,
          sessionId: current.session_id,
          attemptCount: Number(current.attempt_count),
          retryAt,
        },
      }, db);
    }).immediate();
    return { ok: false, error: message };
  }
}

function bridgeCleanupStatus() {
  const db = ensureStorage();
  const counts = Object.fromEntries(db.prepare(`
    SELECT status, COUNT(*) AS count FROM bridge_cleanup_jobs GROUP BY status
  `).all().map((row) => [row.status, Number(row.count)]));
  const latestFailure = db.prepare(`
    SELECT id, task_id, last_error, next_attempt_at, updated_at
    FROM bridge_cleanup_jobs WHERE status='retry'
    ORDER BY updated_at DESC LIMIT 1
  `).get();
  return {
    queued: Number(counts.pending || 0) + Number(counts.processing || 0) + Number(counts.retry || 0),
    pending: Number(counts.pending || 0),
    processing: Number(counts.processing || 0),
    retrying: Number(counts.retry || 0),
    completed: Number(counts.completed || 0),
    latestFailure: latestFailure ? {
      jobId: latestFailure.id,
      taskId: latestFailure.task_id,
      error: latestFailure.last_error,
      nextAttemptAt: latestFailure.next_attempt_at,
      updatedAt: latestFailure.updated_at,
    } : null,
  };
}

function epochMsToIso(value) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return '';
  }
}

function bridgeRuntimeInventoryRows(db) {
  const taskRows = db.prepare(`
    SELECT id, status, created_at, persistent_session_key
    FROM tasks WHERE persistent_session_key<>''
  `).all();
  const tasksByKey = new Map();
  for (const task of taskRows) {
    const items = tasksByKey.get(task.persistent_session_key) || [];
    items.push(task);
    tasksByKey.set(task.persistent_session_key, items);
  }
  const cleanupRows = db.prepare(`
    SELECT * FROM bridge_cleanup_jobs ORDER BY updated_at DESC, id DESC
  `).all();
  const cleanupByKey = new Map();
  for (const row of cleanupRows) {
    if (!cleanupByKey.has(row.session_key)) cleanupByKey.set(row.session_key, row);
  }
  return listBridgeSessionRecords().map((record) => {
    const tasks = record.sessionKey ? (tasksByKey.get(record.sessionKey) || []) : [];
    const cleanup = record.sessionKey ? cleanupByKey.get(record.sessionKey) : null;
    let category = 'unsafe';
    let error = record.error || '';
    let reclaimable = false;
    let task = null;
    if (record.safe && tasks.length > 1) {
      error = 'Multiple platform tasks reference the same Bridge Session key';
    } else if (record.safe && cleanup && ['pending', 'processing', 'retry'].includes(cleanup.status)) {
      category = 'cleanup_queued';
      task = tasks[0] || null;
    } else if (record.safe && cleanup?.status === 'completed') {
      category = 'cleanup_inconsistent';
      task = tasks[0] || null;
      error = 'A completed cleanup job still has a Bridge Session record';
    } else if (record.safe && tasks.length === 1) {
      [task] = tasks;
      category = task.status === 'completed' ? 'completed_retained' : 'task_owned';
      reclaimable = task.status === 'completed';
    } else if (record.safe && tasks.length === 0) {
      category = 'orphan';
      reclaimable = true;
    }
    return {
      ...record,
      category,
      error,
      reclaimable,
      task,
      cleanup,
    };
  });
}

function publicBridgeCleanupJob(row) {
  const job = rowToBridgeCleanupJob(row);
  const lastError = String(job?.lastError || '');
  return job ? {
    id: job.id,
    taskId: job.taskId,
    taskCreatedAt: job.taskCreatedAt,
    reason: job.reason,
    sessionId: job.sessionId,
    status: job.status,
    attemptCount: job.attemptCount,
    nextAttemptAt: job.nextAttemptAt,
    lastError: /[/\\]/.test(lastError)
      ? 'Bridge Session cleanup failed; inspect the runtime audit for details'
      : lastError,
    result: job.result,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  } : null;
}

function listBridgeRuntimeInventory() {
  const db = ensureStorage();
  const rows = bridgeRuntimeInventoryRows(db);
  const counts = {};
  let totalBytes = 0;
  let reclaimableBytes = 0;
  for (const row of rows) {
    counts[row.category] = Number(counts[row.category] || 0) + 1;
    totalBytes += Number(row.bytes || 0);
    if (row.reclaimable) reclaimableBytes += Number(row.bytes || 0);
  }
  return {
    summary: {
      total: rows.length,
      reclaimable: rows.filter((row) => row.reclaimable).length,
      totalBytes,
      reclaimableBytes,
      categories: counts,
      scannedAt: nowIso(),
    },
    sessions: rows.map((row) => ({
      sessionId: row.sessionId,
      category: row.category,
      safe: row.safe,
      reclaimable: row.reclaimable,
      bytes: Number(row.bytes || 0),
      resources: row.resources,
      createdAt: epochMsToIso(row.createdAtMs),
      updatedAt: epochMsToIso(row.updatedAtMs),
      lastRunAt: epochMsToIso(row.lastRunAtMs),
      taskId: row.task?.id || '',
      taskStatus: row.task?.status || '',
      cleanupJob: row.cleanup ? publicBridgeCleanupJob(row.cleanup) : null,
      error: row.error,
    })),
  };
}

function requestBridgeSessionReclaim(sessionId, confirmation, context = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!/^session-[a-f0-9]{16}$/.test(normalizedSessionId)) {
    throw statusError('Invalid Bridge Session id', 400);
  }
  if (String(confirmation || '') !== normalizedSessionId) {
    throw statusError('Bridge Session reclaim requires an exact confirmationSessionId', 400);
  }
  const db = ensureStorage();
  const existing = db.prepare(`
    SELECT * FROM bridge_cleanup_jobs WHERE session_id=? ORDER BY created_at DESC
  `).all(normalizedSessionId);
  if (existing.length > 1) throw statusError('Multiple cleanup jobs reference this Bridge Session id', 409);
  if (existing.length === 1) return publicBridgeCleanupJob(existing[0]);

  const inventory = bridgeRuntimeInventoryRows(db);
  const matches = inventory.filter((row) => row.sessionId === normalizedSessionId);
  if (!matches.length) throw statusError(`Bridge Session ${normalizedSessionId} not found`, 404);
  if (matches.length > 1) throw statusError('Bridge Session inventory is ambiguous', 409);
  const [record] = matches;
  if (!record.safe) throw statusError(`Bridge Session is unsafe to reclaim: ${record.error}`, 409);
  if (!record.reclaimable) {
    if (record.cleanup) return publicBridgeCleanupJob(record.cleanup);
    throw statusError(`Bridge Session cannot be reclaimed while classified as ${record.category}`, 409);
  }

  let jobId;
  db.transaction(() => {
    assertNoPlatformMaintenance(db);
    const references = db.prepare(`
      SELECT * FROM tasks WHERE persistent_session_key=?
    `).all(record.sessionKey);
    if (record.category === 'orphan') {
      if (references.length) throw statusError('Bridge Session gained a platform task reference', 409);
      const syntheticTask = {
        id: `bridge-orphan-${normalizedSessionId.slice('session-'.length)}`,
        created_at: epochMsToIso(record.createdAtMs) || '1970-01-01T00:00:00.000Z',
        persistent_session_key: record.sessionKey,
        working_dir: '',
      };
      jobId = enqueueBridgeCleanupJob(db, syntheticTask, 'deleted', context, {
        sessionId: normalizedSessionId,
        sourceDir: '',
        manual: true,
        inventoryCategory: record.category,
      });
    } else {
      if (references.length !== 1
        || references[0].id !== record.task.id
        || references[0].created_at !== record.task.created_at
        || references[0].status !== 'completed') {
        throw statusError('Completed task ownership changed before Bridge Session reclaim', 409);
      }
      jobId = enqueueBridgeCleanupJob(db, references[0], 'completed', context, {
        sessionId: normalizedSessionId,
        sourceDir: '',
        manual: true,
        inventoryCategory: record.category,
      });
    }
  }).immediate();
  const queued = db.prepare('SELECT * FROM bridge_cleanup_jobs WHERE id=?').get(jobId);
  if (!queued) throw new Error('Bridge Session cleanup job was not persisted');
  return publicBridgeCleanupJob(queued);
}

function cleanupTaskFiles(taskId) {
  const normalizedId = safeId(taskId);
  for (const target of [sessionDir(normalizedId), path.join(SKILL_SNAPSHOTS_DIR, normalizedId)]) {
    if (fileExists(target)) removeTree(target);
  }
}

function stageTaskFilesForDeletion(taskId, taskCreatedAt = '') {
  const normalizedId = safeId(taskId);
  const generation = hashContent(taskCreatedAt).slice(0, 16);
  const staged = [];
  try {
    for (const target of [sessionDir(normalizedId), path.join(SKILL_SNAPSHOTS_DIR, normalizedId)]) {
      if (!fileExists(target)) continue;
      const tombstone = `${target}.deleting-${generation}-${crypto.randomUUID()}`;
      fs.renameSync(target, tombstone);
      staged.push({ target, tombstone });
    }
    return staged;
  } catch (error) {
    restoreStagedTaskFiles(staged);
    throw statusError(`Could not stage session files for deletion: ${error.message}`, 500);
  }
}

function restoreStagedTaskFiles(staged) {
  for (const { target, tombstone } of [...staged].reverse()) {
    if (fileExists(tombstone) && !fileExists(target)) fs.renameSync(tombstone, target);
  }
}

function discardStagedTaskFiles(staged, taskId) {
  for (const { tombstone } of staged) {
    try {
      removeTree(tombstone);
    } catch (error) {
      appendAuditEvent({
        scope: 'storage', taskId, entityType: 'session', entityId: taskId,
        kind: 'session.cleanup.failed', level: 'error',
        message: `Session metadata was deleted but staged files require manual cleanup: ${error.message}`,
      });
    }
  }
}

function normalizeAuditEvent(event) {
  const payload = preserveValue(event.payload || null);
  const record = {
    id: event.id || eventId('audit'),
    ts: event.ts || nowIso(),
    actor: String(event.actor || 'system'),
    requestId: String(event.requestId || ''),
    level: String(event.level || 'info'),
    scope: String(event.scope || 'session'),
    kind: String(event.kind || 'event'),
    message: preserveString(event.message || ''),
    taskId: safeId(event.taskId || event.sessionId || '', ''),
    entityType: String(event.entityType || ''),
    entityId: String(event.entityId || ''),
    payloadJson: payload ? JSON.stringify(payload) : null,
  };
  return { record, payload };
}

function insertAuditRecord(db, record) {
  db.prepare(`
    INSERT INTO audit_events
      (id, ts, actor, request_id, level, scope, kind, message, task_id, entity_type, entity_id, payload_json)
    VALUES (@id, @ts, @actor, @requestId, @level, @scope, @kind, @message, @taskId, @entityType, @entityId, @payloadJson)
  `).run(record);
}

function publicAuditRecord(record, payload) {
  return {
    id: record.id, ts: record.ts, actor: record.actor, requestId: record.requestId,
    level: record.level, scope: record.scope, kind: record.kind, message: record.message,
    sessionId: record.taskId, entityType: record.entityType, entityId: record.entityId, payload,
  };
}

function appendAuditEvent(event, dbOverride = null) {
  const db = dbOverride || ensureStorage();
  const { record, payload } = normalizeAuditEvent(event);
  insertAuditRecord(db, record);
  return publicAuditRecord(record, payload);
}

function appendAuditEventUnlessMaintenance(event) {
  const db = ensureStorage();
  return db.transaction(() => {
    assertNoPlatformMaintenance(db);
    return appendAuditEvent(event, db);
  }).immediate();
}

function appendAuditEvents(events, dbOverride = null) {
  if (!Array.isArray(events) || events.length === 0) throw statusError('Audit events must be a non-empty array', 400);
  const db = dbOverride || ensureStorage();
  return db.transaction(() => events.map((event) => appendAuditEvent(event, db))).immediate();
}

function appendAuditEventsIdempotent(events, dbOverride = null) {
  if (!Array.isArray(events) || events.length === 0) throw statusError('Audit events must be a non-empty array', 400);
  const db = dbOverride || ensureStorage();
  const normalized = events.map(normalizeAuditEvent);
  const projection = `
    id, ts, actor, request_id AS requestId, level, scope, kind, message,
    task_id AS taskId, entity_type AS entityType, entity_id AS entityId,
    payload_json AS payloadJson
  `;
  return db.transaction(() => normalized.map(({ record, payload }) => {
    const existing = db.prepare(`SELECT ${projection} FROM audit_events WHERE id=?`).get(record.id);
    if (existing) {
      const matches = Object.keys(record).every((key) => existing[key] === record[key]);
      if (!matches) throw statusError(`Audit event id ${record.id} conflicts with existing content`, 409);
      return publicAuditRecord(record, payload);
    }
    insertAuditRecord(db, record);
    return publicAuditRecord(record, payload);
  })).immediate();
}

function appendSessionWorklog(sessionId, event) {
  const db = ensureStorage();
  const taskId = safeId(sessionId);
  let record;
  db.transaction(() => {
    record = insertSessionWorklog(db, taskId, event);
  }).immediate();
  return record;
}

function insertSessionWorklog(db, taskId, event) {
  const payload = preserveValue(event.payload || null);
  const record = {
    id: event.id || eventId('worklog'),
    taskId,
    turnId: event.turnId || null,
    ts: event.ts || nowIso(),
    level: String(event.level || 'info'),
    kind: String(event.kind || 'event'),
    message: preserveString(event.message || ''),
    payloadJson: payload ? JSON.stringify(payload) : null,
  };
  const sequence = Number(db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM worklog_events WHERE task_id = ?').get(taskId).value);
  db.prepare(`
    INSERT INTO worklog_events
      (id, task_id, turn_id, sequence, ts, level, kind, message, payload_json)
    VALUES (@id, @taskId, @turnId, @sequence, @ts, @level, @kind, @message, @payloadJson)
  `).run({ ...record, sequence });
  appendAuditEvent({
    scope: 'session', taskId, entityType: 'session', entityId: taskId,
    level: record.level, kind: record.kind, message: record.message, payload,
    actor: event.actor || 'worker', requestId: event.requestId || '', ts: record.ts,
  }, db);
  record.sequence = sequence;
  return {
    id: record.id, ts: record.ts, sessionId: taskId, turnId: record.turnId,
    sequence: record.sequence, level: record.level, kind: record.kind,
    message: record.message, payload,
  };
}

function listSessionWorklogs(sessionId, options = {}) {
  const db = ensureStorage();
  const limit = boundedLimit(options.limit, 500);
  const offset = boundedOffset(options.offset);
  const q = String(options.q || '').trim().toLowerCase();
  const rows = q
    ? db.prepare(`
        SELECT * FROM worklog_events
        WHERE task_id = ? AND lower(kind || ' ' || message || ' ' || COALESCE(payload_json, '')) LIKE ?
        ORDER BY sequence DESC LIMIT ? OFFSET ?
      `).all(safeId(sessionId), `%${q}%`, limit, offset)
    : db.prepare('SELECT * FROM worklog_events WHERE task_id = ? ORDER BY sequence DESC LIMIT ? OFFSET ?')
      .all(safeId(sessionId), limit, offset);
  return rows.reverse().map((row) => ({
    id: row.id, ts: row.ts, sessionId: row.task_id, turnId: row.turn_id || '',
    sequence: Number(row.sequence), level: row.level, kind: row.kind,
    message: row.message, payload: parseJson(row.payload_json, null),
  }));
}

function rowToSkillReportArtifact(row) {
  return {
    id: row.id,
    key: row.artifact_key,
    label: row.label,
    kind: row.kind,
    fileName: row.file_name,
    mediaType: row.media_type,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    url: `/api/sessions/${encodeURIComponent(row.task_id)}/skill-reports/${encodeURIComponent(row.report_id)}/artifacts/${encodeURIComponent(row.id)}`,
    createdAt: row.created_at,
  };
}

function skillReportArtifacts(db, taskId, reportId) {
  return db.prepare(`
    SELECT * FROM skill_report_artifacts
    WHERE task_id=? AND report_id=? ORDER BY created_at, id
  `).all(taskId, reportId).map(rowToSkillReportArtifact);
}

function registeredSkillReportArtifacts(db, row, report) {
  const externalAttemptId = String(report.executionEvidence?.externalAttemptId || '');
  if (!externalAttemptId) return [];
  const external = db.prepare(`
    SELECT step_run_id, status, artifact_declarations_json
    FROM external_attempts WHERE id=? AND task_id=?
  `).get(externalAttemptId, row.task_id);
  if (!external || (row.step_run_id && external.step_run_id !== row.step_run_id)) return [];
  return parseJson(external.artifact_declarations_json, [])
    .filter((artifact) => artifact && typeof artifact === 'object'
      && ['pytest-html', 'failure-analysis-markdown'].includes(artifact.kind))
    .map((artifact) => ({
      key: String(artifact.key || ''),
      kind: artifact.kind,
      fileName: path.basename(String(artifact.path || '')),
      executionStatus: external.status,
      url: `/api/sessions/${encodeURIComponent(row.task_id)}`
        + `/external-attempts/${encodeURIComponent(externalAttemptId)}`
        + `/artifacts/${encodeURIComponent(String(artifact.key || ''))}`,
    }))
    .filter((artifact) => artifact.key && artifact.fileName);
}

function rowToSkillReport(row, db = null) {
  if (!row) return null;
  const report = parseJson(row.payload_json, {});
  return {
    id: row.id,
    sessionId: row.task_id,
    stepRunId: row.step_run_id || '',
    turnId: row.turn_id || '',
    attemptId: row.attempt_id || '',
    reportKey: row.report_key,
    revision: Number(row.revision),
    reportHash: row.report_hash,
    schemaVersion: Number(row.schema_version),
    skillId: row.skill_id,
    skillVersion: Number(row.skill_version),
    skillContentHash: row.skill_content_hash,
    reportType: row.report_type,
    status: row.status,
    title: row.title,
    summary: row.summary,
    observedAt: report.observedAt || '',
    executionEvidence: report.executionEvidence || null,
    primaryExecution: report.primaryExecution || null,
    artifactDeclarations: Array.isArray(report.artifacts) ? report.artifacts : [],
    metrics: Array.isArray(report.metrics) ? report.metrics : [],
    sections: Array.isArray(report.sections) ? report.sections : [],
    artifacts: db ? skillReportArtifacts(db, row.task_id, row.id) : [],
    registeredArtifacts: db ? registeredSkillReportArtifacts(db, row, report) : [],
    publishedAt: row.published_at,
  };
}

function isPytestCommand(command) {
  return /(^|[^A-Za-z0-9_])pytest([^A-Za-z0-9_]|$)/i.test(String(command || ''));
}

function pytestHtmlCommandPaths(command) {
  if (!isPytestCommand(command)) return [];
  const option = /(?:^|\s)--html(?:\s*=\s*|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"';&|]+))/gi;
  const result = [];
  for (const match of String(command).matchAll(option)) {
    const value = String(match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (value && !/[\0\r\n$`]/.test(value)) result.push(value);
  }
  return result;
}

function pytestHtmlArtifact(declaration, sourcePath, artifactCount) {
  return {
    key: declaration.key,
    label: artifactCount > 1
      ? `Pytest HTML report: ${path.basename(sourcePath)}`
      : 'Pytest HTML report',
    kind: 'pytest-html',
    fileName: /^[A-Za-z0-9._-]+$/.test(path.basename(sourcePath))
      ? path.basename(sourcePath)
      : 'pytest-report.html',
    mediaType: 'text/html; charset=utf-8',
    sourcePath: path.normalize(sourcePath),
  };
}

function failureAnalysisMarkdownArtifact(declaration, sourcePath) {
  return {
    key: declaration.key,
    label: 'Failure analysis report',
    kind: 'failure-analysis-markdown',
    fileName: /^[A-Za-z0-9._-]+$/.test(path.basename(sourcePath))
      ? path.basename(sourcePath)
      : 'failure-analysis.md',
    mediaType: 'text/markdown; charset=utf-8',
    sourcePath: path.normalize(sourcePath),
  };
}

function resolvedRegularDirectory(directory, label) {
  const requested = path.resolve(String(directory || ''));
  let stat;
  try {
    stat = fs.lstatSync(requested);
  } catch (error) {
    if (error.code === 'ENOENT') throw statusError(`${label} does not exist`, 409);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw statusError(`${label} must be a regular directory`, 409);
  }
  return fs.realpathSync(requested);
}

function assertArtifactWorkingDirectory(workingDirectory) {
  const forbiddenDirectories = [ROOT_DIR, DATA_DIR, RUNTIME_DIR].map((directory) => {
    try { return fs.realpathSync(directory); } catch { return path.resolve(directory); }
  });
  if (forbiddenDirectories.some((directory) => (
    pathContains(directory, workingDirectory) || pathContains(workingDirectory, directory)
  ))) {
    throw statusError('Artifact execution working directory overlaps platform storage', 409);
  }
}

function skillReportExternalAttempt(db, taskId, report) {
  const externalAttemptId = String(report.executionEvidence?.externalAttemptId || '');
  if (!externalAttemptId) return null;
  const row = db.prepare('SELECT * FROM external_attempts WHERE id=? AND task_id=?')
    .get(externalAttemptId, taskId);
  if (!row) {
    throw statusError('Skill report executionEvidence does not belong to this task', 409);
  }
  if (!row.step_run_id) {
    throw statusError('Skill report executionEvidence is not bound to a Step Run', 409);
  }
  return row;
}

function mergeRegisteredTerminalArtifacts(report, externalAttempt) {
  if (!externalAttempt || ['pending', 'running'].includes(report.status)) return report;
  const registered = parseJson(externalAttempt.artifact_declarations_json, []);
  if (!registered.length) return report;
  const artifacts = [...report.artifacts];
  for (const declaration of registered) {
    const sameKey = artifacts.find((artifact) => artifact.key === declaration.key);
    const samePath = artifacts.find((artifact) => artifact.path === declaration.path);
    if (sameKey && (sameKey.path !== declaration.path || sameKey.kind !== declaration.kind)) {
      throw statusError(`Registered artifact key ${declaration.key} conflicts with the terminal report`, 409);
    }
    if (samePath && (samePath.key !== declaration.key || samePath.kind !== declaration.kind)) {
      throw statusError(`Registered artifact path ${declaration.path} conflicts with the terminal report`, 409);
    }
    if (!sameKey) artifacts.push(declaration);
  }
  return normalizeSkillReport({ ...report, artifacts });
}

function declaredArtifactExecutionEvidence(db, taskId, report, reportStepRunId) {
  const declarations = Array.isArray(report?.artifacts) ? report.artifacts : [];
  if (!declarations.length) return null;
  const row = skillReportExternalAttempt(db, taskId, report);
  const externalAttemptId = row.id;
  if (row.step_run_id !== reportStepRunId) {
    throw statusError('Artifact executionEvidence belongs to a different Step Run', 409);
  }
  if (!row.origin_turn_id || !row.origin_attempt_id) {
    throw statusError('Artifact executionEvidence is missing its originating Turn or Attempt', 409);
  }
  const originAttempt = db.prepare('SELECT turn_id FROM attempts WHERE id=? AND task_id=?')
    .get(row.origin_attempt_id, taskId);
  if (!originAttempt || originAttempt.turn_id !== row.origin_turn_id) {
    throw statusError('Artifact executionEvidence has an invalid Task, Turn, or Attempt lineage', 409);
  }
  const observation = inspectExternalAttempt(rowToExternalAttempt(row));
  if (!observation.terminal || !['succeeded', 'failed'].includes(observation.status)) {
    throw statusError('Artifact executionEvidence must identify a terminal background execution', 409);
  }
  const evidenceWorkingDirectory = String(
    observation.meta?.work_dir
    || observation.meta?.working_directory
    || observation.meta?.workingDirectory
    || '',
  ).trim();
  if (!path.isAbsolute(evidenceWorkingDirectory)) {
    throw statusError('Artifact executionEvidence META must contain an absolute working directory', 409);
  }
  const workingDirectory = resolvedRegularDirectory(
    evidenceWorkingDirectory,
    'Artifact execution working directory',
  );
  assertArtifactWorkingDirectory(workingDirectory);
  const commandEvidence = backgroundCommandEvidence(row.log_path);
  if (!String(commandEvidence.command || '').trim()) {
    throw statusError('Artifact executionEvidence is missing its background command evidence', 409);
  }
  return {
    externalAttemptId,
    workingDirectory,
    command: commandEvidence.command,
    registeredArtifacts: parseJson(row.artifact_declarations_json, []),
  };
}

function inferredPytestArtifactKey(sourcePath, index, count) {
  if (count === 1) return 'pytest-html';
  const stem = path.basename(sourcePath, path.extname(sourcePath))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 110);
  return `${stem || 'pytest-html'}-${index + 1}`;
}

function autoRegisterPytestHtmlArtifacts(db, taskId, report, externalAttempt) {
  if (!externalAttempt || !report.primaryExecution) return externalAttempt;
  // Explicit terminal declarations still go through the existing evidence checks.
  // Automatic discovery is for the common running-report -> terminal-reconciliation path.
  if (Array.isArray(report.artifacts) && report.artifacts.length) return externalAttempt;
  const reportWorkingDirectory = String(report.primaryExecution.workingDirectory || '').trim();
  if (!path.isAbsolute(reportWorkingDirectory)) return externalAttempt;

  const observation = inspectExternalAttempt(rowToExternalAttempt(externalAttempt));
  const evidenceWorkingDirectory = String(
    observation.meta?.work_dir
      || observation.meta?.working_directory
      || observation.meta?.workingDirectory
      || '',
  ).trim();
  if (!path.isAbsolute(evidenceWorkingDirectory)) return externalAttempt;

  let reportRoot;
  let evidenceRoot;
  try {
    reportRoot = resolvedRegularDirectory(reportWorkingDirectory, 'Artifact execution working directory');
    evidenceRoot = resolvedRegularDirectory(evidenceWorkingDirectory, 'Artifact execution working directory');
  } catch {
    return externalAttempt;
  }
  if (reportRoot !== evidenceRoot) return externalAttempt;
  try {
    assertArtifactWorkingDirectory(evidenceRoot);
  } catch {
    return externalAttempt;
  }

  const reportPaths = [...new Set(pytestHtmlCommandPaths(report.primaryExecution.command)
    .filter((reportPath) => /\.html?$/i.test(reportPath))
    .map((reportPath) => path.resolve(reportWorkingDirectory, reportPath)))]
    .filter((sourcePath) => pathContains(evidenceRoot, sourcePath));
  if (!reportPaths.length) return externalAttempt;

  const registered = parseJson(externalAttempt.artifact_declarations_json, []);
  const declarations = [...registered];
  let changed = false;
  for (const [index, sourcePath] of reportPaths.entries()) {
    if (declarations.some((artifact) => artifact?.path === sourcePath)) continue;
    const keyBase = inferredPytestArtifactKey(sourcePath, index, reportPaths.length);
    let key = keyBase;
    let suffix = 2;
    while (declarations.some((artifact) => artifact?.key === key)) {
      const suffixText = `-${suffix}`;
      key = `${keyBase.slice(0, 128 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    declarations.push({
      key,
      kind: 'pytest-html',
      path: sourcePath,
    });
    changed = true;
  }
  if (!changed) return externalAttempt;

  const normalized = normalizeExternalArtifactDeclarations(declarations, evidenceRoot);
  assertExternalArtifactPathsUnclaimed(db, taskId, normalized);
  const now = nowIso();
  db.prepare(`
    UPDATE external_attempts
    SET artifact_declarations_json=?, updated_at=?
    WHERE id=? AND task_id=?
  `).run(JSON.stringify(normalized), now, externalAttempt.id, taskId);
  insertSessionWorklog(db, taskId, {
    turnId: externalAttempt.origin_turn_id || null,
    kind: 'external.attempt.artifacts.auto_registered',
    message: `Auto-registered ${normalized.length - registered.length} pytest HTML artifact(s) from the report command`,
    payload: {
      externalAttemptId: externalAttempt.id,
      artifactDeclarations: normalized,
      source: 'skill-report.primaryExecution.command',
    },
    actor: 'platform',
  });
  return {
    ...externalAttempt,
    artifact_declarations_json: JSON.stringify(normalized),
  };
}

function declaredArtifactCandidate(declaration, evidence, artifactCount) {
  const sourcePath = path.resolve(declaration.path);
  if (!pathContains(evidence.workingDirectory, sourcePath)) {
    throw statusError(`${declaration.kind} artifact must remain inside its execution working directory`, 409);
  }
  if (declaration.kind === 'pytest-html') {
    const registered = evidence.registeredArtifacts || [];
    if (registered.length) {
      if (!registered.some((artifact) => artifact.key === declaration.key
        && artifact.kind === declaration.kind && artifact.path === sourcePath)) {
        throw statusError(`pytest-html artifact ${declaration.key} was not registered by its executionEvidence`, 409);
      }
    } else {
      const evidencedPaths = pytestHtmlCommandPaths(evidence.command).map((reportPath) => (
        path.resolve(evidence.workingDirectory, reportPath)
      ));
      if (!evidencedPaths.includes(sourcePath)) {
        throw statusError(`pytest-html artifact ${declaration.key} is not an exact --html output of its executionEvidence`, 409);
      }
    }
    return {
      ...pytestHtmlArtifact(declaration, sourcePath, artifactCount),
      workingDirectory: evidence.workingDirectory,
      externalAttemptId: evidence.externalAttemptId,
    };
  }
  return {
    ...failureAnalysisMarkdownArtifact(declaration, sourcePath),
    workingDirectory: evidence.workingDirectory,
    externalAttemptId: evidence.externalAttemptId,
  };
}

function fileStatFingerprint(stat) {
  return [
    stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs,
  ].map(String).join(':');
}

async function readStablePytestArtifactFile(filePath, options = {}) {
  const label = String(options.label || 'Pytest HTML resource');
  const maxBytes = Number(options.maxBytes || MAX_SKILL_REPORT_ARTIFACT_BYTES);
  const opened = await openRegularFileForRead(filePath, {
    label,
    missingCode: 'REPORT_ARTIFACT_SOURCE_MISSING',
  });
  try {
    if (opened.bytes > maxBytes) {
      throw statusError(`${label} exceeds ${maxBytes} bytes`, 413);
    }
    const content = Buffer.allocUnsafe(opened.bytes);
    let position = 0;
    while (position < content.length) {
      const { bytesRead } = await opened.handle.read(
        content,
        position,
        content.length - position,
        position,
      );
      if (!bytesRead) throw statusError(`${label} changed while it was read`, 409);
      position += bytesRead;
    }
    const [handleAfter, pathAfter] = await Promise.all([
      opened.handle.stat({ bigint: true }),
      fs.promises.lstat(filePath, { bigint: true }),
    ]);
    const expected = fileStatFingerprint(opened.stat);
    if (fileStatFingerprint(handleAfter) !== expected
      || fileStatFingerprint(pathAfter) !== expected) {
      throw statusError(`${label} changed while it was read`, 409);
    }
    return content;
  } finally {
    await opened.handle.close();
  }
}

function pytestHtmlHasActiveReloadPrompt(content) {
  const html = Buffer.isBuffer(content) ? content.toString('utf8') : String(content || '');
  const openingTags = html.match(/<div\b[^>]*>/gi) || [];
  return openingTags.some((tag) => {
    const classMatch = /\bclass\s*=\s*(["'])(.*?)\1/i.exec(tag);
    if (!classMatch) return false;
    const classes = classMatch[2].split(/\s+/).filter(Boolean);
    return classes.includes('summary__reload__button') && !classes.includes('hidden');
  });
}

function assertCompletedPytestHtml(content, label) {
  if (pytestHtmlHasActiveReloadPrompt(content)) {
    throw statusError(`${label} is incomplete: pytest is still running`, 409);
  }
}

function htmlAttribute(tag, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`,
    'i',
  ).exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function decodeLocalArtifactReference(value, label) {
  const decodedHtml = String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)));
  let decoded;
  try {
    decoded = decodeURIComponent(decodedHtml.split(/[?#]/, 1)[0]);
  } catch {
    throw statusError(`${label} has invalid URL encoding`, 409);
  }
  if (!decoded || /[\0\r\n]/.test(decoded)) {
    throw statusError(`${label} has an invalid local path`, 409);
  }
  if (path.isAbsolute(decoded)
    || decoded.startsWith('//')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded)) {
    throw statusError(`${label} must use a local relative path`, 409);
  }
  return decoded;
}

const PYTEST_CSS_ASSET_MEDIA_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.eot', 'application/vnd.ms-fontobject'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);
const PYTEST_LOG_REFERENCE = /\blogs\/([A-Za-z0-9][A-Za-z0-9._-]*\.(?:txt|html?))\b/g;

async function readPytestLocalResource(reference, baseDirectory, containmentRoot, label) {
  const relativePath = decodeLocalArtifactReference(reference, label);
  const resourcePath = path.resolve(baseDirectory, relativePath);
  if (!pathContains(containmentRoot, resourcePath)) {
    throw statusError(`${label} must remain inside the execution working directory`, 409);
  }
  let resourceStat;
  try {
    resourceStat = await fs.promises.lstat(resourcePath);
  } catch (error) {
    if (error.code === 'ENOENT') throw statusError(`${label} does not exist: ${reference}`, 409);
    throw error;
  }
  if (!resourceStat.isFile() || resourceStat.isSymbolicLink()) {
    throw statusError(`${label} must be a regular file`, 409);
  }
  const resolvedPath = await fs.promises.realpath(resourcePath);
  if (!pathContains(containmentRoot, resolvedPath)) {
    throw statusError(`${label} must remain inside the execution working directory`, 409);
  }
  try {
    return {
      content: await readStablePytestArtifactFile(resolvedPath, { label }),
      resolvedPath,
    };
  } catch (error) {
    if (!error.statusCode) error.statusCode = 409;
    throw error;
  }
}

async function inlinePytestCssAssets(css, stylesheetPath, containmentRoot) {
  if (/(?:^|[;}\s])@import\s/i.test(css)) {
    throw statusError('Pytest HTML stylesheet must not use @import', 409);
  }
  const matches = [...css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi)];
  if (!matches.length) return css;
  const replacements = [];
  for (const match of matches) {
    const reference = String(match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!reference || reference.startsWith('#') || /^(?:data|blob):/i.test(reference)) continue;
    const asset = await readPytestLocalResource(
      reference,
      path.dirname(stylesheetPath),
      containmentRoot,
      'Pytest HTML stylesheet asset',
    );
    const mediaType = PYTEST_CSS_ASSET_MEDIA_TYPES.get(
      path.extname(decodeLocalArtifactReference(reference, 'Pytest HTML stylesheet asset')).toLowerCase(),
    );
    if (!mediaType) {
      throw statusError(`Pytest HTML stylesheet asset type is not supported: ${reference}`, 409);
    }
    replacements.push({
      index: match.index,
      length: match[0].length,
      value: `url("data:${mediaType};base64,${asset.content.toString('base64')}")`,
    });
  }
  let transformed = css;
  for (const replacement of replacements.reverse()) {
    transformed = transformed.slice(0, replacement.index)
      + replacement.value
      + transformed.slice(replacement.index + replacement.length);
  }
  return transformed;
}

async function inlinePytestScriptAssets(html, sourcePath, containmentRoot) {
  const scriptTags = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>\s*<\/script\s*>/gi)];
  if (!scriptTags.length) return html;
  const replacements = [];
  const scriptCache = new Map();
  for (const match of scriptTags) {
    const src = htmlAttribute(match[0], 'src');
    if (!src || /^(?:data|blob):/i.test(src)
      || src.startsWith('//')
      || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(src)) continue;
    try {
      const script = await readPytestLocalResource(
        src,
        path.dirname(sourcePath),
        containmentRoot,
        'Pytest HTML script',
      );
      let content = scriptCache.get(script.resolvedPath);
      if (content == null) {
        content = script.content.toString('utf8').replace(/<\/script/gi, '<\\/script');
        scriptCache.set(script.resolvedPath, content);
      }
      replacements.push({
        index: match.index,
        length: match[0].length,
        value: `<script>${content}</script>`,
      });
    } catch {
      // A running pytest report can publish its stylesheet before optional player scripts.
    }
  }
  let transformed = html;
  for (const replacement of replacements.reverse()) {
    transformed = transformed.slice(0, replacement.index)
      + replacement.value
      + transformed.slice(replacement.index + replacement.length);
  }
  return transformed;
}

const PYTEST_MEDIA_TYPES = new Map([
  ['.aac', 'audio/aac'],
  ['.flv', 'video/x-flv'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.m3u8', 'application/vnd.apple.mpegurl'],
  ['.m4a', 'audio/mp4'],
  ['.m4s', 'video/iso.segment'],
  ['.m4v', 'video/x-m4v'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.mpd', 'application/dash+xml'],
  ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.ts', 'video/mp2t'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.vtt', 'text/vtt; charset=utf-8'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
]);
const PYTEST_MEDIA_ATTRIBUTE_REFERENCE = /\b(?:href|data-src|src)\s*=\s*(?:"|'|\\?&(?:#34|quot);)((?:\.\.\/|\.\/)?(?:[A-Za-z0-9_%+@(),.-]+\/)*[A-Za-z0-9_%+@(),.-]+\.(?:aac|flv|m3u8|m4a|m4s|m4v|mov|mp3|mp4|mpd|ogg|opus|ts|vtt|wav|webm)(?:\?[^"'\\<>\s&]*)?(?:#[^"'\\<>\s&]*)?)/gi;

function pytestMediaResourceUrl(taskId, reportId, artifactId, resourceId) {
  return `/api/sessions/${encodeURIComponent(taskId)}`
    + `/skill-reports/${encodeURIComponent(reportId)}`
    + `/artifacts/${encodeURIComponent(artifactId)}`
    + `/resources/${encodeURIComponent(resourceId)}`;
}

async function resolvePytestMediaResource(reference, baseDirectory, containmentRoot) {
  const relativePath = decodeLocalArtifactReference(reference, 'Pytest HTML media');
  const resourcePath = path.resolve(baseDirectory, relativePath);
  if (!pathContains(containmentRoot, resourcePath)) {
    throw statusError('Pytest HTML media must remain inside the execution working directory', 409);
  }
  let stat;
  try {
    stat = await fs.promises.lstat(resourcePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw statusError(`Pytest HTML media does not exist: ${reference}`, 409);
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw statusError('Pytest HTML media must be a regular file', 409);
  }
  const resolvedPath = await fs.promises.realpath(resourcePath);
  if (!pathContains(containmentRoot, resolvedPath)) {
    throw statusError('Pytest HTML media must remain inside the execution working directory', 409);
  }
  return resolvedPath;
}

function mediaReferencesInHtml(html) {
  const references = new Set();
  for (const match of html.matchAll(PYTEST_MEDIA_ATTRIBUTE_REFERENCE)) {
    references.add(match[1]);
    if (references.size > MAX_PYTEST_MEDIA_RESOURCES) {
      throw statusError(`Pytest HTML references more than ${MAX_PYTEST_MEDIA_RESOURCES} media resources`, 413);
    }
  }
  for (const reference of arguments[1] || []) {
    references.add(reference);
    if (references.size > MAX_PYTEST_MEDIA_RESOURCES) {
      throw statusError(`Pytest HTML references more than ${MAX_PYTEST_MEDIA_RESOURCES} resources`, 413);
    }
  }
  return [...references];
}

function manifestReferences(content, extension) {
  const references = [];
  if (extension === '.m3u8') {
    for (const match of content.matchAll(/\bURI\s*=\s*"([^"]+)"/gi)) {
      references.push(match[1]);
    }
    for (const line of content.split(/\r?\n/)) {
      const value = line.trim();
      if (value && !value.startsWith('#')) references.push(value);
    }
  } else if (extension === '.mpd') {
    for (const match of content.matchAll(/\b(?:media|initialization|sourceURL|href)\s*=\s*"([^"]+)"/gi)) {
      if (!match[1].includes('$')) references.push(match[1]);
    }
    for (const match of content.matchAll(/<BaseURL\b[^>]*>([^<]+)<\/BaseURL\s*>/gi)) {
      references.push(match[1].trim());
    }
  }
  return [...new Set(references)];
}

function replaceLiteralReferences(content, replacements) {
  let transformed = content;
  for (const [reference, replacement] of [...replacements.entries()]
    .sort(([left], [right]) => right.length - left.length)) {
    transformed = transformed.split(reference).join(replacement);
  }
  return transformed;
}

async function archivePytestMediaResources(htmlContent, options) {
  const sourceHtml = htmlContent.toString('utf8');
  const referenceHtml = Buffer.isBuffer(options.referenceContent)
    ? options.referenceContent.toString('utf8')
    : String(options.referenceContent ?? sourceHtml);
  const descriptors = new Map();
  const warnings = [];

  async function descriptorFor(reference, baseDirectory) {
    const resolvedPath = await resolvePytestMediaResource(
      reference,
      baseDirectory,
      options.containmentRoot,
    );
    const existing = descriptors.get(resolvedPath);
    if (existing) return existing;
    if (descriptors.size >= MAX_PYTEST_MEDIA_RESOURCES) {
      throw statusError(`Pytest HTML references more than ${MAX_PYTEST_MEDIA_RESOURCES} media resources`, 413);
    }
    const extension = path.extname(resolvedPath).toLowerCase();
    const resourceId = `report-resource-${hashContent(`${options.artifactId}\0${resolvedPath}`).slice(0, 32)}`;
    const descriptor = {
      id: resourceId,
      resourceKey: path.relative(options.containmentRoot, resolvedPath).split(path.sep).join('/'),
      fileName: path.basename(resolvedPath),
      mediaType: PYTEST_MEDIA_TYPES.get(extension) || 'application/octet-stream',
      managedPath: skillReportArtifactResourceFile(
        options.taskId,
        options.reportId,
        options.artifactId,
        resourceId,
        extension,
      ),
      resolvedPath,
      extension,
      status: 'pending',
      url: pytestMediaResourceUrl(
        options.taskId,
        options.reportId,
        options.artifactId,
        resourceId,
      ),
    };
    descriptors.set(resolvedPath, descriptor);
    return descriptor;
  }

  async function archiveDescriptor(descriptor) {
    if (descriptor.status === 'done' || descriptor.status === 'archiving') return descriptor;
    descriptor.status = 'archiving';
    let archived;
    if (['.m3u8', '.mpd'].includes(descriptor.extension)) {
      const manifest = await readStablePytestArtifactFile(descriptor.resolvedPath, {
        label: 'Pytest HTML media manifest',
        maxBytes: MAX_PYTEST_MEDIA_MANIFEST_BYTES,
      });
      const sourceManifest = manifest.toString('utf8');
      const replacements = new Map();
      for (const reference of manifestReferences(sourceManifest, descriptor.extension)) {
        try {
          const dependency = await descriptorFor(reference, path.dirname(descriptor.resolvedPath));
          await archiveDescriptor(dependency);
          replacements.set(reference, dependency.url);
        } catch (error) {
          warnings.push(`${reference}: ${String(error.message || error)}`);
        }
      }
      const transformed = Buffer.from(replaceLiteralReferences(sourceManifest, replacements), 'utf8');
      archived = await archiveBufferAtomically(transformed, descriptor.managedPath);
    } else {
      archived = await archiveFileAtomically({
        sourcePath: descriptor.resolvedPath,
        destinationPath: descriptor.managedPath,
      });
    }
    Object.assign(descriptor, archived, { status: 'done' });
    return descriptor;
  }

  ensureManagedDirectory(skillReportArtifactResourceDir(
    options.taskId,
    options.reportId,
    options.artifactId,
  ), { label: 'Skill report artifact resource directory' });
  const replacements = new Map();
  for (const reference of mediaReferencesInHtml(referenceHtml, options.logReferences)) {
    try {
      const descriptor = await descriptorFor(reference, path.dirname(options.sourcePath));
      await archiveDescriptor(descriptor);
      replacements.set(reference, descriptor.url);
    } catch (error) {
      warnings.push(`${reference}: ${String(error.message || error)}`);
    }
  }
  return {
    content: Buffer.from(replaceLiteralReferences(sourceHtml, replacements), 'utf8'),
    resources: [...descriptors.values()].filter((descriptor) => descriptor.status === 'done'),
    warnings,
  };
}

const OMITTED_PYTEST_LOG_DATA_URL = 'data:text/plain;charset=utf-8,Log%20omitted%3A%20artifact%20size%20limit';
const PYTEST_LOG_DATA_URL_PREFIX = 'data:text/plain;charset=utf-8;base64,';

function replacePytestLogLinks(html, matches, replacements) {
  const fragments = [];
  let cursor = 0;
  for (const match of matches) {
    fragments.push(html.slice(cursor, match.index), replacements.get(match[0]));
    cursor = match.index + match[0].length;
  }
  fragments.push(html.slice(cursor));
  return fragments.join('');
}

async function preparePytestLogLinks(html, sourcePath, containmentRoot, options = {}) {
  const matches = [...html.matchAll(PYTEST_LOG_REFERENCE)];
  if (!matches.length) return { content: html, externalReferences: [] };
  const referenceCounts = new Map();
  for (const match of matches) {
    referenceCounts.set(match[0], Number(referenceCounts.get(match[0]) || 0) + 1);
  }
  const isHtmlLog = (reference) => ['.htm', '.html'].includes(
    path.extname(decodeLocalArtifactReference(reference, 'Pytest HTML log')).toLowerCase(),
  );
  const htmlLogReferences = [...referenceCounts.keys()].filter(isHtmlLog);
  const textMatches = matches.filter((match) => !isHtmlLog(match[0]));
  const textReferenceCounts = new Map(
    [...referenceCounts].filter(([reference]) => !isHtmlLog(reference)),
  );
  if (!textMatches.length) {
    return { content: html, externalReferences: htmlLogReferences };
  }

  let projectedBytes = Buffer.byteLength(html);
  const resolvedLogs = new Map();
  for (const [reference, count] of textReferenceCounts) {
    const resolvedPath = await resolvePytestMediaResource(
      reference,
      path.dirname(sourcePath),
      containmentRoot,
    );
    const stat = await fs.promises.lstat(resolvedPath);
    const encodedBytes = Buffer.byteLength(PYTEST_LOG_DATA_URL_PREFIX)
      + (4 * Math.ceil(Number(stat.size) / 3));
    projectedBytes += (encodedBytes - Buffer.byteLength(reference)) * count;
    resolvedLogs.set(reference, resolvedPath);
  }

  if (projectedBytes > MAX_SKILL_REPORT_ARTIFACT_BYTES) {
    if (options.omitOversizedLogs) {
      return {
        content: replacePytestLogLinks(
          html,
          textMatches,
          new Map([...textReferenceCounts.keys()].map((reference) => [
            reference, OMITTED_PYTEST_LOG_DATA_URL,
          ])),
        ),
        externalReferences: htmlLogReferences,
      };
    }
    return { content: html, externalReferences: [...referenceCounts.keys()] };
  }

  const replacements = new Map();
  for (const [reference, resolvedPath] of resolvedLogs) {
    const content = await readStablePytestArtifactFile(resolvedPath, { label: 'Pytest HTML log' });
    replacements.set(reference, `${PYTEST_LOG_DATA_URL_PREFIX}${content.toString('base64')}`);
  }
  return {
    content: replacePytestLogLinks(html, textMatches, replacements),
    externalReferences: htmlLogReferences,
  };
}

async function selfContainedPytestHtml(sourceContent, sourcePath, containmentRoot, options = {}) {
  const sourceHtml = sourceContent.toString('utf8');
  const html = sourceHtml;
  const stylesheetTags = [...html.matchAll(/<link\b[^>]*>/gi)].filter((match) => {
    const rel = htmlAttribute(match[0], 'rel').toLowerCase().split(/\s+/);
    return rel.includes('stylesheet');
  });
  const replacements = [];
  const stylesheetCache = new Map();
  for (const match of stylesheetTags) {
    const href = htmlAttribute(match[0], 'href');
    if (!href) throw statusError('Pytest HTML stylesheet link must include href', 409);
    const stylesheet = await readPytestLocalResource(
      href,
      path.dirname(sourcePath),
      containmentRoot,
      'Pytest HTML stylesheet',
    );
    let css = stylesheetCache.get(stylesheet.resolvedPath);
    if (css == null) {
      css = await inlinePytestCssAssets(
        stylesheet.content.toString('utf8'),
        stylesheet.resolvedPath,
        containmentRoot,
      );
      stylesheetCache.set(stylesheet.resolvedPath, css);
    }
    const media = htmlAttribute(match[0], 'media');
    const mediaAttribute = media
      ? ` media="${media.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`
      : '';
    replacements.push({
      index: match.index,
      length: match[0].length,
      value: `<style type="text/css"${mediaAttribute}>${css.replace(/</g, '\\3c ')}</style>`,
    });
  }
  let transformed = html;
  for (const replacement of replacements.reverse()) {
    transformed = transformed.slice(0, replacement.index)
      + replacement.value
      + transformed.slice(replacement.index + replacement.length);
  }
  if (/\bsessionStorage\b/.test(transformed)
    && !/<script\s+data-codex-pytest-storage(?:\s|>)/i.test(transformed)) {
    const storageShim = `<script data-codex-pytest-storage>
(() => {
try { void window.sessionStorage.length; } catch {
  const values = new Map();
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: {
      getItem(key) { key = String(key); return values.has(key) ? values.get(key) : null; },
      setItem(key, value) { values.set(String(key), String(value)); },
      removeItem(key) { values.delete(String(key)); },
      clear() { values.clear(); },
      key(index) { return [...values.keys()][Number(index)] ?? null; },
      get length() { return values.size; },
    },
  });
}
})();
</script>`;
    const headOpen = /<head\b[^>]*>/i.exec(transformed);
    const insertionIndex = headOpen ? headOpen.index + headOpen[0].length : 0;
    transformed = transformed.slice(0, insertionIndex)
      + storageShim
      + transformed.slice(insertionIndex);
  }
  transformed = await inlinePytestScriptAssets(transformed, sourcePath, containmentRoot);
  const preparedLogs = options.includeLogs === false
    ? { content: transformed, externalReferences: [] }
    : await preparePytestLogLinks(transformed, sourcePath, containmentRoot, options);
  transformed = preparedLogs.content;
  const output = transformed === sourceHtml ? sourceContent : Buffer.from(transformed, 'utf8');
  if (output.length > MAX_SKILL_REPORT_ARTIFACT_BYTES) {
    throw statusError(`Pytest HTML report exceeds ${MAX_SKILL_REPORT_ARTIFACT_BYTES} bytes after embedding local resources`, 413);
  }
  return { content: output, externalLogReferences: preparedLogs.externalReferences };
}

async function readExternalArtifactSnapshot(opened) {
  const content = Buffer.allocUnsafe(opened.bytes);
  let position = 0;
  while (position < content.length) {
    const { bytesRead } = await opened.handle.read(
      content,
      position,
      content.length - position,
      position,
    );
    if (!bytesRead) {
      throw statusError('Registered background artifact ended before its snapshot size', 409);
    }
    position += bytesRead;
  }
  return content;
}

function externalArtifactResourceUrl(taskId, attemptId, artifactKey, relativePath = '') {
  const base = `/api/sessions/${encodeURIComponent(taskId)}`
    + `/external-attempts/${encodeURIComponent(attemptId)}`
    + `/artifacts/${encodeURIComponent(artifactKey)}/resources/`;
  return relativePath ? `${base}${relativePath.split('/').map(encodeURIComponent).join('/')}` : base;
}

function externalArtifactPreviewHtml(content, taskId, attemptId, artifactKey) {
  const html = content.toString('utf8');
  const resourceUrl = (reference) => externalArtifactResourceUrl(
    taskId,
    attemptId,
    artifactKey,
    decodeLocalArtifactReference(reference, 'Registered background artifact resource'),
  );
  const withLogs = html.replace(PYTEST_LOG_REFERENCE, (reference) => resourceUrl(reference));
  const preview = withLogs.replace(
    PYTEST_MEDIA_ATTRIBUTE_REFERENCE,
    (attribute, reference) => attribute.replace(reference, resourceUrl(reference)),
  );
  return Buffer.from(preview, 'utf8');
}

function externalArtifactMediaType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return new Map([
    ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'], ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'],
    ['.woff', 'font/woff'], ['.woff2', 'font/woff2'], ['.ttf', 'font/ttf'],
    ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mp3', 'audio/mpeg'],
    ['.m3u8', 'application/vnd.apple.mpegurl'], ['.m4s', 'video/iso.segment'],
    ['.htm', 'text/html; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
    ['.ts', 'video/mp2t'], ['.txt', 'text/plain; charset=utf-8'],
  ]).get(extension) || 'application/octet-stream';
}

function externalArtifactDeclaration(db, taskId, attemptId, artifactKey) {
  const row = db.prepare(`
    SELECT artifact_declarations_json FROM external_attempts WHERE task_id=? AND id=?
  `).get(taskId, String(attemptId || ''));
  if (!row) return null;
  return parseJson(row.artifact_declarations_json, [])
    .find((artifact) => artifact && artifact.key === String(artifactKey || '')) || null;
}

async function archiveBufferAtomically(content, destinationPath) {
  const temporaryPath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.${process.pid}.${crypto.randomUUID()}.source`,
  );
  let handle;
  try {
    handle = await fs.promises.open(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    return await archiveFileAtomically({ sourcePath: temporaryPath, destinationPath });
  } finally {
    try { await handle?.close(); } catch {}
    try { await fs.promises.unlink(temporaryPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function replaceArchivedBufferAtomically(content, destinationPath) {
  const replacementPath = `${destinationPath}.${crypto.randomUUID()}.replacement`;
  try {
    await archiveBufferAtomically(content, replacementPath);
    const [destinationStat, replacementStat] = await Promise.all([
      fs.promises.lstat(destinationPath),
      fs.promises.lstat(replacementPath),
    ]);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()
      || !replacementStat.isFile() || replacementStat.isSymbolicLink()) {
      throw statusError('Managed pytest HTML report must remain a regular file', 409);
    }
    await fs.promises.rename(replacementPath, destinationPath);
    await fsyncDirectory(path.dirname(destinationPath));
    return await digestRegularFile(destinationPath, {
      label: 'Managed pytest HTML report',
    });
  } finally {
    try { await fs.promises.unlink(replacementPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function assertSkillReportRuntimeContext(db, taskId, turnId, attemptId) {
  if (turnId) {
    const turn = db.prepare('SELECT id FROM turns WHERE id=? AND task_id=?').get(turnId, taskId);
    if (!turn) throw statusError('Skill report Turn does not belong to this task', 400);
  }
  if (attemptId) {
    const attempt = db.prepare('SELECT turn_id FROM attempts WHERE id=? AND task_id=?').get(attemptId, taskId);
    if (!attempt) throw statusError('Skill report Attempt does not belong to this task', 400);
    if (turnId && attempt.turn_id !== turnId) {
      throw statusError('Skill report Attempt does not belong to the supplied Turn', 400);
    }
  }
}

function publishSkillReport(sessionId, input, context = {}) {
  const db = ensureStorage();
  const taskId = canonicalTaskId(sessionId);
  let report = normalizeSkillReport(input);
  const turnId = String(context.turnId || '').trim();
  const attemptId = String(context.attemptId || '').trim();
  return db.transaction(() => {
    assertNoPlatformMaintenance(db);
    const task = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId);
    if (!task) throw statusError(`Session ${taskId} not found`, 404);
    if (task.status === 'completed') {
      throw statusError('Completed sessions are immutable history records', 409);
    }
    assertSkillReportRuntimeContext(db, taskId, turnId, attemptId);
    let externalAttempt = skillReportExternalAttempt(db, taskId, report);
    externalAttempt = autoRegisterPytestHtmlArtifacts(db, taskId, report, externalAttempt);
    report = mergeRegisteredTerminalArtifacts(report, externalAttempt);
    const stepRunId = externalAttempt?.step_run_id || null;
    const skill = taskSnapshotSkillMap(db, taskId).get(report.skillId);
    if (!skill) {
      throw statusError(`Skill not present in this task snapshot: ${report.skillId}`, 400);
    }
    const payloadJson = JSON.stringify(report);
    const reportHash = hashContent(JSON.stringify({
      report,
      skillVersion: Number(skill.version),
      skillContentHash: skill.content_hash,
    }));
    const existing = db.prepare(`
      SELECT * FROM skill_reports
      WHERE task_id=? AND report_key=?
      ORDER BY revision DESC LIMIT 1
    `).get(taskId, report.reportKey);
    if (existing && (existing.step_run_id || null) !== stepRunId) {
      throw statusError('A Skill report key cannot publish revisions across different Step Runs', 409);
    }
    if (existing?.report_hash === reportHash) {
      return { ...rowToSkillReport(existing, db), idempotent: true };
    }
    const revision = Number(db.prepare(`
      SELECT COALESCE(MAX(revision), 0) + 1 AS value
      FROM skill_reports WHERE task_id=? AND report_key=?
    `).get(taskId, report.reportKey).value);
    const id = eventId('skill-report');
    const publishedAt = nowIso();
    db.prepare(`
      INSERT INTO skill_reports (
        id, task_id, step_run_id, turn_id, attempt_id, report_key, revision, report_hash,
        schema_version, skill_id, skill_version, skill_content_hash, report_type,
        status, title, summary, payload_json, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId,
      stepRunId,
      turnId || null,
      attemptId || null,
      report.reportKey,
      revision,
      reportHash,
      report.schemaVersion,
      report.skillId,
      Number(skill.version),
      skill.content_hash,
      report.reportType,
      report.status,
      report.title,
      report.summary,
      payloadJson,
      publishedAt,
    );
    if (report.artifacts.length) queueSkillReportArtifactJob(db, taskId, id, publishedAt);
    insertSessionWorklog(db, taskId, {
      turnId: turnId || null,
      ts: publishedAt,
      level: report.status === 'failed' ? 'error' : (['partial', 'blocked'].includes(report.status) ? 'warn' : 'info'),
      kind: 'skill.report.published',
      message: report.summary,
      actor: `skill:${report.skillId}`,
      payload: {
        reportId: id,
        stepRunId: stepRunId || '',
        reportKey: report.reportKey,
        revision,
        reportType: report.reportType,
        status: report.status,
        skillId: report.skillId,
        skillVersion: Number(skill.version),
        skillContentHash: skill.content_hash,
        attemptId,
      },
    });
    return { ...rowToSkillReport(db.prepare('SELECT * FROM skill_reports WHERE id=?').get(id), db), idempotent: false };
  }).immediate();
}

function terminalReportExitCode(data, external) {
  const result = parseJson(external?.result_json, {});
  const exitCode = result.exitCode ?? result.exit_code ?? data.exitCode ?? 0;
  return Number.isInteger(Number(exitCode)) ? Number(exitCode) : 0;
}

function terminalReportStatus(data, external) {
  if (data.finalStatus === 'stopped') return 'cancelled';
  const summary = String(data.summary || data.resultText || '');
  if (/\b\d[\d,]*\s+passed\b/i.test(summary) && /\b\d[\d,]*\s+failed\b/i.test(summary)) {
    return 'partial';
  }
  return terminalReportExitCode(data, external) === 0 ? 'succeeded' : 'failed';
}

function missingPlatformReportSkillsForTask(db, taskId) {
  const usedSkills = db.prepare(`
    SELECT DISTINCT attribution.skill_id
    FROM command_skill_attributions attribution
    WHERE attribution.task_id=? AND attribution.action='linked'
  `).all(taskId).map((row) => row.skill_id);
  return usedSkills.filter((skillId) => PLATFORM_REPORT_SKILL_IDS.has(skillId)
    && !db.prepare('SELECT 1 FROM skill_reports WHERE task_id=? AND skill_id=? LIMIT 1')
      .get(taskId, skillId));
}

function publishMissingPlatformReports(taskId, data, skillIds) {
  if (!skillIds.length) return;
  const db = ensureStorage();
  const task = db.prepare('SELECT name FROM tasks WHERE id=?').get(taskId);
  const external = db.prepare(`
    SELECT log_path, done_path, state_path, meta_path, result_json, started_at, finished_at
    FROM external_attempts WHERE task_id=? ORDER BY generation DESC LIMIT 1
  `).get(taskId);
  const exitCode = terminalReportExitCode(data, external);
  const status = terminalReportStatus(data, external);
  for (const skillId of skillIds) {
    try {
      const evidence = [
        ['Log', external?.log_path],
        ['Done', external?.done_path],
        ['State', external?.state_path],
        ['Metadata', external?.meta_path],
      ].filter(([, value]) => value);
      const report = publishSkillReport(taskId, {
        schemaVersion: 2,
        reportKey: `platform-fallback:${skillId}:${hashContent(taskId).slice(0, 16)}`,
        skillId,
        reportType: skillId === 'cloud-recording-test' ? 'test-result' : 'deployment-result',
        title: `${task?.name || taskId} result`,
        status,
        summary: String(data.summary || data.resultText || `${task?.name || taskId} completed.`).slice(0, 2000),
        observedAt: String(data.finishedAt || nowIso()),
        artifacts: [],
        metrics: [{
          key: 'exit-code', label: 'Exit code', value: exitCode,
          tone: status === 'succeeded' ? 'success' : 'danger',
        }],
        sections: [
          {
            id: 'publication', title: 'Publication', kind: 'fields', priority: 'primary', defaultExpanded: true,
            fields: [
              { label: 'Status', value: status, format: 'status', tone: status === 'succeeded' ? 'success' : 'warning' },
              { label: 'Source', value: 'Platform terminal fallback after the Skill did not publish a report.', format: 'text', tone: 'warning' },
            ],
          },
          {
            id: 'runtime-evidence', title: 'Runtime evidence', kind: 'fields', priority: 'debug', defaultExpanded: false,
            fields: evidence.map(([label, value]) => ({ label, value, format: 'code' })),
          },
        ],
      }, { turnId: data.turnId, attemptId: data.attemptId });
      appendSessionWorklog(taskId, {
        turnId: data.turnId,
        kind: 'skill.report.fallback_published', level: 'warn',
        message: `Published terminal fallback report for ${skillId}`,
        payload: { skillId, reportId: report.id, status },
        actor: 'platform',
      });
    } catch (error) {
      appendSessionWorklog(taskId, {
        turnId: data.turnId,
        kind: 'skill.report.fallback_failed', level: 'warn',
        message: `Could not publish terminal fallback report for ${skillId}: ${String(error.message || error)}`,
        payload: { skillId }, actor: 'platform',
      });
    }
  }
}

async function archivePytestHtmlArtifact(db, taskId, row, candidate, context = {}) {
  ensureSessionStorage(taskId);
  ensureManagedDirectory(sessionSkillReportArtifactDir(taskId), {
    label: 'Skill report artifact root',
  });
  ensureManagedDirectory(sessionSkillReportArtifactDir(taskId, row.id), {
    label: 'Skill report artifact directory',
  });
  const artifactId = `report-artifact-${hashContent(`${row.id}\0${candidate.key}`).slice(0, 32)}`;
  const destinationPath = skillReportArtifactFile(taskId, row.id, artifactId, candidate.kind);
  const registeredArtifact = db.prepare(`
    SELECT * FROM skill_report_artifacts WHERE report_id=? AND artifact_key=?
  `).get(row.id, candidate.key);
  let archived;
  let archivedResources = [];
  let mediaWarnings = [];
  let repairedArtifact = false;
  if (!pathEntryExists(destinationPath)) {
    let sourceStat;
    try {
      sourceStat = fs.lstatSync(candidate.sourcePath);
    } catch (error) {
      if (error.code === 'ENOENT') throw statusError('Pytest HTML report does not exist', 409);
      throw error;
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw statusError('Pytest HTML report must be a regular file', 409);
    }
    if (candidate.workingDirectory) {
      const resolvedSourcePath = fs.realpathSync(candidate.sourcePath);
      if (!pathContains(candidate.workingDirectory, resolvedSourcePath)) {
        throw statusError('Pytest HTML report must remain inside its execution working directory', 409);
      }
    }
    if (sourceStat.size > MAX_SKILL_REPORT_ARTIFACT_BYTES) {
      throw statusError(`Pytest HTML report exceeds ${MAX_SKILL_REPORT_ARTIFACT_BYTES} bytes`, 413);
    }
    const sourceContent = await readStablePytestArtifactFile(candidate.sourcePath, {
      label: 'Pytest HTML report',
    });
    assertCompletedPytestHtml(sourceContent, 'Pytest HTML report');
    const resolvedSourcePath = await fs.promises.realpath(candidate.sourcePath);
    const containmentRoot = candidate.workingDirectory || path.dirname(resolvedSourcePath);
    const selfContained = await selfContainedPytestHtml(
      sourceContent,
      resolvedSourcePath,
      containmentRoot,
    );
    const mediaArchive = await archivePytestMediaResources(selfContained.content, {
      taskId,
      reportId: row.id,
      artifactId,
      sourcePath: resolvedSourcePath,
      containmentRoot,
      referenceContent: sourceContent,
      logReferences: selfContained.externalLogReferences,
    });
    const archivedContent = mediaArchive.content;
    archivedResources = mediaArchive.resources;
    mediaWarnings = mediaArchive.warnings;
    archived = archivedContent === sourceContent
      ? await archiveFileAtomically({
        sourcePath: candidate.sourcePath,
        destinationPath,
      })
      : await archiveBufferAtomically(archivedContent, destinationPath);
  } else {
    const managedContent = await readStablePytestArtifactFile(destinationPath, {
      label: 'Managed pytest HTML report',
    });
    assertCompletedPytestHtml(managedContent, 'Managed pytest HTML report');
    if (registeredArtifact
      && (registeredArtifact.managed_path !== destinationPath
        || Number(registeredArtifact.bytes) !== managedContent.length
        || registeredArtifact.sha256 !== hashBuffer(managedContent))) {
      throw statusError('Managed pytest HTML report failed integrity verification', 409);
    }
    const resolvedSourcePath = path.resolve(candidate.sourcePath);
    const containmentRoot = candidate.workingDirectory || path.dirname(resolvedSourcePath);
    let repairSourceContent = managedContent;
    let repairReferenceContent = managedContent;
    let sourceVerifiedForRepair = false;
    const hasOmittedLogs = managedContent.includes(
      'data:text/plain;charset=utf-8,Log%20omitted%3A%20artifact%20size%20limit',
    );
    if (hasOmittedLogs && pathEntryExists(candidate.sourcePath)) {
      const sourceContent = await readStablePytestArtifactFile(candidate.sourcePath, {
        label: 'Pytest HTML report',
      });
      assertCompletedPytestHtml(sourceContent, 'Pytest HTML report');
      const legacySelfContained = await selfContainedPytestHtml(
        sourceContent,
        resolvedSourcePath,
        containmentRoot,
        { omitOversizedLogs: true },
      );
      const legacyMediaArchive = await archivePytestMediaResources(legacySelfContained.content, {
        taskId,
        reportId: row.id,
        artifactId,
        sourcePath: resolvedSourcePath,
        containmentRoot,
        referenceContent: sourceContent,
      });
      if (legacyMediaArchive.content.equals(managedContent)) {
        repairSourceContent = sourceContent;
        repairReferenceContent = sourceContent;
        sourceVerifiedForRepair = true;
      }
    }
    const selfContained = await selfContainedPytestHtml(
      repairSourceContent,
      resolvedSourcePath,
      containmentRoot,
    );
    const mediaArchive = await archivePytestMediaResources(selfContained.content, {
      taskId,
      reportId: row.id,
      artifactId,
      sourcePath: resolvedSourcePath,
      containmentRoot,
      referenceContent: repairReferenceContent,
      logReferences: selfContained.externalLogReferences,
    });
    const repairedContent = mediaArchive.content;
    archivedResources = mediaArchive.resources;
    mediaWarnings = mediaArchive.warnings;
    if (repairedContent.equals(managedContent)) {
      archived = await digestRegularFile(destinationPath, {
        label: 'Managed pytest HTML report',
      });
    } else {
      if (hasOmittedLogs && !sourceVerifiedForRepair) {
        throw statusError('Pytest HTML source no longer reproduces its managed archive', 409);
      }
      archived = await replaceArchivedBufferAtomically(repairedContent, destinationPath);
      repairedArtifact = true;
    }
  }
  if (archived.bytes > MAX_SKILL_REPORT_ARTIFACT_BYTES) {
    throw statusError(`Pytest HTML report exceeds ${MAX_SKILL_REPORT_ARTIFACT_BYTES} bytes`, 413);
  }
  const createdAt = nowIso();
  db.transaction(() => {
    const existing = db.prepare(`
      SELECT * FROM skill_report_artifacts WHERE report_id=? AND artifact_key=?
    `).get(row.id, candidate.key);
    if (existing) {
      if (existing.managed_path !== destinationPath) {
        throw statusError('Registered pytest HTML report does not match its managed archive', 409);
      }
      if (Number(existing.bytes) !== archived.bytes || existing.sha256 !== archived.sha256) {
        if (!repairedArtifact) {
          throw statusError('Registered pytest HTML report does not match its managed archive', 409);
        }
        db.prepare(`
          UPDATE skill_report_artifacts SET bytes=?, sha256=? WHERE id=?
        `).run(archived.bytes, archived.sha256, existing.id);
        insertSessionWorklog(db, taskId, {
          turnId: row.turn_id || null,
          ts: createdAt,
          kind: 'skill.report.artifact.repaired',
          message: `Repaired managed content and embedded local assets in ${candidate.label}`,
          actor: context.actor || 'operator:artifact-repair',
          requestId: context.requestId || '',
          payload: {
            reportId: row.id,
            artifactId,
            kind: candidate.kind,
            bytes: archived.bytes,
            sha256: archived.sha256,
            sourceExternalAttemptId: candidate.externalAttemptId || null,
          },
        });
      }
    } else {
      db.prepare(`
        INSERT INTO skill_report_artifacts(
          id, task_id, report_id, artifact_key, label, kind, file_name,
          media_type, managed_path, bytes, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifactId, taskId, row.id, candidate.key, candidate.label, candidate.kind,
        candidate.fileName, candidate.mediaType, destinationPath,
        archived.bytes, archived.sha256, createdAt,
      );
      insertSessionWorklog(db, taskId, {
        turnId: row.turn_id || null,
        ts: createdAt,
        kind: 'skill.report.artifact.archived',
        message: `Archived ${candidate.label}`,
        actor: context.actor || `skill:${row.skill_id}`,
        requestId: context.requestId || '',
        payload: {
          reportId: row.id,
          artifactId,
          kind: candidate.kind,
          bytes: archived.bytes,
          sha256: archived.sha256,
          sourceExternalAttemptId: candidate.externalAttemptId || null,
        },
      });
    }
    for (const resource of archivedResources) {
      const existingResource = db.prepare(`
        SELECT * FROM skill_report_artifact_resources
        WHERE artifact_id=? AND resource_key=?
      `).get(artifactId, resource.resourceKey);
      if (existingResource) {
        if (path.resolve(existingResource.managed_path) !== path.resolve(resource.managedPath)
          || Number(existingResource.bytes) !== resource.bytes
          || existingResource.sha256 !== resource.sha256) {
          throw statusError('Registered pytest HTML media does not match its managed archive', 409);
        }
        continue;
      }
      db.prepare(`
        INSERT INTO skill_report_artifact_resources(
          id, task_id, report_id, artifact_id, resource_key, file_name,
          media_type, managed_path, bytes, sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resource.id, taskId, row.id, artifactId, resource.resourceKey, resource.fileName,
        resource.mediaType, resource.managedPath, resource.bytes, resource.sha256, createdAt,
      );
    }
    if (mediaWarnings.length) {
      insertSessionWorklog(db, taskId, {
        turnId: row.turn_id || null,
        ts: createdAt,
        kind: 'skill.report.artifact.media_partial',
        level: 'warn',
        message: `Archived ${candidate.label} with ${mediaWarnings.length} unavailable media reference(s)`,
        actor: context.actor || `skill:${row.skill_id}`,
        requestId: context.requestId || '',
        payload: {
          reportId: row.id,
          artifactId,
          warningCount: mediaWarnings.length,
          warnings: mediaWarnings.slice(0, 100),
        },
      });
    }
  }).immediate();
}

function artifactArchivalError(failures, candidateCount) {
  if (failures.length === 1 && candidateCount === 1) return failures[0].error;
  const details = failures.map(({ declaration, error }) => (
    `${declaration.key}: ${String(error.message || error)}`
  ));
  const statusCode = Number(failures.find(({ error }) => error?.statusCode)?.error.statusCode) || 409;
  return statusError(
    `Failed to archive ${failures.length} of ${candidateCount} declared artifacts: ${details.join('; ')}`,
    statusCode,
  );
}

async function archiveSkillReportArtifacts(sessionId, reportId, context = {}) {
  const db = ensureStorage();
  const taskId = canonicalTaskId(sessionId);
  const row = db.prepare('SELECT * FROM skill_reports WHERE task_id=? AND id=?')
    .get(taskId, String(reportId || ''));
  if (!row) throw statusError('Skill report not found', 404);
  const task = db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId);
  if (!task) throw statusError(`Session ${taskId} not found`, 404);
  if (task.status === 'completed') {
    throw statusError('Completed sessions are immutable history records', 409);
  }
  const report = parseJson(row.payload_json, {});
  const declarations = Array.isArray(report.artifacts) ? report.artifacts : [];
  if (!declarations.length) {
    completeSkillReportArtifactJob(db, row.id);
    return rowToSkillReport(row, db);
  }
  const evidence = declaredArtifactExecutionEvidence(db, taskId, report, row.step_run_id || '');
  const failures = [];
  for (const declaration of declarations) {
    try {
      const candidate = declaredArtifactCandidate(declaration, evidence, declarations.length);
      if (candidate.kind === 'pytest-html') {
        await archivePytestHtmlArtifact(db, taskId, row, candidate, context);
      } else {
        await archiveFailureAnalysisMarkdownArtifact(db, taskId, row, candidate, context);
      }
    } catch (error) {
      failures.push({ declaration, error });
    }
  }
  if (failures.length) throw artifactArchivalError(failures, declarations.length);
  completeSkillReportArtifactJob(db, row.id);
  return rowToSkillReport(row, db);
}

function queueSkillReportArtifactJob(db, taskId, reportId, createdAt = nowIso()) {
  db.prepare(`
    INSERT INTO skill_report_artifact_jobs(
      report_id, task_id, status, created_at, updated_at
    ) VALUES (?, ?, 'pending', ?, ?)
    ON CONFLICT(report_id) DO NOTHING
  `).run(reportId, taskId, createdAt, createdAt);
}

function completeSkillReportArtifactJob(db, reportId) {
  const now = nowIso();
  db.prepare(`
    UPDATE skill_report_artifact_jobs
    SET status='completed', lease_owner='', lease_expires_at='', next_attempt_at='',
      last_error='', completed_at=?, updated_at=?
    WHERE report_id=? AND status<>'completed'
  `).run(now, now, reportId);
}

function reportArtifactJobRetryDelayMs(attemptCount) {
  const exponent = Math.min(10, Math.max(0, Number(attemptCount || 1) - 1));
  return Math.min(REPORT_ARTIFACT_JOB_MAX_RETRY_MS, 5000 * (2 ** exponent));
}

function claimSkillReportArtifactJobs(workerId, limit = 1) {
  const db = ensureStorage();
  const owner = String(workerId || '').trim();
  if (!owner) throw statusError('Artifact job worker id is required', 400);
  const now = nowIso();
  const leaseExpiresAt = new Date(Date.now() + REPORT_ARTIFACT_JOB_LEASE_MS).toISOString();
  return db.transaction(() => {
    const candidates = db.prepare(`
      SELECT * FROM skill_report_artifact_jobs
      WHERE (
        status IN ('pending','retry') AND (next_attempt_at='' OR next_attempt_at<=?)
      ) OR (status='processing' AND lease_expires_at<=?)
      ORDER BY created_at, report_id LIMIT ?
    `).all(now, now, boundedLimit(limit, 1));
    const claimed = [];
    for (const candidate of candidates) {
      const changed = db.prepare(`
        UPDATE skill_report_artifact_jobs
        SET status='processing', attempt_count=attempt_count+1, lease_owner=?,
          lease_expires_at=?, updated_at=?
        WHERE report_id=? AND (
          (status IN ('pending','retry') AND (next_attempt_at='' OR next_attempt_at<=?))
          OR (status='processing' AND lease_expires_at<=?)
        )
      `).run(owner, leaseExpiresAt, now, candidate.report_id, now, now);
      if (changed.changes) {
        claimed.push(db.prepare('SELECT * FROM skill_report_artifact_jobs WHERE report_id=?')
          .get(candidate.report_id));
      }
    }
    return claimed;
  }).immediate();
}

async function processSkillReportArtifactJob(reportId, workerId) {
  const db = ensureStorage();
  const row = db.prepare(`
    SELECT * FROM skill_report_artifact_jobs
    WHERE report_id=? AND status='processing' AND lease_owner=?
  `).get(String(reportId || ''), String(workerId || ''));
  if (!row) return { ok: false, lostLease: true };
  try {
    const report = await archiveSkillReportArtifacts(row.task_id, row.report_id, {
      actor: 'artifact-worker',
    });
    return { ok: true, report };
  } catch (error) {
    const now = nowIso();
    const exhausted = Number(row.attempt_count) >= REPORT_ARTIFACT_JOB_MAX_ATTEMPTS;
    const retryAt = exhausted
      ? ''
      : new Date(Date.now() + reportArtifactJobRetryDelayMs(row.attempt_count)).toISOString();
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE skill_report_artifact_jobs
        SET status=?, lease_owner='', lease_expires_at='', next_attempt_at=?,
          last_error=?, updated_at=?
        WHERE report_id=? AND status='processing' AND lease_owner=?
      `).run(
        exhausted ? 'failed' : 'retry', retryAt,
        String(error.message || error).slice(0, 4000), now, row.report_id, workerId,
      );
      if (!changed.changes) return;
      insertSessionWorklog(db, row.task_id, {
        kind: exhausted ? 'skill.report.artifact.failed' : 'skill.report.artifact.retry_scheduled',
        level: 'warn',
        message: exhausted
          ? `Artifact archival failed after ${Number(row.attempt_count)} attempts`
          : `Artifact archival will retry at ${retryAt}`,
        actor: 'artifact-worker',
        payload: {
          reportId: row.report_id,
          attemptCount: Number(row.attempt_count),
          retryAt,
          error: String(error.message || error),
        },
      });
    }).immediate();
    return { ok: false, error: String(error.message || error), retryAt, exhausted };
  }
}

async function archiveFailureAnalysisMarkdownArtifact(db, taskId, row, candidate, context) {
  ensureSessionStorage(taskId);
  ensureManagedDirectory(sessionSkillReportArtifactDir(taskId), {
    label: 'Skill report artifact root',
  });
  ensureManagedDirectory(sessionSkillReportArtifactDir(taskId, row.id), {
    label: 'Skill report artifact directory',
  });
  const artifactId = `report-artifact-${hashContent(`${row.id}\0${candidate.key}`).slice(0, 32)}`;
  const destinationPath = skillReportArtifactFile(taskId, row.id, artifactId, candidate.kind);
  const registeredArtifact = db.prepare(`
    SELECT * FROM skill_report_artifacts WHERE report_id=? AND artifact_key=?
  `).get(row.id, candidate.key);
  let archived;
  if (!pathEntryExists(destinationPath)) {
    let sourceStat;
    try {
      sourceStat = fs.lstatSync(candidate.sourcePath);
    } catch (error) {
      if (error.code === 'ENOENT') throw statusError('Failure analysis report does not exist', 409);
      throw error;
    }
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw statusError('Failure analysis report must be a regular file', 409);
    }
    const resolvedSourcePath = fs.realpathSync(candidate.sourcePath);
    if (!pathContains(candidate.workingDirectory, resolvedSourcePath)) {
      throw statusError('Failure analysis report must remain inside its execution working directory', 409);
    }
    if (sourceStat.size > MAX_SKILL_REPORT_ARTIFACT_BYTES) {
      throw statusError(`Failure analysis report exceeds ${MAX_SKILL_REPORT_ARTIFACT_BYTES} bytes`, 413);
    }
    archived = await archiveFileAtomically({
      sourcePath: candidate.sourcePath,
      destinationPath,
    });
  } else {
    archived = await readStablePytestArtifactFile(destinationPath, {
      label: 'Managed failure analysis report',
    });
    archived = { bytes: archived.length, sha256: hashBuffer(archived) };
    if (registeredArtifact
      && (registeredArtifact.managed_path !== destinationPath
        || Number(registeredArtifact.bytes) !== archived.bytes
        || registeredArtifact.sha256 !== archived.sha256)) {
      throw statusError('Managed failure analysis report failed integrity verification', 409);
    }
  }
  const createdAt = nowIso();
  db.transaction(() => {
    const existing = db.prepare(`
      SELECT * FROM skill_report_artifacts WHERE report_id=? AND artifact_key=?
    `).get(row.id, candidate.key);
    if (existing) {
      if (existing.managed_path !== destinationPath
        || Number(existing.bytes) !== archived.bytes
        || existing.sha256 !== archived.sha256) {
        throw statusError('Registered failure analysis report does not match its managed archive', 409);
      }
      return;
    }
    db.prepare(`
      INSERT INTO skill_report_artifacts(
        id, task_id, report_id, artifact_key, label, kind, file_name,
        media_type, managed_path, bytes, sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifactId, taskId, row.id, candidate.key, candidate.label, candidate.kind,
      candidate.fileName, candidate.mediaType, destinationPath,
      archived.bytes, archived.sha256, createdAt,
    );
    insertSessionWorklog(db, taskId, {
      turnId: row.turn_id || null,
      ts: createdAt,
      kind: 'skill.report.artifact.archived',
      message: `Archived ${candidate.label}`,
      actor: context.actor || `skill:${row.skill_id}`,
      requestId: context.requestId || '',
      payload: {
        reportId: row.id,
        artifactId,
        kind: candidate.kind,
        bytes: archived.bytes,
        sha256: archived.sha256,
        sourceExternalAttemptId: candidate.externalAttemptId || null,
      },
    });
  }).immediate();
}

async function redactSkillReportArtifacts() {
  const db = ensureStorage();
  const rows = db.prepare(`
    SELECT artifact.*
    FROM skill_report_artifacts artifact
    JOIN skill_reports report ON report.id=artifact.report_id AND report.task_id=artifact.task_id
    WHERE artifact.kind='pytest-html' AND artifact.media_type='text/html; charset=utf-8'
    ORDER BY artifact.created_at, artifact.id
  `).all();
  // Kept as a compatibility endpoint for older operators. Report evidence is
  // intentionally immutable in analysis mode, including credential values.
  const result = { scanned: rows.length, redacted: 0, unchanged: rows.length };
  for (const row of rows) {
    const expectedPath = skillReportArtifactFile(row.task_id, row.report_id, row.id, row.kind);
    if (path.resolve(row.managed_path) !== path.resolve(expectedPath)) {
      throw statusError('Managed pytest HTML report path does not match its task ownership', 409);
    }
    const content = await readStablePytestArtifactFile(expectedPath, {
      label: 'Managed pytest HTML report',
    });
    if (content.length !== Number(row.bytes) || hashBuffer(content) !== row.sha256) {
      throw statusError('Managed pytest HTML report failed integrity verification', 409);
    }
  }
  return result;
}

function redactHistoricalSkillReports() {
  const db = ensureStorage();
  const rows = db.prepare(`
    SELECT id, task_id, payload_json
    FROM skill_reports ORDER BY sequence
  `).all();
  // Historical reports are evidence, so this legacy maintenance operation is
  // deliberately read-only and never changes payloads or report hashes.
  const result = { scanned: rows.length, redacted: 0, unchanged: rows.length };
  for (const row of rows) {
    try {
      JSON.parse(row.payload_json);
    } catch {
      throw statusError(`Historical Skill report ${row.id} contains invalid JSON`, 409);
    }
  }
  return result;
}

async function openSkillReportArtifactFile(sessionId, reportId, artifactId, options = {}) {
  const db = ensureStorage();
  const taskId = canonicalTaskId(sessionId);
  const row = db.prepare(`
    SELECT artifact.* FROM skill_report_artifacts artifact
    JOIN skill_reports report ON report.id=artifact.report_id AND report.task_id=artifact.task_id
    WHERE artifact.task_id=? AND artifact.report_id=? AND artifact.id=?
  `).get(taskId, String(reportId || ''), String(artifactId || ''));
  if (!row) return null;
  const expectedPath = skillReportArtifactFile(taskId, row.report_id, row.id, row.kind);
  if (path.resolve(row.managed_path) !== path.resolve(expectedPath)) {
    throw statusError('Managed pytest HTML report path does not match its task ownership', 409);
  }
  const opened = await openDigestedRegularFile(expectedPath, {
    signal: options.signal,
    label: `Managed ${row.label || 'Skill report artifact'}`,
    missingCode: 'REPORT_ARTIFACT_MISSING',
  });
  if (opened.bytes !== Number(row.bytes) || opened.sha256 !== row.sha256) {
    await opened.handle.close();
    throw statusError('Managed Skill report artifact failed integrity verification', 409);
  }
  return {
    fileHandle: opened.handle,
    bytes: opened.bytes,
    fileName: row.file_name,
    mediaType: row.media_type,
  };
}

async function openSkillReportArtifactResourceFile(
  sessionId,
  reportId,
  artifactId,
  resourceId,
  options = {},
) {
  const db = ensureStorage();
  const taskId = canonicalTaskId(sessionId);
  const row = db.prepare(`
    SELECT resource.* FROM skill_report_artifact_resources resource
    JOIN skill_report_artifacts artifact
      ON artifact.id=resource.artifact_id
      AND artifact.report_id=resource.report_id
      AND artifact.task_id=resource.task_id
    JOIN skill_reports report
      ON report.id=resource.report_id AND report.task_id=resource.task_id
    WHERE resource.task_id=? AND resource.report_id=?
      AND resource.artifact_id=? AND resource.id=?
  `).get(
    taskId,
    String(reportId || ''),
    String(artifactId || ''),
    String(resourceId || ''),
  );
  if (!row) return null;
  const expectedPath = skillReportArtifactResourceFile(
    taskId,
    row.report_id,
    row.artifact_id,
    row.id,
    path.extname(row.file_name).toLowerCase(),
  );
  if (path.resolve(row.managed_path) !== path.resolve(expectedPath)) {
    throw statusError('Managed pytest HTML media path does not match its report ownership', 409);
  }
  const openOptions = {
    signal: options.signal,
    label: `Managed pytest HTML media ${row.file_name}`,
    missingCode: 'REPORT_ARTIFACT_RESOURCE_MISSING',
  };
  let opened = await openRegularFileForRead(expectedPath, openOptions);
  const fingerprint = fileStatFingerprint(opened.stat);
  const cached = skillReportResourceVerificationCache.get(expectedPath);
  if (!cached || cached.fingerprint !== fingerprint || cached.sha256 !== row.sha256) {
    await opened.handle.close();
    opened = await openDigestedRegularFile(expectedPath, openOptions);
    if (opened.bytes !== Number(row.bytes) || opened.sha256 !== row.sha256) {
      await opened.handle.close();
      throw statusError('Managed pytest HTML media failed integrity verification', 409);
    }
    const verifiedFingerprint = fileStatFingerprint(await opened.handle.stat({ bigint: true }));
    skillReportResourceVerificationCache.set(expectedPath, {
      fingerprint: verifiedFingerprint,
      sha256: row.sha256,
    });
    if (skillReportResourceVerificationCache.size > MAX_PYTEST_MEDIA_RESOURCES) {
      skillReportResourceVerificationCache.delete(skillReportResourceVerificationCache.keys().next().value);
    }
  } else if (opened.bytes !== Number(row.bytes)) {
    await opened.handle.close();
    throw statusError('Managed pytest HTML media failed integrity verification', 409);
  }
  return {
    fileHandle: opened.handle,
    bytes: opened.bytes,
    fileName: row.file_name,
    mediaType: row.media_type,
  };
}

function listSkillReports(sessionId, options = {}) {
  const db = ensureStorage();
  const taskId = canonicalTaskId(sessionId);
  const history = options.history === true || options.history === '1';
  const where = history
    ? 'skill_reports.task_id=?'
    : `skill_reports.task_id=? AND skill_reports.revision=(
        SELECT MAX(latest.revision) FROM skill_reports latest
        WHERE latest.task_id=skill_reports.task_id AND latest.report_key=skill_reports.report_key
      )`;
  return db.prepare(`
    SELECT * FROM skill_reports
    WHERE ${where}
    ORDER BY published_at DESC, sequence DESC LIMIT ? OFFSET ?
  `).all(taskId, boundedLimit(options.limit, 100), boundedOffset(options.offset))
    .map((row) => rowToSkillReport(row, db));
}

function countAuditEvents() {
  return Number(ensureStorage().prepare('SELECT COUNT(*) AS count FROM audit_events').get().count);
}

function listAudit(options = {}) {
  const db = ensureStorage();
  const limit = boundedLimit(options.limit, 300);
  const offset = boundedOffset(options.offset);
  const clauses = [];
  const params = [];
  if (options.sessionId) {
    clauses.push('(task_id = ? OR entity_id = ?)');
    params.push(safeId(options.sessionId), safeId(options.sessionId));
  }
  if (options.kind) {
    clauses.push('kind LIKE ?');
    params.push(`%${String(options.kind)}%`);
  }
  if (options.q) {
    clauses.push("lower(kind || ' ' || message || ' ' || COALESCE(payload_json, '')) LIKE ?");
    params.push(`%${String(options.q).toLowerCase()}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const includePayload = options.includePayload !== false;
  const projection = includePayload
    ? '*'
    : `id, ts, actor, request_id, level, scope, kind,
       substr(message, 1, 1000) AS message, task_id, entity_type, entity_id,
       CASE WHEN payload_json IS NULL THEN 0 ELSE 1 END AS has_payload`;
  const rows = db.prepare(`SELECT ${projection} FROM audit_events ${where} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return rows.map((row) => ({
    id: row.id, ts: row.ts, actor: row.actor, requestId: row.request_id,
    level: row.level, scope: row.scope, kind: row.kind, message: row.message,
    sessionId: row.task_id, entityType: row.entity_type, entityId: row.entity_id,
    payload: includePayload ? parseJson(row.payload_json, null) : null,
    hasPayload: includePayload ? row.payload_json != null : Boolean(row.has_payload),
  }));
}

function appendSessionLatestLog(sessionId, chunk, reset = false) {
  ensureSessionStorage(sessionId);
  const filePath = sessionLatestLogFile(sessionId);
  const stat = writeManagedFile(filePath, String(chunk || ''), {
    append: !reset,
    mode: 0o600,
    label: 'Session latest log',
  });
  if (stat.size > LATEST_LOG_TRIM_THRESHOLD) {
    const tail = readManagedTextTail(filePath, MAX_LATEST_LOG_BYTES, {
      label: 'Session latest log',
    });
    writeManagedFile(filePath, tail, {
      mode: 0o600,
      label: 'Session latest log',
    });
  }
}

function readSessionLatestLog(sessionId) {
  if (!getSession(sessionId)) return '';
  const filePath = sessionLatestLogFile(sessionId);
  return readManagedTextTail(filePath, MAX_LATEST_LOG_BYTES, {
    label: 'Session latest log',
  });
}

function createTurn(taskId, input) {
  const db = ensureStorage();
  const id = eventId('turn');
  const now = nowIso();
  db.transaction(() => {
    const sequence = Number(db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM turns WHERE task_id = ?').get(taskId).value);
    db.prepare(`
      INSERT INTO turns(id, task_id, sequence, input, status, created_at, started_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?)
    `).run(id, taskId, sequence, String(input || ''), now, now);
  }).immediate();
  return db.prepare('SELECT * FROM turns WHERE id = ?').get(id);
}

function beginSessionTurn(data) {
  const db = ensureStorage();
  const taskId = safeId(data.taskId);
  const turnId = eventId('turn');
  const attemptId = data.createInitialAttempt ? eventId('attempt') : '';
  let session;
  let turn;
  db.transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) throw statusError(`Session ${taskId} not found`, 404);
    if (!task.enabled) throw statusError('Disabled sessions cannot be run', 409);
    if (task.status !== 'queued') throw statusError(`Session ${taskId} is no longer queued`, 409);
    if (task.lease_owner !== data.workerId) throw statusError(`Session ${taskId} lease is not owned by this worker`, 409);
    const command = db.prepare('SELECT * FROM commands WHERE id = ?').get(data.commandId);
    if (!command || command.task_id !== taskId || command.status !== 'processing' || command.worker_id !== data.workerId) {
      throw statusError(`Run command ${data.commandId} is no longer claimable`, 409);
    }

    const now = nowIso();
    const sequence = Number(db.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM turns WHERE task_id = ?').get(taskId).value);
    db.prepare(`
      INSERT INTO turns(id, task_id, sequence, input, status, created_at, started_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?)
    `).run(turnId, taskId, sequence, String(data.input || ''), now, now);
    const continuing = Boolean(task.persistent_session_key);
    const changed = db.prepare(`
      UPDATE tasks SET status=?, summary=?, last_run_at=?, run_count=run_count+1,
        current_pid=NULL, current_pid_start_ticks='', current_process_group_id=NULL,
        persistent_session_key=?, last_brief=?, last_error='', retry_count=0,
        recovery_count=CASE WHEN ?='recovery' THEN recovery_count ELSE 0 END,
        recovery_state=?, skill_snapshot_id=?, cancel_requested=0,
        version=version+1, updated_at=?
      WHERE id=? AND status='queued' AND enabled=1 AND lease_owner=?
    `).run(
      continuing ? 'recovering' : 'running',
      String(data.input || task.summary || ''),
      now,
      String(data.persistentSessionKey || task.persistent_session_key || ''),
      String(data.input || task.objective || ''),
      command.type,
      continuing ? 'resumed' : 'running',
      data.skillSnapshotId || task.skill_snapshot_id || null,
      now,
      taskId,
      data.workerId,
    );
    if (changed.changes !== 1) throw statusError(`Session ${taskId} could not start`, 409);
    if (attemptId) {
      db.prepare(`
        INSERT INTO attempts(id, task_id, turn_id, attempt_no, worker_id, status, started_at)
        VALUES (?, ?, ?, 1, ?, 'running', ?)
      `).run(attemptId, taskId, turnId, data.workerId, now);
    }
    session = rowToSession(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
    turn = db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId);
  }).immediate();
  return { session, turn, attemptId };
}

function finishTurn(turnId, status, result = '') {
  ensureStorage().prepare('UPDATE turns SET status = ?, result = ?, finished_at = ? WHERE id = ?')
    .run(status, String(result || ''), nowIso(), turnId);
}

function listTurns(taskId, limit = 100, offset = 0) {
  const rows = ensureStorage().prepare(`
    SELECT * FROM turns WHERE task_id = ? ORDER BY sequence DESC LIMIT ? OFFSET ?
  `).all(safeId(taskId), boundedLimit(limit, 100), boundedOffset(offset));
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.task_id,
    sequence: Number(row.sequence),
    input: row.input,
    status: row.status,
    result: row.result,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }));
}

function listAttempts(taskId, options = {}) {
  const clauses = ['a.task_id = ?'];
  const params = [safeId(taskId)];
  if (options.turnId) {
    clauses.push('a.turn_id = ?');
    params.push(String(options.turnId));
  }
  const rows = ensureStorage().prepare(`
    SELECT a.*, t.sequence AS turn_sequence, t.input AS turn_input
    FROM attempts a JOIN turns t ON t.id=a.turn_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY a.started_at DESC, a.attempt_no DESC LIMIT ? OFFSET ?
  `).all(
    ...params,
    boundedLimit(options.limit, 100),
    boundedOffset(options.offset),
  );
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.task_id,
    turnId: row.turn_id,
    turnSequence: Number(row.turn_sequence || 0),
    turnInput: row.turn_input || '',
    attemptNo: Number(row.attempt_no),
    workerId: row.worker_id,
    status: row.status,
    pid: row.pid,
    pidStartTicks: row.pid_start_ticks || '',
    processGroupId: row.process_group_id,
    exitCode: row.exit_code,
    signal: row.signal || '',
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ...attemptOutputEvidence(row.task_id, row.id),
  }));
}

function createAttempt(taskId, turnId, attemptNo, workerId) {
  const db = ensureStorage();
  const id = eventId('attempt');
  db.transaction(() => {
    const task = db.prepare(`
      SELECT id FROM tasks WHERE id=? AND lease_owner=?
        AND status IN ('running','recovering') AND cancel_requested=0
    `).get(taskId, workerId);
    const turn = db.prepare("SELECT id FROM turns WHERE id=? AND task_id=? AND status='running'")
      .get(turnId, taskId);
    if (!task || !turn) throw statusError(`Cannot create an attempt after session ${taskId} ownership changed`, 409);
    db.prepare(`
      INSERT INTO attempts(id, task_id, turn_id, attempt_no, worker_id, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?)
    `).run(id, taskId, turnId, Number(attemptNo), workerId, nowIso());
  }).immediate();
  return id;
}

function updateAttempt(attemptId, patch, expectedWorkerId = '') {
  const db = ensureStorage();
  const current = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!current) return false;
  const changed = db.prepare(`
    UPDATE attempts SET status=?, pid=?, pid_start_ticks=?, process_group_id=?,
      exit_code=?, signal=?, error=?, finished_at=?
    WHERE id=? AND (?='' OR (worker_id=? AND status='running'))
  `).run(
    patch.status ?? current.status,
    patch.pid ?? current.pid,
    patch.pidStartTicks ?? current.pid_start_ticks,
    patch.processGroupId ?? current.process_group_id,
    patch.exitCode ?? current.exit_code,
    patch.signal ?? current.signal,
    preserveString(patch.error ?? current.error),
    patch.finishedAt ?? current.finished_at,
    attemptId,
    String(expectedWorkerId || ''),
    String(expectedWorkerId || ''),
  );
  return changed.changes === 1;
}

function registerAttemptProcess(data) {
  const db = ensureStorage();
  const taskId = safeId(data.taskId);
  const pid = Number(data.pid);
  const processGroupId = Number(data.processGroupId);
  const pidStartTicks = String(data.pidStartTicks || '');
  if (!Number.isInteger(pid) || pid < 2 || processGroupId !== pid || !/^\d+$/.test(pidStartTicks)) {
    throw statusError('Execution process identity is invalid', 500);
  }
  let session;
  db.transaction(() => {
    const task = db.prepare(`
      SELECT * FROM tasks WHERE id=? AND lease_owner=?
        AND status IN ('running','recovering') AND cancel_requested=0
    `).get(taskId, data.workerId);
    const attempt = db.prepare(`
      SELECT * FROM attempts WHERE id=? AND task_id=? AND turn_id=?
        AND worker_id=? AND status='running' AND pid IS NULL
    `).get(data.attemptId, taskId, data.turnId, data.workerId);
    if (!task || !attempt) {
      throw statusError(`Session ${taskId} ownership changed before its process was registered`, 409);
    }
    const attemptChanged = db.prepare(`
      UPDATE attempts SET pid=?, pid_start_ticks=?, process_group_id=?
      WHERE id=? AND worker_id=? AND status='running' AND pid IS NULL
    `).run(pid, pidStartTicks, processGroupId, data.attemptId, data.workerId);
    if (attemptChanged.changes !== 1) throw statusError(`Attempt ${data.attemptId} process could not be registered`, 409);
    const taskChanged = db.prepare(`
      UPDATE tasks SET current_pid=?, current_pid_start_ticks=?, current_process_group_id=?,
        status=?, recovery_state=?, version=version+1, updated_at=?
      WHERE id=? AND lease_owner=? AND status IN ('running','recovering') AND cancel_requested=0
    `).run(
      pid,
      pidStartTicks,
      processGroupId,
      data.retryCount ? 'recovering' : 'running',
      data.retryCount ? 'retrying' : (task.run_count > 1 ? 'resumed' : 'running'),
      nowIso(),
      taskId,
      data.workerId,
    );
    if (taskChanged.changes !== 1) throw statusError(`Session ${taskId} process could not be registered`, 409);
    session = enrichSessionsWithScheduling(
      db,
      [rowToSession(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId))],
    )[0];
  }).immediate();
  return session;
}

function prepareSessionRetry(data) {
  const db = ensureStorage();
  const taskId = safeId(data.taskId);
  let session;
  db.transaction(() => {
    const task = db.prepare(`
      SELECT * FROM tasks WHERE id=? AND lease_owner=?
        AND status IN ('running','recovering')
    `).get(taskId, data.workerId);
    const attempt = db.prepare(`
      SELECT * FROM attempts WHERE id=? AND task_id=? AND turn_id=?
        AND worker_id=? AND status='running'
    `).get(data.attemptId, taskId, data.turnId, data.workerId);
    if (!task || !attempt) throw statusError(`Cannot retry session ${taskId} after ownership changed`, 409);
    const now = String(data.finishedAt || nowIso());
    db.prepare(`
      UPDATE attempts SET status='failed', exit_code=?, signal=?, error=?, finished_at=?
      WHERE id=? AND status='running' AND worker_id=?
    `).run(data.exitCode ?? null, data.signal || null, String(data.summary || ''), now, data.attemptId, data.workerId);
    db.prepare(`
      UPDATE command_executions SET status='failed',
        finished_at=CASE WHEN finished_at='' THEN ? ELSE finished_at END
      WHERE attempt_id=? AND status NOT IN ('completed','failed','cancelled','interrupted')
    `).run(now, data.attemptId);
    const changed = db.prepare(`
      UPDATE tasks SET current_pid=NULL, current_pid_start_ticks='', current_process_group_id=NULL,
        summary=?, retry_count=?, last_error=?,
        status='recovering', recovery_state='retry_scheduled', version=version+1, updated_at=?
      WHERE id=? AND lease_owner=? AND status IN ('running','recovering')
    `).run(
      String(data.summary || ''), Number(data.retryCount || 0), String(data.summary || ''),
      nowIso(), taskId, data.workerId,
    );
    if (changed.changes !== 1) throw statusError(`Cannot schedule retry after session ${taskId} ownership changed`, 409);
    insertSessionWorklog(db, taskId, {
      turnId: data.turnId,
      kind: 'session.retry.scheduled',
      level: 'warn',
      message: `Transient failure detected; retry ${Number(data.retryCount || 0)}/${Number(data.maxRetries || 0)} scheduled in ${Math.round(Number(data.delayMs || 0) / 1000)}s`,
      payload: { exitCode: data.exitCode ?? null, signal: data.signal || null, summary: String(data.summary || '') },
    });
    session = enrichSessionsWithScheduling(
      db,
      [rowToSession(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId))],
    )[0];
  }).immediate();
  return session;
}

function normalizeTrackedPath(value, field, workingDirectory = '') {
  const input = String(value || '').trim().replace(/^(["'`])(.*)\1$/, '$2');
  if (!input || input.includes('\0') || input.length > 4096) {
    throw statusError(`${field} must be a non-empty filesystem path`, 400);
  }
  return path.isAbsolute(input) ? path.normalize(input) : path.resolve(workingDirectory || '.', input);
}

function normalizeExternalArtifactDeclarations(value, workingDirectory) {
  const artifacts = normalizeArtifactDeclarations(value || [], 'external artifacts');
  const root = path.resolve(workingDirectory || '.');
  for (const artifact of artifacts) {
    if (!pathContains(root, artifact.path)) {
      throw statusError('External artifact paths must remain inside the execution working directory', 400);
    }
  }
  return artifacts;
}

function assertExternalArtifactPathsUnclaimed(db, taskId, artifacts) {
  if (!artifacts.length) return;
  const requestedPaths = new Set(artifacts.map((artifact) => artifact.path));
  const attempts = db.prepare(`
    SELECT task_id, artifact_declarations_json
    FROM external_attempts
    WHERE task_id<>? AND artifact_declarations_json<>'[]'
  `).all(taskId);
  for (const attempt of attempts) {
    const conflict = parseJson(attempt.artifact_declarations_json, [])
      .find((artifact) => artifact && requestedPaths.has(String(artifact.path || '')));
    if (conflict) {
      throw statusError(
        `External artifact path is already registered by task ${attempt.task_id}`,
        409,
      );
    }
  }
}

function assertMatchingExternalArtifacts(row, artifacts) {
  const existing = parseJson(row?.artifact_declarations_json, []);
  if (JSON.stringify(existing) !== JSON.stringify(artifacts)) {
    throw statusError('Background execution evidence is already registered with different artifacts', 409);
  }
}

const STEP_RUN_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function canonicalStepRunKey(value, field) {
  const key = String(value || '').trim();
  if (!STEP_RUN_KEY_PATTERN.test(key)) {
    throw statusError(`${field} must match ^[a-z0-9][a-z0-9._-]{0,127}$`, 400);
  }
  return key;
}

function normalizedTargetCount(value) {
  if (value == null || String(value).trim() === '') return null;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw statusError('targetCount must be a non-negative integer', 400);
  }
  return count;
}

function rowToStepRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.task_id,
    stepId: row.step_id,
    runKey: row.run_key,
    runKind: row.run_kind,
    runNumber: Number(row.run_number),
    sourceRunId: row.source_run_id || '',
    sourceRunKey: row.source_run_key || '',
    selectionMode: row.selection_mode || '',
    targetCount: row.target_count == null ? null : Number(row.target_count),
    status: row.status,
    createdByTurnId: row.created_by_turn_id || '',
    createdByAttemptId: row.created_by_attempt_id || '',
    startedAt: row.started_at || '',
    finishedAt: row.finished_at || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    externalAttemptIds: parseJson(row.external_attempt_ids, []),
    reportIds: parseJson(row.report_ids, []),
  };
}

function listTaskSteps(sessionId) {
  const db = ensureStorage();
  const taskId = canonicalTaskId(sessionId);
  const steps = db.prepare(`
    SELECT * FROM task_steps WHERE task_id=? ORDER BY ordinal, created_at, id
  `).all(taskId);
  const runs = db.prepare(`
    SELECT run.*, source.run_key AS source_run_key,
      COALESCE((
        SELECT json_group_array(id) FROM (
          SELECT external.id FROM external_attempts external
          WHERE external.step_run_id=run.id ORDER BY external.created_at, external.id
        )
      ), '[]') AS external_attempt_ids,
      COALESCE((
        SELECT json_group_array(id) FROM (
          SELECT report.id FROM skill_reports report
          WHERE report.step_run_id=run.id ORDER BY report.published_at, report.sequence
        )
      ), '[]') AS report_ids
    FROM step_runs run
    LEFT JOIN step_runs source ON source.id=run.source_run_id
    WHERE run.task_id=?
    ORDER BY run.step_id, run.run_number, run.created_at, run.id
  `).all(taskId).map(rowToStepRun);
  const runsByStep = new Map();
  for (const run of runs) {
    if (!runsByStep.has(run.stepId)) runsByStep.set(run.stepId, []);
    runsByStep.get(run.stepId).push(run);
  }
  return steps.map((step) => ({
    id: step.id,
    sessionId: step.task_id,
    key: step.step_key,
    label: step.label,
    ordinal: Number(step.ordinal),
    status: step.status,
    createdAt: step.created_at,
    updatedAt: step.updated_at,
    runs: runsByStep.get(step.id) || [],
  }));
}

function requestedStepRunIdentity(data) {
  const stepRunId = String(data.stepRunId || '').trim();
  const supplied = [
    data.stepKey, data.stepLabel, data.runKey, data.runKind,
    data.sourceRunKey, data.selectionMode, data.targetCount,
  ].some((value) => value != null && String(value).trim() !== '');
  if (stepRunId && supplied) {
    throw statusError('stepRunId cannot be combined with Step or Run creation options', 400);
  }
  if (stepRunId) return { stepRunId };
  if (!supplied) return null;
  const stepKey = canonicalStepRunKey(data.stepKey, 'stepKey');
  const runKey = canonicalStepRunKey(data.runKey, 'runKey');
  const runKind = String(data.runKind || '').trim();
  if (!['initial', 'rerun'].includes(runKind)) {
    throw statusError('runKind must be initial or rerun', 400);
  }
  const sourceRunKey = String(data.sourceRunKey || '').trim();
  if (runKind === 'rerun' && !sourceRunKey) {
    throw statusError('sourceRunKey is required for a rerun', 400);
  }
  if (runKind === 'initial' && sourceRunKey) {
    throw statusError('sourceRunKey is only valid for a rerun', 400);
  }
  const requestedStepLabel = String(data.stepLabel || '').trim() || stepKey;
  if (requestedStepLabel.length > 200) {
    throw statusError('stepLabel exceeds 200 characters', 400);
  }
  return {
    stepKey,
    stepLabel: requestedStepLabel,
    runKey,
    runKind,
    sourceRunKey: sourceRunKey ? canonicalStepRunKey(sourceRunKey, 'sourceRunKey') : '',
    selectionMode: String(data.selectionMode || '').trim().slice(0, 128),
    targetCount: normalizedTargetCount(data.targetCount),
  };
}

function resolveExternalStepRun(db, taskId, data, originTurnId, originAttemptId) {
  const identity = requestedStepRunIdentity(data);
  if (!identity) return null;
  if (identity.stepRunId) {
    const existing = db.prepare(`
      SELECT run.*, step.step_key, step.label AS step_label
      FROM step_runs run JOIN task_steps step ON step.id=run.step_id
      WHERE run.id=? AND run.task_id=? AND step.task_id=?
    `).get(identity.stepRunId, taskId, taskId);
    if (!existing) throw statusError('stepRunId does not belong to this task', 409);
    return existing;
  }

  let step = db.prepare('SELECT * FROM task_steps WHERE task_id=? AND step_key=?')
    .get(taskId, identity.stepKey);
  const now = nowIso();
  if (!step) {
    const ordinal = Number(db.prepare(`
      SELECT COALESCE(MAX(ordinal), 0) + 1 AS value FROM task_steps WHERE task_id=?
    `).get(taskId).value);
    const stepId = eventId('step');
    db.prepare(`
      INSERT INTO task_steps(id, task_id, step_key, label, ordinal, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(stepId, taskId, identity.stepKey, identity.stepLabel, ordinal, now, now);
    step = db.prepare('SELECT * FROM task_steps WHERE id=?').get(stepId);
  } else if (step.label !== identity.stepLabel) {
    throw statusError(`Step ${identity.stepKey} is already registered with label ${step.label}`, 409);
  }

  let sourceRun = null;
  if (identity.sourceRunKey) {
    sourceRun = db.prepare('SELECT * FROM step_runs WHERE step_id=? AND run_key=?')
      .get(step.id, identity.sourceRunKey);
    if (!sourceRun) throw statusError('sourceRunKey does not identify a Run in this Step', 409);
  }
  const existing = db.prepare('SELECT * FROM step_runs WHERE step_id=? AND run_key=?')
    .get(step.id, identity.runKey);
  if (existing) {
    const sameIdentity = existing.run_kind === identity.runKind
      && (existing.source_run_id || '') === (sourceRun?.id || '')
      && existing.selection_mode === identity.selectionMode
      && (existing.target_count == null ? null : Number(existing.target_count)) === identity.targetCount;
    if (!sameIdentity) {
      throw statusError(`Run ${identity.runKey} is already registered with different semantics`, 409);
    }
    return { ...existing, step_key: step.step_key, step_label: step.label };
  }
  if (identity.runKind === 'initial') {
    const initial = db.prepare("SELECT run_key FROM step_runs WHERE step_id=? AND run_kind='initial'")
      .get(step.id);
    if (initial) throw statusError(`Step ${identity.stepKey} already has initial Run ${initial.run_key}`, 409);
  }
  const runNumber = identity.runKind === 'initial'
    ? 0
    : Number(db.prepare(`
      SELECT COALESCE(MAX(run_number), 0) + 1 AS value FROM step_runs WHERE step_id=?
    `).get(step.id).value);
  const runId = eventId('step-run');
  db.prepare(`
    INSERT INTO step_runs(
      id, task_id, step_id, run_key, run_kind, run_number, source_run_id,
      selection_mode, target_count, status, created_by_turn_id, created_by_attempt_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(
    runId, taskId, step.id, identity.runKey, identity.runKind, runNumber,
    sourceRun?.id || null, identity.selectionMode, identity.targetCount,
    originTurnId || null, originAttemptId || null, now, now,
  );
  return {
    ...db.prepare('SELECT * FROM step_runs WHERE id=?').get(runId),
    step_key: step.step_key,
    step_label: step.label,
  };
}

function refreshStepRunStatus(db, stepRunId) {
  if (!stepRunId) return;
  const run = db.prepare('SELECT * FROM step_runs WHERE id=?').get(stepRunId);
  if (!run) return;
  const attempts = db.prepare(`
    SELECT * FROM external_attempts WHERE step_run_id=?
    ORDER BY chain_key, generation DESC, created_at DESC
  `).all(stepRunId);
  const latestByChain = new Map();
  for (const attempt of attempts) {
    if (!latestByChain.has(attempt.chain_key)) latestByChain.set(attempt.chain_key, attempt);
  }
  const latest = [...latestByChain.values()];
  let status = 'pending';
  if (latest.some((attempt) => attempt.status === 'running')) status = 'running';
  else if (latest.some((attempt) => attempt.status === 'failed')) status = 'failed';
  else if (latest.some((attempt) => attempt.status === 'lost')) status = 'lost';
  else if (latest.some((attempt) => attempt.status === 'cancelled')) status = 'cancelled';
  else if (latest.length && latest.every((attempt) => attempt.status === 'succeeded')) status = 'succeeded';
  const startedAt = attempts.map((attempt) => attempt.started_at).filter(Boolean).sort()[0] || '';
  const finishedAt = ['pending', 'running'].includes(status)
    ? ''
    : latest.map((attempt) => attempt.finished_at).filter(Boolean).sort().at(-1) || '';
  const now = nowIso();
  db.prepare(`
    UPDATE step_runs SET status=?, started_at=?, finished_at=?, updated_at=? WHERE id=?
  `).run(status, startedAt, finishedAt, now, stepRunId);
  const runningStep = db.prepare(`
    SELECT 1 FROM step_runs WHERE step_id=? AND status='running' LIMIT 1
  `).get(run.step_id);
  const latestRun = db.prepare(`
    SELECT status FROM step_runs WHERE step_id=?
    ORDER BY run_number DESC, created_at DESC LIMIT 1
  `).get(run.step_id);
  db.prepare('UPDATE task_steps SET status=?, updated_at=? WHERE id=?')
    .run(runningStep ? 'running' : (latestRun?.status || 'pending'), now, run.step_id);
}

function backgroundCommandEvidence(logPath) {
  const normalizedLogPath = String(logPath || '');
  const basePath = normalizedLogPath.endsWith('.log') ? normalizedLogPath.slice(0, -4) : normalizedLogPath;
  const commandPath = `${basePath}.cmd`;
  try {
    const stat = fs.lstatSync(commandPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
      return { commandPath, command: '' };
    }
    return { commandPath, command: fs.readFileSync(commandPath, 'utf8') };
  } catch {
    return { commandPath, command: '' };
  }
}

function rowToExternalAttempt(row) {
  if (!row) return null;
  const commandEvidence = backgroundCommandEvidence(row.log_path);
  return {
    id: row.id,
    sessionId: row.task_id,
    stepRunId: row.step_run_id || '',
    originTurnId: row.origin_turn_id || '',
    originAttemptId: row.origin_attempt_id || '',
    sourceCommandExecutionId: row.source_command_execution_id || '',
    chainKey: row.chain_key,
    generation: Number(row.generation),
    label: row.label,
    status: row.status,
    pid: row.pid,
    pidStartTicks: row.pid_start_ticks || '',
    processGroupId: row.process_group_id,
    cgroupPath: row.cgroup_path || '',
    cgroupInode: row.cgroup_inode || '',
    logPath: row.log_path,
    commandPath: commandEvidence.commandPath,
    command: commandEvidence.command,
    donePath: row.done_path,
    statePath: row.state_path,
    metaPath: row.meta_path,
    artifactDeclarations: parseJson(row.artifact_declarations_json, []),
    checkIntervalSeconds: Number(row.check_interval_seconds),
    followUpPrompt: row.follow_up_prompt,
    lastObservation: row.last_observation,
    result: parseJson(row.result_json, {}),
    archivedLogPath: row.archived_log_path || '',
    archivedLogBytes: row.archived_log_bytes == null ? null : Number(row.archived_log_bytes),
    archivedLogSha256: row.archived_log_sha256 || '',
    archiveStatus: row.archive_status || 'pending',
    archiveError: row.archive_error || '',
    archiveAttemptCount: Number(row.archive_attempt_count || 0),
    archiveNextRetryAt: row.archive_next_retry_at || '',
    archiveLeaseOwner: row.archive_lease_owner || '',
    archiveLeaseExpiresAt: row.archive_lease_expires_at || '',
    archivedAt: row.archived_at || '',
    archiveVerifyStatus: row.archive_verify_status || 'pending',
    archiveVerifyError: row.archive_verify_error || '',
    archiveVerifyCount: Number(row.archive_verify_count || 0),
    archiveVerifiedAt: row.archive_verified_at || '',
    archiveVerifyNextAt: row.archive_verify_next_at || '',
    archiveVerifyLeaseOwner: row.archive_verify_lease_owner || '',
    archiveVerifyLeaseExpiresAt: row.archive_verify_lease_expires_at || '',
    startedAt: row.started_at,
    lastCheckedAt: row.last_checked_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToScheduledJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.task_id,
    externalAttemptId: row.external_attempt_id || '',
    generation: Number(row.generation),
    sequence: Number(row.sequence),
    kind: row.kind,
    dueAt: row.due_at,
    payload: parseJson(row.payload_json, {}),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    leaseOwner: row.lease_owner || '',
    leaseExpiresAt: row.lease_expires_at || '',
    commandId: row.command_id || '',
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function buildExternalFollowUpPrompt(attempt) {
  const customPrompt = String(attempt.followUpPrompt || '').trim();
  return [
    `Continue background execution ${attempt.id} in this same task Session.`,
    `Business label: ${attempt.label || attempt.id}`,
    `PID (auxiliary only): ${attempt.pid || 'unknown'}`,
    `LOG: ${attempt.logPath}`,
    `DONE: ${attempt.donePath || '(not provided)'}`,
    `STATE: ${attempt.statePath || '(not provided)'}`,
    `META: ${attempt.metaPath || '(not provided)'}`,
    'Inspect DONE, STATE and META before PID because process IDs can be reused.',
    'If it is still running, report the current observation. The platform will schedule the next durable check.',
    'If it is terminal, collect the final result and report success or failure with concrete evidence.',
    customPrompt,
  ].filter(Boolean).join('\n');
}

function enrichExternalFollowUp(db, row, followUpPrompt) {
  const prompt = String(followUpPrompt || '').trim().slice(0, 16000);
  if (!prompt || String(row.follow_up_prompt || '').trim()) return rowToExternalAttempt(row);
  const now = nowIso();
  db.prepare(`
    UPDATE external_attempts SET follow_up_prompt=?, updated_at=? WHERE id=?
  `).run(prompt, now, row.id);
  const updatedRow = db.prepare('SELECT * FROM external_attempts WHERE id=?').get(row.id);
  const attempt = rowToExternalAttempt(updatedRow);
  const schedules = db.prepare(`
    SELECT * FROM scheduled_jobs
    WHERE external_attempt_id=? AND generation=? AND status IN ('pending','leased')
  `).all(row.id, Number(row.generation));
  const updateSchedule = db.prepare('UPDATE scheduled_jobs SET payload_json=?, updated_at=? WHERE id=?');
  for (const schedule of schedules) {
    const payload = parseJson(schedule.payload_json, {});
    payload.prompt = buildExternalFollowUpPrompt(attempt);
    updateSchedule.run(JSON.stringify(payload), now, schedule.id);
  }
  return attempt;
}

function insertScheduledJob(db, attempt, dueAt = '') {
  const sequence = Number(db.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS value
    FROM scheduled_jobs WHERE external_attempt_id=? AND generation=?
  `).get(attempt.id, Number(attempt.generation)).value);
  const id = eventId('scheduled');
  const now = nowIso();
  const scheduledAt = String(dueAt || new Date(Date.now()
    + (boundedExternalCheckSeconds(attempt.checkIntervalSeconds) * 1000)).toISOString());
  const payload = {
    externalAttemptId: attempt.id,
    generation: Number(attempt.generation),
    sequence,
    prompt: buildExternalFollowUpPrompt(attempt),
    pid: attempt.pid || null,
    logPath: attempt.logPath,
    donePath: attempt.donePath,
    statePath: attempt.statePath,
    metaPath: attempt.metaPath,
  };
  db.prepare(`
    INSERT INTO scheduled_jobs(
      id, task_id, external_attempt_id, generation, sequence, kind, due_at,
      payload_json, idempotency_key, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'external_check', ?, ?, ?, 'pending', ?, ?)
  `).run(
    id, attempt.sessionId, attempt.id, Number(attempt.generation), sequence, scheduledAt,
    JSON.stringify(payload), `${attempt.id}:${attempt.generation}:${sequence}`, now, now,
  );
  insertSessionWorklog(db, attempt.sessionId, {
    turnId: attempt.originTurnId || null,
    kind: 'schedule.created',
    message: `Scheduled background check ${sequence} for ${attempt.label || attempt.id}`,
    payload: { scheduledJobId: id, externalAttemptId: attempt.id, generation: attempt.generation, sequence, dueAt: scheduledAt },
  });
  return rowToScheduledJob(db.prepare('SELECT * FROM scheduled_jobs WHERE id=?').get(id));
}

function listExternalAttempts(taskId, options = {}) {
  const db = ensureStorage();
  const statuses = String(options.status || '').split(',').map((item) => item.trim()).filter(Boolean);
  const statusSql = statuses.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
  return db.prepare(`
    SELECT * FROM external_attempts WHERE task_id=?${statusSql}
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(
    safeId(taskId), ...statuses, boundedLimit(options.limit, 100), boundedOffset(options.offset),
  ).map(rowToExternalAttempt);
}

function getExternalAttempt(taskId, attemptId) {
  return rowToExternalAttempt(ensureStorage().prepare(`
    SELECT * FROM external_attempts WHERE task_id=? AND id=?
  `).get(safeId(taskId), String(attemptId || '')));
}

async function openExternalAttemptLogFile(taskId, attemptId, options = {}) {
  const db = ensureStorage();
  const normalizedTaskId = safeId(taskId);
  const row = db.prepare(`
    SELECT * FROM external_attempts WHERE task_id=? AND id=?
  `).get(normalizedTaskId, String(attemptId || ''));
  if (!row) return null;
  if (row.archive_status === 'archived') {
    const expectedPath = externalAttemptArchiveFile(row.task_id, row.id);
    let observed = null;
    let opened = null;
    let error = null;
    try {
      if (path.resolve(row.archived_log_path) !== path.resolve(expectedPath)) {
        const mismatch = new Error('Managed archive path does not match its task ownership');
        mismatch.code = 'ARCHIVE_PATH_MISMATCH';
        throw mismatch;
      }
      opened = await openDigestedRegularFile(expectedPath, { signal: options.signal });
      observed = {
        bytes: opened.bytes,
        sha256: opened.sha256,
      };
      if (observed.bytes !== Number(row.archived_log_bytes)
        || observed.sha256 !== row.archived_log_sha256) {
        const mismatch = new Error('Managed archive size or SHA-256 does not match its record');
        mismatch.code = 'ARCHIVE_DIGEST_MISMATCH';
        throw mismatch;
      }
      return { fileHandle: opened.handle, filePath: expectedPath, bytes: observed.bytes };
    } catch (caught) {
      error = caught;
      try { await opened?.handle.close(); } catch {}
    }
    if (error?.code === 'ARCHIVE_READ_ABORTED') {
      error.statusCode = 499;
      error.expected = true;
      throw error;
    }
    recordExternalArchiveIntegrityFailure(db, row, error, observed, 'api-integrity-check');
    throw statusError('Preserved background log failed integrity verification', 409);
  }
  if (row.archived_log_sha256) {
    throw statusError('Preserved background log is awaiting integrity repair', 409);
  }
  try {
    const opened = await openRegularFileForRead(row.log_path, {
      label: 'Tracked log',
      missingCode: 'TRACKED_LOG_MISSING',
      signal: options.signal,
    });
    return { fileHandle: opened.handle, filePath: row.log_path, bytes: opened.bytes };
  } catch (error) {
    if (error?.code === 'ARCHIVE_READ_ABORTED') {
      error.statusCode = 499;
      error.expected = true;
      throw error;
    }
    return null;
  }
}

async function openExternalAttemptArtifactFile(taskId, attemptId, artifactKey, options = {}) {
  const db = ensureStorage();
  const normalizedTaskId = safeId(taskId);
  const declaration = externalArtifactDeclaration(db, normalizedTaskId, attemptId, artifactKey);
  if (!declaration) return null;
  const mediaType = declaration.kind === 'pytest-html'
    ? 'text/html; charset=utf-8'
    : declaration.kind === 'failure-analysis-markdown'
      ? 'text/markdown; charset=utf-8'
      : '';
  if (!mediaType) return null;
  let opened;
  try {
    opened = await openRegularFileForRead(declaration.path, {
      label: 'Registered background artifact',
      missingCode: 'REGISTERED_ARTIFACT_MISSING',
      signal: options.signal,
    });
    const openedPath = await fs.promises.realpath(`/proc/self/fd/${opened.handle.fd}`);
    if (openedPath !== path.resolve(declaration.path)) {
      await opened.handle.close();
      throw statusError('Registered background artifact must not use symbolic links', 409);
    }
  } catch (error) {
    try { await opened?.handle.close(); } catch {}
    if (error?.code === 'REGISTERED_ARTIFACT_MISSING') return null;
    if (error?.code === 'ARCHIVE_READ_ABORTED') {
      error.statusCode = 499;
      error.expected = true;
    }
    throw error;
  }
  if (opened.bytes > MAX_SKILL_REPORT_ARTIFACT_BYTES) {
    await opened.handle.close();
    throw statusError(`Registered artifact exceeds ${MAX_SKILL_REPORT_ARTIFACT_BYTES} bytes`, 413);
  }
  if (mediaType === 'text/html; charset=utf-8') {
    try {
      const snapshot = await readExternalArtifactSnapshot(opened);
      await opened.handle.close();
      opened = null;
      const sourcePath = path.resolve(declaration.path);
      let preview = snapshot;
      try {
        const selfContained = await selfContainedPytestHtml(
          snapshot,
          sourcePath,
          path.dirname(sourcePath),
          { includeLogs: false },
        );
        preview = externalArtifactPreviewHtml(
          selfContained.content,
          taskId,
          attemptId,
          artifactKey,
        );
      } catch {
        // The report stays viewable while an optional local dependency is still being written.
      }
      return {
        content: preview,
        bytes: preview.length,
        fileName: path.basename(declaration.path),
        mediaType,
      };
    } catch (error) {
      try { await opened?.handle.close(); } catch {}
      throw error;
    }
  }
  return {
    fileHandle: opened.handle,
    bytes: opened.bytes,
    fileName: path.basename(declaration.path),
    mediaType,
  };
}

async function openExternalAttemptArtifactResourceFile(taskId, attemptId, artifactKey, resourcePath, options = {}) {
  const db = ensureStorage();
  const normalizedTaskId = safeId(taskId);
  const declaration = externalArtifactDeclaration(db, normalizedTaskId, attemptId, artifactKey);
  if (!declaration || declaration.kind !== 'pytest-html') return null;
  let relativePath;
  try {
    relativePath = decodeLocalArtifactReference(resourcePath, 'Registered background artifact resource');
  } catch (error) {
    error.statusCode = 404;
    throw error;
  }
  const root = path.dirname(path.resolve(declaration.path));
  const sourcePath = path.resolve(root, relativePath);
  if (!pathContains(root, sourcePath)) return null;
  let opened;
  try {
    opened = await openRegularFileForRead(sourcePath, {
      label: 'Registered background artifact resource',
      missingCode: 'REGISTERED_ARTIFACT_RESOURCE_MISSING',
      signal: options.signal,
    });
    const openedPath = await fs.promises.realpath(`/proc/self/fd/${opened.handle.fd}`);
    const sourceRoot = await fs.promises.realpath(root);
    if (!pathContains(sourceRoot, openedPath) || openedPath !== sourcePath) {
      throw statusError('Registered background artifact resource must not use symbolic links', 409);
    }
  } catch (error) {
    try { await opened?.handle.close(); } catch {}
    if (error?.code === 'REGISTERED_ARTIFACT_RESOURCE_MISSING') return null;
    throw error;
  }
  if (opened.bytes > MAX_SKILL_REPORT_ARTIFACT_BYTES) {
    await opened.handle.close();
    throw statusError(`Registered artifact resource exceeds ${MAX_SKILL_REPORT_ARTIFACT_BYTES} bytes`, 413);
  }
  return {
    fileHandle: opened.handle,
    bytes: opened.bytes,
    fileName: path.basename(sourcePath),
    mediaType: externalArtifactMediaType(sourcePath),
  };
}

async function getExternalAttemptLogFile(taskId, attemptId) {
  const opened = await openExternalAttemptLogFile(taskId, attemptId);
  if (!opened) return '';
  try {
    return opened.filePath;
  } finally {
    await opened.fileHandle.close();
  }
}

function listScheduledJobs(taskId, options = {}) {
  const db = ensureStorage();
  const statuses = String(options.status || '').split(',').map((item) => item.trim()).filter(Boolean);
  const statusSql = statuses.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
  return db.prepare(`
    SELECT * FROM scheduled_jobs WHERE task_id=?${statusSql}
    ORDER BY due_at DESC, sequence DESC LIMIT ? OFFSET ?
  `).all(
    safeId(taskId), ...statuses, boundedLimit(options.limit, 100), boundedOffset(options.offset),
  ).map(rowToScheduledJob);
}

function registerExternalAttempt(data, context = {}) {
  const db = ensureStorage();
  const taskId = safeId(data.taskId || process.env.CODEX_TASK_ID);
  let registered;
  db.transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task) throw statusError(`Session ${taskId} not found`, 404);
    if (task.status === 'completed') throw statusError('Completed sessions cannot track background work', 409);
    if (task.cancel_requested || ['stopping', 'stopped'].includes(task.status)) {
      throw statusError('Stopped sessions cannot register new background work', 409);
    }
    const originTurnId = String(data.turnId || process.env.CODEX_TASK_TURN_ID || '');
    const originAttemptId = String(data.attemptId || process.env.CODEX_TASK_ATTEMPT_ID || '');
    const originTurn = originTurnId
      ? db.prepare('SELECT * FROM turns WHERE id=? AND task_id=?').get(originTurnId, taskId)
      : null;
    if (originTurnId && !originTurn) {
      throw statusError('The background execution turn does not belong to this task', 409);
    }
    const originAttempt = originAttemptId
      ? db.prepare('SELECT * FROM attempts WHERE id=? AND task_id=?').get(originAttemptId, taskId)
      : null;
    if (originAttemptId && !originAttempt) {
      throw statusError('The background execution attempt does not belong to this task', 409);
    }
    if (originTurn && originAttempt && originAttempt.turn_id !== originTurn.id) {
      throw statusError('The background execution attempt does not belong to the supplied turn', 409);
    }
    const workingDirectory = String(data.workingDirectory || task.working_dir || '.');
    const artifactsSupplied = data.artifacts != null;
    const artifactDeclarations = normalizeExternalArtifactDeclarations(data.artifacts, workingDirectory);
    assertExternalArtifactPathsUnclaimed(db, taskId, artifactDeclarations);
    const sourceExecutionId = String(data.sourceCommandExecutionId || '');
    const sourceExecution = sourceExecutionId
      ? db.prepare('SELECT * FROM command_executions WHERE id=?').get(sourceExecutionId)
      : null;
    if (sourceExecutionId && (!sourceExecution || sourceExecution.task_id !== taskId
      || (originTurnId && sourceExecution.turn_id !== originTurnId)
      || (originAttemptId && sourceExecution.attempt_id !== originAttemptId))) {
      throw statusError('The source command execution does not belong to this background attempt', 409);
    }
    const stepRun = resolveExternalStepRun(
      db,
      taskId,
      data,
      originTurnId,
      originAttemptId,
    );
    const assertMatchingStepRun = (row) => {
      if (stepRun && row && row.step_run_id !== stepRun.id) {
        throw statusError('Background execution evidence is already bound to a different Run', 409);
      }
    };
    if (sourceExecutionId) {
      const existing = db.prepare('SELECT * FROM external_attempts WHERE source_command_execution_id=?').get(sourceExecutionId);
      if (existing) {
        assertMatchingStepRun(existing);
        if (artifactsSupplied) assertMatchingExternalArtifacts(existing, artifactDeclarations);
        registered = enrichExternalFollowUp(db, existing, data.followUpPrompt);
        return;
      }
    }
    const logPath = normalizeTrackedPath(data.logPath, 'logPath', workingDirectory);
    const basePath = logPath.endsWith('.log') ? logPath.slice(0, -4) : logPath;
    const label = String(data.label || path.basename(basePath) || 'background execution').slice(0, 300);
    const previousRunAttempt = stepRun ? db.prepare(`
      SELECT chain_key FROM external_attempts WHERE step_run_id=?
      ORDER BY created_at DESC, generation DESC LIMIT 1
    `).get(stepRun.id) : null;
    const requestedChainKey = String(data.chainKey || '');
    if (previousRunAttempt && requestedChainKey
      && requestedChainKey !== previousRunAttempt.chain_key) {
      throw statusError('A Run cannot switch to a different background execution chain', 409);
    }
    const chainKey = requestedChainKey
      || previousRunAttempt?.chain_key
      || hashContent(`${label}\0${logPath}`).slice(0, 32);
    const existingChainOwner = db.prepare(`
      SELECT step_run_id FROM external_attempts
      WHERE task_id=? AND chain_key=?
      ORDER BY generation DESC, created_at DESC LIMIT 1
    `).get(taskId, chainKey);
    if (existingChainOwner
      && (existingChainOwner.step_run_id || null) !== (stepRun?.id || null)) {
      throw statusError('A background execution chain cannot belong to different Runs', 409);
    }
    const pid = Number.isInteger(Number(data.pid)) && Number(data.pid) >= 2 ? Number(data.pid) : null;
    const donePath = normalizeTrackedPath(data.donePath || `${basePath}.done`, 'donePath', workingDirectory);
    const statePath = normalizeTrackedPath(data.statePath || `${basePath}.state`, 'statePath', workingDirectory);
    const metaPath = normalizeTrackedPath(data.metaPath || `${basePath}.meta`, 'metaPath', workingDirectory);
    const matchingEvidence = db.prepare(`
      SELECT * FROM external_attempts
      WHERE task_id=? AND log_path=? AND done_path=? AND state_path=? AND meta_path=?
        AND pid IS ?
      ORDER BY generation DESC LIMIT 1
    `).get(taskId, logPath, donePath, statePath, metaPath, pid);
    if (matchingEvidence && matchingEvidence.status !== 'running') {
      assertMatchingStepRun(matchingEvidence);
      const sameOrigin = originAttemptId && matchingEvidence.origin_attempt_id === originAttemptId;
      const originStartedAt = Date.parse(originAttempt?.started_at || '');
      const evidenceTimes = [donePath, statePath, metaPath].map((filePath) => {
        try {
          const stat = fs.lstatSync(filePath);
          return stat.isFile() && !stat.isSymbolicLink() ? stat.mtimeMs : NaN;
        } catch {
          return NaN;
        }
      }).filter(Number.isFinite);
      const evidencePredatesOrigin = Number.isFinite(originStartedAt)
        && evidenceTimes.length > 0
        && Math.max(...evidenceTimes) < originStartedAt;
      if (sameOrigin || evidencePredatesOrigin) {
        if (artifactsSupplied) assertMatchingExternalArtifacts(matchingEvidence, artifactDeclarations);
        registered = enrichExternalFollowUp(db, matchingEvidence, data.followUpPrompt);
        return;
      }
    }
    const matchingActive = db.prepare(`
      SELECT * FROM external_attempts
      WHERE task_id=? AND log_path=? AND status='running'
      ORDER BY generation DESC LIMIT 1
    `).get(taskId, logPath);
    assertMatchingStepRun(matchingActive);
    const sameOrigin = matchingActive && originAttemptId
      && matchingActive.origin_attempt_id === originAttemptId;
    const sameSource = matchingActive && sourceExecutionId
      && matchingActive.source_command_execution_id === sourceExecutionId;
    if (matchingActive && sameOrigin && sourceExecutionId
      && matchingActive.source_command_execution_id
      && !sameSource) {
      throw statusError('An active background generation is already linked to a different launch command', 409);
    }
    if (matchingActive && (sameOrigin || sameSource || (!originAttemptId && !sourceExecutionId))) {
      if (artifactsSupplied) assertMatchingExternalArtifacts(matchingActive, artifactDeclarations);
      if (sourceExecutionId && !matchingActive.source_command_execution_id) {
        const sourceStartedAt = String(sourceExecution?.started_at || '');
        const currentStartedAtMs = Date.parse(matchingActive.started_at);
        const sourceStartedAtMs = Date.parse(sourceStartedAt);
        const refinedStartedAt = Number.isFinite(sourceStartedAtMs)
          && (!Number.isFinite(currentStartedAtMs) || sourceStartedAtMs > currentStartedAtMs)
          ? sourceStartedAt
          : matchingActive.started_at;
        db.prepare(`
          UPDATE external_attempts
          SET source_command_execution_id=?, started_at=?, updated_at=? WHERE id=?
        `).run(sourceExecutionId, refinedStartedAt, nowIso(), matchingActive.id);
        matchingActive.source_command_execution_id = sourceExecutionId;
        matchingActive.started_at = refinedStartedAt;
      }
      registered = enrichExternalFollowUp(db, matchingActive, data.followUpPrompt);
      return;
    }
    const activeStepRunAttempt = stepRun ? db.prepare(`
      SELECT id FROM external_attempts WHERE step_run_id=? AND status='running' LIMIT 1
    `).get(stepRun.id) : null;
    if (activeStepRunAttempt) {
      throw statusError('This Run already has an active background generation', 409);
    }
    const matchingActiveChain = db.prepare(`
      SELECT * FROM external_attempts
      WHERE task_id=? AND chain_key=? AND status='running'
      ORDER BY generation DESC LIMIT 1
    `).get(taskId, chainKey);
    assertMatchingStepRun(matchingActiveChain);
    if (matchingActive || matchingActiveChain) {
      throw statusError('An active background generation already owns this evidence path or chain', 409);
    }
    const generation = Number(db.prepare(`
      SELECT COALESCE(MAX(generation), 0) + 1 AS value
      FROM external_attempts WHERE task_id=? AND chain_key=?
    `).get(taskId, chainKey).value);
    const now = nowIso();
    const processIdentity = pid ? inspectProcess(pid) : null;
    const trackedProcessIdentity = processIdentity
      && processIdentity.processGroupId === pid
      && processIdentity.sessionId === pid
      ? processIdentity
      : null;
    let suppliedStartedAt = '';
    if (data.startedAt != null && String(data.startedAt).trim()) {
      const parsedStartedAt = Date.parse(String(data.startedAt));
      if (!Number.isFinite(parsedStartedAt)) throw statusError('startedAt must be a valid timestamp', 400);
      suppliedStartedAt = new Date(parsedStartedAt).toISOString();
    }
    const startedAt = String(sourceExecution?.started_at || originAttempt?.started_at || suppliedStartedAt || now);
    const id = eventId('external');
    const attempt = {
      id,
      sessionId: taskId,
      originTurnId,
      originAttemptId,
      chainKey,
      generation,
      label,
      pid,
      pidStartTicks: trackedProcessIdentity?.startTicks || '',
      processGroupId: trackedProcessIdentity?.processGroupId ?? null,
      logPath,
      donePath,
      statePath,
      metaPath,
      artifactDeclarations,
      checkIntervalSeconds: boundedExternalCheckSeconds(data.checkIntervalSeconds),
      followUpPrompt: String(data.followUpPrompt || '').slice(0, 16000),
    };
    db.prepare(`
      UPDATE scheduled_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL,
        last_error='Replaced by a newer background generation', finished_at=?, updated_at=?
      WHERE task_id=? AND external_attempt_id IN (
        SELECT id FROM external_attempts WHERE task_id=? AND chain_key=? AND generation<?
      ) AND status IN ('pending','leased')
    `).run(now, now, taskId, taskId, chainKey, generation);
    db.prepare(`
      INSERT INTO external_attempts(
        id, task_id, step_run_id, origin_turn_id, origin_attempt_id, source_command_execution_id,
        chain_key, generation, label, status, pid, pid_start_ticks, process_group_id,
        log_path, done_path, state_path,
        meta_path, artifact_declarations_json, check_interval_seconds, follow_up_prompt,
        started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, taskId, stepRun?.id || null,
      originTurnId || null, originAttemptId || null, sourceExecutionId || null,
      chainKey, generation, label, attempt.pid, attempt.pidStartTicks, attempt.processGroupId,
      logPath, attempt.donePath, attempt.statePath,
      attempt.metaPath, JSON.stringify(attempt.artifactDeclarations),
      attempt.checkIntervalSeconds, attempt.followUpPrompt,
      startedAt, now, now,
    );
    refreshStepRunStatus(db, stepRun?.id);
    registered = rowToExternalAttempt(db.prepare('SELECT * FROM external_attempts WHERE id=?').get(id));
    const dueAt = data.dueAt || new Date(Date.now()
      + (boundedExternalCheckSeconds(data.checkAfterSeconds, attempt.checkIntervalSeconds) * 1000)).toISOString();
    insertScheduledJob(db, registered, dueAt);
    insertSessionWorklog(db, taskId, {
      turnId: originTurnId || null,
      kind: 'external.attempt.registered',
      message: `Registered background execution ${label}`,
      payload: {
        externalAttemptId: id, stepRunId: stepRun?.id || '', generation, pid: attempt.pid, logPath,
        donePath: attempt.donePath, statePath: attempt.statePath, metaPath: attempt.metaPath,
        artifactDeclarations: attempt.artifactDeclarations,
        checkIntervalSeconds: attempt.checkIntervalSeconds,
      },
      actor: context.actor || 'codex-runtime', requestId: context.requestId || '',
    });
  }).immediate();
  if (registered?.pidStartTicks && registered?.processGroupId === registered?.pid) {
    const cgroup = placeExternalAttemptInTaskCgroup({
      taskId,
      identity: { pid: registered.pid, startTicks: registered.pidStartTicks, processGroupId: registered.processGroupId },
    });
    if (cgroup.attached) {
      db.prepare(`
        UPDATE external_attempts SET cgroup_path=?, cgroup_inode=?, updated_at=?
        WHERE id=? AND status='running'
      `).run(cgroup.path, cgroup.inode, nowIso(), registered.id);
      registered = rowToExternalAttempt(db.prepare('SELECT * FROM external_attempts WHERE id=?').get(registered.id));
    }
  }
  if (registered?.stepRunId) {
    const run = db.prepare(`
      SELECT run.*, step.step_key, step.label AS step_label
      FROM step_runs run JOIN task_steps step ON step.id=run.step_id
      WHERE run.id=?
    `).get(registered.stepRunId);
    if (run) {
      registered = {
        ...registered,
        stepId: run.step_id,
        stepKey: run.step_key,
        stepLabel: run.step_label,
        runKey: run.run_key,
        runKind: run.run_kind,
        runNumber: Number(run.run_number),
      };
    }
  }
  return registered;
}

function detachedLaunchFields(value) {
  const fields = {};
  const pattern = /^\s*(PID|LOG|DONE|CMD|PIDFILE|STATE|META)\s*[:=]\s*(.+?)\s*$/gim;
  let match;
  while ((match = pattern.exec(String(value || '')))) {
    fields[match[1].toLowerCase()] = match[2].trim().replace(/^(["'`])(.*)\1$/, '$2');
  }
  return fields;
}

function concreteDetachedLaunchFields(value, workingDirectory) {
  const fields = detachedLaunchFields(value);
  const pid = Number(fields.pid);
  if (!Number.isSafeInteger(pid) || pid < 2 || !fields.log) return null;
  if (['log', 'done', 'state', 'meta'].some((key) => /[<>]/.test(String(fields[key] || '')))) return null;
  try {
    const logPath = normalizeTrackedPath(fields.log, 'logPath', workingDirectory);
    const stat = fs.lstatSync(logPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { ...fields, pid, logPath };
  } catch {
    return null;
  }
}

function repairPlaceholderExternalAttemptDetections(dbOverride = null) {
  const db = dbOverride || ensureStorage();
  const candidates = db.prepare(`
    SELECT e.*, c.output AS source_output
    FROM external_attempts e
    JOIN command_executions c ON c.id=e.source_command_execution_id
    WHERE e.source_command_execution_id IS NOT NULL
      AND e.archived_log_sha256='' AND e.archived_log_bytes IS NULL AND e.archived_at=''
  `).all().filter((row) => {
    const fields = detachedLaunchFields(row.source_output);
    const placeholdersMatch = fields.log?.toUpperCase() === '<LOG>'
      && fields.done?.toUpperCase() === '<DONE>'
      && fields.state?.toUpperCase() === '<STATE>'
      && fields.meta?.toUpperCase() === '<META>';
    const storedPathsMatch = path.basename(row.log_path).toUpperCase() === '<LOG>'
      && path.basename(row.done_path).toUpperCase() === '<DONE>'
      && path.basename(row.state_path).toUpperCase() === '<STATE>'
      && path.basename(row.meta_path).toUpperCase() === '<META>';
    const evidenceMissing = [row.log_path, row.done_path, row.state_path, row.meta_path, row.archived_log_path]
      .every((filePath) => !filePath || !fileExists(filePath));
    return placeholdersMatch && storedPathsMatch && evidenceMissing && Number(fields.pid) === Number(row.pid);
  });
  if (!candidates.length) return 0;

  let removed = 0;
  db.transaction(() => {
    for (const row of candidates) {
      const changed = db.prepare(`
        DELETE FROM external_attempts
        WHERE id=? AND source_command_execution_id=?
          AND archived_log_sha256='' AND archived_log_bytes IS NULL AND archived_at=''
      `).run(row.id, row.source_command_execution_id);
      if (!changed.changes) continue;
      insertSessionWorklog(db, row.task_id, {
        turnId: row.origin_turn_id || null,
        kind: 'external.attempt.false_positive.removed',
        level: 'warn',
        message: `${row.label || row.id}: removed a background task created from documentation placeholders`,
        payload: {
          externalAttemptId: row.id,
          commandExecutionId: row.source_command_execution_id,
          reason: 'placeholder_launch_output',
        },
        actor: 'system',
      });
      removed += 1;
    }
  }).immediate();
  return removed;
}

function detectExternalAttemptsForTurn(taskId, turnId, attemptId) {
  const db = ensureStorage();
  const rows = db.prepare(`
    SELECT * FROM command_executions
    WHERE task_id=? AND turn_id=? AND attempt_id=?
    ORDER BY started_at, id
  `).all(safeId(taskId), String(turnId), String(attemptId));
  const detected = [];
  for (const row of rows) {
    const declaredSkillIds = parseDeclaredSkillIds(row.command);
    if (!declaredSkillIds.includes('run-in-background')) continue;
    const fields = concreteDetachedLaunchFields(
      row.output,
      row.working_directory || row.configured_working_directory,
    );
    if (!fields) continue;
    const stress = /stress|frequency|momo/i.test(`${row.command}\n${row.output}`);
    const interval = stress ? 1800 : DEFAULT_EXTERNAL_CHECK_SECONDS;
    const followUpPrompt = stress && declaredSkillIds.includes('converter-test')
      ? 'This is a converter stress follow-up. Apply converter-test status rules and, when available, use rtsc-stress-report for the interval since the previous check. Save the report outcome in this task worklog.'
      : (declaredSkillIds.includes('converter-test')
        ? 'Apply converter-test result collection rules. On terminal failure, collect the failed cases and use analyze-failures when it is available.'
        : 'Apply the governing background business Skill when collecting this result.');
    const existing = db.prepare(`
      SELECT * FROM external_attempts
      WHERE task_id=? AND log_path=? AND done_path=? AND state_path=? AND meta_path=?
        AND pid IS ? AND step_run_id IS NOT NULL
      ORDER BY generation DESC LIMIT 1
    `).get(
      taskId,
      fields.logPath,
      fields.done,
      fields.state,
      fields.meta,
      fields.pid,
    );
    if (!existing) {
      appendSessionWorklog(taskId, {
        turnId,
        kind: 'external.attempt.registration_missing',
        level: 'error',
        message: 'Detached execution was not explicitly registered with a Step Run',
        payload: { commandExecutionId: row.id, logPath: fields.logPath },
      });
      continue;
    }
    try {
      detected.push(registerExternalAttempt({
        taskId,
        turnId,
        attemptId,
        sourceCommandExecutionId: row.id,
        stepRunId: existing.step_run_id,
        workingDirectory: row.working_directory || row.configured_working_directory,
        pid: fields.pid,
        logPath: fields.logPath,
        donePath: fields.done,
        statePath: fields.state,
        metaPath: fields.meta,
        label: path.basename(String(fields.log)).replace(/\.log$/i, ''),
        checkAfterSeconds: interval,
        checkIntervalSeconds: interval,
        followUpPrompt,
      }));
    } catch (error) {
      appendSessionWorklog(taskId, {
        turnId,
        kind: 'external.attempt.detection_failed',
        level: 'warn',
        message: `Could not register detached execution output: ${error.message}`,
        payload: { commandExecutionId: row.id },
      });
    }
  }
  return detected;
}

function readSmallTrackedArtifact(filePath, maxBytes = 65536) {
  if (!filePath || !fileExists(filePath)) return { content: '', mtimeMs: null };
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    return { content: '', mtimeMs: null };
  }
  return { content: fs.readFileSync(filePath, 'utf8'), mtimeMs: stat.mtimeMs };
}

function parseTrackedMeta(content) {
  const text = String(content || '').trim();
  if (!text) return {};
  const json = parseJson(text, null);
  if (json && typeof json === 'object' && !Array.isArray(json)) return json;
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function artifactIsFresh(artifact, startedAtMs) {
  if (!artifact.content) return false;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(artifact.mtimeMs)) return true;
  return artifact.mtimeMs >= startedAtMs - 1000;
}

function processIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 2) return null;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM' ? true : false;
  }
}

function externalAttemptRuntimeActivity(attempt) {
  const cgroup = attempt.cgroupPath && attempt.cgroupInode
    ? inspectVerifiedTaskCgroup({
      taskId: attempt.sessionId,
      cgroupPath: attempt.cgroupPath,
      cgroupInode: attempt.cgroupInode,
    })
    : null;
  const identity = Number.isInteger(Number(attempt.pid))
    && Number(attempt.pid) >= 2
    && /^\d+$/.test(String(attempt.pidStartTicks || ''))
    && Number(attempt.processGroupId) === Number(attempt.pid)
    ? {
      pid: Number(attempt.pid),
      startTicks: String(attempt.pidStartTicks),
      processGroupId: Number(attempt.processGroupId),
    }
    : null;
  const processGroupActive = identity ? processGroupStillBelongsTo(identity) : false;
  return {
    active: Boolean(cgroup?.active || processGroupActive),
    cgroupVerified: Boolean(cgroup?.verified),
    cgroupProcesses: Number(cgroup?.processes || 0),
    cgroupThreads: Number(cgroup?.threads || 0),
    processGroupActive,
  };
}

function inspectExternalAttempt(attempt) {
  let doneArtifact = { content: '', mtimeMs: null };
  let stateArtifact = { content: '', mtimeMs: null };
  let metaArtifact = { content: '', mtimeMs: null };
  try { doneArtifact = readSmallTrackedArtifact(attempt.donePath, 4096); } catch {}
  try { stateArtifact = readSmallTrackedArtifact(attempt.statePath, 4096); } catch {}
  try { metaArtifact = readSmallTrackedArtifact(attempt.metaPath); } catch {}
  const startedAtMs = Date.parse(attempt.startedAt || attempt.createdAt);
  const staleArtifacts = [];
  const freshDone = artifactIsFresh(doneArtifact, startedAtMs);
  const freshState = artifactIsFresh(stateArtifact, startedAtMs);
  const freshMeta = artifactIsFresh(metaArtifact, startedAtMs);
  if (doneArtifact.content && !freshDone) staleArtifacts.push('done');
  if (stateArtifact.content && !freshState) staleArtifacts.push('state');
  if (metaArtifact.content && !freshMeta) staleArtifacts.push('meta');
  const done = freshDone ? doneArtifact.content.trim() : '';
  const state = freshState ? stateArtifact.content.trim().toLowerCase() : '';
  let meta = {};
  if (freshMeta) meta = parseTrackedMeta(metaArtifact.content);
  const doneCode = done.match(/-?\d+/)?.[0];
  const metaCode = [meta.exit_code, meta.exitCode, meta.returncode].find((value) => Number.isInteger(Number(value)));
  const exitCode = doneCode == null ? (metaCode == null ? null : Number(metaCode)) : Number(doneCode);
  const terminalState = /^(finished|completed|failed|cancelled|stopped|done)$/.test(state)
    || Boolean(meta.finished_at || meta.finishedAt || meta.ended_at || meta.endedAt);
  const alive = processIsAlive(attempt.pid);
  const runtime = externalAttemptRuntimeActivity(attempt);
  const ageMs = Date.now() - new Date(attempt.startedAt || attempt.createdAt).getTime();
  const staleSuffix = staleArtifacts.length ? ` stale_ignored=${staleArtifacts.join(',')}` : '';
  if ((exitCode != null || terminalState) && runtime.active) {
    return {
      status: 'running', terminal: false, exitCode, state, meta, pidAlive: alive,
      runtimeActive: true, runtime,
      terminalEvidencePending: true,
      ignoredStaleArtifacts: staleArtifacts,
      observation: `state=${state || 'unknown'} exit=${exitCode ?? 'unknown'} runtime=running${staleSuffix}`,
    };
  }
  if (exitCode != null || terminalState) {
    const status = exitCode === 0 ? 'succeeded' : 'failed';
    return {
      status, terminal: true, exitCode, state, meta, pidAlive: alive,
      runtimeActive: false, runtime,
      ignoredStaleArtifacts: staleArtifacts,
      observation: `state=${state || 'unknown'} exit=${exitCode ?? 'unknown'}${staleSuffix}`,
    };
  }
  if (runtime.active) {
    return {
      status: 'running', terminal: false, exitCode: null, state, meta, pidAlive: alive,
      runtimeActive: true, runtime,
      ignoredStaleArtifacts: staleArtifacts,
      observation: `state=${state || 'unknown'} runtime=running${staleSuffix}`,
    };
  }
  if (alive === false && ageMs > 60000) {
    return {
      status: 'lost', terminal: true, exitCode: null, state, meta, pidAlive: false,
      runtimeActive: false, runtime,
      ignoredStaleArtifacts: staleArtifacts,
      observation: `state=${state || 'unknown'} pid=not-running${staleSuffix}`,
    };
  }
  return {
    status: 'running', terminal: false, exitCode: null, state, meta, pidAlive: alive,
    runtimeActive: false, runtime,
    ignoredStaleArtifacts: staleArtifacts,
    observation: `state=${state || 'unknown'} pid=${alive === true ? 'running' : 'unverified'}${staleSuffix}`,
  };
}

function terminalReportObservedAt(observation) {
  const candidate = observation.meta?.ended_at || observation.meta?.endedAt
    || observation.meta?.finished_at || observation.meta?.finishedAt || nowIso();
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : nowIso();
}

function terminalReconciliationSourceReport(db, attempt) {
  if (!attempt.stepRunId) return null;
  const rows = db.prepare(`
    SELECT * FROM skill_reports WHERE task_id=? AND step_run_id=?
    ORDER BY published_at DESC, sequence DESC
  `).all(attempt.sessionId, attempt.stepRunId);
  return rows.find((row) => {
    const payload = parseJson(row.payload_json, {});
    return payload.executionEvidence?.externalAttemptId === attempt.id;
  }) || null;
}

function publishTerminalReconciliationReport(attempt, observation) {
  const db = ensureStorage();
  const source = terminalReconciliationSourceReport(db, attempt);
  if (!source) return null;
  const payload = parseJson(source.payload_json, {});
  if (!['pending', 'running'].includes(payload.status)) return null;
  const observedAt = terminalReportObservedAt(observation);
  const status = observation.status === 'succeeded' ? 'succeeded' : 'failed';
  const exitCode = observation.exitCode == null ? null : Number(observation.exitCode);
  const summary = exitCode == null
    ? `Background execution reached ${status}; detailed business result collection is pending.`
    : `Background execution reached ${status} with exit code ${exitCode}; detailed business result collection is pending.`;
  const reconciliationSection = {
    id: 'platform-reconciliation',
    title: 'Platform reconciliation',
    kind: 'fields',
    priority: 'primary',
    sensitivity: 'normal',
    defaultExpanded: true,
    fields: [
      { label: 'Execution', value: status, format: 'status', tone: status === 'succeeded' ? 'success' : 'danger' },
      { label: 'Exit code', value: exitCode ?? 'unknown', format: 'code', tone: status === 'succeeded' ? 'success' : 'danger' },
      { label: 'Source', value: 'DONE/STATE/META terminal reconciliation', format: 'text', tone: 'neutral' },
    ],
  };
  try {
    const report = publishSkillReport(attempt.sessionId, {
      ...payload,
      status,
      summary,
      observedAt,
      primaryExecution: payload.primaryExecution ? {
        ...payload.primaryExecution,
        status,
        exitCode,
        finishedAt: observedAt,
      } : null,
      artifacts: payload.artifacts || [],
      sections: [
        reconciliationSection,
        ...(payload.sections || []).filter((section) => section.id !== reconciliationSection.id),
      ].slice(0, 16),
    }, { turnId: source.turn_id || '', attemptId: source.attempt_id || '' });
    appendSessionWorklog(attempt.sessionId, {
      turnId: source.turn_id || null,
      kind: 'skill.report.terminal_reconciled',
      level: status === 'succeeded' ? 'info' : 'warn',
      message: `Published terminal reconciliation report for ${attempt.label || attempt.id}`,
      actor: 'platform',
      payload: {
        reportId: report.id,
        reportKey: report.reportKey,
        externalAttemptId: attempt.id,
        status,
        exitCode,
      },
    });
    return report;
  } catch (error) {
    appendSessionWorklog(attempt.sessionId, {
      turnId: source.turn_id || null,
      kind: 'skill.report.terminal_reconciliation_failed',
      level: 'warn',
      message: `Could not publish terminal reconciliation report: ${String(error.message || error)}`,
      actor: 'platform',
      payload: { externalAttemptId: attempt.id },
    });
    return null;
  }
}

function reconcileExternalAttempts(taskId, options = {}) {
  const db = ensureStorage();
  const attempts = listExternalAttempts(taskId, { status: 'running', limit: MAX_QUERY_LIMIT });
  const preserveTerminalSchedule = Boolean(options.preserveTerminalSchedule);
  const results = [];
  for (const attempt of attempts) {
    const observation = inspectExternalAttempt(attempt);
    db.transaction(() => {
      const current = db.prepare("SELECT * FROM external_attempts WHERE id=? AND status='running'").get(attempt.id);
      if (!current) return;
      const now = nowIso();
      if (observation.terminal) {
        db.prepare(`
          UPDATE external_attempts SET status=?, last_observation=?, result_json=?,
            last_checked_at=?, finished_at=?, updated_at=? WHERE id=? AND status='running'
        `).run(
          observation.status, observation.observation, JSON.stringify(observation),
          now, now, now, attempt.id,
        );
        refreshStepRunStatus(db, current.step_run_id);
        if (preserveTerminalSchedule) {
          const activeSchedule = db.prepare(`
            SELECT 1 FROM scheduled_jobs
            WHERE external_attempt_id=? AND generation=?
              AND status IN ('pending','leased','dispatched') LIMIT 1
          `).get(attempt.id, attempt.generation);
          if (activeSchedule) {
            db.prepare(`
              UPDATE scheduled_jobs SET due_at=?, last_error='', updated_at=?
              WHERE external_attempt_id=? AND generation=? AND status='pending'
            `).run(now, now, attempt.id, attempt.generation);
          } else {
            insertScheduledJob(db, { ...attempt, ...rowToExternalAttempt(current) }, now);
          }
        } else {
          db.prepare(`
            UPDATE scheduled_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL,
              last_error='Background execution reached a terminal state', finished_at=?, updated_at=?
            WHERE external_attempt_id=? AND generation=? AND status IN ('pending','leased')
          `).run(now, now, attempt.id, attempt.generation);
        }
        insertSessionWorklog(db, attempt.sessionId, {
          kind: `external.attempt.${observation.status}`,
          level: observation.status === 'succeeded' ? 'info' : 'warn',
          message: `${attempt.label || attempt.id}: ${observation.observation}`,
          payload: { externalAttemptId: attempt.id, generation: attempt.generation, ...observation },
        });
      } else {
        db.prepare(`
          UPDATE external_attempts SET last_observation=?, result_json=?,
            last_checked_at=?, updated_at=? WHERE id=? AND status='running'
        `).run(observation.observation, JSON.stringify(observation), now, now, attempt.id);
        const hasNext = db.prepare(`
          SELECT 1 FROM scheduled_jobs
          WHERE external_attempt_id=? AND generation=? AND status IN ('pending','leased') LIMIT 1
        `).get(attempt.id, attempt.generation);
        if (!hasNext) insertScheduledJob(db, { ...attempt, ...rowToExternalAttempt(current) });
        insertSessionWorklog(db, attempt.sessionId, {
          kind: 'external.attempt.observed',
          message: `${attempt.label || attempt.id}: ${observation.observation}`,
          payload: { externalAttemptId: attempt.id, generation: attempt.generation, ...observation },
        });
      }
    }).immediate();
    results.push({ id: attempt.id, ...observation });
  }
  for (const result of results.filter((entry) => entry.terminal)) {
    const attempt = getExternalAttempt(taskId, result.id);
    if (attempt) publishTerminalReconciliationReport(attempt, result);
  }
  return results;
}

function reconcileRunningExternalAttempts() {
  const db = ensureStorage();
  const terminalTaskIds = new Set();
  const rows = db.prepare(`
    SELECT * FROM external_attempts WHERE status='running' ORDER BY task_id, created_at
  `).all();
  for (const row of rows) {
    if (inspectExternalAttempt(rowToExternalAttempt(row)).terminal) terminalTaskIds.add(row.task_id);
  }
  const results = [];
  for (const taskId of terminalTaskIds) {
    results.push(...reconcileExternalAttempts(taskId, { preserveTerminalSchedule: true }));
  }
  return results;
}

function externalArchiveRetryDelayMs(attemptCount) {
  const exponent = Math.min(18, Math.max(0, Number(attemptCount || 1) - 1));
  return Math.min(EXTERNAL_ARCHIVE_MAX_RETRY_MS, 5000 * (2 ** exponent));
}

function recordExternalArchiveIntegrityFailure(db, row, error, observed = null, actor = 'archive-worker') {
  let recorded = false;
  db.transaction(() => {
    const current = db.prepare(`
      SELECT * FROM external_attempts WHERE id=? AND archive_status='archived'
    `).get(row.id);
    if (!current || current.archived_log_sha256 !== row.archived_log_sha256) return;
    const now = nowIso();
    const message = String(error?.message || error || 'Managed archive integrity check failed').slice(0, 4000);
    db.prepare(`
      UPDATE external_attempts
      SET archive_status='failed', archive_error=?, archive_next_retry_at=?,
        archive_lease_owner='', archive_lease_expires_at='',
        archive_verify_status='failed', archive_verify_error=?,
        archive_verify_lease_owner='', archive_verify_lease_expires_at='', updated_at=?
      WHERE id=? AND archive_status='archived' AND archived_log_sha256=?
    `).run(message, now, message, now, row.id, row.archived_log_sha256);
    insertSessionWorklog(db, row.task_id, {
      turnId: row.origin_turn_id || null,
      kind: 'external.log_archive.integrity_failed',
      level: 'error',
      message: `${row.label || row.id}: preserved background log integrity check failed`,
      payload: {
        externalAttemptId: row.id,
        errorCode: String(error?.code || 'ARCHIVE_INTEGRITY_FAILED'),
        expectedBytes: row.archived_log_bytes == null ? null : Number(row.archived_log_bytes),
        expectedSha256: row.archived_log_sha256,
        observedBytes: observed?.bytes ?? null,
        observedSha256: observed?.sha256 || '',
      },
      actor,
    });
    recorded = true;
  }).immediate();
  return recorded;
}

async function quarantineManagedArchive(taskId, attemptId, destinationPath) {
  const directory = sessionExternalAttemptOutputDir(taskId);
  const quarantineDirectory = path.join(directory, '.quarantine');
  ensureManagedDirectory(quarantineDirectory, {
    label: 'External attempt archive quarantine directory',
  });
  const stat = fs.lstatSync(destinationPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error('Unsafe managed archive cannot be quarantined automatically');
    error.code = 'ARCHIVE_UNSAFE_FILE';
    throw error;
  }
  const stamp = nowIso().replace(/[^0-9]/g, '').slice(0, 17);
  const quarantinePath = path.join(
    quarantineDirectory,
    `${safeId(attemptId)}.${stamp}.${crypto.randomUUID()}.corrupt.log`,
  );
  await fs.promises.rename(destinationPath, quarantinePath);
  await fsyncDirectory(directory);
  await fsyncDirectory(quarantineDirectory);
  return quarantinePath;
}

async function prepareExternalArchiveRepair(row, destinationPath, sourcePath = row.log_path) {
  const expectedSha256 = String(row.archived_log_sha256 || '');
  if (!expectedSha256) return { repaired: false, quarantinedPath: '' };
  let destinationDigest = null;
  try {
    destinationDigest = await digestRegularFile(destinationPath);
    if (destinationDigest.bytes === Number(row.archived_log_bytes)
      && destinationDigest.sha256 === expectedSha256) {
      return { repaired: false, quarantinedPath: '', existingValid: true };
    }
  } catch (error) {
    if (error.code !== 'ARCHIVE_FILE_MISSING') throw error;
  }

  const sourceDigest = await digestRegularFile(sourcePath, {
    label: 'Tracked log',
    missingCode: 'ARCHIVE_SOURCE_MISSING',
  });
  if (sourceDigest.bytes !== Number(row.archived_log_bytes)
    || sourceDigest.sha256 !== expectedSha256) {
    const error = new Error('Tracked log no longer matches the preserved archive record');
    error.code = 'ARCHIVE_REPAIR_SOURCE_MISMATCH';
    throw error;
  }
  const quarantinedPath = destinationDigest
    ? await quarantineManagedArchive(row.task_id, row.id, destinationPath)
    : '';
  return { repaired: true, quarantinedPath, existingValid: false };
}

async function resolveExternalArchiveSource(db, row) {
  if (pathEntryExists(row.log_path) || row.pid == null) {
    return {
      sourcePath: row.log_path,
      sourceExternalAttemptId: '',
      expectedBytes: null,
      expectedSha256: '',
    };
  }

  const sibling = db.prepare(`
    SELECT * FROM external_attempts
    WHERE task_id=? AND id<>? AND pid=?
      AND done_path=? AND state_path=? AND meta_path=?
      AND archive_status='archived' AND archive_verify_status='verified'
    ORDER BY archive_verified_at DESC, archived_at DESC, updated_at DESC, id DESC
    LIMIT 1
  `).get(
    row.task_id, row.id, row.pid,
    row.done_path, row.state_path, row.meta_path,
  );
  if (!sibling) {
    return {
      sourcePath: row.log_path,
      sourceExternalAttemptId: '',
      expectedBytes: null,
      expectedSha256: '',
    };
  }

  const expectedPath = externalAttemptArchiveFile(sibling.task_id, sibling.id);
  if (path.resolve(sibling.archived_log_path) !== path.resolve(expectedPath)) {
    const error = new Error('Verified sibling archive path does not match its task ownership');
    error.code = 'ARCHIVE_SIBLING_PATH_MISMATCH';
    throw error;
  }
  const observed = await digestRegularFile(expectedPath, {
    label: 'Verified sibling archive',
    missingCode: 'ARCHIVE_SIBLING_MISSING',
  });
  if (observed.bytes !== Number(sibling.archived_log_bytes)
    || observed.sha256 !== sibling.archived_log_sha256) {
    const error = new Error('Verified sibling archive size or SHA-256 does not match its record');
    error.code = 'ARCHIVE_SIBLING_DIGEST_MISMATCH';
    throw error;
  }
  return {
    sourcePath: expectedPath,
    sourceExternalAttemptId: sibling.id,
    expectedBytes: observed.bytes,
    expectedSha256: observed.sha256,
  };
}

function claimExternalAttemptArchives(workerId, limit = 1, options = {}) {
  const normalizedWorkerId = String(workerId || '').trim();
  if (!normalizedWorkerId) throw statusError('Archive worker id is required', 400);
  const taskId = options.taskId ? safeId(options.taskId) : '';
  const db = ensureStorage();
  return db.transaction(() => {
    if (platformMaintenanceFromDatabase(db)) return [];
    const now = nowIso();
    const rows = db.prepare(`
      SELECT * FROM external_attempts
      WHERE status IN ('succeeded','failed','lost','cancelled')
        AND (?='' OR task_id=?)
        AND (
          (archive_status IN ('pending','failed')
            AND (archive_next_retry_at='' OR archive_next_retry_at<=?))
          OR (archive_status='failed' AND archive_error='Tracked log does not exist'
            AND pid IS NOT NULL AND EXISTS (
              SELECT 1 FROM external_attempts AS sibling
              WHERE sibling.task_id=external_attempts.task_id
                AND sibling.id<>external_attempts.id AND sibling.pid=external_attempts.pid
                AND sibling.done_path=external_attempts.done_path
                AND sibling.state_path=external_attempts.state_path
                AND sibling.meta_path=external_attempts.meta_path
                AND sibling.archive_status='archived'
                AND sibling.archive_verify_status='verified'
            ))
          OR (archive_status='archiving'
            AND (archive_lease_expires_at='' OR archive_lease_expires_at<=?))
        )
      ORDER BY
        CASE archive_status WHEN 'pending' THEN 0 WHEN 'archiving' THEN 1 ELSE 2 END,
        COALESCE(NULLIF(finished_at, ''), updated_at), id
      LIMIT ?
    `).all(taskId, taskId, now, now, Math.min(EXTERNAL_ARCHIVE_MAX_CLAIM, boundedLimit(limit, 1)));
    const leaseExpiresAt = new Date(Date.now() + EXTERNAL_ARCHIVE_LEASE_MS).toISOString();
    const claimed = [];
    for (const row of rows) {
      const archivedLogPath = externalAttemptArchiveFile(row.task_id, row.id);
      const changed = db.prepare(`
        UPDATE external_attempts
        SET archive_status='archiving', archived_log_path=?, archive_error='',
          archive_attempt_count=archive_attempt_count+1, archive_lease_owner=?,
          archive_lease_expires_at=?, updated_at=?
        WHERE id=? AND status IN ('succeeded','failed','lost','cancelled')
          AND (
            (archive_status IN ('pending','failed')
              AND (archive_next_retry_at='' OR archive_next_retry_at<=?))
            OR (archive_status='failed' AND archive_error='Tracked log does not exist'
              AND pid IS NOT NULL AND EXISTS (
                SELECT 1 FROM external_attempts AS sibling
                WHERE sibling.task_id=external_attempts.task_id
                  AND sibling.id<>external_attempts.id AND sibling.pid=external_attempts.pid
                  AND sibling.done_path=external_attempts.done_path
                  AND sibling.state_path=external_attempts.state_path
                  AND sibling.meta_path=external_attempts.meta_path
                  AND sibling.archive_status='archived'
                  AND sibling.archive_verify_status='verified'
              ))
            OR (archive_status='archiving'
              AND (archive_lease_expires_at='' OR archive_lease_expires_at<=?))
          )
      `).run(archivedLogPath, normalizedWorkerId, leaseExpiresAt, now, row.id, now, now);
      if (changed.changes) {
        claimed.push(rowToExternalAttempt(db.prepare('SELECT * FROM external_attempts WHERE id=?').get(row.id)));
      }
    }
    return claimed;
  }).immediate();
}

function renewExternalArchiveLease(attemptId, workerId) {
  const changed = ensureStorage().prepare(`
    UPDATE external_attempts SET archive_lease_expires_at=?, updated_at=?
    WHERE id=? AND archive_status='archiving' AND archive_lease_owner=?
  `).run(
    new Date(Date.now() + EXTERNAL_ARCHIVE_LEASE_MS).toISOString(),
    nowIso(), String(attemptId), String(workerId),
  );
  if (changed.changes !== 1) {
    const error = new Error('External attempt archive lease was lost');
    error.code = 'ARCHIVE_LEASE_LOST';
    throw error;
  }
}

function prepareExternalAttemptArchiveStorage(taskId, attemptId) {
  ensureSessionStorage(taskId);
  const directory = sessionExternalAttemptOutputDir(taskId);
  ensureManagedDirectory(directory, {
    label: 'External attempt output directory',
  });
  const prefix = `.${path.basename(externalAttemptArchiveFile(taskId, attemptId))}.`;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.tmp')) continue;
    const temporaryPath = path.join(directory, entry.name);
    const stat = fs.lstatSync(temporaryPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      const error = new Error('Unsafe stale external archive temporary file');
      error.code = 'ARCHIVE_UNSAFE_FILE';
      throw error;
    }
    fs.unlinkSync(temporaryPath);
  }
  return externalAttemptArchiveFile(taskId, attemptId);
}

async function processExternalAttemptArchive(attemptId, workerId, options = {}) {
  const db = ensureStorage();
  const normalizedAttemptId = String(attemptId || '');
  const normalizedWorkerId = String(workerId || '');
  const row = db.prepare(`
    SELECT * FROM external_attempts
    WHERE id=? AND archive_status='archiving' AND archive_lease_owner=?
  `).get(normalizedAttemptId, normalizedWorkerId);
  if (!row) return { ok: false, lostLease: true, attemptId: normalizedAttemptId };

  let destinationPath = externalAttemptArchiveFile(row.task_id, row.id);
  try {
    destinationPath = prepareExternalAttemptArchiveStorage(row.task_id, row.id);
    const archiveSource = await resolveExternalArchiveSource(db, row);
    const repair = await prepareExternalArchiveRepair(row, destinationPath, archiveSource.sourcePath);
    const archived = await archiveFileAtomically({
      sourcePath: archiveSource.sourcePath,
      destinationPath,
      faultInjector: options.faultInjector,
      onProgress: () => renewExternalArchiveLease(row.id, normalizedWorkerId),
    });
    if (archiveSource.sourceExternalAttemptId
      && (archived.bytes !== archiveSource.expectedBytes
        || archived.sha256 !== archiveSource.expectedSha256)) {
      await quarantineManagedArchive(row.task_id, row.id, destinationPath);
      const error = new Error('Copied sibling archive no longer matches its verified record');
      error.code = 'ARCHIVE_SIBLING_CHANGED';
      throw error;
    }
    let recorded = false;
    db.transaction(() => {
      const now = nowIso();
      const verifyNextAt = new Date(Date.now() + EXTERNAL_ARCHIVE_VERIFY_INTERVAL_MS).toISOString();
      const changed = db.prepare(`
        UPDATE external_attempts
        SET archive_status='archived', archived_log_path=?, archived_log_bytes=?,
          archived_log_sha256=?, archived_at=?, archive_error='', archive_next_retry_at='',
          archive_lease_owner='', archive_lease_expires_at='',
          archive_verify_status='verified', archive_verify_error='',
          archive_verified_at=?, archive_verify_next_at=?,
          archive_verify_lease_owner='', archive_verify_lease_expires_at='', updated_at=?
        WHERE id=? AND archive_status='archiving' AND archive_lease_owner=?
      `).run(
        destinationPath, archived.bytes, archived.sha256, now, now, verifyNextAt, now,
        row.id, normalizedWorkerId,
      );
      if (!changed.changes) return;
      const completeEvidence = ['succeeded', 'failed'].includes(row.status);
      insertSessionWorklog(db, row.task_id, {
        turnId: row.origin_turn_id || null,
        kind: repair.repaired ? 'external.log_archive.repaired' : 'external.log_archive.completed',
        message: repair.repaired
          ? `${row.label || row.id}: repaired the preserved background log from matching source evidence`
          : `${row.label || row.id}: preserved the ${completeEvidence ? 'complete' : 'terminal snapshot of the'} background log`,
        payload: {
          externalAttemptId: row.id,
          archivedLogPath: destinationPath,
          bytes: archived.bytes,
          sha256: archived.sha256,
          recoveredExisting: archived.recoveredExisting,
          evidenceKind: completeEvidence ? 'complete' : 'terminal_snapshot',
          repaired: repair.repaired,
          quarantinedPath: repair.quarantinedPath,
          sourceExternalAttemptId: archiveSource.sourceExternalAttemptId || null,
        },
        actor: 'archive-worker',
      });
      recorded = true;
    }).immediate();
    return {
      ok: recorded,
      lostLease: !recorded,
      attemptId: row.id,
      path: destinationPath,
      repaired: repair.repaired,
      quarantinedPath: repair.quarantinedPath,
      sourceExternalAttemptId: archiveSource.sourceExternalAttemptId || '',
      ...archived,
    };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 4000);
    let recorded = false;
    db.transaction(() => {
      const current = db.prepare(`
        SELECT * FROM external_attempts
        WHERE id=? AND archive_status='archiving' AND archive_lease_owner=?
      `).get(row.id, normalizedWorkerId);
      if (!current) return;
      const now = nowIso();
      const nextRetryAt = new Date(Date.now()
        + externalArchiveRetryDelayMs(current.archive_attempt_count)).toISOString();
      db.prepare(`
        UPDATE external_attempts
        SET archive_status='failed', archive_error=?, archive_next_retry_at=?,
          archive_lease_owner='', archive_lease_expires_at='', updated_at=?
        WHERE id=? AND archive_status='archiving' AND archive_lease_owner=?
      `).run(message, nextRetryAt, now, row.id, normalizedWorkerId);
      insertSessionWorklog(db, row.task_id, {
        turnId: row.origin_turn_id || null,
        kind: 'external.log_archive.failed',
        level: 'warn',
        message: `${row.label || row.id}: background log preservation failed: ${message}`,
        payload: {
          externalAttemptId: row.id,
          errorCode: String(error?.code || 'ARCHIVE_FAILED'),
          archiveAttemptCount: Number(current.archive_attempt_count || 0),
          nextRetryAt,
        },
        actor: 'archive-worker',
      });
      recorded = true;
    }).immediate();
    return {
      ok: false,
      lostLease: !recorded,
      attemptId: row.id,
      error: message,
      errorCode: String(error?.code || 'ARCHIVE_FAILED'),
    };
  }
}

function claimExternalArchiveVerifications(workerId, limit = 1, options = {}) {
  const normalizedWorkerId = String(workerId || '').trim();
  if (!normalizedWorkerId) throw statusError('Archive verification worker id is required', 400);
  const taskId = options.taskId ? safeId(options.taskId) : '';
  const db = ensureStorage();
  return db.transaction(() => {
    if (platformMaintenanceFromDatabase(db)) return [];
    const now = nowIso();
    const rows = db.prepare(`
      SELECT * FROM external_attempts
      WHERE archive_status='archived' AND (?='' OR task_id=?)
        AND (
          (archive_verify_status IN ('pending','verified','failed')
            AND (archive_verify_next_at='' OR archive_verify_next_at<=?))
          OR (archive_verify_status='verifying'
            AND (archive_verify_lease_expires_at='' OR archive_verify_lease_expires_at<=?))
        )
      ORDER BY COALESCE(NULLIF(archive_verify_next_at, ''), NULLIF(archive_verified_at, ''), archived_at), id
      LIMIT ?
    `).all(taskId, taskId, now, now, Math.min(EXTERNAL_ARCHIVE_MAX_CLAIM, boundedLimit(limit, 1)));
    const leaseExpiresAt = new Date(Date.now() + EXTERNAL_ARCHIVE_VERIFY_LEASE_MS).toISOString();
    const claimed = [];
    for (const row of rows) {
      const changed = db.prepare(`
        UPDATE external_attempts
        SET archive_verify_status='verifying', archive_verify_error='',
          archive_verify_count=archive_verify_count+1, archive_verify_lease_owner=?,
          archive_verify_lease_expires_at=?, updated_at=?
        WHERE id=? AND archive_status='archived'
          AND (
            (archive_verify_status IN ('pending','verified','failed')
              AND (archive_verify_next_at='' OR archive_verify_next_at<=?))
            OR (archive_verify_status='verifying'
              AND (archive_verify_lease_expires_at='' OR archive_verify_lease_expires_at<=?))
          )
      `).run(normalizedWorkerId, leaseExpiresAt, now, row.id, now, now);
      if (changed.changes) {
        claimed.push(rowToExternalAttempt(db.prepare('SELECT * FROM external_attempts WHERE id=?').get(row.id)));
      }
    }
    return claimed;
  }).immediate();
}

function renewExternalArchiveVerificationLease(attemptId, workerId) {
  const changed = ensureStorage().prepare(`
    UPDATE external_attempts SET archive_verify_lease_expires_at=?, updated_at=?
    WHERE id=? AND archive_status='archived'
      AND archive_verify_status='verifying' AND archive_verify_lease_owner=?
  `).run(
    new Date(Date.now() + EXTERNAL_ARCHIVE_VERIFY_LEASE_MS).toISOString(),
    nowIso(), String(attemptId), String(workerId),
  );
  if (changed.changes !== 1) {
    const error = new Error('External archive verification lease was lost');
    error.code = 'ARCHIVE_VERIFY_LEASE_LOST';
    throw error;
  }
}

async function processExternalArchiveVerification(attemptId, workerId, options = {}) {
  const db = ensureStorage();
  const normalizedAttemptId = String(attemptId || '');
  const normalizedWorkerId = String(workerId || '');
  const row = db.prepare(`
    SELECT * FROM external_attempts
    WHERE id=? AND archive_status='archived'
      AND archive_verify_status='verifying' AND archive_verify_lease_owner=?
  `).get(normalizedAttemptId, normalizedWorkerId);
  if (!row) return { ok: false, lostLease: true, attemptId: normalizedAttemptId };
  let observed = null;
  try {
    const expectedPath = externalAttemptArchiveFile(row.task_id, row.id);
    if (path.resolve(row.archived_log_path) !== path.resolve(expectedPath)) {
      const error = new Error('Managed archive path does not match its task ownership');
      error.code = 'ARCHIVE_PATH_MISMATCH';
      throw error;
    }
    observed = await digestRegularFile(expectedPath);
    await options.faultInjector?.('after_digest');
    renewExternalArchiveVerificationLease(row.id, normalizedWorkerId);
    if (observed.bytes !== Number(row.archived_log_bytes)
      || observed.sha256 !== row.archived_log_sha256) {
      const error = new Error('Managed archive size or SHA-256 does not match its record');
      error.code = 'ARCHIVE_DIGEST_MISMATCH';
      throw error;
    }
    let recorded = false;
    db.transaction(() => {
      const current = db.prepare(`
        SELECT * FROM external_attempts
        WHERE id=? AND archive_status='archived'
          AND archive_verify_status='verifying' AND archive_verify_lease_owner=?
      `).get(row.id, normalizedWorkerId);
      if (!current) return;
      const now = nowIso();
      const nextAt = new Date(Date.now() + EXTERNAL_ARCHIVE_VERIFY_INTERVAL_MS).toISOString();
      db.prepare(`
        UPDATE external_attempts
        SET archive_verify_status='verified', archive_verify_error='', archive_verified_at=?,
          archive_verify_next_at=?, archive_verify_lease_owner='',
          archive_verify_lease_expires_at='', updated_at=?
        WHERE id=? AND archive_status='archived'
          AND archive_verify_status='verifying' AND archive_verify_lease_owner=?
      `).run(now, nextAt, now, row.id, normalizedWorkerId);
      if (Number(current.archive_verify_count || 0) === 1) {
        insertSessionWorklog(db, row.task_id, {
          turnId: row.origin_turn_id || null,
          kind: 'external.log_archive.verified',
          message: `${row.label || row.id}: verified the preserved background log`,
          payload: {
            externalAttemptId: row.id,
            bytes: observed.bytes,
            sha256: observed.sha256,
            nextVerificationAt: nextAt,
          },
          actor: 'archive-worker',
        });
      }
      recorded = true;
    }).immediate();
    return { ok: recorded, lostLease: !recorded, attemptId: row.id, ...observed };
  } catch (error) {
    if (error?.code === 'ARCHIVE_VERIFY_LEASE_LOST') {
      return {
        ok: false,
        lostLease: true,
        attemptId: row.id,
        error: String(error.message || error),
        errorCode: error.code,
      };
    }
    const recorded = recordExternalArchiveIntegrityFailure(db, row, error, observed, 'archive-worker');
    return {
      ok: false,
      lostLease: !recorded,
      attemptId: row.id,
      error: String(error?.message || error),
      errorCode: String(error?.code || 'ARCHIVE_INTEGRITY_FAILED'),
    };
  }
}

function externalArchiveIntegrityStatus() {
  const db = ensureStorage();
  const terminal = "status IN ('succeeded','failed','lost','cancelled')";
  const count = (condition) => Number(db.prepare(`
    SELECT COUNT(*) AS count FROM external_attempts WHERE ${terminal} AND ${condition}
  `).get().count);
  const latestFailure = db.prepare(`
    SELECT task_id, id, archive_error, archive_verify_error, updated_at
    FROM external_attempts
    WHERE ${terminal} AND (archive_status='failed' OR archive_verify_status='failed')
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).get();
  const lastVerified = db.prepare(`
    SELECT MAX(archive_verified_at) AS value FROM external_attempts
    WHERE archive_status='archived' AND archive_verify_status='verified'
  `).get().value || '';
  const status = {
    total: count('1=1'),
    archived: count("archive_status='archived'"),
    pending: count("archive_status='pending'"),
    archiving: count("archive_status='archiving'"),
    failed: count("archive_status='failed'"),
    verifying: count("archive_verify_status='verifying'"),
    verificationFailed: count("archive_verify_status='failed'"),
    failures: count("archive_status='failed' OR archive_verify_status='failed'"),
    lastVerifiedAt: lastVerified,
    latestFailure: latestFailure ? {
      sessionId: latestFailure.task_id,
      attemptId: latestFailure.id,
      error: latestFailure.archive_verify_error || latestFailure.archive_error || '',
      updatedAt: latestFailure.updated_at,
    } : null,
  };
  return { ...status, ok: status.failures === 0 };
}

function trackingCounts(db, taskId) {
  return {
    external: Number(db.prepare("SELECT COUNT(*) AS count FROM external_attempts WHERE task_id=? AND status='running'").get(taskId).count),
    scheduled: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM scheduled_jobs
      WHERE task_id=? AND status IN ('pending','leased','dispatched')
    `).get(taskId).count),
  };
}

function rowToCommandExecution(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.task_id,
    turnId: row.turn_id,
    attemptId: row.attempt_id,
    runtimeItemId: row.runtime_item_id,
    turnSequence: Number(row.turn_sequence || 0),
    turnInput: row.turn_input || '',
    command: row.command,
    workingDirectory: row.working_directory,
    configuredWorkingDirectory: row.configured_working_directory,
    workingDirectoryReported: Boolean(row.working_directory),
    output: row.output,
    attemptNo: Number(row.attempt_no || 0),
    exitCode: row.exit_code,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    rawEvent: parseJson(row.raw_event_json, {}),
  };
}

function parseDeclaredSkillIds(command) {
  let candidate = String(command || '').trim();
  const launcher = candidate.match(/^(?:[^\s"']*\/)?(?:ba)?sh\s+-lc\s+/);
  if (launcher) candidate = candidate.slice(launcher[0].length).trimStart();
  const match = candidate.match(/^["']?(?:[^\s"']*\/)?codex-skill-use\s+((?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}\s+)+)--(?:\s|["']|$)/);
  if (!match) return [];
  return unique(match[1].trim().split(/\s+/));
}

function rowToCommandSkillAttribution(row) {
  return {
    id: row.id,
    sequence: Number(row.sequence),
    sessionId: row.task_id,
    commandExecutionId: row.command_execution_id,
    skillId: row.skill_id,
    version: Number(row.skill_version),
    contentHash: row.skill_content_hash,
    action: row.action,
    source: row.source,
    reason: row.reason,
    actor: row.actor,
    ts: row.ts,
  };
}

function taskSnapshotSkillMap(db, taskId) {
  const rows = db.prepare(`
    SELECT e.* FROM tasks t
    JOIN skill_snapshot_entries e ON e.snapshot_id=t.skill_snapshot_id
    WHERE t.id=? ORDER BY e.skill_id
  `).all(taskId);
  return new Map(rows.map((row) => [row.skill_id, row]));
}

function insertCommandSkillAttribution(db, data) {
  db.prepare(`
    INSERT INTO command_skill_attributions
      (id, task_id, command_execution_id, skill_id, skill_version, skill_content_hash,
       action, source, reason, actor, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId('skill-attribution'), data.taskId, data.commandExecutionId, data.skillId,
    data.version, data.contentHash, data.action, data.source, data.reason || '',
    data.actor, data.ts || nowIso(),
  );
}

function ensureRuntimeSkillAttributions(db, execution) {
  const declaredSkillIds = parseDeclaredSkillIds(execution.command);
  if (!declaredSkillIds.length) return;
  const existing = db.prepare(`
    SELECT skill_id, source FROM command_skill_attributions
    WHERE command_execution_id=? ORDER BY sequence
  `).all(execution.id);
  if (existing.some((row) => row.source === 'operator')) return;
  const runtimeSkillIds = new Set(existing.map((row) => row.skill_id));
  const availableSkills = taskSnapshotSkillMap(db, execution.sessionId);
  for (const skillId of declaredSkillIds) {
    if (runtimeSkillIds.has(skillId)) continue;
    const skill = availableSkills.get(skillId);
    if (!skill) continue;
    insertCommandSkillAttribution(db, {
      taskId: execution.sessionId,
      commandExecutionId: execution.id,
      skillId,
      version: Number(skill.version),
      contentHash: skill.content_hash,
      action: 'linked',
      source: 'runtime',
      reason: 'Declared by codex-skill-use',
      actor: 'codex-runtime',
      ts: execution.startedAt || nowIso(),
    });
  }
}

function enrichCommandExecutions(db, executions) {
  if (!executions.length) return [];
  const placeholders = executions.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT * FROM command_skill_attributions
    WHERE command_execution_id IN (${placeholders}) ORDER BY sequence
  `).all(...executions.map((execution) => execution.id));
  const historyByExecution = new Map(executions.map((execution) => [execution.id, []]));
  for (const row of rows) historyByExecution.get(row.command_execution_id)?.push(rowToCommandSkillAttribution(row));
  const availableSkills = taskSnapshotSkillMap(db, executions[0].sessionId);
  return executions.map((execution) => {
    const history = historyByExecution.get(execution.id) || [];
    const effective = new Map();
    for (const attribution of history) effective.set(attribution.skillId, attribution);
    const skills = [...effective.values()]
      .filter((attribution) => attribution.action === 'linked')
      .sort((left, right) => left.skillId.localeCompare(right.skillId));
    const declaredSkillIds = parseDeclaredSkillIds(execution.command);
    return {
      ...execution,
      declaredSkillIds,
      unresolvedSkillIds: declaredSkillIds.filter((skillId) => !availableSkills.has(skillId)),
      skills,
      skillAttributionHistory: [...history].reverse(),
    };
  });
}

function insertCommandExecution(db, data) {
  const event = preserveValue(data.event || {});
  const item = event?.item;
  if (!item || item.type !== 'command_execution') return null;
  const runtimeItemId = String(item.id || data.runtimeItemId || eventId('runtime-item'));
  const existing = db.prepare(`
    SELECT * FROM command_executions
    WHERE task_id=? AND turn_id=? AND attempt_id=? AND runtime_item_id=?
  `).get(safeId(data.taskId), String(data.turnId), String(data.attemptId), runtimeItemId);
  const now = String(data.ts || nowIso());
  const command = item.command == null
    ? ''
    : (typeof item.command === 'string' ? item.command : JSON.stringify(item.command));
  const outputValue = item.aggregated_output ?? item.output ?? item.stdout ?? '';
  const output = typeof outputValue === 'string' ? outputValue : JSON.stringify(outputValue);
  const status = String(item.status || (event.type === 'item.completed' ? 'completed' : 'running'));
  const startedAt = String(existing?.started_at || item.started_at || (event.type === 'item.started' ? now : ''));
  const finishedAt = String(item.finished_at || (event.type === 'item.completed' ? now : existing?.finished_at || ''));
  const id = existing?.id || eventId('execution');
  const reportedWorkingDirectory = [item.cwd, item.working_directory, item.workingDirectory]
    .find((value) => typeof value === 'string');
  db.prepare(`
    INSERT INTO command_executions
      (id, task_id, turn_id, attempt_id, runtime_item_id, command, working_directory,
       configured_working_directory, output, exit_code, status, started_at, finished_at, raw_event_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, turn_id, attempt_id, runtime_item_id) DO UPDATE SET
      command=CASE
        WHEN excluded.command<>'' THEN excluded.command
        ELSE command_executions.command
      END,
      working_directory=CASE
        WHEN excluded.working_directory<>'' THEN excluded.working_directory
        ELSE command_executions.working_directory
      END,
      configured_working_directory=CASE
        WHEN excluded.configured_working_directory<>'' THEN excluded.configured_working_directory
        ELSE command_executions.configured_working_directory
      END,
      output=CASE
        WHEN excluded.output<>'' THEN excluded.output
        ELSE command_executions.output
      END,
      exit_code=COALESCE(excluded.exit_code, command_executions.exit_code),
      status=excluded.status, started_at=CASE WHEN command_executions.started_at='' THEN excluded.started_at ELSE command_executions.started_at END,
      finished_at=excluded.finished_at, raw_event_json=excluded.raw_event_json
  `).run(
    id,
    safeId(data.taskId),
    String(data.turnId),
    String(data.attemptId),
    runtimeItemId,
    command || existing?.command || '',
    String(reportedWorkingDirectory || ''),
    String(data.configuredWorkingDirectory || existing?.configured_working_directory || ''),
    output || existing?.output || '',
    item.exit_code ?? existing?.exit_code ?? null,
    status,
    startedAt,
    finishedAt,
    JSON.stringify(event),
  );
  const execution = rowToCommandExecution(db.prepare(`
    SELECT ce.*, t.sequence AS turn_sequence, t.input AS turn_input, a.attempt_no
    FROM command_executions ce
    JOIN turns t ON t.id=ce.turn_id
    JOIN attempts a ON a.id=ce.attempt_id
    WHERE ce.id=?
  `).get(id));
  ensureRuntimeSkillAttributions(db, execution);
  return execution;
}

function recordCommandExecution(data) {
  const db = ensureStorage();
  let execution;
  db.transaction(() => {
    execution = insertCommandExecution(db, data);
  }).immediate();
  return execution;
}

function appendRuntimeWorklog(sessionId, event, runtimeEvent, attemptId, configuredWorkingDirectory = '') {
  const db = ensureStorage();
  const taskId = safeId(sessionId);
  let record;
  db.transaction(() => {
    record = insertSessionWorklog(db, taskId, event);
    if (runtimeEvent?.item?.type === 'command_execution') {
      insertCommandExecution(db, {
        taskId,
        turnId: event.turnId,
        attemptId,
        configuredWorkingDirectory,
        event: runtimeEvent,
        ts: event.ts,
      });
    }
  }).immediate();
  return record;
}

function listCommandExecutions(taskId, options = {}) {
  const clauses = ['task_id = ?'];
  const params = [safeId(taskId)];
  if (options.turnId) {
    clauses.push('turn_id = ?');
    params.push(String(options.turnId));
  }
  if (options.executionId) {
    clauses.push('id = ?');
    params.push(String(options.executionId));
  }
  const db = ensureStorage();
  const rows = db.prepare(`
    SELECT ce.*, t.sequence AS turn_sequence, t.input AS turn_input, a.attempt_no
    FROM command_executions ce
    JOIN turns t ON t.id=ce.turn_id
    JOIN attempts a ON a.id=ce.attempt_id
    WHERE ${clauses.map((clause) => `ce.${clause}`).join(' AND ')}
    ORDER BY COALESCE(NULLIF(ce.finished_at, ''), ce.started_at) DESC, ce.id DESC LIMIT ? OFFSET ?
  `).all(
    ...params,
    boundedLimit(options.limit, 100),
    boundedOffset(options.offset),
  );
  return enrichCommandExecutions(db, rows.map(rowToCommandExecution));
}

function setCommandExecutionSkills(taskId, executionId, skillIds, reason, context = {}) {
  const db = ensureStorage();
  const normalizedTaskId = safeId(taskId);
  if (!Array.isArray(skillIds) || skillIds.length > MAX_SKILL_FILES
    || skillIds.some((skillId) => typeof skillId !== 'string')) {
    throw statusError('skillIds must be an array of Skill IDs', 400);
  }
  const desiredSkillIds = unique(skillIds.map((skillId) => skillId.trim()).filter(Boolean));
  if (desiredSkillIds.some((skillId) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(skillId))) {
    throw statusError('skillIds contains an invalid Skill ID', 400);
  }
  const correctionReason = String(reason || '').trim();
  if (!correctionReason) throw statusError('A correction reason is required', 400);
  if (correctionReason.length > MAX_ATTRIBUTION_REASON_LENGTH) {
    throw statusError(`Correction reason exceeds ${MAX_ATTRIBUTION_REASON_LENGTH} characters`, 400);
  }
  let result;
  db.transaction(() => {
    assertNoPlatformMaintenance(db);
    const executionRow = db.prepare(`
      SELECT ce.*, t.sequence AS turn_sequence, t.input AS turn_input, a.attempt_no
      FROM command_executions ce
      JOIN turns t ON t.id=ce.turn_id
      JOIN attempts a ON a.id=ce.attempt_id
      WHERE ce.task_id=? AND ce.id=?
    `).get(normalizedTaskId, String(executionId));
    if (!executionRow) throw statusError(`Command execution ${executionId} not found`, 404);
    const availableSkills = taskSnapshotSkillMap(db, normalizedTaskId);
    const invalid = desiredSkillIds.filter((skillId) => !availableSkills.has(skillId));
    if (invalid.length) throw statusError(`Skill not present in this task snapshot: ${invalid.join(', ')}`, 400);
    const historyRows = db.prepare(`
      SELECT * FROM command_skill_attributions WHERE command_execution_id=? ORDER BY sequence
    `).all(executionRow.id);
    const effective = new Map();
    for (const row of historyRows) effective.set(row.skill_id, row);
    const currentSkillIds = [...effective.values()]
      .filter((row) => row.action === 'linked')
      .map((row) => row.skill_id)
      .sort();
    const desired = new Set(desiredSkillIds);
    const current = new Set(currentSkillIds);
    const ts = nowIso();
    const actor = String(context.actor || 'operator');
    const changes = [];
    for (const skillId of currentSkillIds.filter((id) => !desired.has(id))) {
      const row = effective.get(skillId);
      insertCommandSkillAttribution(db, {
        taskId: normalizedTaskId, commandExecutionId: executionRow.id, skillId,
        version: Number(row.skill_version), contentHash: row.skill_content_hash,
        action: 'unlinked', source: 'operator', reason: correctionReason, actor, ts,
      });
      changes.push({ skillId, action: 'unlinked' });
    }
    for (const skillId of desiredSkillIds.filter((id) => !current.has(id))) {
      const skill = availableSkills.get(skillId);
      insertCommandSkillAttribution(db, {
        taskId: normalizedTaskId, commandExecutionId: executionRow.id, skillId,
        version: Number(skill.version), contentHash: skill.content_hash,
        action: 'linked', source: 'operator', reason: correctionReason, actor, ts,
      });
      changes.push({ skillId, action: 'linked' });
    }
    if (changes.length) {
      insertSessionWorklog(db, normalizedTaskId, {
        turnId: executionRow.turn_id,
        kind: 'command.skills.corrected',
        message: `Corrected Skill attribution for command ${executionRow.runtime_item_id}`,
        payload: {
          commandExecutionId: executionRow.id,
          before: currentSkillIds,
          after: [...desiredSkillIds].sort(),
          changes,
          reason: correctionReason,
        },
        actor,
        requestId: context.requestId || '',
        ts,
      });
    }
    result = enrichCommandExecutions(db, [rowToCommandExecution(executionRow)])[0];
  }).immediate();
  return result;
}

function getSessionSkillUsage(taskId) {
  const db = ensureStorage();
  const normalizedTaskId = safeId(taskId);
  const task = db.prepare('SELECT skill_snapshot_id FROM tasks WHERE id=?').get(normalizedTaskId);
  if (!task) throw statusError(`Session ${normalizedTaskId} not found`, 404);
  if (!task.skill_snapshot_id) return { snapshot: null, skills: [], attributedCommandCount: 0 };
  const snapshot = db.prepare('SELECT * FROM skill_snapshots WHERE id=?').get(task.skill_snapshot_id);
  const entries = db.prepare(`
    SELECT skill_id, version, origin, name, content_hash
    FROM skill_snapshot_entries WHERE snapshot_id=? ORDER BY skill_id
  `).all(task.skill_snapshot_id);
  const attributions = db.prepare(`
    SELECT * FROM command_skill_attributions WHERE task_id=? ORDER BY sequence
  `).all(normalizedTaskId);
  const effective = new Map();
  const correctionCounts = new Map();
  for (const row of attributions) {
    effective.set(`${row.command_execution_id}\0${row.skill_id}`, row);
    if (row.source === 'operator') correctionCounts.set(row.skill_id, (correctionCounts.get(row.skill_id) || 0) + 1);
  }
  const commandIds = new Set();
  const usage = new Map(entries.map((entry) => [entry.skill_id, { commandIds: new Set(), lastUsedAt: '' }]));
  for (const row of effective.values()) {
    if (row.action !== 'linked') continue;
    commandIds.add(row.command_execution_id);
    const item = usage.get(row.skill_id);
    if (!item) continue;
    item.commandIds.add(row.command_execution_id);
    if (!item.lastUsedAt || row.ts > item.lastUsedAt) item.lastUsedAt = row.ts;
  }
  return {
    snapshot: {
      id: snapshot.id,
      contentHash: snapshot.content_hash,
      createdAt: snapshot.created_at,
    },
    skills: entries.map((entry) => ({
      id: entry.skill_id,
      name: entry.name,
      origin: entry.origin,
      version: Number(entry.version),
      contentHash: entry.content_hash,
      commandCount: usage.get(entry.skill_id).commandIds.size,
      lastUsedAt: usage.get(entry.skill_id).lastUsedAt,
      correctionCount: correctionCounts.get(entry.skill_id) || 0,
    })),
    attributedCommandCount: commandIds.size,
  };
}

function claimDueScheduledJobs(workerId, limit = 20) {
  const db = ensureStorage();
  return db.transaction(() => {
    const now = nowIso();
    if (platformMaintenanceFromDatabase(db, now)) return [];
    db.prepare(`
      UPDATE scheduled_jobs SET status='pending', lease_owner=NULL, lease_expires_at=NULL,
        last_error='Recovered expired scheduler lease', updated_at=?
      WHERE status='leased' AND (lease_expires_at IS NULL OR lease_expires_at < ?)
    `).run(now, now);
    const rows = db.prepare(`
      SELECT j.* FROM scheduled_jobs j
      JOIN tasks t ON t.id=j.task_id
      WHERE j.status='pending' AND j.due_at<=? AND t.status='waiting_scheduled'
      ORDER BY j.due_at, j.created_at LIMIT ?
    `).all(now, Math.max(1, Math.min(100, Number(limit || 20))));
    const expires = new Date(Date.now() + SCHEDULE_CLAIM_TTL_MS).toISOString();
    const claimed = [];
    const claim = db.prepare(`
      UPDATE scheduled_jobs SET status='leased', lease_owner=?, lease_expires_at=?, updated_at=?
      WHERE id=? AND status='pending'
    `);
    for (const row of rows) {
      if (claim.run(workerId, expires, now, row.id).changes) {
        claimed.push(rowToScheduledJob({ ...row, status: 'leased', lease_owner: workerId, lease_expires_at: expires, updated_at: now }));
      }
    }
    return claimed;
  }).immediate();
}

function dispatchClaimedScheduledJob(jobId, workerId) {
  const db = ensureStorage();
  let dispatched = null;
  db.transaction(() => {
    const now = nowIso();
    if (platformMaintenanceFromDatabase(db, now)) return;
    const job = db.prepare(`
      SELECT * FROM scheduled_jobs WHERE id=? AND status='leased' AND lease_owner=?
    `).get(jobId, workerId);
    if (!job) return;
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(job.task_id);
    const external = job.external_attempt_id
      ? db.prepare('SELECT * FROM external_attempts WHERE id=?').get(job.external_attempt_id)
      : null;
    if (!task || task.status !== 'waiting_scheduled'
      || (external && Number(external.generation) !== Number(job.generation))) {
      db.prepare(`
        UPDATE scheduled_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL,
          last_error='Task or background generation is no longer dispatchable', finished_at=?, updated_at=?
        WHERE id=?
      `).run(now, now, job.id);
      return;
    }
    const payload = parseJson(job.payload_json, {});
    const nextAttempt = Number(job.attempt_count || 0) + 1;
    const commandId = eventId('scheduled-command');
    db.prepare(`
      INSERT INTO commands(id, task_id, type, input, idempotency_key, status, created_at)
      VALUES (?, ?, 'scheduled', ?, ?, 'pending', ?)
    `).run(commandId, job.task_id, String(payload.prompt || ''), `${job.id}:dispatch:${nextAttempt}`, now);
    const taskChanged = db.prepare(`
      UPDATE tasks SET status='queued', recovery_state='scheduled_queued', last_brief=?,
        cancel_requested=0, version=version+1, updated_at=?
      WHERE id=? AND status='waiting_scheduled'
    `).run(String(payload.prompt || ''), now, job.task_id);
    if (taskChanged.changes !== 1) throw statusError(`Scheduled task ${job.task_id} changed before dispatch`, 409);
    db.prepare(`
      UPDATE scheduled_jobs SET status='dispatched', lease_owner=NULL, lease_expires_at=NULL,
        command_id=?, attempt_count=?, last_error='', updated_at=? WHERE id=?
    `).run(commandId, nextAttempt, now, job.id);
    insertSessionWorklog(db, job.task_id, {
      kind: 'schedule.dispatched',
      message: `Dispatched scheduled background check ${Number(job.sequence)}`,
      payload: {
        scheduledJobId: job.id, externalAttemptId: job.external_attempt_id,
        generation: Number(job.generation), sequence: Number(job.sequence), commandId,
      },
    });
    dispatched = { ...rowToScheduledJob(job), status: 'dispatched', commandId, attemptCount: nextAttempt };
  }).immediate();
  return dispatched;
}

function trackedExternalProcesses(db, taskId, statuses) {
  const placeholders = statuses.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, pid, pid_start_ticks, process_group_id, cgroup_path, cgroup_inode
    FROM external_attempts
    WHERE task_id=? AND status IN (${placeholders})
    ORDER BY created_at DESC, id DESC
  `).all(taskId, ...statuses).flatMap((attempt) => {
    if (!Number.isInteger(Number(attempt.pid))
      || Number(attempt.pid) < 2
      || !/^\d+$/.test(String(attempt.pid_start_ticks || ''))
      || Number(attempt.process_group_id) !== Number(attempt.pid)) {
      return [];
    }
    return [{
      externalAttemptId: attempt.id,
      pid: Number(attempt.pid),
      startTicks: String(attempt.pid_start_ticks),
      processGroupId: Number(attempt.process_group_id),
      cgroupPath: String(attempt.cgroup_path || ''),
      cgroupInode: String(attempt.cgroup_inode || ''),
    }];
  });
}

function taskRuntimeActivity(db, taskId) {
  const externalProcesses = trackedExternalProcesses(
    db,
    taskId,
    ['running', 'succeeded', 'failed', 'lost', 'cancelled'],
  );
  const activeProcesses = externalProcesses.filter((external) => externalAttemptRuntimeActivity({
    sessionId: taskId,
    pid: external.pid,
    pidStartTicks: external.startTicks,
    processGroupId: external.processGroupId,
    cgroupPath: external.cgroupPath,
    cgroupInode: external.cgroupInode,
  }).active);
  return { active: activeProcesses.length > 0, externalProcesses: activeProcesses };
}

function finalizeStoppedTaskIfRuntimeEmpty(taskId, context = {}) {
  const db = ensureStorage();
  let finalized = false;
  db.transaction(() => {
    const task = db.prepare("SELECT * FROM tasks WHERE id=? AND status='stopping'").get(taskId);
    if (!task || taskRuntimeActivity(db, taskId).active) return;
    const now = nowIso();
    const changed = db.prepare(`
      UPDATE tasks SET status='stopped', recovery_state='stopped', current_pid=NULL,
        current_pid_start_ticks='', current_process_group_id=NULL,
        lease_owner=NULL, lease_expires_at=NULL, cancel_requested=0,
        version=version+1, updated_at=?
      WHERE id=? AND status='stopping' AND (lease_owner IS NULL OR lease_owner='')
    `).run(now, taskId);
    if (!changed.changes) return;
    insertSessionWorklog(db, taskId, {
      kind: 'session.stopped', level: 'warn',
      message: 'Task session stopped after all owned runtime processes exited.',
      payload: { reason: 'owned_runtime_empty' },
      actor: context.actor || 'operator', requestId: context.requestId || '',
    });
    finalized = true;
  }).immediate();
  return finalized;
}

function cancelTaskScheduledWork(db, taskId, reason, context = {}) {
  const now = nowIso();
  const affectedStepRunIds = db.prepare(`
    SELECT DISTINCT step_run_id FROM external_attempts
    WHERE task_id=? AND status='running' AND step_run_id IS NOT NULL
  `).all(taskId).map((row) => row.step_run_id);
  const jobs = db.prepare(`
    UPDATE scheduled_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL,
      last_error=?, finished_at=?, updated_at=?
    WHERE task_id=? AND status IN ('pending','leased','dispatched')
  `).run(String(reason || 'Cancelled by operator'), now, now, taskId).changes;
  const externalProcesses = trackedExternalProcesses(db, taskId, ['running']);
  const attempts = db.prepare(`
    UPDATE external_attempts SET status='cancelled', last_observation=?, finished_at=?, updated_at=?
    WHERE task_id=? AND status='running'
  `).run(String(reason || 'Cancelled by operator'), now, now, taskId).changes;
  for (const stepRunId of affectedStepRunIds) refreshStepRunStatus(db, stepRunId);
  if (jobs || attempts) {
    insertSessionWorklog(db, taskId, {
      kind: 'schedule.cancelled', level: 'warn',
      message: `Cancelled ${jobs} scheduled check(s) and ${attempts} tracked background execution(s)`,
      payload: { jobs, externalAttempts: attempts, reason: String(reason || '') },
      actor: context.actor || 'operator', requestId: context.requestId || '',
    });
  }
  return { jobs, attempts, externalProcesses };
}

function terminateTrackedExternalProcesses(taskId, externalProcesses, context = {}) {
  for (const external of externalProcesses) {
    const cgroupResult = external.cgroupPath && external.cgroupInode
      ? killVerifiedTaskCgroup({
        taskId,
        cgroupPath: external.cgroupPath,
        cgroupInode: external.cgroupInode,
      })
      : null;
    if (cgroupResult?.killed) {
      appendSessionWorklog(taskId, {
        kind: 'external.attempt.stop.cgroup_killed', level: 'warn',
        message: `Killed ${cgroupResult.members} process(es) in task cgroup for ${external.externalAttemptId}`,
        payload: { externalAttemptId: external.externalAttemptId, backend: 'cgroup.kill', ...cgroupResult },
        actor: context.actor || 'operator', requestId: context.requestId || '',
      });
      continue;
    }
    const identity = {
      pid: external.pid,
      startTicks: external.startTicks,
      processGroupId: external.processGroupId,
    };
    let result;
    try {
      result = signalVerifiedProcessGroup(identity, 'SIGTERM');
    } catch (error) {
      result = { signalled: false, reason: String(error?.code || error?.message || 'signal_failed') };
    }
    appendSessionWorklog(taskId, {
      kind: 'external.attempt.stop.signalled',
      level: result.signalled ? 'warn' : 'info',
      message: result.signalled
        ? `Sent SIGTERM to tracked background execution ${external.externalAttemptId}`
        : `Did not signal tracked background execution ${external.externalAttemptId}: ${result.reason}`,
      payload: { externalAttemptId: external.externalAttemptId, signal: 'SIGTERM', ...result },
      actor: context.actor || 'operator', requestId: context.requestId || '',
    });
    if (!result.signalled) continue;
    const timer = setTimeout(() => {
      let forced;
      try {
        forced = signalVerifiedProcessGroup(identity, 'SIGKILL');
      } catch (error) {
        forced = { signalled: false, reason: String(error?.code || error?.message || 'signal_failed') };
      }
      appendSessionWorklog(taskId, {
        kind: 'external.attempt.stop.forced',
        level: forced.signalled ? 'warn' : 'info',
        message: forced.signalled
          ? `Sent SIGKILL to tracked background execution ${external.externalAttemptId}`
          : `Tracked background execution ${external.externalAttemptId} exited before SIGKILL: ${forced.reason}`,
        payload: { externalAttemptId: external.externalAttemptId, signal: 'SIGKILL', ...forced },
        actor: context.actor || 'operator', requestId: context.requestId || '',
      });
      const settleTimer = setTimeout(() => finalizeStoppedTaskIfRuntimeEmpty(taskId, context), 50);
      settleTimer.unref();
    }, EXTERNAL_STOP_GRACE_MS);
    timer.unref();
  }
  const settleTimer = setTimeout(() => finalizeStoppedTaskIfRuntimeEmpty(taskId, context), 50);
  settleTimer.unref();
}

function queueSessionRunInTransaction(
  db,
  sessionId,
  input = '',
  idempotencyKey = '',
  context = {},
  commandType = 'run',
  allowEnqueue = true,
) {
  const taskId = safeId(sessionId);
  const commandId = eventId('command');
  const key = String(idempotencyKey || commandId);
  const runInput = String(input || '');
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) throw statusError(`Session ${taskId} not found`, 404);
  const existingCommand = db.prepare('SELECT task_id, type, input FROM commands WHERE idempotency_key = ?').get(key);
  if (existingCommand) {
    if (existingCommand.task_id !== taskId) throw statusError('Idempotency key already belongs to another task', 409);
    if (existingCommand.type !== commandType || existingCommand.input !== runInput) {
      const operation = commandType === 'create_run' ? 'create-and-run' : 'run';
      throw statusError(`Idempotency key does not match the original ${operation} request`, 409);
    }
    return rowToSession(task);
  }
  if (!task.enabled) throw statusError('Disabled sessions cannot be run', 409);
  if (task.status === 'completed') throw statusError('Completed sessions are immutable history records', 409);
  if (!allowEnqueue) return null;
  assertNoPlatformMaintenance(db);
  if (ACTIVE_STATUSES.includes(task.status)) {
    throw statusError('Session already has an active run command', 409);
  }
  const now = nowIso();
  db.prepare(`
    INSERT INTO commands(id, task_id, type, input, idempotency_key, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(commandId, taskId, commandType, runInput, key, now);
  db.prepare(`
    UPDATE tasks SET status='queued', recovery_state='queued', last_brief=?,
      cancel_requested=0, version=version+1, updated_at=? WHERE id=?
  `).run(runInput || task.objective || '', now, taskId);
  insertSessionWorklog(db, taskId, {
    kind: 'session.queued', message: `Queued task session ${taskId}`,
    payload: { commandId, commandType, idempotencyKey: key, input: runInput },
    actor: context.actor || 'operator', requestId: context.requestId || '',
  });
  return rowToSession(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
}

function queueSessionRun(sessionId, input = '', idempotencyKey = '', context = {}, options = {}) {
  const db = ensureStorage();
  return db.transaction(() => queueSessionRunInTransaction(
    db,
    sessionId,
    input,
    idempotencyKey,
    context,
    'run',
    options.allowEnqueue !== false,
  )).immediate();
}

function sessionMatchesCreateRequest(task, taskId, data) {
  return task.id === taskId
    && task.name === String(data.name || taskId).trim()
    && task.objective === String(data.objective || '').trim()
    && task.working_dir === (String(data.workingDir || '.').trim() || '.')
    && task.notes === String(data.notes || '').trim()
    && Boolean(task.enabled) === true
    && Boolean(task.auto_resume) === (data.autoResume !== false)
    && Number(task.max_retries) === Math.min(
      MAX_TASK_RETRIES,
      Math.max(0, Number(data.maxRetries ?? 2)),
    );
}

function createAndQueueSession(id, data, input = '', idempotencyKey = '', context = {}) {
  const db = ensureStorage();
  const taskId = canonicalTaskId(id);
  validateTaskBody({ ...data, id: taskId }, { creating: true, requireId: true });
  if (data.enabled === false) throw statusError('Disabled sessions cannot be created and run atomically', 400);
  const runInput = String(input || data.objective || '');
  const key = String(idempotencyKey || eventId('command'));
  return db.transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    const keyedCommand = db.prepare('SELECT * FROM commands WHERE idempotency_key=?').get(key);
    if (keyedCommand && keyedCommand.task_id !== taskId) {
      throw statusError('Idempotency key already belongs to another task', 409);
    }
    if (task) {
      const originalCommand = keyedCommand || db.prepare(`
        SELECT * FROM commands WHERE task_id=? AND type='create_run' ORDER BY created_at LIMIT 1
      `).get(taskId);
      if (!originalCommand || originalCommand.type !== 'create_run'
        || originalCommand.input !== runInput || !sessionMatchesCreateRequest(task, taskId, data)) {
        throw statusError(`Session ${taskId} already exists with a different create-and-run request`, 409);
      }
      return { session: rowToSession(task), created: false };
    }
    if (keyedCommand) throw statusError('Idempotency key belongs to a missing task', 409);
    saveSessionInTransaction(db, taskId, { ...data, status: 'idle' }, { ...context, createOnly: true });
    const session = queueSessionRunInTransaction(
      db,
      taskId,
      runInput,
      key,
      context,
      'create_run',
    );
    return { session, created: true };
  }).immediate();
}

function claimPendingCommands(workerId, limit = 10) {
  const db = ensureStorage();
  return db.transaction(() => {
    const now = nowIso();
    if (platformMaintenanceFromDatabase(db, now)) return [];
    db.prepare(`
      UPDATE commands SET status='pending', worker_id='', claimed_at='', claim_expires_at='',
        error='Recovered stale command claim'
      WHERE status='processing' AND (claim_expires_at='' OR claim_expires_at < ?)
        AND task_id IN (SELECT id FROM tasks WHERE status='queued')
    `).run(now);
    const rows = db.prepare(`
      SELECT commands.* FROM commands
      JOIN tasks ON tasks.id=commands.task_id
      WHERE commands.status='pending' AND tasks.status='queued'
      ORDER BY commands.created_at LIMIT ?
    `)
      .all(Math.max(1, Number(limit || 10)));
    const claimed = [];
    const expires = new Date(Date.now() + COMMAND_CLAIM_TTL_MS).toISOString();
    const statement = db.prepare(`
      UPDATE commands SET status='processing', worker_id=?, claimed_at=?, claim_expires_at=?
      WHERE id=? AND status='pending'
    `);
    for (const row of rows) {
      if (statement.run(workerId, now, expires, row.id).changes) {
        claimed.push({ ...row, worker_id: workerId, claimed_at: now, claim_expires_at: expires });
      }
    }
    return claimed;
  }).immediate();
}

function finishCommand(commandId, status = 'completed', error = '') {
  ensureStorage().prepare("UPDATE commands SET status=?, error=?, claim_expires_at='', finished_at=? WHERE id=?")
    .run(status, preserveString(error), nowIso(), commandId);
}

function finishClaimedCommand(commandId, workerId, status = 'completed', error = '') {
  return ensureStorage().prepare(`
    UPDATE commands SET status=?, error=?, claim_expires_at='', finished_at=?
    WHERE id=? AND status='processing' AND worker_id=?
  `).run(status, preserveString(error), nowIso(), commandId, workerId).changes === 1;
}

function deferClaimedCommand(commandId, workerId, error = '') {
  const retryAt = new Date(Date.now() + 1000).toISOString();
  return ensureStorage().prepare(`
    UPDATE commands SET error=?, claim_expires_at=?
    WHERE id=? AND status='processing' AND worker_id=?
  `).run(preserveString(error), retryAt, commandId, workerId).changes === 1;
}

function failClaimedCommand(commandId, workerId, error) {
  const db = ensureStorage();
  let handled = false;
  db.transaction(() => {
    const command = db.prepare(`
      SELECT * FROM commands WHERE id=? AND status='processing' AND worker_id=?
    `).get(commandId, workerId);
    if (!command) return;
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(command.task_id);
    if (!task) return;
    const stopping = task.status === 'stopping' || Boolean(task.cancel_requested);
    const scheduledJob = command.type === 'scheduled'
      ? db.prepare(`
        SELECT * FROM scheduled_jobs
        WHERE task_id=? AND command_id=? AND status='dispatched'
      `).get(command.task_id, command.id)
      : null;
    const message = stopping
      ? 'Task stopped before the execution process could continue'
      : preserveString(error?.message || error || 'Task execution failed');
    const retryScheduled = Boolean(scheduledJob && !stopping
      && Number(scheduledJob.attempt_count) < Number(scheduledJob.max_attempts));
    const finalStatus = stopping ? 'stopped' : (retryScheduled ? 'waiting_scheduled' : 'failed');
    const recoveryState = stopping ? 'stopped' : (retryScheduled ? 'scheduled_retry_waiting' : 'failed');
    const finishedAt = nowIso();
    const taskChanged = db.prepare(`
      UPDATE tasks SET status=?, recovery_state=?, last_error=?, summary=?,
        current_pid=NULL, current_pid_start_ticks='', current_process_group_id=NULL,
        lease_owner=NULL, lease_expires_at=NULL,
        cancel_requested=0,
        version=version+1, updated_at=?
      WHERE id=? AND lease_owner=? AND status IN ('queued','running','recovering','stopping')
    `).run(
      finalStatus, recoveryState, stopping ? '' : message, message,
      finishedAt, command.task_id, workerId,
    ).changes;
    if (!taskChanged) return;
    db.prepare(`
      UPDATE command_executions SET status=?, finished_at=CASE WHEN finished_at='' THEN ? ELSE finished_at END
      WHERE task_id=? AND attempt_id IN (
        SELECT id FROM attempts WHERE task_id=? AND worker_id=? AND status='running'
      ) AND status NOT IN ('completed','failed','cancelled','interrupted')
    `).run(stopping ? 'cancelled' : 'failed', finishedAt, command.task_id, command.task_id, workerId);
    db.prepare(`
      UPDATE attempts SET status=?, error=?, finished_at=?
      WHERE task_id=? AND worker_id=? AND status='running'
    `).run(stopping ? 'cancelled' : 'failed', message, finishedAt, command.task_id, workerId);
    db.prepare(`
      UPDATE turns SET status=?, result=?, finished_at=?
      WHERE task_id=? AND status='running'
    `).run(stopping ? 'stopped' : 'failed', message, finishedAt, command.task_id);
    db.prepare(`
      UPDATE commands SET status=?, error=?, claim_expires_at='', finished_at=?
      WHERE id=? AND status='processing' AND worker_id=?
    `).run(stopping ? 'cancelled' : 'failed', message, finishedAt, commandId, workerId);
    if (scheduledJob && !stopping) {
      if (retryScheduled) {
        const retryAt = new Date(Date.now()
          + Math.min(300000, 30000 * Math.max(1, Number(scheduledJob.attempt_count)))).toISOString();
        db.prepare(`
          UPDATE scheduled_jobs SET status='pending', due_at=?, lease_owner=NULL, lease_expires_at=NULL,
            command_id=NULL, last_error=?, finished_at='', updated_at=?
          WHERE id=? AND status='dispatched' AND command_id=?
        `).run(retryAt, message, finishedAt, scheduledJob.id, command.id);
        insertSessionWorklog(db, command.task_id, {
          kind: 'schedule.retry_scheduled', level: 'warn',
          message: `Scheduled check could not start and will retry at ${retryAt}`,
          payload: {
            scheduledJobId: scheduledJob.id,
            externalAttemptId: scheduledJob.external_attempt_id,
            commandId: command.id,
            retryAt,
            attemptCount: Number(scheduledJob.attempt_count),
            maxAttempts: Number(scheduledJob.max_attempts),
            error: message,
          },
        });
      } else {
        db.prepare(`
          UPDATE scheduled_jobs SET status='failed', lease_owner=NULL, lease_expires_at=NULL,
            last_error=?, finished_at=?, updated_at=?
          WHERE id=? AND status='dispatched' AND command_id=?
        `).run(message, finishedAt, finishedAt, scheduledJob.id, command.id);
        const external = scheduledJob.external_attempt_id
          ? db.prepare("SELECT * FROM external_attempts WHERE id=? AND status='running'")
            .get(scheduledJob.external_attempt_id)
          : null;
        if (external) {
          const previousResult = parseJson(external.result_json, {});
          const observation = `monitoring lost after ${Number(scheduledJob.attempt_count)} failed scheduled check attempts`;
          const result = {
            ...previousResult,
            status: 'lost',
            terminal: true,
            observation,
            monitoringFailure: {
              scheduledJobId: scheduledJob.id,
              commandId: command.id,
              attemptCount: Number(scheduledJob.attempt_count),
              maxAttempts: Number(scheduledJob.max_attempts),
              error: message,
            },
          };
          db.prepare(`
            UPDATE external_attempts SET status='lost', last_observation=?, result_json=?,
              finished_at=?, updated_at=? WHERE id=? AND status='running'
          `).run(observation, JSON.stringify(result), finishedAt, finishedAt, external.id);
          refreshStepRunStatus(db, external.step_run_id);
          db.prepare(`
            UPDATE scheduled_jobs SET status='cancelled', lease_owner=NULL, lease_expires_at=NULL,
              last_error='Cancelled after background monitoring was lost', finished_at=?, updated_at=?
            WHERE external_attempt_id=? AND generation=? AND id<>?
              AND status IN ('pending','leased','dispatched')
          `).run(finishedAt, finishedAt, external.id, scheduledJob.generation, scheduledJob.id);
          insertSessionWorklog(db, command.task_id, {
            kind: 'external.attempt.lost', level: 'error',
            message: `${external.label || external.id}: ${observation}`,
            payload: { externalAttemptId: external.id, generation: Number(external.generation), ...result },
          });
        }
        insertSessionWorklog(db, command.task_id, {
          kind: 'schedule.failed', level: 'error',
          message: `Scheduled check failed to start after ${Number(scheduledJob.attempt_count)} attempt(s)`,
          payload: {
            scheduledJobId: scheduledJob.id,
            externalAttemptId: scheduledJob.external_attempt_id,
            commandId: command.id,
            attemptCount: Number(scheduledJob.attempt_count),
            maxAttempts: Number(scheduledJob.max_attempts),
            error: message,
          },
        });
      }
    }
    if (!retryScheduled) {
      insertSessionWorklog(db, command.task_id, {
        kind: stopping ? 'session.stopped' : 'session.failed',
        level: stopping ? 'warn' : 'error', message,
        payload: { commandId, scheduledJobId: scheduledJob?.id || '' },
      });
    }
    handled = true;
  }).immediate();
  return handled;
}

function acquireTaskLease(taskId, workerId, ttlMs = 15000) {
  const db = ensureStorage();
  const now = nowIso();
  const expires = new Date(Date.now() + ttlMs).toISOString();
  const result = db.prepare(`
    UPDATE tasks SET lease_owner=?, lease_expires_at=?, version=version+1, updated_at=?
    WHERE id=? AND status='queued'
      AND (lease_owner IS NULL OR lease_owner=? OR lease_expires_at IS NULL OR lease_expires_at < ?)
  `).run(workerId, expires, now, safeId(taskId), workerId, now);
  return result.changes === 1;
}

function renewTaskLease(taskId, workerId, ttlMs = 15000) {
  const expires = new Date(Date.now() + ttlMs).toISOString();
  return ensureStorage().prepare('UPDATE tasks SET lease_expires_at=? WHERE id=? AND lease_owner=?')
    .run(expires, safeId(taskId), workerId).changes === 1;
}

function releaseTaskLease(taskId, workerId) {
  ensureStorage().prepare(`
    UPDATE tasks SET lease_owner=NULL, lease_expires_at=NULL, current_pid=NULL,
      current_pid_start_ticks='', current_process_group_id=NULL
    WHERE id=? AND lease_owner=?
  `).run(safeId(taskId), workerId);
}

function requestSessionStop(sessionId, context = {}) {
  const db = ensureStorage();
  const taskId = safeId(sessionId);
  reconcileExternalAttempts(taskId, { preserveTerminalSchedule: false });
  const identity = sessionOperationIdentity('stop', taskId, context);
  let stopped = false;
  let externalProcesses = [];
  db.transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) throw statusError(`Session ${taskId} not found`, 404);
    const receipt = readSessionOperationReceipt(db, identity);
    if (receipt) {
      stopped = Boolean(receipt.ok);
      if (['stopping', 'stopped'].includes(task.status)) {
        externalProcesses = taskRuntimeActivity(db, taskId).externalProcesses;
      }
      return;
    }
    assertNoPlatformMaintenance(db);
    assertExpectedTaskGeneration(task, identity);
    if (task.status === 'waiting_scheduled') {
      cancelTaskScheduledWork(db, taskId, 'Task monitoring stopped by operator', context);
      externalProcesses = taskRuntimeActivity(db, taskId).externalProcesses;
      const nextStatus = externalProcesses.length ? 'stopping' : 'stopped';
      db.prepare(`
        UPDATE tasks SET status=?, recovery_state=?, cancel_requested=?,
          current_pid=NULL, current_pid_start_ticks='', current_process_group_id=NULL,
          lease_owner=NULL, lease_expires_at=NULL,
          version=version+1, updated_at=? WHERE id=?
      `).run(nextStatus, nextStatus, nextStatus === 'stopping' ? 1 : 0, nowIso(), taskId);
      stopped = true;
      insertSessionWorklog(db, taskId, {
        kind: 'session.stop.requested', level: 'warn',
        message: `Stop requested for scheduled task session ${taskId}`,
        actor: context.actor || 'operator', requestId: context.requestId || '',
      });
    } else if (task.status === 'queued') {
      db.prepare("UPDATE commands SET status='cancelled', claim_expires_at='', finished_at=? WHERE task_id=? AND status IN ('pending','processing')")
        .run(nowIso(), taskId);
      cancelTaskScheduledWork(db, taskId, 'Task stopped before scheduled execution', context);
      externalProcesses = taskRuntimeActivity(db, taskId).externalProcesses;
      const nextStatus = externalProcesses.length ? 'stopping' : 'stopped';
      db.prepare(`
        UPDATE tasks SET status=?, recovery_state=?, cancel_requested=?,
          current_pid=NULL, current_pid_start_ticks='', current_process_group_id=NULL,
          lease_owner=NULL, lease_expires_at=NULL,
          version=version+1, updated_at=? WHERE id=?
      `).run(nextStatus, nextStatus, nextStatus === 'stopping' ? 1 : 0, nowIso(), taskId);
      stopped = true;
      insertSessionWorklog(db, taskId, {
        kind: 'session.stop.requested', level: 'warn',
        message: `Stop requested for task session ${taskId}`,
        actor: context.actor || 'operator', requestId: context.requestId || '',
      });
    } else if (['running', 'recovering', 'stopping'].includes(task.status)) {
      cancelTaskScheduledWork(db, taskId, 'Task execution stopped by operator', context);
      externalProcesses = taskRuntimeActivity(db, taskId).externalProcesses;
      db.prepare(`
        UPDATE tasks SET status='stopping', recovery_state='stopping', cancel_requested=1,
          version=version+1, updated_at=? WHERE id=?
      `).run(nowIso(), taskId);
      stopped = true;
      insertSessionWorklog(db, taskId, {
        kind: 'session.stop.requested', level: 'warn',
        message: `Stop requested for task session ${taskId}`,
        actor: context.actor || 'operator', requestId: context.requestId || '',
      });
    } else if (task.status === 'stopped') {
      externalProcesses = taskRuntimeActivity(db, taskId).externalProcesses;
      stopped = externalProcesses.length > 0;
      if (stopped) {
        db.prepare(`
          UPDATE tasks SET status='stopping', recovery_state='stopping', cancel_requested=1,
            version=version+1, updated_at=? WHERE id=? AND status='stopped'
        `).run(nowIso(), taskId);
        insertSessionWorklog(db, taskId, {
          kind: 'session.stop.residual_cleanup', level: 'warn',
          message: `Retrying cleanup for ${externalProcesses.length} tracked background process group(s)`,
          actor: context.actor || 'operator', requestId: context.requestId || '',
        });
      }
    }
    writeSessionOperationReceipt(db, identity, task.created_at, { ok: stopped }, context);
  }).immediate();
  if (externalProcesses.length) {
    terminateTrackedExternalProcesses(taskId, externalProcesses, context);
  } else {
    finalizeStoppedTaskIfRuntimeEmpty(taskId, context);
  }
  return stopped;
}

function finalizeSessionTurn(data) {
  const db = ensureStorage();
  const taskId = safeId(data.taskId);
  let session;
  let missingPlatformReportSkills = [];
  db.transaction(() => {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task) throw statusError(`Session ${taskId} not found`, 404);
    if (task.lease_owner !== data.workerId || !['running', 'recovering', 'stopping'].includes(task.status)) {
      throw statusError(`Session ${taskId} lease or state is no longer owned by this worker`, 409);
    }
    const command = db.prepare('SELECT * FROM commands WHERE id=?').get(data.commandId);
    if (!command || command.task_id !== taskId || command.status !== 'processing' || command.worker_id !== data.workerId) {
      throw statusError(`Run command ${data.commandId} is no longer owned by this worker`, 409);
    }
    const turn = db.prepare('SELECT * FROM turns WHERE id=?').get(data.turnId);
    if (!turn || turn.task_id !== taskId || turn.status !== 'running') {
      throw statusError(`Turn ${data.turnId} is no longer active for session ${taskId}`, 409);
    }
    const attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(data.attemptId);
    const attemptAlreadyFinalized = Boolean(data.attemptAlreadyFinalized);
    const expectedAttemptStatus = attemptAlreadyFinalized ? 'failed' : 'running';
    if (!attempt || attempt.task_id !== taskId || attempt.turn_id !== data.turnId
      || attempt.worker_id !== data.workerId || attempt.status !== expectedAttemptStatus) {
      throw statusError(`Attempt ${data.attemptId} is no longer owned by this worker`, 409);
    }
    // Background detection is part of finalization ownership: a stale worker
    // must not create schedules after another worker has recovered the task.
    detectExternalAttemptsForTurn(taskId, data.turnId, data.attemptId);
    reconcileExternalAttempts(taskId, { preserveTerminalSchedule: command.type !== 'scheduled' });
    const finishedAt = String(data.finishedAt || nowIso());
    const requestedFinalStatus = String(data.finalStatus || 'failed');
    const attemptStatus = requestedFinalStatus === 'waiting_review'
      ? 'completed'
      : (requestedFinalStatus === 'stopped' ? 'cancelled' : requestedFinalStatus);
    if (!attemptAlreadyFinalized) {
      const attemptChanged = db.prepare(`
        UPDATE attempts SET status=?, exit_code=?, signal=?, error=?, finished_at=?
        WHERE id=? AND status='running' AND worker_id=?
      `).run(
        attemptStatus,
        data.exitCode ?? null,
        data.signal || null,
        attemptStatus === 'completed' ? '' : String(data.summary || ''),
        finishedAt,
        data.attemptId,
        data.workerId,
      );
      if (attemptChanged.changes !== 1) throw statusError(`Attempt ${data.attemptId} could not be finalized`, 409);
    }
    db.prepare(`
      UPDATE command_executions SET status=?,
        finished_at=CASE WHEN finished_at='' THEN ? ELSE finished_at END
      WHERE attempt_id=? AND status NOT IN ('completed','failed','cancelled','interrupted')
    `).run(attemptStatus, finishedAt, data.attemptId);
    const turnChanged = db.prepare("UPDATE turns SET status=?, result=?, finished_at=? WHERE id=? AND status='running'")
      .run(
        requestedFinalStatus === 'waiting_review' ? 'completed' : requestedFinalStatus,
        String(data.resultText || data.summary || ''),
        finishedAt,
        data.turnId,
      );
    if (turnChanged.changes !== 1) throw statusError(`Turn ${data.turnId} could not be finalized`, 409);
    const scheduledJob = db.prepare("SELECT * FROM scheduled_jobs WHERE command_id=? AND status='dispatched'").get(data.commandId);
    if (scheduledJob) {
      if (requestedFinalStatus === 'waiting_review') {
        db.prepare(`
          UPDATE scheduled_jobs SET status='completed', lease_owner=NULL, lease_expires_at=NULL,
            last_error='', finished_at=?, updated_at=? WHERE id=? AND status='dispatched'
        `).run(finishedAt, finishedAt, scheduledJob.id);
        insertSessionWorklog(db, taskId, {
          turnId: data.turnId,
          kind: 'schedule.completed',
          message: `Completed scheduled background check ${Number(scheduledJob.sequence)}`,
          payload: { scheduledJobId: scheduledJob.id, externalAttemptId: scheduledJob.external_attempt_id },
        });
      } else {
        const activeExternal = Number(db.prepare(`
          SELECT COUNT(*) AS count FROM external_attempts WHERE task_id=? AND status='running'
        `).get(taskId).count);
        const retryCurrent = !activeExternal && Number(scheduledJob.attempt_count) < Number(scheduledJob.max_attempts);
        const retryAt = new Date(Date.now() + Math.min(300000, 30000 * Math.max(1, Number(scheduledJob.attempt_count)))).toISOString();
        db.prepare(`
          UPDATE scheduled_jobs SET status=?, due_at=?, lease_owner=NULL, lease_expires_at=NULL,
            command_id=NULL, last_error=?, finished_at=?, updated_at=? WHERE id=? AND status='dispatched'
        `).run(
          retryCurrent ? 'pending' : 'failed', retryCurrent ? retryAt : scheduledJob.due_at,
          String(data.summary || requestedFinalStatus), retryCurrent ? '' : finishedAt,
          finishedAt, scheduledJob.id,
        );
        insertSessionWorklog(db, taskId, {
          turnId: data.turnId,
          kind: retryCurrent ? 'schedule.retry_scheduled' : 'schedule.failed',
          level: 'warn',
          message: retryCurrent
            ? `Scheduled check failed and will retry at ${retryAt}`
            : `Scheduled check ${Number(scheduledJob.sequence)} failed`,
          payload: { scheduledJobId: scheduledJob.id, retryAt: retryCurrent ? retryAt : '', summary: String(data.summary || '') },
        });
      }
    }
    const tracked = trackingCounts(db, taskId);
    const ownedRuntimeActive = taskRuntimeActivity(db, taskId).active;
    const finalStatus = ownedRuntimeActive && requestedFinalStatus === 'stopped'
      ? 'stopping'
      : ((tracked.external || tracked.scheduled) && requestedFinalStatus !== 'stopped'
        ? 'waiting_scheduled'
        : requestedFinalStatus);
    const taskChanged = db.prepare(`
      UPDATE tasks SET status=?, current_pid=NULL, current_pid_start_ticks='', current_process_group_id=NULL,
        summary=?, last_finished_at=?, archived_at='',
        last_error=?, recovery_state=?, retry_count=?, cancel_requested=0,
        recovery_count=CASE WHEN ?='waiting_review' THEN 0 ELSE recovery_count END,
        lease_owner=NULL, lease_expires_at=NULL, version=version+1, updated_at=?
      WHERE id=? AND lease_owner=? AND status IN ('running','recovering','stopping')
    `).run(
      finalStatus,
      String(data.summary || ''),
      finishedAt,
      ['waiting_review', 'waiting_scheduled', 'stopped'].includes(finalStatus) && requestedFinalStatus === 'waiting_review'
        ? ''
        : String(data.summary || ''),
      finalStatus === 'waiting_scheduled'
        ? 'scheduled_waiting'
        : (finalStatus === 'waiting_review' ? 'waiting_review' : (finalStatus === 'failed' && data.transient ? 'recoverable' : finalStatus)),
      Number(data.retryCount || 0),
      finalStatus,
      finishedAt,
      taskId,
      data.workerId,
    );
    if (taskChanged.changes !== 1) throw statusError(`Session ${taskId} could not be finalized`, 409);
    if (finalStatus === 'waiting_review') {
      missingPlatformReportSkills = missingPlatformReportSkillsForTask(db, taskId);
    }
    if (data.resultText) {
      insertSessionWorklog(db, taskId, {
        turnId: data.turnId,
        kind: 'session.turn.result',
        message: String(data.resultText),
        payload: { result: String(data.resultText) },
      });
    }
    insertSessionWorklog(db, taskId, {
      turnId: data.turnId,
      kind: finalStatus === 'waiting_scheduled'
        ? 'session.waiting_scheduled'
        : (finalStatus === 'waiting_review' ? 'session.waiting_review' : `session.${finalStatus}`),
      level: ['waiting_review', 'waiting_scheduled'].includes(finalStatus) ? 'info' : 'warn',
      message: finalStatus === 'waiting_scheduled'
        ? `${task.name}: Codex execution released; durable background checks remain scheduled`
        : (finalStatus === 'waiting_review'
        ? `${task.name}: turn completed and is waiting for operator review`
        : `${task.name}: ${data.summary || finalStatus}`),
      payload: {
        exitCode: data.exitCode ?? null,
        signal: data.signal || null,
        retryCount: Number(data.retryCount || 0),
        transient: Boolean(data.transient),
        activeExternalAttempts: tracked.external,
        activeScheduledJobs: tracked.scheduled,
      },
    });
    const commandStatus = requestedFinalStatus === 'waiting_review'
      ? 'completed'
      : (requestedFinalStatus === 'stopped' ? 'cancelled' : 'failed');
    const commandChanged = db.prepare(`
      UPDATE commands SET status=?, error=?, claim_expires_at='', finished_at=?
      WHERE id=? AND status='processing' AND worker_id=?
    `).run(
      commandStatus,
      commandStatus === 'completed' ? '' : String(data.summary || requestedFinalStatus),
      finishedAt,
      data.commandId,
      data.workerId,
    );
    if (commandChanged.changes !== 1) throw statusError(`Run command ${data.commandId} could not be finalized`, 409);
    session = enrichSessionsWithScheduling(
      db,
      [rowToSession(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId))],
    )[0];
  }).immediate();
  publishMissingPlatformReports(taskId, data, missingPlatformReportSkills);
  return session;
}

function completeSession(sessionId, context = {}) {
  const db = ensureStorage();
  const taskId = safeId(sessionId);
  const identity = sessionOperationIdentity('complete', taskId, context);
  let session;
  db.transaction(() => {
    const receipt = readSessionOperationReceipt(db, identity);
    if (receipt) {
      session = receipt;
      return;
    }
    assertNoPlatformMaintenance(db);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) throw statusError(`Session ${taskId} not found`, 404);
    assertExpectedTaskGeneration(task, identity);
    if (task.status === 'completed') {
      session = rowToSession(task);
      return;
    }
    if (!['waiting_review', 'waiting_input'].includes(task.status)) {
      throw statusError('Only a reviewed task can be completed', 409);
    }
    const tracked = trackingCounts(db, taskId);
    if (tracked.external || tracked.scheduled) {
      throw statusError('Task still has background executions or scheduled checks', 409);
    }
    if (db.prepare(`
      SELECT 1 FROM skill_report_artifact_jobs
      WHERE task_id=? AND status IN ('pending','processing','retry') LIMIT 1
    `).get(taskId)) {
      throw statusError('Task still has report artifacts awaiting archival', 409);
    }
    if (taskRuntimeActivity(db, taskId).active) {
      throw statusError('Task still has owned runtime processes or threads', 409);
    }
    const now = nowIso();
    db.prepare(`
      UPDATE tasks SET status='completed', archived_at=?, recovery_state='archived',
        lease_owner=NULL, lease_expires_at=NULL, cancel_requested=0,
        version=version+1, updated_at=? WHERE id=?
    `).run(now, now, taskId);
    insertSessionWorklog(db, taskId, {
      kind: 'session.completed',
      message: `Completed and archived task session ${taskId}`,
      actor: context.actor || 'operator', requestId: context.requestId || '',
    });
    db.prepare("DELETE FROM session_operation_receipts WHERE task_id=? AND operation='restore'").run(taskId);
    session = rowToSession(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
    writeSessionOperationReceipt(db, identity, task.created_at, session, context);
  }).immediate();
  return session;
}

function resetSession(sessionId, context = {}) {
  const db = ensureStorage();
  const taskId = safeId(sessionId);
  const identity = sessionOperationIdentity('reset', taskId, context);
  let session;
  db.transaction(() => {
    const receipt = readSessionOperationReceipt(db, identity);
    if (receipt) {
      session = receipt;
      return;
    }
    assertNoPlatformMaintenance(db);
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task) throw statusError(`Session ${taskId} not found`, 404);
    assertExpectedTaskGeneration(task, identity);
    if (ACTIVE_STATUSES.includes(task.status)) {
      throw statusError('Stop the active task before resetting its Session', 409);
    }
    if (task.current_pid || task.lease_owner || task.lease_expires_at) {
      throw statusError('Task runtime ownership must be released before resetting its Session', 409);
    }
    if (db.prepare(`
      SELECT 1 FROM commands
      WHERE task_id=? AND status IN ('pending','processing') LIMIT 1
    `).get(taskId)) {
      throw statusError('Task still has an active run command', 409);
    }
    if (db.prepare("SELECT 1 FROM attempts WHERE task_id=? AND status='running' LIMIT 1").get(taskId)) {
      throw statusError('Task still has a running Attempt', 409);
    }
    const tracked = trackingCounts(db, taskId);
    if (tracked.external || tracked.scheduled) {
      throw statusError('Task still has background executions or scheduled checks', 409);
    }
    if (taskRuntimeActivity(db, taskId).active) {
      throw statusError('Task still has owned runtime processes or threads', 409);
    }

    const previousSessionKey = String(task.persistent_session_key || '').trim();
    if (previousSessionKey && db.prepare(`
      SELECT 1 FROM bridge_cleanup_jobs
      WHERE task_id=? AND task_created_at=? AND session_key=? AND status='processing'
    `).get(taskId, task.created_at, previousSessionKey)) {
      throw statusError('The current task Runtime is already being reclaimed', 409);
    }
    if (previousSessionKey) {
      enqueueBridgeCleanupJob(db, task, 'deleted', context);
      db.prepare(`
        UPDATE bridge_cleanup_jobs SET reason='deleted', updated_at=?
        WHERE task_id=? AND task_created_at=? AND session_key=?
          AND status IN ('pending','retry')
      `).run(nowIso(), taskId, task.created_at, previousSessionKey);
    }

    const now = nowIso();
    db.prepare(`
      UPDATE tasks SET status='idle', summary='', last_run_at='', last_finished_at='',
        archived_at='', current_pid=NULL, current_pid_start_ticks='', current_process_group_id=NULL,
        persistent_session_key='', retry_count=0, recovery_count=0, last_brief='', last_error='',
        recovery_state='reset', lease_owner=NULL, lease_expires_at=NULL, cancel_requested=0,
        version=version+1, updated_at=? WHERE id=?
    `).run(now, taskId);
    insertSessionWorklog(db, taskId, {
      kind: 'session.reset', level: 'warn',
      message: `Reset the current Codex Session for task ${taskId}`,
      payload: { previousStatus: task.status, runtimeCleanupQueued: Boolean(previousSessionKey) },
      actor: context.actor || 'operator', requestId: context.requestId || '',
    });
    session = rowToSession(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId));
    writeSessionOperationReceipt(db, identity, task.created_at, session, context);
  }).immediate();
  return session;
}

function restoreCompletedSession(sessionId, context = {}) {
  const db = ensureStorage();
  const taskId = safeId(sessionId);
  const identity = sessionOperationIdentity('restore', taskId, context);
  let session;
  db.transaction(() => {
    const receipt = readSessionOperationReceipt(db, identity);
    if (receipt) {
      session = receipt;
      return;
    }
    assertNoPlatformMaintenance(db);
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
    if (!task) throw statusError(`Session ${taskId} not found`, 404);
    assertExpectedTaskGeneration(task, identity);
    if (task.status !== 'completed') throw statusError('Only a completed task can be restored', 409);
    if (!String(task.persistent_session_key || '').trim()) {
      throw statusError('The completed task does not have a resumable Codex Session', 409);
    }
    const cleanup = db.prepare(`
      SELECT id, status FROM bridge_cleanup_jobs
      WHERE task_id=? AND task_created_at=? AND session_key=?
      ORDER BY created_at DESC LIMIT 1
    `).get(taskId, task.created_at, task.persistent_session_key);
    if (cleanup?.status === 'processing') {
      throw statusError('The completed task Runtime is currently being reclaimed', 409);
    }
    if (cleanup?.status === 'completed') {
      throw statusError('The completed task Runtime has already been reclaimed', 409);
    }
    if (cleanup) {
      db.prepare("DELETE FROM bridge_cleanup_jobs WHERE id=? AND status IN ('pending','retry')").run(cleanup.id);
      appendAuditEvent({
        scope: 'runtime', taskId, entityType: 'bridge_cleanup', entityId: cleanup.id,
        kind: 'bridge.session.cleanup.cancelled',
        message: `Cancelled Bridge Session cleanup while restoring ${taskId}`,
        actor: context.actor || 'operator', requestId: context.requestId || '',
      }, db);
    }
    const now = nowIso();
    db.prepare(`
      UPDATE tasks SET status='waiting_input', archived_at='', recovery_state='restored',
        version=version+1, updated_at=? WHERE id=? AND status='completed'
    `).run(now, taskId);
    insertSessionWorklog(db, taskId, {
      kind: 'session.restored',
      message: `Restored archived task session ${taskId}`,
      actor: context.actor || 'operator', requestId: context.requestId || '',
    });
    db.prepare("DELETE FROM session_operation_receipts WHERE task_id=? AND operation='complete'").run(taskId);
    session = rowToSession(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId));
    writeSessionOperationReceipt(db, identity, task.created_at, session, context);
  }).immediate();
  return session;
}

function recoverExpiredTasks() {
  const db = ensureStorage();
  const now = nowIso();
  const recovered = [];
  const stoppingCleanup = [];
  db.transaction(() => {
    const rows = db.prepare(`
      SELECT * FROM tasks
      WHERE (
        status IN ('running', 'recovering', 'stopping')
        AND (lease_expires_at IS NULL OR lease_expires_at < ?)
      ) OR (
        status = 'interrupted' AND auto_resume = 1
        AND recovery_count < max_retries
      )
    `).all(now);
    for (const task of rows) {
      const scheduledJob = db.prepare(`
        SELECT j.* FROM scheduled_jobs j
        JOIN commands c ON c.id=j.command_id
        WHERE j.task_id=? AND j.status='dispatched' AND c.status='processing'
        ORDER BY j.updated_at DESC LIMIT 1
      `).get(task.id);
      const interruptedStatus = task.status === 'stopping' ? 'cancelled' : 'interrupted';
      const interruptedMessage = task.status === 'stopping' ? 'Stopped after worker interruption' : 'Worker lease expired';
      db.prepare(`
        UPDATE command_executions SET status=?, finished_at=CASE WHEN finished_at='' THEN ? ELSE finished_at END
        WHERE task_id=? AND attempt_id IN (
          SELECT id FROM attempts WHERE task_id=? AND status='running'
        ) AND status NOT IN ('completed','failed','cancelled','interrupted')
      `).run(interruptedStatus, now, task.id, task.id);
      db.prepare(`
        UPDATE attempts SET status=?, error=?, finished_at=?
        WHERE task_id=? AND status='running'
      `).run(interruptedStatus, interruptedMessage, now, task.id);
      db.prepare(`
        UPDATE turns SET status=?, result=?, finished_at=?
        WHERE task_id=? AND status='running'
      `).run(task.status === 'stopping' ? 'stopped' : 'interrupted', interruptedMessage, now, task.id);
      db.prepare(`
        UPDATE commands SET status=?, error=?, claim_expires_at='', finished_at=?
        WHERE task_id=? AND status='processing'
      `).run(
        task.status === 'stopping' ? 'cancelled' : 'failed',
        task.status === 'stopping' ? interruptedMessage : 'Worker lease expired',
        now,
        task.id,
      );
      if (task.status === 'stopping') {
        const runtime = taskRuntimeActivity(db, task.id);
        if (runtime.active) {
          db.prepare(`
            UPDATE tasks SET recovery_state='stopping', current_pid=NULL,
              current_pid_start_ticks='', current_process_group_id=NULL,
              lease_owner=NULL, lease_expires_at=NULL, cancel_requested=1,
              version=version+1, updated_at=? WHERE id=? AND status='stopping'
          `).run(now, task.id);
          stoppingCleanup.push({ taskId: task.id, externalProcesses: runtime.externalProcesses });
          recovered.push({ id: task.id, resumed: false, status: 'stopping' });
          continue;
        }
        db.prepare(`
          UPDATE tasks SET status='stopped', recovery_state='stopped', current_pid=NULL,
            current_pid_start_ticks='', current_process_group_id=NULL,
            lease_owner=NULL, lease_expires_at=NULL, cancel_requested=0,
            version=version+1, updated_at=? WHERE id=?
        `).run(now, task.id);
        recovered.push({ id: task.id, resumed: false, status: 'stopped' });
        insertSessionWorklog(db, task.id, {
          kind: 'session.stopped',
          level: 'warn',
          message: 'Task session stopped after worker interruption.',
          payload: {
            reason: 'worker_lease_expired',
            recoveryCount: Number(task.recovery_count || 0),
            maxRetries: Number(task.max_retries || 0),
          },
        });
        continue;
      }
      if (scheduledJob) {
        const retryAt = new Date(Date.now() + 30000).toISOString();
        db.prepare(`
          UPDATE scheduled_jobs SET status='pending', due_at=?, lease_owner=NULL, lease_expires_at=NULL,
            command_id=NULL, last_error='Recovered scheduled check after worker lease expiry',
            finished_at='', updated_at=? WHERE id=? AND status='dispatched'
        `).run(retryAt, now, scheduledJob.id);
        db.prepare(`
          UPDATE tasks SET status='waiting_scheduled', recovery_state='scheduled_recovered', current_pid=NULL,
            current_pid_start_ticks='', current_process_group_id=NULL,
            lease_owner=NULL, lease_expires_at=NULL, cancel_requested=0,
            version=version+1, updated_at=? WHERE id=?
        `).run(now, task.id);
        recovered.push({ id: task.id, resumed: true, status: 'waiting_scheduled' });
        insertSessionWorklog(db, task.id, {
          kind: 'schedule.recovered', level: 'warn',
          message: 'Recovered a scheduled background check after worker interruption.',
          payload: { scheduledJobId: scheduledJob.id, retryAt, reason: 'worker_lease_expired' },
        });
        continue;
      }
      if (task.auto_resume && Number(task.recovery_count || 0) < Number(task.max_retries || 0)) {
        const commandId = eventId('recovery');
        db.prepare(`
          INSERT INTO commands(id, task_id, type, input, idempotency_key, status, created_at)
          VALUES (?, ?, 'recovery', ?, ?, 'pending', ?)
        `).run(commandId, task.id, 'Recover the interrupted task from its latest completed action.', commandId, now);
        db.prepare(`
          UPDATE tasks SET status='queued', recovery_state='recovery_queued', current_pid=NULL,
            current_pid_start_ticks='', current_process_group_id=NULL,
            lease_owner=NULL, lease_expires_at=NULL, cancel_requested=0,
            recovery_count=recovery_count+1, version=version+1, updated_at=? WHERE id=?
        `).run(now, task.id);
        recovered.push({ id: task.id, resumed: true, status: 'queued' });
      } else {
        db.prepare(`
          UPDATE tasks SET status='interrupted', recovery_state=?, current_pid=NULL,
            current_pid_start_ticks='', current_process_group_id=NULL,
            lease_owner=NULL, lease_expires_at=NULL, cancel_requested=0,
            version=version+1, updated_at=? WHERE id=?
        `).run(task.auto_resume ? 'retry_exhausted' : 'recoverable', now, task.id);
        recovered.push({ id: task.id, resumed: false, status: 'interrupted' });
      }
      insertSessionWorklog(db, task.id, {
        kind: task.status === 'stopping'
          ? 'session.stopped'
          : (task.auto_resume && Number(task.recovery_count || 0) < Number(task.max_retries || 0)
            ? 'session.resume.queued'
            : 'session.interrupted'),
        level: 'warn',
        message: task.status === 'stopping'
          ? 'Task session stopped after worker interruption.'
          : (task.auto_resume && Number(task.recovery_count || 0) < Number(task.max_retries || 0)
            ? 'Queued automatic session recovery after worker interruption.'
            : (task.auto_resume
              ? 'Task session interrupted after automatic recovery attempts were exhausted.'
              : 'Task session interrupted after worker lease expired.')),
        payload: {
          reason: 'worker_lease_expired',
          recoveryCount: Number(task.recovery_count || 0),
          maxRetries: Number(task.max_retries || 0),
        },
      });
    }
    const orphanedExternalAttempts = db.prepare(`
      SELECT e.* FROM external_attempts e
      JOIN tasks t ON t.id=e.task_id
      WHERE t.status='waiting_scheduled' AND e.status='running'
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_jobs j
          WHERE j.external_attempt_id=e.id AND j.generation=e.generation
            AND j.status IN ('pending','leased','dispatched')
        )
      ORDER BY e.created_at, e.id
    `).all();
    for (const row of orphanedExternalAttempts) {
      const attempt = rowToExternalAttempt(row);
      const job = insertScheduledJob(db, attempt, now);
      db.prepare(`
        UPDATE tasks SET recovery_state='scheduled_recovered', version=version+1, updated_at=?
        WHERE id=? AND status='waiting_scheduled'
      `).run(now, row.task_id);
      insertSessionWorklog(db, row.task_id, {
        kind: 'schedule.recovered', level: 'warn',
        message: 'Recreated a missing durable background check.',
        payload: {
          scheduledJobId: job.id,
          externalAttemptId: row.id,
          generation: Number(row.generation),
          dueAt: job.dueAt,
          reason: 'missing_active_schedule',
        },
      });
    }
    const strandedTasks = db.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.status='waiting_scheduled'
        AND NOT EXISTS (
          SELECT 1 FROM external_attempts e
          WHERE e.task_id=t.id AND e.status='running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_jobs j
          WHERE j.task_id=t.id AND j.status IN ('pending','leased','dispatched')
        )
      ORDER BY t.created_at, t.id
    `).all();
    for (const task of strandedTasks) {
      const runtime = taskRuntimeActivity(db, task.id);
      if (runtime.active) {
        for (const external of runtime.externalProcesses.slice(0, 1)) {
          const row = db.prepare('SELECT * FROM external_attempts WHERE id=?').get(external.externalAttemptId);
          if (!row) continue;
          db.prepare(`
            UPDATE external_attempts SET status='running', finished_at='', updated_at=? WHERE id=?
          `).run(now, row.id);
          refreshStepRunStatus(db, row.step_run_id);
          insertScheduledJob(db, rowToExternalAttempt({ ...row, status: 'running', finished_at: '', updated_at: now }), now);
        }
        continue;
      }
      const changed = db.prepare(`
        UPDATE tasks SET status='waiting_review', recovery_state='waiting_review',
          current_pid=NULL, current_pid_start_ticks='', current_process_group_id=NULL,
          lease_owner=NULL, lease_expires_at=NULL,
          version=version+1, updated_at=?
        WHERE id=? AND status='waiting_scheduled'
      `).run(now, task.id);
      if (!changed.changes) continue;
      insertSessionWorklog(db, task.id, {
        kind: 'session.waiting_review', level: 'warn',
        message: `${task.name}: repaired a scheduled wait with no remaining background work`,
        payload: {
          reason: 'tracking_state_recovered',
          activeExternalAttempts: 0,
          activeScheduledJobs: 0,
        },
      });
    }
  }).immediate();
  for (const cleanup of stoppingCleanup) {
    terminateTrackedExternalProcesses(cleanup.taskId, cleanup.externalProcesses, { actor: 'system' });
  }
  return recovered;
}

function materializeSkillSnapshot(snapshotId) {
  const db = ensureStorage();
  const snapshot = db.prepare('SELECT * FROM skill_snapshots WHERE id = ?').get(snapshotId);
  if (!snapshot) return null;
  const entries = db.prepare('SELECT * FROM skill_snapshot_entries WHERE snapshot_id = ? ORDER BY skill_id').all(snapshotId);
  const fileRows = db.prepare(`
    SELECT * FROM skill_snapshot_files WHERE snapshot_id=? ORDER BY skill_id, file_path
  `).all(snapshotId);
  const filesBySkill = new Map(entries.map((entry) => [entry.skill_id, []]));
  for (const row of fileRows) {
    filesBySkill.get(row.skill_id)?.push({
      path: row.file_path,
      content: Buffer.from(row.content),
      mode: Number(row.mode),
      contentHash: row.content_hash,
    });
  }
  const taskSnapshotDir = path.join(SKILL_SNAPSHOTS_DIR, safeId(snapshot.task_id));
  const snapshotDir = path.join(taskSnapshotDir, snapshot.id);
  const manifest = {
    id: snapshot.id,
    taskId: snapshot.task_id,
    contentHash: snapshot.content_hash,
    createdAt: snapshot.created_at,
    skills: entries.map((entry) => ({
      id: entry.skill_id,
      name: entry.name,
      origin: entry.origin,
      version: Number(entry.version),
      contentHash: entry.content_hash,
      files: (filesBySkill.get(entry.skill_id) || []).map((file) => ({
        path: file.path,
        mode: file.mode,
        contentHash: file.contentHash,
      })),
    })),
  };
  const expectedNames = new Set(['manifest.json', ...entries.map((entry) => safeId(entry.skill_id))]);
  let valid = false;
  try {
    const snapshotStat = fs.lstatSync(snapshotDir);
    valid = snapshotStat.isDirectory() && !snapshotStat.isSymbolicLink();
    const names = valid ? fs.readdirSync(snapshotDir) : [];
    valid = valid && names.length === expectedNames.size && names.every((name) => expectedNames.has(name));
    const manifestPath = path.join(snapshotDir, 'manifest.json');
    const manifestStat = valid ? fs.lstatSync(manifestPath) : null;
    const storedManifest = manifestStat?.isFile() && !manifestStat.isSymbolicLink()
      ? readJson(manifestPath, null)
      : null;
    valid = valid && (snapshotStat.mode & 0o777) === 0o500
      && (manifestStat?.mode & 0o777) === 0o400
      && JSON.stringify(storedManifest) === JSON.stringify(manifest);
    for (const entry of entries) {
      if (!valid) break;
      const skillDir = path.join(snapshotDir, safeId(entry.skill_id));
      const expectedFiles = filesBySkill.get(entry.skill_id) || [];
      const actualFiles = [];
      const visit = (directory, relativeDirectory = '') => {
        const directoryStat = fs.lstatSync(directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777) !== 0o500) {
          throw new Error('Invalid snapshot directory');
        }
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
          const relativePath = relativeDirectory ? `${relativeDirectory}/${item.name}` : item.name;
          const absolutePath = path.join(directory, item.name);
          if (item.isSymbolicLink()) throw new Error('Invalid snapshot link');
          if (item.isDirectory()) visit(absolutePath, relativePath);
          else if (item.isFile()) actualFiles.push({ relativePath, absolutePath });
          else throw new Error('Invalid snapshot entry');
        }
      };
      visit(skillDir);
      valid = actualFiles.length === expectedFiles.length;
      for (const file of expectedFiles) {
        if (!valid) break;
        const actual = actualFiles.find((item) => item.relativePath === file.path);
        const stat = actual ? fs.lstatSync(actual.absolutePath) : null;
        const expectedMode = file.mode & 0o111 ? 0o500 : 0o400;
        valid = Boolean(stat?.isFile() && !stat.isSymbolicLink()
          && (stat.mode & 0o777) === expectedMode
          && hashBuffer(fs.readFileSync(actual.absolutePath)) === file.contentHash);
      }
    }
  } catch {
    valid = false;
  }

  if (!valid) {
    ensureManagedDirectory(SKILL_SNAPSHOTS_DIR, {
      label: 'Skill snapshot storage root',
    });
    ensureManagedDirectory(taskSnapshotDir, {
      label: 'Task Skill snapshot directory',
    });
    const materializingDir = path.join(taskSnapshotDir, `.${snapshot.id}.materializing-${crypto.randomUUID()}`);
    const staleDir = path.join(taskSnapshotDir, `.${snapshot.id}.stale-${crypto.randomUUID()}`);
    let stagedExisting = false;
    try {
      ensureManagedDirectory(materializingDir, {
        label: 'Skill snapshot materializing directory',
      });
      for (const entry of entries) {
        const skillDir = path.join(materializingDir, safeId(entry.skill_id));
        ensureManagedDirectory(skillDir, {
          label: 'Materialized Skill directory',
        });
        for (const file of filesBySkill.get(entry.skill_id) || []) {
          const filePath = path.join(skillDir, ...file.path.split('/'));
          ensureManagedDirectory(path.dirname(filePath), {
            recursive: true,
            label: 'Materialized Skill child directory',
          });
          writeManagedFile(filePath, file.content, {
            exclusive: true,
            mode: file.mode & 0o111 ? 0o500 : 0o400,
            label: 'Materialized Skill file',
          });
        }
        const lockDirectories = (directory) => {
          for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
            if (item.isDirectory()) lockDirectories(path.join(directory, item.name));
          }
          fs.chmodSync(directory, 0o500);
        };
        lockDirectories(skillDir);
      }
      writeManagedFile(path.join(materializingDir, 'manifest.json'), JSON.stringify(manifest, null, 2), {
        exclusive: true,
        mode: 0o400,
        label: 'Skill snapshot manifest',
      });
      fs.chmodSync(materializingDir, 0o500);
      if (pathEntryExists(snapshotDir)) {
        fs.renameSync(snapshotDir, staleDir);
        stagedExisting = true;
      }
      fs.renameSync(materializingDir, snapshotDir);
      if (stagedExisting) removeTree(staleDir);
    } catch (error) {
      try {
        if (!pathEntryExists(snapshotDir) && stagedExisting && pathEntryExists(staleDir)) fs.renameSync(staleDir, snapshotDir);
        if (pathEntryExists(materializingDir)) removeTree(materializingDir);
      } catch {}
      throw error;
    }
  }
  return {
    id: snapshot.id,
    taskId: snapshot.task_id,
    contentHash: snapshot.content_hash,
    path: snapshotDir,
    skills: entries.map((entry) => ({
      id: entry.skill_id, name: entry.name, origin: entry.origin,
      version: Number(entry.version), contentHash: entry.content_hash,
      fileCount: (filesBySkill.get(entry.skill_id) || []).length,
    })),
  };
}

function ensureTaskSkillSnapshot(taskId) {
  refreshSourceSkills();
  const db = ensureStorage();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(safeId(taskId));
  if (!task) throw statusError(`Session ${taskId} not found`, 404);
  if (task.skill_snapshot_id) return materializeSkillSnapshot(task.skill_snapshot_id);
  const skills = db.prepare(`
    SELECT s.*, v.content FROM skills s
    JOIN skill_versions v ON v.skill_id=s.id AND v.version=s.current_version
    WHERE s.enabled=1 ORDER BY s.id
  `).all();
  const digest = hashContent(JSON.stringify(skills.map((skill) => [skill.id, skill.current_version, skill.content_hash])));
  const snapshotId = `snapshot-${safeId(task.id)}-${digest.slice(0, 16)}`;
  const now = nowIso();
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO skill_snapshots(id, task_id, content_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(snapshotId, task.id, digest, now);
    const insert = db.prepare(`
      INSERT OR IGNORE INTO skill_snapshot_entries
        (snapshot_id, skill_id, version, origin, name, content, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFile = db.prepare(`
      INSERT OR IGNORE INTO skill_snapshot_files
        (snapshot_id, skill_id, file_path, content, mode, content_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const skill of skills) {
      insert.run(snapshotId, skill.id, skill.current_version, skill.origin, skill.name, skill.content, skill.content_hash);
      for (const file of skillVersionFiles(db, skill.id, skill.current_version)) {
        insertFile.run(snapshotId, skill.id, file.path, file.content, file.mode, file.contentHash);
      }
    }
    db.prepare('UPDATE tasks SET skill_snapshot_id=?, version=version+1, updated_at=? WHERE id=?')
      .run(snapshotId, now, task.id);
  }).immediate();
  return materializeSkillSnapshot(snapshotId);
}

function hasActiveSessions(dbOverride = null) {
  const db = dbOverride || ensureStorage();
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  return Boolean(db.prepare(`SELECT 1 FROM tasks WHERE status IN (${placeholders}) LIMIT 1`).get(...ACTIVE_STATUSES));
}

function hasExternalArchivesInProgress(dbOverride = null) {
  const db = dbOverride || ensureStorage();
  return Boolean(db.prepare(`
    SELECT 1 FROM external_attempts
    WHERE archive_status='archiving' OR archive_verify_status='verifying' LIMIT 1
  `).get());
}

function decodeBundleSkillFiles(skill) {
  if (skill.files == null) return skill;
  if (!Array.isArray(skill.files)) throw statusError(`Skill ${skill.id} files must be an array`, 400);
  const decoded = skill.files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || typeof file.path !== 'string' || typeof file.contentBase64 !== 'string'
      || (file.mode != null && !Number.isInteger(file.mode))) {
      throw statusError(`Skill ${skill.id} contains an invalid file entry`, 400);
    }
    const encoded = file.contentBase64;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw statusError(`Skill ${skill.id} contains invalid base64 content`, 400);
    }
    return { path: file.path, content: Buffer.from(encoded, 'base64'), mode: file.mode };
  });
  return { ...skill, files: normalizeSkillFiles(decoded, skill.content) };
}

function exportConfigBundle() {
  const db = ensureStorage();
  return {
    format: 'codex-ops-bundle',
    version: 4,
    exportedAt: nowIso(),
    skills: listManagedSkills().map((skill) => {
      const exported = {
        id: skill.id,
        name: skill.name,
        category: skill.category,
        description: skill.description,
        tags: skill.tags,
        enabled: skill.enabled,
        content: skill.content,
      };
      const files = skillVersionFiles(db, skill.id, skill.version);
      if (files.length > 1) {
        exported.files = files.map((file) => ({
          path: file.path,
          mode: file.mode,
          contentBase64: file.content.toString('base64'),
        }));
      }
      return exported;
    }),
    sessions: listSessions().filter((session) => session.status !== 'completed').map((session) => ({
      id: session.id,
      name: session.name,
      objective: session.objective,
      workingDir: session.workingDir,
      notes: session.notes,
      enabled: session.enabled,
      autoResume: session.autoResume,
      maxRetries: session.maxRetries,
    })),
  };
}

function importConfigBundle(bundle, mode = 'merge', context = {}) {
  if (!bundle || bundle.format !== 'codex-ops-bundle') throw statusError('Unsupported bundle format', 400);
  if (![3, 4].includes(bundle.version)) throw statusError('Only config bundle versions 3 and 4 are supported', 400);
  if (!['merge', 'replace'].includes(mode)) throw statusError('Import mode must be merge or replace', 400);
  if (hasActiveSessions()) throw statusError('Stop all active sessions before importing configuration', 409);
  if (hasExternalArchivesInProgress()) {
    throw statusError('Wait for background log archival before importing configuration', 409);
  }
  const db = ensureStorage();
  if (bundle.skills != null && !Array.isArray(bundle.skills)) throw statusError('Bundle skills must be an array', 400);
  if (bundle.sessions != null && !Array.isArray(bundle.sessions)) throw statusError('Bundle sessions must be an array', 400);
  const skills = (Array.isArray(bundle.skills) ? bundle.skills : []).map(decodeBundleSkillFiles);
  const sessions = Array.isArray(bundle.sessions) ? bundle.sessions : [];
  if (skills.length > 5000 || sessions.length > 5000) throw statusError('Bundle contains too many entries', 400);
  const skillIds = new Set();
  const sessionIds = new Set();
  for (const skill of skills) {
    validateSkillBody(skill, { creating: true, requireId: true });
    const skillId = canonicalManagedSkillId(skill.id);
    if (skillIds.has(skillId)) throw statusError(`Duplicate imported skill id: ${skillId}`, 400);
    skillIds.add(skillId);
  }
  for (const session of sessions) {
    validateTaskBody(session, { creating: true, requireId: true });
    const sessionId = canonicalTaskId(session?.id);
    if (sessionIds.has(sessionId)) throw statusError(`Duplicate imported session id: ${sessionId}`, 400);
    sessionIds.add(sessionId);
    resolveWorkingDir(session.workingDir || '.');
    if (ACTIVE_STATUSES.includes(String(session.status || 'idle'))) {
      throw statusError(`Session ${session.id} has an active status that cannot be imported`, 400);
    }
  }
  refreshSourceSkills();
  const completedTaskIds = new Set(db.prepare("SELECT id FROM tasks WHERE status='completed'").all().map((row) => row.id));
  if (mode === 'replace') {
    const collision = [...sessionIds].find((id) => completedTaskIds.has(id));
    if (collision) throw statusError(`Imported session ${collision} conflicts with immutable completed history`, 409);
  }
  const result = {
    mode,
    importedAt: nowIso(),
    counts: { skills: skills.length, sessions: sessions.length },
    preservedCompletedSessions: mode === 'replace' ? completedTaskIds.size : 0,
  };
  let removedTaskIds = [];
  let stagedFiles = [];
  try {
    db.transaction(() => {
      assertNoPlatformMaintenance(db);
      if (hasActiveSessions(db)) throw statusError('Stop all active sessions before importing configuration', 409);
      if (hasExternalArchivesInProgress(db)) {
        throw statusError('Wait for background log archival before importing configuration', 409);
      }
      if (mode === 'replace') {
        const removedTasks = db.prepare("SELECT id, created_at FROM tasks WHERE status<>'completed'").all();
        removedTaskIds = removedTasks.map((row) => row.id);
        for (const task of removedTasks) stagedFiles.push(...stageTaskFilesForDeletion(task.id, task.created_at));
        db.prepare("DELETE FROM tasks WHERE status<>'completed'").run();
        db.prepare("DELETE FROM skills WHERE origin='managed'").run();
      }
      for (const skill of skills) saveSkill(skill.id, skill, context);
      for (const session of sessions) {
        saveSession(session.id, {
          ...session,
          status: 'idle',
          summary: '',
          runCount: 0,
          persistentSessionKey: '',
          lastRunAt: '',
          lastFinishedAt: '',
          archivedAt: '',
          lastBrief: '',
          lastError: '',
          recoveryState: 'idle',
        }, context);
      }
      appendAuditEvent({
        scope: 'config', entityType: 'bundle', entityId: 'config',
        kind: 'bundle.imported', message: `Imported config bundle in ${mode} mode`, payload: result,
        actor: context.actor || 'operator', requestId: context.requestId || '',
      }, db);
    }).immediate();
  } catch (error) {
    restoreStagedTaskFiles(stagedFiles);
    throw error;
  }
  discardStagedTaskFiles(stagedFiles, removedTaskIds.join(','));
  return result;
}

function setMetadata(key, value) {
  ensureStorage().prepare(`
    INSERT INTO metadata(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(String(key), JSON.stringify(value));
}

function getMetadata(key, fallback = null) {
  const row = ensureStorage().prepare('SELECT value FROM metadata WHERE key = ?').get(String(key));
  return row ? parseJson(row.value, fallback) : fallback;
}

function platformMaintenanceFromDatabase(db, now = nowIso()) {
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(PLATFORM_MAINTENANCE_KEY);
  if (!row) return null;
  const value = parseJson(row.value, null);
  if (!value || typeof value !== 'object' || String(value.expiresAt || '') <= now) return null;
  return {
    kind: String(value.kind || 'maintenance'),
    owner: String(value.owner || ''),
    startedAt: String(value.startedAt || ''),
    expiresAt: String(value.expiresAt || ''),
  };
}

function getPlatformMaintenance() {
  return platformMaintenanceFromDatabase(ensureStorage());
}

function platformActivityCountsFromDatabase(db) {
  const countStatuses = (table, statuses) => {
    const placeholders = statuses.map(() => '?').join(',');
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE status IN (${placeholders})`)
      .get(...statuses).count);
  };
  return {
    tasks: countStatuses('tasks', ACTIVE_STATUSES),
    attempts: countStatuses('attempts', ['running']),
    commands: countStatuses('commands', ['pending', 'processing']),
    scheduledJobs: countStatuses('scheduled_jobs', ACTIVE_SCHEDULE_STATUSES),
    externalAttempts: countStatuses('external_attempts', ACTIVE_EXTERNAL_STATUSES),
    externalArchives: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM external_attempts WHERE archive_status='archiving'
    `).get().count),
    externalArchiveVerifications: Number(db.prepare(`
      SELECT COUNT(*) AS count FROM external_attempts WHERE archive_verify_status='verifying'
    `).get().count),
    reportArtifactArchives: countStatuses('skill_report_artifact_jobs', ['processing']),
    bridgeCleanups: countStatuses('bridge_cleanup_jobs', ['processing']),
  };
}

function getPlatformActivityCounts() {
  return platformActivityCountsFromDatabase(ensureStorage());
}

function acquirePlatformMaintenance(kind, owner, ttlMs = 120000) {
  const normalizedKind = String(kind || '').trim();
  const normalizedOwner = String(owner || '').trim();
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(normalizedKind)) throw statusError('Invalid maintenance kind', 400);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(normalizedOwner)) throw statusError('Invalid maintenance owner', 400);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 30000 || ttlMs > 600000) {
    throw statusError('Maintenance TTL must be between 30000 and 600000 milliseconds', 400);
  }
  const db = ensureStorage();
  return db.transaction(() => {
    const now = nowIso();
    const existing = platformMaintenanceFromDatabase(db, now);
    if (existing) throw statusError(`Platform maintenance is already active: ${existing.kind}`, 409);
    const activity = platformActivityCountsFromDatabase(db);
    if (Object.values(activity).some((count) => count > 0)) {
      const summary = Object.entries(activity).map(([key, count]) => `${key}=${count}`).join(', ');
      const error = statusError(`Platform activity prevents maintenance: ${summary}`, 409);
      error.activityCounts = activity;
      throw error;
    }
    const value = {
      kind: normalizedKind,
      owner: normalizedOwner,
      startedAt: now,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    db.prepare(`
      INSERT INTO metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(PLATFORM_MAINTENANCE_KEY, JSON.stringify(value));
    return value;
  }).immediate();
}

function renewPlatformMaintenance(owner, ttlMs = 120000) {
  const normalizedOwner = String(owner || '').trim();
  const db = ensureStorage();
  return db.transaction(() => {
    const current = platformMaintenanceFromDatabase(db);
    if (!current || current.owner !== normalizedOwner) return null;
    const renewed = { ...current, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    db.prepare('UPDATE metadata SET value=? WHERE key=?')
      .run(JSON.stringify(renewed), PLATFORM_MAINTENANCE_KEY);
    return renewed;
  }).immediate();
}

function releasePlatformMaintenance(owner) {
  const normalizedOwner = String(owner || '').trim();
  const db = ensureStorage();
  return db.transaction(() => {
    const row = db.prepare('SELECT value FROM metadata WHERE key=?').get(PLATFORM_MAINTENANCE_KEY);
    const current = row ? parseJson(row.value, null) : null;
    if (!current || String(current.owner || '') !== normalizedOwner) return false;
    return db.prepare('DELETE FROM metadata WHERE key=?').run(PLATFORM_MAINTENANCE_KEY).changes === 1;
  }).immediate();
}

function seedExamples() {
  ensureStorage();
}

module.exports = {
  ACTIVE_STATUSES,
  SESSION_STATUSES,
  TASK_RETENTION_DAYS,
  ensureStorage,
  seedExamples,
  refreshSourceSkills,
  listManagedSkills,
  listSkills,
  listSkillSummaries,
  countSkills,
  getSkill,
  saveSkill,
  setSkillEnabled,
  importSkillArchive,
  deleteSkill,
  listSessions,
  sessionStats,
  countExecutingSessions,
  checkStateInvariants,
  listActiveProcessIdentities,
  getSession,
  saveSession,
  updateSession,
  deleteSession,
  taskRetentionStatus,
  performTaskRetentionCleanup,
  claimBridgeCleanupJobs,
  processBridgeCleanupJob,
  bridgeCleanupStatus,
  listBridgeRuntimeInventory,
  requestBridgeSessionReclaim,
  appendSessionWorklog,
  listSessionWorklogs,
  publishSkillReport,
  archiveSkillReportArtifacts,
  claimSkillReportArtifactJobs,
  processSkillReportArtifactJob,
  redactSkillReportArtifacts,
  redactHistoricalSkillReports,
  openSkillReportArtifactFile,
  openSkillReportArtifactResourceFile,
  listSkillReports,
  appendSessionLatestLog,
  readSessionLatestLog,
  appendAuditEvent,
  appendAuditEventUnlessMaintenance,
  appendAuditEvents,
  appendAuditEventsIdempotent,
  listAudit,
  countAuditEvents,
  createTurn,
  beginSessionTurn,
  finishTurn,
  listTurns,
  listAttempts,
  listTaskSteps,
  prepareSessionBridgeOutputFile,
  prepareAttemptOutputFiles,
  getAttemptOutput,
  getAttemptOutputFile,
  listExternalAttempts,
  getExternalAttempt,
  getExternalAttemptLogFile,
  openExternalAttemptLogFile,
  openExternalAttemptArtifactFile,
  openExternalAttemptArtifactResourceFile,
  externalArchiveIntegrityStatus,
  listScheduledJobs,
  createAttempt,
  updateAttempt,
  registerAttemptProcess,
  prepareSessionRetry,
  recordCommandExecution,
  appendRuntimeWorklog,
  listCommandExecutions,
  setCommandExecutionSkills,
  getSessionSkillUsage,
  parseDeclaredSkillIds,
  registerExternalAttempt,
  repairPlaceholderExternalAttemptDetections,
  detectExternalAttemptsForTurn,
  reconcileExternalAttempts,
  reconcileRunningExternalAttempts,
  claimExternalAttemptArchives,
  processExternalAttemptArchive,
  claimExternalArchiveVerifications,
  processExternalArchiveVerification,
  claimDueScheduledJobs,
  dispatchClaimedScheduledJob,
  createAndQueueSession,
  queueSessionRun,
  claimPendingCommands,
  finishCommand,
  finishClaimedCommand,
  deferClaimedCommand,
  failClaimedCommand,
  acquireTaskLease,
  renewTaskLease,
  releaseTaskLease,
  requestSessionStop,
  completeSession,
  resetSession,
  restoreCompletedSession,
  recoverExpiredTasks,
  ensureTaskSkillSnapshot,
  hasActiveSessions,
  exportConfigBundle,
  importConfigBundle,
  setMetadata,
  getMetadata,
  getPlatformMaintenance,
  getPlatformActivityCounts,
  acquirePlatformMaintenance,
  renewPlatformMaintenance,
  releasePlatformMaintenance,
  statusError,
  canonicalTaskId,
  canonicalManagedSkillId,
  finalizeSessionTurn,
};
