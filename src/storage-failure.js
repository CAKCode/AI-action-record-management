const KNOWN_FAILURE_CODES = [
  ['maintenance lease was lost', 'MAINTENANCE_LEASE_LOST'],
  ['database backup failed consistency checks', 'SNAPSHOT_INTEGRITY_FAILED'],
  ['invalid generated database backup', 'SNAPSHOT_INTEGRITY_FAILED'],
  ['recovery checkpoint database failed consistency checks', 'SNAPSHOT_INTEGRITY_FAILED'],
  ['recovery archive inventory does not match its sources', 'SOURCE_CHANGED_DURING_CHECKPOINT'],
];

function storageFailureAuditPayload(error, fallbackCode) {
  const nativeCode = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  const knownCode = KNOWN_FAILURE_CODES.find(([needle]) => message.includes(needle))?.[1];
  const errorCode = /^[A-Z][A-Z0-9_]{1,63}$/.test(nativeCode)
    ? nativeCode
    : (knownCode || fallbackCode);
  const statusCode = Number(error?.statusCode || 500);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? { errorCode, statusCode }
    : { errorCode, statusCode: 500 };
}

module.exports = { storageFailureAuditPayload };
