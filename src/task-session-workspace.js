const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { digestRegularFile } = require('./external-attempt-archive');
const { TASK_SESSION_ROOT } = require('./paths');

const WORKSPACE_MODES = new Set(['shared', 'session-clone']);
const ARCHIVE_MODES = new Set(['managed-copy', 'in-place']);
const ARCHIVE_STATES = new Set(['none', 'active', 'pending', 'archived', 'failed']);

function normalizeEnum(value, values, fallback, label) {
  const normalized = String(value ?? fallback).trim() || fallback;
  if (!values.has(normalized)) throw Object.assign(new Error(`${label} is unsupported`), { statusCode: 400 });
  return normalized;
}

function normalizeWorkspaceMode(value) {
  return normalizeEnum(value, WORKSPACE_MODES, 'shared', 'workspaceMode');
}

function normalizeArchiveMode(value, workspaceMode) {
  return normalizeEnum(value, ARCHIVE_MODES, workspaceMode === 'session-clone' ? 'in-place' : 'managed-copy', 'archiveMode');
}

function normalizeArchiveState(value, workspaceMode) {
  return normalizeEnum(value, ARCHIVE_STATES, workspaceMode === 'session-clone' ? 'active' : 'none', 'archiveState');
}

function taskSessionRoot(taskId) {
  const normalized = String(taskId || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw Object.assign(new Error('Task ID is not a valid session workspace name'), { statusCode: 400 });
  }
  return path.join(TASK_SESSION_ROOT, normalized);
}

function taskSessionPaths(taskId) {
  const root = taskSessionRoot(taskId);
  return {
    root,
    source: path.join(root, 'source', 'premium_robot'),
    output: path.join(root, 'task'),
    manifest: path.join(root, 'source-manifest.json'),
    agent: path.join(root, '.agent'),
  };
}

function assertRegularDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw Object.assign(new Error(`${label} must be a regular directory`), { statusCode: 409 });
  }
}

function prepareTaskSessionWorkspace(taskId) {
  const paths = taskSessionPaths(taskId);
  fs.mkdirSync(TASK_SESSION_ROOT, { recursive: true, mode: 0o700 });
  assertRegularDirectory(TASK_SESSION_ROOT, 'Task session workspace root');
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  assertRegularDirectory(paths.root, 'Task session workspace');
  fs.mkdirSync(path.dirname(paths.source), { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.output, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.agent, { recursive: true, mode: 0o700 });
  assertRegularDirectory(path.dirname(paths.source), 'Task source parent');
  assertRegularDirectory(paths.output, 'Task output directory');
  return paths;
}

function taskAgentDirectory(task) {
  return (task.workspaceMode ?? task.workspace_mode) === 'session-clone'
    ? taskSessionPaths(task.id).agent : task.workingDir ?? task.working_dir;
}

function readSourceManifest(taskId) {
  const paths = taskSessionPaths(taskId);
  assertRegularDirectory(paths.source, 'Task source');
  const raw = fs.readFileSync(paths.manifest);
  const manifest = JSON.parse(raw);
  const head = execFileSync('git', ['-C', paths.source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (manifest.task_id !== taskId || manifest.source_root !== paths.source || manifest.commit !== head) {
    throw new Error('Source manifest does not match the Task checkout');
  }
  return { manifest, hash: crypto.createHash('sha256').update(raw).digest('hex') };
}

async function inventorySessionWorkspace(taskId) {
  const paths = taskSessionPaths(taskId);
  const source = readSourceManifest(taskId);
  const entries = [];
  async function visit(target) {
    const stat = await fs.promises.lstat(target);
    const entry = { path: path.relative(paths.root, target).split(path.sep).join('/'), mode: stat.mode & 0o777 };
    if (stat.isSymbolicLink()) {
      entries.push({ ...entry, kind: 'symlink', target: await fs.promises.readlink(target) });
    } else if (stat.isDirectory()) {
      entries.push({ ...entry, kind: 'directory' });
      for (const name of (await fs.promises.readdir(target)).sort()) await visit(path.join(target, name));
    } else if (stat.isFile()) {
      entries.push({ ...entry, kind: 'file', ...await digestRegularFile(target) });
    }
  }
  await visit(paths.source);
  await visit(paths.output);
  return { schemaVersion: 1, taskId, sourceCommit: source.manifest.commit, sourceManifestHash: source.hash, entries };
}

function sealSessionWorkspace(taskId, inventory) {
  const root = taskSessionRoot(taskId);
  const manifestPath = path.join(root, 'archive-manifest.json');
  const content = JSON.stringify(inventory);
  fs.writeFileSync(`${manifestPath}.tmp`, content, { mode: 0o600, flush: true });
  fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  const directoryFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  for (const entry of [...inventory.entries].reverse()) {
    if (entry.kind !== 'symlink') fs.chmodSync(path.join(root, entry.path), entry.mode & ~0o222);
  }
  return crypto.createHash('sha256').update(content).digest('hex');
}

function reopenSessionSource(taskId) {
  const paths = taskSessionPaths(taskId);
  const manifestPath = path.join(paths.root, 'archive-manifest.json');
  if (!fs.existsSync(manifestPath)) return;
  const inventory = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const entry of inventory.entries) {
    const target = path.resolve(paths.root, entry.path);
    if (entry.kind !== 'symlink' && (target === paths.source || target.startsWith(`${paths.source}${path.sep}`))) {
      fs.chmodSync(target, entry.mode | 0o200);
    }
  }
  fs.chmodSync(paths.output, 0o700);
}

module.exports = {
  WORKSPACE_MODES,
  ARCHIVE_MODES,
  ARCHIVE_STATES,
  normalizeWorkspaceMode,
  normalizeArchiveMode,
  normalizeArchiveState,
  taskSessionRoot,
  taskSessionPaths,
  prepareTaskSessionWorkspace,
  readSourceManifest,
  inventorySessionWorkspace,
  sealSessionWorkspace,
  reopenSessionSource,
  taskAgentDirectory,
};
