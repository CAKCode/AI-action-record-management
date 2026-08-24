'use strict';

const path = require('node:path');

const REPORT_SCHEMA_VERSION = 2;
const MAX_REPORT_BYTES = 256 * 1024;
const MAX_METRICS = 12;
const MAX_SECTIONS = 16;
const MAX_ARTIFACTS = 32;
const MAX_FIELDS = 48;
const MAX_LIST_ITEMS = 100;
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 200;
const MAX_PRIMARY_COMMAND_LENGTH = 32 * 1024;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPORT_STATUSES = new Set([
  'pending', 'running', 'succeeded', 'failed', 'partial', 'blocked', 'cancelled', 'unknown',
]);
const TONES = new Set(['neutral', 'info', 'success', 'warning', 'danger']);
const PRIORITIES = new Set(['primary', 'supporting', 'debug']);
const SENSITIVITIES = new Set(['normal', 'internal', 'sensitive']);
const FIELD_FORMATS = new Set(['text', 'code', 'status', 'datetime', 'duration', 'bytes', 'url']);
const SECTION_KINDS = new Set(['fields', 'list', 'table', 'json']);
const ARTIFACT_KINDS = new Set(['pytest-html', 'failure-analysis-markdown']);
function reportError(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function boundedText(value, label, maximum, required = false) {
  if (value == null) value = '';
  if (typeof value !== 'string') throw reportError(`${label} must be a string`);
  const result = value.trim();
  if (required && !result) throw reportError(`${label} is required`);
  if (result.length > maximum) throw reportError(`${label} exceeds ${maximum} characters`);
  return result;
}

function identifier(value, label, pattern = IDENTIFIER_PATTERN) {
  const result = boundedText(value, label, 128, true);
  if (!pattern.test(result)) throw reportError(`${label} contains unsupported characters`);
  return result;
}

function enumValue(value, label, allowed, fallback) {
  const result = boundedText(value == null ? fallback : value, label, 32, true);
  if (!allowed.has(result)) throw reportError(`${label} has an unsupported value`);
  return result;
}

function displayValue(value, label) {
  if (value == null) return '';
  if (typeof value === 'string') {
    if (value.length > 4000) throw reportError(`${label} exceeds 4000 characters`);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw reportError(`${label} must be finite`);
    return value;
  }
  if (typeof value === 'boolean') return value;
  throw reportError(`${label} must be text, a number, a boolean, or null`);
}

function normalizeFormat(value, label) {
  return enumValue(value, label, FIELD_FORMATS, 'text');
}

function normalizeMetric(metric, index) {
  if (!metric || typeof metric !== 'object' || Array.isArray(metric)) {
    throw reportError(`metrics[${index}] must be an object`);
  }
  return {
    key: identifier(metric.key, `metrics[${index}].key`),
    label: boundedText(metric.label, `metrics[${index}].label`, 80, true),
    value: displayValue(metric.value, `metrics[${index}].value`),
    tone: enumValue(metric.tone, `metrics[${index}].tone`, TONES, 'neutral'),
  };
}

function optionalTimestamp(value, label) {
  const timestamp = boundedText(value, label, 64);
  if (timestamp && Number.isNaN(Date.parse(timestamp))) {
    throw reportError(`${label} must be an ISO timestamp`);
  }
  return timestamp;
}

function normalizePrimaryExecution(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw reportError('primaryExecution must be an object');
  }
  const exitCode = value.exitCode ?? value.exit_code ?? null;
  if (exitCode != null && (!Number.isInteger(exitCode)
    || exitCode < -255 || exitCode > 255)) {
    throw reportError('primaryExecution.exitCode must be an integer from -255 to 255 or null');
  }
  return {
    label: boundedText(value.label, 'primaryExecution.label', 160, true),
    command: boundedText(
      value.command,
      'primaryExecution.command',
      MAX_PRIMARY_COMMAND_LENGTH,
      true,
    ),
    workingDirectory: boundedText(
      value.workingDirectory ?? value.working_directory,
      'primaryExecution.workingDirectory',
      4096,
    ),
    commandPath: boundedText(
      value.commandPath ?? value.command_path,
      'primaryExecution.commandPath',
      4096,
    ),
    status: enumValue(value.status, 'primaryExecution.status', REPORT_STATUSES, 'unknown'),
    exitCode,
    startedAt: optionalTimestamp(
      value.startedAt ?? value.started_at,
      'primaryExecution.startedAt',
    ),
    finishedAt: optionalTimestamp(
      value.finishedAt ?? value.finished_at,
      'primaryExecution.finishedAt',
    ),
  };
}

