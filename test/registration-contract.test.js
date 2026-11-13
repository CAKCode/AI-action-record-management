const test = require('node:test');
const assert = require('node:assert/strict');
const { registrationEnvelope } = require('../src/registration-contract');

test('registration envelopes expose one stable identity contract', () => {
  assert.deepEqual(registrationEnvelope('external-attempt', {
    taskId: 'task-a', externalAttemptId: 'external-a', stepRunId: 'run-a',
  }), {
    schemaVersion: 1,
    registrationType: 'external-attempt',
    taskId: 'task-a', externalAttemptId: 'external-a', stepRunId: 'run-a',
  });
});
