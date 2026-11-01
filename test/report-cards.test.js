const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { definitions, definition, createTemplate, groupReports, combinedStatus } = require('../public/report-cards');
const { normalizeSkillReport } = require('../src/skill-report');

const cli = path.resolve(__dirname, '../bin/full-access/codex-skill-report');

test('all five card skeletons satisfy the existing publication schema without inventing results', () => {
  assert.equal(definitions.length, 5);
  for (const card of definitions) {
    const input = createTemplate({ type: card.reportType, skillId: 'actual-business-skill', reportKey: `${card.id}:run-1` });
    const report = normalizeSkillReport(input);
    assert.equal(report.reportType, card.reportType);
    assert.equal(report.status, 'unknown');
    assert.deepEqual(report.metrics, []);
    assert.deepEqual(report.artifacts, []);
    assert.equal(report.skillId, 'actual-business-skill');
  }
});

test('aliases use the standard type and custom business reports remain supported', () => {
  assert.equal(createTemplate({ type: 'TEST' }).reportType, 'test-result');
  assert.equal(createTemplate({ type: 'failure-analysis-result' }).reportType, 'failure-analysis');
  const custom = normalizeSkillReport(createTemplate({ type: 'converter-special-result' }));
  assert.equal(custom.reportType, 'converter-special-result');
  assert.equal(definition(custom.reportType).id, 'business');
});

test('phase cards group independent Runs without changing their execution or artifacts', () => {
  const child = key => ({ reportKey: key, executionEvidence: { externalAttemptId: key }, artifacts: [{ url: `/${key}.html` }] });
  const children = [child('rerun:gw51'), child('rerun:gw53')];
  const stage = { reportKey: 'phase:rerun', relatedReportKeys: children.map(report => report.reportKey) };
  const final = { reportKey: 'summary' };
  const reports = [children[1], final, stage, children[0]];
  const original = JSON.stringify(reports);
  const groups = groupReports(reports);
  assert.deepEqual(groups.map(group => group.report.reportKey), ['summary', 'phase:rerun']);
  assert.deepEqual(groups[1].relatedReports, children);
  assert.equal(JSON.stringify(reports), original);
  assert.deepEqual(groupReports(children).map(group => group.report), children);
});

test('missing references and cycles retain all reports exactly once', () => {
  const reports = [
    { reportKey: 'a', relatedReportKeys: ['a', 'missing', 'b'] },
    { reportKey: 'b', relatedReportKeys: ['a'] },
    { reportKey: 'c', relatedReportKeys: ['b'] },
  ];
  const retained = groupReports(reports).flatMap(group => [group.report, ...group.relatedReports]);
  assert.equal(retained.length, 3);
  assert.equal(new Set(retained).size, 3);
});

test('phase references survive Schema v2 normalization and leave legacy reports unchanged', () => {
  const stage = createTemplate({ type: 'test-result', relatedReports: 'run:1,run:2,run:1' });
  assert.deepEqual(normalizeSkillReport(stage).relatedReportKeys, ['run:1', 'run:2']);
  assert.equal('relatedReportKeys' in normalizeSkillReport(createTemplate()), false);
});

test('rerun reports without a stage share one display group with all original evidence', () => {
  const initial = { reportKey: 'release:initial', status: 'succeeded' };
  const children = [
    { reportKey: 'release:rerun-1:gw51', status: 'succeeded', skillId: 'first-skill', metrics: [{ key: 'passed', value: 3 }] },
    { reportKey: 'release:rerun-1:gw53', status: 'partial', skillId: 'second-skill', artifacts: [{ url: '/second.html' }] },
  ];
  const reports = [children[0], initial, children[1]];
  const original = JSON.stringify(reports);
  const groups = groupReports(reports, { rerunKeys: new Set(children.map(report => report.reportKey)) });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].report.presentationGroup, 'rerun');
  assert.equal(groups[0].report.status, 'partial');
  assert.deepEqual(groups[0].relatedReports, children);
  assert.deepEqual(groups[0].report.metrics, []);
  assert.equal(groups[0].report.skillId, undefined);
  assert.equal(groups[1].report, initial);
  assert.equal(JSON.stringify(reports), original);
});

