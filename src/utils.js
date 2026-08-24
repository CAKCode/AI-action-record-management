const fs = require('fs');
const path = require('path');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function safeId(input, fallback = 'item') {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function appendNdjson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return [];
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readTextTail(filePath, maxBytes = 1024 * 1024) {
  if (!fs.existsSync(filePath)) return '';
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, Math.max(0, Number(maxBytes) || 0));
  if (!length) return '';
  const buffer = Buffer.allocUnsafe(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8');
}

function readNdjsonTail(filePath, limit = 300, maxBytes = 4 * 1024 * 1024) {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  let text = readTextTail(filePath, maxBytes);
  if (stat.size > maxBytes) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
  }
  return text
    .split('\n')
    .filter(Boolean)
    .slice(-Math.max(0, Number(limit) || 0))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function tailSummary(lines, maxLength = 2048) {
  const limit = Math.max(0, Math.floor(Number(maxLength) || 0));
  if (!limit) return '';
  const parts = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = String(lines[index] || '').trim();
    if (!candidate) continue;
    parts.unshift(candidate);
    if (parts.join(' ').length >= limit) break;
  }
  const summary = parts.join(' ');
  if (summary.length <= limit) return summary;
  if (limit === 1) return '\u2026';
  return `${summary.slice(0, limit - 1).trimEnd()}\u2026`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  nowIso,
  ensureDir,
  readJson,
  writeJson,
  safeId,
  unique,
  toArray,
  deepClone,
  appendNdjson,
  readNdjson,
  readTextTail,
  readNdjsonTail,
  stripAnsi,
  tailSummary,
  sleep,
};
