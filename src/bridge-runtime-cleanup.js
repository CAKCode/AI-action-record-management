const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { RUNTIME_DIR } = require('./paths');
const { lstatIfExists, readManagedFile } = require('./managed-storage');

const BRIDGE_BOT_ID = process.env.BRIDGE_BOT_ID || 'codex-task-sessions';
const BRIDGE_RUNTIME_ROOT = path.resolve(
  process.env.BRIDGE_RUNTIME_ROOT || path.join(RUNTIME_DIR, 'bridge-sessions'),
);
const BRIDGE_CHATFILE_ROOT = path.resolve(
  process.env.BRIDGE_CHATFILE_ROOT || path.join(RUNTIME_DIR, 'bridge-chatfiles'),
);
const MAX_SESSION_RECORD_BYTES = 1024 * 1024;
const SESSION_ID_PATTERN = /^session-[a-f0-9]{16}$/;
const SAFE_COMPONENT_PATTERN = /^[A-Za-z0-9._-]+$/;

function cleanupError(message, code = 'UNSAFE_BRIDGE_CLEANUP') {
  return Object.assign(new Error(message), { code });
}

function safeComponent(value, label, maxLength = 256) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength || !SAFE_COMPONENT_PATTERN.test(normalized)) {
    throw cleanupError(`${label} is not a safe Bridge path component`);
  }
  return normalized;
}

function sessionUserId(sessionKey) {
  const normalized = String(sessionKey || '').trim();
  if (!normalized.startsWith('single:')) {
    throw cleanupError('Only platform single-user Bridge Session keys can be reclaimed');
  }
  return safeComponent(normalized.slice('single:'.length), 'Bridge Session user id');
}

function stableBridgeSessionId(sessionKey, sourceDir, botId = BRIDGE_BOT_ID) {
  const normalizedBotId = safeComponent(botId, 'Bridge bot id', 128);
  const normalizedSessionKey = `single:${sessionUserId(sessionKey)}`;
  const normalizedSourceDir = path.resolve(String(sourceDir || ''));
  if (!sourceDir || normalizedSourceDir === path.parse(normalizedSourceDir).root) {
    throw cleanupError('Bridge source directory is required to calculate the Session id');
  }
  const digest = crypto.createHash('sha1')
    .update(`${normalizedBotId}\n${normalizedSessionKey}\n${normalizedSourceDir}\n${normalizedBotId}\nteam`)
    .digest('hex')
    .slice(0, 16);
  return `session-${digest}`;
}

function existingRoot(root, label) {
  const stat = lstatIfExists(root);
  if (!stat) return path.resolve(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw cleanupError(`${label} is not a regular directory`);
  }
  return fs.realpathSync(root);
}

function assertWithinRoot(target, root, label) {
  const relative = path.relative(root, target);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw cleanupError(`${label} escapes its configured Bridge root`);
}

function assertSafePathChain(root, target, expectedKind, label) {
  assertWithinRoot(target, root, label);
  const relative = path.relative(root, target);
  if (!relative) throw cleanupError(`${label} must not be the configured Bridge root`);
  let current = root;
  const segments = relative.split(path.sep);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = lstatIfExists(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw cleanupError(`${label} contains a symbolic link`);
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) throw cleanupError(`${label} has a non-directory ancestor`);
    if (final && expectedKind === 'directory' && !stat.isDirectory()) {
      throw cleanupError(`${label} is not a regular directory`);
    }
    if (final && expectedKind === 'file' && !stat.isFile()) {
      throw cleanupError(`${label} is not a regular file`);
    }
  }
}

function readSessionRecord(recordFile, required = false) {
  const stat = lstatIfExists(recordFile);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw cleanupError('Bridge Session record is not a regular file');
  }
  if (stat.size > MAX_SESSION_RECORD_BYTES) {
    throw cleanupError('Bridge Session record exceeds the safe size limit');
  }
  const raw = readManagedFile(recordFile, {
    encoding: 'utf8',
    label: 'Bridge Session record',
  });
  try {
    const record = JSON.parse(raw);
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('not an object');
    return record;
  } catch {
    if (!required) return null;
    throw cleanupError('Bridge Session record is malformed');
  }
}

