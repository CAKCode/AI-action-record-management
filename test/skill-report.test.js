const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const YAML = require('yaml');

const ROOT_DIR = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-report-'));
const dataDir = path.join(tempDir, 'data');
const runtimeDir = path.join(tempDir, 'runtime');
const workspaceRoot = path.join(tempDir, 'workspaces');
const projectDir = path.join(workspaceRoot, 'project');
const sourceCodexHome = path.join(tempDir, 'codex-home');
const workspaceSkills = path.join(tempDir, 'workspace-skills');
let artifactEvidenceSequence = 0;

for (const directory of [dataDir, runtimeDir, projectDir, sourceCodexHome, workspaceSkills]) {
  fs.mkdirSync(directory, { recursive: true });
}

process.env.CODEX_DESK_DATA_DIR = dataDir;
process.env.CODEX_DESK_RUNTIME_DIR = runtimeDir;
process.env.CODEX_TASK_WORKSPACE_ROOTS = workspaceRoot;
process.env.SOURCE_CODEX_HOME = sourceCodexHome;
process.env.WORKSPACE_CODEX_SKILLS_DIR = workspaceSkills;
process.env.CODEX_ALLOW_ROOT_EXECUTION = '1';

const store = require('../src/store');
const { closeDatabase, getDatabase } = require('../src/database');
const { normalizeSkillReport } = require('../src/skill-report');

function reportFixture(overrides = {}) {
  return {
    schemaVersion: 2,
    reportKey: 'cloud-recording:curated-3',
    skillId: 'report-skill',
    reportType: 'test-result',
    title: 'Cloud recording result',
    status: 'partial',
    summary: 'Three cases completed: 2 passed and 1 failed.',
    observedAt: '2026-08-04T12:14:20.000Z',
    primaryExecution: {
      label: 'Cloud recording pytest',
      command: 'python3 -m pytest -v test_cloud_recording.py --ak <AK_FROM_ENV> --sk <SK_FROM_ENV>',
      workingDirectory: '/home/jenkins/premium_robot',
      commandPath: '/home/jenkins/premium_robot/task/cloud-recording.cmd',
      status: 'partial',
      exitCode: 1,
      startedAt: '2026-08-04T12:11:56.000Z',
      finishedAt: '2026-08-04T12:14:20.000Z',
    },
    artifacts: [],
    metrics: [
      { key: 'passed', label: 'Passed', value: 2, tone: 'success' },
      { key: 'failed', label: 'Failed', value: 1, tone: 'danger' },
      { key: 'duration', label: 'Duration', value: '2m 23s', tone: 'neutral' },
    ],
    sections: [
      {
        id: 'business-result', title: 'Business result', kind: 'fields', priority: 'primary',
        defaultExpanded: true,
        fields: [
          { label: 'Outcome', value: '2 passed / 1 failed', format: 'status', tone: 'warning' },
          { label: 'Failed case', value: 'test_check_ncs[live-uploaded-mix]', format: 'code', tone: 'danger' },
          { label: 'Expected', value: 'serviceType=2', format: 'code' },
          { label: 'Actual', value: 'serviceType=1', format: 'code', tone: 'danger' },
        ],
      },
      {
        id: 'current-state', title: 'Current state', kind: 'fields', priority: 'primary',
        defaultExpanded: true,
        fields: [
          { label: 'Execution', value: 'finished', format: 'status', tone: 'success' },
          { label: 'Exit code', value: 1, format: 'code', tone: 'danger' },
        ],
      },
      {
        id: 'gw-deployment', title: 'GW deployment', kind: 'table', priority: 'supporting',
        defaultExpanded: false,
        columns: [
          { key: 'component', label: 'Component', format: 'text' },
          { key: 'image', label: 'Image', format: 'code' },
          { key: 'match', label: 'Image ID match', format: 'status' },
        ],
        rows: [{ component: 'worker', image: 'registry/gw-worker:v1', match: true }],
      },
      {
        id: 'runtime-evidence', title: 'Runtime evidence', kind: 'fields', priority: 'debug',
        defaultExpanded: false,
        fields: [{ label: 'Log', value: '/tmp/cloud-recording.log', format: 'code' }],
      },
      {
        id: 'raw-payload', title: 'Raw payload', kind: 'json', priority: 'debug',
        defaultExpanded: true,
        data: { status: 'failed', nested: { value: '<script>alert(1)</script>' } },
      },
      {
        id: 'credentials', title: 'Credentials', kind: 'fields', priority: 'debug',
        sensitivity: 'sensitive', defaultExpanded: true,
        fields: [{ label: 'Source', value: 'private-file', format: 'text' }],
      },
    ],
    ...overrides,
  };
}

function createRunningTask(taskId, workerId) {
  store.saveSession(taskId, {
    name: taskId,
    objective: 'Publish structured Skill reports.',
    workingDir: projectDir,
  });
  const snapshot = store.ensureTaskSkillSnapshot(taskId);
  store.queueSessionRun(taskId, 'Publish a report.', `${taskId}:run`);
  const command = store.claimPendingCommands(workerId, 10)
    .find((candidate) => candidate.task_id === taskId);
  assert.ok(command);
  assert.equal(store.acquireTaskLease(taskId, workerId), true);
  const started = store.beginSessionTurn({
    taskId,
    commandId: command.id,
    workerId,
    input: command.input,
    persistentSessionKey: `single:${taskId}`,
    skillSnapshotId: snapshot.id,
    createInitialAttempt: true,
  });
  return { ...started, command, snapshot, workerId };
}

function ensureReportSkill() {
  store.saveSkill('report-skill', {
    name: 'Report Skill',
    description: 'Publishes structured business reports.',
    content: '---\nname: report-skill\ndescription: Publishes structured business reports.\n---\n# Report Skill\n',
  });
}

function ensureCloudRecordingReportSkill() {
  store.saveSkill('cloud-recording-test', {
    name: 'Cloud Recording Test',
    description: 'Runs cloud recording tests and publishes structured results.',
    content: '---\nname: cloud-recording-test\ndescription: Runs cloud recording tests.\n---\n# Cloud Recording Test\n',
  });
}

function registerTrackedPytest(taskId, workingDirectory, options = {}) {
  const basePath = path.join(workingDirectory, options.baseName || 'tracked-pytest');
  const logPath = `${basePath}.log`;
  const commandPath = `${basePath}.cmd`;
  const htmlNames = Array.isArray(options.htmlNames) && options.htmlNames.length
    ? options.htmlNames
    : [options.htmlName || 'tracked-pytest.html'];
  const htmlPaths = htmlNames.map((htmlName) => path.join(workingDirectory, htmlName));
  const command = htmlPaths.map((htmlPath) => (
    `python3 -m pytest tests --html ${JSON.stringify(htmlPath)}`
  )).join(' && ');
  fs.mkdirSync(workingDirectory, { recursive: true });
  fs.writeFileSync(logPath, 'pytest output\n', { mode: 0o600 });
  fs.writeFileSync(commandPath, `${command}\n`, { mode: 0o600 });
  for (const [index, htmlPath] of htmlPaths.entries()) {
    fs.writeFileSync(
      htmlPath,
      `<!doctype html><title>Tracked pytest ${index + 1}</title>`,
      { mode: 0o600 },
    );
  }
  const external = store.registerExternalAttempt({
    taskId,
    turnId: options.runtime?.turn.id,
    attemptId: options.runtime?.attemptId,
    pid: 999999986,
    logPath,
    donePath: `${basePath}.done`,
    statePath: `${basePath}.state`,
    metaPath: `${basePath}.meta`,
    stepKey: options.stepKey || 'normal',
    stepLabel: options.stepLabel || 'Normal',
    runKey: options.runKey || 'initial',
    runKind: options.runKind || 'initial',
    sourceRunKey: options.sourceRunKey,
  });
  fs.writeFileSync(`${basePath}.state`, options.running ? 'running\n' : 'finished\n');
  fs.writeFileSync(`${basePath}.meta`, JSON.stringify({ work_dir: workingDirectory }));
  if (!options.running) fs.writeFileSync(`${basePath}.done`, '1\n');
  return { command, commandPath, external, htmlPath: htmlPaths[0], htmlPaths };
}

function registerArtifactExecution(taskId, runtime, workingDirectory, command, options = {}) {
  artifactEvidenceSequence += 1;
  const basePath = path.join(workingDirectory, `.artifact-evidence-${artifactEvidenceSequence}`);
  fs.mkdirSync(workingDirectory, { recursive: true });
  fs.writeFileSync(`${basePath}.log`, 'pytest output\n', { mode: 0o600 });
  fs.writeFileSync(`${basePath}.cmd`, `${command}\n`, { mode: 0o600 });
  fs.writeFileSync(`${basePath}.state`, options.running ? 'running\n' : 'finished\n');
  fs.writeFileSync(`${basePath}.meta`, JSON.stringify({ work_dir: workingDirectory }));
  if (!options.running) fs.writeFileSync(`${basePath}.done`, `${options.exitCode ?? 1}\n`);
  return store.registerExternalAttempt({
    taskId,
    turnId: runtime.turn.id,
    attemptId: runtime.attemptId,
    pid: 999999985,
    logPath: `${basePath}.log`,
    donePath: `${basePath}.done`,
    statePath: `${basePath}.state`,
    metaPath: `${basePath}.meta`,
    stepKey: options.stepKey || 'normal',
    stepLabel: options.stepLabel || 'Normal',
    runKey: options.runKey || 'initial',
    runKind: options.runKind || 'initial',
    sourceRunKey: options.sourceRunKey,
    artifacts: options.artifacts,
  });
}

function publishArtifactReport(taskId, runtime, input, artifacts, options = {}) {
  const workingDirectory = input.primaryExecution?.workingDirectory || projectDir;
  const external = registerArtifactExecution(
    taskId,
    runtime,
    workingDirectory,
    options.command || input.primaryExecution?.command || 'pytest',
    options,
  );
  const report = store.publishSkillReport(taskId, {
    ...input,
    executionEvidence: { externalAttemptId: external.id },
    artifacts,
  }, { turnId: runtime.turn.id, attemptId: runtime.attemptId });
  return { report, external };
}

function requestJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, payload: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
  });
}

async function waitForApi(port, pathname) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await requestJson(port, pathname);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError || new Error('API did not start');
}

