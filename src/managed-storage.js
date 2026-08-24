const fs = require('fs');
const path = require('path');

function storageError(label, kind) {
  const error = new Error(`${label} is not a ${kind}`);
  error.code = 'UNSAFE_MANAGED_STORAGE';
  return error;
}

function lstatIfExists(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function pathEntryExists(filePath) {
  return lstatIfExists(filePath) !== null;
}

function ensureManagedDirectory(directory, options = {}) {
  const {
    recursive = false,
    mode = 0o700,
    label = 'Managed storage directory',
  } = options;
  let stat = lstatIfExists(directory);
  if (!stat) {
    fs.mkdirSync(directory, { recursive, mode });
    stat = fs.lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw storageError(label, 'regular directory');
  }
  fs.chmodSync(directory, mode);
  return directory;
}

function assertRegularFile(stat, label) {
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw storageError(label, 'regular file');
  }
}

function writeManagedFile(filePath, content, options = {}) {
  const {
    append = false,
    exclusive = false,
    mode = 0o600,
    label = 'Managed storage file',
  } = options;
  const existing = lstatIfExists(filePath);
  if (existing) assertRegularFile(existing, label);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | (append ? fs.constants.O_APPEND : 0)
    | (exclusive ? fs.constants.O_EXCL : 0)
    | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, flags, mode);
    assertRegularFile(fs.fstatSync(descriptor), label);
    fs.fchmodSync(descriptor, mode);
    if (!append) fs.ftruncateSync(descriptor, 0);
    fs.writeFileSync(descriptor, content);
    return fs.fstatSync(descriptor);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function readManagedFile(filePath, options = {}) {
  const {
    encoding = null,
    label = 'Managed storage file',
  } = options;
  const existing = lstatIfExists(filePath);
  if (!existing) return null;
  assertRegularFile(existing, label);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    assertRegularFile(fs.fstatSync(descriptor), label);
    return fs.readFileSync(descriptor, encoding ? { encoding } : undefined);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function readManagedTextTail(filePath, maxBytes = 1024 * 1024, options = {}) {
  const { label = 'Managed storage file' } = options;
  const existing = lstatIfExists(filePath);
  if (!existing) return '';
  assertRegularFile(existing, label);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(descriptor);
    assertRegularFile(stat, label);
    const length = Math.min(stat.size, Math.max(0, Number(maxBytes) || 0));
    if (!length) return '';
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(descriptor, buffer, 0, length, stat.size - length);
    return buffer.toString('utf8');
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function secureManagedTree(rootDirectory) {
  ensureManagedDirectory(rootDirectory, {
    recursive: true,
    mode: 0o700,
    label: 'Platform data directory',
  });
  const visit = (directory) => {
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory)) {
      const absolutePath = path.join(directory, entry);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(absolutePath);
      } else if (stat.isFile()) {
        fs.chmodSync(absolutePath, 0o600);
      }
    }
  };
  visit(rootDirectory);
}

module.exports = {
  lstatIfExists,
  pathEntryExists,
  ensureManagedDirectory,
  writeManagedFile,
  readManagedFile,
  readManagedTextTail,
  secureManagedTree,
};
