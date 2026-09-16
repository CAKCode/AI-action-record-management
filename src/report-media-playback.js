const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fileURLToPath, pathToFileURL } = require('url');
const { SESSIONS_DIR } = require('./paths');
const { openRegularFileForRead } = require('./external-attempt-archive');
const { ensureManagedDirectory } = require('./managed-storage');
const { safeId } = require('./utils');

const PLAYBACK_CACHE_VERSION = 'v1';
const playbackMaterializations = new Map();

function playbackError(message, statusCode = 409, cause = null) {
  const error = Object.assign(new Error(message), { statusCode, expected: true });
  if (cause) error.cause = cause;
  return error;
}

function manifestReferences(content) {
  const references = [];
  for (const match of String(content).matchAll(/\bURI\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
    references.push(match[1] ?? match[2]);
  }
  for (const line of String(content).split(/\r?\n/)) {
    const value = line.trim();
    if (value && !value.startsWith('#')) references.push(value);
  }
  return [...new Set(references)];
}

function replaceManifestReferences(content, replacements) {
  const replace = (reference) => replacements.get(reference) || reference;
  let transformed = String(content).replace(
    /(\bURI\s*=\s*["'])([^"']+)(["'])/gi,
    (_, prefix, reference, suffix) => `${prefix}${replace(reference)}${suffix}`,
  );
  transformed = transformed.split(/(\r?\n)/).map((line) => {
    if (/^\r?\n$/.test(line) || /^\s*#/.test(line) || !line.trim()) return line;
    const match = /^(\s*)(\S+)(\s*)$/.exec(line);
    return match ? `${match[1]}${replace(match[2])}${match[3]}` : line;
  }).join('');
  return transformed;
}

function referencedResourceId(reference) {
  let parsed;
  try {
    parsed = new URL(String(reference), 'http://managed-report.invalid');
  } catch {
    throw playbackError(`HLS manifest contains an invalid resource reference: ${reference}`);
  }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const marker = segments.lastIndexOf('resources');
  if (marker < 0 || marker !== segments.length - 2) {
    throw playbackError(`HLS manifest reference is not a managed report resource: ${reference}`);
  }
  let resourceId;
  try {
    resourceId = decodeURIComponent(segments[marker + 1]);
  } catch {
    throw playbackError(`HLS manifest contains malformed resource encoding: ${reference}`);
  }
  if (!resourceId || resourceId.includes('/') || resourceId.includes('\\')) {
    throw playbackError(`HLS manifest contains an invalid resource id: ${reference}`);
  }
  return resourceId;
}

async function readOpenedResource(opened, encoding = null) {
  try {
    return encoding
      ? await opened.fileHandle.readFile({ encoding })
      : await opened.fileHandle.readFile();
  } finally {
    await opened.fileHandle.close();
  }
}

async function materializeLocalPlaylist(options, stagingDirectory) {
  const materialized = new Map();
  const active = new Set();

  const materializeResource = async (resourceId) => {
    if (materialized.has(resourceId)) return materialized.get(resourceId);
    if (active.has(resourceId)) throw playbackError('HLS manifest contains a playlist cycle');
    active.add(resourceId);
    try {
      const opened = await options.openResource(resourceId);
      if (!opened) throw playbackError(`HLS dependency ${resourceId} is not available`, 404);
      const extension = path.extname(opened.fileName).toLowerCase();
      if (extension !== '.m3u8') {
        await opened.fileHandle.close();
        const localUrl = pathToFileURL(opened.managedPath).href;
        materialized.set(resourceId, localUrl);
        return localUrl;
      }

      const content = await readOpenedResource(opened, 'utf8');
      const replacements = new Map();
      for (const reference of manifestReferences(content)) {
        replacements.set(
          reference,
          await materializeResource(referencedResourceId(reference)),
        );
      }
      const localPath = path.join(stagingDirectory, `${safeId(resourceId)}.m3u8`);
      await fs.promises.writeFile(
        localPath,
        replaceManifestReferences(content, replacements),
        { mode: 0o600 },
      );
      const localUrl = pathToFileURL(localPath).href;
      materialized.set(resourceId, localUrl);
      return localUrl;
    } finally {
      active.delete(resourceId);
    }
  };

  const playlistUrl = await materializeResource(options.resourceId);
  return new URL(playlistUrl);
}

function ffmpegExecutable() {
  return String(process.env.CODEX_REPORT_FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
}

function runFfmpeg(inputPath, outputPath) {
  const args = [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-protocol_whitelist', 'file,crypto,data',
    '-i', inputPath,
    '-map', '0:v?',
    '-map', '0:a?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', outputPath,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExecutable(), args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk.slice(0, (64 * 1024) - stderr.length);
    });
    child.once('error', (error) => {
      reject(playbackError(`Could not start FFmpeg: ${error.message}`, 503, error));
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim().split(/\r?\n/).slice(-4).join(' | ');
      reject(playbackError(
        'FFmpeg could not prepare HLS playback',
        409,
        new Error(detail || String(signal || code)),
      ));
    });
  });
}

function playbackCacheDirectory(taskId) {
  return path.join(
    SESSIONS_DIR,
    safeId(taskId),
    'skill-report-artifacts',
    '.playback-cache',
  );
}

async function usableCacheFile(filePath) {
  try {
    const stat = await fs.promises.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function materializePlaybackFile(options, cachePath) {
  if (await usableCacheFile(cachePath)) return cachePath;
  const cacheDirectory = path.dirname(cachePath);
  ensureManagedDirectory(cacheDirectory, { label: 'Report media playback cache' });
  const stagingDirectory = await fs.promises.mkdtemp(
    path.join(cacheDirectory, '.materializing-'),
  );
  try {
    const playlistUrl = await materializeLocalPlaylist(options, stagingDirectory);
    const stagedOutput = path.join(stagingDirectory, 'playback.mp4');
    await runFfmpeg(fileURLToPath(playlistUrl), stagedOutput);
    const stat = await fs.promises.lstat(stagedOutput);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      throw playbackError('FFmpeg produced an empty playback file');
    }
    await fs.promises.chmod(stagedOutput, 0o600);
    await fs.promises.rename(stagedOutput, cachePath);
    return cachePath;
  } finally {
    await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function openHlsPlaybackFile(options) {
  const source = await options.openResource(options.resourceId);
  if (!source) return null;
  const extension = path.extname(source.fileName).toLowerCase();
  const sourceSha256 = source.sha256;
  const sourceFileName = source.fileName;
  await source.fileHandle.close();
  if (extension !== '.m3u8') {
    throw playbackError('FFmpeg playback preparation is only available for HLS resources');
  }
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
    throw playbackError('Managed HLS resource has an invalid content hash');
  }

  const cachePath = path.join(
    playbackCacheDirectory(options.taskId),
    `${PLAYBACK_CACHE_VERSION}-${sourceSha256}.mp4`,
  );
  let materialization = playbackMaterializations.get(cachePath);
  if (!materialization) {
    materialization = materializePlaybackFile(options, cachePath)
      .finally(() => playbackMaterializations.delete(cachePath));
    playbackMaterializations.set(cachePath, materialization);
  }
  await materialization;

  const opened = await openRegularFileForRead(cachePath, {
    label: 'Report media playback cache',
  });
  if (opened.bytes === 0) {
    await opened.handle.close();
    throw playbackError('Playback cache file is empty');
  }
  return {
    fileHandle: opened.handle,
    bytes: opened.bytes,
    fileName: `${path.basename(sourceFileName, extension)}.mp4`,
    mediaType: 'video/mp4',
  };
}

module.exports = {
  openHlsPlaybackFile,
};
