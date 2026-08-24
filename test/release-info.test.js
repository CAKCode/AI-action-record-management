const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createReleaseInfo,
  expectedReleaseId,
  matchesExpectedRelease,
  releaseExpectationMismatch,
} = require('../src/release-info');

test('release info exposes a safe optional deployment marker and unique instance identity', () => {
  const first = createReleaseInfo({ CODEX_RELEASE_ID: '2026.08.07_rc-1' }, '2026-08-07T12:00:00.000Z');
  const second = createReleaseInfo({ CODEX_RELEASE_ID: '2026.08.07_rc-1' }, '2026-08-07T12:00:00.000Z');

  assert.equal(first.version, '0.1.0');
  assert.equal(first.releaseId, '2026.08.07_rc-1');
  assert.equal(first.releaseIdConfigured, true);
  assert.equal(first.startedAt, '2026-08-07T12:00:00.000Z');
  assert.match(first.instanceId, /^[a-f0-9-]{36}$/);
  assert.notEqual(first.instanceId, second.instanceId);
  assert.throws(
    () => createReleaseInfo({ CODEX_RELEASE_ID: 'unsafe release id' }),
    /CODEX_RELEASE_ID must use/,
  );
});

test('release matching only requires an identity when the deployment configures one', () => {
  assert.equal(expectedReleaseId({ CODEX_RELEASE_ID: ' 2026.08.07_rc-1 ' }), '2026.08.07_rc-1');
  assert.equal(matchesExpectedRelease({}, {}), true);
  assert.equal(matchesExpectedRelease({ releaseIdConfigured: false, releaseId: '' }, {
    CODEX_RELEASE_ID: '2026.08.07_rc-1',
  }), false);
  assert.equal(matchesExpectedRelease({ releaseIdConfigured: true, releaseId: 'different-release' }, {
    CODEX_RELEASE_ID: '2026.08.07_rc-1',
  }), false);
  assert.equal(matchesExpectedRelease({ releaseIdConfigured: true, releaseId: '2026.08.07_rc-1' }, {
    CODEX_RELEASE_ID: '2026.08.07_rc-1',
  }), true);
  assert.deepEqual(releaseExpectationMismatch({ releaseIdConfigured: false, releaseId: '' }, {
    CODEX_RELEASE_ID: '2026.08.07_rc-1',
  }), {
    expectedReleaseId: '2026.08.07_rc-1', actualReleaseId: '', releaseIdConfigured: false,
  });
  assert.equal(releaseExpectationMismatch({ releaseIdConfigured: true, releaseId: '2026.08.07_rc-1' }, {
    CODEX_RELEASE_ID: '2026.08.07_rc-1',
  }), null);
});
