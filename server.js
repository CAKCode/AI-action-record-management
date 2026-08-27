process.umask(0o077);

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');
const {
  PUBLIC_DIR,
} = require('./src/paths');
const {
  ACTIVE_STATUSES,
  SESSION_STATUSES,
  ensureStorage,
  seedExamples,
  listSkillSummaries,
  countSkills,
  getSkill,
  saveSkill,
  setSkillEnabled,
  importSkillArchive,
  deleteSkill,
  listSessions,
  sessionStats,
  getSession,
  saveSession,
  deleteSession,
  createAndQueueSession,
  queueSessionRun,
  requestSessionStop,
  completeSession,
  resetSession,
  restoreCompletedSession,
  listTurns,
  listAttempts,
  listTaskSteps,
  getAttemptOutput,
  listExternalAttempts,
  getExternalAttempt,
  openExternalAttemptLogFile,
  openExternalAttemptArtifactFile,
  openExternalAttemptArtifactResourceFile,
  externalArchiveIntegrityStatus,
  listScheduledJobs,
  listCommandExecutions,
  setCommandExecutionSkills,
  getSessionSkillUsage,
  listSkillReports,
  openSkillReportArtifactFile,
  openSkillReportArtifactResourceFile,
  listSessionWorklogs,
  appendSessionWorklog,
  readSessionLatestLog,
  exportConfigBundle,
  importConfigBundle,
  appendAuditEvent,
  appendAuditEventUnlessMaintenance,
  appendAuditEventsIdempotent,
  listAudit,
  countAuditEvents,
  checkStateInvariants,
  bridgeCleanupStatus,
  taskRetentionStatus,
  listBridgeRuntimeInventory,
  requestBridgeSessionReclaim,
  getPlatformMaintenance,
  canonicalTaskId,
  canonicalManagedSkillId,
} = require('./src/store');
const { MAX_ARCHIVE_BYTES, parseSkillArchive } = require('./src/skill-archive');
const {
  syncBridgeRuntime,
  getRuntimeStatus,
  webSupervisorStatus,
} = require('./src/orchestrator');
const { resolveWorkingDir } = require('./src/workspaces');
const { startWorker, stopWorker } = require('./src/worker-supervisor');
const { checkDatabaseIntegrity, closeDatabase } = require('./src/database');
const {
  listDatabaseBackups,
  createDatabaseBackup,
  verifyDatabaseBackup,
  databaseBackupStatus,
  startDatabaseBackupScheduler,
  stopDatabaseBackupScheduler,
  cancelDatabaseBackup,
  waitForDatabaseBackup,
} = require('./src/database-backup');
const {
  listRecoveryCheckpoints,
  createRecoveryCheckpoint,
  verifyRecoveryCheckpoint,
  recoveryCheckpointStatus,
  startRecoveryCheckpointScheduler,
  stopRecoveryCheckpointScheduler,
  waitForRecoveryCheckpoint,
} = require('./src/recovery-checkpoint');
const { createStorageAuditRecorder } = require('./src/storage-audit');
const { createStorageAuditOutbox } = require('./src/storage-audit-outbox');
const { storageFailureAuditPayload } = require('./src/storage-failure');
const { pipeResponseStream } = require('./src/response-stream');
const { createCodexTerminalManager } = require('./src/codex-terminal');
const { createInteractiveCliTranscriptStore } = require('./src/interactive-cli-transcript');
const { resolveBridgeSessionRuntime } = require('./src/bridge-runtime-cleanup');
const { createReleaseInfo } = require('./src/release-info');
const {
  TASK_FIELD_LIMITS,
  assertStringLength,
  validateTaskBody,
  validateSkillBody,
} = require('./src/validation');

const PORT = Number(process.env.PORT || 8091);
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_USER = process.env.CODEX_DESK_AUTH_USER || '';
const AUTH_PASSWORD = process.env.CODEX_DESK_AUTH_PASSWORD || '';
const AUTH_SESSION_COOKIE = 'codex_task_session';
const AUTH_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const AUTH_SESSION_SECRET = AUTH_USER && AUTH_PASSWORD
  ? crypto.createHash('sha256').update(`${AUTH_USER}\0${AUTH_PASSWORD}`).digest()
  : null;
const REPORT_RESOURCE_ACCESS_PARAM = 'codex_report_resource_access';
const OPERATOR_ACTOR = AUTH_USER ? `user:${AUTH_USER}` : 'operator';
const API_MAX_CONCURRENCY = Number(process.env.CODEX_API_MAX_CONCURRENCY ?? 64);
const API_IDLE_TIMEOUT_MS = Number(process.env.CODEX_API_IDLE_TIMEOUT_MS ?? 30000);
const LOG_STREAM_MAX_CONCURRENCY = Number(process.env.CODEX_LOG_STREAM_MAX_CONCURRENCY ?? 8);
const LOG_STREAM_IDLE_TIMEOUT_MS = Number(process.env.CODEX_LOG_STREAM_IDLE_TIMEOUT_MS ?? 60000);
const ATTEMPT_OUTPUT_MAX_CHUNK_BYTES = 1024 * 1024;
const ATTEMPT_OUTPUT_SOCKET_CHUNK_BYTES = 256 * 1024;
const ATTEMPT_OUTPUT_SOCKET_POLL_MS = 250;
const ATTEMPT_OUTPUT_SOCKET_MAX_BUFFERED_BYTES = 1024 * 1024;
const ATTEMPT_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const API_RESPONSE_IDLE_GUARD = Symbol('apiResponseIdleGuard');
let shuttingDown = false;
let activeApiRequests = 0;
let apiRequestRejectedCount = 0;
let apiRequestIdleTimeoutCount = 0;
let activeLogStreams = 0;
let logStreamIdleTimeoutCount = 0;
let lastBackupDeferralAuditReason = '';
let lastRecoveryDeferralAuditReason = '';
let storageAuditRetryTimer = null;
let webSupervisorWatchTimer = null;
let storageAudit = null;
const RELEASE_INFO = createReleaseInfo();

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

if (Boolean(AUTH_USER) !== Boolean(AUTH_PASSWORD)) {
  throw new Error('CODEX_DESK_AUTH_USER and CODEX_DESK_AUTH_PASSWORD must be configured together');
}

if (!Number.isInteger(API_MAX_CONCURRENCY) || API_MAX_CONCURRENCY < 1 || API_MAX_CONCURRENCY > 256) {
  throw new Error('CODEX_API_MAX_CONCURRENCY must be an integer between 1 and 256');
}

if (!Number.isInteger(API_IDLE_TIMEOUT_MS)
  || API_IDLE_TIMEOUT_MS < 1000 || API_IDLE_TIMEOUT_MS > 3600000) {
  throw new Error('CODEX_API_IDLE_TIMEOUT_MS must be an integer between 1000 and 3600000');
}

if (!Number.isInteger(LOG_STREAM_MAX_CONCURRENCY)
  || LOG_STREAM_MAX_CONCURRENCY < 1 || LOG_STREAM_MAX_CONCURRENCY > 64) {
  throw new Error('CODEX_LOG_STREAM_MAX_CONCURRENCY must be an integer between 1 and 64');
}

if (!Number.isInteger(LOG_STREAM_IDLE_TIMEOUT_MS)
  || LOG_STREAM_IDLE_TIMEOUT_MS < 1000 || LOG_STREAM_IDLE_TIMEOUT_MS > 3600000) {
  throw new Error('CODEX_LOG_STREAM_IDLE_TIMEOUT_MS must be an integer between 1000 and 3600000');
}

if (!LOOPBACK_HOSTS.has(HOST) && (!AUTH_USER || !AUTH_PASSWORD)) {
  throw new Error('Remote listening requires CODEX_DESK_AUTH_USER and CODEX_DESK_AUTH_PASSWORD');
}

ensureStorage();
seedExamples();
storageAudit = createStorageAuditRecorder(appendAuditEventsIdempotent, {
  outbox: createStorageAuditOutbox(),
  onError(error, details) {
    console.error(`[storage-audit:${details.category}] ${error.stack || error.message}`);
  },
});
try {
  syncBridgeRuntime();
} catch (error) {
  console.error(`[codex-ops] runtime initialization degraded: ${error.message}`);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttc': 'font/collection',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function json(res, payload, statusCode = 200) {
  const body = JSON.stringify(payload);
  armApiResponseIdleTimeout(res);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function text(res, payload, statusCode = 200) {
  armApiResponseIdleTimeout(res);
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function apiRequestStatus(options = {}) {
  const active = Math.max(0, activeApiRequests - (options.excludeCurrent ? 1 : 0));
  return {
    active,
    maxConcurrency: API_MAX_CONCURRENCY,
    saturated: active >= API_MAX_CONCURRENCY,
    rejectedCount: apiRequestRejectedCount,
    idleTimeoutMs: API_IDLE_TIMEOUT_MS,
    idleTimeoutCount: apiRequestIdleTimeoutCount,
  };
}

function acquireApiRequestSlot(res, options = {}) {
  if (activeApiRequests >= API_MAX_CONCURRENCY) {
    apiRequestRejectedCount += 1;
    throw Object.assign(new Error('API request concurrency limit reached'), {
      statusCode: 429,
      retryAfterSeconds: 1,
      expected: true,
    });
  }
  activeApiRequests += 1;
  let released = false;
  let handlerFinished = false;
  let responseFinished = false;
  let responseIdleTimeoutArmed = false;
  const onIdleTimeout = () => {
    if (released || res.destroyed || res.writableEnded) return;
    apiRequestIdleTimeoutCount += 1;
    res.destroy();
  };
  const release = () => {
    if (released || !handlerFinished || !responseFinished) return;
    released = true;
    res.off('finish', finishResponse);
    res.off('close', finishResponse);
    res.off('timeout', onIdleTimeout);
    delete res[API_RESPONSE_IDLE_GUARD];
    activeApiRequests -= 1;
  };
  const finishResponse = () => {
    responseFinished = true;
    release();
  };
  res.once('finish', finishResponse);
  res.once('close', finishResponse);
  if (res.destroyed || res.writableFinished) finishResponse();
  res[API_RESPONSE_IDLE_GUARD] = () => {
    if (options.responseIdleTimeout === false || responseIdleTimeoutArmed || released) return;
    responseIdleTimeoutArmed = true;
    res.setTimeout(API_IDLE_TIMEOUT_MS);
    res.once('timeout', onIdleTimeout);
  };
  return () => {
    handlerFinished = true;
    release();
  };
}

function armApiResponseIdleTimeout(res) {
  res[API_RESPONSE_IDLE_GUARD]?.();
}

function apiRequestBodyIdleTimeout(req, reject) {
  let timer = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const refresh = () => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      apiRequestIdleTimeoutCount += 1;
      reject(Object.assign(new Error('API request body made no progress before its idle timeout'), {
        statusCode: 408,
        expected: true,
        closeConnection: true,
      }));
      req.resume();
    }, API_IDLE_TIMEOUT_MS);
    timer.unref();
  };
  refresh();
  return { clear, refresh };
}

