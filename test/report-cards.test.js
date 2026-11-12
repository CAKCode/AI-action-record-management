const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { definitions, definition, createTemplate, groupReports, combinedStatus, cardCatalog } = require('../public/report-cards');
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

test('analysis templates retain foreground execution evidence and terminal attachments', () => {
  const data = {
    status: 'succeeded',
    executionEvidence: { commandExecutionId: 'execution-analysis' },
    artifacts: [{ key: 'analysis', kind: 'failure-analysis-markdown', path: '/workspace/analysis.md' }],
  };
  const before = JSON.stringify(data);
  const report = normalizeSkillReport(createTemplate({ type: 'failure-analysis', data }));
  assert.deepEqual(report.executionEvidence, data.executionEvidence);
  assert.deepEqual(report.artifacts, data.artifacts);
  assert.equal(JSON.stringify(data), before);
  const overridden = normalizeSkillReport(createTemplate({
    type: 'failure-analysis', data, externalAttemptId: 'external-analysis',
  }));
  assert.deepEqual(overridden.executionEvidence, { externalAttemptId: 'external-analysis' });
  assert.throws(() => normalizeSkillReport(createTemplate({ type: 'failure-analysis', data: {
    ...data, executionEvidence: { ...data.executionEvidence, externalAttemptId: 'external-analysis' },
  } })), /exactly one/);
});

test('pending and running templates leave attachments for terminal publication', () => {
  for (const status of ['pending', 'running']) {
    const data = { status, artifacts: [{ key: 'html', kind: 'pytest-html', path: '/workspace/report.html' }],
      executionEvidence: { externalAttemptId: 'external-fixture' } };
    const before = JSON.stringify(data);
    for (const options of [{ data }, { data: { ...data, status: 'succeeded' }, status }]) {
      const report = normalizeSkillReport(createTemplate({ type: 'test-result', ...options }));
      assert.equal(report.status, status);
      assert.deepEqual(report.artifacts, []);
      assert.deepEqual(report.executionEvidence, data.executionEvidence);
    }
    assert.equal(JSON.stringify(data), before);
  }
});

test('fixed templates order known measurements, preserve zero and retain custom business evidence', () => {
  const data = { status: 'failed', summary: 'Observed two failures',
    metrics: [{ key: 'failed', label: 'ad hoc failure label', value: 2 },
      { key: 'passed', label: 'ad hoc pass label', value: 0 },
      { key: 'errors', value: 0 }, { key: 'total', value: null },
      { key: 'custom_measurement', label: 'Custom measurement', value: 7, tone: 'info' }],
    rows: [{ case: 'test_example', outcome: 'failed', detail: 'Evidence retained' }],
    context: [{ label: 'Target', value: 'example-target' }],
    evidence: [{ label: 'Log', value: '/workspace/example.log' }],
    primaryExecution: { command: 'pytest test_example.py', workingDirectory: '/workspace',
      startedAt: '2026-01-01T10:00:00Z', finishedAt: '2026-01-01T10:01:00Z', exitCode: 1 },
  };
  const before = JSON.stringify(data);
  const report = normalizeSkillReport(createTemplate({ type: 'test-result', skillId: 'real-test-skill', data }));
  assert.deepEqual(report.metrics.map(metric => metric.key), ['passed', 'failed', 'error', 'custom_measurement']);
  assert.equal(report.metrics[0].value, 0);
  assert.equal(report.metrics[0].label, 'Pass');
  assert.equal(report.metrics[1].label, 'Fail');
  assert.equal(report.metrics[3].label, 'Custom measurement');
  assert.equal(report.sections[0].columns[0].label, '用例');
  assert.equal(report.sections[0].rows[0].detail, 'Evidence retained');
  assert.equal(report.primaryExecution.finishedAt, data.primaryExecution.finishedAt);
  assert.equal(report.sections.find(section => section.id === 'evidence').defaultExpanded, false);
  assert.equal(JSON.stringify(data), before);
});

