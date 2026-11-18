'use strict';

const { TASK_FIELD_LIMITS } = require('./validation');

function invalidRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400, expected: true });
}

/**
 * Resolve the idempotency key used by a mutating API operation.
 *
 * The header is canonical. The body field remains supported for existing
 * callers, and the server-supplied operation id gives keyless requests a
 * unique operation identity without reusing a caller-supplied trace ID.
 */
function requestIdempotencyKey(options = {}) {
  const headerValue = options.headerValue == null ? '' : options.headerValue;
  const body = options.body;
  const bodyValue = body == null ? undefined : body?.idempotencyKey;
  if (bodyValue != null && typeof bodyValue !== 'string') {
    throw invalidRequest('idempotencyKey must be a string');
  }
  if (headerValue != null && typeof headerValue !== 'string') {
    throw invalidRequest('Idempotency-Key must be a string');
  }
  const header = String(headerValue || '').trim();
  const bodyKey = String(bodyValue || '').trim();
  const maxLength = Number(options.maxLength || TASK_FIELD_LIMITS.idempotencyKey);
  if (header.length > maxLength) {
    throw invalidRequest(`Idempotency-Key exceeds the maximum length of ${maxLength}`);
  }
  if (bodyKey.length > maxLength) {
    throw invalidRequest(`idempotencyKey exceeds the maximum length of ${maxLength}`);
  }
  return header || bodyKey || String(options.fallbackValue || '').trim();
}

module.exports = {
  requestIdempotencyKey,
};
