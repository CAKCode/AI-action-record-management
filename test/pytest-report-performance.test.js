const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { gunzipSync } = require('node:zlib');
const { acceptsGzip, gzipHtmlArtifact } = require('../src/report-http-encoding');
const { readVideoCheckReport, rewriteVideoCheckReport } = require('../src/pytest-video-check');

function attributeJson(html) {
  const attribute = /data-jsonblob=(?:"([^"]*)"|'([^']*)')/.exec(html);
  return JSON.parse((attribute[1] ?? attribute[2]).replace(/&(quot|amp|#39|#34);/g,
    (_, entity) => ({ quot: '"', amp: '&', '#39': "'", '#34': '"' })[entity]));
}

test('Video Check reads and rewrites only its top-level descriptor while preserving all test data', () => {
  for (const quote of ['&quot;', '&#34;', '"']) {
    for (const first of [true, false]) {
      const descriptor = { run_id: 'run-1', source: 'checks/results.js', nested: { value: 'quote " slash \\ } ]' } };
      const tests = { nested: { videoCheck: { run_id: 'wrong', source: 'wrong.js' } },
        log: ('escaped \\" braces { [ ] } and fake "videoCheck": {} ').repeat(1000) };
      const blob = first ? { videoCheck: descriptor, tests } : { tests, videoCheck: descriptor };
      const encoded = JSON.stringify(blob).replace(/&/g, '&amp;').replace(/"/g, quote);
      const html = `<div data-jsonblob='${encoded}'></div>`;
      assert.deepEqual(readVideoCheckReport(html).descriptor, descriptor);
      assert.equal(rewriteVideoCheckReport(html, value => value), html);
      const changed = rewriteVideoCheckReport(html, value => ({ ...value, source: "archive/result's.js" }));
      assert.deepEqual(attributeJson(changed), { ...blob, videoCheck: { ...descriptor, source: "archive/result's.js" } });
    }
  }
  const nestedOnly = '<div data-jsonblob=\'{"tests":{"videoCheck":{"run_id":"wrong","source":"wrong.js"}}}\'></div>';
  assert.equal(readVideoCheckReport(nestedOnly), null);
  assert.equal(rewriteVideoCheckReport(nestedOnly, () => { throw new Error('nested data must not be rewritten'); }), nestedOnly);
  const encodedPunctuation = JSON.stringify({ tests: { log: '\\" } [ \\\\ "videoCheck": {}' },
    videoCheck: { source: 'checks/quote"and\\slash.js', run_id: 'run-2' } })
    .replace('"videoCheck"', '"vi\\u0064eoCheck"')
    .replace(/[\\"{}]/g, character => `&#${character.charCodeAt(0)};`);
  assert.deepEqual(readVideoCheckReport(`<div data-jsonblob='${encodedPunctuation}'></div>`).descriptor,
    { source: 'checks/quote"and\\slash.js', run_id: 'run-2' });
});

test('HTML compression negotiates gzip, preserves decoded bytes and leaves binary media untouched', async () => {
  assert.equal(acceptsGzip(), false);
  assert.equal(acceptsGzip('br, GZip; q=0.8'), true);
  assert.equal(acceptsGzip('gzip;q=0, *;q=1'), false);
  assert.equal(acceptsGzip('*;q=0.5'), true);
  const content = Buffer.from('<html>same report and all cases</html>'.repeat(500));
  const original = { content, bytes: content.length, mediaType: 'text/html; charset=utf-8' };
  const compressed = await gzipHtmlArtifact(original, 'gzip');
  assert.equal(compressed.contentEncoding, 'gzip');
  assert.ok(compressed.bytes < original.bytes / 2);
  assert.deepEqual(gunzipSync(compressed.content), content);
  assert.equal(await gzipHtmlArtifact(original, 'identity'), original);
  const video = { ...original, mediaType: 'video/mp4' };
  assert.equal(await gzipHtmlArtifact(video, 'gzip'), video);
});

function rendererFixture() {
  const frames = new Map();
  let nextFrame = 0;
  let ticks = 0;
  let created = 0;
  let bound = 0;
  let document;
  class Element {
    constructor(kind) {
      this.kind = kind;
      this.children = [];
      this.ownerDocument = document;
      const classes = new Set();
      this.classList = {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
      };
    }
    get isConnected() { return this.kind === 'table' || Boolean(this.parentNode?.isConnected); }
    appendChild(child) {
      if (child.kind === 'fragment') {
        for (const item of [...child.children]) this.appendChild(item);
      } else {
        child.remove();
        child.parentNode = this;
        this.children.push(child);
      }
      return child;
    }
    replaceChildren(...children) {
      for (const child of [...this.children]) child.remove();
      for (const child of children) this.appendChild(child);
    }
    prepend(child) { this.appendChild(child); this.children.unshift(this.children.pop()); }
    querySelector(selector) {
      if (selector === 'tbody') return null;
      if (selector === '.extras-row') return this.extras;
      if (selector === '.collapsible > .col-result') return this.resultCell;
      return null;
    }
    querySelectorAll() { return this.media || []; }
    setAttribute() {}
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
      this.parentNode = null;
    }
  }
  document = {
    getElementById: () => ({ content: { cloneNode: () => new Element('empty') } }),
    createElement: kind => new Element(kind), createDocumentFragment: () => new Element('fragment'),
  };
  const table = new Element('table');
  const header = new Element('header');
  const context = {
    module: { exports: {} },
    performance: { now: () => ticks++ },
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/pytest-report-table.js'), 'utf8'), context);
  const renderRows = context.module.exports.createResultTableRenderer({
    createRow(data) {
      created++;
      const row = new Element('row');
      row.caseId = data.id;
      row.extras = new Element('extras');
      row.resultCell = new Element('result');
      return row;
    },
    onRowCreated() { bound++; },
  });
  return {
    table, frames,
    render: tests => renderRows(table, header, tests),
    rowIds: () => table.children.filter(child => child.kind === 'row').map(child => child.caseId),
    created: () => created, bound: () => bound,
    flush() {
      for (let turns = 0; frames.size && turns < 1000; turns++) {
        const [id, callback] = frames.entries().next().value;
        frames.delete(id);
        callback();
      }
      assert.equal(frames.size, 0);
    },
  };
}

test('large report rendering yields, retains every case and cancels obsolete redraws', () => {
  const fixture = rendererFixture();
  const tests = Array.from({ length: 401 }, (_, id) => ({ id }));
  fixture.render(tests);
  assert.ok(fixture.rowIds().length > 0 && fixture.rowIds().length < tests.length);
  assert.equal(fixture.frames.size, 1);
  fixture.render(tests.slice().reverse());
  assert.equal(fixture.frames.size, 1);
  fixture.flush();
  assert.deepEqual(fixture.rowIds(), tests.map(item => item.id).reverse());
  assert.equal(fixture.created(), tests.length, 'a case is built only once even when its first render is interrupted');
  assert.equal(fixture.bound(), tests.length);
  assert.equal(fixture.table.children.some(child => child.kind === 'caption'), false);
});

test('sorting and collapsing reuse rows; filtering evicts rows and changing content rebuilds only that case', () => {
  const fixture = rendererFixture();
  const tests = Array.from({ length: 100 }, (_, id) => ({ id, log: 'original', collapsed: false }));
  fixture.render(tests);
  const originalRows = new Map(fixture.table.children.filter(row => row.kind === 'row').map(row => [row.caseId, row]));
  fixture.render(tests.slice().reverse());
  assert.equal(fixture.created(), 100);
  assert.ok(fixture.table.children.filter(row => row.kind === 'row').every(row => row === originalRows.get(row.caseId)));
  const collapsed = tests.map(data => ({ ...data, collapsed: true }));
  fixture.render(collapsed);
  assert.equal(fixture.created(), 100);
  assert.ok(originalRows.get(0).extras.classList.contains('hidden'));
  fixture.render(tests.slice(0, 10));
  assert.equal(fixture.frames.size, 0);
  assert.deepEqual(fixture.rowIds(), tests.slice(0, 10).map(data => data.id));
  fixture.render(tests);
  assert.equal(fixture.created(), 190, 'only filtered-out cases are rebuilt when their category returns');
  fixture.render(tests.map(data => data.id === 0 ? { ...data, log: 'updated' } : data));
  assert.equal(fixture.created(), 191);
  assert.notEqual(fixture.table.children.find(row => row.caseId === 0), originalRows.get(0));
  fixture.render([]);
  assert.deepEqual(fixture.rowIds(), []);
});
test('Video Check evicts old details and consumes its script payloads', () => {
    const requests = []
    const context = {
        module: { exports: {} }, window: { __pytestVideoCheckDetails: {} },
        document: {
            createElement: () => ({ remove() { this.removed = true } }),
            body: { appendChild: (script) => requests.push(script) },
        },
    }
    const original = fs.readFileSync(path.join(__dirname, 'fixtures/pytest-video-check-legacy.js'), 'utf8')
    const source = require('../src/pytest-report-performance').progressivePytestReportHtml(original)
    vm.runInNewContext(source + `
module.exports.configure = value => { descriptor = value }
module.exports.loadDetails = loadDetails
module.exports.cache = detailCache
showVideoCheckDetail = (output, text) => { output.textContent = text }`, context)
    const api = context.module.exports
    api.configure({ run_id: 'run', source: 'checks/results.js' })
    const load = (id, open = true, detail = { id }) => {
        const output = { dataset: {}, closest: () => ({ open }), textContent: '' }
        const before = requests.length
        api.loadDetails(id, { detail_source: `${id}.js`, detail_updated_at: 1 }, output)
        if (requests.length !== before) {
            context.window.__pytestVideoCheckDetails[id] = { run_id: 'run', case_id: id, detail }
            requests[requests.length - 1].onload()
        }
        return output
    }
    for (let index = 0; index < 40; index++) load(`case${index}`)
    assert.equal(api.cache.size, 32)
    assert.equal(Object.keys(context.window.__pytestVideoCheckDetails).length, 0)
    const before = requests.length
    load('case8')
    assert.equal(requests.length, before)
    load('case40')
    assert.equal(api.cache.has('case8:1'), true)
    assert.equal(api.cache.has('case9:1'), false)
    const closed = load('case41', false)
    assert.equal(closed.textContent, '展开加载检查详情')
    load('case0')
    assert.equal(requests.length, before + 3)
    const large = { payload: 'x'.repeat(5 * 1024 * 1024) }
    const output = load('large', true, large)
    assert.equal(JSON.parse(output.textContent).payload.length, large.payload.length)
    assert.equal(api.cache.has('large:1'), false)
    const cachedBytes = Array.from(api.cache.values()).reduce((sum, text) => sum + text.length * 2, 0)
    assert.ok(cachedBytes <= 8 * 1024 * 1024)
})
test('collapsing pauses native media and filtering releases its source buffers', () => {
    const fixture = rendererFixture()
    fixture.render([{ id: 0, collapsed: false }])
    const row = fixture.table.children.find((child) => child.kind === 'row')
    let pauses = 0
    let unloads = 0
    const removed = []
    row.media = [{
        pause: () => pauses++, load: () => unloads++,
        removeAttribute: (name) => removed.push(name), querySelectorAll: () => [],
    }]
    fixture.render([{ id: 0, collapsed: true }])
    assert.equal(pauses, 1)
    assert.equal(unloads, 0)
    fixture.render([])
    assert.equal(pauses, 2)
    assert.equal(unloads, 1)
    assert.deepEqual(removed, ['src'])
    assert.equal(row.parentNode, null)
});