test.after(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Skill report schema preserves useful sections and forces sensitive evidence closed', () => {
  const normalized = normalizeSkillReport(reportFixture());
  assert.equal(normalized.sections.find((section) => section.id === 'business-result').defaultExpanded, true);
  assert.equal(normalized.sections.find((section) => section.id === 'current-state').defaultExpanded, true);
  assert.equal(normalized.sections.find((section) => section.id === 'gw-deployment').defaultExpanded, false);
  assert.equal(normalized.sections.find((section) => section.id === 'raw-payload').defaultExpanded, false);
  assert.equal(normalized.sections.find((section) => section.id === 'credentials').defaultExpanded, false);
  assert.equal(normalized.primaryExecution.command.includes('<AK_FROM_ENV>'), true);
  assert.equal(normalized.primaryExecution.exitCode, 1);
  assert.deepEqual(normalized.artifacts, []);

  const duplicate = reportFixture();
  duplicate.sections[1].id = duplicate.sections[0].id;
  assert.throws(() => normalizeSkillReport(duplicate), /duplicate ids/);
  assert.throws(() => normalizeSkillReport({ ...reportFixture(), schemaVersion: 1 }), /schemaVersion must be 2/);
  assert.throws(() => normalizeSkillReport({ ...reportFixture(), metrics: Array(13).fill({}) }), /metrics exceeds 12/);
  assert.throws(() => normalizeSkillReport(reportFixture({
    primaryExecution: { label: 'pytest', command: 'pytest', status: 'finished' },
  })), /primaryExecution.status has an unsupported value/);
  assert.throws(() => normalizeSkillReport(reportFixture({
    primaryExecution: { label: 'pytest', command: 'pytest', exitCode: 256 },
  })), /primaryExecution.exitCode/);
  assert.throws(() => normalizeSkillReport(reportFixture({
    primaryExecution: { label: 'pytest', command: 'pytest', exitCode: '1' },
  })), /primaryExecution.exitCode/);
  assert.throws(() => normalizeSkillReport({
    ...reportFixture(), artifacts: undefined,
  }), /artifacts must be an array/);
  assert.throws(() => normalizeSkillReport(reportFixture({
    artifacts: [{ key: 'normal', kind: 'pytest-html', path: 'relative.html' }],
  })), /must be an absolute path/);
  assert.throws(() => normalizeSkillReport(reportFixture({
    artifacts: [{ key: 'normal', kind: 'pytest-html', path: '/tmp/normal.html' }],
  })), /executionEvidence is required/);
  assert.throws(() => normalizeSkillReport(reportFixture({
    status: 'running',
    executionEvidence: { externalAttemptId: 'external-running' },
    artifacts: [{ key: 'normal', kind: 'pytest-html', path: '/tmp/normal.html' }],
  })), /running reports cannot declare artifacts/);
});

test('Skill report normalization preserves credential values as test evidence', () => {
  const accessKey = 'report-access-key-secret';
  const secretKey = 'report-secret-key-secret';
  const token = 'report-bearer-token-secret';
  const cookie = 'report-cookie-secret';
  const normalized = normalizeSkillReport(reportFixture({
    title: `Report token=${token}`,
    summary: `Request used https://example.test/api?api_key=${accessKey}`,
    primaryExecution: {
      ...reportFixture().primaryExecution,
      label: `Run password=${secretKey}`,
      command: `pytest --ak ${accessKey} --sk=${secretKey} --token ${token}`,
    },
    metrics: [{ key: 'request', label: `Request token=${token}`, value: `Authorization: Bearer ${token}` }],
    sections: [{
      id: 'evidence', title: `Evidence token=${token}`, kind: 'fields', description: `password=${secretKey}`,
      fields: [{
        label: `Payload token=${token}`,
        value: `{"apiKey":"${accessKey}","secretKey":"${secretKey}"}\nCookie: sid=${cookie}`,
      }],
    }, {
      id: 'raw', title: 'Raw', kind: 'json',
      data: { token, nested: { authorization: `Basic ${token}` } },
    }, {
      id: 'list', title: 'List', kind: 'list',
      items: [{ label: `token=${token}`, value: `password=${secretKey}` }],
    }, {
      id: 'table', title: 'Table', kind: 'table',
      columns: [{ key: 'evidence', label: `Authorization: Basic ${token}` }],
      rows: [{ evidence: `secretKey=${secretKey}` }],
    }],
  }));

  const serialized = JSON.stringify(normalized);
  for (const value of [accessKey, secretKey, token, cookie]) assert.match(serialized, new RegExp(value));
  assert.match(normalized.summary, new RegExp(`api_key=${accessKey}`));
  assert.equal(normalized.title, `Report token=${token}`);
  assert.equal(normalized.primaryExecution.label, `Run password=${secretKey}`);
  assert.equal(normalized.primaryExecution.command, `pytest --ak ${accessKey} --sk=${secretKey} --token ${token}`);
  assert.equal(normalized.metrics[0].label, `Request token=${token}`);
  assert.equal(normalized.metrics[0].value, `Authorization: Bearer ${token}`);
  assert.equal(normalized.sections[0].title, `Evidence token=${token}`);
  assert.equal(normalized.sections[0].description, `password=${secretKey}`);
  assert.equal(normalized.sections[0].fields[0].label, `Payload token=${token}`);
  assert.equal(normalized.sections[0].fields[0].value, `{"apiKey":"${accessKey}","secretKey":"${secretKey}"}\nCookie: sid=${cookie}`);
  assert.deepEqual(normalized.sections[1].data, {
    token, nested: { authorization: `Basic ${token}` },
  });
  assert.deepEqual(normalized.sections[2].items, [{
    label: `token=${token}`, value: `password=${secretKey}`, tone: 'neutral',
  }]);
  assert.equal(normalized.sections[3].columns[0].label, `Authorization: Basic ${token}`);
  assert.equal(normalized.sections[3].rows[0].evidence, `secretKey=${secretKey}`);
});

test('legacy historical report redaction command is read-only', () => {
  ensureReportSkill();
  const runtime = createRunningTask('historical-report-redaction-task', 'historical-report-redaction-worker');
  const published = store.publishSkillReport('historical-report-redaction-task', reportFixture({
    reportKey: 'historical:redaction',
  }), { turnId: runtime.turn.id, attemptId: runtime.attemptId });
  const legacySecret = 'legacy-report-api-key-secret';
  const database = getDatabase();
  const row = database.prepare('SELECT * FROM skill_reports WHERE id=?').get(published.id);
  const legacyReport = JSON.parse(row.payload_json);
  legacyReport.summary = `Historical request api_key=${legacySecret}`;
  legacyReport.sections[0].fields[0].value = `Authorization: Bearer ${legacySecret}`;
  const legacyPayload = JSON.stringify(legacyReport);
  database.prepare('UPDATE skill_reports SET summary=?, payload_json=?, report_hash=? WHERE id=?').run(
    legacyReport.summary,
    legacyPayload,
    'a'.repeat(64),
    published.id,
  );

  const preview = store.redactHistoricalSkillReports({ dryRun: true });
  assert.deepEqual(preview, { scanned: 1, redacted: 0, unchanged: 1 });
  assert.equal(
    database.prepare('SELECT payload_json FROM skill_reports WHERE id=?').get(published.id).payload_json,
    legacyPayload,
  );

  const applied = store.redactHistoricalSkillReports({ actor: 'test:historical-report-redaction' });
  assert.deepEqual(applied, { scanned: 1, redacted: 0, unchanged: 1 });
  const preserved = store.listSkillReports('historical-report-redaction-task')
    .find((report) => report.id === published.id);
  const serialized = JSON.stringify(preserved);
  assert.match(serialized, new RegExp(legacySecret));
  assert.equal(preserved.revision, published.revision);
  assert.match(preserved.summary, new RegExp(`api_key=${legacySecret}`));
  assert.equal(preserved.sections[0].fields[0].value, `Authorization: Bearer ${legacySecret}`);
  assert.equal(preserved.reportHash, 'a'.repeat(64));
  const firstRedactionEvents = store.listSessionWorklogs('historical-report-redaction-task')
    .filter((entry) => entry.kind === 'skill.report.redacted');
  assert.equal(firstRedactionEvents.length, 0);

  const repeated = store.redactHistoricalSkillReports();
  assert.deepEqual(repeated, { scanned: 1, redacted: 0, unchanged: 1 });
  const reopened = store.listSkillReports('historical-report-redaction-task')
    .find((report) => report.id === published.id);
  assert.equal(reopened.reportHash, preserved.reportHash);
  assert.equal(
    store.listSessionWorklogs('historical-report-redaction-task')
      .filter((entry) => entry.kind === 'skill.report.redacted').length,
    0,
  );
});

test('terminal pytest reports archive concrete --html output inside the execution directory', async () => {
  ensureReportSkill();
  const runtime = createRunningTask('pytest-html-artifact-task', 'pytest-html-artifact-worker');
  const reportDirectory = path.join(projectDir, 'reports');
  const htmlPath = path.join(reportDirectory, 'pytest-result.html');
  const html = '<!doctype html><title>Pytest result</title><p>2 passed</p>';
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(htmlPath, html, { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:auto',
    status: 'succeeded',
    summary: 'Two cases passed.',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'python3 -m pytest -v tests --html "reports/pytest-result.html" --self-contained-html',
      workingDirectory: projectDir,
      status: 'succeeded',
      exitCode: 0,
    },
  });
  const { report: published } = publishArtifactReport(
    'pytest-html-artifact-task',
    runtime,
    input,
    [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
    { exitCode: 0 },
  );
  const archived = await store.archiveSkillReportArtifacts(
    'pytest-html-artifact-task',
    published.id,
  );
  assert.equal(archived.artifacts.length, 1);
  const [artifact] = archived.artifacts;
  assert.equal(artifact.kind, 'pytest-html');
  assert.equal(artifact.fileName, 'pytest-result.html');
  assert.equal(artifact.bytes, Buffer.byteLength(html));
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    artifact.url,
    `/api/sessions/pytest-html-artifact-task/skill-reports/${published.id}/artifacts/${artifact.id}`,
  );
  const opened = await store.openSkillReportArtifactFile(
    'pytest-html-artifact-task',
    published.id,
    artifact.id,
  );
  try {
    assert.equal(await opened.fileHandle.readFile('utf8'), html);
  } finally {
    await opened.fileHandle.close();
  }
});

