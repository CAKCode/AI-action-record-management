const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { spawn } = require('node:child_process');
const http = require('node:http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-workspace-'));
const dataDir = path.join(tempDir, 'data');
const runtimeDir = path.join(tempDir, 'runtime');
const workspaceRoot = path.join(tempDir, 'workspace');
const sourceRoot = path.join(tempDir, 'session-root');
for (const directory of [dataDir, runtimeDir, workspaceRoot, sourceRoot]) fs.mkdirSync(directory, { recursive: true });
process.env.CODEX_DESK_DATA_DIR = dataDir;
process.env.CODEX_DESK_RUNTIME_DIR = runtimeDir;
process.env.CODEX_TASK_WORKSPACE_ROOTS = `${workspaceRoot}${path.delimiter}${sourceRoot}`;
process.env.CODEX_TASK_SESSIONS_DIR = sourceRoot;
process.env.CODEX_ALLOW_ROOT_EXECUTION = '1';

const store = require('../src/store');
const { closeDatabase, getDatabase } = require('../src/database');
const { taskSessionPaths } = require('../src/task-session-workspace');

function prepareSource(session) {
  fs.mkdirSync(session.sourceRoot, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', session.sourceRoot, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(session.sourceRoot, 'case.py'), 'def test_case(): pass\n');
  git('add', 'case.py');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(session.sessionRoot, 'source-manifest.json'), JSON.stringify({
    schema_version: 1, task_id: session.id, source_root: session.sourceRoot, commit,
  }));
  return { commit, ...store.updateTaskSourceMetadata(session.id, {}) };
}

test('session-clone Tasks allocate independent source and output roots', () => {
  const taskId = 'release-session-workspace';
  const session = store.saveSession(taskId, {
    name: 'Release source session',
    objective: 'Use an isolated source checkout.',
    workingDir: '.',
    workspaceMode: 'session-clone',
    sourceMode: 'session-clone',
  });
  const paths = taskSessionPaths(taskId);
  assert.equal(session.workspaceMode, 'session-clone');
  assert.equal(session.archiveMode, 'in-place');
  assert.equal(session.archiveState, 'active');
  assert.equal(session.workingDir, paths.root);
  assert.equal(session.sessionRoot, paths.root);
  assert.equal(session.sourceRoot, paths.source);
  assert.equal(fs.statSync(paths.root).isDirectory(), true);
  assert.equal(fs.statSync(paths.output).isDirectory(), true);
  assert.equal(fs.existsSync(paths.source), false);
});

test('text snapshots publish concurrently, preserve older content and reject a corrupt cache', async () => {
  const id = 'release-text-snapshots';
  const session = store.saveSession(id, { name: id, objective: 'Snapshot publication', workspaceMode: 'session-clone' });
  const source = path.join(session.sessionRoot, 'report.html');
  const first = Buffer.from('<html>first published document</html>');
  fs.writeFileSync(source, first);
  const results = await Promise.all(Array.from({ length: 8 }, () => store.snapshotInPlaceArtifactText(id, source, first)));
  assert.equal(new Set(results).size, 1);
  assert.equal(path.extname(results[0]), '.snapshot');
  assert.deepEqual(fs.readFileSync(results[0]), first);
  const second = Buffer.from('<html>later document</html>');
  fs.writeFileSync(source, second);
  const next = await store.snapshotInPlaceArtifactText(id, source, second);
  assert.notEqual(next, results[0]);
  assert.deepEqual(fs.readFileSync(results[0]), first);
  fs.appendFileSync(next, 'corrupt');
  await assert.rejects(() => store.snapshotInPlaceArtifactText(id, source, second), /integrity verification/);
});

test('source metadata records commit and manifest without changing shared Tasks', () => {
  const taskId = 'release-source-metadata';
  const session = store.saveSession(taskId, {
    name: 'Source metadata',
    objective: 'Record a frozen source.',
    workingDir: workspaceRoot,
    workspaceMode: 'session-clone',
  });
  const source = prepareSource(session);
  const updated = store.updateTaskSourceMetadata(taskId, {
    sourceRoot: session.sourceRoot,
    sourceMode: 'session-clone',
    sourceCommit: source.commit,
    sourceManifestHash: source.sourceManifestHash,
    archiveState: 'pending',
  });
  assert.equal(updated.sourceCommit, source.commit);
  assert.equal(updated.sourceManifestHash.length, 64);
  assert.equal(updated.archiveState, 'pending');

  const shared = store.saveSession('legacy-shared-workspace', {
    name: 'Shared business test',
    objective: 'Keep legacy behavior.',
    workingDir: workspaceRoot,
  });
  assert.equal(shared.workspaceMode, 'shared');
  assert.equal(shared.archiveMode, 'managed-copy');
  assert.equal(shared.sourceMode, 'shared-repo');
});

