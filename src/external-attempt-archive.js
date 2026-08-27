const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COPY_CHUNK_BYTES = 1024 * 1024;
const PROGRESS_INTERVAL_BYTES = 8 * 1024 * 1024;
const EXISTING_ARCHIVE_VERIFY_ATTEMPTS = 4;
const EXISTING_ARCHIVE_VERIFY_DELAY_MS = 10;

function archiveError(message, code, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function statFingerprint(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function sameFingerprint(left, right) {
  const leftFingerprint = statFingerprint(left);
  const rightFingerprint = statFingerprint(right);
  return Object.keys(leftFingerprint)
    .every((key) => leftFingerprint[key] === rightFingerprint[key]);
}

function throwIfReadAborted(signal) {
  if (!signal?.aborted) return;
  throw archiveError('Archive read was interrupted by the client', 'ARCHIVE_READ_ABORTED');
}

async function lstatRegularFile(filePath, label, missingCode = 'ARCHIVE_SOURCE_MISSING') {
  let stat;
  try {
    stat = await fs.promises.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') throw archiveError(`${label} does not exist`, missingCode, error);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw archiveError(`${label} is not a regular file`, 'ARCHIVE_UNSAFE_FILE');
  }
  return stat;
}

async function openRegularFile(filePath, flags, mode, label) {
  let handle;
  try {
    handle = await fs.promises.open(filePath, flags | (fs.constants.O_NOFOLLOW || 0), mode);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw archiveError(`${label} is not a regular file`, 'ARCHIVE_UNSAFE_FILE');
    return { handle, stat };
  } catch (error) {
    try { await handle?.close(); } catch {}
    if (error.code === 'ELOOP') throw archiveError(`${label} must not be a symbolic link`, 'ARCHIVE_UNSAFE_FILE', error);
    throw error;
  }
}

async function openRegularFileForRead(filePath, options = {}) {
  const label = String(options.label || 'Managed archive');
  const missingCode = String(options.missingCode || 'ARCHIVE_FILE_MISSING');
  throwIfReadAborted(options.signal);
  const pathStat = await lstatRegularFile(filePath, label, missingCode);
  const opened = await openRegularFile(
    filePath,
    fs.constants.O_RDONLY,
    undefined,
    label,
  );
  if (!sameFingerprint(pathStat, opened.stat)) {
    await opened.handle.close();
    throw archiveError(`${label} changed while it was opened`, 'ARCHIVE_FILE_CHANGED');
  }
  if (options.signal?.aborted) {
    await opened.handle.close();
    throwIfReadAborted(options.signal);
  }
  return { handle: opened.handle, bytes: Number(opened.stat.size), stat: opened.stat };
}

async function assertArchiveDirectory(directory) {
  const stat = await fs.promises.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw archiveError('Archive destination parent is not a regular directory', 'ARCHIVE_UNSAFE_DIRECTORY');
  }
}

async function openDigestedRegularFile(filePath, options = {}) {
  const label = String(options.label || 'Managed archive');
  const opened = await openRegularFileForRead(filePath, options);
  const { handle, stat: before } = opened;
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  try {
    while (position < Number(before.size)) {
      throwIfReadAborted(options.signal);
      const length = Math.min(buffer.length, Number(before.size) - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (!bytesRead) throw archiveError('Managed archive ended before its recorded size', 'ARCHIVE_FILE_CHANGED');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    let pathAfter;
    try {
      pathAfter = await fs.promises.lstat(filePath, { bigint: true });
    } catch (error) {
      throw archiveError(`${label} path changed while it was verified`, 'ARCHIVE_FILE_CHANGED', error);
    }
    if (!sameFingerprint(before, after) || !sameFingerprint(before, pathAfter)) {
      throw archiveError(`${label} changed while it was verified`, 'ARCHIVE_FILE_CHANGED');
    }
    throwIfReadAborted(options.signal);
    return {
      handle,
      bytes: opened.bytes,
      sha256: hash.digest('hex'),
      recoveredExisting: true,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function digestRegularFile(filePath, options = {}) {
  const opened = await openDigestedRegularFile(filePath, options);
  try {
    return {
      bytes: opened.bytes,
      sha256: opened.sha256,
      recoveredExisting: opened.recoveredExisting,
    };
  } finally {
    await opened.handle.close();
  }
}

async function digestExistingArchive(filePath) {
  let lastError;
  for (let attempt = 1; attempt <= EXISTING_ARCHIVE_VERIFY_ATTEMPTS; attempt += 1) {
    try {
      return await digestRegularFile(filePath);
    } catch (error) {
      lastError = error;
      if (error.code !== 'ARCHIVE_FILE_CHANGED' || attempt === EXISTING_ARCHIVE_VERIFY_ATTEMPTS) {
        throw error;
      }
      // A concurrent publisher briefly changes hard-link metadata while it
      // removes its temporary link. Retry the digest without weakening checks.
      await new Promise((resolve) => setTimeout(resolve, EXISTING_ARCHIVE_VERIFY_DELAY_MS));
    }
  }
  throw lastError;
}

async function fsyncDirectory(directory) {
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_DIRECTORY || 0)
    | (fs.constants.O_NOFOLLOW || 0);
  const handle = await fs.promises.open(directory, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw archiveError('Archive parent changed type', 'ARCHIVE_UNSAFE_DIRECTORY');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function archiveFileAtomically(options) {
  const sourcePath = path.resolve(String(options?.sourcePath || ''));
  const destinationPath = path.resolve(String(options?.destinationPath || ''));
  const destinationDirectory = path.dirname(destinationPath);
  const faultInjector = options?.faultInjector;
  const onProgress = options?.onProgress;
  if (!options?.sourcePath || !options?.destinationPath || sourcePath === destinationPath) {
    throw archiveError('Archive source and destination must be distinct paths', 'ARCHIVE_INVALID_PATH');
  }

  await assertArchiveDirectory(destinationDirectory);
  try {
    await fs.promises.lstat(destinationPath);
    return await digestExistingArchive(destinationPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const sourcePathStat = await lstatRegularFile(sourcePath, 'Tracked log');
  const source = await openRegularFile(sourcePath, fs.constants.O_RDONLY, undefined, 'Tracked log');
  if (!sameFingerprint(sourcePathStat, source.stat)) {
    await source.handle.close();
    throw archiveError('Tracked log changed while it was opened', 'ARCHIVE_SOURCE_CHANGED');
  }

  const temporaryPath = path.join(
    destinationDirectory,
    `.${path.basename(destinationPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let destinationHandle = null;
  let published = false;
  try {
    const destination = await openRegularFile(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
      'Archive temporary file',
    );
    destinationHandle = destination.handle;
    await destinationHandle.chmod(0o600);

    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    const expectedBytes = Number(source.stat.size);
    let position = 0;
    let nextProgressAt = PROGRESS_INTERVAL_BYTES;
    while (position < expectedBytes) {
      const length = Math.min(buffer.length, expectedBytes - position);
      const { bytesRead } = await source.handle.read(buffer, 0, length, position);
      if (!bytesRead) throw archiveError('Tracked log ended during archival', 'ARCHIVE_SOURCE_CHANGED');
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw archiveError('Archive write made no progress', 'ARCHIVE_WRITE_FAILED');
        written += result.bytesWritten;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (position >= nextProgressAt) {
        await onProgress?.({ bytes: position, expectedBytes });
        nextProgressAt = position + PROGRESS_INTERVAL_BYTES;
      }
    }
    await destinationHandle.sync();
    await faultInjector?.('after_copy');

    const sourceAfter = await source.handle.stat({ bigint: true });
    let sourcePathAfter;
    try {
      sourcePathAfter = await fs.promises.lstat(sourcePath, { bigint: true });
    } catch (error) {
      throw archiveError('Tracked log path changed during archival', 'ARCHIVE_SOURCE_CHANGED', error);
    }
    if (!sameFingerprint(source.stat, sourceAfter) || !sameFingerprint(source.stat, sourcePathAfter)) {
      throw archiveError('Tracked log changed during archival', 'ARCHIVE_SOURCE_CHANGED');
    }
    await onProgress?.({ bytes: position, expectedBytes, publishing: true });
    await faultInjector?.('before_publish');

    await destinationHandle.close();
    destinationHandle = null;
    try {
      await fs.promises.link(temporaryPath, destinationPath);
      published = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return await digestExistingArchive(destinationPath);
    }
    await fsyncDirectory(destinationDirectory);
    await fs.promises.unlink(temporaryPath);
    await fsyncDirectory(destinationDirectory);
    await faultInjector?.('after_publish');
    return {
      bytes: expectedBytes,
      sha256: hash.digest('hex'),
      recoveredExisting: false,
    };
  } finally {
    try { await destinationHandle?.close(); } catch {}
    try { await source.handle.close(); } catch {}
    if (!published) {
      try { await fs.promises.unlink(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

module.exports = {
  archiveFileAtomically,
  digestRegularFile,
  fsyncDirectory,
  openDigestedRegularFile,
  openRegularFileForRead,
};
