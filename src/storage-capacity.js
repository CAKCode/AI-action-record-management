const fs = require('fs');
const {
  DATA_DIR,
  BACKUP_DIR,
  RUNTIME_DIR,
  TASK_WORKSPACE_ROOTS,
} = require('./paths');

const DEFAULT_MIN_FREE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MIN_FREE_PERCENT = 2;

function integerSetting(name, fallback) {
  const raw = String(process.env[name] ?? fallback).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} exceeds the supported integer range`);
  return value;
}

function percentSetting(name, fallback) {
  const raw = String(process.env[name] ?? fallback).trim();
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be a number between 0 and 100`);
  }
  return value;
}

const MIN_FREE_BYTES = integerSetting('CODEX_MIN_FREE_BYTES', DEFAULT_MIN_FREE_BYTES);
const MIN_FREE_PERCENT = percentSetting('CODEX_MIN_FREE_PERCENT', DEFAULT_MIN_FREE_PERCENT);

function capacityTarget(role, targetPath) {
  try {
    fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.W_OK);
    const stat = fs.statfsSync(targetPath, { bigint: true });
    const available = stat.bavail * stat.bsize;
    const total = stat.blocks * stat.bsize;
    const availablePercent = total > 0n
      ? Math.round((Number(available) / Number(total)) * 10000) / 100
      : 0;
    const low = available < BigInt(MIN_FREE_BYTES) || availablePercent < MIN_FREE_PERCENT;
    return {
      role,
      status: low ? 'low' : 'ok',
      writable: true,
      availableBytes: Number(available),
      totalBytes: Number(total),
      availablePercent,
    };
  } catch (error) {
    return {
      role,
      status: 'unavailable',
      writable: false,
      availableBytes: null,
      totalBytes: null,
      availablePercent: null,
      errorCode: String(error?.code || 'UNKNOWN'),
    };
  }
}

function storageCapacityStatus() {
  const targets = [
    { role: 'data', path: DATA_DIR },
    { role: 'backup', path: BACKUP_DIR },
    { role: 'runtime', path: RUNTIME_DIR },
    ...TASK_WORKSPACE_ROOTS
      .filter((root) => {
        try { return fs.statSync(root).isDirectory(); } catch { return false; }
      })
      .map((root, index) => ({ role: `workspace:${index + 1}`, path: root })),
  ].map(({ role, path: targetPath }) => capacityTarget(role, targetPath));
  const low = targets.filter((target) => target.status === 'low').length;
  const unavailable = targets.filter((target) => target.status === 'unavailable').length;
  return {
    ok: low === 0 && unavailable === 0,
    minimumFreeBytes: MIN_FREE_BYTES,
    minimumFreePercent: MIN_FREE_PERCENT,
    low,
    unavailable,
    targets,
  };
}

module.exports = {
  MIN_FREE_BYTES,
  MIN_FREE_PERCENT,
  capacityTarget,
  storageCapacityStatus,
};
