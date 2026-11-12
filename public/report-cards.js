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

  const columnLabels = {
    case: ['用例', 'Case'], outcome: ['结果', 'Outcome'], detail: ['说明', 'Detail'],
    target: ['目标', 'Target'], component: ['组件', 'Component'], version: ['版本', 'Version'],
    classification: ['分类', 'Classification'], evidence: ['证据', 'Evidence'], action: ['下一步', 'Next action'],
    stage: ['阶段', 'Stage'], scope: ['统计口径', 'Scope'], total: ['总数', 'Total'],
    passed: ['Pass', 'Pass'], failed: ['Fail', 'Fail'], skipped: ['Skip', 'Skip'],
    error: ['Error', 'Error'], xfailed: ['XFail', 'XFail'], xpassed: ['XPass', 'XPass'], unknown: ['未知', 'Unknown'],
  };
  const metrics = {
    total: ['总数', 'Total', 'neutral'], passed: ['Pass', 'Pass', 'success'], failed: ['Fail', 'Fail', 'danger'],
    skipped: ['Skip', 'Skip', 'neutral'], error: ['Error', 'Error', 'danger'], xfailed: ['XFail', 'XFail', 'neutral'],
    duration: ['耗时', 'Duration', 'neutral'], selected: ['重跑用例', 'Selected cases', 'neutral'],
    recovered: ['重跑恢复', 'Recovered', 'success'], persistent: ['仍需处理', 'Still failing', 'danger'],
    targets: ['目标数', 'Targets', 'neutral'], succeeded: ['成功', 'Succeeded', 'success'],
    analyzed: ['已分析', 'Analyzed', 'neutral'], confirmed: ['确认问题', 'Confirmed issues', 'danger'],
    unresolved: ['待确认', 'Unresolved', 'warning'], completed: ['已完成阶段', 'Completed stages', 'success'],
    stages: ['阶段总数', 'Stages', 'neutral'],
  };
  const metricOrder = {
    test: ['total', 'passed', 'failed', 'skipped', 'error', 'xfailed', 'duration'],
    deployment: ['targets', 'succeeded', 'failed', 'duration'],
    analysis: ['analyzed', 'confirmed', 'unresolved'], workflow: ['stages', 'completed', 'failed'], business: [],
  };
  const presets = [
    { id: 'rerun', reportType: 'test-result', labels: { zh: '重跑结果', en: 'Rerun results' },
      metrics: ['selected', 'passed', 'failed', 'recovered', 'persistent', 'duration'] },
    { id: 'final-summary', reportType: 'workflow-progress', labels: { zh: '最终汇总', en: 'Final summary' },
      sectionId: 'final-results', columns: ['scope', 'total', 'passed', 'failed', 'skipped', 'error', 'xfailed', 'xpassed', 'unknown'] },
  ];

  function localLabel(values, language) {
    return values?.[language === 'en' ? 1 : 0];
  }

  function cardCatalog() {
    return { templateVersion: 1, schemaVersion: 2,
      cards: definitions.map(card => ({ ...card, metrics: metricOrder[card.id],
        columnLabels: Object.fromEntries((card.columns || []).map(key => [key, columnLabels[key]])) })),
      presets, metricFields: metrics };
  }

  function templateMetrics(data, keys, language) {
    const supplied = new Map(Array.isArray(data.metrics)
      ? data.metrics.map(metric => [metric.key, metric])
      : Object.entries(data.metrics || {}).map(([key, value]) => [key, { value }]));
    if (!supplied.has('error') && supplied.has('errors')) supplied.set('error', supplied.get('errors'));
    supplied.delete('errors');
    return [...new Set([...keys, ...supplied.keys()])].flatMap(key => {
      const input = supplied.get(key);
      if (input?.value == null || input.value === '') return [];
      const standard = metrics[key];
      return [{ key, label: standard ? localLabel(standard, language) : (input.label || key),
        value: input.value, tone: standard?.[2] || input.tone || 'neutral' }];
    });
  }

  function definition(reportType) {
    const type = String(reportType || '').trim().toLowerCase();
    return definitions.find(card => card.reportType === type || card.id === type || card.aliases?.includes(type))
      || definitions[definitions.length - 1];
  }

  function createTemplate(options = {}) {
    const language = options.language === 'en' ? 'en' : 'zh';
    const preset = options.preset ? presets.find(item => item.id === options.preset) : null;
    if (options.preset && !preset) throw new Error(`Unknown report card preset: ${options.preset}`);
    const card = definition(options.type || preset?.reportType);
    if (preset && preset.reportType !== card.reportType) throw new Error(`The ${preset.id} preset uses ${preset.reportType}`);
    const data = options.data || {};
    const requested = String(options.type || card.reportType);
    const normalized = requested.trim().toLowerCase();
    const reportType = [card.id, card.reportType, ...(card.aliases || [])].includes(normalized) ? card.reportType : requested;
    const summary = options.summary || data.summary || (language === 'en' ? 'Fill in the observed business conclusion.' : '待补充本轮真实业务结论。');
    const columns = preset?.columns || card.columns;
    const section = {
      id: preset?.sectionId || card.sectionId, title: preset?.sectionId ? preset.labels[language] : card.sectionLabels[language],
      kind: columns ? 'table' : 'fields', priority: 'primary', defaultExpanded: true,
      ...(columns
        ? { columns: columns.map(key => ({ key, label: localLabel(columnLabels[key], language) || key, format: 'text' })), rows: data.rows || [] }
        : { fields: data.fields || [{ label: language === 'en' ? 'Result' : '结果', value: '' }] }),
    };
    const report = {
      schemaVersion: 2,
      reportKey: options.reportKey || 'business:run',
      skillId: options.skillId || 'business-skill',
      reportType, title: options.title || data.title || preset?.labels[language] || card.labels[language],
      status: options.status || data.status || 'unknown', summary,
      artifacts: ['pending', 'running'].includes(options.status || data.status) ? [] : (data.artifacts || []),
      metrics: templateMetrics(data, preset?.metrics || metricOrder[card.id], language), sections: [section],
    };
    if (preset?.id === 'final-summary') {
      const countsData = data.available === false ? {} : data;
      section.rows = ['cumulative', 'final'].flatMap(scope => {
        if (!countsData[scope]) return [];
        const counts = Object.fromEntries(preset.columns.filter(key => countsData[scope][key] != null).map(key => [key, countsData[scope][key]]));
        return [{ scope: scope === 'cumulative' ? (language === 'en' ? 'Cumulative (including reruns)' : '累计（含重跑）')
          : (language === 'en' ? 'Final (reruns replace earlier results)' : '最终（重跑覆盖）'), ...counts }];
      });
      const countMetrics = ['cumulative', 'final'].flatMap(scope => ['total', 'passed', 'failed'].flatMap(key => {
        const value = countsData[scope]?.[key];
        if (value == null) return [];
        const prefix = scope === 'cumulative' ? (language === 'en' ? 'Cumulative' : '累计') : (language === 'en' ? 'Final' : '最终');
        return [{ key: `${scope}_${key}`, label: `${prefix} ${localLabel(metrics[key], language)}`, value, tone: metrics[key][2] }];
      }));
      report.metrics = [...countMetrics, ...report.metrics.filter(metric => !countMetrics.some(count => count.key === metric.key))];
      if (typeof data.complete === 'boolean') report.sections.push({ id: 'count-source',
        title: language === 'en' ? 'Count provenance' : '统计来源', kind: 'fields', priority: 'supporting', defaultExpanded: false,
        fields: [
          { label: language === 'en' ? 'Complete' : '统计完整', value: data.complete },
          ...(typeof data.available === 'boolean' ? [{ label: language === 'en' ? 'Available' : '统计可用', value: data.available }] : []),
          ...[['reportCount', '已读取报告', 'Reports read'], ['executed', '实际执行（不含 Skip）', 'Executions excluding Skip']]
            .filter(([key]) => data[key] != null).map(([key, zh, en]) => ({ label: language === 'en' ? en : zh, value: data[key] })),
        ] });
    }
    for (const [id, title] of [['context', language === 'en' ? 'Scope and environment' : '范围与环境'],
      ['evidence', language === 'en' ? 'Evidence and details' : '证据与详情']]) {
      if (data[id]?.length) report.sections.push({ id, title, kind: 'fields', priority: 'supporting', defaultExpanded: false, fields: data[id] });
    }
    report.sections.push(...(data.sections || []));
    const executionEvidence = options.externalAttemptId
      ? { externalAttemptId: options.externalAttemptId } : data.executionEvidence;
    if (executionEvidence) report.executionEvidence = { ...executionEvidence };
    const relatedReports = options.relatedReports || data.relatedReportKeys;
    if (relatedReports) report.relatedReportKeys = Array.isArray(relatedReports)
      ? relatedReports : relatedReports.split(',').map(key => key.trim()).filter(Boolean);
    if (data.observedAt) report.observedAt = data.observedAt;
    if (options.command || data.primaryExecution?.command) report.primaryExecution = {
      ...data.primaryExecution, label: data.primaryExecution?.label || report.title,
      command: options.command || data.primaryExecution.command,
      workingDirectory: options.workingDirectory || data.primaryExecution?.workingDirectory || '', status: report.status,
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

  return { definitions, definition, presets, cardCatalog, createTemplate, groupReports, combinedStatus };
}));
