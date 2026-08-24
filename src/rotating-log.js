const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETENTION = 3;

function boundedInteger(value, fallback, minimum, maximum, name) {
  const raw = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(raw) || raw < minimum || raw > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return raw;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Rotating log directory is not a private directory');
  }
  fs.chmodSync(directory, 0o700);
}

function inspectLogFile(filePath, allowMissing = true) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Rotating log path is not a regular file: ${path.basename(filePath)}`);
    }
    fs.chmodSync(filePath, 0o600);
    return stat;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function rewriteTail(filePath, maximumBytes) {
  const stat = inspectLogFile(filePath);
  if (!stat || stat.size <= maximumBytes) return;
  const temporaryPath = `${filePath}.trim-${process.pid}-${Date.now()}`;
  let source;
  let destination;
  try {
    source = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    destination = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(maximumBytes);
    let offset = 0;
    while (offset < maximumBytes) {
      const bytesRead = fs.readSync(
        source,
        buffer,
        offset,
        maximumBytes - offset,
        stat.size - maximumBytes + offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    let written = 0;
    while (written < offset) {
      written += fs.writeSync(destination, buffer, written, offset - written);
    }
    fs.fsyncSync(destination);
    fs.closeSync(destination);
    destination = null;
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    syncDirectory(path.dirname(filePath));
  } finally {
    if (source != null) fs.closeSync(source);
    if (destination != null) fs.closeSync(destination);
    try { fs.unlinkSync(temporaryPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

class RotatingLog {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.directory = path.dirname(this.filePath);
    this.maxBytes = boundedInteger(
      options.maxBytes,
      DEFAULT_MAX_BYTES,
      256,
      1024 * 1024 * 1024,
      'Rotating log max bytes',
    );
    this.retention = boundedInteger(
      options.retention,
      DEFAULT_RETENTION,
      1,
      20,
      'Rotating log retention',
    );
    this.descriptor = null;
    this.size = 0;
    ensurePrivateDirectory(this.directory);
    const basename = path.basename(this.filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rotatedPattern = new RegExp(`^${basename}\\.(\\d+)$`);
    const trimPattern = new RegExp(`^${basename}\\.trim-\\d+-\\d+$`);
    let removed = false;
    for (const name of fs.readdirSync(this.directory)) {
      const candidate = path.join(this.directory, name);
      const match = name.match(rotatedPattern);
      if (match) {
        inspectLogFile(candidate, false);
        if (Number(match[1]) > this.retention) {
          fs.unlinkSync(candidate);
          removed = true;
        } else {
          rewriteTail(candidate, this.maxBytes);
        }
        continue;
      }
      if (trimPattern.test(name)) {
        inspectLogFile(candidate, false);
        fs.unlinkSync(candidate);
        removed = true;
      }
    }
    if (removed) syncDirectory(this.directory);
    const current = inspectLogFile(this.filePath);
    if (current && current.size >= this.maxBytes) this.rotate();
    this.open();
  }

  open() {
    if (this.descriptor != null) return;
    this.descriptor = fs.openSync(
      this.filePath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_APPEND
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const stat = fs.fstatSync(this.descriptor);
    if (!stat.isFile()) {
      fs.closeSync(this.descriptor);
      this.descriptor = null;
      throw new Error('Rotating log descriptor is not a regular file');
    }
    fs.chmodSync(this.filePath, 0o600);
    this.size = stat.size;
  }

  rotate() {
    if (this.descriptor != null) {
      try { fs.fsyncSync(this.descriptor); } finally { fs.closeSync(this.descriptor); }
      this.descriptor = null;
    }
    const oldest = `${this.filePath}.${this.retention}`;
    inspectLogFile(oldest);
    try { fs.unlinkSync(oldest); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (let index = this.retention - 1; index >= 1; index -= 1) {
      const source = `${this.filePath}.${index}`;
      const destination = `${this.filePath}.${index + 1}`;
      if (!inspectLogFile(source)) continue;
      inspectLogFile(destination);
      fs.renameSync(source, destination);
    }
    if (inspectLogFile(this.filePath)) {
      const firstRotated = `${this.filePath}.1`;
      fs.renameSync(this.filePath, firstRotated);
      rewriteTail(firstRotated, this.maxBytes);
    }
    syncDirectory(this.directory);
    this.size = 0;
  }

  write(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    let offset = 0;
    while (offset < buffer.length) {
      if (this.descriptor == null) this.open();
      if (this.size >= this.maxBytes) {
        this.rotate();
        this.open();
      }
      const bytesToWrite = Math.min(buffer.length - offset, this.maxBytes - this.size);
      const written = fs.writeSync(this.descriptor, buffer, offset, bytesToWrite);
      if (written <= 0) throw new Error('Rotating log write made no progress');
      offset += written;
      this.size += written;
    }
  }

  close() {
    if (this.descriptor == null) return;
    try { fs.fsyncSync(this.descriptor); } finally {
      fs.closeSync(this.descriptor);
      this.descriptor = null;
    }
  }
}

function supervisorLogOptions(runtimeDirectory) {
  return {
    filePath: path.join(runtimeDirectory, 'web-supervisor.log'),
    maxBytes: boundedInteger(
      process.env.CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES,
      DEFAULT_MAX_BYTES,
      256,
      1024 * 1024 * 1024,
      'CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES',
    ),
    retention: boundedInteger(
      process.env.CODEX_WEB_SUPERVISOR_LOG_RETENTION,
      DEFAULT_RETENTION,
      1,
      20,
      'CODEX_WEB_SUPERVISOR_LOG_RETENTION',
    ),
  };
}

module.exports = {
  RotatingLog,
  supervisorLogOptions,
};
