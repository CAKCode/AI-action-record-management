const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { definitions, definition, createTemplate } = require('../public/report-cards');
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
  assert.equal(fs.existsSync(dataDir), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