test('final summaries keep a rerun stage visible while its child reports remain grouped', () => {
  const children = ['a', 'b'].map(key => ({ reportKey: `rerun:${key}` }));
  const stage = { reportKey: 'phase:rerun', relatedReportKeys: children.map(report => report.reportKey) };
  const analysis = { reportKey: 'analysis' };
  const final = { reportKey: 'summary', relatedReportKeys: [stage.reportKey, analysis.reportKey] };
  const groups = groupReports([final, stage, ...children, analysis], {
    rerunKeys: new Set([stage.reportKey, ...children.map(report => report.reportKey)]),
  });
  assert.deepEqual(groups.map(group => group.report), [final, stage]);
  assert.deepEqual(groups[0].relatedReports, [analysis]);
  assert.deepEqual(groups[1].relatedReports, children);
});

test('multiple rerun stages combine without dropping their distinct original summaries', () => {
  const first = { reportKey: 'phase:rerun-1', status: 'partial', relatedReportKeys: ['run:a'] };
  const child = { reportKey: 'run:a' };
  const next = { reportKey: 'phase:rerun-2', status: 'running' };
  const groups = groupReports([next, first, child], { rerunKeys: new Set([first.reportKey, child.reportKey, next.reportKey]) });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].report.status, 'running');
  assert.deepEqual(groups[0].relatedReports, [next, first, child]);
});

test('combined status preserves active work and unsuccessful outcomes', () => {
  assert.equal(combinedStatus(['succeeded', 'running']), 'running');
  assert.equal(combinedStatus(['pending', 'pending']), 'pending');
  assert.equal(combinedStatus(['succeeded', 'failed']), 'partial');
  assert.equal(combinedStatus(['failed', 'failed']), 'failed');
  assert.equal(combinedStatus(['succeeded', 'succeeded']), 'succeeded');
  assert.equal(combinedStatus([]), 'unknown');
});

test('template CLI works without a Task context, preserves attribution and does not create platform data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-card-template-'));
  const output = path.join(dir, 'report.json');
  const dataDir = path.join(dir, 'platform-data');
  const env = { ...process.env, CODEX_DESK_DATA_DIR: dataDir, CODEX_DESK_RUNTIME_DIR: path.join(dir, 'runtime'), CODEX_ACTIVE_SKILL_IDS: 'actual-test-skill' };
  delete env.CODEX_TASK_ID;
  delete env.CODEX_TASK_TURN_ID;
  delete env.CODEX_TASK_ATTEMPT_ID;
  const result = spawnSync(process.execPath, [cli, 'template', '--type', 'test-result', '--report-key', 'test:run-1', '--status', 'running', '--external-attempt', 'external-1', '--command', 'pytest test_case.py --html=task/run/report/run.html', '--output', output], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = normalizeSkillReport(JSON.parse(fs.readFileSync(output, 'utf8')));
  assert.equal(report.skillId, 'actual-test-skill');
  assert.equal(report.executionEvidence.externalAttemptId, 'external-1');
  assert.match(report.primaryExecution.command, /--html=task\/run\/report\/run.html/);
  const stage = spawnSync(process.execPath, [cli, 'template', '--type', 'workflow-progress',
    '--report-key', 'release:cicd', '--related-reports', 'cicd:cloud,cicd:web'], { env, encoding: 'utf8' });
  assert.equal(stage.status, 0, stage.stderr);
  const stageReport = normalizeSkillReport(JSON.parse(stage.stdout));
  assert.deepEqual(stageReport.relatedReportKeys, ['cicd:cloud', 'cicd:web']);
  assert.equal(stageReport.executionEvidence, null);
  assert.equal(fs.existsSync(dataDir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
