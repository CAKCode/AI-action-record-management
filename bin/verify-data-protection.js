#!/usr/bin/env node

process.umask(0o077);

function localServiceUrl(environment = process.env) {
  const configuredHost = String(environment.HOST || '127.0.0.1');
  const host = configuredHost === '0.0.0.0'
    ? '127.0.0.1'
    : (configuredHost === '::' ? '::1' : configuredHost);
  const port = Number(environment.PORT || 8091);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function authorizationHeader(environment = process.env) {
  const user = String(environment.CODEX_DESK_AUTH_USER || '');
  const password = String(environment.CODEX_DESK_AUTH_PASSWORD || '');
  if (Boolean(user) !== Boolean(password)) {
    throw new Error('CODEX_DESK_AUTH_USER and CODEX_DESK_AUTH_PASSWORD must be configured together');
  }
  return user ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : '';
}

async function requestJson(baseUrl, pathname, options = {}) {
  const headers = { accept: 'application/json' };
  if (options.authorization) headers.authorization = options.authorization;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${options.method || 'GET'} ${pathname} returned HTTP ${response.status} without JSON`);
  }
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} returned HTTP ${response.status}: ${String(payload?.error || 'request failed')}`);
  }
  return payload;
}

async function verifyRecords(baseUrl, records, resourcePath, authorization) {
  const summary = {
    total: records.length,
    available: records.filter((record) => record.status === 'available').length,
    invalid: records.filter((record) => record.status !== 'available').length,
    verified: 0,
    failed: 0,
    results: [],
  };
  for (const record of records) {
    if (record.status !== 'available') {
      summary.results.push({ id: record.id, ok: false, error: 'manifest_invalid' });
      continue;
    }
    const verification = await requestJson(
      baseUrl,
      `${resourcePath}/${encodeURIComponent(record.id)}/verify`,
      { method: 'POST', authorization },
    );
    summary.results.push({
      id: record.id,
      ok: verification.ok === true,
      ...(verification.error ? { error: verification.error } : {}),
    });
    if (verification.ok) summary.verified += 1;
    else summary.failed += 1;
  }
  return summary;
}

async function main() {
  if (process.argv.length > 2) {
    throw new Error('verify-data-protection.js does not accept command-line arguments');
  }
  const baseUrl = localServiceUrl();
  const authorization = authorizationHeader();
  const health = await requestJson(baseUrl, '/api/health', { authorization });
  if (health.ok !== true) throw new Error('Service health is not OK; data protection verification was not started');

  const [backupListing, checkpointListing] = await Promise.all([
    requestJson(baseUrl, '/api/backups', { authorization }),
    requestJson(baseUrl, '/api/recovery-checkpoints', { authorization }),
  ]);
  if (!Array.isArray(backupListing.backups) || !Array.isArray(checkpointListing.checkpoints)) {
    throw new Error('Data protection inventory response is invalid');
  }
  const [backups, recoveryCheckpoints] = await Promise.all([
    verifyRecords(baseUrl, backupListing.backups, '/api/backups', authorization),
    verifyRecords(baseUrl, checkpointListing.checkpoints, '/api/recovery-checkpoints', authorization),
  ]);
  const result = {
    ok: backups.invalid === 0 && backups.failed === 0
      && recoveryCheckpoints.invalid === 0 && recoveryCheckpoints.failed === 0,
    checkedAt: new Date().toISOString(),
    release: health.release,
    backups,
    recoveryCheckpoints,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
