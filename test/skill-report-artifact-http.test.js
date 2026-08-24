const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitFor(url, options = {}, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { ...options, method: 'HEAD' });
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test('managed pytest HTML artifacts support HEAD without streaming a response body', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-artifact-head-'));
  const dataDir = path.join(root, 'data');
  const runtimeDir = path.join(root, 'runtime');
  const workspaceDir = path.join(root, 'workspace');
  const sourceHome = path.join(root, 'source-home');
  const workspaceSkills = path.join(root, 'workspace-skills');
  for (const directory of [dataDir, runtimeDir, workspaceDir, sourceHome, workspaceSkills]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const port = await availablePort();
  const taskId = 'artifact-head-task';
  const reportId = 'skill-report-artifact-head';
  const artifactId = 'report-artifact-head';
  const resourceId = 'report-resource-head';
  const markdownArtifactId = 'failure-analysis-artifact-head';
  const externalAttemptId = 'external-artifact-head';
  const resourceApiPath = `/api/sessions/${taskId}/skill-reports/${reportId}`
    + `/artifacts/${artifactId}/resources/${resourceId}`;
  const html = `<!doctype html><title>Managed artifact</title><iframe src="${resourceApiPath}"></iframe>`;
  const registeredLogReference = 'logs/sample.txt';
  const registeredHtml = `<!doctype html><head><link href="assets/style.css" rel="stylesheet" type="text/css"><script src="assets/app.js"></script></head><body><main id="running">Running artifact</main><iframe src="${registeredLogReference}"></iframe></body>`;
  const registeredLog = 'registered artifact log\n';
  const media = Buffer.from('<!doctype html><style>body{color:white}</style><pre>0123456789</pre>', 'utf8');
  const markdown = '# Failure analysis\n\n- BUG: 1\n';
  const setup = [
    "const crypto = require('crypto');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const store = require('./src/store');",
    "const { getDatabase } = require('./src/database');",
    `const taskId = ${JSON.stringify(taskId)};`,
    `const reportId = ${JSON.stringify(reportId)};`,
    `const artifactId = ${JSON.stringify(artifactId)};`,
    `const resourceId = ${JSON.stringify(resourceId)};`,
    `const markdownArtifactId = ${JSON.stringify(markdownArtifactId)};`,
    `const externalAttemptId = ${JSON.stringify(externalAttemptId)};`,
    `const html = ${JSON.stringify(html)};`,
    `const registeredHtml = ${JSON.stringify(registeredHtml)};`,
    `const registeredLog = ${JSON.stringify(registeredLog)};`,
    `const media = Buffer.from(${JSON.stringify(media.toString('base64'))}, 'base64');`,
    `const markdown = ${JSON.stringify(markdown)};`,
    "store.saveSession(taskId, { name: taskId, objective: 'HTTP artifact contract.', workingDir: process.env.CODEX_TASK_WORKSPACE_ROOTS });",
    "const registeredPath = path.join(process.env.CODEX_TASK_WORKSPACE_ROOTS, 'running.html');",
    "const missingPath = path.join(process.env.CODEX_TASK_WORKSPACE_ROOTS, 'missing.html');",
    "const registeredAssets = path.join(process.env.CODEX_TASK_WORKSPACE_ROOTS, 'assets');",
    "const registeredLogs = path.join(process.env.CODEX_TASK_WORKSPACE_ROOTS, 'logs');",
    "fs.mkdirSync(registeredAssets, { recursive: true, mode: 0o700 });",
    "fs.mkdirSync(registeredLogs, { recursive: true, mode: 0o700 });",
    "fs.writeFileSync(registeredPath, registeredHtml, { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredAssets, 'style.css'), '#running { color: rgb(1, 2, 3); }', { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredAssets, 'app.js'), 'window.__runningArtifactReady = true;', { mode: 0o600 });",
    "fs.writeFileSync(path.join(registeredLogs, 'sample.txt'), registeredLog, { mode: 0o600 });",
    "const artifactDir = path.join(process.env.CODEX_DESK_DATA_DIR, 'sessions', taskId, 'skill-report-artifacts', reportId);",
    "fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });",
    "const artifactPath = path.join(artifactDir, `${artifactId}.html`);",
    "const markdownPath = path.join(artifactDir, `${markdownArtifactId}.md`);",
    "const resourceDir = path.join(artifactDir, `${artifactId}.resources`);",
    "fs.mkdirSync(resourceDir, { recursive: true, mode: 0o700 });",
    "const resourcePath = path.join(resourceDir, `${resourceId}.html`);",
    "fs.writeFileSync(artifactPath, html, { mode: 0o600 });",
    "fs.writeFileSync(markdownPath, markdown, { mode: 0o600 });",
    "fs.writeFileSync(resourcePath, media, { mode: 0o600 });",
    "const hash = crypto.createHash('sha256').update(html).digest('hex');",
    "const markdownHash = crypto.createHash('sha256').update(markdown).digest('hex');",
    "const mediaHash = crypto.createHash('sha256').update(media).digest('hex');",
    "const now = new Date().toISOString();",
    "const db = getDatabase();",
    "db.prepare(`INSERT INTO external_attempts(id, task_id, chain_key, generation, label, status, log_path, artifact_declarations_json, started_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 'running', ?, ?, ?, ?, ?)` )",
    "  .run(externalAttemptId, taskId, 'artifact-http', 'Running report', path.join(process.env.CODEX_TASK_WORKSPACE_ROOTS, 'run.log'), JSON.stringify([{ key: 'normal', kind: 'pytest-html', path: registeredPath }, { key: 'missing', kind: 'pytest-html', path: missingPath }]), now, now, now);",
    "db.prepare(`INSERT INTO skill_reports(id, task_id, turn_id, attempt_id, report_key, revision, report_hash, schema_version, skill_id, skill_version, skill_content_hash, report_type, status, title, summary, payload_json, published_at) VALUES (?, ?, NULL, NULL, ?, 1, ?, 1, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(reportId, taskId, 'head', hash, 'report-skill', hash, 'test-result', 'succeeded', 'Artifact head', 'Artifact HTTP contract.', '{}', now);",
    "db.prepare(`INSERT INTO skill_report_artifacts(id, task_id, report_id, artifact_key, label, kind, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(artifactId, taskId, reportId, 'pytest-html', 'Pytest HTML report', 'pytest-html', 'artifact.html', 'text/html; charset=utf-8', artifactPath, Buffer.byteLength(html), hash, now);",
    "db.prepare(`INSERT INTO skill_report_artifacts(id, task_id, report_id, artifact_key, label, kind, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(markdownArtifactId, taskId, reportId, 'failure-analysis-markdown', 'Failure analysis report', 'failure-analysis-markdown', 'failure-analysis.md', 'text/markdown; charset=utf-8', markdownPath, Buffer.byteLength(markdown), markdownHash, now);",
    "db.prepare(`INSERT INTO skill_report_artifact_resources(id, task_id, report_id, artifact_id, resource_key, file_name, media_type, managed_path, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)",
    "  .run(resourceId, taskId, reportId, artifactId, 'logs/sample.html', 'sample.html', 'text/html; charset=utf-8', resourcePath, media.length, mediaHash, now);",
    "require('./server');",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', setup], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CODEX_REQUIRE_HOST_LAUNCHER: '',
      CODEX_HOST_LAUNCHER_PID: '',
      CODEX_HOST_LAUNCHER_START_TICKS: '',
      CODEX_REQUIRE_WEB_SUPERVISOR: '',
      CODEX_WEB_SUPERVISOR_PID: '',
      CODEX_WEB_SUPERVISOR_START_TICKS: '',
      HOST: '127.0.0.1',
      PORT: String(port),
      CODEX_DESK_DATA_DIR: dataDir,
      CODEX_DESK_RUNTIME_DIR: runtimeDir,
      CODEX_TASK_WORKSPACE_ROOTS: workspaceDir,
      SOURCE_CODEX_HOME: sourceHome,
      WORKSPACE_CODEX_SKILLS_DIR: workspaceSkills,
      CODEX_ALLOW_ROOT_EXECUTION: '1',
      CODEX_DISABLE_WORKER: '1',
      CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
      CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
      CODEX_DESK_AUTH_USER: 'artifact-user',
      CODEX_DESK_AUTH_PASSWORD: 'artifact-password',
    },
    stdio: 'inherit',
  });
  const artifactUrl = `http://127.0.0.1:${port}/api/sessions/${taskId}/skill-reports/${reportId}/artifacts/${artifactId}`;
  const markdownUrl = `http://127.0.0.1:${port}/api/sessions/${taskId}/skill-reports/${reportId}/artifacts/${markdownArtifactId}`;
  const resourceUrl = `${artifactUrl}/resources/${resourceId}`;
  const registeredUrl = `http://127.0.0.1:${port}/api/sessions/${taskId}/external-attempts/${externalAttemptId}/artifacts/normal`;
  const registeredStyleUrl = `${registeredUrl}/resources/assets/style.css`;
  const registeredScriptUrl = `${registeredUrl}/resources/assets/app.js`;
  const registeredLogUrl = `${registeredUrl}/resources/${registeredLogReference}`;
  const missingRegisteredUrl = `http://127.0.0.1:${port}/api/sessions/${taskId}/external-attempts/${externalAttemptId}/artifacts/missing`;
  const unknownRegisteredUrl = `http://127.0.0.1:${port}/api/sessions/${taskId}/external-attempts/${externalAttemptId}/artifacts/unknown`;
  const authorization = `Basic ${Buffer.from('artifact-user:artifact-password').toString('base64')}`;
  const authenticatedFetch = (url, options = {}) => fetch(url, {
    ...options,
    headers: { authorization, ...options.headers },
  });
  try {
    await waitFor(artifactUrl, { headers: { authorization } });
    const head = await authenticatedFetch(artifactUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(head.headers.get('content-disposition'), 'inline; filename="artifact.html"');
    assert.equal(head.headers.get('cache-control'), 'private, no-store');
    assert.equal(head.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(head.headers.get('x-content-type-options'), 'nosniff');
    const contentSecurityPolicy = head.headers.get('content-security-policy');
    assert.match(contentSecurityPolicy, /sandbox allow-scripts/);
    assert.match(contentSecurityPolicy, /default-src 'none'/);
    assert.match(contentSecurityPolicy, /frame-src http: https: data:/);
    assert.doesNotMatch(contentSecurityPolicy, /allow-same-origin/);
    assert.match(contentSecurityPolicy, /media-src 'self'/);
    assert.match(contentSecurityPolicy, /connect-src 'self'/);
    assert.equal(head.headers.get('set-cookie'), null);
    assert.equal(await head.text(), '');

    const get = await authenticatedFetch(artifactUrl);
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-length'), head.headers.get('content-length'));
    assert.equal(get.headers.get('content-security-policy'), contentSecurityPolicy);
    const servedHtml = await get.text();
    assert.notEqual(servedHtml, html);
    const signedResourcePath = /<iframe src="([^"]+)">/.exec(servedHtml)?.[1];
    assert.ok(signedResourcePath);
    const signedResourceUrl = new URL(signedResourcePath, artifactUrl);
    assert.equal(signedResourceUrl.pathname, resourceApiPath);
    assert.match(signedResourceUrl.searchParams.get('codex_report_resource_access'), /^[A-Za-z0-9_-]+$/);
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(servedHtml)));

    const registeredHead = await authenticatedFetch(registeredUrl, { method: 'HEAD' });
    assert.equal(registeredHead.status, 200);
    assert.equal(registeredHead.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(registeredHead.headers.get('content-disposition'), 'inline; filename="running.html"');
    assert.equal(registeredHead.headers.get('cache-control'), 'private, no-store');
    assert.match(registeredHead.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.equal(await registeredHead.text(), '');
    const registeredGet = await authenticatedFetch(registeredUrl);
    assert.equal(registeredGet.status, 200);
    const registeredPreview = await registeredGet.text();
    assert.doesNotMatch(registeredPreview, /<base\b/);
    assert.match(registeredPreview, /<style type="text\/css">#running/);
    assert.match(registeredPreview, /<script>window\.__runningArtifactReady = true;<\/script>/);
    const signedRegisteredLogPath = /<iframe src="([^"]+)">/.exec(registeredPreview)?.[1];
    assert.ok(signedRegisteredLogPath);
    const signedRegisteredLogUrl = new URL(signedRegisteredLogPath, registeredUrl);
    assert.equal(signedRegisteredLogUrl.pathname, new URL(registeredLogUrl).pathname);
    assert.match(
      signedRegisteredLogUrl.searchParams.get('codex_report_resource_access'),
      /^[A-Za-z0-9_-]+$/,
    );
    assert.equal(registeredHead.headers.get('content-length'), String(Buffer.byteLength(registeredPreview)));
    const registeredStyle = await authenticatedFetch(registeredStyleUrl);
    assert.equal(registeredStyle.status, 200);
    assert.equal(registeredStyle.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(await registeredStyle.text(), '#running { color: rgb(1, 2, 3); }');
    const registeredScript = await authenticatedFetch(registeredScriptUrl);
    assert.equal(registeredScript.status, 200);
    assert.equal(registeredScript.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(await registeredScript.text(), 'window.__runningArtifactReady = true;');
    assert.equal((await fetch(registeredLogUrl)).status, 401);
    const registeredLogResponse = await fetch(signedRegisteredLogUrl);
    assert.equal(registeredLogResponse.status, 200);
    assert.equal(await registeredLogResponse.text(), registeredLog);
    const mismatchedRegisteredLogUrl = new URL(`${registeredLogUrl}.other`);
    mismatchedRegisteredLogUrl.search = signedRegisteredLogUrl.search;
    assert.equal((await fetch(mismatchedRegisteredLogUrl)).status, 401);
    assert.equal((await authenticatedFetch(missingRegisteredUrl)).status, 404);
    assert.equal((await authenticatedFetch(unknownRegisteredUrl)).status, 404);

    const markdownHead = await authenticatedFetch(markdownUrl, { method: 'HEAD' });
    assert.equal(markdownHead.status, 200);
    assert.equal(markdownHead.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.equal(markdownHead.headers.get('content-disposition'), 'inline; filename="failure-analysis.md"');
    assert.doesNotMatch(markdownHead.headers.get('content-security-policy'), /sandbox/);
    const markdownGet = await authenticatedFetch(markdownUrl);
    assert.equal(markdownGet.status, 200);
    assert.equal(await markdownGet.text(), markdown);

    assert.equal((await fetch(resourceUrl)).status, 401);
    const resourceHead = await fetch(signedResourceUrl, { method: 'HEAD' });
    assert.equal(resourceHead.status, 200);
    assert.equal(resourceHead.headers.get('x-frame-options'), null);
    assert.match(resourceHead.headers.get('content-security-policy'), /sandbox allow-scripts/);
    assert.match(resourceHead.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/);
    assert.equal(resourceHead.headers.get('accept-ranges'), 'bytes');
    assert.equal(resourceHead.headers.get('content-length'), String(media.length));
    assert.equal(resourceHead.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(resourceHead.headers.get('content-disposition'), 'inline; filename="sample.html"');

    const partial = await fetch(signedResourceUrl, {
      headers: { Range: 'bytes=2-5' },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 2-5/${media.length}`);
    assert.equal(partial.headers.get('content-length'), '4');
    assert.equal(await partial.text(), media.subarray(2, 6).toString('utf8'));

    const suffix = await fetch(signedResourceUrl, {
      headers: { Range: 'bytes=-3' },
    });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), media.subarray(-3).toString('utf8'));

    const unsatisfied = await fetch(signedResourceUrl, {
      headers: { Range: 'bytes=99-100' },
    });
    assert.equal(unsatisfied.status, 416);
    assert.equal(unsatisfied.headers.get('content-range'), `bytes */${media.length}`);
    const unrelatedApiUrl = new URL('/api/health', artifactUrl);
    unrelatedApiUrl.search = signedResourceUrl.search;
    const unauthorizedApi = await fetch(unrelatedApiUrl);
    assert.equal(unauthorizedApi.status, 401);
    const mismatchedResourceUrl = new URL(`${resourceUrl}-other`);
    mismatchedResourceUrl.search = signedResourceUrl.search;
    assert.equal((await fetch(mismatchedResourceUrl)).status, 401);
  } finally {
    await stop(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