function sessionTargets(sessionKey, sessionId, options = {}) {
  const botId = safeComponent(options.botId || BRIDGE_BOT_ID, 'Bridge bot id', 128);
  const userId = sessionUserId(sessionKey);
  const normalizedSessionId = safeComponent(sessionId, 'Bridge Session id', 64);
  if (!SESSION_ID_PATTERN.test(normalizedSessionId)) {
    throw cleanupError('Bridge Session id has an unexpected format');
  }
  const runtimeRoot = existingRoot(options.runtimeRoot || BRIDGE_RUNTIME_ROOT, 'Bridge runtime root');
  const chatfileRoot = existingRoot(options.chatfileRoot || BRIDGE_CHATFILE_ROOT, 'Bridge chatfile root');
  const workspaceRoot = path.join(runtimeRoot, 'workspaces', botId, 'users', userId);
  return {
    botId,
    userId,
    sessionId: normalizedSessionId,
    runtimeRoot,
    chatfileRoot,
    recordFile: path.join(runtimeRoot, 'sessions', `${normalizedSessionId}.json`),
    codexHome: path.join(runtimeRoot, '.bridge-codex-home', 'sessions', normalizedSessionId),
    workspaceRoot,
    workfileDir: path.join(workspaceRoot, 'workfile'),
    skillDir: path.join(workspaceRoot, 'workfile', '.codex', 'skills'),
    chatfileDir: path.join(chatfileRoot, normalizedSessionId),
    workspaceLock: path.join(runtimeRoot, 'locks', `user__${botId}__${userId}.lock`),
    sessionRunLock: path.join(runtimeRoot, 'session-run-locks', `${normalizedSessionId}.lock`),
  };
}

function findSessionRecord(sessionKey, options = {}) {
  const botId = safeComponent(options.botId || BRIDGE_BOT_ID, 'Bridge bot id', 128);
  const runtimeRoot = existingRoot(options.runtimeRoot || BRIDGE_RUNTIME_ROOT, 'Bridge runtime root');
  const registryRoot = path.join(runtimeRoot, 'sessions');
  const registryStat = lstatIfExists(registryRoot);
  if (!registryStat) return null;
  if (!registryStat.isDirectory() || registryStat.isSymbolicLink()) {
    throw cleanupError('Bridge Session registry is not a regular directory');
  }
  const matches = [];
  for (const entry of fs.readdirSync(registryRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    const recordFile = path.join(registryRoot, entry.name);
    let record;
    try {
      record = readSessionRecord(recordFile, false);
    } catch (error) {
      if (options.expectedSessionId && entry.name === `${options.expectedSessionId}.json`) throw error;
      continue;
    }
    if (!record) {
      if (options.expectedSessionId && entry.name === `${options.expectedSessionId}.json`) {
        throw cleanupError('Bridge Session record is malformed');
      }
      continue;
    }
    if (String(record.botId || '') === botId && String(record.chatKey || '') === String(sessionKey || '')) {
      matches.push({ record, recordFile });
    }
  }
  if (matches.length > 1) throw cleanupError('Multiple Bridge Session records match the cleanup job');
  return matches[0] || null;
}

function validateRecord(record, targets, sessionKey) {
  const expected = {
    sessionId: targets.sessionId,
    botId: targets.botId,
    chatKey: String(sessionKey),
    workspaceId: `user:${targets.botId}:${targets.userId}`,
    workspaceScope: 'user',
    workspaceMode: 'team',
    cwdDir: targets.workfileDir,
    skillDir: targets.skillDir,
    chatfileDir: targets.chatfileDir,
    workfileDir: targets.workfileDir,
  };
  for (const [field, value] of Object.entries(expected)) {
    const actual = field.endsWith('Dir') ? path.resolve(String(record[field] || '')) : String(record[field] || '');
    if (actual !== value) throw cleanupError(`Bridge Session record ${field} does not match the cleanup target`);
  }
  if (record.roomfileDir != null && String(record.roomfileDir) !== '') {
    throw cleanupError('Bridge Session record unexpectedly references a room workspace');
  }
}

function removeTreeNoFollow(target) {
  const stat = lstatIfExists(target);
  if (!stat) return false;
  if (stat.isSymbolicLink()) throw cleanupError('Refusing to remove a symbolic-link cleanup target');
  if (!stat.isDirectory()) throw cleanupError('Refusing to recursively remove a non-directory cleanup target');
  fs.chmodSync(target, 0o700);
  for (const entry of fs.readdirSync(target)) {
    const child = path.join(target, entry);
    const childStat = fs.lstatSync(child);
    if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
      removeTreeNoFollow(child);
    } else {
      fs.unlinkSync(child);
    }
  }
  fs.rmdirSync(target);
  return true;
}

function unlinkRegularFile(target) {
  const stat = lstatIfExists(target);
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw cleanupError('Refusing to unlink an unsafe Bridge cleanup target');
  }
  fs.unlinkSync(target);
  return true;
}