function isDiagnosticApiRequest(method, pathname) {
  return method === 'GET' && (pathname === '/api/health' || pathname === '/api/ready');
}

function isLogDownloadRequest(method, pathname) {
  if (method !== 'GET') return false;
  return /^\/api\/sessions\/[^/]+\/attempts\/[^/]+\/(?:stdout|stderr)$/.test(pathname)
    || /^\/api\/sessions\/[^/]+\/external-attempts\/[^/]+\/log$/.test(pathname);
}

function logStreamStatus() {
  return {
    active: activeLogStreams,
    maxConcurrency: LOG_STREAM_MAX_CONCURRENCY,
    saturated: activeLogStreams >= LOG_STREAM_MAX_CONCURRENCY,
    idleTimeoutMs: LOG_STREAM_IDLE_TIMEOUT_MS,
    idleTimeoutCount: logStreamIdleTimeoutCount,
  };
}

function acquireLogStreamSlot() {
  if (activeLogStreams >= LOG_STREAM_MAX_CONCURRENCY) {
    throw Object.assign(new Error('Log download concurrency limit reached'), {
      statusCode: 429,
      retryAfterSeconds: 1,
      expected: true,
    });
  }
  activeLogStreams += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeLogStreams -= 1;
  };
}

function pipeLogResponseStream(res, stream) {
  return pipeResponseStream(res, stream, {
    idleTimeoutMs: LOG_STREAM_IDLE_TIMEOUT_MS,
    onIdleTimeout: () => {
      logStreamIdleTimeoutCount += 1;
    },
  });
}

async function streamExactTextFile(res, filePath, options = {}) {
  let fd;
  try {
    if (res.destroyed || res.writableEnded) return;
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(new Error('Tracked log is not a regular file'), { statusCode: 409 });
    const requestedOffset = options.offset == null ? 0 : options.offset;
    const start = Math.min(requestedOffset, stat.size);
    const availableBytes = stat.size - start;
    const bytes = options.limit == null ? availableBytes : Math.min(options.limit, availableBytes);
    const nextOffset = start + bytes;
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': bytes,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(options.incremental ? {
        'X-Log-Offset': start,
        'X-Log-Next-Offset': nextOffset,
        'X-Log-File-Size': stat.size,
        'X-Attempt-Status': options.status || '',
      } : {}),
    });
    if (bytes === 0) {
      fs.closeSync(fd);
      fd = null;
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath, {
      fd,
      autoClose: true,
      start,
      end: nextOffset - 1,
    });
    fd = null;
    await pipeLogResponseStream(res, stream);
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function parseAttemptOutputWindow(url) {
  const hasOffset = url.searchParams.has('offset');
  const hasLimit = url.searchParams.has('limit');
  if (!hasOffset && !hasLimit) return null;
  const offsetValue = hasOffset ? url.searchParams.get('offset') : '0';
  const limitValue = hasLimit ? url.searchParams.get('limit') : String(ATTEMPT_OUTPUT_MAX_CHUNK_BYTES);
  if (!/^\d+$/.test(offsetValue || '') || !/^\d+$/.test(limitValue || '')) {
    throw Object.assign(new Error('offset and limit must be non-negative integers'), {
      statusCode: 400,
      expected: true,
    });
  }
  const offset = Number(offsetValue);
  const limit = Number(limitValue);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit) || limit < 1
    || limit > ATTEMPT_OUTPUT_MAX_CHUNK_BYTES) {
    throw Object.assign(new Error(`offset must be a safe integer and limit must be between 1 and ${ATTEMPT_OUTPUT_MAX_CHUNK_BYTES}`), {
      statusCode: 400,
      expected: true,
    });
  }
  return { offset, limit };
}

async function streamExactTextHandle(res, opened, options = {}) {
  let handle = opened.fileHandle;
  try {
    if (res.destroyed || res.writableEnded) return;
    const requestedOffset = options.offset == null ? 0 : options.offset;
    const start = Math.min(requestedOffset, opened.bytes);
    const availableBytes = opened.bytes - start;
    const bytes = options.limit == null ? availableBytes : Math.min(options.limit, availableBytes);
    const nextOffset = start + bytes;
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': bytes,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(options.incremental ? {
        'X-Log-Offset': start,
        'X-Log-Next-Offset': nextOffset,
        'X-Log-File-Size': opened.bytes,
        'X-Attempt-Status': options.status || '',
      } : {}),
    });
    if (bytes === 0) {
      await handle.close();
      handle = null;
      res.end();
      return;
    }
    const stream = handle.createReadStream({
      autoClose: true,
      start,
      end: nextOffset - 1,
    });
    handle = null;
    await pipeLogResponseStream(res, stream);
  } finally {
    if (handle) await handle.close();
  }
}

function artifactByteRange(value, bytes) {
  const header = String(value || '').trim();
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || bytes === 0) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffixBytes = Number(match[2]);
    if (!Number.isSafeInteger(suffixBytes) || suffixBytes < 1) return false;
    start = Math.max(0, bytes - suffixBytes);
    end = bytes - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : bytes - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start >= bytes || end < start) return false;
    end = Math.min(end, bytes - 1);
  }
  return { start, end, bytes: end - start + 1 };
}

