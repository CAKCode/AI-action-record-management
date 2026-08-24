const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { STORAGE_AUDIT_OUTBOX_FILE } = require('./paths');

const OUTBOX_FORMAT = 'codex-task-platform.storage-audit-outbox';
const OUTBOX_VERSION = 1;
const MAX_OUTBOX_BYTES = 4 * 1024 * 1024;
const MAX_OUTBOX_EVENTS = 10000;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function syncPath(targetPath) {
  let fd;
  try {
    fd = fs.openSync(targetPath, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function regularPrivateFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Storage audit outbox is not a regular file');
  if (stat.size > MAX_OUTBOX_BYTES) throw new Error('Storage audit outbox exceeds its size limit');
  fs.chmodSync(filePath, 0o600);
}

function validateCategories(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Storage audit outbox categories are invalid');
  }
  const result = {};
  let eventCount = 0;
  for (const [category, events] of Object.entries(value)) {
    if (!CATEGORY_PATTERN.test(category) || !Array.isArray(events)) {
      throw new Error('Storage audit outbox category is invalid');
    }
    result[category] = events.map((event) => {
      if (!event || typeof event !== 'object' || Array.isArray(event)
        || !/^audit-[a-f0-9-]{36}$/.test(String(event.id || ''))
        || typeof event.ts !== 'string' || !Number.isFinite(Date.parse(event.ts))) {
        throw new Error('Storage audit outbox event is invalid');
      }
      eventCount += 1;
      if (eventCount > MAX_OUTBOX_EVENTS) throw new Error('Storage audit outbox contains too many events');
      return JSON.parse(JSON.stringify(event));
    });
  }
  return result;
}

function createStorageAuditOutbox(filePath = STORAGE_AUDIT_OUTBOX_FILE) {
  const absolutePath = path.resolve(filePath);
  const directory = path.dirname(absolutePath);
  const baseName = path.basename(absolutePath);

  const cleanupTemporaryFiles = () => {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(`.${baseName}.writing-`)) continue;
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.rmSync(target, { force: true });
    }
  };

  return {
    load() {
      cleanupTemporaryFiles();
      try {
        regularPrivateFile(absolutePath);
      } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
      }
      const document = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
      if (document?.format !== OUTBOX_FORMAT || document?.version !== OUTBOX_VERSION) {
        throw new Error('Storage audit outbox format is unsupported');
      }
      return validateCategories(document.categories);
    },
    save(categories) {
      const normalized = validateCategories(categories);
      const nonempty = Object.fromEntries(Object.entries(normalized).filter(([, events]) => events.length > 0));
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (Object.keys(nonempty).length === 0) {
        try {
          regularPrivateFile(absolutePath);
          fs.unlinkSync(absolutePath);
          syncPath(directory);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        return;
      }
      const body = `${JSON.stringify({
        format: OUTBOX_FORMAT,
        version: OUTBOX_VERSION,
        updatedAt: new Date().toISOString(),
        categories: nonempty,
      }, null, 2)}\n`;
      if (Buffer.byteLength(body) > MAX_OUTBOX_BYTES) throw new Error('Storage audit outbox exceeds its size limit');
      const temporaryPath = path.join(directory, `.${baseName}.writing-${process.pid}-${crypto.randomUUID()}`);
      let fd;
      try {
        fd = fs.openSync(temporaryPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
        fs.writeFileSync(fd, body, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        try {
          const targetStat = fs.lstatSync(absolutePath);
          if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('Storage audit outbox target is unsafe');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        fs.renameSync(temporaryPath, absolutePath);
        fs.chmodSync(absolutePath, 0o600);
        syncPath(directory);
      } finally {
        if (fd != null) fs.closeSync(fd);
        try { fs.rmSync(temporaryPath, { force: true }); } catch {}
      }
    },
  };
}

module.exports = {
  OUTBOX_FORMAT,
  OUTBOX_VERSION,
  MAX_OUTBOX_BYTES,
  MAX_OUTBOX_EVENTS,
  createStorageAuditOutbox,
};