test('stop reconciles terminal evidence and archives registered wrapper HTML artifacts', async () => {
  ensureReportSkill();
  const taskId = 'stop-terminal-artifact-reconciliation-task';
  const runtime = createRunningTask(taskId, 'stop-terminal-artifact-reconciliation-worker');
  const basePath = path.join(projectDir, 'stop-terminal-artifact-reconciliation');
  const htmlPath = path.join(projectDir, 'stop-terminal-artifact-reconciliation.html');
  fs.writeFileSync(`${basePath}.log`, 'pytest wrapper output\n', { mode: 0o600 });
  fs.writeFileSync(`${basePath}.cmd`, `python3 wrapper.py --report ${htmlPath}\n`, { mode: 0o600 });
  fs.writeFileSync(`${basePath}.state`, 'running\n', { mode: 0o600 });
  fs.writeFileSync(`${basePath}.meta`, JSON.stringify({ work_dir: projectDir }), { mode: 0o600 });
  const external = store.registerExternalAttempt({
    taskId,
    turnId: runtime.turn.id,
    attemptId: runtime.attemptId,
    pid: 999999984,
    workingDirectory: projectDir,
    logPath: `${basePath}.log`,
    donePath: `${basePath}.done`,
    statePath: `${basePath}.state`,
    metaPath: `${basePath}.meta`,
    stepKey: 'normal',
    stepLabel: 'Normal',
    runKey: 'initial',
    runKind: 'initial',
    artifacts: [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
  });
  store.publishSkillReport(taskId, reportFixture({
    reportKey: 'pytest-html:stop-reconciliation',
    status: 'running',
    summary: 'Pytest is running.',
    executionEvidence: { externalAttemptId: external.id },
    artifacts: [],
  }), { turnId: runtime.turn.id, attemptId: runtime.attemptId });
  const [runningReport] = store.listSkillReports(taskId);
  assert.deepEqual(runningReport.registeredArtifacts, [{
    key: 'normal',
    kind: 'pytest-html',
    fileName: path.basename(htmlPath),
    executionStatus: 'running',
    url: `/api/sessions/${taskId}/external-attempts/${external.id}/artifacts/normal`,
  }]);
  assert.equal(JSON.stringify(runningReport.registeredArtifacts).includes(projectDir), false);
  const waiting = store.finalizeSessionTurn({
    taskId,
    turnId: runtime.turn.id,
    attemptId: runtime.attemptId,
    commandId: runtime.command.id,
    workerId: runtime.workerId,
    exitCode: 0,
    summary: 'Background pytest launched.',
    finalStatus: 'waiting_review',
    retryCount: 0,
  });
  assert.equal(waiting.status, 'waiting_scheduled');

  fs.writeFileSync(htmlPath, '<!doctype html><title>Finished wrapper report</title>', { mode: 0o600 });
  fs.writeFileSync(`${basePath}.done`, '1\n', { mode: 0o600 });
  fs.writeFileSync(`${basePath}.state`, 'finished\n', { mode: 0o600 });
  fs.writeFileSync(`${basePath}.meta`, JSON.stringify({
    work_dir: projectDir,
    ended_at: new Date().toISOString(),
    exit_code: 1,
  }), { mode: 0o600 });

  assert.equal(store.requestSessionStop(taskId), true);
  assert.equal(store.getExternalAttempt(taskId, external.id).status, 'failed');
  assert.equal(store.getSession(taskId).status, 'stopped');
  const [terminalReport] = store.listSkillReports(taskId);
  assert.equal(terminalReport.status, 'failed');
  assert.deepEqual(terminalReport.artifactDeclarations, [
    { key: 'normal', kind: 'pytest-html', path: htmlPath },
  ]);

  const [job] = store.claimSkillReportArtifactJobs('stop-terminal-artifact-worker', 1);
  assert.equal(job.report_id, terminalReport.id);
  const archived = await store.processSkillReportArtifactJob(
    job.report_id,
    'stop-terminal-artifact-worker',
  );
  assert.equal(archived.ok, true, archived.error);
  const [managedReport] = store.listSkillReports(taskId);
  assert.equal(managedReport.artifacts.length, 1);
  assert.equal(managedReport.artifacts[0].fileName, path.basename(htmlPath));
});

test('one Skill report archives every distinct pytest HTML output with stable identities', async () => {
  ensureReportSkill();
  const taskId = 'pytest-multiple-html-artifact-task';
  const runtime = createRunningTask(taskId, 'pytest-multiple-html-artifact-worker');
  const reportDirectory = path.join(projectDir, 'multiple-html-reports');
  const reportFiles = [
    ['command-first.html', '<!doctype html><title>Command first</title>'],
    ['command-second.html', '<!doctype html><title>Command second</title>'],
    ['declared-third.html', '<!doctype html><title>Declared third</title>'],
  ];
  fs.mkdirSync(reportDirectory, { recursive: true });
  for (const [fileName, content] of reportFiles) {
    fs.writeFileSync(path.join(reportDirectory, fileName), content, { mode: 0o600 });
  }
  const declaredSecondPath = path.join(reportDirectory, reportFiles[1][0]);
  const declaredThirdPath = path.join(reportDirectory, reportFiles[2][0]);
  const input = reportFixture({
    reportKey: 'pytest-html:multiple',
    status: 'succeeded',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: [
        'python3 -m pytest tests/first --html multiple-html-reports/command-first.html',
        'python3 -m pytest tests/second --html=multiple-html-reports/command-second.html',
        'python3 -m pytest tests/third --html=multiple-html-reports/declared-third.html',
      ].join(' && '),
      workingDirectory: projectDir,
      status: 'succeeded',
      exitCode: 0,
    },
    sections: [{
      id: 'runtime-evidence', title: 'Runtime evidence', kind: 'fields', priority: 'debug',
      defaultExpanded: false,
      fields: [
        { label: 'Normal final report', value: declaredSecondPath, format: 'code' },
        { label: 'Long final report', value: declaredThirdPath, format: 'code' },
      ],
    }],
  });
  const artifacts = reportFiles.map(([fileName], index) => ({
    key: ['first', 'normal', 'long'][index],
    kind: 'pytest-html',
    path: path.join(reportDirectory, fileName),
  }));
  const { report: published } = publishArtifactReport(
    taskId, runtime, input, artifacts, { exitCode: 0 },
  );

  const archived = await store.archiveSkillReportArtifacts(taskId, published.id);

  assert.equal(archived.artifacts.length, 3);
  assert.deepEqual(
    archived.artifacts.map((artifact) => artifact.fileName).sort(),
    reportFiles.map(([fileName]) => fileName).sort(),
  );
  assert.equal(new Set(archived.artifacts.map((artifact) => artifact.key)).size, 3);
  assert.equal(
    archived.artifacts.find((artifact) => artifact.fileName === 'command-second.html').key,
    'normal',
  );
  for (const artifact of archived.artifacts) {
    const opened = await store.openSkillReportArtifactFile(taskId, published.id, artifact.id);
    try {
      assert.equal(
        await opened.fileHandle.readFile('utf8'),
        reportFiles.find(([fileName]) => fileName === artifact.fileName)[1],
      );
    } finally {
      await opened.fileHandle.close();
    }
  }

  const repeated = await store.archiveSkillReportArtifacts(taskId, published.id);
  assert.deepEqual(
    repeated.artifacts.map((artifact) => artifact.id).sort(),
    archived.artifacts.map((artifact) => artifact.id).sort(),
  );
  assert.equal(
    store.listSessionWorklogs(taskId)
      .filter((entry) => entry.kind === 'skill.report.artifact.archived').length,
    3,
  );
});

test('invalid pytest HTML outputs do not block other outputs from the same report', async () => {
  ensureReportSkill();
  const taskId = 'pytest-multiple-html-partial-artifact-task';
  const runtime = createRunningTask(taskId, 'pytest-multiple-html-partial-artifact-worker');
  const reportDirectory = path.join(projectDir, 'partial-html-reports');
  const missingPath = path.join(reportDirectory, 'missing.html');
  const oversizedPath = path.join(reportDirectory, 'oversized.html');
  const validPath = path.join(reportDirectory, 'valid.html');
  const validHtml = '<!doctype html><title>Valid report</title>';
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(oversizedPath, '', { mode: 0o600 });
  fs.truncateSync(oversizedPath, (64 * 1024 * 1024) + 1);
  fs.writeFileSync(validPath, validHtml, { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:multiple-partial',
    status: 'failed',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: [
        `pytest tests/missing --html ${JSON.stringify(missingPath)}`,
        `pytest tests/oversized --html ${JSON.stringify(oversizedPath)}`,
        `pytest tests/valid --html ${JSON.stringify(validPath)}`,
      ].join(' && '),
      workingDirectory: projectDir,
      status: 'failed',
      exitCode: 1,
    },
  });
  const { report: published } = publishArtifactReport(taskId, runtime, input, [
    { key: 'missing', kind: 'pytest-html', path: missingPath },
    { key: 'oversized', kind: 'pytest-html', path: oversizedPath },
    { key: 'valid', kind: 'pytest-html', path: validPath },
  ]);

  await assert.rejects(
    store.archiveSkillReportArtifacts(taskId, published.id),
    /Failed to archive 2 of 3 declared artifacts:.*does not exist.*exceeds 67108864 bytes/,
  );

  const [artifact] = store.listSkillReports(taskId)[0].artifacts;
  assert.equal(artifact.fileName, 'valid.html');
  const opened = await store.openSkillReportArtifactFile(taskId, published.id, artifact.id);
  try {
    assert.equal(await opened.fileHandle.readFile('utf8'), validHtml);
  } finally {
    await opened.fileHandle.close();
  }
});

test('archives a declared failure analysis Markdown report alongside pytest HTML', async () => {
  ensureReportSkill();
  const runtime = createRunningTask('failure-analysis-artifact-task', 'failure-analysis-artifact-worker');
  const htmlPath = path.join(projectDir, 'failure-analysis-result.html');
  const markdownPath = path.join(projectDir, 'failure_analysis_result.md');
  fs.writeFileSync(htmlPath, '<!doctype html><title>Pytest result</title>', { mode: 0o600 });
  fs.writeFileSync(markdownPath, '# Failure analysis\n\n- BUG: 1\n', { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'failure-analysis:artifact',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: `python3 -m pytest tests --html ${JSON.stringify(htmlPath)}`,
      workingDirectory: projectDir,
      commandPath: path.join(projectDir, 'failure-analysis.cmd'),
    },
    sections: [{
      id: 'runtime-evidence', title: 'Runtime evidence', kind: 'fields', priority: 'debug',
      defaultExpanded: false,
      fields: [{ label: 'Failure report', value: markdownPath, format: 'code' }],
    }],
  });
  const { report: published } = publishArtifactReport(
    'failure-analysis-artifact-task',
    runtime,
    input,
    [
      { key: 'pytest', kind: 'pytest-html', path: htmlPath },
      { key: 'failure-analysis', kind: 'failure-analysis-markdown', path: markdownPath },
    ],
  );

  const archived = await store.archiveSkillReportArtifacts(
    'failure-analysis-artifact-task',
    published.id,
  );

  assert.equal(archived.artifacts.length, 2);
  const markdown = archived.artifacts.find((artifact) => artifact.kind === 'failure-analysis-markdown');
  assert.ok(markdown);
  assert.equal(markdown.fileName, 'failure_analysis_result.md');
  assert.equal(markdown.mediaType, 'text/markdown; charset=utf-8');
  const opened = await store.openSkillReportArtifactFile(
    'failure-analysis-artifact-task', published.id, markdown.id,
  );
  try {
    assert.equal(await opened.fileHandle.readFile('utf8'), '# Failure analysis\n\n- BUG: 1\n');
  } finally {
    await opened.fileHandle.close();
  }
});

test('terminal tracked pytest authorizes HTML archival outside task workspace roots', async () => {
  ensureReportSkill();
  const taskId = 'pytest-html-tracked-external-task';
  const runtime = createRunningTask(taskId, 'pytest-html-tracked-external-worker');
  const externalDirectory = path.join(tempDir, 'business-checkout', taskId);
  const tracked = registerTrackedPytest(taskId, externalDirectory, { runtime });
  const published = store.publishSkillReport(taskId, reportFixture({
    reportKey: 'pytest-html:tracked-external',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: tracked.command,
      commandPath: tracked.commandPath,
      workingDirectory: externalDirectory,
    },
    executionEvidence: { externalAttemptId: tracked.external.id },
    artifacts: [{ key: 'normal', kind: 'pytest-html', path: tracked.htmlPath }],
  }), { turnId: runtime.turn.id, attemptId: runtime.attemptId });

  const archived = await store.archiveSkillReportArtifacts(taskId, published.id);
  assert.equal(archived.artifacts.length, 1);
  assert.equal(archived.artifacts[0].fileName, path.basename(tracked.htmlPath));
  assert.ok(store.listSessionWorklogs(taskId).some((entry) => (
    entry.kind === 'skill.report.artifact.archived'
      && entry.payload.sourceExternalAttemptId === tracked.external.id
  )));
});

