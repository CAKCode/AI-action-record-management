const test = require('node:test');
const assert = require('node:assert/strict');
const { requestIdempotencyKey } = require('../src/api-contract');

test('idempotency key resolution is consistent across header, body, and request fallback', () => {
  assert.equal(requestIdempotencyKey({
    headerValue: ' header-key ',
    body: { idempotencyKey: 'body-key' },
    fallbackValue: 'request-key',
  }), 'header-key');
  assert.equal(requestIdempotencyKey({
    body: { idempotencyKey: ' body-key ' },
    fallbackValue: 'request-key',
  }), 'body-key');
  assert.equal(requestIdempotencyKey({ fallbackValue: 'request-key' }), 'request-key');
});

test('idempotency key resolution rejects non-string and oversized values', () => {
  assert.throws(
    () => requestIdempotencyKey({ body: { idempotencyKey: 42 } }),
    error => error.statusCode === 400 && /must be a string/.test(error.message),
  );
  assert.throws(
    () => requestIdempotencyKey({ headerValue: 'x'.repeat(257) }),
    error => error.statusCode === 400 && /maximum length/.test(error.message),
  );
});
