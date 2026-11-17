const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BOOT_SOURCE = fs.readFileSync(path.join(__dirname, '../public/boot.js'), 'utf8');
const PROTECTED_SCRIPTS = [
  '/vendor/xterm/xterm.js',
  '/vendor/xterm/addon-fit.js',
  '/report-cards.js',
  '/app.js',
];

test('boot continues loading protected scripts after a page Basic Auth challenge', async () => {
  const scripts = [];
  const storage = new Map();
  const overlay = {
    classList: {
      add(name) { this.lastAdded = name; },
      remove(name) { this.lastRemoved = name; },
    },
  };
  const form = { addEventListener() {}, querySelector() { return null; } };
  const elements = new Map([
    ['authOverlay', overlay],
    ['authForm', form],
    ['authError', { textContent: '' }],
    ['authUser', { value: '' }],
    ['authPass', { value: '' }],
  ]);
  const document = {
    body: {
      appendChild(script) {
        scripts.push(script.src);
        queueMicrotask(() => script.onload());
      },
    },
    getElementById(id) { return elements.get(id) || null; },
    createElement() { return {}; },
  };
  const response = {
    ok: true,
    async json() { return { ok: false }; },
    headers: { get(name) { return name === 'x-codex-auth-required' ? '1' : null; } },
  };
  const context = {
    document,
    sessionStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); },
    },
    fetch: async () => response,
    btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
    setTimeout,
    queueMicrotask,
    console,
  };
  context.globalThis = context;

  vm.runInNewContext(BOOT_SOURCE, context);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(scripts, PROTECTED_SCRIPTS);
  assert.equal(overlay.classList.lastAdded, 'hidden');
  assert.equal(storage.size, 0);
});