test('terminal tracked pytest authorizes every evidenced HTML outside task workspace roots', async () => {
  ensureReportSkill();
  const taskId = 'pytest-multiple-html-tracked-external-task';
  const runtime = createRunningTask(taskId, 'pytest-multiple-html-tracked-external-worker');
  const externalDirectory = path.join(tempDir, 'business-checkout', taskId);
  const tracked = registerTrackedPytest(taskId, externalDirectory, {
    runtime,
    htmlNames: ['first-external.html', 'second-external.html'],
  });
  const published = store.publishSkillReport(taskId, reportFixture({
    reportKey: 'pytest-html:multiple-tracked-external',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: tracked.command,
      commandPath: tracked.commandPath,
      workingDirectory: externalDirectory,
    },
    executionEvidence: { externalAttemptId: tracked.external.id },
    artifacts: tracked.htmlPaths.map((htmlPath, index) => ({
      key: `report-${index + 1}`, kind: 'pytest-html', path: htmlPath,
    })),
  }), { turnId: runtime.turn.id, attemptId: runtime.attemptId });

  const archived = await store.archiveSkillReportArtifacts(taskId, published.id);

  assert.deepEqual(
    archived.artifacts.map((artifact) => artifact.fileName).sort(),
    tracked.htmlPaths.map((htmlPath) => path.basename(htmlPath)).sort(),
  );
  const archiveEvents = store.listSessionWorklogs(taskId)
    .filter((entry) => entry.kind === 'skill.report.artifact.archived');
  assert.equal(archiveEvents.length, 2);
  assert.equal(archiveEvents.every((entry) => (
    entry.payload.sourceExternalAttemptId === tracked.external.id
  )), true);
});

test('explicit artifact path is validated against its tracked command instead of display fields', async () => {
  ensureReportSkill();
  const taskId = 'pytest-html-declared-external-task';
  const runtime = createRunningTask(taskId, 'pytest-html-declared-external-worker');
  const externalDirectory = path.join(tempDir, 'business-checkout', taskId);
  const tracked = registerTrackedPytest(taskId, externalDirectory, { runtime });
  const input = reportFixture({
    reportKey: 'pytest-html:declared-external',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'python3 -m pytest tests --html <LOCAL_REPORT_OMITTED_OVER_64MB>',
      commandPath: tracked.commandPath,
      workingDirectory: externalDirectory,
    },
    sections: [{
      id: 'runtime-evidence', title: 'Runtime evidence', kind: 'fields', priority: 'debug',
      defaultExpanded: false,
      fields: [{ label: 'Local report path', value: tracked.htmlPath, format: 'code' }],
    }],
  });
  const published = store.publishSkillReport(taskId, {
    ...input,
    executionEvidence: { externalAttemptId: tracked.external.id },
    artifacts: [{ key: 'normal', kind: 'pytest-html', path: tracked.htmlPath }],
  }, {
    turnId: runtime.turn.id,
    attemptId: runtime.attemptId,
  });

  const archived = await store.archiveSkillReportArtifacts(taskId, published.id);

  assert.equal(archived.artifacts.length, 1);
  assert.equal(archived.artifacts[0].kind, 'pytest-html');
  assert.equal(archived.artifacts[0].fileName, path.basename(tracked.htmlPath));

  const untrackedPath = path.join(externalDirectory, 'untracked.html');
  fs.writeFileSync(untrackedPath, '<!doctype html><title>Untracked</title>', { mode: 0o600 });
  const mismatched = store.publishSkillReport(taskId, {
    ...input,
    reportKey: 'pytest-html:declared-external-mismatch',
    executionEvidence: { externalAttemptId: tracked.external.id },
    artifacts: [{ key: 'untracked', kind: 'pytest-html', path: untrackedPath }],
    sections: [{
      ...input.sections[0],
      fields: [{ label: 'Local report path', value: untrackedPath, format: 'code' }],
    }],
  }, { turnId: runtime.turn.id, attemptId: runtime.attemptId });
  await assert.rejects(
    store.archiveSkillReportArtifacts(taskId, mismatched.id),
    /is not an exact --html output/,
  );
});

test('external pytest HTML archival requires matching command and terminal evidence', async () => {
  ensureReportSkill();
  const cases = [
    { suffix: 'command', running: false, wrongPath: true, error: /is not an exact --html output/ },
    { suffix: 'running', running: true, wrongPath: false, error: /must identify a terminal background execution/ },
  ];
  for (const fixture of cases) {
    const taskId = `pytest-html-tracked-${fixture.suffix}-task`;
    const runtime = createRunningTask(taskId, `pytest-html-tracked-${fixture.suffix}-worker`);
    const externalDirectory = path.join(tempDir, 'business-checkout', taskId);
    const tracked = registerTrackedPytest(taskId, externalDirectory, {
      runtime, running: fixture.running,
    });
    const declaredPath = fixture.wrongPath
      ? path.join(externalDirectory, 'not-command-output.html')
      : tracked.htmlPath;
    if (fixture.wrongPath) {
      fs.writeFileSync(declaredPath, '<!doctype html><title>Wrong output</title>', { mode: 0o600 });
    }
    const published = store.publishSkillReport(taskId, reportFixture({
      reportKey: `pytest-html:tracked-${fixture.suffix}`,
      primaryExecution: {
        ...reportFixture().primaryExecution,
        command: tracked.command,
        commandPath: tracked.commandPath,
        workingDirectory: externalDirectory,
      },
      executionEvidence: { externalAttemptId: tracked.external.id },
      artifacts: [{ key: 'normal', kind: 'pytest-html', path: declaredPath }],
    }), { turnId: runtime.turn.id, attemptId: runtime.attemptId });

    await assert.rejects(
      store.archiveSkillReportArtifacts(taskId, published.id),
      fixture.error,
    );
    assert.deepEqual(store.listSkillReports(taskId)[0].artifacts, []);
  }
});