test('in-place report indexes preserve original media and survive seal, restore, and Task deletion', async () => {
  const id = 'release-in-place';
  const session = store.saveSession(id, { name: id, objective: 'Test Session artifacts', workspaceMode: 'session-clone' });
  prepareSource(session);
  store.saveSkill('session-report', { name: 'Session report', content: '---\nname: session-report\ndescription: Test reporting\n---\n# Test', description: 'Test' });
  store.ensureTaskSkillSnapshot(id);
  store.queueSessionRun(id, 'run', 'in-place-run');
  const workerId = 'in-place-worker';
  const command = store.claimPendingCommands(workerId, 10).find(c => c.task_id === id);
  store.acquireTaskLease(id, workerId);
  const runtime = store.beginSessionTurn({ taskId: id, workerId, commandId: command.id, input: 'run',
    persistentSessionKey: `single:${id}`, createInitialAttempt: true });
  const run = path.join(session.sessionRoot, 'task', 'initial');
  fs.mkdirSync(path.join(run, 'report'), { recursive: true });
  fs.mkdirSync(path.join(run, 'videos'), { recursive: true });
  const video = path.join(run, 'videos', 'clip.ts');
  fs.writeFileSync(video, 'only physical video copy');
  fs.writeFileSync(path.join(run, 'videos', 'clip.m3u8'), '#EXTM3U\nclip.ts\n');
  const html = path.join(run, 'report', 'initial.html');
  const sourceDirectory = path.join(run, 'report', 'initial.case-sources');
  fs.mkdirSync(sourceDirectory);
  const sourceScript = 'window.__pytestHtmlCaseSourceLoaded({id:"case1",source:"def test_case(): pass"});';
  fs.writeFileSync(path.join(sourceDirectory, 'case1.js'), sourceScript);
  const checkDir = path.join(run, 'report', 'checks');
  fs.mkdirSync(path.join(checkDir, 'details'), { recursive: true });
  const summary = { run_id: 'check-run', complete: true, cases: { case1: { status: 'PASS', detail_source: 'details/case1.js' } } };
  fs.writeFileSync(path.join(checkDir, 'results.js'), `window.__pytestVideoCheck = ${JSON.stringify(summary)};`);
  fs.writeFileSync(path.join(checkDir, 'results.json'), JSON.stringify(summary));
  fs.writeFileSync(path.join(checkDir, 'details', 'case1.js'), 'window.__pytestVideoCheckDetails={case1:{run_id:"check-run",case_id:"case1",detail:{status:"PASS"}}};');
  fs.writeFileSync(path.join(checkDir, 'details', 'case1.json'), '{"status":"PASS"}');
  const blob = JSON.stringify({ videoCheck: { run_id: 'check-run', source: 'checks/results.js' } }).replace(/"/g, '&quot;');
  fs.writeFileSync(html, `<!doctype html><html><body><a href="../videos/clip.m3u8" data-case-source="initial.case-sources/case1.js">video</a><div data-jsonblob="${blob}"></div>`
    + `<script id="video-check-snapshot" type="application/json">${JSON.stringify(summary)}</script></body></html>`);
  const originalInode = fs.statSync(video).ino;
  const base = path.join(run, 'pytest');
  fs.writeFileSync(base + '.log', 'pytest output\n');
  fs.writeFileSync(base + '.cmd', `pytest tests --html ${html}`);
  fs.writeFileSync(base + '.state', 'finished');
  fs.writeFileSync(base + '.done', '0');
  fs.writeFileSync(base + '.meta', JSON.stringify({ work_dir: session.sessionRoot }));
  const external = store.registerExternalAttempt({ taskId: id, turnId: runtime.turn.id, attemptId: runtime.attemptId,
    workingDirectory: session.sessionRoot, pid: 999999984, logPath: base + '.log', donePath: base + '.done',
    statePath: base + '.state', metaPath: base + '.meta', stepKey: 'normal', runKey: 'initial', runKind: 'initial',
    artifacts: [{ key: 'html', kind: 'pytest-html', path: html }] });
  const report = store.publishSkillReport(id, { schemaVersion: 2, reportKey: 'in-place:initial', skillId: 'session-report',
    reportType: 'test-result', title: 'Test result', status: 'succeeded', summary: 'Passed',
    executionEvidence: { externalAttemptId: external.id }, artifacts: [{ key: 'html', kind: 'pytest-html', path: html }],
    sections: [{ id: 'result', title: 'Result', kind: 'fields', priority: 'primary',
      fields: [{ label: 'Passed', value: 1, format: 'text' }] }], metrics: [] }, { turnId: runtime.turn.id, attemptId: runtime.attemptId });
  const archived = await store.archiveSkillReportArtifacts(id, report.id);
  const artifact = archived.artifacts[0];
  assert.equal(artifact.storageMode, 'in-place');
  assert.equal(fs.statSync(video).ino, originalInode);
  assert.equal(fs.existsSync(path.join(dataDir, 'sessions', id, 'skill-report-artifacts', report.id, artifact.id + '.html')), false);
  const resources = getDatabase().prepare('SELECT * FROM skill_report_artifact_resources WHERE artifact_id=?').all(artifact.id);
  assert.equal(resources.length, 7);
  assert.ok(resources.every(r => r.managed_path.startsWith(session.sessionRoot)));
  const registeredDocument = getDatabase().prepare('SELECT managed_path FROM skill_report_artifacts WHERE id=?').get(artifact.id);
  assert.notEqual(registeredDocument.managed_path, html);
  assert.equal(path.extname(registeredDocument.managed_path), '.snapshot');
  assert.equal(path.dirname(registeredDocument.managed_path), path.dirname(html));
  // Later report and source-script processing must not alter the published revision.
  fs.appendFileSync(html, '<!-- source updated after registration -->');
  fs.writeFileSync(path.join(sourceDirectory, 'case1.js'), 'window.sourceChangedAfterRegistration=true;');
  const opened = await store.openSkillReportArtifactFile(id, report.id, artifact.id);
  assert.match(opened.content.toString(), /\/resources\/report-resource-/);
  assert.doesNotMatch(opened.content.toString(), /source updated after registration/);
  const sourceResource = resources.find(r => r.resource_key.endsWith('initial.case-sources/case1.js'));
  const retainedSource = await store.openSkillReportArtifactResourceFile(id, report.id, artifact.id, sourceResource.id);
  try { assert.equal(await retainedSource.fileHandle.readFile('utf8'), sourceScript); }
  finally { await retainedSource.fileHandle.close(); }
  const snapshotBytes = fs.readFileSync(registeredDocument.managed_path);
  fs.appendFileSync(registeredDocument.managed_path, 'unexpected mutation');
  await assert.rejects(() => store.openSkillReportArtifactFile(id, report.id, artifact.id), /integrity verification/);
  fs.writeFileSync(registeredDocument.managed_path, snapshotBytes);
  const { readVideoCheckReport, readVideoCheckSummaryScript } = require('../src/pytest-video-check');
  const check = readVideoCheckReport(opened.content.toString());
  const results = resources.find(r => r.file_name === 'results.js');
  const resultFile = await store.openSkillReportArtifactResourceFile(id, report.id, artifact.id, results.id);
  assert.equal(readVideoCheckSummaryScript(resultFile.content.toString()).cases.case1.detail_source,
    check.snapshot.cases.case1.detail_source);
  const manifest = resources.find(r => r.file_name.endsWith('.m3u8'));
  const media = await store.openSkillReportArtifactResourceFile(id, report.id, artifact.id, manifest.id);
  assert.match(media.content.toString(), /\/resources\/report-resource-/);
  store.reconcileExternalAttempts(id, { preserveTerminalSchedule: false });
  getDatabase().prepare("UPDATE scheduled_jobs SET status='completed' WHERE task_id=?").run(id);
  store.finalizeSessionTurn({ taskId: id, turnId: runtime.turn.id, attemptId: runtime.attemptId,
    commandId: command.id, workerId, exitCode: 0, summary: 'Passed', finalStatus: 'waiting_review' });
  await store.sealPendingSessionWorkspace(id);
  assert.equal(store.getSession(id).archiveState, 'archived');
  assert.equal(fs.statSync(video).mode & 0o222, 0);
  const sourceFiles = store.listTaskSourceFiles(id);
  assert.ok(sourceFiles.files.some(f => f.path === 'case.py'));
  const sourceFile = await store.openTaskSourceFile(id, 'case.py');
  try { assert.equal(await sourceFile.fileHandle.readFile('utf8'), 'def test_case(): pass\n'); }
  finally { await sourceFile.fileHandle.close(); }
  const listener = http.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), CODEX_DISABLE_WORKER: '1',
      CODEX_DESK_AUTH_USER: 'test', CODEX_DESK_AUTH_PASSWORD: 'source-test',
      CODEX_DB_BACKUP_INTERVAL_HOURS: '0', CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0' },
    stdio: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { Authorization: 'Basic ' + Buffer.from('test:source-test').toString('base64') };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await fetch(baseUrl + '/api/health', { headers }); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(ready);
    const metadata = await fetch(`${baseUrl}/api/sessions/${id}/source`, { headers });
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).sourceCommit, store.getSession(id).sourceCommit);
    const listing = await fetch(`${baseUrl}/api/sessions/${id}/source/files`, { headers });
    assert.equal(listing.status, 200);
    assert.ok((await listing.json()).files.some(f => f.path === 'case.py'));
    const file = await fetch(`${baseUrl}/api/sessions/${id}/source/file?path=case.py`, { headers });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), 'def test_case(): pass\n');
    const viewedReport = await fetch(baseUrl + artifact.url, { headers });
    assert.equal(viewedReport.status, 200);
    const viewedHtml = await viewedReport.text();
    const sourceUrl = /data-case-source="([^"]+)"/.exec(viewedHtml)[1];
    const servedSource = await fetch(baseUrl + sourceUrl);
    assert.equal(servedSource.status, 200);
    assert.equal(await servedSource.text(), sourceScript);
    assert.equal(fs.statSync(path.join(sourceDirectory, 'case1.js')).mode & 0o222, 0);
    const servedCheck = readVideoCheckReport(viewedHtml);
    const servedResults = await fetch(baseUrl + servedCheck.descriptor.source + '?t=123');
    assert.equal(servedResults.status, 200);
    const payload = readVideoCheckSummaryScript(await servedResults.text());
    const directoryUrl = servedCheck.descriptor.source.slice(0, servedCheck.descriptor.source.lastIndexOf('/') + 1);
    const detail = await fetch(baseUrl + directoryUrl + payload.cases.case1.detail_source + '?t=123');
    assert.equal(detail.status, 200);
    assert.match(await detail.text(), /__pytestVideoCheckDetails/);
    const segment = resources.find(r => r.file_name === 'clip.ts');
    const segmentResponse = await fetch(baseUrl + artifact.url + '/resources/' + segment.id,
      { headers: { ...headers, Range: 'bytes=0-3' } });
    assert.equal(segmentResponse.status, 206);
    assert.equal(await segmentResponse.text(), 'only');
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => { if (server.exitCode != null) resolve(); else server.once('exit', resolve); });
  }
  store.queueSessionRun(id, 'continue', 'in-place-continue');
  assert.equal(store.getSession(id).archiveState, 'active');
  assert.notEqual(fs.statSync(session.sourceRoot).mode & 0o200, 0);
  assert.equal(fs.statSync(video).mode & 0o222, 0);
  store.requestSessionStop(id);
  store.deleteSession(id);
  assert.equal(fs.existsSync(session.sessionRoot), false);
  assert.ok(fs.existsSync(workspaceRoot));
});

