'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SESSIONS_DIR } = require('./paths');
const {
  ensureManagedDirectory,
  lstatIfExists,
  readManagedFile,
} = require('./managed-storage');

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TRANSCRIPT_ID_PATTERN = /^cli-[0-9]{13}-[a-f0-9]{16}$/;
const READ_CHUNK_BYTES = 256 * 1024;

function transcriptError(message, code = 'INTERACTIVE_CLI_TRANSCRIPT_INVALID') {
  return Object.assign(new Error(message), { code, statusCode: 409, expected: true });
}

function assertTaskId(taskId) {
  const normalized = String(taskId || '');
  if (!TASK_ID_PATTERN.test(normalized)) throw transcriptError('Invalid task id', 'INTERACTIVE_CLI_TASK_INVALID');
  return normalized;
}

function assertRegularFile(filePath, label) {
  const stat = lstatIfExists(filePath);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw transcriptError(`${label} is not a regular file`);
  return stat;
}

function writeAll(descriptor, content) {
  let offset = 0;
  while (offset < content.length) {
    const written = fs.writeSync(descriptor, content, offset, content.length - offset);
    if (written <= 0) throw transcriptError('Interactive CLI transcript write made no progress');
    offset += written;
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function writeJsonAtomically(filePath, payload) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    writeAll(descriptor, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, filePath);
    fsyncDirectory(directory);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function digestDescriptor(descriptor) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let bytes = 0;
  let position = 0;
  while (true) {
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, position);
    if (!length) break;
    const chunk = buffer.subarray(0, length);
    hash.update(chunk);
    bytes += length;
    position += length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function digestDescriptorForReplay(descriptor, cancelled) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let bytes = 0;
  let position = 0;
  while (true) {
    if (cancelled?.()) return { bytes, cancelled: true };
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, position);
    if (!length) break;
    hash.update(buffer.subarray(0, length));
    bytes += length;
    position += length;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { bytes, sha256: hash.digest('hex'), cancelled: false };
}

function openRegularFile(filePath, label) {
  assertRegularFile(filePath, label);
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw transcriptError(`${label} is not a regular file`);
    return { descriptor, stat };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function createInteractiveCliTranscriptStore(options = {}) {
  const sessionsDir = path.resolve(options.sessionsDir || SESSIONS_DIR);
  const now = options.now || (() => new Date());

  function taskDirectory(taskId) {
    return path.join(sessionsDir, assertTaskId(taskId));
  }

  function archiveDirectory(taskId, create = false) {
    const taskDir = taskDirectory(taskId);
    const directory = path.join(taskDir, 'interactive-cli');
    if (create) {
      ensureManagedDirectory(sessionsDir, { recursive: true, label: 'Session storage root' });
      ensureManagedDirectory(taskDir, { label: 'Session storage directory' });
      ensureManagedDirectory(directory, { label: 'Interactive CLI transcript directory' });
    }
    return directory;
  }

  function archivePaths(taskId, transcriptId) {
    if (!TRANSCRIPT_ID_PATTERN.test(String(transcriptId || ''))) {
      throw transcriptError('Invalid interactive CLI transcript id');
    }
    const directory = archiveDirectory(taskId);
    return {
      raw: path.join(directory, `${transcriptId}.raw`),
      manifest: path.join(directory, `${transcriptId}.json`),
    };
  }

  function listTranscriptIds(taskId) {
    const directory = archiveDirectory(taskId);
    const stat = lstatIfExists(directory);
    if (!stat) return [];
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw transcriptError('Interactive CLI transcript directory is not a regular directory');
    }
    const ids = new Set();
    for (const name of fs.readdirSync(directory)) {
      const match = /^(cli-[0-9]{13}-[a-f0-9]{16})\.(?:raw|json)$/.exec(name);
      if (match) ids.add(match[1]);
    }
    return [...ids].sort();
  }

  function readManifest(taskId, transcriptId) {
    const paths = archivePaths(taskId, transcriptId);
    const raw = readManagedFile(paths.manifest, {
      encoding: 'utf8',
      label: 'Interactive CLI transcript manifest',
    });
    if (raw == null) return null;
    let manifest;
    try { manifest = JSON.parse(raw); } catch { throw transcriptError('Interactive CLI transcript manifest is malformed'); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.id !== transcriptId || manifest.taskId !== taskId
      || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0
      || !/^[a-f0-9]{64}$/.test(String(manifest.sha256 || ''))) {
      throw transcriptError('Interactive CLI transcript manifest is invalid');
    }
    return manifest;
  }

  function publishManifest(taskId, transcriptId, metadata) {
    const paths = archivePaths(taskId, transcriptId);
    if (lstatIfExists(paths.manifest)) return readManifest(taskId, transcriptId);
    writeJsonAtomically(paths.manifest, metadata);
    return metadata;
  }

  function start(taskId, metadata = {}) {
    const normalizedTaskId = assertTaskId(taskId);
    const directory = archiveDirectory(normalizedTaskId, true);
    const startedAt = now().toISOString();
    const transcriptId = `cli-${String(Date.now()).padStart(13, '0')}-${crypto.randomBytes(8).toString('hex')}`;
    const paths = {
      raw: path.join(directory, `${transcriptId}.raw`),
      manifest: path.join(directory, `${transcriptId}.json`),
    };
    let descriptor = fs.openSync(
      paths.raw,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let manifestPayload = null;
    let writeError = null;

    return {
      id: transcriptId,
      append(chunk) {
        if (writeError) throw writeError;
        if (descriptor == null) throw transcriptError('Interactive CLI transcript is already sealed');
        const content = Buffer.from(chunk);
        try {
          writeAll(descriptor, content);
          hash.update(content);
          bytes += content.length;
        } catch (error) {
          writeError = error;
          try { fs.closeSync(descriptor); } catch {}
          descriptor = null;
          throw error;
        }
      },
      seal(result = {}) {
        if (writeError) throw writeError;
        if (manifestPayload) return publishManifest(normalizedTaskId, transcriptId, manifestPayload);
        if (descriptor == null) return readManifest(normalizedTaskId, transcriptId);
        let closeError = null;
        try {
          fs.fsyncSync(descriptor);
        } catch (error) {
          closeError = error;
        }
        try {
          fs.closeSync(descriptor);
        } catch (error) {
          closeError ||= error;
        }
        descriptor = null;
        if (closeError) {
          writeError = closeError;
          throw closeError;
        }
        manifestPayload = {
          format: 'codex-task-platform.interactive-cli-transcript',
          version: 1,
          id: transcriptId,
          taskId: normalizedTaskId,
          threadId: String(result.threadId || metadata.threadId || ''),
          mode: String(metadata.mode || 'interactive'),
          attemptId: String(metadata.attemptId || ''),
          pid: Number.isInteger(Number(metadata.pid)) ? Number(metadata.pid) : null,
          startedAt,
          endedAt: String(result.endedAt || now().toISOString()),
          exitCode: result.exitCode == null ? null : Number(result.exitCode),
          signal: result.signal == null ? null : Number(result.signal),
          bytes,
          sha256: hash.digest('hex'),
          recovered: false,
        };
        return publishManifest(normalizedTaskId, transcriptId, manifestPayload);
      },
    };
  }

  function sealUnfinished(taskId) {
    const normalizedTaskId = assertTaskId(taskId);
    const sealed = [];
    for (const transcriptId of listTranscriptIds(normalizedTaskId)) {
      const existing = readManifest(normalizedTaskId, transcriptId);
      if (existing) {
        assertRegularFile(archivePaths(normalizedTaskId, transcriptId).raw, 'Interactive CLI transcript');
        sealed.push(existing);
        continue;
      }
      const paths = archivePaths(normalizedTaskId, transcriptId);
      const { descriptor, stat } = openRegularFile(paths.raw, 'Interactive CLI transcript');
      let digest;
      try { digest = digestDescriptor(descriptor); } finally { fs.closeSync(descriptor); }
      sealed.push(publishManifest(normalizedTaskId, transcriptId, {
        format: 'codex-task-platform.interactive-cli-transcript',
        version: 1,
        id: transcriptId,
        taskId: normalizedTaskId,
        threadId: '',
        pid: null,
        startedAt: stat.birthtime.toISOString(),
        endedAt: stat.mtime.toISOString(),
        exitCode: null,
        signal: null,
        bytes: digest.bytes,
        sha256: digest.sha256,
        recovered: true,
      }));
    }
    return sealed;
  }

  async function replay(taskId, onChunk, options = {}) {
    const normalizedTaskId = assertTaskId(taskId);
    let totalBytes = 0;
    const archives = [];
    for (const transcriptId of listTranscriptIds(normalizedTaskId)) {
      const manifest = readManifest(normalizedTaskId, transcriptId);
      if (!manifest) throw transcriptError('Interactive CLI transcript has not been sealed');
      const { raw } = archivePaths(normalizedTaskId, transcriptId);
      const { descriptor, stat } = openRegularFile(raw, 'Interactive CLI transcript');
      try {
        if (stat.size !== manifest.bytes) throw transcriptError('Interactive CLI transcript size does not match its manifest');
        const verified = await digestDescriptorForReplay(descriptor, options.cancelled);
        if (verified.cancelled) return { archives, totalBytes, cancelled: true };
        if (verified.bytes !== manifest.bytes || verified.sha256 !== manifest.sha256) {
          throw transcriptError('Interactive CLI transcript failed integrity verification');
        }
        if (!onChunk) {
          archives.push(manifest);
          totalBytes += verified.bytes;
          continue;
        }
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let bytes = 0;
        let position = 0;
        while (true) {
          if (options.cancelled?.()) return { archives, totalBytes, cancelled: true };
          const length = fs.readSync(descriptor, buffer, 0, buffer.length, position);
          if (!length) break;
          const chunk = Buffer.from(buffer.subarray(0, length));
          hash.update(chunk);
          bytes += length;
          position += length;
          await onChunk(chunk);
        }
        if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.sha256) {
          throw transcriptError('Interactive CLI transcript changed during replay');
        }
        archives.push(manifest);
        totalBytes += bytes;
      } finally {
        fs.closeSync(descriptor);
      }
    }
    return { archives, totalBytes, cancelled: false };
  }

  async function verify(taskId) {
    return replay(taskId, null);
  }

  return { start, sealUnfinished, replay, verify };
}

module.exports = {
  createInteractiveCliTranscriptStore,
};