test('artifact execution evidence cannot be reused by another task', async () => {
  ensureReportSkill();
  const ownerRuntime = createRunningTask('artifact-evidence-owner-task', 'artifact-evidence-owner-worker');
  const reportRuntime = createRunningTask('artifact-evidence-other-task', 'artifact-evidence-other-worker');
  const htmlPath = path.join(projectDir, 'cross-task-report.html');
  const command = `pytest -v tests --html ${JSON.stringify(htmlPath)}`;
  fs.writeFileSync(htmlPath, '<!doctype html><title>Cross task</title>', { mode: 0o600 });
  const external = registerArtifactExecution(
    'artifact-evidence-owner-task', ownerRuntime, projectDir, command,
  );
  assert.throws(
    () => store.publishSkillReport('artifact-evidence-other-task', reportFixture({
      reportKey: 'pytest-html:cross-task-evidence',
      executionEvidence: { externalAttemptId: external.id },
      artifacts: [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
      primaryExecution: {
        ...reportFixture().primaryExecution,
        command,
        workingDirectory: projectDir,
      },
    }), { turnId: reportRuntime.turn.id, attemptId: reportRuntime.attemptId }),
    /executionEvidence does not belong to this task/,
  );
});

test('pytest HTML archival embeds local stylesheets and their local assets', async () => {
  ensureReportSkill();
  const runtime = createRunningTask('pytest-html-styles-task', 'pytest-html-styles-worker');
  const reportDirectory = path.join(projectDir, 'styled-report');
  const assetDirectory = path.join(reportDirectory, 'assets');
  const htmlPath = path.join(reportDirectory, 'pytest-result.html');
  const html = [
    '<!doctype html><html><head>',
    '<link media="screen" href="assets/style.css" rel="stylesheet" type="text/css"/>',
    '</head><body><p>2 passed</p>',
    '<script>sessionStorage.setItem("pytest", "ready")</script></body></html>',
  ].join('');
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  fs.mkdirSync(assetDirectory, { recursive: true });
  fs.writeFileSync(htmlPath, html, { mode: 0o600 });
  fs.writeFileSync(
    path.join(assetDirectory, 'style.css'),
    'body { font-family: sans-serif; background-image: url("dot.png"); }',
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(assetDirectory, 'dot.png'), image, { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:styles',
    status: 'succeeded',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'pytest -v tests --html styled-report/pytest-result.html',
      workingDirectory: projectDir,
      status: 'succeeded',
      exitCode: 0,
    },
  });
  const { report: published } = publishArtifactReport(
    'pytest-html-styles-task', runtime, input,
    [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
    { exitCode: 0 },
  );
  const archived = await store.archiveSkillReportArtifacts(
    'pytest-html-styles-task',
    published.id,
  );
  const [artifact] = archived.artifacts;
  const opened = await store.openSkillReportArtifactFile(
    'pytest-html-styles-task',
    published.id,
    artifact.id,
  );
  try {
    const archivedHtml = await opened.fileHandle.readFile('utf8');
    assert.doesNotMatch(archivedHtml, /<link\b/i);
    assert.match(archivedHtml, /<style type="text\/css" media="screen">/);
    assert.match(archivedHtml, /font-family: sans-serif/);
    assert.match(archivedHtml, new RegExp(`data:image/png;base64,${image.toString('base64')}`));
    assert.match(archivedHtml, /<script data-codex-pytest-storage>/);
    assert.equal(
      archivedHtml.indexOf('data-codex-pytest-storage')
        < archivedHtml.indexOf('sessionStorage.setItem'),
      true,
    );
    assert.equal(artifact.bytes, Buffer.byteLength(archivedHtml));
    assert.equal(fs.readFileSync(htmlPath, 'utf8'), html);
  } finally {
    await opened.fileHandle.close();
  }

  const artifactDirectory = path.join(
    dataDir,
    'sessions',
    'pytest-html-styles-task',
    'skill-report-artifacts',
    published.id,
  );
  const artifactPath = path.join(artifactDirectory, `${artifact.id}.html`);
  fs.writeFileSync(artifactPath, html, { mode: 0o600 });
  const database = new Database(path.join(dataDir, 'codex-tasks.db'));
  database.prepare('UPDATE skill_report_artifacts SET bytes=?, sha256=? WHERE id=?').run(
    Buffer.byteLength(html),
    require('node:crypto').createHash('sha256').update(html).digest('hex'),
    artifact.id,
  );
  database.close();

  const repaired = await store.archiveSkillReportArtifacts(
    'pytest-html-styles-task',
    published.id,
  );
  assert.equal(repaired.artifacts[0].bytes > Buffer.byteLength(html), true);
  assert.equal(repaired.artifacts[0].sha256, artifact.sha256);
  const reopened = await store.openSkillReportArtifactFile(
    'pytest-html-styles-task',
    published.id,
    artifact.id,
  );
  try {
    const repairedHtml = await reopened.fileHandle.readFile('utf8');
    assert.doesNotMatch(repairedHtml, /<link\b/i);
    assert.match(repairedHtml, /font-family: sans-serif/);
  } finally {
    await reopened.fileHandle.close();
  }
});

test('pytest HTML archival hosts entity-encoded MP4 and HLS media dependencies', async () => {
  ensureReportSkill();
  const taskId = 'pytest-html-media-task';
  const runtime = createRunningTask(taskId, 'pytest-html-media-worker');
  const reportDirectory = path.join(projectDir, 'media-report');
  const videoDirectory = path.join(projectDir, 'videos', 'media-run');
  const scriptDirectory = path.join(reportDirectory, 'assets', 'video');
  const htmlPath = path.join(reportDirectory, 'pytest-result.html');
  const mp4 = Buffer.from('0123456789abcdef', 'utf8');
  const segment = Buffer.from('hls-segment-bytes', 'utf8');
  fs.mkdirSync(videoDirectory, { recursive: true });
  fs.mkdirSync(scriptDirectory, { recursive: true });
  fs.writeFileSync(path.join(videoDirectory, 'clip.mp4'), mp4, { mode: 0o600 });
  fs.writeFileSync(path.join(videoDirectory, 'segment.ts'), segment, { mode: 0o600 });
  fs.writeFileSync(
    path.join(videoDirectory, 'stream.m3u8'),
    '#EXTM3U\n#EXTINF:1.0,\nsegment.ts\n#EXT-X-ENDLIST\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(scriptDirectory, 'hls.min.js'),
    'window.Hls = { isSupported: function(){ return true; } };',
    { mode: 0o600 },
  );
  const html = [
    '<!doctype html><html><head><script src="assets/video/hls.min.js"></script></head><body>',
    '<div id="data-container" data-jsonblob="{&#34;row&#34;:&#34;',
    '&lt;a href=\\&#34;../videos/media-run/clip.mp4\\&#34; data-src=\\&#34;../videos/media-run/clip.mp4\\&#34;&gt;MP4&lt;/a&gt;',
    '&lt;a href=\\&#34;../videos/media-run/stream.m3u8\\&#34; data-src=\\&#34;../videos/media-run/stream.m3u8\\&#34;&gt;HLS&lt;/a&gt;',
    '&lt;a href=\\&#34;../videos/media-run/missing.mp4\\&#34; data-src=\\&#34;../videos/media-run/missing.mp4\\&#34;&gt;Missing&lt;/a&gt;',
    '&#34;}"></div></body></html>',
  ].join('');
  fs.writeFileSync(htmlPath, html, { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:media',
    status: 'succeeded',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'pytest -v tests --html media-report/pytest-result.html',
      workingDirectory: projectDir,
      status: 'succeeded',
      exitCode: 0,
    },
  });
  const { report: published } = publishArtifactReport(
    taskId, runtime, input,
    [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
    { exitCode: 0 },
  );

  const archived = await store.archiveSkillReportArtifacts(taskId, published.id);
  const [artifact] = archived.artifacts;
  const database = getDatabase();
  const resources = database.prepare(`
    SELECT * FROM skill_report_artifact_resources
    WHERE artifact_id=? ORDER BY file_name
  `).all(artifact.id);
  assert.deepEqual(resources.map((resource) => resource.file_name), [
    'clip.mp4', 'segment.ts', 'stream.m3u8',
  ]);
  assert.equal(new Set(resources.map((resource) => resource.managed_path)).size, 3);

  const opened = await store.openSkillReportArtifactFile(taskId, published.id, artifact.id);
  try {
    const archivedHtml = await opened.fileHandle.readFile('utf8');
    assert.doesNotMatch(archivedHtml, /<script[^>]+src=/i);
    assert.match(archivedHtml, /window\.Hls/);
    assert.doesNotMatch(archivedHtml, /\.\.\/videos\/media-run\/(?:clip\.mp4|stream\.m3u8)/);
    assert.match(archivedHtml, /\.\.\/videos\/media-run\/missing\.mp4/);
    for (const resource of resources.filter(({ file_name: fileName }) => fileName !== 'segment.ts')) {
      assert.match(archivedHtml, new RegExp(`/resources/${resource.id}`));
    }
  } finally {
    await opened.fileHandle.close();
  }

  const manifestRow = resources.find(({ file_name: fileName }) => fileName === 'stream.m3u8');
  const segmentRow = resources.find(({ file_name: fileName }) => fileName === 'segment.ts');
  const manifest = await store.openSkillReportArtifactResourceFile(
    taskId, published.id, artifact.id, manifestRow.id,
  );
  try {
    const content = await manifest.fileHandle.readFile('utf8');
    assert.doesNotMatch(content, /^segment\.ts$/m);
    assert.match(content, new RegExp(`/resources/${segmentRow.id}`));
  } finally {
    await manifest.fileHandle.close();
  }
  const openedMp4 = await store.openSkillReportArtifactResourceFile(
    taskId,
    published.id,
    artifact.id,
    resources.find(({ file_name: fileName }) => fileName === 'clip.mp4').id,
  );
  try {
    assert.deepEqual(await openedMp4.fileHandle.readFile(), mp4);
  } finally {
    await openedMp4.fileHandle.close();
  }
  assert.equal(store.listSessionWorklogs(taskId).some((entry) => (
    entry.kind === 'skill.report.artifact.media_partial'
      && entry.payload?.warningCount === 1
  )), true);
});

test('multiple pytest HTML artifacts isolate media with identical file names', async () => {
  ensureReportSkill();
  const taskId = 'pytest-html-media-isolation-task';
  const runtime = createRunningTask(taskId, 'pytest-html-media-isolation-worker');
  const paths = [];
  for (const suffix of ['normal', 'rerun']) {
    const reportDirectory = path.join(projectDir, `media-${suffix}`);
    const mediaDirectory = path.join(reportDirectory, 'videos');
    const htmlPath = path.join(reportDirectory, `${suffix}.html`);
    fs.mkdirSync(mediaDirectory, { recursive: true });
    fs.writeFileSync(path.join(mediaDirectory, 'same.mp4'), suffix, { mode: 0o600 });
    fs.writeFileSync(
      htmlPath,
      `<!doctype html><a href="videos/same.mp4" data-src="videos/same.mp4">${suffix}</a>`,
      { mode: 0o600 },
    );
    paths.push(htmlPath);
  }
  const input = reportFixture({
    reportKey: 'pytest-html:media-isolation',
    status: 'succeeded',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: `pytest -v tests --html ${paths[0]} --html ${paths[1]}`,
      workingDirectory: projectDir,
      status: 'succeeded',
      exitCode: 0,
    },
  });
  const { report: published } = publishArtifactReport(
    taskId,
    runtime,
    input,
    paths.map((htmlPath, index) => ({
      key: ['normal', 'rerun'][index], kind: 'pytest-html', path: htmlPath,
    })),
    { exitCode: 0 },
  );

  const archived = await store.archiveSkillReportArtifacts(taskId, published.id);
  assert.equal(archived.artifacts.length, 2);
  const resources = getDatabase().prepare(`
    SELECT * FROM skill_report_artifact_resources WHERE report_id=? ORDER BY artifact_id
  `).all(published.id);
  assert.equal(resources.length, 2);
  assert.equal(new Set(resources.map((resource) => resource.artifact_id)).size, 2);
  assert.equal(new Set(resources.map((resource) => resource.id)).size, 2);
  assert.equal(new Set(resources.map((resource) => resource.managed_path)).size, 2);
});

test('pytest HTML archival embeds referenced logtxt files for offline report viewing', async () => {
  ensureReportSkill();
  const runtime = createRunningTask('pytest-html-logtxt-task', 'pytest-html-logtxt-worker');
  const reportDirectory = path.join(projectDir, 'logtxt-report');
  const logDirectory = path.join(reportDirectory, 'logs');
  const htmlPath = path.join(reportDirectory, 'pytest-result.html');
  const logName = 'case___gw13__123.txt';
  const logContent = 'setup failed: <untrusted detail>\n';
  const html = [
    '<!doctype html><html><body>',
    `<button onclick="openLog('logs/${logName}')">Log</button>`,
    `<a href="logs/${logName}">duplicate</a>`,
    ...Array.from({ length: 1024 }, (_, index) => `<a href="logs/${logName}">duplicate-${index}</a>`),
    '</body></html>',
  ].join('');
  fs.mkdirSync(logDirectory, { recursive: true });
  fs.writeFileSync(htmlPath, html, { mode: 0o600 });
  fs.writeFileSync(path.join(logDirectory, logName), logContent, { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:logtxt',
    status: 'failed',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'pytest -v tests --html logtxt-report/pytest-result.html',
      workingDirectory: projectDir,
      status: 'failed',
      exitCode: 1,
    },
  });
  const { report: published } = publishArtifactReport(
    'pytest-html-logtxt-task', runtime, input,
    [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
  );
  const archived = await store.archiveSkillReportArtifacts('pytest-html-logtxt-task', published.id);
  const [artifact] = archived.artifacts;
  const opened = await store.openSkillReportArtifactFile(
    'pytest-html-logtxt-task',
    published.id,
    artifact.id,
  );
  try {
    const archivedHtml = await opened.fileHandle.readFile('utf8');
    const embeddedLog = `data:text/plain;charset=utf-8;base64,${Buffer.from(logContent).toString('base64')}`;
    assert.doesNotMatch(archivedHtml, new RegExp(`logs/${logName}`));
    assert.equal((archivedHtml.match(new RegExp(embeddedLog, 'g')) || []).length, 1026);
    assert.equal(artifact.bytes, Buffer.byteLength(archivedHtml));
  } finally {
    await opened.fileHandle.close();
  }
  assert.equal(fs.readFileSync(htmlPath, 'utf8'), html);
  assert.equal(fs.readFileSync(path.join(logDirectory, logName), 'utf8'), logContent);
});

