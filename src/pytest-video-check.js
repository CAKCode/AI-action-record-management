const JSON_BLOB_ATTRIBUTE = /\bdata-jsonblob\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SNAPSHOT_SCRIPT = /(<script\b[^>]*\bid=["']video-check-snapshot["'][^>]*>)([\s\S]*?)(<\/script\s*>)/gi;

function decodeAttribute(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', quot: '"' };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&(amp|apos|gt|lt|quot);/gi, (_, name) => named[name.toLowerCase()]);
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// Locate only the top-level object we need. Decoding and parsing the tests field
// for every read used to dominate response time for large pytest reports.
function videoCheckAttributeField(attribute) {
  const tokens = /&(?:quot|#x[0-9a-f]+|#\d+);|[\\{}\[\]"]/gi;
  let depth = 0;
  let inString = false;
  let escapedUntil = -1;
  let stringStart = 0;
  let keyEnd = 0;
  let key = '';
  let start = -1;
  for (const token of attribute.matchAll(tokens)) {
    const raw = token[0];
    const char = raw.length === 1 ? raw : decodeAttribute(raw);
    if (inString) {
      if (token.index === escapedUntil) {
        escapedUntil = -1;
        continue;
      }
      if (char === '\\') escapedUntil = token.index + raw.length;
      else if (char === '"') {
        inString = false;
        if (depth === 1) {
          keyEnd = token.index + raw.length;
          key = parseJson(decodeAttribute(attribute.slice(stringStart, keyEnd)));
        }
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      stringStart = token.index;
    } else if (char === '{' || char === '[') {
      if (depth === 1 && key === 'videoCheck' && char === '{'
        && /^\s*:\s*$/.test(decodeAttribute(attribute.slice(keyEnd, token.index)))) start = token.index;
      depth++;
    } else if (char === '}' || char === ']') {
      depth--;
      if (start >= 0 && depth === 1) {
        const end = token.index + raw.length;
        const value = parseJson(decodeAttribute(attribute.slice(start, end)));
        return value ? { start, end, value } : null;
      }
    }
  }
  return null;
}

function readVideoCheckReport(html) {
  for (const match of html.matchAll(JSON_BLOB_ATTRIBUTE)) {
    const descriptor = videoCheckAttributeField(match[1] ?? match[2])?.value;
    if (!descriptor || typeof descriptor.source !== 'string' || !descriptor.run_id) continue;
    const snapshots = [...html.matchAll(SNAPSHOT_SCRIPT)]
      .map((snapshot) => parseJson(snapshot[2]));
    return {
      descriptor,
      snapshot: snapshots.find((snapshot) => snapshot?.run_id === descriptor.run_id) || null,
    };
  }
  return null;
}

function rewriteVideoCheckReport(html, mapDescriptor, mapSnapshot = (payload) => payload) {
  const withDescriptor = html.replace(JSON_BLOB_ATTRIBUTE, (attribute, doubleQuoted, singleQuoted) => {
    const raw = doubleQuoted ?? singleQuoted;
    const field = videoCheckAttributeField(raw);
    if (!field) return attribute;
    const descriptor = mapDescriptor(field.value);
    if (descriptor === field.value) return attribute;
    const encoded = scriptJson(descriptor)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/>/g, '&gt;');
    const offset = attribute.indexOf(raw);
    return attribute.slice(0, offset + field.start) + encoded + attribute.slice(offset + field.end);
  });
  return withDescriptor.replace(SNAPSHOT_SCRIPT, (script, opening, json, closing) => {
    const payload = parseJson(json);
    if (!payload) return script;
    const updated = mapSnapshot(payload);
    return updated === payload ? script : opening + scriptJson(updated) + closing;
  });
}

function mapVideoCheckDetails(payload, mapSource) {
  if (!payload?.cases || typeof payload.cases !== 'object' || Array.isArray(payload.cases)) return payload;
  let changed = false;
  const cases = Object.fromEntries(Object.entries(payload.cases).map(([id, summary]) => {
    if (typeof summary?.detail_source !== 'string') return [id, summary];
    const source = mapSource(summary.detail_source);
    if (source === summary.detail_source) return [id, summary];
    changed = true;
    return [id, { ...summary, detail_source: source }];
  }));
  return changed ? { ...payload, cases } : payload;
}

function readVideoCheckSummaryScript(script) {
  const match = /^\s*window\.__pytestVideoCheck\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(script);
  return match ? parseJson(match[1]) : null;
}

function videoCheckSummaryScript(payload) {
  return `window.__pytestVideoCheck = ${scriptJson(payload)};`;
}

module.exports = {
  readVideoCheckReport,
  rewriteVideoCheckReport,
  mapVideoCheckDetails,
  readVideoCheckSummaryScript,
  videoCheckSummaryScript,
};