function normalizeExecutionEvidence(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw reportError('executionEvidence must be an object or null');
  }
  return {
    externalAttemptId: identifier(
      value.externalAttemptId ?? value.external_attempt_id,
      'executionEvidence.externalAttemptId',
    ),
  };
}

function normalizeArtifact(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw reportError(`artifacts[${index}] must be an object`);
  }
  const kind = enumValue(value.kind, `artifacts[${index}].kind`, ARTIFACT_KINDS);
  const sourcePath = boundedText(value.path, `artifacts[${index}].path`, 4096, true);
  if (!path.isAbsolute(sourcePath)) {
    throw reportError(`artifacts[${index}].path must be an absolute path`);
  }
  const expectedExtension = kind === 'pytest-html' ? /\.html?$/i : /\.md$/i;
  if (!expectedExtension.test(sourcePath)) {
    throw reportError(`artifacts[${index}].path has an unsupported extension for ${kind}`);
  }
  return {
    key: identifier(value.key, `artifacts[${index}].key`),
    kind,
    path: path.normalize(sourcePath),
  };
}

function normalizeField(field, label) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    throw reportError(`${label} must be an object`);
  }
  return {
    label: boundedText(field.label, `${label}.label`, 100, true),
    value: displayValue(field.value, `${label}.value`),
    format: normalizeFormat(field.format, `${label}.format`),
    tone: enumValue(field.tone, `${label}.tone`, TONES, 'neutral'),
  };
}

function normalizeListItem(item, label) {
  if (['string', 'number', 'boolean'].includes(typeof item) || item == null) {
    return { label: '', value: displayValue(item, label), tone: 'neutral' };
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw reportError(`${label} must be a display value or an object`);
  }
  return {
    label: boundedText(item.label, `${label}.label`, 100),
    value: displayValue(item.value, `${label}.value`),
    tone: enumValue(item.tone, `${label}.tone`, TONES, 'neutral'),
  };
}

function normalizeTable(section, sectionIndex) {
  const columns = Array.isArray(section.columns) ? section.columns : [];
  if (!columns.length || columns.length > MAX_TABLE_COLUMNS) {
    throw reportError(`sections[${sectionIndex}].columns must contain 1-${MAX_TABLE_COLUMNS} items`);
  }
  const normalizedColumns = columns.map((column, columnIndex) => {
    if (!column || typeof column !== 'object' || Array.isArray(column)) {
      throw reportError(`sections[${sectionIndex}].columns[${columnIndex}] must be an object`);
    }
    return {
      key: identifier(column.key, `sections[${sectionIndex}].columns[${columnIndex}].key`),
      label: boundedText(column.label, `sections[${sectionIndex}].columns[${columnIndex}].label`, 80, true),
      format: normalizeFormat(column.format, `sections[${sectionIndex}].columns[${columnIndex}].format`),
    };
  });
  if (new Set(normalizedColumns.map((column) => column.key)).size !== normalizedColumns.length) {
    throw reportError(`sections[${sectionIndex}].columns contains duplicate keys`);
  }
  const rows = Array.isArray(section.rows) ? section.rows : [];
  if (rows.length > MAX_TABLE_ROWS) {
    throw reportError(`sections[${sectionIndex}].rows exceeds ${MAX_TABLE_ROWS} items`);
  }
  return {
    columns: normalizedColumns,
    rows: rows.map((row, rowIndex) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw reportError(`sections[${sectionIndex}].rows[${rowIndex}] must be an object`);
      }
      return Object.fromEntries(normalizedColumns.map((column) => [
        column.key,
        displayValue(row[column.key], `sections[${sectionIndex}].rows[${rowIndex}].${column.key}`),
      ]));
    }),
  };
}

function jsonValue(value, label) {
  if (value === undefined) throw reportError(`${label} is required`);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw reportError(`${label} must be JSON serializable`);
  }
  if (serialized === undefined) throw reportError(`${label} must be JSON serializable`);
  return JSON.parse(serialized);
}

