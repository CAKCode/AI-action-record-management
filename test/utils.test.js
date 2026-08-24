'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tailSummary } = require('../src/utils');
const { storageFailureAuditPayload } = require('../src/storage-failure');

test('task summaries preserve normal final responses and mark actual truncation', () => {
  const finalResponse = 'x'.repeat(977);
  assert.equal(tailSummary([finalResponse]), finalResponse);
  assert.equal(tailSummary(['abcdefgh'], 5), 'abcd\u2026');
});

test('storage failure audit payloads classify known errors without retaining sensitive messages', () => {
  assert.deepEqual(
    storageFailureAuditPayload(new Error('Recovery checkpoint maintenance lease was lost'), 'CHECKPOINT_FAILED'),
    { errorCode: 'MAINTENANCE_LEASE_LOST', statusCode: 500 },
  );
  assert.deepEqual(
    storageFailureAuditPayload(
      Object.assign(new Error('mkdir /private/platform/backups: no space left on device'), { code: 'ENOSPC', statusCode: 507 }),
      'BACKUP_FAILED',
    ),
    { errorCode: 'ENOSPC', statusCode: 507 },
  );
  assert.deepEqual(
    storageFailureAuditPayload(new Error('unexpected /private/platform/path'), 'CHECKPOINT_FAILED'),
    { errorCode: 'CHECKPOINT_FAILED', statusCode: 500 },
  );
});
