#!/usr/bin/env node

process.umask(0o077);

const crypto = require('node:crypto');
const { listSessions, listTaskPytestReports, publishSkillReport } = require('../src/store');
const { readTaskPytestRunSummaries } = require('../src/pytest-result-summary');
const { getDatabase } = require('../src/database');

const RUN_KEYS = Object.freeze({ initial: 'initial', rerun1: 'rerun-1' });

function runGroup(runKey) {
  const key = String(runKey || '').toLowerCase();
  if (/^rerun[-_. ]?1(?:$|[-_.:])/.test(key)) return 'rerun1';
  if (key === 'initial' || !/(?:rerun[-_. ]?\d|manual[-_. ]?rerun|recovery|targeted|retry)/.test(key)) return 'initial';
  return '';
}

function aggregateRunSummaries(summaries, group) {
  const candidates = summaries.filter((summary) => runGroup(summary.runKey) === group);
  if (!candidates.length || candidates.some((summary) => !summary.available)) return null;
  const members = candidates;
  const counts = Object.fromEntries(['total', 'passed', 'failed', 'error', 'skipped', 'xfailed', 'xpassed', 'unknown']
    .map((key) => [key, 0]));
  for (const member of members) {
    for (const key of Object.keys(counts)) counts[key] += Number(member.counts?.[key] || 0);
  }
  const executed = counts.total - counts.skipped;
  return {
    counts,
    executed: Math.max(0, executed),
    reportCount: members.reduce((total, member) => total + Number(member.reportCount || 0), 0),
    complete: members.every((member) => member.complete),
  };
}

function metricsForRun(summary, group) {
  const counts = summary.counts;
  const metrics = [
    { key: group === 'initial' ? 'total' : 'selected', label: group === 'initial' ? 'Total' : 'Selected cases', value: counts.total, tone: 'neutral' },
    { key: 'passed', label: 'Passed', value: counts.passed, tone: 'success' },
    { key: 'failed', label: 'Failed', value: counts.failed, tone: counts.failed ? 'danger' : 'neutral' },
    { key: 'error', label: 'Errors', value: counts.error, tone: counts.error ? 'danger' : 'neutral' },
    { key: 'skipped', label: 'Skipped', value: counts.skipped, tone: 'neutral' },
    { key: 'xfailed', label: 'XFail', value: counts.xfailed, tone: 'neutral' },
    { key: 'xpassed', label: 'XPass', value: counts.xpassed, tone: 'success' },
    { key: 'executed', label: 'Executed', value: summary.executed, tone: 'neutral' },
  ];
  return metrics.filter((metric) => metric.value > 0 || ['total', 'selected', 'executed'].includes(metric.key));
}

function reportPayload(task, skillId, group, summary, sourceReportCount) {
  const label = group === 'initial' ? 'initial' : 'rerun-1';
  const counts = summary.counts;
  const failed = counts.failed + counts.error;
  return {
    schemaVersion: 2,
    reportKey: `backfill:pytest-progress:${group}:${crypto.createHash('sha256').update(task.id).digest('hex').slice(0, 20)}`,
    skillId,
    reportType: 'test-result',
    title: `${task.name} · ${label} · progress backfill`,
    status: summary.complete ? 'succeeded' : 'partial',
    summary: `Backfilled ${label} case progress from ${sourceReportCount} verified pytest report(s): ${counts.passed} passed, ${failed} failed/error, ${counts.skipped} skipped.`,
    artifacts: [],
    metrics: metricsForRun(summary, group),
    sections: [{
      id: 'backfill-provenance', title: 'Backfill provenance', kind: 'fields', priority: 'supporting', defaultExpanded: false,
      fields: [
        { label: 'Source', value: 'Verified managed pytest HTML reports' },
        { label: 'Run', value: label },
        { label: 'Reports', value: sourceReportCount },
      ],
    }],
  };
}

function latestReportSkillId(taskId) {
  return getDatabase().prepare(`
    SELECT skill_id FROM skill_reports
    WHERE task_id=? AND report_type='test-result'
    ORDER BY published_at DESC, revision DESC LIMIT 1
  `).get(taskId)?.skill_id || '';
}

async function backfillTask(task) {
  if (task.status === 'completed') return { taskId: task.id, skipped: 'completed' };
  const skillId = latestReportSkillId(task.id);
  if (!skillId) return { taskId: task.id, skipped: 'no test-result report' };
  const reports = listTaskPytestReports(task.id);
  if (!reports.length) return { taskId: task.id, skipped: 'no pytest HTML reports' };
  const summaries = await readTaskPytestRunSummaries(reports);
  const progress = task.testProgress?.runs || {};
  const existingBackfills = new Set(getDatabase().prepare(
    "SELECT report_key FROM skill_reports WHERE task_id=? AND report_key LIKE 'backfill:pytest-progress:%'",
  ).all(task.id).map((row) => row.report_key));
  const published = [];
  for (const group of ['initial', 'rerun1']) {
    const summary = aggregateRunSummaries(summaries, group);
    if (!summary) continue;
    const label = RUN_KEYS[group];
    const payload = reportPayload(task, skillId, group, summary, summary.reportCount);
    if (existingBackfills.has(payload.reportKey) && progress[group]?.resultKnown) continue;
    const report = publishSkillReport(task.id, payload);
    if (!report.idempotent) published.push(`${label}@${report.revision}`);
  }
  return { taskId: task.id, published };
}

async function main() {
  const tasks = listSessions({ limit: 500, internal: true });
  const results = [];
  for (const task of tasks) {
    try {
      results.push(await backfillTask(task));
    } catch (error) {
      results.push({ taskId: task.id, error: error.message });
    }
  }
  const errors = results.filter((result) => result.error);
  console.log(JSON.stringify({ tasks: tasks.length, errors: errors.length, results }, null, 2));
  if (errors.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
