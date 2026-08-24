const path = require('path');
const { TextDecoder } = require('util');
const yauzl = require('yauzl');
const YAML = require('yaml');

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_SKILL_MARKDOWN_BYTES = 768 * 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function archiveError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function normalizeArchivePath(fileName, directory) {
  const value = String(fileName || '');
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)) {
    throw archiveError(`Unsafe ZIP path: ${value || '(empty)'}`);
  }
  const withoutTrailingSlash = directory ? value.replace(/\/+$/, '') : value;
  const segments = withoutTrailingSlash.split('/');
  if (!withoutTrailingSlash || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw archiveError(`Unsafe ZIP path: ${value}`);
  }
  return segments.join('/');
}

function entryKind(entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = unixMode & 0o170000;
  const directory = entry.fileName.endsWith('/') || type === 0o040000;
  if (type === 0o120000) throw archiveError(`Symbolic links are not allowed: ${entry.fileName}`);
  if (type && type !== 0o100000 && type !== 0o040000) {
    throw archiveError(`Unsupported ZIP entry type: ${entry.fileName}`);
  }
  return { directory, mode: unixMode & 0o111 ? 0o755 : 0o644 };
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, zip) => (error ? reject(archiveError(`Invalid ZIP archive: ${error.message}`)) : resolve(zip)));
  });
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(archiveError(`Cannot read ${entry.fileName}: ${error.message}`));
        return;
      }
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) stream.destroy(archiveError(`ZIP file is too large: ${entry.fileName}`));
        else chunks.push(chunk);
      });
      stream.on('error', (streamError) => reject(
        streamError.statusCode ? streamError : archiveError(`Cannot read ${entry.fileName}: ${streamError.message}`),
      ));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function readArchiveEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw archiveError('Skill ZIP is empty');
  if (buffer.length > MAX_ARCHIVE_BYTES) throw archiveError('Skill ZIP exceeds the 8 MiB limit', 413);
  const zip = await openZip(buffer);
  const files = [];
  const paths = new Set();
  let entryCount = 0;
  let expandedSize = 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { zip.close(); } catch {}
      reject(error.statusCode ? error : archiveError(error.message));
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(files);
    });
    zip.on('entry', async (entry) => {
      try {
        entryCount += 1;
        if (entryCount > MAX_FILES) throw archiveError(`Skill ZIP exceeds the ${MAX_FILES}-entry limit`);
        if (entry.generalPurposeBitFlag & 0x1) throw archiveError(`Encrypted ZIP entries are not allowed: ${entry.fileName}`);
        const kind = entryKind(entry);
        const filePath = normalizeArchivePath(entry.fileName, kind.directory);
        if (paths.has(filePath)) throw archiveError(`Duplicate ZIP path: ${filePath}`);
        paths.add(filePath);
        if (!kind.directory) {
          if (entry.uncompressedSize > MAX_FILE_BYTES) throw archiveError(`ZIP file is too large: ${filePath}`);
          expandedSize += entry.uncompressedSize;
          if (expandedSize > MAX_EXPANDED_BYTES) throw archiveError('Skill ZIP exceeds the 16 MiB expanded-size limit');
          const content = await readEntry(zip, entry);
          files.push({ path: filePath, content, mode: kind.mode });
        }
        if (!settled) zip.readEntry();
      } catch (error) {
        fail(error);
      }
    });
    zip.readEntry();
  });
}

function parseSkillFrontmatter(content, archivePath) {
  if (content.length > MAX_SKILL_MARKDOWN_BYTES) throw archiveError(`${archivePath} exceeds the SKILL.md size limit`);
  let markdown;
  try {
    markdown = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw archiveError(`${archivePath} must be valid UTF-8`);
  }
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw archiveError(`${archivePath} requires YAML frontmatter`);
  const document = YAML.parseDocument(match[1], { schema: 'core', maxAliasCount: 10, prettyErrors: false });
  if (document.errors.length) throw archiveError(`${archivePath} has invalid YAML frontmatter: ${document.errors[0].message}`);
  const metadata = document.toJS({ maxAliasCount: 10 });
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw archiveError(`${archivePath} frontmatter must be a mapping`);
  }
  const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
  const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
  if (!name || name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw archiveError(`${archivePath} name must use lowercase letters, digits, and hyphens, with at most 64 characters`);
  }
  if (!description) throw archiveError(`${archivePath} requires a non-empty description`);
  if (!markdown.slice(match[0].length).trim()) throw archiveError(`${archivePath} requires Markdown instructions after frontmatter`);
  return { name, description, markdown };
}

function archiveSkillRoots(files) {
  const roots = files
    .filter((file) => path.posix.basename(file.path) === 'SKILL.md')
    .map((file) => path.posix.dirname(file.path) === '.' ? '' : path.posix.dirname(file.path))
    .sort((left, right) => left.length - right.length || left.localeCompare(right));
  if (!roots.length) throw archiveError('Skill ZIP does not contain SKILL.md');
  for (let index = 0; index < roots.length; index += 1) {
    if (roots.slice(0, index).some((root) => !root || roots[index].startsWith(`${root}/`))) {
      throw archiveError(`Nested Skill roots are not allowed: ${roots[index] || '(archive root)'}`);
    }
  }
  return roots;
}

async function parseSkillArchive(buffer) {
  const files = await readArchiveEntries(buffer);
  const roots = archiveSkillRoots(files);
  const assigned = new Set();
  const skills = roots.map((root) => {
    const prefix = root ? `${root}/` : '';
    const skillFiles = files
      .filter((file) => !root || file.path.startsWith(prefix))
      .map((file) => {
        assigned.add(file.path);
        return { ...file, path: root ? file.path.slice(prefix.length) : file.path };
      });
    const markdownFile = skillFiles.find((file) => file.path === 'SKILL.md');
    const metadata = parseSkillFrontmatter(markdownFile.content, `${prefix}SKILL.md`);
    if (root && path.posix.basename(root) !== metadata.name) {
      throw archiveError(`Skill folder ${path.posix.basename(root)} must match frontmatter name ${metadata.name}`);
    }
    return {
      id: metadata.name,
      name: metadata.name,
      description: metadata.description,
      category: 'Imported',
      tags: [],
      enabled: true,
      content: metadata.markdown,
      files: skillFiles,
    };
  });
  const unassigned = files.find((file) => !assigned.has(file.path));
  if (unassigned) throw archiveError(`ZIP file is outside a Skill folder: ${unassigned.path}`);
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) {
    throw archiveError('Skill ZIP contains duplicate Skill names');
  }
  return skills;
}

module.exports = {
  MAX_ARCHIVE_BYTES,
  MAX_EXPANDED_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  parseSkillArchive,
};
