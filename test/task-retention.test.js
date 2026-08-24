const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-task-retention-'));
const dataDir = path.join(tempDir, 'data');
const runtimeDir = path.join(tempDir, 'runtime');
const workspaceRoot = path.join(tempDir, 'workspaces');
const projectDir = path.join(workspaceRoot, 'project');
const sourceHome = path.join(tempDir, 'codex-home');
const sourceSkills = path.join(sourceHome, 'skills');
const workspaceSkills = path.join(tempDir, 'workspace-skills');

for (const directory of [dataDir, runtimeDir, projectDir, sourceSkills, workspaceSkills]) {
  fs.mkdirSync(directory, { recursive: true });
}

process.env.CODEX_DESK_DATA_DIR = dataDir;
process.env.CODEX_DESK_RUNTIME_DIR = runtimeDir;
process.env.CODEX_TASK_WORKSPACE_ROOTS = workspaceRoot;
process.env.SOURCE_CODEX_HOME = sourceHome;
process.env.WORKSPACE_CODEX_SKILLS_DIR = workspaceSkills;

const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
const { SESSIONS_DIR, SKILL_SNAPSHOTS_DIR } = require('../src/paths');

const NOW = new Date('2026-08-10T12:00:00.000Z');

function daysBefore(days) {
  return new Date(NOW.getTime() - (days * 24 * 60 * 60 * 1000)).toISOString();
}

function createTask(taskId, status = 'idle', archivedAt = '') {
  store.saveSession(taskId, {
    name: taskId,
    objective: `Retention fixture for ${taskId}`,
    workingDir: projectDir,
  });
  const db = getDatabase();
  db.prepare(`
    UPDATE tasks SET status=?, archived_at=?, recovery_state=?, persistent_session_key=?,
      last_finished_at=?, updated_at=? WHERE id=?
  `).run(
    status,
    archivedAt,
    status === 'completed' ? 'archived' : status,
    `single:${taskId}`,
    archivedAt,
    archivedAt || NOW.toISOString(),
    taskId,
  );
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
}

test.after(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('retention purges an expired completed task through managed deletion and Runtime cleanup', () => {
  const taskId = 'retention-expired';
  const archivedAt = daysBefore(31);
  const task = createTask(taskId, 'completed', archivedAt);
  const db = getDatabase();

  for (const directory of [
    path.join(SESSIONS_DIR, taskId),
    path.join(SKILL_SNAPSHOTS_DIR, taskId),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'evidence.txt'), 'expired evidence');
  }

  store.appendAuditEvent({
    ts: archivedAt,
    scope: 'session',
    taskId,
    kind: 'retention.fixture',
    message: 'Task-scoped evidence must expire with its task.',
  });
  db.prepare(`
    INSERT INTO session_operation_receipts(
      idempotency_key, operation, task_id, task_created_at, response_json, created_at
    ) VALUES (?, 'complete', ?, ?, ?, ?)
  `).run('retention-complete-key', taskId, task.created_at, '{"summary":"expired"}', archivedAt);
  db.prepare(`
    INSERT INTO bridge_cleanup_jobs(
      id, task_id, task_created_at, reason, session_key, status,
      next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'completed', ?, 'pending', ?, ?, ?)
  `).run(
    'retention-existing-cleanup',
    taskId,
    task.created_at,
    task.persistent_session_key,
    archivedAt,
    archivedAt,
    archivedAt,
  );

  const result = store.performTaskRetentionCleanup({
    owner: 'test:retention-expired',
    now: NOW,
    limit: 10,
  });

  assert.equal(result.ok, true);
  assert.equal(result.purgedTasks, 1);
  assert.equal(store.getSession(taskId), null);
  assert.equal(fs.existsSync(path.join(SESSIONS_DIR, taskId)), false);
  assert.equal(fs.existsSync(path.join(SKILL_SNAPSHOTS_DIR, taskId)), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE task_id=?').get(taskId).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_operation_receipts WHERE task_id=?').get(taskId).count, 0);
  const cleanup = db.prepare('SELECT reason, status FROM bridge_cleanup_jobs WHERE id=?')
    .get('retention-existing-cleanup');
  assert.deepEqual(cleanup, { reason: 'deleted', status: 'pending' });

  const status = store.taskRetentionStatus(NOW);
  assert.equal(status.retentionDays, 30);
  assert.equal(status.dueTasks, 0);
  assert.equal(status.lastPurgedTasks, 1);
  assert.equal(status.totalPurgedTasks, 1);
});

test('retention preserves recent completed tasks and every non-completed task state', () => {
  createTask('retention-recent', 'completed', daysBefore(29));
  createTask('retention-review', 'waiting_review', daysBefore(60));
  createTask('retention-stopped', 'stopped', daysBefore(60));
  createTask('retention-failed', 'failed', daysBefore(60));

  const result = store.performTaskRetentionCleanup({
    owner: 'test:retention-preserve',
    now: NOW,
    limit: 10,
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.purgedTasks, 0);
  assert.equal(store.getPlatformMaintenance(), null);
  for (const taskId of [
    'retention-recent',
    'retention-review',
    'retention-stopped',
    'retention-failed',
  ]) assert.ok(store.getSession(taskId), taskId);
});

test('retention defers while platform activity is present and retries without deleting early', () => {
  createTask('retention-deferred-expired', 'completed', daysBefore(31));
  createTask('retention-active', 'queued');

  const deferred = store.performTaskRetentionCleanup({
    owner: 'test:retention-deferred',
    now: NOW,
    limit: 10,
  });

  assert.equal(deferred.deferred, true);
  assert.equal(deferred.reason, 'platform_activity');
  assert.equal(deferred.activityCounts.tasks, 1);
  assert.ok(store.getSession('retention-deferred-expired'));

  getDatabase().prepare(`
    UPDATE tasks SET status='idle', recovery_state='idle', updated_at=? WHERE id='retention-active'
  `).run(NOW.toISOString());
  const retried = store.performTaskRetentionCleanup({
    owner: 'test:retention-retried',
    now: NOW,
    limit: 10,
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.purgedTasks, 1);
  assert.equal(store.getSession('retention-deferred-expired'), null);
});

test('retention keeps the task intact and releases maintenance when file staging fails', () => {
  const taskId = 'retention-stage-failure';
  createTask(taskId, 'completed', daysBefore(31));
  const taskDirectory = path.join(SESSIONS_DIR, taskId);
  fs.mkdirSync(taskDirectory, { recursive: true });
  fs.writeFileSync(path.join(taskDirectory, 'evidence.txt'), 'must survive');

  const originalRename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (source === taskDirectory) {
      const error = new Error('Injected retention staging failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename(source, destination);
  };
  let result;
  try {
    result = store.performTaskRetentionCleanup({
      owner: 'test:retention-stage-failure',
      now: NOW,
      limit: 10,
    });
  } finally {
    fs.renameSync = originalRename;
  }

  assert.equal(result.ok, false);
  assert.equal(result.failedTasks, 1);
  assert.ok(store.getSession(taskId));
  assert.equal(fs.readFileSync(path.join(taskDirectory, 'evidence.txt'), 'utf8'), 'must survive');
  assert.equal(store.getPlatformMaintenance(), null);
  assert.equal(store.taskRetentionStatus(NOW).lastFailureCode, 'TASK_PURGE_FAILED');

  const retry = store.performTaskRetentionCleanup({
    owner: 'test:retention-stage-retry',
    now: NOW,
    limit: 10,
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.purgedTasks, 1);
});
