const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = process.env.CODEX_DESK_DATA_DIR
  ? path.resolve(process.env.CODEX_DESK_DATA_DIR)
  : path.join(ROOT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'codex-tasks.db');
const BACKUP_DIR = process.env.CODEX_DESK_BACKUP_DIR
  ? path.resolve(process.env.CODEX_DESK_BACKUP_DIR)
  : path.join(DATA_DIR, 'backups');
const RECOVERY_CHECKPOINT_DIR = path.join(BACKUP_DIR, 'recovery-checkpoints');
const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.ndjson');
const STORAGE_AUDIT_OUTBOX_FILE = path.join(DATA_DIR, 'storage-audit-outbox.json');
const RUNTIME_DIR = process.env.CODEX_DESK_RUNTIME_DIR
  ? path.resolve(process.env.CODEX_DESK_RUNTIME_DIR)
  : path.join(path.dirname(ROOT_DIR), `.${path.basename(ROOT_DIR)}-runtime`);
const CODEX_HOME_DIR = path.join(RUNTIME_DIR, 'codex-home');
const CODEX_HOME_SOURCE = process.env.SOURCE_CODEX_HOME || '/home/jenkins/.codex';
const CODEX_SOURCE_SKILLS_DIR = path.join(CODEX_HOME_SOURCE, 'skills');
const WORKSPACE_CODEX_SKILLS_DIR = process.env.WORKSPACE_CODEX_SKILLS_DIR
  ? path.resolve(process.env.WORKSPACE_CODEX_SKILLS_DIR)
  : path.join(ROOT_DIR, '.codex', 'skills');
const SKILL_SNAPSHOTS_DIR = path.join(RUNTIME_DIR, 'skill-snapshots');
const DEFAULT_TASK_WORKSPACE_ROOT = path.dirname(ROOT_DIR);
const TASK_WORKSPACE_ROOTS = String(process.env.CODEX_TASK_WORKSPACE_ROOTS || DEFAULT_TASK_WORKSPACE_ROOT)
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(entry));
const TASK_SESSION_ROOT = process.env.CODEX_TASK_SESSIONS_DIR
  ? path.resolve(process.env.CODEX_TASK_SESSIONS_DIR)
  : path.join(TASK_WORKSPACE_ROOTS[0] || DEFAULT_TASK_WORKSPACE_ROOT, 'codex-task-sessions');

function comparablePath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function pathsOverlap(left, right) {
  const leftPath = comparablePath(left);
  const rightPath = comparablePath(right);
  const relative = path.relative(leftPath, rightPath);
  const reverse = path.relative(rightPath, leftPath);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative))
    || (!reverse.startsWith('..') && !path.isAbsolute(reverse));
}

function pathIsWithin(parent, candidate) {
  const relative = path.relative(comparablePath(parent), comparablePath(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPathConfiguration(condition, message) {
  if (!condition) throw new Error(message);
}

if (pathsOverlap(DATA_DIR, RUNTIME_DIR)) {
  throw new Error('Data and runtime directories must not overlap');
}
if (pathsOverlap(ROOT_DIR, RUNTIME_DIR)) {
  throw new Error('Runtime directory must be isolated from the platform source directory');
}

// Backups may live below DATA_DIR (the default layout), but must never share
// the source or runtime tree. Task workspaces are mutable execution storage;
// keeping them out of platform storage prevents startup permission tightening,
// backup traversal, and runtime cleanup from touching business files.
assertPathConfiguration(
  comparablePath(DATA_DIR) !== comparablePath(BACKUP_DIR),
  'Backup directory must be separate from the data directory',
);
assertPathConfiguration(
  !pathsOverlap(BACKUP_DIR, RUNTIME_DIR),
  'Backup directory must not overlap the runtime directory',
);
assertPathConfiguration(
  !pathsOverlap(BACKUP_DIR, ROOT_DIR) || pathIsWithin(DATA_DIR, BACKUP_DIR),
  'Backup directory must not overlap the platform source directory outside data storage',
);
assertPathConfiguration(
  !pathsOverlap(TASK_SESSION_ROOT, DATA_DIR)
    && !pathsOverlap(TASK_SESSION_ROOT, RUNTIME_DIR)
    && !pathsOverlap(TASK_SESSION_ROOT, ROOT_DIR),
  'Task Session directory must be isolated from platform storage and source',
);
for (const workspaceRoot of TASK_WORKSPACE_ROOTS) {
  assertPathConfiguration(
    !pathIsWithin(DATA_DIR, workspaceRoot)
      && !pathIsWithin(RUNTIME_DIR, workspaceRoot)
      && !pathIsWithin(BACKUP_DIR, workspaceRoot)
      && !pathIsWithin(ROOT_DIR, workspaceRoot),
    'Task workspace roots must not be inside platform storage or source',
  );
}

module.exports = {
  ROOT_DIR,
  PUBLIC_DIR,
  DATA_DIR,
  DB_FILE,
  BACKUP_DIR,
  RECOVERY_CHECKPOINT_DIR,
  SKILLS_DIR,
  SESSIONS_DIR,
  AUDIT_FILE,
  STORAGE_AUDIT_OUTBOX_FILE,
  RUNTIME_DIR,
  CODEX_HOME_DIR,
  CODEX_HOME_SOURCE,
  CODEX_SOURCE_SKILLS_DIR,
  WORKSPACE_CODEX_SKILLS_DIR,
  SKILL_SNAPSHOTS_DIR,
  DEFAULT_TASK_WORKSPACE_ROOT,
  TASK_SESSION_ROOT,
  TASK_WORKSPACE_ROOTS,
};
