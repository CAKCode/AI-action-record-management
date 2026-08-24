const fs = require('fs');
const path = require('path');
const {
  ROOT_DIR,
  DATA_DIR,
  RUNTIME_DIR,
  TASK_WORKSPACE_ROOTS,
} = require('./paths');
const { ensureDir } = require('./utils');

function pathContains(parentDir, targetDir) {
  const relative = path.relative(path.resolve(parentDir), path.resolve(targetDir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function workspaceError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function ensureWorkspaceRoots() {
  if (TASK_WORKSPACE_ROOTS[0]) ensureDir(TASK_WORKSPACE_ROOTS[0]);
  return TASK_WORKSPACE_ROOTS.filter((root) => fs.existsSync(root) && fs.statSync(root).isDirectory());
}

function resolveWorkingDir(value) {
  const roots = ensureWorkspaceRoots();
  if (!roots.length) throw workspaceError('No task workspace root is available');
  const requested = String(value || '.').trim() || '.';
  const candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(roots[0], requested);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw workspaceError(`Working directory does not exist: ${candidate}`);
  }
  const resolved = fs.realpathSync(candidate);
  const allowed = roots.some((root) => {
    const resolvedRoot = fs.realpathSync(root);
    return pathContains(resolvedRoot, resolved);
  });
  if (!allowed) throw workspaceError('Working directory is outside the configured task workspace roots');

  const forbidden = [ROOT_DIR, DATA_DIR, RUNTIME_DIR].map((entry) => {
    try {
      return fs.realpathSync(entry);
    } catch {
      return path.resolve(entry);
    }
  });
  if (forbidden.some((entry) => pathContains(entry, resolved) || pathContains(resolved, entry))) {
    throw workspaceError('Working directory must be isolated from platform source, data, and runtime directories');
  }
  return resolved;
}

function workspaceStatus() {
  return {
    configured: TASK_WORKSPACE_ROOTS.length,
    available: ensureWorkspaceRoots().length,
  };
}

module.exports = {
  pathContains,
  ensureWorkspaceRoots,
  resolveWorkingDir,
  workspaceStatus,
};