test('pytest HTML archival preserves referenced HTML logs as managed resources', async () => {
  ensureReportSkill();
  const taskId = 'pytest-html-loghtml-task';
  const runtime = createRunningTask(taskId, 'pytest-html-loghtml-worker');
  const reportDirectory = path.join(projectDir, 'loghtml-report');
  const logDirectory = path.join(reportDirectory, 'logs');
  const htmlPath = path.join(reportDirectory, 'pytest-result.html');
  const logName = 'case___gw13__123.html';
  const logContent = '<!doctype html><style>body{color:white}</style><pre>case log</pre>';
  const html = [
    '<!doctype html><html><body>',
    `<button onclick="openLog('logs/${logName}')">Log</button>`,
    `<a href="logs/${logName}">duplicate</a>`,
    '</body></html>',
  ].join('');
  fs.mkdirSync(logDirectory, { recursive: true });
  fs.writeFileSync(htmlPath, html, { mode: 0o600 });
  fs.writeFileSync(path.join(logDirectory, logName), logContent, { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:loghtml',
    status: 'succeeded',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'pytest -v tests --html loghtml-report/pytest-result.html',
      workingDirectory: projectDir,
      status: 'succeeded',
      exitCode: 0,
    },
  });
  const { report: published } = publishArtifactReport(
    taskId, runtime, input,
    [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
    { exitCode: 0 },
  );

  const archived = await store.archiveSkillReportArtifacts(taskId, published.id);
  const [artifact] = archived.artifacts;
  const [resource] = getDatabase().prepare(`
    SELECT * FROM skill_report_artifact_resources WHERE artifact_id=?
  `).all(artifact.id);
  assert.ok(resource);
  assert.equal(resource.file_name, logName);
  assert.equal(resource.media_type, 'text/html; charset=utf-8');
  const resourceUrl = `/api/sessions/${taskId}/skill-reports/${published.id}`
    + `/artifacts/${artifact.id}/resources/${resource.id}`;
  const opened = await store.openSkillReportArtifactFile(taskId, published.id, artifact.id);
  try {
    const archivedHtml = await opened.fileHandle.readFile('utf8');
    assert.doesNotMatch(archivedHtml, new RegExp(`logs/${logName}`));
    assert.equal((archivedHtml.match(new RegExp(resourceUrl, 'g')) || []).length, 2);
  } finally {
    await opened.fileHandle.close();
  }
  const openedResource = await store.openSkillReportArtifactResourceFile(
    taskId, published.id, artifact.id, resource.id,
  );
  try {
    assert.equal(await openedResource.fileHandle.readFile('utf8'), logContent);
    assert.equal(openedResource.mediaType, 'text/html; charset=utf-8');
  } finally {
    await openedResource.fileHandle.close();
  }
  assert.equal(fs.readFileSync(htmlPath, 'utf8'), html);
  assert.equal(fs.readFileSync(path.join(logDirectory, logName), 'utf8'), logContent);
});

test('pytest HTML remains openable when referenced logs exceed the artifact size limit', async () => {
  ensureReportSkill();
  const taskId = 'pytest-html-large-logtxt-task';
  const runtime = createRunningTask(taskId, 'pytest-html-large-logtxt-worker');
  const reportDirectory = path.join(projectDir, 'large-logtxt-report');
  const logDirectory = path.join(reportDirectory, 'logs');
  const htmlPath = path.join(reportDirectory, 'pytest-result.html');
  const logName = 'large-case___gw13__123.txt';
  const logContent = `${'diagnostic detail '.repeat(16384)}\n`;
  const html = [
    '<!doctype html><html><body>',
    ...Array.from({ length: 300 }, (_, index) => (
      `<a href="logs/${logName}">case-log-${index}</a>`
    )),
    '</body></html>',
  ].join('');
  fs.mkdirSync(logDirectory, { recursive: true });
  fs.writeFileSync(htmlPath, html, { mode: 0o600 });
  fs.writeFileSync(path.join(logDirectory, logName), logContent, { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:large-logtxt',
    status: 'failed',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'pytest -v tests --html large-logtxt-report/pytest-result.html',
      workingDirectory: projectDir,
      status: 'failed',
      exitCode: 1,
    },
  });
  const { report: published } = publishArtifactReport(
    taskId, runtime, input,
    [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
  );

  const archived = await store.archiveSkillReportArtifacts(taskId, published.id);
  const [artifact] = archived.artifacts;
  const opened = await store.openSkillReportArtifactFile(taskId, published.id, artifact.id);
  try {
    const archivedHtml = await opened.fileHandle.readFile('utf8');
    assert.doesNotMatch(archivedHtml, /Log%20omitted%3A%20artifact%20size%20limit/);
    const resources = getDatabase().prepare(`
      SELECT * FROM skill_report_artifact_resources WHERE artifact_id=?
    `).all(artifact.id);
    assert.equal(resources.length, 1);
    const [resource] = resources;
    const resourceUrl = `/api/sessions/${taskId}/skill-reports/${published.id}
      /artifacts/${artifact.id}/resources/${resource.id}`.replace(/\s+/g, '');
    assert.equal((archivedHtml.match(new RegExp(resourceUrl, 'g')) || []).length, 300);
    const openedResource = await store.openSkillReportArtifactResourceFile(
      taskId, published.id, artifact.id, resource.id,
    );
    try {
      assert.equal(await openedResource.fileHandle.readFile('utf8'), logContent);
      assert.equal(openedResource.mediaType, 'text/plain; charset=utf-8');
    } finally {
      await openedResource.fileHandle.close();
    }
    assert.equal(artifact.bytes < 64 * 1024 * 1024, true);
  } finally {
    await opened.fileHandle.close();
  }
  assert.equal(fs.readFileSync(htmlPath, 'utf8'), html);
});

test('pytest HTML archival preserves credentials in report and embedded log evidence', async () => {
  ensureReportSkill();
  const runtime = createRunningTask('pytest-html-redaction-task', 'pytest-html-redaction-worker');
  const reportDirectory = path.join(projectDir, 'redaction-report');
  const logDirectory = path.join(reportDirectory, 'logs');
  const htmlPath = path.join(reportDirectory, 'pytest-result.html');
  const logName = 'case___gw13__456.txt';
  const accessKey = 'artifact-access-key-value';
  const secretKey = 'artifact-secret-key-value';
  const bearerToken = 'artifact-bearer-token-value';
  const basicCredential = 'artifact-basic-credential-value';
  const cookieCredential = 'artifact-cookie-credential-value';
  const logContent = [
    `{"accessKey":"${accessKey}","secretKey":"${secretKey}"}`,
    `Authorization: Bearer ${bearerToken}`,
    `Authorization: Basic ${basicCredential}`,
    `Cookie: session=${cookieCredential}; theme=dark`,
    'ordinary diagnostic detail',
  ].join('\n');
  const html = [
    '<!doctype html><html><body>',
    `<div data-request='{"apiKey":"${accessKey}"}'>Report</div>`,
    `<button onclick="openLog('logs/${logName}')">Log</button>`,
    '</body></html>',
  ].join('');
  fs.mkdirSync(logDirectory, { recursive: true });
  fs.writeFileSync(htmlPath, html, { mode: 0o600 });
  fs.writeFileSync(path.join(logDirectory, logName), logContent, { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:redaction',
    status: 'failed',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'pytest -v tests --html redaction-report/pytest-result.html',
      workingDirectory: projectDir,
      status: 'failed',
      exitCode: 1,
    },
  });
  const { report: published } = publishArtifactReport(
    'pytest-html-redaction-task', runtime, input,
    [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
  );
  const archived = await store.archiveSkillReportArtifacts('pytest-html-redaction-task', published.id);
  const opened = await store.openSkillReportArtifactFile(
    'pytest-html-redaction-task', published.id, archived.artifacts[0].id,
  );
  try {
    const archivedHtml = await opened.fileHandle.readFile('utf8');
    const embeddedLog = Buffer.from(
      archivedHtml.match(/data:text\/plain;charset=utf-8;base64,([A-Za-z0-9+/=]+)/)?.[1] || '',
      'base64',
    ).toString('utf8');
    for (const credential of [accessKey, secretKey, bearerToken, basicCredential, cookieCredential]) {
      assert.match(embeddedLog, new RegExp(credential));
    }
    assert.match(archivedHtml, new RegExp(`apiKey":"${accessKey}`));
    assert.match(embeddedLog, new RegExp(`accessKey":"${accessKey}`));
    assert.match(embeddedLog, new RegExp(`secretKey":"${secretKey}`));
    assert.match(embeddedLog, new RegExp(`Authorization: Bearer ${bearerToken}`));
    assert.match(embeddedLog, new RegExp(`Authorization: Basic ${basicCredential}`));
    assert.match(embeddedLog, new RegExp(`Cookie: session=${cookieCredential}`));
    assert.match(embeddedLog, /ordinary diagnostic detail/);
  } finally {
    await opened.fileHandle.close();
  }
  assert.equal(fs.readFileSync(htmlPath, 'utf8'), html);
  assert.equal(fs.readFileSync(path.join(logDirectory, logName), 'utf8'), logContent);
});

test('pytest HTML archival preserves credentials in pre-embedded log data', async () => {
  ensureReportSkill();
  const runtime = createRunningTask('pytest-html-embedded-redaction-task', 'pytest-html-embedded-redaction-worker');
  const reportDirectory = path.join(projectDir, 'embedded-redaction-report');
  const htmlPath = path.join(reportDirectory, 'pytest-result.html');
  const secret = 'pre-embedded-secret-value';
  const embeddedLog = Buffer.from(`token=${secret}\nvisible detail\n`, 'utf8').toString('base64');
  const html = `<!doctype html><html><body><button onclick="openLog('data:text/plain;charset=utf-8;base64,${embeddedLog}')">Log</button></body></html>`;
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(htmlPath, html, { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:embedded-redaction',
    status: 'failed',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'pytest -v tests --html embedded-redaction-report/pytest-result.html',
      workingDirectory: projectDir,
      status: 'failed',
      exitCode: 1,
    },
  });
  const { report: published } = publishArtifactReport(
    'pytest-html-embedded-redaction-task', runtime, input,
    [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
  );
  const archived = await store.archiveSkillReportArtifacts(
    'pytest-html-embedded-redaction-task', published.id,
  );
  const opened = await store.openSkillReportArtifactFile(
    'pytest-html-embedded-redaction-task', published.id, archived.artifacts[0].id,
  );
  try {
    const archivedHtml = await opened.fileHandle.readFile('utf8');
    const redactedLog = Buffer.from(
      archivedHtml.match(/data:text\/plain;charset=utf-8;base64,([A-Za-z0-9+/=]+)/)?.[1] || '',
      'base64',
    ).toString('utf8');
    assert.match(redactedLog, new RegExp(secret));
    assert.match(redactedLog, new RegExp(`token=${secret}`));
    assert.match(redactedLog, /visible detail/);
  } finally {
    await opened.fileHandle.close();
  }
  assert.equal(fs.readFileSync(htmlPath, 'utf8'), html);
});

