const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-pytest-summary-'));
for (const name of ['data', 'runtime', 'workspace', 'source', 'skills']) fs.mkdirSync(path.join(root, name));
Object.assign(process.env, {
  CODEX_DESK_DATA_DIR: path.join(root, 'data'), CODEX_DESK_RUNTIME_DIR: path.join(root, 'runtime'),
  CODEX_TASK_WORKSPACE_ROOTS: path.join(root, 'workspace'), SOURCE_CODEX_HOME: path.join(root, 'source'),
  WORKSPACE_CODEX_SKILLS_DIR: path.join(root, 'skills'),
});
const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
const { readTaskPytestSummary } = require('../src/pytest-result-summary');
const taskId = 'summary-fixture';

test.after(() => { closeDatabase(); fs.rmSync(root, { recursive: true, force: true }); });

function publishFixture(id, key, outcomes, revision = 1, reusedPath = '') {
  const filePath = reusedPath || path.join(root, 'workspace', `${id}.html`);
  const payload = { artifacts: [{ key: 'html', kind: 'pytest-html', path: filePath }] };
  const db = getDatabase();
  db.prepare(`INSERT INTO skill_reports(id,task_id,report_key,revision,report_hash,schema_version,
    skill_id,skill_version,skill_content_hash,report_type,status,title,summary,payload_json,published_at)
    VALUES (?,?,?,?,?,2,'fixture-test',1,?,'test-result','failed',?,'fixture',?,?)`)
    .run(id, taskId, key, revision, id, 'a'.repeat(64), key, JSON.stringify(payload), `2026-10-27T12:${String(revision).padStart(2, '0')}:00Z`);
  if (reusedPath) return filePath;
  const tests = Object.fromEntries(Object.entries(outcomes).map(([node, result]) => [node, [{ result }]]));
  const content = `<div data-jsonblob="${JSON.stringify({ tests }).replace(/"/g, '&quot;')}"></div>`;
  fs.writeFileSync(filePath, content);
  db.prepare(`INSERT INTO skill_report_artifacts(id,task_id,report_id,artifact_key,label,kind,file_name,
    media_type,managed_path,bytes,sha256,created_at) VALUES (?,?,?,'html','HTML','pytest-html',?,'text/html',?,?,?,?)`)
    .run(`artifact-${id}`, taskId, id, path.basename(filePath), filePath, Buffer.byteLength(content),
      crypto.createHash('sha256').update(content).digest('hex'), '2026-10-27T12:00:00Z');
  return filePath;
}

test('latest report revisions reuse original artifacts and the read endpoint returns only counts', async () => {
  store.saveSession(taskId, { name: 'Fixture', objective: 'Count reports', workingDir: '.' });
  const initial = publishFixture('initial-1', 'suite:initial', { a: 'Passed', b: 'Failed' });
  publishFixture('initial-2', 'suite:initial', {}, 2, initial);
  publishFixture('rerun', 'suite:rerun-1', { b: 'Passed' }, 3);
  const descriptors = store.listTaskPytestReports(taskId);
  assert.equal(descriptors.length, 2);
  assert.equal(descriptors.some(item => !item.filePath), false);
  const result = await readTaskPytestSummary(descriptors);
  assert.equal(result.complete, true);
  assert.equal(result.cumulative.total, 3);
  assert.equal(result.cumulative.passed, 2);
  assert.equal(result.cumulative.failed, 1);
  assert.equal(result.final.total, 2);
  assert.equal(result.final.passed, 2);
  assert.equal(result.final.failed, 0);

  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  const environment = { ...process.env, HOST: '127.0.0.1', PORT: String(port),
    CODEX_DISABLE_WORKER: '1', CODEX_ALLOW_ROOT_EXECUTION: '1',
    CODEX_DB_BACKUP_INTERVAL_HOURS: '0', CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    CODEX_DESK_AUTH_USER: 'fixture', CODEX_DESK_AUTH_PASSWORD: 'fixture-password',
    BRIDGE_RUNTIME_ROOT: path.join(root, 'runtime', 'bridge'), BRIDGE_CHATFILE_ROOT: path.join(root, 'runtime', 'chatfiles') };
  for (const key of Object.keys(environment)) {
    if (/^CODEX_(REQUIRE_|HOST_LAUNCHER_|WEB_SUPERVISOR_|MANAGED_WEB_SUPERVISOR_)/.test(key)) delete environment[key];
  }
  const server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: environment, stdio: 'ignore' });
  try {
    const headers = { authorization: `Basic ${Buffer.from('fixture:fixture-password').toString('base64')}` };
    let response;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/sessions/${taskId}/pytest-summary`, { headers });
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(response, 'Isolated HTTP server did not start');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.final, result.final);
    assert.equal(JSON.stringify(body).includes(root), false);
    const missing = await fetch(`http://127.0.0.1:${port}/api/sessions/missing/pytest-summary`, { headers });
    assert.equal(missing.status, 404);
  } finally {
    if (server.exitCode == null && server.signalCode == null) {
      const ended = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      await ended;
    }
  }
});