function normalizeSection(section, index) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw reportError(`sections[${index}] must be an object`);
  }
  const kind = enumValue(section.kind, `sections[${index}].kind`, SECTION_KINDS, 'fields');
  const sensitivity = enumValue(
    section.sensitivity,
    `sections[${index}].sensitivity`,
    SENSITIVITIES,
    'normal',
  );
  const normalized = {
    id: identifier(section.id, `sections[${index}].id`),
    title: boundedText(section.title, `sections[${index}].title`, 120, true),
    kind,
    priority: enumValue(section.priority, `sections[${index}].priority`, PRIORITIES, 'supporting'),
    sensitivity,
    defaultExpanded: sensitivity !== 'sensitive' && kind !== 'json' && section.defaultExpanded === true,
    description: boundedText(section.description, `sections[${index}].description`, 1000),
  };
  if (kind === 'fields') {
    const fields = Array.isArray(section.fields) ? section.fields : [];
    if (fields.length > MAX_FIELDS) throw reportError(`sections[${index}].fields exceeds ${MAX_FIELDS} items`);
    normalized.fields = fields.map((field, fieldIndex) => normalizeField(
      field,
      `sections[${index}].fields[${fieldIndex}]`,
    ));
  } else if (kind === 'list') {
    const items = Array.isArray(section.items) ? section.items : [];
    if (items.length > MAX_LIST_ITEMS) {
      throw reportError(`sections[${index}].items exceeds ${MAX_LIST_ITEMS} items`);
    }
    normalized.items = items.map((item, itemIndex) => normalizeListItem(
      item,
      `sections[${index}].items[${itemIndex}]`,
    ));
  } else if (kind === 'table') {
    Object.assign(normalized, normalizeTable(section, index));
  } else {
    normalized.data = jsonValue(section.data, `sections[${index}].data`);
  }
  return normalized;
}

function normalizeSkillReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw reportError('Skill report must be an object');
  }
  const schemaVersion = Number(input.schemaVersion ?? input.schema_version);
  if (schemaVersion !== REPORT_SCHEMA_VERSION) {
    throw reportError(`schemaVersion must be ${REPORT_SCHEMA_VERSION}`);
  }
  const metrics = Array.isArray(input.metrics) ? input.metrics : [];
  const sections = Array.isArray(input.sections) ? input.sections : [];
  if (!Array.isArray(input.artifacts)) throw reportError('artifacts must be an array');
  const artifacts = normalizeArtifactDeclarations(input.artifacts);
  if (metrics.length > MAX_METRICS) throw reportError(`metrics exceeds ${MAX_METRICS} items`);
  if (!sections.length || sections.length > MAX_SECTIONS) {
    throw reportError(`sections must contain 1-${MAX_SECTIONS} items`);
  }
  const observedAt = optionalTimestamp(input.observedAt ?? input.observed_at, 'observedAt');
  const report = {
    schemaVersion,
    reportKey: identifier(input.reportKey ?? input.report_key, 'reportKey'),
    skillId: identifier(input.skillId ?? input.skill_id, 'skillId', SKILL_ID_PATTERN),
    reportType: identifier(input.reportType ?? input.report_type, 'reportType'),
    title: boundedText(input.title, 'title', 160, true),
    status: enumValue(input.status, 'status', REPORT_STATUSES, 'unknown'),
    summary: boundedText(input.summary, 'summary', 2000, true),
    observedAt,
    executionEvidence: normalizeExecutionEvidence(
      input.executionEvidence ?? input.execution_evidence,
    ),
    primaryExecution: normalizePrimaryExecution(
      input.primaryExecution ?? input.primary_execution,
    ),
    artifacts,
    metrics: metrics.map(normalizeMetric),
    sections: sections.map(normalizeSection),
  };
  if (new Set(report.metrics.map((metric) => metric.key)).size !== report.metrics.length) {
    throw reportError('metrics contains duplicate keys');
  }
  if (new Set(report.sections.map((section) => section.id)).size !== report.sections.length) {
    throw reportError('sections contains duplicate ids');
  }
  if (report.artifacts.length && !report.executionEvidence) {
    throw reportError('executionEvidence is required when artifacts are declared');
  }
  if (report.artifacts.length && ['pending', 'running'].includes(report.status)) {
    throw reportError('pending or running reports cannot declare artifacts');
  }
  const bytes = Buffer.byteLength(JSON.stringify(report));
  if (bytes > MAX_REPORT_BYTES) throw reportError(`Skill report exceeds ${MAX_REPORT_BYTES} bytes`);
  return report;
}

function normalizeArtifactDeclarations(input, label = 'artifacts') {
  if (!Array.isArray(input)) throw reportError(`${label} must be an array`);
  if (input.length > MAX_ARTIFACTS) throw reportError(`${label} exceeds ${MAX_ARTIFACTS} items`);
  const artifacts = input.map(normalizeArtifact);
  if (new Set(artifacts.map((artifact) => artifact.key)).size !== artifacts.length) {
    throw reportError(`${label} contains duplicate keys`);
  }
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    throw reportError(`${label} contains duplicate paths`);
  }
  return artifacts;
}

module.exports = {
  MAX_REPORT_BYTES,
  REPORT_SCHEMA_VERSION,
  normalizeArtifactDeclarations,
  normalizeSkillReport,
};