test('legacy report artifact redaction command is read-only', async () => {
  ensureReportSkill();
  const runtime = createRunningTask('pytest-html-historical-redaction-task', 'pytest-html-historical-redaction-worker');
  const reportDirectory = path.join(projectDir, 'historical-redaction-report');
  const htmlPath = path.join(reportDirectory, 'pytest-result.html');
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(htmlPath, '<!doctype html><html><body>clean report</body></html>', { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:historical-redaction',
    status: 'failed',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'pytest -v tests --html historical-redaction-report/pytest-result.html',
      workingDirectory: projectDir,
      status: 'failed',
      exitCode: 1,
    },
  });
  const { report: published } = publishArtifactReport(
    'pytest-html-historical-redaction-task', runtime, input,
    [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
  );
  const archived = await store.archiveSkillReportArtifacts(
    'pytest-html-historical-redaction-task', published.id,
  );
  const artifact = archived.artifacts[0];
  const artifactPath = path.join(
    dataDir, 'sessions', 'pytest-html-historical-redaction-task', 'skill-report-artifacts',
    published.id, `${artifact.id}.html`,
  );
  const secret = 'historical-artifact-secret';
  const unsafeContent = Buffer.from(
    `<!doctype html><html><body>token=${secret}</body></html>`,
    'utf8',
  );
  fs.writeFileSync(artifactPath, unsafeContent, { mode: 0o600 });
  const database = new Database(path.join(dataDir, 'codex-tasks.db'));
  try {
    database.prepare('UPDATE skill_report_artifacts SET bytes=?, sha256=? WHERE id=?').run(
      unsafeContent.length,
      require('node:crypto').createHash('sha256').update(unsafeContent).digest('hex'),
      artifact.id,
    );
  } finally {
    database.close();
  }
  const dryRun = await store.redactSkillReportArtifacts({ dryRun: true });
  assert.equal(dryRun.redacted, 0);
  assert.equal(dryRun.unchanged, dryRun.scanned);
  assert.match(fs.readFileSync(artifactPath, 'utf8'), new RegExp(secret));
  const result = await store.redactSkillReportArtifacts();
  assert.deepEqual(result, dryRun);
  const repaired = fs.readFileSync(artifactPath, 'utf8');
  assert.match(repaired, new RegExp(secret));
  const reopened = await store.openSkillReportArtifactFile(
    'pytest-html-historical-redaction-task', published.id, artifact.id,
  );
  try {
    assert.equal(await reopened.fileHandle.readFile('utf8'), repaired);
  } finally {
    await reopened.fileHandle.close();
  }
  assert.equal(
    store.listSkillReports('pytest-html-historical-redaction-task').find((report) => report.id === published.id).reportHash,
    published.reportHash,
  );
  assert.equal(store.listSessionWorklogs('pytest-html-historical-redaction-task').some((entry) => (
    entry.kind === 'skill.report.artifact.redacted'
  )), false);
});

test('pytest HTML archival rejects unsafe or unavailable stylesheet dependencies', async () => {
  ensureReportSkill();
  const cases = [
    {
      suffix: 'missing',
      href: 'assets/missing.css',
      expected: /stylesheet does not exist/,
    },
    {
      suffix: 'escape',
      href: '../../outside-style.css',
      expected: /stylesheet must remain inside the execution working directory/,
      setup() {
        fs.writeFileSync(path.join(workspaceRoot, 'outside-style.css'), 'body {}', { mode: 0o600 });
      },
    },
    {
      suffix: 'symlink',
      href: 'assets/style.css',
      expected: /stylesheet must be a regular file/,
      setup(reportDirectory) {
        const assetDirectory = path.join(reportDirectory, 'assets');
        const target = path.join(reportDirectory, 'real-style.css');
        fs.mkdirSync(assetDirectory, { recursive: true });
        fs.writeFileSync(target, 'body {}', { mode: 0o600 });
        fs.symlinkSync(target, path.join(assetDirectory, 'style.css'));
      },
    },
  ];

  for (const fixture of cases) {
    const taskId = `pytest-html-style-${fixture.suffix}-task`;
    const runtime = createRunningTask(taskId, `pytest-html-style-${fixture.suffix}-worker`);
    const reportDirectory = path.join(projectDir, `unsafe-style-${fixture.suffix}`);
    const htmlPath = path.join(reportDirectory, 'pytest-result.html');
    fs.mkdirSync(reportDirectory, { recursive: true });
    fixture.setup?.(reportDirectory);
    fs.writeFileSync(
      htmlPath,
      `<!doctype html><link rel="stylesheet" href="${fixture.href}"><p>result</p>`,
      { mode: 0o600 },
    );
    const input = reportFixture({
      reportKey: `pytest-html:style-${fixture.suffix}`,
      status: 'succeeded',
      primaryExecution: {
        ...reportFixture().primaryExecution,
        command: `pytest tests --html unsafe-style-${fixture.suffix}/pytest-result.html`,
        workingDirectory: projectDir,
        status: 'succeeded',
        exitCode: 0,
      },
    });
    const { report: published } = publishArtifactReport(
      taskId, runtime, input,
      [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
      { exitCode: 0 },
    );
    await assert.rejects(
      store.archiveSkillReportArtifacts(taskId, published.id),
      fixture.expected,
    );
    assert.deepEqual(store.listSkillReports(taskId)[0].artifacts, []);
  }
});

test('explicit pytest HTML declarations reject paths outside the execution directory', async () => {
  ensureReportSkill();
  const runtime = createRunningTask('pytest-html-escape-task', 'pytest-html-escape-worker');
  const outsidePath = path.join(workspaceRoot, 'outside.html');
  fs.writeFileSync(outsidePath, '<!doctype html><title>Outside</title>', { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:escape',
    status: 'succeeded',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'pytest -v tests --html=../outside.html',
      workingDirectory: projectDir,
      status: 'succeeded',
      exitCode: 0,
    },
  });
  const { report: published } = publishArtifactReport(
    'pytest-html-escape-task', runtime, input,
    [{ key: 'outside', kind: 'pytest-html', path: outsidePath }],
    { exitCode: 0 },
  );
  await assert.rejects(
    store.archiveSkillReportArtifacts('pytest-html-escape-task', published.id),
    /must remain inside its execution working directory/,
  );
  assert.deepEqual(store.listSkillReports('pytest-html-escape-task')[0].artifacts, []);
});

test('commands and Section fields are not used to discover undeclared artifacts', async () => {
  ensureReportSkill();
  const taskId = 'pytest-html-no-discovery-task';
  const runtime = createRunningTask(taskId, 'pytest-html-no-discovery-worker');
  const htmlPath = path.join(projectDir, 'undeclared.html');
  fs.writeFileSync(htmlPath, '<!doctype html><title>Undeclared</title>', { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:no-discovery',
    status: 'failed',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'pytest -v tests --html undeclared.html',
      workingDirectory: projectDir,
      status: 'failed',
      exitCode: 1,
    },
    sections: [{
      id: 'runtime-evidence', title: 'Runtime evidence', kind: 'fields',
      fields: [{ label: 'HTML report path', value: htmlPath, format: 'code' }],
    }],
  });
  const published = store.publishSkillReport(taskId, input, {
    turnId: runtime.turn.id,
    attemptId: runtime.attemptId,
  });
  const archived = await store.archiveSkillReportArtifacts(taskId, published.id);
  assert.deepEqual(archived.artifacts, []);
  assert.deepEqual(archived.artifactDeclarations, []);
});

test('running pytest reports auto-register HTML outputs for terminal reconciliation', async () => {
  ensureReportSkill();
  const taskId = 'pytest-html-auto-registration-task';
  const runtime = createRunningTask(taskId, 'pytest-html-auto-registration-worker');
  const externalDirectory = path.join(tempDir, 'business-checkout', taskId);
  const tracked = registerTrackedPytest(taskId, externalDirectory, {
    runtime,
    running: true,
  });
  // The real detached launcher .cmd usually contains only its wrapper command;
  // the report command is the authoritative source for the pytest HTML path.
  fs.writeFileSync(tracked.commandPath, 'bash /tmp/run-pytest-wrapper.sh\n', { mode: 0o600 });
  const running = store.publishSkillReport(taskId, reportFixture({
    reportKey: 'pytest-html:auto-registration',
    status: 'running',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: tracked.command,
      commandPath: tracked.commandPath,
      workingDirectory: externalDirectory,
      status: 'running',
      exitCode: null,
    },
    executionEvidence: { externalAttemptId: tracked.external.id },
    artifacts: [],
  }), { turnId: runtime.turn.id, attemptId: runtime.attemptId });
  assert.deepEqual(running.artifactDeclarations, []);
  assert.deepEqual(store.getExternalAttempt(taskId, tracked.external.id).artifactDeclarations, [{
    key: 'pytest-html', kind: 'pytest-html', path: tracked.htmlPath,
  }]);

  fs.writeFileSync(`${tracked.external.statePath}`, 'finished\n');
  fs.writeFileSync(`${tracked.external.donePath}`, '0\n');
  fs.writeFileSync(`${tracked.external.metaPath}`, JSON.stringify({
    work_dir: externalDirectory,
    ended_at: new Date().toISOString(),
    exit_code: 0,
  }));
  const [reconciled] = store.reconcileExternalAttempts(taskId);
  assert.equal(reconciled.status, 'succeeded');
  const terminal = store.listSkillReports(taskId)[0];
  assert.deepEqual(terminal.artifactDeclarations.map((artifact) => artifact.path), [tracked.htmlPath]);
  const archived = await store.archiveSkillReportArtifacts(taskId, terminal.id);
  assert.equal(archived.artifacts.length, 1);
  assert.equal(archived.artifacts[0].fileName, path.basename(tracked.htmlPath));
  assert.ok(store.listSessionWorklogs(taskId).some((entry) => (
    entry.kind === 'external.attempt.artifacts.auto_registered'
  )));
});

test('terminal evidence does not permit an HTML report that still shows pytest running', async () => {
  ensureReportSkill();
  const runtime = createRunningTask('pytest-html-terminal-reload-task', 'pytest-html-terminal-reload-worker');
  const reportDirectory = path.join(projectDir, 'terminal-reload-report');
  const htmlPath = path.join(reportDirectory, 'normal.html');
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(htmlPath, [
    '<!doctype html><html><body>',
    '<div class="summary__reload__button" onclick="location.reload()">Reload</div>',
    '<div class="summary__reload__button hidden" onclick="location.reload()">Hidden</div>',
    '</body></html>',
  ].join(''), { mode: 0o600 });
  const input = reportFixture({
    reportKey: 'pytest-html:terminal-reload',
    status: 'failed',
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: 'pytest -v tests --html normal.html',
      workingDirectory: reportDirectory,
      status: 'failed',
      exitCode: 1,
    },
  });
  const { report: published } = publishArtifactReport(
    'pytest-html-terminal-reload-task', runtime, input,
    [{ key: 'normal', kind: 'pytest-html', path: htmlPath }],
  );
  await assert.rejects(
    store.archiveSkillReportArtifacts('pytest-html-terminal-reload-task', published.id),
    /pytest is still running/,
  );
  assert.deepEqual(store.listSkillReports('pytest-html-terminal-reload-task')[0].artifacts, []);
});

