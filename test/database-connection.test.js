const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..');

test('database initialization failure closes its candidate and retries every setup step', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-database-connection-'));
  const dataDir = path.join(tempDir, 'data');
  const runtimeDir = path.join(tempDir, 'runtime');
  const backupDir = path.join(tempDir, 'backups');
  const workspaceDir = path.join(tempDir, 'workspaces');
  for (const directory of [dataDir, runtimeDir, backupDir, workspaceDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  process.env.CODEX_DESK_DATA_DIR = dataDir;
  process.env.CODEX_DESK_RUNTIME_DIR = runtimeDir;
  process.env.CODEX_DESK_BACKUP_DIR = backupDir;
  process.env.CODEX_TASK_WORKSPACE_ROOTS = workspaceDir;

  const databaseFile = path.join(dataDir, 'codex-tasks.db');
  const originalChmod = fs.chmodSync;
  const originalClose = Database.prototype.close;
  let databaseChmodAttempts = 0;
  let closeCalls = 0;
  let injectFailure = true;
  fs.chmodSync = function chmodWithFailure(filePath, mode) {
    if (path.resolve(String(filePath)) === databaseFile) {
      databaseChmodAttempts += 1;
      if (injectFailure) {
        injectFailure = false;
        throw new Error('injected database permission failure');
      }
    }
    return originalChmod.call(this, filePath, mode);
  };
  Database.prototype.close = function trackedClose(...args) {
    closeCalls += 1;
    return originalClose.apply(this, args);
  };

  let databaseModule;
  try {
    databaseModule = require('../src/database');
    assert.throws(() => databaseModule.getDatabase(), /injected database permission failure/);
    assert.equal(closeCalls, 1);

    const db = databaseModule.getDatabase();
    assert.equal(db.prepare('SELECT 1 AS value').get().value, 1);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('synchronous', { simple: true }), 2);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    assert.equal(databaseChmodAttempts, 3);
    assert.equal(fs.statSync(databaseFile).mode & 0o777, 0o600);

    Database.prototype.close = function closeThenThrow(...args) {
      closeCalls += 1;
      originalClose.apply(this, args);
      throw new Error('injected post-close failure');
    };
    assert.throws(() => databaseModule.closeDatabase(), /injected post-close failure/);
    assert.equal(closeCalls, 2);

    Database.prototype.close = function trackedClose(...args) {
      closeCalls += 1;
      return originalClose.apply(this, args);
    };
    const reopened = databaseModule.getDatabase();
    assert.notEqual(reopened, db);
    assert.equal(reopened.prepare('SELECT 2 AS value').get().value, 2);
    databaseModule.closeDatabase();
    assert.equal(closeCalls, 3);
  } finally {
    try { databaseModule?.closeDatabase(); } catch {}
    fs.chmodSync = originalChmod;
    Database.prototype.close = originalClose;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('schema migration rolls back atomically when an intermediate statement fails', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-schema-transaction-'));
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const Database = require('better-sqlite3');",
    "for (const name of ['data', 'runtime', 'backups', 'workspaces']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const originalExec = Database.prototype.exec;",
    "let execCalls = 0;",
    "Database.prototype.exec = function injectedExec(sql) {",
    "  execCalls += 1;",
    "  if (execCalls === 2) throw new Error('injected schema migration failure');",
    "  return originalExec.call(this, sql);",
    "};",
    "const database = require('./src/database');",
    "let failure = '';",
    "try { database.getDatabase(); } catch (error) { failure = error.message; }",
    "Database.prototype.exec = originalExec;",
    "const file = path.join(process.env.CODEX_DESK_DATA_DIR, 'codex-tasks.db');",
    "const inspection = new Database(file);",
    "const userTablesAfterFailure = inspection.prepare(\"SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\").get().count;",
    "inspection.close();",
    "const reopened = database.getDatabase();",
    "const userTablesAfterRetry = reopened.prepare(\"SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\").get().count;",
    "database.closeDatabase();",
    "console.log(JSON.stringify({ failure, execCalls, userTablesAfterFailure, userTablesAfterRetry }));",
  ].join('\n');
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        TEST_ROOT: tempDir,
        CODEX_DESK_DATA_DIR: path.join(tempDir, 'data'),
        CODEX_DESK_RUNTIME_DIR: path.join(tempDir, 'runtime'),
        CODEX_DESK_BACKUP_DIR: path.join(tempDir, 'backups'),
        CODEX_TASK_WORKSPACE_ROOTS: path.join(tempDir, 'workspaces'),
      },
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.failure, 'injected schema migration failure');
    assert.equal(output.execCalls, 2);
    assert.equal(output.userTablesAfterFailure, 0);
    assert.ok(output.userTablesAfterRetry >= 15);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('database startup rejects a symbolic-link database without modifying its target', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-database-symlink-'));
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const Database = require('better-sqlite3');",
    "for (const name of ['data', 'runtime', 'backups', 'workspaces']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const target = path.join(process.env.TEST_ROOT, 'outside.db');",
    "const targetDb = new Database(target);",
    "targetDb.exec('CREATE TABLE marker(value TEXT)');",
    "targetDb.prepare('INSERT INTO marker(value) VALUES (?)').run('unchanged');",
    "targetDb.close();",
    "fs.symlinkSync(target, path.join(process.env.CODEX_DESK_DATA_DIR, 'codex-tasks.db'));",
    "const database = require('./src/database');",
    "let failure = '';",
    "try { database.getDatabase(); } catch (error) { failure = error.message; }",
    "const inspection = new Database(target, { readonly: true, fileMustExist: true });",
    "const marker = inspection.prepare('SELECT value FROM marker').get().value;",
    "const taskTables = inspection.prepare(\"SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='tasks'\").get().count;",
    "inspection.close();",
    "console.log(JSON.stringify({ failure, marker, taskTables }));",
  ].join('\n');
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        TEST_ROOT: tempDir,
        CODEX_DESK_DATA_DIR: path.join(tempDir, 'data'),
        CODEX_DESK_RUNTIME_DIR: path.join(tempDir, 'runtime'),
        CODEX_DESK_BACKUP_DIR: path.join(tempDir, 'backups'),
        CODEX_TASK_WORKSPACE_ROOTS: path.join(tempDir, 'workspaces'),
      },
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.match(output.failure, /SQLite database path is not a regular file/);
    assert.equal(output.marker, 'unchanged');
    assert.equal(output.taskTables, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('database startup rejects a symbolic-link data directory before chmod or file creation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-data-directory-symlink-'));
  const script = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const target = path.join(process.env.TEST_ROOT, 'outside-data');",
    "fs.mkdirSync(target, { recursive: true, mode: 0o755 });",
    "fs.chmodSync(target, 0o755);",
    "fs.symlinkSync(target, process.env.CODEX_DESK_DATA_DIR, 'dir');",
    "for (const name of ['runtime', 'backups', 'workspaces']) fs.mkdirSync(path.join(process.env.TEST_ROOT, name), { recursive: true });",
    "const database = require('./src/database');",
    "let failure = '';",
    "try { database.getDatabase(); } catch (error) { failure = error.message; }",
    "console.log(JSON.stringify({",
    "  failure,",
    "  targetMode: fs.statSync(target).mode & 0o777,",
    "  databaseCreated: fs.existsSync(path.join(target, 'codex-tasks.db')),",
    "}));",
  ].join('\n');
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        TEST_ROOT: tempDir,
        CODEX_DESK_DATA_DIR: path.join(tempDir, 'data-link'),
        CODEX_DESK_RUNTIME_DIR: path.join(tempDir, 'runtime'),
        CODEX_DESK_BACKUP_DIR: path.join(tempDir, 'backups'),
        CODEX_TASK_WORKSPACE_ROOTS: path.join(tempDir, 'workspaces'),
      },
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.match(output.failure, /SQLite data storage is not a private directory/);
    assert.equal(output.targetMode, 0o755);
    assert.equal(output.databaseCreated, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
