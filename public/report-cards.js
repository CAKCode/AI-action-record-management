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
    if (options.command) report.primaryExecution = {
      label: options.title || card.labels.zh, command: options.command,
      workingDirectory: options.workingDirectory || '', status: report.status,
    };
    return report;
  }

  return { definitions, definition, createTemplate };
}));
