const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { measureTaskStorage } = require('../src/task-storage');
const playbackData = fs.mkdtempSync(path.join(os.tmpdir(), 'deleted-task-playback-'));
process.env.CODEX_DESK_DATA_DIR = playbackData;
const { openHlsPlaybackFile } = require('../src/report-media-playback');

test.after(() => fs.rmSync(playbackData, { recursive: true, force: true }));

test('task storage includes archived media and cache, deduplicates hardlinks and does not follow source links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-storage-size-'));
  try {
    const session = path.join(root, 'session');
    const archive = path.join(session, 'skill-report-artifacts');
    const cache = path.join(archive, '.playback-cache');
    const snapshot = path.join(root, 'snapshot');
    const source = path.join(root, 'source');
    for (const dir of [archive, cache, snapshot, source]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(archive, 'video.mp4'), Buffer.alloc(1024));
    fs.linkSync(path.join(archive, 'video.mp4'), path.join(archive, 'same-video.mp4'));
    fs.writeFileSync(path.join(cache, 'playback.mp4'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(session, 'stdout.log'), Buffer.alloc(128));
    fs.writeFileSync(path.join(snapshot, 'SKILL.md'), Buffer.alloc(64));
    fs.writeFileSync(path.join(source, 'original.mp4'), Buffer.alloc(1024 * 1024));
    fs.symlinkSync(source, path.join(archive, 'source-link'));
    const usage = measureTaskStorage(session, snapshot);
    const metadata = fs.lstatSync(archive).size + fs.lstatSync(cache).size + fs.lstatSync(path.join(archive, 'source-link')).size;
    assert.equal(usage.archiveBytes, 1024 + 2048 + metadata);
    assert.equal(usage.files, 4);
    assert.equal(usage.unreadableEntries, 0);
    assert.equal(usage.totalBytes, usage.platformBytes + usage.archiveBytes + usage.snapshotBytes);
    const missing = measureTaskStorage(path.join(root, 'absent'), path.join(root, 'absent-snapshot'));
    assert.equal(missing.totalBytes, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a playback request interrupted by Task deletion cannot recreate the deleted cache directory', async () => {
  const taskId = 'deleted-playback-task';
  let closed = false;
  await assert.rejects(openHlsPlaybackFile({
    taskId, resourceId: 'manifest',
    openResource: async () => ({ fileName: 'video.m3u8', sha256: 'a'.repeat(64), fileHandle: { close: async () => { closed = true; } } }),
    assertOwner: () => { throw Object.assign(new Error('Task was deleted'), { statusCode: 404 }); },
  }), error => error.statusCode === 404);
  assert.equal(closed, true);
  assert.equal(fs.existsSync(path.join(playbackData, 'sessions', taskId)), false);
});
