const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-session-history-'));
process.env.CODEX_DESK_DATA_DIR = path.join(root, 'data');
process.env.CODEX_DESK_RUNTIME_DIR = path.join(root, 'runtime');
const { historyDirectory, retainTaskSessionHistory, prepareTaskSessionResume } = require('../src/task-session-history');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('retained rollout survives Bridge home removal and reconnect preserves its thread', () => {
  const home = path.join(root, 'old-home');
  const source = path.join(root, 'source-home');
  const rollout = path.join(home, 'sessions/2026/10/26/rollout-thread-id.jsonl');
  const history = '{"type":"session_meta","payload":{"id":"same-thread"}}\n{"type":"response_item","payload":{"text":"prior context"}}\n';
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, history);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-private-key' }));
  fs.writeFileSync(path.join(source, 'config.toml'), 'model="fixture-model"\n');
  const runtime = { codexHome: home, sessionKey: 'single:old-task', threadId: 'same-thread' };
  assert.equal(retainTaskSessionHistory('old-task', runtime.sessionKey, runtime), 1);
  const saved = path.join(historyDirectory('old-task', runtime.sessionKey), '2026/10/26/rollout-thread-id.jsonl');
  assert.equal(fs.statSync(saved).ino, fs.statSync(rollout).ino);
  fs.rmSync(home, { recursive: true, force: true });
  prepareTaskSessionResume('old-task', runtime, { CODEX_SOURCE_HOME: source });
  assert.equal(runtime.threadId, 'same-thread');
  assert.equal(fs.readFileSync(rollout, 'utf8'), history);
  assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), fs.readFileSync(path.join(source, 'auth.json'), 'utf8'));
  assert.equal(fs.statSync(path.join(home, 'auth.json')).mode & 0o777, 0o600);
  fs.appendFileSync(rollout, '{"type":"response_item","payload":{"text":"continued context"}}\n');
  assert(fs.readFileSync(saved, 'utf8').includes('continued context'));
});

test('previously missing history is reported without inventing a new conversation', () => {
  const runtime = { codexHome: path.join(root, 'missing-home'), sessionKey: 'single:missing-task', threadId: 'missing-thread' };
  assert.throws(() => prepareTaskSessionResume('missing-task', runtime), /history was previously removed/);
  assert.equal(fs.existsSync(runtime.codexHome), false);
});
