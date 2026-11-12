const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const CODEX_HOME = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(os.homedir(), '.codex');
const SCRIPT = process.env.CODEX_TASK_API_SKILL_SCRIPT || path.join(
  CODEX_HOME,
  'skills',
  'codex-task-platform-api',
  'scripts',
  'codex_task_api.js',
);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-api-skill-'));
const archiveFile = path.join(tempDir, 'skill.zip');
const requests = [];
let server;
let baseUrl;

fs.writeFileSync(archiveFile, Buffer.from('zip-contract-payload'));

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT_DIR,
      env: { ...process.env, CODEX_TASK_API_URL: baseUrl, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function runCliWithClosedOutput(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT_DIR,
      env: { ...process.env, CODEX_TASK_API_URL: baseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.once('data', () => child.stdout.destroy());
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stderr }));
  });
}

test.before(async () => {
  server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body,
    });
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-request-id', request.headers['x-request-id'] || 'mock-request');
    if (request.url === '/api/release-cycles/wait-cycle' && request.method === 'DELETE') {
      response.statusCode = 202;
      response.end(JSON.stringify({ ok: true, deleted: false, deletionId: 'deletion-fixture' })); return;
    }
    if (request.url === '/api/release-cycle-deletions/deletion-fixture') {
      response.end(JSON.stringify({ ok: true, deleted: true, deletionId: 'deletion-fixture', deletedTasks: 2 })); return;
    }
    if (request.url.startsWith('/api/release-cycles')) {
      response.end(JSON.stringify({ method: request.method, url: request.url, body: body.length ? JSON.parse(body) : null }));
      return;
    }
    if (request.url.startsWith('/api/sessions?')) {
      response.end('[]'); return;
    }
    if (request.url === '/api/health') {
      response.end(JSON.stringify({ ok: true, runtime: { bridgeAvailable: true } }));
      return;
    }
    if (request.url === '/api/ready') {
      response.end(JSON.stringify({ ok: true, ready: true, runtime: { ready: true } }));
      return;
    }
    if (request.url === '/api/runtime/bridge-sessions' && request.method === 'GET') {
      response.end(JSON.stringify({
        summary: { total: 1, reclaimable: 1, categories: { orphan: 1 } },
        sessions: [{ sessionId: 'session-0123456789abcdef', category: 'orphan', reclaimable: true }],
      }));
      return;
    }
    if (request.url === '/api/runtime/bridge-sessions/session-0123456789abcdef/reclaim'
      && request.method === 'POST') {
      response.statusCode = 202;
      response.end(JSON.stringify({ ok: true, job: { id: 'bridge-cleanup-test', status: 'pending' } }));
      return;
    }
    if (request.url === '/api/backups' && request.method === 'GET') {
      response.end(JSON.stringify({ status: { backupCount: 1 }, backups: [{ id: 'db-20260803T052808572Z-f7001e70' }] }));
      return;
    }
    if (request.url === '/api/backups' && request.method === 'POST') {
      response.statusCode = 201;
      response.end(JSON.stringify({ ok: true, backup: { id: 'db-20260803T052808572Z-f7001e70' } }));
      return;
    }
    if (request.url === '/api/backups/db-20260803T052808572Z-f7001e70/verify' && request.method === 'POST') {
      response.end(JSON.stringify({ id: 'db-20260803T052808572Z-f7001e70', ok: true }));
      return;
    }
    if (request.url === '/api/recovery-checkpoints' && request.method === 'GET') {
      response.end(JSON.stringify({
        status: { checkpointCount: 1, sensitive: true },
        checkpoints: [{ id: 'recovery-20260803T060204169Z-6b3f034b', sensitive: true }],
      }));
      return;
    }
    if (request.url === '/api/recovery-checkpoints' && request.method === 'POST') {
      response.statusCode = 201;
      response.end(JSON.stringify({
        ok: true,
        checkpoint: { id: 'recovery-20260803T060204169Z-6b3f034b', sensitive: true },
      }));
      return;
    }
    if (request.url === '/api/recovery-checkpoints/recovery-20260803T060204169Z-6b3f034b/verify'
      && request.method === 'POST') {
      response.end(JSON.stringify({ id: 'recovery-20260803T060204169Z-6b3f034b', ok: true, sensitive: true }));
      return;
    }
    if (request.url === '/api/sessions/task-1/run' && request.method === 'POST') {
      response.statusCode = 202;
      response.end(JSON.stringify({ id: 'task-1', status: 'queued' }));
      return;
    }
    if (request.url === '/api/sessions/task-1/stop' && request.method === 'POST') {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === '/api/sessions/task-1/restore' && request.method === 'POST') {
      response.end(JSON.stringify({ id: 'task-1', status: 'waiting_input' }));
      return;
    }
    if (request.url === '/api/sessions/start' && request.method === 'POST') {
      response.statusCode = 202;
      response.end(JSON.stringify({ id: 'atomic-task', status: 'queued' }));
      return;
    }
    if (request.url === '/api/sessions/task-1' && request.method === 'PUT') {
      response.end(JSON.stringify({ id: 'task-1', project: 'converter', tags: ['smoke', 'regression'] }));
      return;
    }
    if (request.url === '/api/sessions/task-1/attempts/attempt-1/stdout') {
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end(Buffer.from('RAW\0OUTPUT\n'));
      return;
    }
    if (request.url === '/api/sessions/task-1/attempts/attempt-1/stderr') {
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end();
      return;
    }
    if (request.url === '/api/sessions/task-1/skill-reports?limit=20&offset=5&history=1') {
      response.end(JSON.stringify([{
        id: 'skill-report-1', reportKey: 'cloud-recording:curated-3', revision: 2,
        skillId: 'cloud-recording-test', status: 'partial',
      }]));
      return;
    }
    if (request.url === '/api/sessions/task-1/skill-invocations?limit=20&offset=5&turnId=turn-1') {
      response.end(JSON.stringify([{
        id: 'skill-invocation-1', status: 'succeeded',
        skills: [{ skillId: 'cloud-recording-test', version: 1 }],
      }]));
      return;
    }
    if (request.url === '/api/sessions') {
      response.end(JSON.stringify([{ id: 'large-output', notes: 'x'.repeat(4 * 1024 * 1024) }]));
      return;
    }
    if (request.url === '/api/skills/import?overwrite=true' && request.method === 'POST') {
      response.statusCode = 201;
      response.end(JSON.stringify({ ok: true, count: 1 }));
      return;
    }
    response.statusCode = 409;
    response.end(JSON.stringify({ error: 'mock conflict' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('API Skill CLI sends typed authenticated requests and preserves failure semantics', async () => {
  const health = await runCli(['--compact', 'health'], {
    CODEX_TASK_API_USER: 'operator',
    CODEX_TASK_API_PASSWORD: 'secret',
  });
  assert.equal(health.status, 0, health.stderr);
  assert.deepEqual(JSON.parse(health.stdout), { ok: true, runtime: { bridgeAvailable: true } });
  assert.equal(requests.at(-1).headers.authorization, `Basic ${Buffer.from('operator:secret').toString('base64')}`);

  const ready = await runCli(['--compact', 'ready']);
  assert.equal(ready.status, 0, ready.stderr);
  assert.deepEqual(JSON.parse(ready.stdout), { ok: true, ready: true, runtime: { ready: true } });
  assert.equal(requests.at(-1).url, '/api/ready');

  const bridgeInventory = await runCli(['--compact', 'bridge-session', 'list']);
  assert.equal(bridgeInventory.status, 0, bridgeInventory.stderr);
  assert.equal(JSON.parse(bridgeInventory.stdout).summary.categories.orphan, 1);
  assert.equal(requests.at(-1).url, '/api/runtime/bridge-sessions');

  const requestCountBeforeBridgeConfirmation = requests.length;
  const unconfirmedBridgeReclaim = await runCli([
    'bridge-session', 'reclaim', 'session-0123456789abcdef',
  ]);
  assert.equal(unconfirmedBridgeReclaim.status, 64);
  assert.match(unconfirmedBridgeReclaim.stderr, /requires explicit confirmation with --yes/);
  assert.equal(requests.length, requestCountBeforeBridgeConfirmation);

  const invalidBridgeReclaim = await runCli([
    'bridge-session', 'reclaim', 'session-ABC', '--yes',
  ]);
  assert.equal(invalidBridgeReclaim.status, 64);
  assert.match(invalidBridgeReclaim.stderr, /16 lowercase hex/);
  assert.equal(requests.length, requestCountBeforeBridgeConfirmation);

  const bridgeReclaim = await runCli([
    '--compact', 'bridge-session', 'reclaim', 'session-0123456789abcdef', '--yes',
  ]);
  assert.equal(bridgeReclaim.status, 0, bridgeReclaim.stderr);
  assert.equal(JSON.parse(bridgeReclaim.stdout).job.status, 'pending');
  const bridgeReclaimRequest = requests.at(-1);
  assert.equal(bridgeReclaimRequest.method, 'POST');
  assert.deepEqual(JSON.parse(bridgeReclaimRequest.body.toString()), {
    confirmationSessionId: 'session-0123456789abcdef',
  });

  const backupList = await runCli(['--compact', 'backup', 'list']);
  assert.equal(backupList.status, 0, backupList.stderr);
  assert.equal(JSON.parse(backupList.stdout).status.backupCount, 1);

  const backupCreate = await runCli(['--compact', 'backup', 'create']);
  assert.equal(backupCreate.status, 0, backupCreate.stderr);
  assert.equal(JSON.parse(backupCreate.stdout).backup.id, 'db-20260803T052808572Z-f7001e70');
  assert.equal(requests.at(-1).method, 'POST');

  const backupVerify = await runCli(['--compact', 'backup', 'verify', 'db-20260803T052808572Z-f7001e70']);
  assert.equal(backupVerify.status, 0, backupVerify.stderr);
  assert.equal(JSON.parse(backupVerify.stdout).ok, true);

  const recoveryList = await runCli(['--compact', 'recovery', 'list']);
  assert.equal(recoveryList.status, 0, recoveryList.stderr);
  assert.equal(JSON.parse(recoveryList.stdout).status.checkpointCount, 1);

  const recoveryCreate = await runCli(['--compact', 'recovery', 'create']);
  assert.equal(recoveryCreate.status, 0, recoveryCreate.stderr);
  assert.equal(JSON.parse(recoveryCreate.stdout).checkpoint.id, 'recovery-20260803T060204169Z-6b3f034b');
  assert.equal(requests.at(-1).method, 'POST');

  const recoveryVerify = await runCli([
    '--compact', 'recovery', 'verify', 'recovery-20260803T060204169Z-6b3f034b',
  ]);
  assert.equal(recoveryVerify.status, 0, recoveryVerify.stderr);
  assert.equal(JSON.parse(recoveryVerify.stdout).ok, true);

  const atomicCreate = await runCli([
    'task', 'create', '--start', '--idempotency-key', 'atomic-task-create',
    '--id', 'atomic-task', '--name', 'Atomic task', '--objective', 'Create and start once.',
    '--working-dir', '.', '--project', 'cloudRecord', '--tags', 'release,nightly',
    '--max-retries', '2', '--auto-resume', 'true',
  ]);
  assert.equal(atomicCreate.status, 0, atomicCreate.stderr);
  assert.equal(JSON.parse(atomicCreate.stdout).status, 'queued');
  const atomicCreateRequest = requests.at(-1);
  assert.equal(atomicCreateRequest.url, '/api/sessions/start');
  assert.deepEqual(JSON.parse(atomicCreateRequest.body.toString()), {
    id: 'atomic-task',
    name: 'Atomic task',
    objective: 'Create and start once.',
    workingDir: '.',
    project: 'cloudRecord',
    tags: 'release,nightly',
    maxRetries: 2,
    autoResume: true,
    idempotencyKey: 'atomic-task-create',
  });
  const requestCountBeforeMissingCreateKey = requests.length;
  const missingCreateKey = await runCli([
    'task', 'create', '--start', '--id', 'invalid-atomic-task',
    '--name', 'Invalid atomic task', '--objective', 'Must not be sent.',
  ]);
  assert.equal(missingCreateKey.status, 64);
  assert.match(missingCreateKey.stderr, /--idempotency-key is required with --start/);
  assert.equal(requests.length, requestCountBeforeMissingCreateKey);

  const updatedTask = await runCli([
    'task', 'update', 'task-1', '--project', 'converter', '--tags', 'smoke,regression',
  ]);
  assert.equal(updatedTask.status, 0, updatedTask.stderr);
  assert.equal(JSON.parse(updatedTask.stdout).project, 'converter');
  const updateRequest = requests.at(-1);
  assert.equal(updateRequest.url, '/api/sessions/task-1');
  assert.deepEqual(JSON.parse(updateRequest.body.toString()), {
    project: 'converter', tags: 'smoke,regression',
  });

  const run = await runCli([
    'task', 'run', 'task-1', '--input', 'Verify state',
    '--idempotency-key', 'task-1-turn-1', '--request-id', 'cli-contract-run',
  ]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).status, 'queued');
  const runRequest = requests.at(-1);
  assert.equal(runRequest.headers['x-request-id'], 'cli-contract-run');
  assert.deepEqual(JSON.parse(runRequest.body.toString()), {
    input: 'Verify state',
    idempotencyKey: 'task-1-turn-1',
  });

  const stop = await runCli([
    'task', 'stop', 'task-1', '--yes', '--idempotency-key', 'task-1-stop-1',
    '--task-created-at', '2026-08-03T00:00:00.000Z',
  ]);
  assert.equal(stop.status, 0, stop.stderr);
  assert.deepEqual(JSON.parse(stop.stdout), { ok: true });
  const stopRequest = requests.at(-1);
  assert.equal(stopRequest.headers['idempotency-key'], 'task-1-stop-1');
  assert.equal(stopRequest.headers['x-task-created-at'], '2026-08-03T00:00:00.000Z');

  const restore = await runCli([
    'task', 'restore', 'task-1', '--yes', '--idempotency-key', 'task-1-restore-1',
    '--task-created-at', '2026-08-03T00:00:00.000Z',
  ]);
  assert.equal(restore.status, 0, restore.stderr);
  assert.equal(JSON.parse(restore.stdout).status, 'waiting_input');
  const restoreRequest = requests.at(-1);
  assert.equal(restoreRequest.url, '/api/sessions/task-1/restore');
  assert.equal(restoreRequest.headers['idempotency-key'], 'task-1-restore-1');

  const rawStdout = await runCli(['task', 'attempt-output', 'task-1', 'attempt-1', '--stream', 'stdout']);
  assert.equal(rawStdout.status, 0, rawStdout.stderr);
  assert.equal(rawStdout.stdout, 'RAW\0OUTPUT\n');
  const rawStderr = await runCli(['task', 'attempt-output', 'task-1', 'attempt-1', '--stream', 'stderr']);
  assert.equal(rawStderr.status, 0, rawStderr.stderr);
  assert.equal(rawStderr.stdout, '');

  const reports = await runCli([
    '--compact', 'task', 'skill-reports', 'task-1',
    '--limit', '20', '--offset', '5', '--history',
  ]);
  assert.equal(reports.status, 0, reports.stderr);
  assert.equal(JSON.parse(reports.stdout)[0].revision, 2);
  assert.equal(requests.at(-1).url, '/api/sessions/task-1/skill-reports?limit=20&offset=5&history=1');

  const invocations = await runCli([
    '--compact', 'task', 'skill-invocations', 'task-1',
    '--limit', '20', '--offset', '5', '--turn-id', 'turn-1',
  ]);
  assert.equal(invocations.status, 0, invocations.stderr);
  assert.equal(JSON.parse(invocations.stdout)[0].id, 'skill-invocation-1');
  assert.equal(requests.at(-1).url, '/api/sessions/task-1/skill-invocations?limit=20&offset=5&turnId=turn-1');

  const requestCount = requests.length;
  const unconfirmed = await runCli(['task', 'delete', 'task-1']);
  assert.equal(unconfirmed.status, 64);
  assert.match(unconfirmed.stderr, /requires explicit confirmation with --yes/);
  assert.equal(requests.length, requestCount);

  const imported = await runCli([
    'skill', 'import', '--file', archiveFile, '--overwrite', 'true', '--yes',
  ]);
  assert.equal(imported.status, 0, imported.stderr);
  const importRequest = requests.at(-1);
  assert.equal(importRequest.headers['content-type'], 'application/zip');
  assert.deepEqual(importRequest.body, fs.readFileSync(archiveFile));

  const conflict = await runCli(['task', 'get', 'missing-task']);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /HTTP 409: mock conflict \(request mock-request\)/);
});

test('API Skill CLI exits cleanly when a downstream pipe closes early', async () => {
  const result = await runCliWithClosedOutput(['task', 'list']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
});

test('version cycle CLI carries templates, Cron, series filters and deletion identity through the API', async () => {
  const template = path.join(tempDir, 'task-template.json');
  fs.writeFileSync(template, JSON.stringify({ name: 'Hourly sample', objective: 'Collect and sample two normal cases per Task',
    workspaceMode: 'shared', sourceMode: 'shared-repo' }));
  const created = await runCli(['release-cycle', 'create', '--id', 'hourly-cycle', '--name', 'Hourly normal',
    '--release-key', 'hourly-normal', '--project', 'cloudRecord', '--workflow', 'cloud-recording-normal-sample',
    '--task-template-file', template, '--cron', '17 * * * *', '--timezone', 'Asia/Shanghai',
    '--overlap-policy', 'queue', '--misfire-policy', 'once', '--idempotency-key', 'create-hourly']);
  assert.equal(created.status, 0, created.stderr);
  const createRequest = requests.at(-1);
  assert.equal(createRequest.url, '/api/release-cycles');
  assert.equal(createRequest.method, 'POST');
  assert.equal(createRequest.headers['idempotency-key'], 'create-hourly');
  const body = JSON.parse(createRequest.body);
  assert.equal(body.taskTemplate.objective, 'Collect and sample two normal cases per Task');
  assert.deepEqual(body.schedule, { cron: '17 * * * *', timezone: 'Asia/Shanghai', overlapPolicy: 'queue', misfirePolicy: 'once' });

  for (const [args, method, url] of [
    [['list', '--project', 'cloudRecord', '--status', 'active,closed'], 'GET', '/api/release-cycles?project=cloudRecord&status=active%2Cclosed'],
    [['get', 'hourly-cycle'], 'GET', '/api/release-cycles/hourly-cycle'],
    [['tasks', 'hourly-cycle', '--limit', '5', '--offset', '1', '--status', 'running'], 'GET', '/api/release-cycles/hourly-cycle/tasks?limit=5&offset=1&status=running'],
    [['close', 'hourly-cycle'], 'POST', '/api/release-cycles/hourly-cycle/close'],
  ]) {
    const response = await runCli(['release-cycle', ...args]);
    assert.equal(response.status, 0, response.stderr);
    assert.equal(requests.at(-1).method, method); assert.equal(requests.at(-1).url, url);
  }
  const scheduled = await runCli(['release-cycle', 'schedule-create', 'hourly-cycle', '--id', 'hourly-plan',
    '--cron', '17 * * * *', '--timezone', 'Asia/Shanghai', '--enabled', 'false', '--overlap-policy', 'skip']);
  assert.equal(scheduled.status, 0, scheduled.stderr);
  assert.equal(requests.at(-1).url, '/api/release-cycles/hourly-cycle/schedules');
  assert.deepEqual(JSON.parse(requests.at(-1).body), { id: 'hourly-plan', cron: '17 * * * *', timezone: 'Asia/Shanghai', enabled: false, overlapPolicy: 'skip' });

  const count = requests.length;
  const missingKey = await runCli(['release-cycle', 'run', 'hourly-cycle']);
  assert.equal(missingKey.status, 64); assert.equal(requests.length, count);
  const run = await runCli(['release-cycle', 'run', 'hourly-cycle', '--task-id', 'sample-task', '--idempotency-key', 'sample-first']);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(requests.at(-1).body), { taskId: 'sample-task', idempotencyKey: 'sample-first' });
  const removed = await runCli(['release-cycle', 'delete', 'hourly-cycle', '--idempotency-key', 'delete-hourly',
    '--release-cycle-created-at', '2026-11-04T00:00:00.000Z']);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(requests.at(-1).method, 'DELETE');
  assert.equal(requests.at(-1).headers['x-release-cycle-created-at'], '2026-11-04T00:00:00.000Z');
  assert.equal(requests.at(-1).headers['idempotency-key'], 'delete-hourly');

  const linked = await runCli(['task', 'create', '--start', '--id', 'atomic-task', '--name', 'Linked task',
    '--objective', 'Sample two normal cases', '--release-cycle-id', 'hourly-cycle', '--idempotency-key', 'linked-create']);
  assert.equal(linked.status, 0, linked.stderr);
  assert.equal(JSON.parse(requests.at(-1).body).releaseCycleId, 'hourly-cycle');
  const filtered = await runCli(['task', 'list', '--release-cycle-id', 'hourly-cycle', '--release-key', 'hourly-normal']);
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.equal(requests.at(-1).url, '/api/sessions?releaseCycleId=hourly-cycle&releaseKey=hourly-normal');
  const beforeWait = requests.length;
  const invalidWait = await runCli(['release-cycle', 'delete', 'wait-cycle', '--wait=invalid']);
  assert.equal(invalidWait.status, 64); assert.equal(requests.length, beforeWait);
  const waited = await runCli(['release-cycle', 'delete', 'wait-cycle', '--wait', '--idempotency-key', 'wait-delete']);
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).deletedTasks, 2);
  assert.deepEqual(requests.slice(beforeWait).map(request => [request.method, request.url]), [
    ['DELETE', '/api/release-cycles/wait-cycle'], ['GET', '/api/release-cycle-deletions/deletion-fixture'],
  ]);
  const progress = await runCli(['release-cycle', 'deletion', 'deletion-fixture']);
  assert.equal(progress.status, 0, progress.stderr);
  assert.equal(JSON.parse(progress.stdout).deleted, true);
});