function inlineFileName(value) {
  return String(value || 'artifact').replace(/[^\x20-\x7e]|["\\]/g, '_');
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodeExternalArtifactResourcePath(relativePath) {
  const value = String(relativePath || '');
  const segments = value.split('/');
  return segments.includes('..')
    ? encodeURIComponent(value)
    : segments.map(encodeURIComponent).join('/');
}

function externalArtifactManifestReferenceUrl(resourceScope, manifestPath, reference) {
  const raw = String(reference || '').trim();
  if (!raw || /^(?:#|\/|\/\/|data:|[A-Za-z][A-Za-z0-9+.-]*:)/i.test(raw)) return null;
  const suffixMatch = /([?#].*)$/.exec(raw);
  const pathReference = suffixMatch ? raw.slice(0, suffixMatch.index) : raw;
  let decodedReference;
  try {
    // `%0Nd` is DASH's formatting syntax, not URL escaping.
    const protectedReference = pathReference.replace(/%0(\d+)d/gi, '%250$1d');
    decodedReference = decodeURIComponent(protectedReference);
  } catch {
    return null;
  }
  const normalizedPath = path.posix.normalize(
    path.posix.join(path.posix.dirname(String(manifestPath || '')), decodedReference),
  );
  if (!normalizedPath || normalizedPath === '.') return null;
  return `${resourceScope}/${encodeExternalArtifactResourcePath(normalizedPath)}${suffixMatch?.[1] || ''}`;
}

function rewriteExternalArtifactManifest(content, resourceScope, manifestPath, mediaType) {
  const rewrite = (reference) => externalArtifactManifestReferenceUrl(
    resourceScope,
    manifestPath,
    reference,
  ) || reference;
  let transformed = String(content || '');
  if (mediaType === 'application/vnd.apple.mpegurl') {
    transformed = transformed.replace(
      /(\bURI\s*=\s*["'])([^"']+)(["'])/gi,
      (_, prefix, reference, suffix) => `${prefix}${rewrite(reference)}${suffix}`,
    );
    transformed = transformed.split(/(\r?\n)/).map((line) => {
      if (/^\r?\n$/.test(line) || /^\s*#/.test(line) || !line.trim()) return line;
      const match = /^(\s*)(\S+)(\s*)$/.exec(line);
      return match ? `${match[1]}${rewrite(match[2])}${match[3]}` : line;
    }).join('');
    return transformed;
  }
  transformed = transformed.replace(
    /(\b(?:media|initialization|sourceURL|href)\s*=\s*["'])([^"']+)(["'])/gi,
    (_, prefix, reference, suffix) => `${prefix}${rewrite(reference)}${suffix}`,
  );
  return transformed.replace(
    /(<BaseURL\b[^>]*>)([^<]+)(<\/BaseURL\s*>)/gi,
    (_, prefix, reference, suffix) => `${prefix}${rewrite(reference)}${suffix}`,
  );
}

async function withSignedArtifactResourceUrls(opened, resourceScope) {
  const rewritableMediaTypes = new Set([
    'text/html; charset=utf-8',
    'application/vnd.apple.mpegurl',
    'application/dash+xml',
  ]);
  if (!AUTH_USER || !AUTH_PASSWORD || !resourceScope
    || !rewritableMediaTypes.has(opened.mediaType)) return opened;

  let content = opened.content;
  let handle = opened.fileHandle;
  try {
    if (!Buffer.isBuffer(content)) {
      content = Buffer.allocUnsafe(opened.bytes);
      let offset = 0;
      while (offset < content.length) {
        const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
        if (!bytesRead) throw new Error('Managed report artifact ended before its verified size');
        offset += bytesRead;
      }
    }
  } finally {
    if (handle) await handle.close();
  }

  let transformedContent = content.toString('utf8');
  if (opened.resourcePath && ['application/vnd.apple.mpegurl', 'application/dash+xml']
    .includes(opened.mediaType)) {
    transformedContent = rewriteExternalArtifactManifest(
      transformedContent,
      resourceScope,
      opened.resourcePath,
      opened.mediaType,
    );
  }
  const resourcePattern = new RegExp(
    `${escapeRegularExpression(resourceScope)}/([^\\s"'\\\\<>&?#]+)`,
    'g',
  );
  const transformed = transformedContent.replace(resourcePattern, (resourcePath) => (
    `${resourcePath}?${REPORT_RESOURCE_ACCESS_PARAM}=${reportResourceAccessToken(resourcePath)}`
  ));
  const responseContent = Buffer.from(transformed, 'utf8');
  return {
    ...opened,
    fileHandle: null,
    content: responseContent,
    bytes: responseContent.length,
  };
}

async function streamSkillReportArtifactHandle(res, opened, options = {}) {
  let handle = opened.fileHandle;
  try {
    if (res.destroyed || res.writableEnded) return;
    const range = options.range || null;
    writeSkillReportArtifactHeaders(res, opened, { range, mediaResource: options.mediaResource });
    const responseBytes = range ? range.bytes : opened.bytes;
    if (opened.content) {
      res.end(range
        ? opened.content.subarray(range.start, range.end + 1)
        : opened.content);
      return;
    }
    if (responseBytes === 0) {
      await handle.close();
      handle = null;
      res.end();
      return;
    }
    const stream = handle.createReadStream({
      autoClose: true,
      start: range ? range.start : 0,
      end: range ? range.end : opened.bytes - 1,
    });
    handle = null;
    await pipeLogResponseStream(res, stream);
  } finally {
    if (handle) await handle.close();
  }
}

function writeSkillReportArtifactHeaders(res, opened, options = {}) {
  const range = options.range || null;
  const headers = {
    'Content-Type': opened.mediaType,
    'Content-Length': range ? range.bytes : opened.bytes,
    'Content-Disposition': `inline; filename="${inlineFileName(opened.fileName)}"`,
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  if (options.mediaResource) {
    // Sandboxed reports have an opaque origin, so SAMEORIGIN blocks their managed resources.
    res.removeHeader('X-Frame-Options');
    headers['Accept-Ranges'] = 'bytes';
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Content-Security-Policy'] = "default-src 'none'";
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${opened.bytes}`;
  }
  if (opened.mediaType === 'text/html; charset=utf-8') {
    headers['Content-Security-Policy'] = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; frame-src http: https: data:; media-src 'self' blob:; connect-src 'self'";
  }
  res.writeHead(range ? 206 : 200, headers);
}

async function headSkillReportArtifactHandle(res, opened, options = {}) {
  try {
    if (res.destroyed || res.writableEnded) return;
    writeSkillReportArtifactHeaders(res, opened, options);
    res.end();
  } finally {
    await opened.fileHandle?.close();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let idleTimeout = null;
    const rejectBody = (error) => {
      if (settled) return;
      settled = true;
      idleTimeout?.clear();
      reject(error);
    };
    const declaredLength = Number(req.headers['content-length'] || 0);
    const hasDeclaredBody = declaredLength > 0 || Boolean(req.headers['transfer-encoding']);
    if (Number.isFinite(declaredLength) && declaredLength > 1024 * 1024) {
      rejectBody(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
      req.resume();
      return;
    }
    if (hasDeclaredBody && !String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      rejectBody(Object.assign(new Error('JSON requests require Content-Type: application/json'), { statusCode: 415 }));
      req.resume();
      return;
    }
    idleTimeout = apiRequestBodyIdleTimeout(req, rejectBody);
    req.once('aborted', () => {
      rejectBody(Object.assign(new Error('API request body was aborted by the client'), {
        statusCode: 400,
        expected: true,
        closeConnection: true,
      }));
    });
    req.once('error', (error) => {
      rejectBody(Object.assign(new Error(`API request body failed: ${error.message}`), {
        statusCode: 400,
        expected: true,
        closeConnection: true,
      }));
    });
    req.on('data', (chunk) => {
      if (settled) return;
      idleTimeout.refresh();
      size += chunk.length;
      if (size > 1024 * 1024) {
        rejectBody(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      idleTimeout?.clear();
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      idleTimeout.clear();
      reject(error);
    });
    req.on('aborted', () => {
      if (settled) return;
      settled = true;
      idleTimeout.clear();
      reject(Object.assign(new Error('Request body was aborted'), { statusCode: 400 }));
    });
  });
}

function readBinaryBody(req, maxBytes = MAX_ARCHIVE_BYTES) {
  return new Promise((resolve, reject) => {
    const allowedTypes = new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']);
    const contentType = String(req.headers['content-type'] || '').toLowerCase().split(';', 1)[0].trim();
    const declaredLength = Number(req.headers['content-length'] || 0);
    if (!allowedTypes.has(contentType)) {
      reject(Object.assign(new Error('Skill import requires a ZIP request body'), { statusCode: 415 }));
      req.resume();
      return;
    }
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      reject(Object.assign(new Error('Skill ZIP exceeds the 8 MiB limit'), { statusCode: 413 }));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const idleTimeout = apiRequestBodyIdleTimeout(req, (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    req.on('data', (chunk) => {
      if (settled) return;
      idleTimeout.refresh();
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        idleTimeout.clear();
        reject(Object.assign(new Error('Skill ZIP exceeds the 8 MiB limit'), { statusCode: 413 }));
        req.resume();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      idleTimeout.clear();
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      idleTimeout.clear();
      reject(error);
    });
    req.on('aborted', () => {
      if (settled) return;
      settled = true;
      idleTimeout.clear();
      reject(Object.assign(new Error('Request body was aborted'), { statusCode: 400 }));
    });
  });
}

function routeParams(pattern, pathname) {
  const match = pathname.match(pattern);
  if (!match) return null;
  try {
    return match.slice(1).map(decodeURIComponent);
  } catch {
    throw Object.assign(new Error('Malformed URL encoding'), { statusCode: 400 });
  }
}

function terminalOperationContext(req, requestContext) {
  const suppliedIdempotencyKey = String(req.headers['idempotency-key'] || '').trim();
  const idempotencyKey = suppliedIdempotencyKey || String(requestContext.requestId || '').trim();
  const expectedTaskCreatedAt = String(req.headers['x-task-created-at'] || '').trim();
  assertStringLength('idempotency-key header', idempotencyKey, TASK_FIELD_LIMITS.idempotencyKey);
  assertStringLength('x-task-created-at header', expectedTaskCreatedAt, 128);
  if (expectedTaskCreatedAt && !Number.isFinite(Date.parse(expectedTaskCreatedAt))) {
    throw Object.assign(new Error('x-task-created-at must be an ISO timestamp'), { statusCode: 400 });
  }
  return { ...requestContext, idempotencyKey, expectedTaskCreatedAt };
}

function acceptsIdempotentReplayDuringMaintenance(req, pathname) {
  if (req.method === 'POST' && pathname === '/api/sessions/start') return true;
  if (req.method === 'POST'
    && /^\/api\/sessions\/[^/]+\/(?:run|stop|complete|restore|reset)$/.test(pathname)) return true;
  return req.method === 'DELETE' && /^\/api\/sessions\/[^/]+$/.test(pathname);
}

function secureEqual(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left || '')).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function requestCookie(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return '';
}

function createAuthSessionValue(now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    user: AUTH_USER,
    expiresAt: now + AUTH_SESSION_TTL_MS,
    nonce: crypto.randomBytes(18).toString('base64url'),
  }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function readAuthSession(value, now = Date.now()) {
  if (!AUTH_SESSION_SECRET) return null;
  const parts = String(value || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = crypto.createHmac('sha256', AUTH_SESSION_SECRET)
    .update(parts[0])
    .digest('base64url');
  if (!secureEqual(parts[1], expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.user !== AUTH_USER
    || !Number.isSafeInteger(payload.expiresAt)
    || payload.expiresAt <= now) return null;
  return payload;
}

function authSessionFromRequest(req) {
  return readAuthSession(requestCookie(req, AUTH_SESSION_COOKIE));
}

function setAuthSessionCookie(res, value, maxAgeSeconds) {
  res.setHeader(
    'Set-Cookie',
    `${AUTH_SESSION_COOKIE}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; SameSite=Strict`,
  );
}

function issueAuthSession(res) {
  if (!AUTH_SESSION_SECRET) return '';
  const expiresAt = Date.now() + AUTH_SESSION_TTL_MS;
  setAuthSessionCookie(res, createAuthSessionValue(), Math.floor(AUTH_SESSION_TTL_MS / 1000));
  return new Date(expiresAt).toISOString();
}

function clearAuthSession(res) {
  setAuthSessionCookie(res, '', 0);
}

function artifactResourceScope(pathname) {
  const value = String(pathname || '');
  return [
    /^\/api\/sessions\/[^/]+\/skill-reports\/[^/]+\/artifacts\/[^/]+\/resources(?=\/|$)/,
    /^\/api\/sessions\/[^/]+\/external-attempts\/[^/]+\/artifacts\/[^/]+\/resources(?=\/|$)/,
  ].map((pattern) => pattern.exec(value)?.[0] || '').find(Boolean) || '';
}

function reportResourceAccessToken(scope) {
  return crypto.createHmac('sha256', `${AUTH_USER}\0${AUTH_PASSWORD}`)
    .update(scope)
    .digest('base64url');
}

function artifactResourceAccessValid(req, pathname, searchParams) {
  const scope = artifactResourceScope(pathname);
  if (!scope || !['GET', 'HEAD'].includes(req.method)
    || !pathname.startsWith(`${scope}/`)
    || !pathname.slice(scope.length + 1)) return false;
  const supplied = searchParams?.get(REPORT_RESOURCE_ACCESS_PARAM) || '';
  return Boolean(supplied) && secureEqual(supplied, reportResourceAccessToken(pathname));
}

function requestCredentialsValid(req, pathname = '', searchParams = null) {
  if (!AUTH_USER && !AUTH_PASSWORD) return true;
  const value = String(req.headers.authorization || '');
  if (value.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
    } catch {}
    const separator = decoded.indexOf(':');
    const user = separator === -1 ? decoded : decoded.slice(0, separator);
    const password = separator === -1 ? '' : decoded.slice(separator + 1);
    if (secureEqual(user, AUTH_USER) && secureEqual(password, AUTH_PASSWORD)) return true;
  }
  if (authSessionFromRequest(req)) return true;
  return artifactResourceAccessValid(req, pathname, searchParams);
}

function authorize(req, res, pathname, searchParams) {
  if (requestCredentialsValid(req, pathname, searchParams)) return true;
  const hasCredentials = String(req.headers.authorization || '').startsWith('Basic ');
  if (!hasCredentials) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Codex Task Sessions", charset="UTF-8"');
    json(res, { error: 'Authentication required' }, 401);
  } else {
    res.setHeader('WWW-Authenticate', 'Basic realm="Codex Task Sessions", charset="UTF-8"');
    json(res, { error: 'Invalid credentials' }, 401);
  }
  return false;
}

function sameOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function summarizeDashboard(taskLimit = 100) {
  const skillsMounted = countSkills();
  const stats = sessionStats();
  const sessions = listSessions({ limit: taskLimit, internal: true });
  const activeSessions = sessions.filter((session) => ACTIVE_STATUSES.includes(session.status));
  return {
    stats: {
      ...stats,
      skills: skillsMounted,
      operations: countAuditEvents(),
    },
    runtime: getRuntimeStatus(skillsMounted),
    apiRequests: apiRequestStatus({ excludeCurrent: true }),
    logStreams: logStreamStatus(),
    sessions,
    activeSessions,
    taskPage: { limit: sessions.length, total: stats.sessions, hasMore: sessions.length < stats.sessions },
    recentAudit: listAudit({ limit: 30, includePayload: false }),
  };
}

function serveStatic(req, res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, target));
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    json(res, { error: 'Forbidden' }, 403);
    return;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const publicRoot = fs.realpathSync(PUBLIC_DIR);
    const realFilePath = fs.realpathSync(filePath);
    const realRelative = path.relative(publicRoot, realFilePath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      json(res, { error: 'Forbidden' }, 403);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(realFilePath);
    pipeResponseStream(res, stream);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(path.join(PUBLIC_DIR, 'index.html'));
  pipeResponseStream(res, stream);
}

function assertEditableSession(session) {
  if (session.status === 'completed') throw Object.assign(new Error('Completed sessions are immutable history records'), { statusCode: 409 });
  if (ACTIVE_STATUSES.includes(session.status)) throw Object.assign(new Error('Active sessions cannot be edited'), { statusCode: 409 });
}

function requireSessionId(input) {
  const id = canonicalTaskId(input);
  if (!getSession(id)) throw Object.assign(new Error(`Session ${id} not found`), { statusCode: 404 });
  return id;
}

function serviceHealthSnapshot() {
  const storage = checkDatabaseIntegrity();
  const state = checkStateInvariants();
  const runtime = getRuntimeStatus();
  const backups = databaseBackupPublicStatus();
  const recoveryCheckpoints = recoveryCheckpointPublicStatus();
  const bridgeCleanup = bridgeCleanupStatus();
  const taskRetention = taskRetentionStatus();
  const externalLogArchives = externalArchiveIntegrityStatus();
  const ok = storage.ok && state.ok && externalLogArchives.ok;
  return {
    statusCode: ok ? 200 : 503,
    readinessStatusCode: ok && runtime.ready ? 200 : 503,
    payload: {
      ok,
      ready: ok && runtime.ready,
      release: RELEASE_INFO,
      runtime,
      storage,
      state,
      bridgeCleanup,
      taskRetention,
      externalLogArchives,
      apiRequests: apiRequestStatus(),
      logStreams: logStreamStatus(),
      backups,
      recoveryCheckpoints,
    },
  };
}

function databaseBackupPublicStatus() {
  return { ...databaseBackupStatus(), ...storageAudit.status('database_backup') };
}

function recoveryCheckpointPublicStatus() {
  return { ...recoveryCheckpointStatus(), ...storageAudit.status('recovery_checkpoint') };
}

function recordStorageAudit(category, events, publicMessage) {
  return storageAudit.record(category, events, { publicMessage });
}

function databaseBackupCreatedEvent(backup, context = {}) {
  return {
    scope: 'storage', entityType: 'database_backup', entityId: backup.id,
    kind: 'database.backup.created',
    message: context.message || 'Created and verified an online database backup.',
    actor: context.actor || 'system', requestId: context.requestId || '',
    payload: {
      id: backup.id,
      createdAt: backup.createdAt,
      completedAt: backup.completedAt,
      sizeBytes: backup.database.sizeBytes,
      sha256: backup.database.sha256,
      removedBackupIds: backup.removedBackupIds,
    },
  };
}

function auditRecoveryCheckpointCreated(checkpoint, context = {}) {
  const actor = context.actor || 'system';
  const requestId = context.requestId || '';
  const scheduled = Boolean(context.scheduled);
  const sourceBackup = listDatabaseBackups()
    .find((backup) => backup.status === 'available' && backup.id === checkpoint.database.backupId);
  const events = [];
  if (sourceBackup) {
    events.push({
      scope: 'storage', entityType: 'database_backup', entityId: sourceBackup.id,
      kind: 'database.backup.created',
      message: scheduled
        ? 'Created a verified database backup for a scheduled recovery checkpoint.'
        : 'Created a verified database backup for a recovery checkpoint.',
      actor, requestId,
      payload: {
        id: sourceBackup.id,
        sizeBytes: sourceBackup.database.sizeBytes,
        sha256: sourceBackup.database.sha256,
        recoveryCheckpointId: checkpoint.id,
      },
    });
  }
  events.push({
    scope: 'storage', entityType: 'recovery_checkpoint', entityId: checkpoint.id,
    kind: 'recovery.checkpoint.created',
    message: scheduled
      ? 'Created and verified a scheduled platform recovery checkpoint.'
      : 'Created and verified a platform recovery checkpoint.',
    actor, requestId,
    payload: {
      id: checkpoint.id,
      scheduled,
      createdAt: checkpoint.createdAt,
      completedAt: checkpoint.completedAt,
      databaseSizeBytes: checkpoint.database.sizeBytes,
      archiveSizeBytes: checkpoint.archive.sizeBytes,
      archiveSha256: checkpoint.archive.sha256,
      sourceFileCount: checkpoint.source.fileCount,
      sourceTotalBytes: checkpoint.source.totalBytes,
      removedCheckpointIds: checkpoint.removedCheckpointIds,
      sensitive: true,
    },
  });
  if (checkpoint.maintenanceReleaseUnconfirmed) {
    events.push({
      scope: 'storage', entityType: 'recovery_checkpoint', entityId: checkpoint.id,
      kind: 'recovery.checkpoint.maintenance_release_unconfirmed', level: 'warn',
      message: 'Recovery checkpoint was published, but maintenance release could not be confirmed.',
      actor, requestId,
      payload: {
        id: checkpoint.id,
        scheduled,
        maintenanceLeaseExpiresAt: checkpoint.maintenanceLeaseExpiresAt,
      },
    });
  }
  return recordStorageAudit(
    'recovery_checkpoint',
    events,
    'Recovery checkpoint audit persistence failed',
  );
}

const attemptOutputWebSocketServer = new WebSocketServer({
  noServer: true,
  clientTracking: true,
  maxPayload: 1024,
  perMessageDeflate: false,
});

const codexTerminalWebSocketServer = new WebSocketServer({
  noServer: true,
  clientTracking: true,
  maxPayload: 64 * 1024,
  perMessageDeflate: false,
});

const interactiveCliTranscripts = createInteractiveCliTranscriptStore();

const codexTerminalManager = createCodexTerminalManager({
  getTask: getSession,
  activeStatuses: ACTIVE_STATUSES,
  transcripts: interactiveCliTranscripts,
  appendWorklog: appendSessionWorklog,
  onError(error) {
    console.error(`[codex-terminal] ${error.stack || error.message}`);
  },
});

function assertInteractiveTerminalIdle(taskId, operation) {
  if (!codexTerminalManager.isRunning(taskId)) return;
  throw Object.assign(new Error(
    `This task has an active Codex CLI. Open the Codex CLI tab, select End CLI, then try ${operation} the task again.`,
  ), {
    statusCode: 409,
    expected: true,
    clientCode: 'interactive_codex_cli_active',
    operation,
  });
}

function rejectWebSocketUpgrade(socket, statusCode, message, headers = {}) {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const reason = http.STATUS_CODES[statusCode] || 'Error';
  const body = `${message}\n`;
  const responseHeaders = {
    Connection: 'close',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  };
  const headerLines = Object.entries(responseHeaders).map(([name, value]) => `${name}: ${value}`);
  socket.end(`HTTP/1.1 ${statusCode} ${reason}\r\n${headerLines.join('\r\n')}\r\n\r\n${body}`);
}

function webSocketOriginAllowed(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readAttemptOutputChunk(filePath, requestedOffset) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(new Error('Tracked log is not a regular file'), { statusCode: 409 });
    const offset = requestedOffset > stat.size ? 0 : requestedOffset;
    const bytesToRead = Math.min(ATTEMPT_OUTPUT_SOCKET_CHUNK_BYTES, stat.size - offset);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    let bytesRead = 0;
    while (bytesRead < bytesToRead) {
      const count = fs.readSync(fd, buffer, bytesRead, bytesToRead - bytesRead, offset + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return {
      offset,
      fileSize: stat.size,
      bytes: bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
    };
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function sendAttemptOutputControl(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

function streamAttemptOutputWebSocket(ws, context) {
  let offset = context.offset;
  let timer = null;
  let closed = false;
  let pumping = false;
  let lastStatus = '';
  let lastFileSize = -1;
  let terminalStablePolls = 0;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    context.releaseLogStream();
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    release();
  };
  const schedule = (pump, delay = ATTEMPT_OUTPUT_SOCKET_POLL_MS) => {
    clearTimeout(timer);
    timer = setTimeout(pump, delay);
  };
  const fail = (error) => {
    if (closed) return;
    sendAttemptOutputControl(ws, { type: 'error', message: error.message || 'Attempt output stream failed' });
    ws.close(1011, 'Attempt output stream failed');
    cleanup();
  };
  const pump = () => {
    if (closed || pumping || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > ATTEMPT_OUTPUT_SOCKET_MAX_BUFFERED_BYTES) {
      schedule(pump);
      return;
    }
    pumping = true;
    try {
      const output = getAttemptOutput(context.taskId, context.attemptId, context.stream);
      if (!output) throw Object.assign(new Error('Attempt output not found'), { statusCode: 404 });
      const chunk = readAttemptOutputChunk(output.filePath, offset);
      if (chunk.offset < offset) {
        offset = chunk.offset;
        terminalStablePolls = 0;
        sendAttemptOutputControl(ws, {
          type: 'reset', offset, fileSize: chunk.fileSize, status: output.status,
        });
      }
      if (lastStatus === '') {
        sendAttemptOutputControl(ws, {
          type: 'ready', offset, fileSize: chunk.fileSize, status: output.status,
        });
      } else if (output.status !== lastStatus || chunk.fileSize !== lastFileSize) {
        sendAttemptOutputControl(ws, {
          type: 'status', offset, fileSize: chunk.fileSize, status: output.status,
        });
      }
      lastStatus = output.status;
      lastFileSize = chunk.fileSize;
      if (chunk.bytes.length > 0) {
        offset += chunk.bytes.length;
        terminalStablePolls = 0;
        ws.send(chunk.bytes, { binary: true }, (error) => {
          if (error) fail(error);
        });
        pumping = false;
        schedule(pump, 0);
        return;
      }
      if (ATTEMPT_TERMINAL_STATUSES.has(output.status)) {
        terminalStablePolls += 1;
        if (terminalStablePolls >= 2) {
          sendAttemptOutputControl(ws, {
            type: 'end', offset, fileSize: chunk.fileSize, status: output.status,
          });
          ws.close(1000, 'Attempt completed');
          cleanup();
          return;
        }
      } else {
        terminalStablePolls = 0;
      }
      pumping = false;
      schedule(pump);
    } catch (error) {
      pumping = false;
      fail(error);
    }
  };

  ws.once('close', cleanup);
  ws.once('error', cleanup);
  ws.on('message', () => ws.close(1008, 'Read-only output stream'));
  pump();
}

function streamExternalAttemptOutputWebSocket(ws, context) {
  let offset = context.offset;
  let timer = null;
  let closed = false;
  let pumping = false;
  let fileHandle = null;
  let lastStatus = '';
  let lastFileSize = -1;
  let terminalStablePolls = 0;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    context.releaseLogStream();
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    const handle = fileHandle;
    fileHandle = null;
    handle?.close().catch(() => {});
    release();
  };
  const schedule = (pump, delay = ATTEMPT_OUTPUT_SOCKET_POLL_MS) => {
    clearTimeout(timer);
    timer = setTimeout(pump, delay);
  };
  const fail = (error) => {
    if (closed) return;
    sendAttemptOutputControl(ws, { type: 'error', message: error.message || 'Task output stream failed' });
    ws.close(1011, 'Task output stream failed');
    cleanup();
  };
  const pump = async () => {
    if (closed || pumping || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > ATTEMPT_OUTPUT_SOCKET_MAX_BUFFERED_BYTES) {
      schedule(pump);
      return;
    }
    pumping = true;
    try {
      const attempt = getExternalAttempt(context.taskId, context.attemptId);
      if (!attempt) throw Object.assign(new Error('Background task output not found'), { statusCode: 404 });
      const stat = await fileHandle.stat();
      if (!stat.isFile()) throw Object.assign(new Error('Tracked log is not a regular file'), { statusCode: 409 });
      const fileSize = stat.size;
      if (offset > fileSize) {
        offset = 0;
        terminalStablePolls = 0;
        sendAttemptOutputControl(ws, { type: 'reset', offset, fileSize, status: attempt.status });
      }
      if (lastStatus === '') {
        sendAttemptOutputControl(ws, { type: 'ready', offset, fileSize, status: attempt.status });
      } else if (attempt.status !== lastStatus || fileSize !== lastFileSize) {
        sendAttemptOutputControl(ws, { type: 'status', offset, fileSize, status: attempt.status });
      }
      lastStatus = attempt.status;
      lastFileSize = fileSize;
      const bytesToRead = Math.min(ATTEMPT_OUTPUT_SOCKET_CHUNK_BYTES, fileSize - offset);
      if (bytesToRead > 0) {
        const buffer = Buffer.allocUnsafe(bytesToRead);
        const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, offset);
        if (bytesRead > 0) {
          offset += bytesRead;
          terminalStablePolls = 0;
          ws.send(buffer.subarray(0, bytesRead), { binary: true }, (error) => {
            if (error) fail(error);
          });
          pumping = false;
          schedule(pump, 0);
          return;
        }
      }
      if (['succeeded', 'failed', 'lost', 'cancelled'].includes(attempt.status)) {
        terminalStablePolls += 1;
        if (terminalStablePolls >= 2) {
          sendAttemptOutputControl(ws, { type: 'end', offset, fileSize, status: attempt.status });
          ws.close(1000, 'Background task completed');
          cleanup();
          return;
        }
      } else {
        terminalStablePolls = 0;
      }
      pumping = false;
      schedule(pump);
    } catch (error) {
      pumping = false;
      fail(error);
    }
  };

  ws.once('close', cleanup);
  ws.once('error', cleanup);
  ws.on('message', () => ws.close(1008, 'Read-only output stream'));
  openExternalAttemptLogFile(context.taskId, context.attemptId)
    .then((opened) => {
      if (!opened) throw Object.assign(new Error('Tracked log is not available'), { statusCode: 404 });
      if (closed) {
        opened.fileHandle.close().catch(() => {});
        return;
      }
      fileHandle = opened.fileHandle;
      pump();
    })
    .catch(fail);
}

const server = http.createServer(async (req, res) => {
  const suppliedRequestId = String(req.headers['x-request-id'] || '')
    .replace(/[\u0000-\u001f\u007f]/g, '-')
    .trim()
    .slice(0, 128);
  const requestId = suppliedRequestId || crypto.randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'");
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    json(res, { error: 'Malformed request URL' }, 400);
    return;
  }
  const pathname = url.pathname;
  const isApiRoute = pathname.startsWith('/api/');
  const isAuthSessionProbe = pathname === '/api/auth/session' && req.method === 'GET';
  if (isApiRoute && !isAuthSessionProbe && !authorize(req, res, pathname, url.searchParams)) return;
  if (isApiRoute && !sameOrigin(req)) {
    json(res, { error: 'Cross-origin write requests are forbidden' }, 403);
    return;
  }
  if (shuttingDown) {
    res.setHeader('Connection', 'close');
    json(res, { error: 'Service is shutting down' }, 503);
    return;
  }
  let finishApiRequest = null;
  try {
    const requestContext = { actor: OPERATOR_ACTOR, requestId };
    if (pathname.startsWith('/api/') && !isDiagnosticApiRequest(req.method, pathname)) {
      finishApiRequest = acquireApiRequestSlot(res, {
        responseIdleTimeout: !isLogDownloadRequest(req.method, pathname),
      });
    }
    const maintenance = getPlatformMaintenance();
    if (maintenance && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && pathname !== '/api/recovery-checkpoints'
      && pathname !== '/api/auth/session'
      && !acceptsIdempotentReplayDuringMaintenance(req, pathname)) {
      const remainingSeconds = Math.max(1, Math.ceil((Date.parse(maintenance.expiresAt) - Date.now()) / 1000));
      res.setHeader('Retry-After', String(remainingSeconds));
      json(res, {
        error: `Platform maintenance is active: ${maintenance.kind}`,
        maintenance: {
          kind: maintenance.kind,
          startedAt: maintenance.startedAt,
          expiresAt: maintenance.expiresAt,
        },
      }, 503);
      return;
    }
    if (pathname === '/api/auth/session') {
      if (req.method === 'POST') {
        const expiresAt = issueAuthSession(res);
        json(res, expiresAt ? { ok: true, expiresAt } : { ok: true });
        return;
      }
      if (req.method === 'DELETE') {
        clearAuthSession(res);
        json(res, { ok: true });
        return;
      }
      if (req.method === 'GET') {
        json(res, { ok: Boolean(authSessionFromRequest(req)) });
        return;
      }
      res.setHeader('Allow', 'GET, POST, DELETE');
      json(res, { error: 'Method not allowed' }, 405);
      return;
    }
    if (pathname === '/api/health' && req.method === 'GET') {
      const health = serviceHealthSnapshot();
      json(res, health.payload, health.statusCode);
      return;
    }
    if (pathname === '/api/ready' && req.method === 'GET') {
      const health = serviceHealthSnapshot();
      json(res, health.payload, health.readinessStatusCode);
      return;
    }
    if (pathname === '/api/backups' && req.method === 'GET') {
      json(res, {
        status: databaseBackupPublicStatus(),
        backups: listDatabaseBackups(),
      });
      return;
    }
    if (pathname === '/api/recovery-checkpoints' && req.method === 'GET') {
      json(res, {
        status: recoveryCheckpointPublicStatus(),
        checkpoints: listRecoveryCheckpoints(),
      });
      return;
    }
    if (pathname === '/api/recovery-checkpoints' && req.method === 'POST') {
      let checkpoint;
      try {
        checkpoint = await createRecoveryCheckpoint();
      } catch (error) {
        recordStorageAudit('recovery_checkpoint', [{
            scope: 'storage', entityType: 'recovery_checkpoint', entityId: 'manual',
            kind: 'recovery.checkpoint.failed', level: 'error',
            message: 'Recovery checkpoint creation failed.', actor: OPERATOR_ACTOR, requestId,
            payload: storageFailureAuditPayload(error, 'CHECKPOINT_FAILED'),
        }], 'Recovery checkpoint failure audit persistence failed');
        throw error;
      }
      const auditRecorded = auditRecoveryCheckpointCreated(checkpoint, { actor: OPERATOR_ACTOR, requestId });
      json(res, { ok: true, checkpoint, auditRecorded }, 201);
      return;
    }
    {
      const params = routeParams(/^\/api\/recovery-checkpoints\/([^/]+)\/verify$/, pathname);
      if (params && req.method === 'POST') {
        const verification = await verifyRecoveryCheckpoint(params[0]);
        const auditRecorded = recordStorageAudit('recovery_checkpoint', [{
          scope: 'storage', entityType: 'recovery_checkpoint', entityId: verification.id,
          kind: verification.ok ? 'recovery.checkpoint.verified' : 'recovery.checkpoint.verification_failed',
          level: verification.ok ? 'info' : 'error',
          message: verification.ok
            ? 'Verified a platform recovery checkpoint.'
            : 'Recovery checkpoint verification failed.',
          actor: OPERATOR_ACTOR, requestId,
          payload: verification,
        }], 'Recovery checkpoint verification audit persistence failed');
        json(res, { ...verification, auditRecorded });
        return;
      }
    }
    if (pathname === '/api/backups' && req.method === 'POST') {
      let backup;
      try {
        backup = await createDatabaseBackup();
      } catch (error) {
        recordStorageAudit('database_backup', [{
            scope: 'storage', entityType: 'database_backup', entityId: 'manual',
            kind: 'database.backup.failed', level: 'error',
            message: 'Manual database backup failed.', actor: OPERATOR_ACTOR, requestId,
            payload: storageFailureAuditPayload(error, 'BACKUP_FAILED'),
        }], 'Database backup failure audit persistence failed');
        throw error;
      }
      const auditRecorded = recordStorageAudit('database_backup', [databaseBackupCreatedEvent(backup, {
        actor: OPERATOR_ACTOR, requestId,
      })], 'Database backup audit persistence failed');
      json(res, { ok: true, backup, auditRecorded }, 201);
      return;
    }
    {
      const params = routeParams(/^\/api\/backups\/([^/]+)\/verify$/, pathname);
      if (params && req.method === 'POST') {
        const verification = await verifyDatabaseBackup(params[0]);
        const auditRecorded = recordStorageAudit('database_backup', [{
          scope: 'storage', entityType: 'database_backup', entityId: verification.id,
          kind: verification.ok ? 'database.backup.verified' : 'database.backup.verification_failed',
          level: verification.ok ? 'info' : 'error',
          message: verification.ok
            ? 'Verified an online database backup.'
            : 'Database backup verification failed.',
          actor: OPERATOR_ACTOR, requestId,
          payload: verification,
        }], 'Database backup verification audit persistence failed');
        json(res, { ...verification, auditRecorded });
        return;
      }
    }
    if (pathname === '/api/dashboard' && req.method === 'GET') {
      json(res, summarizeDashboard(Number(url.searchParams.get('taskLimit') || 100)));
      return;
    }
    if (pathname === '/api/runtime/sync' && req.method === 'POST') {
      const status = syncBridgeRuntime();
      appendAuditEventUnlessMaintenance({
        scope: 'runtime', kind: 'runtime.synced', message: 'Synchronized task runtime status.',
        payload: status, actor: OPERATOR_ACTOR, requestId,
      });
      json(res, { ok: true, status });
      return;
    }
    if (pathname === '/api/runtime/bridge-sessions' && req.method === 'GET') {
      json(res, listBridgeRuntimeInventory());
      return;
    }
    {
      const params = routeParams(/^\/api\/runtime\/bridge-sessions\/([^/]+)\/reclaim$/, pathname);
      if (params && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || typeof body.confirmationSessionId !== 'string'
          || Object.keys(body).some((key) => key !== 'confirmationSessionId')) {
          throw Object.assign(new Error('Body must contain only confirmationSessionId'), { statusCode: 400 });
        }
        assertStringLength('confirmationSessionId', body.confirmationSessionId, 64);
        const job = requestBridgeSessionReclaim(
          params[0],
          body.confirmationSessionId,
          requestContext,
        );
        json(res, { ok: true, job }, job.status === 'completed' ? 200 : 202);
        return;
      }
    }
    if (pathname === '/api/export' && req.method === 'GET') {
      const bundle = exportConfigBundle();
      appendAuditEventUnlessMaintenance({
        scope: 'config', entityType: 'bundle', entityId: 'config',
        kind: 'bundle.exported', message: 'Exported portable configuration bundle.',
        actor: OPERATOR_ACTOR, requestId,
        payload: { format: bundle.format, version: bundle.version, counts: { skills: bundle.skills.length, sessions: bundle.sessions.length } },
      });
      json(res, bundle);
      return;
    }
    if (pathname === '/api/import' && req.method === 'POST') {
      const body = await readBody(req);
      const result = importConfigBundle(body.bundle || body, body.mode || 'merge', requestContext);
      let runtimeSync = null;
      try {
        runtimeSync = { ok: true, status: syncBridgeRuntime() };
      } catch (error) {
        runtimeSync = { ok: false, error: 'Runtime synchronization failed after the configuration was imported' };
        console.error(`[request:${requestId}] runtime sync after import failed: ${error.stack || error.message}`);
        try {
          appendAuditEventUnlessMaintenance({
            scope: 'runtime', kind: 'runtime.sync.failed', level: 'error',
            message: runtimeSync.error, actor: OPERATOR_ACTOR, requestId,
          });
        } catch (auditError) {
          console.error(`[request:${requestId}] runtime sync failure audit was not recorded: ${auditError.message}`);
        }
      }
      json(res, { ok: true, result, runtimeSync });
      return;
    }

    if (pathname === '/api/skills' && req.method === 'GET') {
      json(res, listSkillSummaries());
      return;
    }
    if (pathname === '/api/skills/import' && req.method === 'POST') {
      const archive = await readBinaryBody(req);
      const parsed = await parseSkillArchive(archive);
      const imported = importSkillArchive(parsed, {
        overwrite: url.searchParams.get('overwrite') === 'true',
      }, requestContext);
      json(res, {
        ok: true,
        count: imported.length,
        skills: imported.map((skill) => ({
          id: skill.id,
          name: skill.name,
          version: skill.version,
          fileCount: skill.fileCount,
        })),
      }, 201);
      return;
    }
    if (pathname === '/api/skills' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id || !body.name) {
        json(res, { error: 'id and name are required' }, 400);
        return;
      }
      validateSkillBody(body);
      canonicalManagedSkillId(body.id);
      json(res, saveSkill(body.id, body, { ...requestContext, createOnly: true }), 201);
      return;
    }
    {
      const params = routeParams(/^\/api\/skills\/([^/]+)$/, pathname);
      if (params) {
        const [id] = params;
        if (req.method === 'GET') {
          const skill = getSkill(id);
          json(res, skill || { error: 'Not found' }, skill ? 200 : 404);
          return;
        }
        if (req.method === 'PUT') {
          const existing = getSkill(id);
          if (!existing) {
            json(res, { error: 'Not found' }, 404);
            return;
          }
          const body = await readBody(req);
          validateSkillBody(body, { creating: false, requireId: false });
          json(res, saveSkill(id, body, requestContext));
          return;
        }
        if (req.method === 'DELETE') {
          const deleted = deleteSkill(id, requestContext);
          json(res, { ok: deleted }, deleted ? 200 : 404);
          return;
        }
      }
    }
    {
      const params = routeParams(/^\/api\/skills\/([^/]+)\/enabled$/, pathname);
      if (params && req.method === 'PATCH') {
        const body = await readBody(req);
        json(res, setSkillEnabled(params[0], body.enabled, requestContext));
        return;
      }
    }

    if (pathname === '/api/sessions' && req.method === 'GET') {
      const statusFilter = url.searchParams.get('status') || '';
      const statuses = [...new Set(statusFilter.split(',').map((item) => item.trim()).filter(Boolean))];
      if (statuses.some((status) => !SESSION_STATUSES.includes(status))) {
        throw Object.assign(new Error('status contains an unsupported task state'), { statusCode: 400 });
      }
      json(res, listSessions({
        limit: Number(url.searchParams.get('limit') || 100),
        offset: Number(url.searchParams.get('offset') || 0),
        statuses,
      }));
      return;
    }
    if (pathname === '/api/sessions/start' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || (body.idempotencyKey != null && typeof body.idempotencyKey !== 'string')) {
        throw Object.assign(new Error('Create-and-run body must be a JSON object with a string idempotencyKey'), { statusCode: 400 });
      }
      const { idempotencyKey, ...taskBody } = body;
      if (!taskBody.id || !String(taskBody.name || '').trim() || !String(taskBody.objective || '').trim()) {
        json(res, { error: 'id, name and objective are required' }, 400);
        return;
      }
      validateTaskBody(taskBody);
      assertStringLength('idempotencyKey', idempotencyKey, TASK_FIELD_LIMITS.idempotencyKey);
      assertStringLength('idempotency-key header', req.headers['idempotency-key'], TASK_FIELD_LIMITS.idempotencyKey);
      const taskId = canonicalTaskId(taskBody.id);
      const existing = getSession(taskId);
      if (existing) assertInteractiveTerminalIdle(taskId, 'running');
      if (!existing) resolveWorkingDir(taskBody.workingDir || '.');
      const runtime = getRuntimeStatus();
      const maintenanceOnly = Boolean(maintenance)
        && runtime.degradedReasons.length === 1
        && runtime.degradedReasons[0] === 'platform_maintenance';
      if (!existing && !runtime.ready && !maintenanceOnly) {
        json(res, {
          error: 'Persistent session worker is not ready',
          degradedReasons: runtime.degradedReasons,
        }, 503);
        return;
      }
      const key = req.headers['idempotency-key'] || idempotencyKey || requestId;
      const outcome = createAndQueueSession(
        taskId,
        taskBody,
        taskBody.objective,
        key,
        requestContext,
      );
      json(res, outcome.session, outcome.created ? 202 : 200);
      return;
    }
    if (pathname === '/api/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.id || !String(body.name || '').trim() || !String(body.objective || '').trim()) {
        json(res, { error: 'id, name and objective are required' }, 400);
        return;
      }
      validateTaskBody(body);
      const taskId = canonicalTaskId(body.id);
      if (getSession(taskId)) {
        json(res, { error: `Session ${body.id} already exists` }, 409);
        return;
      }
      resolveWorkingDir(body.workingDir || '.');
      json(res, saveSession(taskId, { ...body, status: 'idle' }, { ...requestContext, createOnly: true }), 201);
      return;
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)$/, pathname);
      if (params) {
        const id = canonicalTaskId(params[0]);
        if (req.method === 'GET') {
          const session = getSession(id);
          json(res, session || { error: 'Not found' }, session ? 200 : 404);
          return;
        }
        if (req.method === 'PUT') {
          const session = getSession(id);
          if (!session) {
            json(res, { error: 'Not found' }, 404);
            return;
          }
          assertEditableSession(session);
          const body = await readBody(req);
          validateTaskBody(body, { creating: false, requireId: false });
          resolveWorkingDir(body.workingDir ?? session.workingDir);
          json(res, saveSession(id, body, requestContext));
          return;
        }
        if (req.method === 'DELETE') {
          assertInteractiveTerminalIdle(id, 'deleting');
          const deleted = deleteSession(id, terminalOperationContext(req, requestContext));
          json(res, { ok: deleted }, deleted ? 200 : 404);
          return;
        }
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/run$/, pathname);
      if (params && req.method === 'POST') {
        const id = canonicalTaskId(params[0]);
        assertInteractiveTerminalIdle(id, 'running');
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || (body.input != null && typeof body.input !== 'string')
          || (body.idempotencyKey != null && typeof body.idempotencyKey !== 'string')) {
          throw Object.assign(new Error('Run body must contain string input and idempotencyKey fields'), { statusCode: 400 });
        }
        assertStringLength('input', body.input, TASK_FIELD_LIMITS.input);
        assertStringLength('idempotencyKey', body.idempotencyKey, TASK_FIELD_LIMITS.idempotencyKey);
        assertStringLength('idempotency-key header', req.headers['idempotency-key'], TASK_FIELD_LIMITS.idempotencyKey);
        const runtime = getRuntimeStatus();
        const maintenanceOnly = Boolean(maintenance)
          && runtime.degradedReasons.length === 1
          && runtime.degradedReasons[0] === 'platform_maintenance';
        const session = queueSessionRun(
          id,
          body.input || '',
          req.headers['idempotency-key'] || body.idempotencyKey || requestId,
          requestContext,
          { allowEnqueue: runtime.ready || maintenanceOnly },
        );
        if (!session) {
          json(res, {
            error: 'Persistent session worker is not ready',
            degradedReasons: runtime.degradedReasons,
          }, 503);
          return;
        }
        json(res, session, 202);
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/stop$/, pathname);
      if (params && req.method === 'POST') {
        const id = canonicalTaskId(params[0]);
        await codexTerminalManager.terminateAndWait(id, 'task_stopped');
        codexTerminalManager.assertTranscriptHealthy(id);
        json(res, {
          ok: requestSessionStop(
            id,
            terminalOperationContext(req, requestContext),
          ),
        });
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/complete$/, pathname);
      if (params && req.method === 'POST') {
        const id = canonicalTaskId(params[0]);
        const session = getSession(id);
        if (session && ['waiting_review', 'waiting_input'].includes(session.status)
          && !session.activeExternalAttempts && !session.activeScheduledJobs) {
          await codexTerminalManager.terminateAndWait(id, 'task_completed');
          codexTerminalManager.assertTranscriptHealthy(id);
          interactiveCliTranscripts.sealUnfinished(id);
          await interactiveCliTranscripts.verify(id);
        }
        json(res, completeSession(
          id,
          terminalOperationContext(req, requestContext),
        ));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/reset$/, pathname);
      if (params && req.method === 'POST') {
        const id = canonicalTaskId(params[0]);
        assertInteractiveTerminalIdle(id, 'resetting');
        json(res, resetSession(
          id,
          terminalOperationContext(req, requestContext),
        ));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/restore$/, pathname);
      if (params && req.method === 'POST') {
        const id = canonicalTaskId(params[0]);
        const session = getSession(id);
        if (!session) {
          json(res, { error: 'Not found' }, 404);
          return;
        }
        if (session.status === 'completed'
          && !resolveBridgeSessionRuntime(session.persistentSessionKey)) {
          throw Object.assign(new Error('The completed task Runtime is no longer available'), {
            statusCode: 409,
            expected: true,
          });
        }
        json(res, restoreCompletedSession(
          id,
          terminalOperationContext(req, requestContext),
        ));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/turns$/, pathname);
      if (params && req.method === 'GET') {
        json(res, listTurns(
          requireSessionId(params[0]),
          Number(url.searchParams.get('limit') || 100),
          Number(url.searchParams.get('offset') || 0),
        ));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/steps$/, pathname);
      if (params && req.method === 'GET') {
        json(res, listTaskSteps(requireSessionId(params[0])));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/attempts$/, pathname);
      if (params && req.method === 'GET') {
        json(res, listAttempts(requireSessionId(params[0]), {
          limit: Number(url.searchParams.get('limit') || 100),
          offset: Number(url.searchParams.get('offset') || 0),
          turnId: url.searchParams.get('turnId') || '',
        }));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/attempts\/([^/]+)\/(stdout|stderr)$/, pathname);
      if (params && req.method === 'GET') {
        const taskId = requireSessionId(params[0]);
        const output = getAttemptOutput(taskId, params[1], params[2]);
        if (!output) {
          json(res, { error: 'Attempt output not found' }, 404);
          return;
        }
        const window = parseAttemptOutputWindow(url);
        const releaseLogStream = acquireLogStreamSlot();
        try {
          await streamExactTextFile(res, output.filePath, window
            ? { ...window, incremental: true, status: output.status }
            : {});
          return;
        } finally {
          releaseLogStream();
        }
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/external-attempts$/, pathname);
      if (params && req.method === 'GET') {
        json(res, listExternalAttempts(requireSessionId(params[0]), {
          limit: Number(url.searchParams.get('limit') || 100),
          offset: Number(url.searchParams.get('offset') || 0),
          status: url.searchParams.get('status') || '',
        }));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/external-attempts\/([^/]+)\/artifacts\/([^/]+)\/resources\/(.+)$/, pathname);
      if (params && ['GET', 'HEAD'].includes(req.method)) {
        const taskId = requireSessionId(params[0]);
        const releaseLogStream = req.method === 'GET' ? acquireLogStreamSlot() : null;
        const readController = new AbortController();
        const abortRead = () => readController.abort();
        req.once('aborted', abortRead);
        res.once('close', abortRead);
        if (req.aborted || res.destroyed) abortRead();
        try {
          let resource = await openExternalAttemptArtifactResourceFile(
            taskId, params[1], params[2], params[3], { signal: readController.signal },
          );
          if (!resource) {
            json(res, { error: 'Registered artifact resource is not available' }, 404);
            return;
          }
          resource = await withSignedArtifactResourceUrls(resource, artifactResourceScope(pathname));
          if (req.method === 'HEAD') await headSkillReportArtifactHandle(res, resource, { mediaResource: true });
          else await streamSkillReportArtifactHandle(res, resource, { mediaResource: true });
          return;
        } finally {
          req.off('aborted', abortRead);
          res.off('close', abortRead);
          releaseLogStream?.();
        }
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/external-attempts\/([^/]+)\/artifacts\/([^/]+)$/, pathname);
      if (params && ['GET', 'HEAD'].includes(req.method)) {
        const taskId = requireSessionId(params[0]);
        const releaseLogStream = req.method === 'GET' ? acquireLogStreamSlot() : null;
        const readController = new AbortController();
        const abortRead = () => readController.abort();
        req.once('aborted', abortRead);
        res.once('close', abortRead);
        if (req.aborted || res.destroyed) abortRead();
        try {
          let artifact = await openExternalAttemptArtifactFile(
            taskId, params[1], params[2], { signal: readController.signal },
          );
          if (!artifact) {
            json(res, { error: 'Registered artifact is not available' }, 404);
            return;
          }
          artifact = await withSignedArtifactResourceUrls(artifact, `${pathname}/resources`);
          if (req.method === 'HEAD') await headSkillReportArtifactHandle(res, artifact);
          else await streamSkillReportArtifactHandle(res, artifact);
          return;
        } finally {
          req.off('aborted', abortRead);
          res.off('close', abortRead);
          releaseLogStream?.();
        }
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/external-attempts\/([^/]+)\/log$/, pathname);
      if (params && req.method === 'GET') {
        const taskId = requireSessionId(params[0]);
        const attempt = getExternalAttempt(taskId, params[1]);
        if (!attempt) {
          json(res, { error: 'Not found' }, 404);
          return;
        }
        const releaseLogStream = acquireLogStreamSlot();
        const readController = new AbortController();
        const abortRead = () => readController.abort();
        req.once('aborted', abortRead);
        res.once('close', abortRead);
        if (req.aborted || res.destroyed) abortRead();
        try {
          const openedLog = await openExternalAttemptLogFile(taskId, attempt.id, {
            signal: readController.signal,
          });
          if (!openedLog) {
            json(res, { error: 'Tracked log is not available' }, 404);
            return;
          }
          const window = parseAttemptOutputWindow(url);
          await streamExactTextHandle(res, openedLog, window
            ? { ...window, incremental: true, status: attempt.status }
            : {});
          return;
        } finally {
          req.off('aborted', abortRead);
          res.off('close', abortRead);
          releaseLogStream();
        }
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/scheduled-jobs$/, pathname);
      if (params && req.method === 'GET') {
        json(res, listScheduledJobs(requireSessionId(params[0]), {
          limit: Number(url.searchParams.get('limit') || 100),
          offset: Number(url.searchParams.get('offset') || 0),
          status: url.searchParams.get('status') || '',
        }));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/executions$/, pathname);
      if (params && req.method === 'GET') {
        json(res, listCommandExecutions(requireSessionId(params[0]), {
          limit: Number(url.searchParams.get('limit') || 100),
          offset: Number(url.searchParams.get('offset') || 0),
          turnId: url.searchParams.get('turnId') || '',
        }));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/executions\/([^/]+)\/skills$/, pathname);
      if (params && req.method === 'PUT') {
        const taskId = requireSessionId(params[0]);
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)
          || !Array.isArray(body.skillIds) || typeof body.reason !== 'string') {
          throw Object.assign(new Error('Body must contain skillIds array and reason string'), { statusCode: 400 });
        }
        json(res, setCommandExecutionSkills(taskId, params[1], body.skillIds, body.reason, requestContext));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/skill-usage$/, pathname);
      if (params && req.method === 'GET') {
        json(res, getSessionSkillUsage(requireSessionId(params[0])));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/skill-reports\/([^/]+)\/artifacts\/([^/]+)\/resources\/([^/]+)$/, pathname);
      if (params && ['GET', 'HEAD'].includes(req.method)) {
        const taskId = requireSessionId(params[0]);
        const releaseLogStream = req.method === 'GET' ? acquireLogStreamSlot() : null;
        const readController = new AbortController();
        const abortRead = () => readController.abort();
        req.once('aborted', abortRead);
        res.once('close', abortRead);
        if (req.aborted || res.destroyed) abortRead();
        try {
          let resource = await openSkillReportArtifactResourceFile(
            taskId,
            params[1],
            params[2],
            params[3],
            { signal: readController.signal },
          );
          if (!resource) {
            json(res, { error: 'Report artifact resource not found' }, 404);
            return;
          }
          resource = await withSignedArtifactResourceUrls(resource, artifactResourceScope(pathname));
          const range = artifactByteRange(req.headers.range, resource.bytes);
          if (range === false) {
            await resource.fileHandle?.close();
            res.writeHead(416, {
              'Content-Range': `bytes */${resource.bytes}`,
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, no-store',
              'X-Content-Type-Options': 'nosniff',
            });
            res.end();
            return;
          }
          if (req.method === 'HEAD') {
            await headSkillReportArtifactHandle(res, resource, { range, mediaResource: true });
          } else {
            await streamSkillReportArtifactHandle(res, resource, { range, mediaResource: true });
          }
          return;
        } finally {
          req.off('aborted', abortRead);
          res.off('close', abortRead);
          releaseLogStream?.();
        }
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/skill-reports\/([^/]+)\/artifacts\/([^/]+)$/, pathname);
      if (params && ['GET', 'HEAD'].includes(req.method)) {
        const taskId = requireSessionId(params[0]);
        if (req.method === 'HEAD') {
          let artifact = await openSkillReportArtifactFile(taskId, params[1], params[2]);
          if (!artifact) {
            json(res, { error: 'Report artifact not found' }, 404);
            return;
          }
          artifact = await withSignedArtifactResourceUrls(artifact, `${pathname}/resources`);
          await headSkillReportArtifactHandle(res, artifact);
          return;
        }
        const releaseLogStream = acquireLogStreamSlot();
        const readController = new AbortController();
        const abortRead = () => readController.abort();
        req.once('aborted', abortRead);
        res.once('close', abortRead);
        if (req.aborted || res.destroyed) abortRead();
        try {
          let artifact = await openSkillReportArtifactFile(taskId, params[1], params[2], {
            signal: readController.signal,
          });
          if (!artifact) {
            json(res, { error: 'Report artifact not found' }, 404);
            return;
          }
          artifact = await withSignedArtifactResourceUrls(artifact, `${pathname}/resources`);
          await streamSkillReportArtifactHandle(res, artifact);
          return;
        } finally {
          req.off('aborted', abortRead);
          res.off('close', abortRead);
          releaseLogStream();
        }
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/skill-reports$/, pathname);
      if (params && req.method === 'GET') {
        json(res, listSkillReports(requireSessionId(params[0]), {
          limit: Number(url.searchParams.get('limit') || 100),
          offset: Number(url.searchParams.get('offset') || 0),
          history: url.searchParams.get('history') === '1',
        }));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/worklogs$/, pathname);
      if (params && req.method === 'GET') {
        json(res, listSessionWorklogs(requireSessionId(params[0]), {
          limit: Number(url.searchParams.get('limit') || 500),
          offset: Number(url.searchParams.get('offset') || 0),
          q: url.searchParams.get('q') || '',
        }));
        return;
      }
    }
    {
      const params = routeParams(/^\/api\/sessions\/([^/]+)\/latest-log$/, pathname);
      if (params && req.method === 'GET') {
        const id = canonicalTaskId(params[0]);
        if (!getSession(id)) {
          json(res, { error: 'Not found' }, 404);
          return;
        }
        text(res, readSessionLatestLog(id) || '');
        return;
      }
    }

    if (pathname === '/api/audit' && req.method === 'GET') {
      json(res, listAudit({
        limit: Number(url.searchParams.get('limit') || 300),
        offset: Number(url.searchParams.get('offset') || 0),
        sessionId: url.searchParams.get('sessionId') || '',
        kind: url.searchParams.get('kind') || '',
        q: url.searchParams.get('q') || '',
      }));
      return;
    }

    if (pathname.startsWith('/api/')) {
      json(res, { error: 'Not found' }, 404);
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      json(res, { error: 'Method not allowed' }, 405);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    if (statusCode >= 500 && !error.expected) {
      console.error(`[request:${requestId}] ${error.stack || error.message}`);
    }
    if (res.destroyed || res.writableEnded) return;
    if (Number.isFinite(Number(error.retryAfterSeconds))) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(Number(error.retryAfterSeconds)))));
    }
    if (error.closeConnection) res.setHeader('Connection', 'close');
    json(res, {
      error: statusCode >= 500 && !error.expose ? 'Unexpected server error' : error.message,
      ...(error.clientCode ? { code: error.clientCode } : {}),
      ...(error.clientCode && error.operation ? { operation: error.operation } : {}),
      ...(error.maintenance ? { maintenance: error.maintenance } : {}),
    }, statusCode);
  } finally {
    finishApiRequest?.();
  }
});

server.on('upgrade', (req, socket, head) => {
  let releaseLogStream = null;
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const attemptParams = routeParams(
      /^\/api\/sessions\/([^/]+)\/attempts\/([^/]+)\/(stdout|stderr)\/live$/,
      url.pathname,
    );
    const externalParams = routeParams(
      /^\/api\/sessions\/([^/]+)\/external-attempts\/([^/]+)\/log\/live$/,
      url.pathname,
    );
    const terminalParams = routeParams(
      /^\/api\/sessions\/([^/]+)\/codex-terminal\/live$/,
      url.pathname,
    );
    if (!attemptParams && !externalParams && !terminalParams) {
      rejectWebSocketUpgrade(socket, 404, 'WebSocket endpoint not found');
      return;
    }
    if (shuttingDown) {
      rejectWebSocketUpgrade(socket, 503, 'Service is shutting down');
      return;
    }
    if (!requestCredentialsValid(req)) {
      rejectWebSocketUpgrade(socket, 401, 'Authentication required', {
        'WWW-Authenticate': 'Basic realm="Codex Task Sessions", charset="UTF-8"',
      });
      return;
    }
    if (!webSocketOriginAllowed(req)) {
      rejectWebSocketUpgrade(socket, 403, 'Cross-origin WebSocket requests are forbidden');
      return;
    }
    if (terminalParams) {
      const taskId = canonicalTaskId(terminalParams[0]);
      if (!getSession(taskId)) {
        rejectWebSocketUpgrade(socket, 404, 'Task not found');
        return;
      }
      const dimensions = Object.fromEntries(['cols', 'rows'].map((name) => {
        const value = url.searchParams.get(name) || '';
        if (value && !/^\d+$/.test(value)) {
          throw Object.assign(new Error(`${name} must be a positive integer`), { statusCode: 400, expected: true });
        }
        return [name, value ? Number(value) : undefined];
      }));
      codexTerminalWebSocketServer.handleUpgrade(req, socket, head, (ws) => {
        try {
          codexTerminalManager.attach(taskId, ws, dimensions);
        } catch (error) {
          sendAttemptOutputControl(ws, { type: 'error', message: error.message || 'Interactive terminal failed' });
          ws.close(Number(error.statusCode) === 503 ? 1013 : 1008, 'Interactive terminal unavailable');
        }
      });
      return;
    }
    const offsetValue = url.searchParams.get('offset') || '0';
    if (!/^\d+$/.test(offsetValue)) {
      rejectWebSocketUpgrade(socket, 400, 'offset must be a non-negative safe integer');
      return;
    }
    const offset = Number(offsetValue);
    if (!Number.isSafeInteger(offset)) {
      rejectWebSocketUpgrade(socket, 400, 'offset must be a non-negative safe integer');
      return;
    }
    const params = attemptParams || externalParams;
    const taskId = canonicalTaskId(params[0]);
    if (!getSession(taskId)) {
      rejectWebSocketUpgrade(socket, 404, 'Task not found');
      return;
    }
    if (attemptParams) {
      if (!getAttemptOutput(taskId, params[1], params[2])) {
        rejectWebSocketUpgrade(socket, 404, 'Attempt output not found');
        return;
      }
    } else if (!getExternalAttempt(taskId, params[1])) {
      rejectWebSocketUpgrade(socket, 404, 'Background task output not found');
      return;
    }
    releaseLogStream = acquireLogStreamSlot();
    attemptOutputWebSocketServer.handleUpgrade(req, socket, head, (ws) => {
      const release = releaseLogStream;
      releaseLogStream = null;
      const context = {
        taskId, attemptId: params[1], offset, releaseLogStream: release,
      };
      if (attemptParams) {
        streamAttemptOutputWebSocket(ws, { ...context, stream: params[2] });
      } else {
        streamExternalAttemptOutputWebSocket(ws, context);
      }
    });
  } catch (error) {
    releaseLogStream?.();
    const statusCode = Number(error.statusCode || 500);
    if (statusCode >= 500 && !error.expected) {
      console.error(`[websocket] ${error.stack || error.message}`);
    }
    rejectWebSocketUpgrade(socket, statusCode, statusCode >= 500 ? 'Unexpected server error' : error.message, {
      ...(Number.isFinite(Number(error.retryAfterSeconds))
        ? { 'Retry-After': String(Math.max(1, Math.ceil(Number(error.retryAfterSeconds)))) }
        : {}),
    });
  }
});

server.on('error', (error) => {
  console.error(`[codex-ops] ${error.stack || error.message}`);
  process.exitCode = 1;
});

server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 1000;
server.on('clientError', (_error, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[codex-ops] listening on http://${HOST}:${PORT}`);
  if (webSupervisorStatus().required) {
    webSupervisorWatchTimer = setInterval(() => {
      if (webSupervisorStatus().processVerified) return;
      clearInterval(webSupervisorWatchTimer);
      webSupervisorWatchTimer = null;
      process.exitCode = 1;
      console.error('[codex-ops] required web supervisor disappeared; shutting down');
      shutdown();
    }, 500);
    webSupervisorWatchTimer.unref();
  }
  startWorker();
  if (!getPlatformMaintenance()) storageAudit.retryAll();
  storageAuditRetryTimer = setInterval(() => {
    if (getPlatformMaintenance()) return;
    storageAudit.retryAll();
  }, 30000);
  storageAuditRetryTimer.unref();
  try {
    startDatabaseBackupScheduler({
      onSuccess(backup) {
        lastBackupDeferralAuditReason = '';
        recordStorageAudit('database_backup', [databaseBackupCreatedEvent(backup, {
          actor: 'system', message: 'Created and verified a scheduled database backup.',
        })], 'Scheduled database backup audit persistence failed');
      },
      onError(error) {
        console.error(`[database-backup] ${error.stack || error.message}`);
        if (getPlatformMaintenance()) return;
        recordStorageAudit('database_backup', [{
          scope: 'storage', entityType: 'database_backup', entityId: 'scheduled',
          kind: 'database.backup.failed', level: 'error',
          message: 'Scheduled database backup failed.', actor: 'system',
          payload: storageFailureAuditPayload(error, 'BACKUP_FAILED'),
        }], 'Scheduled database backup failure audit persistence failed');
      },
      onDeferred(deferral) {
        if (getPlatformMaintenance() || deferral.reason === lastBackupDeferralAuditReason) return;
        lastBackupDeferralAuditReason = deferral.reason;
        recordStorageAudit('database_backup', [{
          scope: 'storage', entityType: 'database_backup', entityId: 'scheduled',
          kind: 'database.backup.deferred', level: 'info',
          message: 'Deferred a scheduled database backup until maintenance completes.',
          actor: 'system',
          payload: { reason: deferral.reason, retryAt: deferral.retryAt },
        }], 'Database backup deferral audit persistence failed');
      },
    });
  } catch (error) {
    console.error(`[database-backup] scheduler initialization failed: ${error.stack || error.message}`);
  }
  try {
    startRecoveryCheckpointScheduler({
      onSuccess(checkpoint) {
        lastRecoveryDeferralAuditReason = '';
        auditRecoveryCheckpointCreated(checkpoint, { actor: 'system', scheduled: true });
      },
      onDeferred(deferral) {
        if (getPlatformMaintenance()) return;
        if (deferral.reason === lastRecoveryDeferralAuditReason) return;
        lastRecoveryDeferralAuditReason = deferral.reason;
        recordStorageAudit('recovery_checkpoint', [{
          scope: 'storage', entityType: 'recovery_checkpoint', entityId: 'scheduled',
          kind: 'recovery.checkpoint.deferred', level: 'info',
          message: 'Deferred a scheduled recovery checkpoint until the platform is idle.',
          actor: 'system',
          payload: {
            reason: deferral.reason,
            retryAt: deferral.retryAt,
            activityCounts: deferral.activityCounts || null,
          },
        }], 'Recovery checkpoint deferral audit persistence failed');
      },
      onError(error) {
        console.error(`[recovery-checkpoint] ${error.stack || error.message}`);
        if (getPlatformMaintenance()) return;
        recordStorageAudit('recovery_checkpoint', [{
          scope: 'storage', entityType: 'recovery_checkpoint', entityId: 'scheduled',
          kind: 'recovery.checkpoint.failed', level: 'error',
          message: 'Scheduled recovery checkpoint failed.', actor: 'system',
          payload: storageFailureAuditPayload(error, 'CHECKPOINT_FAILED'),
        }], 'Scheduled recovery checkpoint failure audit persistence failed');
      },
    });
  } catch (error) {
    console.error(`[recovery-checkpoint] scheduler initialization failed: ${error.stack || error.message}`);
  }
});

async function shutdown() {
  if (shutdown.started) return;
  shutdown.started = true;
  shuttingDown = true;
  if (webSupervisorWatchTimer) clearInterval(webSupervisorWatchTimer);
  webSupervisorWatchTimer = null;
  if (storageAuditRetryTimer) clearInterval(storageAuditRetryTimer);
  storageAuditRetryTimer = null;
  stopDatabaseBackupScheduler();
  cancelDatabaseBackup();
  stopRecoveryCheckpointScheduler();
  for (const client of attemptOutputWebSocketServer.clients) client.terminate();
  attemptOutputWebSocketServer.close();
  codexTerminalManager.shutdown();
  codexTerminalWebSocketServer.close();
  const storageOperationInProgress = databaseBackupStatus().inProgress
    || recoveryCheckpointStatus().inProgress;
  const forceExitTimer = setTimeout(() => process.exit(1), storageOperationInProgress ? 300000 : 8000);
  forceExitTimer.unref();
  const serverClosed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections?.();
  try {
    await stopWorker();
  } catch (error) {
    console.error(`[codex-ops] worker shutdown failed: ${error.message}`);
  }
  try {
    await waitForDatabaseBackup();
  } catch (error) {
    console.error(`[codex-ops] database backup shutdown wait failed: ${error.message}`);
  }
  try {
    await waitForRecoveryCheckpoint();
  } catch (error) {
    console.error(`[codex-ops] recovery checkpoint shutdown wait failed: ${error.message}`);
  }
  await serverClosed;
  closeDatabase();
  clearTimeout(forceExitTimer);
  process.exit(process.exitCode || 0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
