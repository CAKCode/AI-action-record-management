const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  archiveFileAtomically,
  openDigestedRegularFile,
} = require('../src/external-attempt-archive');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-external-archive-'));

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function fixture(name) {
  const directory = path.join(tempDir, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  return {
    source: path.join(directory, 'source.log'),
    destination: path.join(directory, 'archive.log'),
  };
}

test('external attempt archival preserves every source byte and records its digest', async () => {
  const paths = fixture('exact-bytes');
  const content = Buffer.concat([
    Buffer.from('pytest command output\n', 'utf8'),
    Buffer.from([0, 1, 2, 255]),
    crypto.randomBytes((2 * 1024 * 1024) + 17),
  ]);
  fs.writeFileSync(paths.source, content, { mode: 0o600 });

  const result = await archiveFileAtomically({
    sourcePath: paths.source,
    destinationPath: paths.destination,
  });

  assert.deepEqual(fs.readFileSync(paths.destination), content);
  assert.equal(result.bytes, content.length);
  assert.equal(result.sha256, crypto.createHash('sha256').update(content).digest('hex'));
  assert.equal(result.recoveredExisting, false);
  assert.equal(fs.statSync(paths.destination).mode & 0o777, 0o600);
});

test('external attempt archival rejects symbolic-link sources and destinations', async () => {
  const sourcePaths = fixture('source-link');
  const target = path.join(path.dirname(sourcePaths.source), 'target.log');
  fs.writeFileSync(target, 'secret', { mode: 0o600 });
  fs.symlinkSync(target, sourcePaths.source);
  await assert.rejects(
    archiveFileAtomically({ sourcePath: sourcePaths.source, destinationPath: sourcePaths.destination }),
    (error) => error.code === 'ARCHIVE_UNSAFE_FILE',
  );
  assert.equal(fs.existsSync(sourcePaths.destination), false);

  const destinationPaths = fixture('destination-link');
  fs.writeFileSync(destinationPaths.source, 'source', { mode: 0o600 });
  fs.symlinkSync(target, destinationPaths.destination);
  await assert.rejects(
    archiveFileAtomically({ sourcePath: destinationPaths.source, destinationPath: destinationPaths.destination }),
    (error) => error.code === 'ARCHIVE_UNSAFE_FILE',
  );
});

test('external attempt archival does not publish a source that changes during copying', async () => {
  const paths = fixture('source-change');
  fs.writeFileSync(paths.source, crypto.randomBytes(1024 * 1024), { mode: 0o600 });
  await assert.rejects(archiveFileAtomically({
    sourcePath: paths.source,
    destinationPath: paths.destination,
    faultInjector(stage) {
      if (stage === 'after_copy') fs.appendFileSync(paths.source, 'changed');
    },
  }), (error) => error.code === 'ARCHIVE_SOURCE_CHANGED');
  assert.equal(fs.existsSync(paths.destination), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(paths.destination)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('a published archive is reusable after a crash even when the source is gone', async () => {
  const paths = fixture('publish-recovery');
  const content = Buffer.from('complete pytest output before database commit\n', 'utf8');
  fs.writeFileSync(paths.source, content, { mode: 0o600 });
  await assert.rejects(archiveFileAtomically({
    sourcePath: paths.source,
    destinationPath: paths.destination,
    faultInjector(stage) {
      if (stage === 'after_publish') throw new Error('simulated process crash');
    },
  }), /simulated process crash/);
  assert.deepEqual(fs.readFileSync(paths.destination), content);

  fs.unlinkSync(paths.source);
  const recovered = await archiveFileAtomically({
    sourcePath: paths.source,
    destinationPath: paths.destination,
  });
  assert.equal(recovered.recoveredExisting, true);
  assert.equal(recovered.bytes, content.length);
  assert.equal(recovered.sha256, crypto.createHash('sha256').update(content).digest('hex'));
});

test('concurrent publishers never overwrite an already published archive', async () => {
  const paths = fixture('concurrent-publish');
  const secondSource = path.join(path.dirname(paths.source), 'second.log');
  const firstContent = Buffer.alloc(1024 * 1024, 0x31);
  const secondContent = Buffer.alloc(1024 * 1024, 0x32);
  fs.writeFileSync(paths.source, firstContent, { mode: 0o600 });
  fs.writeFileSync(secondSource, secondContent, { mode: 0o600 });
  let waiting = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const beforePublish = async (stage) => {
    if (stage !== 'before_publish') return;
    waiting += 1;
    if (waiting === 2) release();
    await barrier;
  };

  const results = await Promise.all([
    archiveFileAtomically({
      sourcePath: paths.source, destinationPath: paths.destination, faultInjector: beforePublish,
    }),
    archiveFileAtomically({
      sourcePath: secondSource, destinationPath: paths.destination, faultInjector: beforePublish,
    }),
  ]);
  const published = fs.readFileSync(paths.destination);
  assert.ok(published.equals(firstContent) || published.equals(secondContent));
  assert.equal(results.filter((result) => result.recoveredExisting).length, 1);
  assert.equal(results.filter((result) => !result.recoveredExisting).length, 1);
  assert.ok(results.every((result) => result.sha256
    === crypto.createHash('sha256').update(published).digest('hex')));
});

test('concurrent archive verification tolerates transient hard-link metadata changes', async () => {
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const paths = fixture(`concurrent-verify-${iteration}`);
    const secondSource = path.join(path.dirname(paths.source), 'second.log');
    fs.writeFileSync(paths.source, Buffer.alloc(1024 * 1024, 0x31), { mode: 0o600 });
    fs.writeFileSync(secondSource, Buffer.alloc(1024 * 1024, 0x32), { mode: 0o600 });
    let waiting = 0;
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const beforePublish = async (stage) => {
      if (stage !== 'before_publish') return;
      waiting += 1;
      if (waiting === 2) release();
      await barrier;
    };

    try {
      const results = await Promise.all([
        archiveFileAtomically({
          sourcePath: paths.source,
          destinationPath: paths.destination,
          faultInjector: beforePublish,
        }),
        archiveFileAtomically({
          sourcePath: secondSource,
          destinationPath: paths.destination,
          faultInjector: beforePublish,
        }),
      ]);
      const published = fs.readFileSync(paths.destination);
      const publishedSha256 = crypto.createHash('sha256').update(published).digest('hex');
      assert.ok(results.every((result) => result.sha256 === publishedSha256));
    } finally {
      fs.rmSync(path.dirname(paths.destination), { recursive: true, force: true });
    }
  }
});

test('a verified open handle keeps the validated inode when its path is replaced', async () => {
  const paths = fixture('verified-open-path-replacement');
  const verifiedContent = Buffer.from('validated terminal output\n', 'utf8');
  const replacementContent = Buffer.from('replacement after validation\n', 'utf8');
  const displacedPath = path.join(path.dirname(paths.destination), 'displaced.log');
  fs.writeFileSync(paths.destination, verifiedContent, { mode: 0o600 });

  const opened = await openDigestedRegularFile(paths.destination);
  try {
    fs.renameSync(paths.destination, displacedPath);
    fs.writeFileSync(paths.destination, replacementContent, { mode: 0o600 });
    assert.deepEqual(await opened.handle.readFile(), verifiedContent);
    assert.deepEqual(fs.readFileSync(paths.destination), replacementContent);
    assert.equal(opened.sha256, crypto.createHash('sha256').update(verifiedContent).digest('hex'));
  } finally {
    await opened.handle.close();
  }
});

test('digesting a large archive releases its handle when the read is aborted', {
  skip: process.platform !== 'linux',
}, async () => {
  const paths = fixture('digest-read-abort');
  fs.writeFileSync(paths.destination, Buffer.alloc(1024 * 1024, 0x61), { mode: 0o600 });
  fs.truncateSync(paths.destination, 256 * 1024 * 1024);
  const controller = new AbortController();
  const digest = openDigestedRegularFile(paths.destination, { signal: controller.signal });
  setTimeout(() => controller.abort(), 1);
  await assert.rejects(digest, (error) => error.code === 'ARCHIVE_READ_ABORTED');
  const openTargets = fs.readdirSync('/proc/self/fd').flatMap((fd) => {
    try { return [fs.readlinkSync(`/proc/self/fd/${fd}`)]; } catch { return []; }
  });
  assert.equal(openTargets.includes(paths.destination), false);
});
