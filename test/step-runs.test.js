const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-step-runs-'));
const dataDir = path.join(tempDir, 'data');
const runtimeDir = path.join(tempDir, 'runtime');
const workspaceRoot = path.join(tempDir, 'workspaces');
const projectDir = path.join(workspaceRoot, 'project');
const sourceHome = path.join(tempDir, 'codex-home');
const workspaceSkills = path.join(tempDir, 'workspace-skills');

for (const directory of [projectDir, sourceHome, workspaceSkills]) {
  fs.mkdirSync(directory, { recursive: true });
}

process.env.CODEX_DESK_DATA_DIR = dataDir;
process.env.CODEX_DESK_RUNTIME_DIR = runtimeDir;
process.env.CODEX_TASK_WORKSPACE_ROOTS = workspaceRoot;
process.env.SOURCE_CODEX_HOME = sourceHome;
process.env.WORKSPACE_CODEX_SKILLS_DIR = workspaceSkills;

const store = require('../src/store');
const { closeDatabase, getDatabase } = require('../src/database');

test.after(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function saveTask(taskId) {
  store.saveSession(taskId, {
    name: taskId,
    objective: 'Verify explicit Step and Run ownership.',
    workingDir: projectDir,
  });
}

let pidSequence = 990000000;

function register(taskId, name, identity) {
  pidSequence += 1;
  return store.registerExternalAttempt({
    taskId,
    pid: pidSequence,
    workingDirectory: projectDir,
    logPath: path.join(projectDir, `${name}.log`),
    donePath: path.join(projectDir, `${name}.done`),
    statePath: path.join(projectDir, `${name}.state`),
    metaPath: path.join(projectDir, `${name}.meta`),
    ...identity,
  });
}

function reportFixture(reportKey, externalAttemptId, summary) {
  return {
    schemaVersion: 2,
    reportKey,
    skillId: 'step-report-skill',
    reportType: 'test-result',
    title: 'Step result',
    status: 'running',
    summary,
    executionEvidence: { externalAttemptId },
    artifacts: [],
    metrics: [],
    sections: [{
      id: 'status', title: 'Status', kind: 'fields',
      fields: [{ label: 'Summary', value: summary }],
    }],
  };
}

test('Steps are stable scopes while reruns and technical retries retain distinct identities', () => {
  const taskId = 'step-run-hierarchy';
  saveTask(taskId);

  const normalInitialInput = {
    stepKey: 'normal', stepLabel: 'Normal group', runKey: 'initial', runKind: 'initial',
    selectionMode: 'group', targetCount: 974,
  };
  const normalInitial = register(taskId, 'normal-initial', normalInitialInput);
  const repeatedInitial = store.registerExternalAttempt({
    taskId,
    pid: normalInitial.pid,
    workingDirectory: projectDir,
    logPath: normalInitial.logPath,
    donePath: normalInitial.donePath,
    statePath: normalInitial.statePath,
    metaPath: normalInitial.metaPath,
    ...normalInitialInput,
  });
  assert.equal(repeatedInitial.id, normalInitial.id);

  const longInitial = register(taskId, 'long-initial', {
    stepKey: 'long', stepLabel: 'Long group', runKey: 'initial', runKind: 'initial',
    selectionMode: 'group', targetCount: 20,
  });
  assert.notEqual(longInitial.stepId, normalInitial.stepId);
  assert.notEqual(longInitial.stepRunId, normalInitial.stepRunId);
  assert.equal(path.dirname(longInitial.logPath), path.dirname(normalInitial.logPath));

  const rerunInput = {
    stepKey: 'normal', stepLabel: 'Normal group', runKey: 'rerun-1', runKind: 'rerun',
    sourceRunKey: 'initial', selectionMode: 'failed-from-source', targetCount: 7,
  };
  const rerun = register(taskId, 'normal-rerun-1', rerunInput);
  const repeatedRerun = store.registerExternalAttempt({
    taskId,
    pid: rerun.pid,
    workingDirectory: projectDir,
    logPath: rerun.logPath,
    donePath: rerun.donePath,
    statePath: rerun.statePath,
    metaPath: rerun.metaPath,
    ...rerunInput,
  });
  assert.equal(repeatedRerun.id, rerun.id);
  assert.equal(rerun.stepId, normalInitial.stepId);
  assert.notEqual(rerun.stepRunId, normalInitial.stepRunId);
  assert.equal(rerun.runKind, 'rerun');
  assert.equal(rerun.runNumber, 1);

  fs.writeFileSync(rerun.donePath, '1\n');
  fs.writeFileSync(rerun.statePath, 'finished\n');
  fs.writeFileSync(rerun.metaPath, JSON.stringify({
    work_dir: projectDir,
    ended_at: new Date().toISOString(),
    exit_code: 1,
  }));
  store.reconcileExternalAttempts(taskId);
  assert.equal(store.getExternalAttempt(taskId, rerun.id).status, 'failed');

  assert.throws(() => register(taskId, 'normal-rerun-1-wrong-chain', {
    stepRunId: rerun.stepRunId,
    chainKey: 'different-chain',
  }), /Run cannot switch to a different background execution chain/);

  const technicalRetry = register(taskId, 'normal-rerun-1-retry', {
    stepRunId: rerun.stepRunId,
  });
  assert.equal(technicalRetry.stepRunId, rerun.stepRunId);
  assert.notEqual(technicalRetry.id, rerun.id);
  assert.equal(technicalRetry.generation, 2);

  const steps = store.listTaskSteps(taskId);
  assert.deepEqual(steps.map((step) => step.key), ['normal', 'long']);
  assert.deepEqual(steps[0].runs.map((run) => [run.runKey, run.runKind, run.runNumber]), [
    ['initial', 'initial', 0],
    ['rerun-1', 'rerun', 1],
  ]);
  assert.equal(steps[0].runs[1].externalAttemptIds.length, 2);
  assert.deepEqual(steps[1].runs.map((run) => run.runKind), ['initial']);
});

test('a cancelled Attempt keeps its registered artifact paths exclusive to its Task', () => {
  const ownerTaskId = 'artifact-path-owner';
  const otherTaskId = 'artifact-path-other';
  const artifactPath = path.join(projectDir, 'shared-pytest-result.html');
  saveTask(ownerTaskId);
  saveTask(otherTaskId);

  const owner = store.registerExternalAttempt({
    taskId: ownerTaskId,
    pid: ++pidSequence,
    workingDirectory: projectDir,
    logPath: path.join(projectDir, 'owner.log'),
    donePath: path.join(projectDir, 'owner.done'),
    statePath: path.join(projectDir, 'owner.state'),
    metaPath: path.join(projectDir, 'owner.meta'),
    artifacts: [{ key: 'normal', kind: 'pytest-html', path: artifactPath }],
  });
  getDatabase().prepare(`UPDATE external_attempts SET status='cancelled' WHERE id=?`).run(owner.id);

  assert.throws(() => store.registerExternalAttempt({
    taskId: otherTaskId,
    pid: ++pidSequence,
    workingDirectory: projectDir,
    logPath: path.join(projectDir, 'other.log'),
    donePath: path.join(projectDir, 'other.done'),
    statePath: path.join(projectDir, 'other.state'),
    metaPath: path.join(projectDir, 'other.meta'),
    artifacts: [{ key: 'normal', kind: 'pytest-html', path: artifactPath }],
  }), /already registered by task artifact-path-owner/);
});

test('Run registration validates source scope and rejects semantic idempotency conflicts', () => {
  const taskId = 'step-run-validation';
  saveTask(taskId);
  const normalInitial = register(taskId, 'normal-initial-validation', {
    stepKey: 'normal', stepLabel: 'Normal', runKey: 'initial', runKind: 'initial',
  });
  register(taskId, 'long-initial-validation', {
    stepKey: 'long', stepLabel: 'Long', runKey: 'initial', runKind: 'initial',
  });

  assert.throws(() => register(taskId, 'missing-source', {
    stepKey: 'normal', stepLabel: 'Normal', runKey: 'rerun-1', runKind: 'rerun',
    sourceRunKey: 'missing',
  }), /sourceRunKey does not identify a Run in this Step/);
  assert.throws(() => register(taskId, 'second-initial', {
    stepKey: 'normal', stepLabel: 'Normal', runKey: 'another-initial', runKind: 'initial',
  }), /already has initial Run/);
  assert.throws(() => register(taskId, 'renamed-step', {
    stepKey: 'normal', stepLabel: 'Different label', runKey: 'rerun-2', runKind: 'rerun',
    sourceRunKey: 'initial',
  }), /already registered with label Normal/);
  assert.throws(() => register(taskId, 'cross-run-chain', {
    stepKey: 'normal', stepLabel: 'Normal', runKey: 'rerun-3', runKind: 'rerun',
    sourceRunKey: 'initial', chainKey: normalInitial.chainKey,
  }), /background execution chain cannot belong to different Runs/);
  assert.deepEqual(store.listTaskSteps(taskId).find((step) => step.key === 'normal')
    .runs.map((run) => run.runKey), ['initial']);
});

test('Skill report revisions cannot move between Step Runs', () => {
  const taskId = 'step-run-report-binding';
  store.saveSkill('step-report-skill', {
    name: 'Step report skill',
    description: 'Publishes Step-bound reports.',
    content: '---\nname: step-report-skill\ndescription: Step reports.\n---\n# Step reports\n',
  });
  saveTask(taskId);
  store.ensureTaskSkillSnapshot(taskId);
  const normal = register(taskId, 'report-normal', {
    stepKey: 'normal', stepLabel: 'Normal', runKey: 'initial', runKind: 'initial',
  });
  const long = register(taskId, 'report-long', {
    stepKey: 'long', stepLabel: 'Long', runKey: 'initial', runKind: 'initial',
  });

  const published = store.publishSkillReport(
    taskId,
    reportFixture('cloud-recording:normal:initial', normal.id, 'Normal is running.'),
  );
  assert.equal(published.stepRunId, normal.stepRunId);
  assert.throws(() => store.publishSkillReport(
    taskId,
    reportFixture('cloud-recording:normal:initial', long.id, 'Wrong Step revision.'),
  ), /cannot publish revisions across different Step Runs/);
  assert.deepEqual(store.listTaskSteps(taskId).find((step) => step.key === 'normal')
    .runs[0].reportIds, [published.id]);
});

test('lightweight reconciliation promotes terminal evidence without waiting for the scheduled Turn', () => {
  const taskId = 'step-run-lightweight-reconciliation';
  saveTask(taskId);
  const basePath = path.join(projectDir, 'lightweight-reconciliation');
  fs.writeFileSync(`${basePath}.log`, 'pytest output\n');
  fs.writeFileSync(`${basePath}.state`, 'running\n');
  fs.writeFileSync(`${basePath}.meta`, JSON.stringify({ work_dir: projectDir }));
  const external = store.registerExternalAttempt({
    taskId,
    pid: 999999983,
    workingDirectory: projectDir,
    logPath: `${basePath}.log`,
    donePath: `${basePath}.done`,
    statePath: `${basePath}.state`,
    metaPath: `${basePath}.meta`,
    stepKey: 'normal',
    stepLabel: 'Normal',
    runKey: 'initial',
    runKind: 'initial',
    checkAfterSeconds: 300,
  });
  assert.deepEqual(store.reconcileRunningExternalAttempts(), []);

  fs.writeFileSync(`${basePath}.done`, '0\n');
  fs.writeFileSync(`${basePath}.state`, 'finished\n');
  fs.writeFileSync(`${basePath}.meta`, JSON.stringify({
    work_dir: projectDir,
    ended_at: new Date().toISOString(),
    exit_code: 0,
  }));
  const reconciled = store.reconcileRunningExternalAttempts();
  assert.equal(reconciled.find((entry) => entry.id === external.id).status, 'succeeded');
  assert.equal(store.getExternalAttempt(taskId, external.id).status, 'succeeded');
  const [schedule] = store.listScheduledJobs(taskId);
  assert.ok(Date.parse(schedule.dueAt) <= Date.now());
});

test('background tracking CLI requires Step identity and returns Step and Run ids', () => {
  const taskId = 'step-run-cli';
  saveTask(taskId);
  const cli = path.join(ROOT_DIR, 'bin', 'full-access', 'codex-background-track');
  const environment = { ...process.env, CODEX_TASK_ID: taskId };
  const normalHtml = path.join(projectDir, 'cli-normal.html');
  const longHtml = path.join(projectDir, 'cli-long.html');
  const missing = spawnSync(cli, [
    'register', '--pid', '999999991', '--log', path.join(projectDir, 'cli-missing.log'),
  ], { cwd: projectDir, env: environment, encoding: 'utf8' });
  assert.equal(missing.status, 64);
  assert.match(missing.stderr, /--step-key is required/);

  const registered = spawnSync(cli, [
    'register', '--pid', '999999992', '--log', path.join(projectDir, 'cli-initial.log'),
    '--step-key', 'normal', '--step-label', 'Normal',
    '--run-key', 'initial', '--run-kind', 'initial', '--target-count', '12',
    '--artifact', `pytest-html:normal:${normalHtml}`,
    '--artifact', `pytest-html:long:${longHtml}`,
  ], { cwd: projectDir, env: environment, encoding: 'utf8' });
  assert.equal(registered.status, 0, registered.stderr);
  assert.match(registered.stdout, /^STEP_ID=step-/m);
  assert.match(registered.stdout, /^STEP_RUN_ID=step-run-/m);
  assert.match(registered.stdout, /^TRACKING_ID=external-/m);
  assert.match(registered.stdout, /^ARTIFACTS=2$/m);
  const [external] = store.listExternalAttempts(taskId);
  assert.deepEqual(external.artifactDeclarations, [
    { key: 'normal', kind: 'pytest-html', path: normalHtml },
    { key: 'long', kind: 'pytest-html', path: longHtml },
  ]);
});
