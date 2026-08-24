'use strict';

const crypto = require('crypto');
const packageManifest = require('../package.json');

const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function expectedReleaseId(environment = process.env) {
  return String(environment.CODEX_RELEASE_ID || '').trim();
}

function createReleaseInfo(environment = process.env, now = new Date()) {
  const releaseId = expectedReleaseId(environment);
  if (releaseId && !RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error('CODEX_RELEASE_ID must use 1-128 letters, numbers, dots, underscores, or hyphens');
  }
  return Object.freeze({
    version: packageManifest.version,
    releaseId,
    releaseIdConfigured: Boolean(releaseId),
    startedAt: new Date(now).toISOString(),
    instanceId: crypto.randomUUID(),
  });
}

function matchesExpectedRelease(release, environment = process.env) {
  const expected = expectedReleaseId(environment);
  if (!expected) return true;
  return release?.releaseIdConfigured === true && release.releaseId === expected;
}

function releaseExpectationMismatch(release, environment = process.env) {
  const expected = expectedReleaseId(environment);
  if (!expected || matchesExpectedRelease(release, environment)) return null;
  return {
    expectedReleaseId: expected,
    actualReleaseId: typeof release?.releaseId === 'string' ? release.releaseId : '',
    releaseIdConfigured: release?.releaseIdConfigured === true,
  };
}

module.exports = {
  createReleaseInfo,
  expectedReleaseId,
  matchesExpectedRelease,
  releaseExpectationMismatch,
};
