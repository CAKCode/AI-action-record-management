'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createInteractiveCliTranscriptStore } = require('../src/interactive-cli-transcript');

test('interactive CLI transcripts preserve and verify every PTY output byte', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-cli-transcript-'));
  const sessionsDir = path.join(root, 'sessions');
  const taskDir = path.join(sessionsDir, 'audit-task');
  fs.mkdirSync(taskDir, { recursive: true });
  const store = createInteractiveCliTranscriptStore({ sessionsDir });
  const writer = store.start('audit-task', { threadId: 'thread-audit', pid: 4812 });
  const chunks = [Buffer.from('\u001b[32m$ codex\u001b[0m\r\n'), Buffer.from([0, 1, 2, 255])];
  for (const chunk of chunks) writer.append(chunk);
  const manifest = writer.seal({ exitCode: 0, signal: 15 });

  assert.equal(manifest.bytes, Buffer.concat(chunks).length);
  assert.equal(manifest.threadId, 'thread-audit');
  assert.equal(manifest.recovered, false);
  const replayed = [];
  const result = await store.replay('audit-task', async (chunk) => replayed.push(chunk));
  assert.deepEqual(Buffer.concat(replayed), Buffer.concat(chunks));
  assert.equal(result.archives.length, 1);
  assert.equal(result.totalBytes, manifest.bytes);

  const directory = path.join(taskDir, 'interactive-cli');
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, `${writer.id}.raw`)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(directory, `${writer.id}.json`)).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});

test('managed PTY transcripts bind the final rollout thread to the originating Attempt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-cli-transcript-'));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(path.join(sessionsDir, 'managed-task'), { recursive: true });
  const store = createInteractiveCliTranscriptStore({ sessionsDir });
  const writer = store.start('managed-task', {
    mode: 'managed', attemptId: 'attempt-managed-1', pid: 9921,
  });
  writer.append('\u001b[32mmanaged PTY\u001b[0m\r\n');
  const manifest = writer.seal({ exitCode: 0, threadId: 'thread-from-rollout' });

  assert.equal(manifest.mode, 'managed');
  assert.equal(manifest.attemptId, 'attempt-managed-1');
  assert.equal(manifest.threadId, 'thread-from-rollout');
  assert.equal((await store.verify('managed-task')).archives.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('interactive CLI transcript replay rejects changed archived output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-cli-transcript-tamper-'));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(path.join(sessionsDir, 'tampered-task'), { recursive: true });
  const store = createInteractiveCliTranscriptStore({ sessionsDir });
  const writer = store.start('tampered-task');
  writer.append('original output\r\n');
  writer.seal({ exitCode: 0 });
  fs.appendFileSync(
    path.join(sessionsDir, 'tampered-task', 'interactive-cli', `${writer.id}.raw`),
    'changed',
  );

  await assert.rejects(
    store.verify('tampered-task'),
    /size does not match its manifest/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('interactive CLI transcript replay verifies content before emitting archived output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-cli-transcript-preflight-'));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(path.join(sessionsDir, 'preflight-task'), { recursive: true });
  const store = createInteractiveCliTranscriptStore({ sessionsDir });
  const writer = store.start('preflight-task');
  const content = Buffer.from('trusted archived output\r\n');
  writer.append(content);
  writer.seal({ exitCode: 0 });
  fs.writeFileSync(
    path.join(sessionsDir, 'preflight-task', 'interactive-cli', `${writer.id}.raw`),
    Buffer.alloc(content.length, 88),
  );
  const replayed = [];

  await assert.rejects(
    store.replay('preflight-task', async (chunk) => replayed.push(chunk)),
    /failed integrity verification/,
  );
  assert.equal(replayed.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('interactive CLI transcript replay rejects a manifest whose raw output is missing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-cli-transcript-missing-'));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(path.join(sessionsDir, 'missing-raw-task'), { recursive: true });
  const store = createInteractiveCliTranscriptStore({ sessionsDir });
  const writer = store.start('missing-raw-task');
  writer.append('archived output\r\n');
  writer.seal({ exitCode: 0 });
  fs.unlinkSync(path.join(
    sessionsDir,
    'missing-raw-task',
    'interactive-cli',
    `${writer.id}.raw`,
  ));

  await assert.rejects(
    store.replay('missing-raw-task', async () => {}),
    /is not a regular file/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('interactive CLI transcript manifest publication can be retried after a filesystem failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-cli-transcript-seal-retry-'));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(path.join(sessionsDir, 'seal-retry-task'), { recursive: true });
  const store = createInteractiveCliTranscriptStore({ sessionsDir });
  const writer = store.start('seal-retry-task');
  writer.append('complete output\r\n');
  const manifestPath = path.join(
    sessionsDir,
    'seal-retry-task',
    'interactive-cli',
    `${writer.id}.json`,
  );
  fs.mkdirSync(manifestPath);

  assert.throws(() => writer.seal({ exitCode: 0 }));
  fs.rmdirSync(manifestPath);
  const manifest = writer.seal({ exitCode: 0 });

  assert.equal(manifest.bytes, Buffer.byteLength('complete output\r\n'));
  assert.equal(fs.statSync(manifestPath).isFile(), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('unfinished transcripts are sealed for read-only archival after process loss', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-cli-transcript-recover-'));
  const sessionsDir = path.join(root, 'sessions');
  const directory = path.join(sessionsDir, 'recovered-task', 'interactive-cli');
  fs.mkdirSync(directory, { recursive: true });
  const transcriptId = 'cli-1700000000000-0123456789abcdef';
  const content = Buffer.from('persisted before process loss\r\n');
  fs.writeFileSync(path.join(directory, `${transcriptId}.raw`), content, { mode: 0o600 });
  const store = createInteractiveCliTranscriptStore({ sessionsDir });

  const [manifest] = store.sealUnfinished('recovered-task');
  assert.equal(manifest.recovered, true);
  assert.equal(manifest.bytes, content.length);
  const replayed = [];
  await store.replay('recovered-task', async (chunk) => replayed.push(chunk));
  assert.deepEqual(Buffer.concat(replayed), content);
  fs.rmSync(root, { recursive: true, force: true });
});

test('archived transcript replay stops reading after its consumer disconnects', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-cli-transcript-cancel-'));
  const sessionsDir = path.join(root, 'sessions');
  fs.mkdirSync(path.join(sessionsDir, 'cancelled-task'), { recursive: true });
  const store = createInteractiveCliTranscriptStore({ sessionsDir });
  const writer = store.start('cancelled-task');
  writer.append(Buffer.alloc((256 * 1024) + 1, 65));
  writer.seal({ exitCode: 0 });
  let cancelled = false;
  let chunks = 0;

  const result = await store.replay('cancelled-task', async () => {
    chunks += 1;
    cancelled = true;
  }, { cancelled: () => cancelled });

  assert.equal(result.cancelled, true);
  assert.equal(chunks, 1);
  assert.equal(result.totalBytes, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