test.after(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('completed Session archives retain source until the 30-day Task cleanup and leave source links untouched', async () => {
  const id = 'release-session-retention';
  const session = store.saveSession(id, { name: id, objective: 'Retain session source', workspaceMode: 'session-clone' });
  prepareSource(session);
  const retainedVideo = path.join(workspaceRoot, 'source-video.mp4');
  fs.writeFileSync(retainedVideo, 'source video');
  fs.symlinkSync(retainedVideo, path.join(session.sourceRoot, 'source-video-link'));
  getDatabase().prepare("UPDATE tasks SET status='waiting_review', archive_state='pending' WHERE id=?").run(id);
  await store.sealPendingSessionWorkspace(id);
  assert.equal(store.getSession(id).archiveState, 'archived');
  store.completeSession(id);
  assert.equal(store.getSession(id).status, 'completed');
  assert.ok(fs.existsSync(session.sourceRoot));
  getDatabase().prepare("UPDATE tasks SET archived_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(id);
  const result = store.performTaskRetentionCleanup({ owner: 'session-retention-test' });
  assert.equal(result.ok, true);
  assert.equal(store.getSession(id), null);
  assert.equal(fs.existsSync(session.sessionRoot), false);
  assert.equal(fs.readFileSync(retainedVideo, 'utf8'), 'source video');
});
