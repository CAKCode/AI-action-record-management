const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-external-path-boundary-'));
const workspace = path.join(root, 'workspace');
const externalCheckout = path.join(root, 'business-checkout');
const backup = path.join(root, 'backup');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(externalCheckout, { recursive: true });
fs.mkdirSync(backup, { recursive: true });
process.env.CODEX_DESK_DATA_DIR = path.join(root, 'data');
process.env.CODEX_DESK_RUNTIME_DIR = path.join(root, 'runtime');
process.env.CODEX_DESK_BACKUP_DIR = backup;
process.env.CODEX_TASK_WORKSPACE_ROOTS = workspace;
process.env.SOURCE_CODEX_HOME = path.join(root, 'source-home');
process.env.WORKSPACE_CODEX_SKILLS_DIR = path.join(root, 'workspace-skills');
process.env.CODEX_ALLOW_ROOT_EXECUTION = '1';

const store = require('../src/store');
const { closeDatabase } = require('../src/database');

test.after(() => {
  closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

test('external tracking respects checkout boundaries and legacy absolute paths', async () => {
  store.saveSession('external-path-boundary', {
    name: 'External path boundary',
    objective: 'Keep tracked evidence inside the task workspace.',
    workingDir: workspace,
  });

  assert.throws(
    () => store.registerExternalAttempt({
      taskId: 'external-path-boundary',
      workingDirectory: workspace,
      logPath: path.join(root, 'outside.log'),
    }),
    error => error.statusCode === 400 && /working directory/.test(error.message),
  );

  assert.throws(
    () => store.registerExternalAttempt({
      taskId: 'external-path-boundary',
      workingDirectory: process.env.CODEX_DESK_DATA_DIR,
      logPath: path.join(process.env.CODEX_DESK_DATA_DIR, 'platform-overlap.log'),
    }),
    error => error.statusCode === 409 && /platform storage/.test(error.message),
  );

  assert.throws(
    () => store.registerExternalAttempt({
      taskId: 'external-path-boundary',
      workingDirectory: backup,
      logPath: path.join(backup, 'platform-backup.log'),
    }),
    error => error.statusCode === 409 && /platform storage/.test(error.message),
  );

  const platformLink = path.join(externalCheckout, 'platform-link');
  fs.symlinkSync(process.env.CODEX_DESK_DATA_DIR, platformLink, 'dir');
  assert.throws(
    () => store.registerExternalAttempt({
      taskId: 'external-path-boundary',
      logPath: path.join(platformLink, 'future.log'),
    }),
    error => error.statusCode === 409 && /platform storage/.test(error.message),
  );

  const legacy = store.registerExternalAttempt({
    taskId: 'external-path-boundary',
    logPath: path.join(externalCheckout, 'legacy.log'),
  });
  assert.equal(legacy.logPath, path.join(externalCheckout, 'legacy.log'));

  const registered = store.registerExternalAttempt({
    taskId: 'external-path-boundary',
    workingDirectory: externalCheckout,
    logPath: path.join(externalCheckout, 'inside.log'),
  });
  assert.equal(registered.logPath, path.join(externalCheckout, 'inside.log'));

  const deferredCheckout = path.join(root, 'checkout-created-after-registration');
  const deferred = store.registerExternalAttempt({
    taskId: 'external-path-boundary',
    workingDirectory: deferredCheckout,
    logPath: path.join(deferredCheckout, 'deferred.log'),
  });
  assert.equal(deferred.logPath, path.join(deferredCheckout, 'deferred.log'));

  const symlinkTarget = path.join(root, 'symlink-target');
  const symlinkCheckout = path.join(root, 'symlink-checkout');
  fs.mkdirSync(symlinkTarget, { recursive: true });
  fs.symlinkSync(symlinkTarget, symlinkCheckout, 'dir');
  assert.throws(
    () => store.registerExternalAttempt({
      taskId: 'external-path-boundary',
      workingDirectory: path.join(symlinkCheckout, 'future'),
      logPath: path.join(symlinkCheckout, 'future', 'symlink.log'),
    }),
    error => error.statusCode === 400 && /symbolic links/.test(error.message),
  );

  const logDirectory = path.join(externalCheckout, 'tracked-logs');
  const swappedDirectory = path.join(root, 'swapped-logs');
  fs.mkdirSync(logDirectory, { recursive: true });
  fs.mkdirSync(swappedDirectory, { recursive: true });
  const trackedLogPath = path.join(logDirectory, 'tracked.log');
  fs.writeFileSync(trackedLogPath, 'tracked\n');
  const tracked = store.registerExternalAttempt({
    taskId: 'external-path-boundary',
    workingDirectory: externalCheckout,
    logPath: trackedLogPath,
  });
  fs.writeFileSync(path.join(swappedDirectory, 'tracked.log'), 'unexpected\n');
  fs.renameSync(logDirectory, `${logDirectory}.original`);
  fs.symlinkSync(swappedDirectory, logDirectory, 'dir');
  await assert.rejects(
    () => store.openExternalAttemptLogFile('external-path-boundary', tracked.id),
    error => error.statusCode === 409 && /symbolic links/.test(error.message),
  );
});
