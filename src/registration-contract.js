'use strict';

const REGISTRATION_SCHEMA_VERSION = 1;

function registrationEnvelope(registrationType, fields = {}) {
  return {
    schemaVersion: REGISTRATION_SCHEMA_VERSION,
    registrationType,
    ...fields,
  };
}

function writeRegistrationResult(result, legacyLines = []) {
  const useJson = result.json === true;
  const payload = { ...result };
  delete payload.json;
  process.stdout.write(useJson
    ? `${JSON.stringify(payload)}\n`
    : `${legacyLines.join('\n')}\n`);
}

module.exports = { registrationEnvelope, writeRegistrationResult };