test('rerun and final presets retain the five report types and separate cumulative from final counts', () => {
  assert.equal(cardCatalog().templateVersion, 1);
  assert.equal(cardCatalog().schemaVersion, 2);
  assert.equal(cardCatalog().cards.length, 5);
  const rerun = normalizeSkillReport(createTemplate({ preset: 'rerun',
    data: { metrics: { persistent: 1, passed: 4, selected: 5, recovered: 4, failed: 1 } } }));
  assert.equal(rerun.reportType, 'test-result');
  assert.deepEqual(rerun.metrics.map(metric => metric.key), ['selected', 'passed', 'failed', 'recovered', 'persistent']);
  const input = { complete: false, reportCount: 2, executed: 200,
    cumulative: { total: 205, passed: 194, failed: 6, skipped: 5, error: 0, xfailed: 0 },
    final: { total: 200, passed: 194, failed: 1, skipped: 5, error: 0, xfailed: 0 } };
  const result = normalizeSkillReport(createTemplate({ preset: 'final-summary', language: 'en', data: input }));
  assert.equal(result.reportType, 'workflow-progress');
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.metrics.map(metric => metric.value), [205, 194, 6, 200, 194, 1]);
  assert.equal(result.sections[0].id, 'final-results');
  assert.equal(result.sections[0].rows[0].failed, 6);
  assert.equal(result.sections[0].rows[1].failed, 1);
  assert.equal(result.sections[0].rows[1].error, 0);
  assert.equal(result.sections.find(section => section.id === 'count-source').fields[0].value, false);
  assert.equal(result.executionEvidence, null);
  const unknown = createTemplate({ preset: 'final-summary', data: { final: { failed: 1 } } });
  assert.deepEqual(unknown.metrics.map(metric => metric.key), ['final_failed']);
  assert.equal('passed' in unknown.sections[0].rows[0], false);
  const noData = createTemplate({ preset: 'final-summary', data: { available: false, complete: true,
    cumulative: { total: 0, passed: 0, failed: 0 }, final: { total: 0, passed: 0, failed: 0 } } });
  assert.deepEqual(noData.metrics, []);
  assert.deepEqual(noData.sections[0].rows, []);
  const extended = normalizeSkillReport(createTemplate({ preset: 'final-summary',
    data: { final: { total: 2, xpassed: 1, unknown: 1 }, metrics: { business_measure: 3 } } }));
  assert.equal(extended.sections[0].rows[0].xpassed, 1);
  assert.equal(extended.sections[0].rows[0].unknown, 1);
  assert.equal(extended.metrics.find(metric => metric.key === 'business_measure').value, 3);
});

test('all documented example data generates a valid report without publishing or creating runtime state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-report-examples-'));
  const examples = path.resolve(__dirname, '../skills/task-reporting/examples');
  try {
    for (const name of ['test-result', 'rerun', 'deployment-result', 'failure-analysis', 'workflow-progress', 'final-summary', 'business-result']) {
      const args = ['template', ...(name === 'rerun' || name === 'final-summary' ? ['--preset', name] : ['--type', name]),
        '--report-key', `example:${name}`, '--data', path.join(examples, `${name}.data.json`)];
      const result = spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8',
        env: { ...process.env, CODEX_ACTIVE_SKILL_IDS: 'actual-publisher',
          CODEX_DESK_DATA_DIR: path.join(directory, 'data'), CODEX_DESK_RUNTIME_DIR: path.join(directory, 'runtime') } });
      assert.equal(result.status, 0, result.stderr);
      const report = normalizeSkillReport(JSON.parse(result.stdout));
      assert.equal(report.skillId, 'actual-publisher');
      assert.equal(report.reportKey, `example:${name}`);
    }
    const catalog = spawnSync(process.execPath, [cli, 'cards'], { cwd: directory, encoding: 'utf8',
      env: { ...process.env, CODEX_DESK_DATA_DIR: path.join(directory, 'data'), CODEX_DESK_RUNTIME_DIR: path.join(directory, 'runtime') } });
    assert.equal(catalog.status, 0, catalog.stderr);
    assert.equal(JSON.parse(catalog.stdout).cards.length, 5);
    assert.equal(fs.existsSync(path.join(directory, 'data')), false);
    assert.equal(fs.existsSync(path.join(directory, 'runtime')), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
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
  const analysisData = path.join(dir, 'analysis-data.json');
  fs.writeFileSync(analysisData, JSON.stringify({ status: 'succeeded',
    executionEvidence: { commandExecutionId: 'execution-analysis-cli' },
    artifacts: [{ key: 'analysis', kind: 'failure-analysis-html', path: '/workspace/analysis.html' }],
  }));
  const analysis = spawnSync(process.execPath, [cli, 'template', '--type', 'failure-analysis',
    '--report-key', 'analysis:run-1', '--data', analysisData], { env, encoding: 'utf8' });
  assert.equal(analysis.status, 0, analysis.stderr);
  const analysisReport = normalizeSkillReport(JSON.parse(analysis.stdout));
  assert.deepEqual(analysisReport.executionEvidence, { commandExecutionId: 'execution-analysis-cli' });
  assert.equal(analysisReport.artifacts[0].kind, 'failure-analysis-html');
  assert.equal(fs.existsSync(dataDir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