function inspectBridgeSessionCleanup(job, options = {}) {
  const sessionKey = String(job.sessionKey || '').trim();
  let expectedSessionId = String(job.sessionId || '').trim();
  if (job.sourceDir) {
    const calculated = stableBridgeSessionId(sessionKey, job.sourceDir, options.botId || BRIDGE_BOT_ID);
    if (expectedSessionId && expectedSessionId !== calculated) {
      throw cleanupError('Stored Bridge Session id does not match its source directory');
    }
    expectedSessionId = calculated;
  }
  const matched = findSessionRecord(sessionKey, { ...options, expectedSessionId });
  if (matched) {
    const recordSessionId = String(matched.record.sessionId || '').trim();
    if (expectedSessionId && recordSessionId !== expectedSessionId) {
      throw cleanupError('Bridge Session record id does not match the cleanup job');
    }
    expectedSessionId = recordSessionId;
  }
  if (!expectedSessionId) {
    throw cleanupError('Bridge Session resources cannot be identified without a record or source directory');
  }
  const targets = sessionTargets(sessionKey, expectedSessionId, options);
  if (matched && path.resolve(matched.recordFile) !== targets.recordFile) {
    throw cleanupError('Bridge Session record filename does not match its Session id');
  }
  if (matched) validateRecord(matched.record, targets, sessionKey);

  for (const [target, root, kind, label] of [
    [targets.workspaceRoot, targets.runtimeRoot, 'directory', 'Bridge workspace'],
    [targets.codexHome, targets.runtimeRoot, 'directory', 'Bridge Codex home'],
    [targets.chatfileDir, targets.chatfileRoot, 'directory', 'Bridge chatfile directory'],
    [targets.workspaceLock, targets.runtimeRoot, 'file', 'Bridge workspace lock'],
    [targets.sessionRunLock, targets.runtimeRoot, 'file', 'Bridge Session run lock'],
    [targets.recordFile, targets.runtimeRoot, 'file', 'Bridge Session record'],
  ]) {
    assertSafePathChain(root, target, kind, label);
  }
  return { targets, recordFound: Boolean(matched) };
}

function resolveBridgeSessionRuntime(sessionKey, options = {}) {
  const normalizedSessionKey = String(sessionKey || '').trim();
  if (!normalizedSessionKey) return null;
  const matched = findSessionRecord(normalizedSessionKey, options);
  if (!matched) return null;
  const sessionId = String(matched.record.sessionId || '').trim();
  const plan = inspectBridgeSessionCleanup({ sessionId, sessionKey: normalizedSessionKey }, options);
  return {
    sessionId,
    sessionKey: normalizedSessionKey,
    threadId: String(matched.record.threadId || '').trim(),
    cwdDir: plan.targets.workfileDir,
    codexHome: plan.targets.codexHome,
    chatfileDir: plan.targets.chatfileDir,
  };
}

function cleanupBridgeSessionResources(job, options = {}) {
  const plan = inspectBridgeSessionCleanup(job, options);
  if (typeof options.onResolved === 'function') options.onResolved(plan.targets.sessionId);
  const removed = [];
  for (const [name, target] of [
    ['workspace', plan.targets.workspaceRoot],
    ['codexHome', plan.targets.codexHome],
    ['chatfile', plan.targets.chatfileDir],
  ]) {
    if (removeTreeNoFollow(target)) removed.push(name);
  }
  for (const [name, target] of [
    ['workspaceLock', plan.targets.workspaceLock],
    ['sessionRunLock', plan.targets.sessionRunLock],
    ['record', plan.targets.recordFile],
  ]) {
    if (unlinkRegularFile(target)) removed.push(name);
  }
  return { sessionId: plan.targets.sessionId, recordFound: plan.recordFound, removed };
}

function entrySizeNoFollow(target) {
  let stat;
  try {
    stat = lstatIfExists(target);
  } catch (error) {
    if (error.code === 'ENOTDIR') return 0;
    throw error;
  }
  if (!stat) return 0;
  if (stat.isSymbolicLink()) return Number(stat.size || 0);
  if (stat.isFile()) return Number(stat.size || 0);
  if (!stat.isDirectory()) return Number(stat.size || 0);
  let total = Number(stat.size || 0);
  let entries;
  try {
    entries = fs.readdirSync(target);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return 0;
    throw error;
  }
  for (const entry of entries) total += entrySizeNoFollow(path.join(target, entry));
  return total;
}

function inventoryInspectionError(error) {
  if (error?.code === 'UNSAFE_BRIDGE_CLEANUP' || error?.code === 'UNSAFE_MANAGED_STORAGE') {
    return String(error.message);
  }
  const code = /^[A-Z0-9_]+$/.test(String(error?.code || '')) ? ` (${error.code})` : '';
  return `Bridge Session record could not be inspected safely${code}`;
}