test('database startup removes the legacy whole-history report hash constraint', () => {
  const legacyDataDir = path.join(tempDir, 'legacy-report-database');
  fs.mkdirSync(legacyDataDir, { recursive: true });
  const databasePath = path.join(legacyDataDir, 'codex-tasks.db');
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE skill_reports (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      turn_id TEXT,
      attempt_id TEXT,
      report_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      report_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      skill_id TEXT NOT NULL,
      skill_version INTEGER NOT NULL,
      skill_content_hash TEXT NOT NULL,
      report_type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      published_at TEXT NOT NULL,
      UNIQUE(task_id, report_key, revision),
      UNIQUE(task_id, report_key, report_hash)
    );
  `);
  legacy.close();

  const migrated = spawnSync(process.execPath, ['-e', "require('./src/database').getDatabase().close()"], {
    cwd: ROOT_DIR,
    env: { ...process.env, CODEX_DESK_DATA_DIR: legacyDataDir },
    encoding: 'utf8',
  });
  assert.equal(migrated.status, 0, migrated.stderr);

  const inspected = new Database(databasePath, { readonly: true });
  const definition = inspected.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='skill_reports'",
  ).get().sql;
  inspected.close();
  assert.doesNotMatch(definition, /UNIQUE\s*\(\s*task_id\s*,\s*report_key\s*,\s*report_hash\s*\)/i);
  assert.match(definition, /UNIQUE\s*\(\s*task_id\s*,\s*report_key\s*,\s*revision\s*\)/i);
});

test('Skill reports are attributed, revisioned, queryable, and immutable with their task', async () => {
  ensureReportSkill();

  const direct = createRunningTask('report-direct-task', 'report-direct-worker');
  const first = store.publishSkillReport('report-direct-task', reportFixture(), {
    turnId: direct.turn.id,
    attemptId: direct.attemptId,
  });
  assert.equal(first.revision, 1);
  assert.equal(first.skillVersion, 1);
  assert.match(first.skillContentHash, /^[a-f0-9]{64}$/);
  assert.equal(first.idempotent, false);
  assert.equal(first.primaryExecution.command, reportFixture().primaryExecution.command);

  const repeated = store.publishSkillReport('report-direct-task', reportFixture(), {
    turnId: direct.turn.id,
    attemptId: direct.attemptId,
  });
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.idempotent, true);

  const secondInput = reportFixture({ status: 'failed', summary: 'A later failed revision.' });
  const second = store.publishSkillReport('report-direct-task', secondInput, {
    turnId: direct.turn.id,
    attemptId: direct.attemptId,
  });
  assert.equal(second.revision, 2);

  const reverted = store.publishSkillReport('report-direct-task', reportFixture(), {
    turnId: direct.turn.id,
    attemptId: direct.attemptId,
  });
  assert.equal(reverted.revision, 3);
  assert.equal(reverted.idempotent, false);
  assert.deepEqual(store.listSkillReports('report-direct-task').map((report) => report.revision), [3]);
  assert.deepEqual(store.listSkillReports('report-direct-task', { history: true })
    .map((report) => report.revision), [3, 2, 1]);
  assert.equal(store.listSessionWorklogs('report-direct-task')
    .filter((event) => event.kind === 'skill.report.published').length, 3);

  assert.throws(() => store.publishSkillReport('report-direct-task', {
    ...reportFixture(), reportKey: 'wrong-skill', skillId: 'not-in-snapshot',
  }, { turnId: direct.turn.id, attemptId: direct.attemptId }), /not present in this task snapshot/);
  assert.throws(() => store.publishSkillReport('report-direct-task', {
    ...reportFixture(), reportKey: 'wrong-context',
  }, { turnId: direct.turn.id, attemptId: 'attempt-from-another-task' }), /does not belong to this task/);

  store.finalizeSessionTurn({
    taskId: 'report-direct-task', turnId: direct.turn.id, attemptId: direct.attemptId,
    commandId: direct.command.id, workerId: direct.workerId, exitCode: 0,
    summary: 'Report task complete.', finalStatus: 'waiting_review', retryCount: 0,
  });
  store.completeSession('report-direct-task');
  assert.throws(() => store.publishSkillReport('report-direct-task', {
    ...reportFixture(), reportKey: 'completed-task-report',
  }), /immutable history records/);

  const cliTask = createRunningTask('report-cli-task', 'report-cli-worker');
  const reportPath = path.join(tempDir, 'report.json');
  const yamlPath = path.join(tempDir, 'report.yaml');
  const cliHtmlPath = path.join(projectDir, 'cli-pytest-report.html');
  const cliCommand = 'python3 -m pytest -v test_cloud_recording.py --html=cli-pytest-report.html';
  fs.writeFileSync(cliHtmlPath, '<!doctype html><title>CLI pytest report</title>', 'utf8');
  const cliExternal = registerArtifactExecution(
    'report-cli-task', cliTask, projectDir, cliCommand,
  );
  fs.writeFileSync(reportPath, JSON.stringify(reportFixture({
    reportKey: 'cli-report',
    executionEvidence: { externalAttemptId: cliExternal.id },
    artifacts: [{ key: 'normal', kind: 'pytest-html', path: cliHtmlPath }],
    primaryExecution: {
      ...reportFixture().primaryExecution,
      command: cliCommand,
      workingDirectory: projectDir,
    },
  })), 'utf8');
  fs.writeFileSync(yamlPath, YAML.stringify(reportFixture({ reportKey: 'cli-yaml-report' })), 'utf8');

  const cli = path.join(ROOT_DIR, 'bin', 'full-access', 'codex-skill-report');
  const wrapper = path.join(ROOT_DIR, 'bin', 'full-access', 'codex-skill-use');
  const runtimeEnv = {
    ...process.env,
    CODEX_TASK_ID: 'report-cli-task',
    CODEX_TASK_TURN_ID: cliTask.turn.id,
    CODEX_TASK_ATTEMPT_ID: cliTask.attemptId,
    CODEX_TASK_SKILL_SNAPSHOT: cliTask.snapshot.path,
  };
  const missingAttribution = spawnSync(cli, ['publish', '--file', reportPath], {
    cwd: tempDir, env: runtimeEnv, encoding: 'utf8',
  });
  assert.equal(missingAttribution.status, 78);
  assert.match(missingAttribution.stderr, /publish through codex-skill-use/);

  const wrongAttribution = spawnSync(cli, ['publish', '--file', reportPath], {
    cwd: tempDir, env: { ...runtimeEnv, CODEX_ACTIVE_SKILL_IDS: 'different-skill' }, encoding: 'utf8',
  });
  assert.equal(wrongAttribution.status, 65);
  assert.match(wrongAttribution.stderr, /report Skill is not active/);

  const jsonPublished = spawnSync(wrapper, [
    'report-skill', '--', cli, 'publish', '--file', reportPath,
  ], { cwd: tempDir, env: runtimeEnv, encoding: 'utf8' });
  assert.equal(jsonPublished.status, 0, jsonPublished.stderr);
  assert.match(jsonPublished.stdout, /REVISION=1/);
  assert.match(jsonPublished.stdout, /IDEMPOTENT=false/);
  assert.match(jsonPublished.stdout, /ARTIFACTS=1/);

  const shortCommandPublished = spawnSync(wrapper, [
    'report-skill', '--', 'codex-skill-report', 'publish', '--file', reportPath,
  ], {
    cwd: tempDir,
    env: { ...runtimeEnv, PATH: path.dirname(process.execPath) },
    encoding: 'utf8',
  });
  assert.equal(shortCommandPublished.status, 0, shortCommandPublished.stderr);
  assert.match(shortCommandPublished.stdout, /IDEMPOTENT=true/);
  assert.match(shortCommandPublished.stdout, /ARTIFACTS=1/);

  const yamlPublished = spawnSync(wrapper, [
    'report-skill', '--', cli, 'publish', '--file', yamlPath,
  ], { cwd: tempDir, env: runtimeEnv, encoding: 'utf8' });
  assert.equal(yamlPublished.status, 0, yamlPublished.stderr);
  assert.match(yamlPublished.stdout, /REPORT_KEY=cli-yaml-report/);

  const yamlRepeated = spawnSync(wrapper, [
    'report-skill', '--', cli, 'publish', '--file', yamlPath,
  ], { cwd: tempDir, env: runtimeEnv, encoding: 'utf8' });
  assert.equal(yamlRepeated.status, 0, yamlRepeated.stderr);
  assert.match(yamlRepeated.stdout, /IDEMPOTENT=true/);

  const port = 22000 + (process.pid % 1000);
  let serverOutput = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT_DIR,
    env: {
      ...runtimeEnv,
      HOST: '127.0.0.1',
      PORT: String(port),
      CODEX_DISABLE_WORKER: '1',
      CODEX_DB_BACKUP_INTERVAL_HOURS: '0',
      CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  try {
    const latest = await waitForApi(port, '/api/sessions/report-cli-task/skill-reports?limit=100&offset=0');
    assert.equal(latest.status, 200, serverOutput);
    assert.deepEqual(latest.payload.map((report) => report.reportKey).sort(), ['cli-report', 'cli-yaml-report']);
    assert.ok(latest.payload.every((report) => report.skillId === 'report-skill'));
    assert.equal(latest.payload[0].primaryExecution.command, reportFixture().primaryExecution.command);
    const cliReport = latest.payload.find((report) => report.reportKey === 'cli-report');
    assert.equal(cliReport.artifacts.length, 1);
    assert.equal(cliReport.artifacts[0].kind, 'pytest-html');
    assert.equal(cliReport.artifacts[0].fileName, 'cli-pytest-report.html');
    const history = await requestJson(port, '/api/sessions/report-cli-task/skill-reports?history=1');
    assert.equal(history.status, 200);
    assert.equal(history.payload.length, 2);
  } finally {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      if (server.exitCode != null) resolve();
      else server.once('exit', resolve);
    });
  }
});

test('terminal cloud-recording turns receive a fallback report when the Skill omits publication', () => {
  ensureCloudRecordingReportSkill();
  const runtime = createRunningTask('missing-cloud-report-task', 'missing-cloud-report-worker');
  store.recordCommandExecution({
    taskId: 'missing-cloud-report-task',
    turnId: runtime.turn.id,
    attemptId: runtime.attemptId,
    event: {
      type: 'item.completed',
      item: {
        id: 'cloud-recording-command',
        type: 'command_execution',
        command: '/usr/local/bin/codex-skill-use cloud-recording-test -- pytest -q cloud_recording',
        status: 'completed',
        exit_code: 1,
      },
    },
  });
  const external = store.registerExternalAttempt({
    taskId: 'missing-cloud-report-task',
    logPath: path.join(projectDir, 'missing-cloud-report.log'),
    donePath: path.join(projectDir, 'missing-cloud-report.done'),
    statePath: path.join(projectDir, 'missing-cloud-report.state'),
    metaPath: path.join(projectDir, 'missing-cloud-report.meta'),
  });
  const database = getDatabase();
  database.prepare(`
    UPDATE external_attempts SET status='failed', result_json=? WHERE id=?
  `).run(JSON.stringify({ exitCode: 7 }), external.id);
  database.prepare(`
    UPDATE scheduled_jobs SET status='completed' WHERE external_attempt_id=?
  `).run(external.id);

  store.finalizeSessionTurn({
    taskId: 'missing-cloud-report-task', turnId: runtime.turn.id, attemptId: runtime.attemptId,
    commandId: runtime.command.id, workerId: runtime.workerId, exitCode: 1,
    summary: '3 passed, 2 failed.', finalStatus: 'waiting_review', retryCount: 0,
  });

  const [report] = store.listSkillReports('missing-cloud-report-task');
  assert.equal(report.skillId, 'cloud-recording-test');
  assert.equal(report.status, 'partial');
  assert.match(report.reportKey, /^platform-fallback:cloud-recording-test:/);
  assert.equal(report.metrics.find((metric) => metric.key === 'exit-code').value, 7);
  assert.equal(report.sections.find((section) => section.id === 'publication').fields[1].tone, 'warning');
  assert.ok(store.listSessionWorklogs('missing-cloud-report-task').some((entry) => (
    entry.kind === 'skill.report.fallback_published'
  )));
});
