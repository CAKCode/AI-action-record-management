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

function readVideoCheckReport(html) {
  for (const match of html.matchAll(JSON_BLOB_ATTRIBUTE)) {
    const descriptor = parseJson(decodeAttribute(match[1] ?? match[2]))?.videoCheck;
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
    const blob = parseJson(decodeAttribute(doubleQuoted ?? singleQuoted));
    if (!blob?.videoCheck) return attribute;
    const descriptor = mapDescriptor(blob.videoCheck);
    if (descriptor === blob.videoCheck) return attribute;
    const encoded = scriptJson({ ...blob, videoCheck: descriptor })
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/>/g, '&gt;');
    return `data-jsonblob="${encoded}"`;
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