function listBridgeSessionRecords(options = {}) {
  const botId = safeComponent(options.botId || BRIDGE_BOT_ID, 'Bridge bot id', 128);
  const runtimeRoot = existingRoot(options.runtimeRoot || BRIDGE_RUNTIME_ROOT, 'Bridge runtime root');
  const registryRoot = path.join(runtimeRoot, 'sessions');
  const registryStat = lstatIfExists(registryRoot);
  if (!registryStat) return [];
  if (!registryStat.isDirectory() || registryStat.isSymbolicLink()) {
    throw cleanupError('Bridge Session registry is not a regular directory');
  }
  const records = [];
  for (const entry of fs.readdirSync(registryRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith('.json')) continue;
    const filenameSessionId = entry.name.slice(0, -'.json'.length);
    const recordFile = path.join(registryRoot, entry.name);
    let record;
    try {
      record = readSessionRecord(recordFile, true);
      if (String(record.botId || '') !== botId) continue;
      const sessionId = String(record.sessionId || '').trim();
      const sessionKey = String(record.chatKey || '').trim();
      if (filenameSessionId !== sessionId) {
        throw cleanupError('Bridge Session record filename does not match its Session id');
      }
      const plan = inspectBridgeSessionCleanup({ sessionId, sessionKey }, options);
      const resourceTargets = {
        record: plan.targets.recordFile,
        codexHome: plan.targets.codexHome,
        workspace: plan.targets.workspaceRoot,
        chatfile: plan.targets.chatfileDir,
        workspaceLock: plan.targets.workspaceLock,
        sessionRunLock: plan.targets.sessionRunLock,
      };
      const resources = Object.fromEntries(Object.entries(resourceTargets)
        .map(([name, target]) => [name, lstatIfExists(target) !== null]));
      records.push({
        sessionId,
        sessionKey,
        safe: true,
        error: '',
        createdAtMs: Number(record.createdAt || 0),
        updatedAtMs: Number(record.updatedAt || 0),
        lastRunAtMs: Number(record.lastRunAt || 0),
        resources,
        bytes: Object.values(resourceTargets).reduce((sum, target) => sum + entrySizeNoFollow(target), 0),
      });
    } catch (error) {
      records.push({
        sessionId: SESSION_ID_PATTERN.test(filenameSessionId) ? filenameSessionId : '',
        sessionKey: record && typeof record === 'object' ? String(record.chatKey || '') : '',
        safe: false,
        error: inventoryInspectionError(error),
        createdAtMs: Number(record?.createdAt || 0),
        updatedAtMs: Number(record?.updatedAt || 0),
        lastRunAtMs: Number(record?.lastRunAt || 0),
        resources: { record: true },
        bytes: (() => {
          try { return entrySizeNoFollow(recordFile); } catch { return 0; }
        })(),
      });
    }
  }
  return records.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

function securePrivateTree(root) {
  const stat = lstatIfExists(root);
  if (!stat) return { directories: 0, files: 0, skipped: 0 };
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw cleanupError('Bridge storage root is not a regular directory');
  }
  const counts = { directories: 0, files: 0, skipped: 0 };
  const visit = (directory) => {
    fs.chmodSync(directory, 0o700);
    counts.directories += 1;
    let entries;
    try {
      entries = fs.readdirSync(directory);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry);
      let child;
      try {
        child = fs.lstatSync(absolutePath);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (child.isSymbolicLink()) {
        counts.skipped += 1;
      } else if (child.isDirectory()) {
        visit(absolutePath);
      } else if (child.isFile()) {
        fs.chmodSync(absolutePath, 0o600 | ((child.mode & 0o111) ? 0o100 : 0));
        counts.files += 1;
      } else {
        counts.skipped += 1;
      }
    }
  };
  visit(root);
  return counts;
}

function secureBridgeRuntimeStorage(options = {}) {
  const runtimeRoot = options.runtimeRoot || BRIDGE_RUNTIME_ROOT;
  const chatfileRoot = options.chatfileRoot || BRIDGE_CHATFILE_ROOT;
  return {
    runtime: securePrivateTree(runtimeRoot),
    chatfiles: securePrivateTree(chatfileRoot),
  };
}

module.exports = {
  BRIDGE_BOT_ID,
  BRIDGE_RUNTIME_ROOT,
  BRIDGE_CHATFILE_ROOT,
  stableBridgeSessionId,
  sessionTargets,
  inspectBridgeSessionCleanup,
  resolveBridgeSessionRuntime,
  cleanupBridgeSessionResources,
  listBridgeSessionRecords,
  secureBridgeRuntimeStorage,
};
