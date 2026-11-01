(function (root, factory) {
  const cards = factory();
  if (typeof module === 'object' && module.exports) module.exports = cards;
  else root.CodexReportCards = cards;
}(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const definitions = [
    { id: 'test', reportType: 'test-result', labels: { zh: '测试结果', en: 'Test result' }, sectionId: 'case-results', sectionLabels: { zh: '用例结果', en: 'Case results' }, columns: ['case', 'outcome', 'detail'] },
    { id: 'deployment', reportType: 'deployment-result', labels: { zh: '部署结果', en: 'Deployment result' }, sectionId: 'targets', sectionLabels: { zh: '部署目标', en: 'Deployment targets' }, columns: ['target', 'component', 'version', 'outcome'] },
    { id: 'analysis', reportType: 'failure-analysis', aliases: ['failure-analysis-result'], labels: { zh: '失败分析', en: 'Failure analysis' }, sectionId: 'findings', sectionLabels: { zh: '分析结论与证据', en: 'Findings and evidence' }, columns: ['case', 'classification', 'evidence', 'action'] },
    { id: 'workflow', reportType: 'workflow-progress', aliases: ['workflow-result'], labels: { zh: '流程进度', en: 'Workflow progress' }, sectionId: 'stages', sectionLabels: { zh: '阶段进度', en: 'Stage progress' }, columns: ['stage', 'outcome', 'detail'] },
    { id: 'business', reportType: 'business-result', labels: { zh: '业务结果', en: 'Business result' }, sectionId: 'details', sectionLabels: { zh: '业务详情', en: 'Business details' } },
  ];

  function definition(reportType) {
    const type = String(reportType || '').trim().toLowerCase();
    return definitions.find(card => card.reportType === type || card.id === type || card.aliases?.includes(type))
      || definitions[definitions.length - 1];
  }

  function createTemplate(options = {}) {
    const card = definition(options.type);
    const requested = String(options.type || card.reportType);
    const normalized = requested.trim().toLowerCase();
    const reportType = [card.id, card.reportType, ...(card.aliases || [])].includes(normalized) ? card.reportType : requested;
    const summary = options.summary || '待补充本轮真实业务结论。';
    const section = {
      id: card.sectionId, title: card.sectionLabels.zh,
      kind: card.columns ? 'table' : 'fields', priority: 'primary', defaultExpanded: true,
      ...(card.columns
        ? { columns: card.columns.map(key => ({ key, label: key, format: 'text' })), rows: [] }
        : { fields: [{ label: 'Result', value: '' }] }),
    };
    const report = {
      schemaVersion: 2,
      reportKey: options.reportKey || 'business:run',
      skillId: options.skillId || 'business-skill',
      reportType, title: options.title || card.labels.zh,
      status: options.status || 'unknown', summary,
      artifacts: [], metrics: [], sections: [section],
    };
    if (options.externalAttemptId) report.executionEvidence = { externalAttemptId: options.externalAttemptId };
    if (options.relatedReports) report.relatedReportKeys = Array.isArray(options.relatedReports)
      ? options.relatedReports : options.relatedReports.split(',').map(key => key.trim()).filter(Boolean);
    if (options.command) report.primaryExecution = {
      label: options.title || card.labels.zh, command: options.command,
      workingDirectory: options.workingDirectory || '', status: report.status,
    };
    return report;
  }

  function combinedStatus(statuses) {
    if (!statuses.length) return 'unknown';
    if (statuses.includes('running')) return 'running';
    if (statuses.includes('pending')) return statuses.every(status => status === 'pending') ? 'pending' : 'running';
    if (statuses.includes('blocked')) return 'blocked';
    if (statuses.every(status => status === 'succeeded')) return 'succeeded';
    if (statuses.every(status => status === 'failed')) return 'failed';
    if (statuses.every(status => status === 'cancelled')) return 'cancelled';
    if (statuses.every(status => status === 'unknown')) return 'unknown';
    return 'partial';
  }

  function groupReports(reports, options = {}) {
    const rerunKeys = options.rerunKeys || new Set();
    const isRerun = report => rerunKeys.has(report.reportKey || report.id);
    const byKey = new Map(reports.map(report => [report.reportKey, report]));
    const parents = new Map();
    for (const parent of reports) {
      for (const key of parent.relatedReportKeys || []) {
        const child = byKey.get(key);
        if (!child || child === parent || parents.has(child)) continue;
        // A rerun stage stays visible even when a final summary references it.
        if (isRerun(child) && !isRerun(parent)) continue;
        let ancestor = parent;
        while (ancestor && ancestor !== child) ancestor = parents.get(ancestor);
        if (!ancestor) parents.set(child, parent);
      }
    }
    const children = new Map();
    for (const [child, parent] of parents) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(child);
    }
    const descendants = report => (children.get(report) || []).flatMap(child => [child, ...descendants(child)]);
    const groups = reports.filter(report => !parents.has(report))
      .map(report => ({ report, relatedReports: descendants(report) }));
    const reruns = groups.filter(group => isRerun(group.report));
    if (reruns.length < 2) return groups;
    const members = [...new Set(reruns.flatMap(group => [group.report, ...group.relatedReports]))];
    const latest = [...members].sort((left, right) => (
      Date.parse(right.publishedAt || 0) - Date.parse(left.publishedAt || 0)
    ))[0];
    const merged = {
      report: {
        reportKey: 'presentation:reruns', presentationGroup: 'rerun', reportType: 'test-result',
        title: options.rerunTitle || 'Rerun results',
        summary: options.rerunSummary?.(members.length) || `${members.length} rerun reports`,
        status: combinedStatus(reruns.map(group => group.report.status || 'unknown')),
        metrics: [], sections: [], artifacts: [],
        publishedAt: latest.publishedAt || '',
      },
      relatedReports: members,
    };
    const first = groups.indexOf(reruns[0]);
    return groups.flatMap((group, index) => index === first ? [merged] : isRerun(group.report) ? [] : [group]);
  }

  return { definitions, definition, createTemplate, groupReports, combinedStatus };
}));
