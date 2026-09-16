const fs = require('fs');
const Database = require('better-sqlite3');
const { DB_FILE, DATA_DIR } = require('./paths');

let database = null;
let integrityCache = null;
const INTEGRITY_CACHE_TTL_MS = 30000;
const DATABASE_RUNTIME_FILES = [
  { filePath: DB_FILE, label: 'database' },
  { filePath: `${DB_FILE}-wal`, label: 'WAL' },
  { filePath: `${DB_FILE}-shm`, label: 'SHM' },
  { filePath: `${DB_FILE}-journal`, label: 'rollback journal' },
];

function ensurePrivateDataDirectory() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(DATA_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('SQLite data storage is not a private directory');
  }
  fs.chmodSync(DATA_DIR, 0o700);
}

function secureDatabaseRuntimeFiles() {
  for (const { filePath, label } of DATABASE_RUNTIME_FILES) {
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`SQLite ${label} path is not a regular file`);
    }
    fs.chmodSync(filePath, 0o600);
  }
}

function migrateSkillReportHashUniqueness(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='skill_reports'").get();
  if (!/UNIQUE\s*\(\s*task_id\s*,\s*report_key\s*,\s*report_hash\s*\)/i.test(table?.sql || '')) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_skill_reports_task_latest;
    DROP INDEX IF EXISTS idx_skill_reports_task_published;
    DROP INDEX IF EXISTS idx_skill_reports_task_hash;
    ALTER TABLE skill_reports RENAME TO skill_reports_legacy_hash_unique;

    CREATE TABLE skill_reports (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
      report_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      report_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      skill_id TEXT NOT NULL,
      skill_version INTEGER NOT NULL,
      skill_content_hash TEXT NOT NULL,
      report_type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      published_at TEXT NOT NULL,
      UNIQUE(task_id, report_key, revision)
    );

    INSERT INTO skill_reports (
      sequence, id, task_id, turn_id, attempt_id, report_key, revision, report_hash,
      schema_version, skill_id, skill_version, skill_content_hash, report_type,
      status, title, summary, payload_json, published_at
    )
    SELECT
      sequence, id, task_id, turn_id, attempt_id, report_key, revision, report_hash,
      schema_version, skill_id, skill_version, skill_content_hash, report_type,
      status, title, summary, payload_json, published_at
    FROM skill_reports_legacy_hash_unique;

    DROP TABLE skill_reports_legacy_hash_unique;
    CREATE INDEX idx_skill_reports_task_latest
      ON skill_reports(task_id, report_key, revision DESC);
    CREATE INDEX idx_skill_reports_task_published
      ON skill_reports(task_id, published_at DESC, sequence DESC);
    CREATE INDEX idx_skill_reports_task_hash
      ON skill_reports(task_id, report_key, report_hash);
  `);
}

function migrateSessionOperationReceiptOperations(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_operation_receipts'").get();
  const tableSql = table?.sql || '';
  if (/['\"]restore['\"]/i.test(tableSql) && /['\"]reset['\"]/i.test(tableSql)) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_session_operation_receipts_task;
    ALTER TABLE session_operation_receipts RENAME TO session_operation_receipts_before_operations;

    CREATE TABLE session_operation_receipts (
      idempotency_key TEXT PRIMARY KEY,
      operation TEXT NOT NULL CHECK(operation IN ('stop', 'complete', 'restore', 'reset', 'delete')),
      task_id TEXT NOT NULL,
      task_created_at TEXT NOT NULL DEFAULT '',
      expected_task_created_at TEXT NOT NULL DEFAULT '',
      response_json TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'operator',
      request_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    INSERT INTO session_operation_receipts (
      idempotency_key, operation, task_id, task_created_at, expected_task_created_at,
      response_json, actor, request_id, created_at
    )
    SELECT
      idempotency_key, operation, task_id, task_created_at, expected_task_created_at,
      response_json, actor, request_id, created_at
    FROM session_operation_receipts_before_operations;

    DROP TABLE session_operation_receipts_before_operations;
    CREATE INDEX idx_session_operation_receipts_task
      ON session_operation_receipts(task_id, created_at DESC);
  `);
}

function schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      working_dir TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'idle',
      summary TEXT NOT NULL DEFAULT '',
      last_run_at TEXT NOT NULL DEFAULT '',
      last_finished_at TEXT NOT NULL DEFAULT '',
      archived_at TEXT NOT NULL DEFAULT '',
      run_count INTEGER NOT NULL DEFAULT 0,
      current_pid INTEGER,
      current_pid_start_ticks TEXT NOT NULL DEFAULT '',
      current_process_group_id INTEGER,
      persistent_session_key TEXT NOT NULL DEFAULT '',
      auto_resume INTEGER NOT NULL DEFAULT 1,
      max_retries INTEGER NOT NULL DEFAULT 2,
      retry_count INTEGER NOT NULL DEFAULT 0,
      recovery_count INTEGER NOT NULL DEFAULT 0,
      last_brief TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      recovery_state TEXT NOT NULL DEFAULT 'idle',
      skill_snapshot_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      lease_owner TEXT,
      lease_expires_at TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
      ON tasks(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_lease
      ON tasks(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_completed_retention
      ON tasks(archived_at, id) WHERE status='completed';

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      input TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      result TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      UNIQUE(task_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_turns_task_sequence
      ON turns(task_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      pid_start_ticks TEXT NOT NULL DEFAULT '',
      process_group_id INTEGER,
      exit_code INTEGER,
      signal TEXT,
      error TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT '',
      UNIQUE(turn_id, attempt_no)
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_task_started
      ON attempts(task_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS task_steps (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      step_key TEXT NOT NULL,
      label TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'partial', 'lost', 'cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, step_key),
      UNIQUE(task_id, ordinal)
    );

    CREATE INDEX IF NOT EXISTS idx_task_steps_task_ordinal
      ON task_steps(task_id, ordinal);

    CREATE TABLE IF NOT EXISTS step_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL REFERENCES task_steps(id) ON DELETE CASCADE,
      run_key TEXT NOT NULL,
      run_kind TEXT NOT NULL CHECK(run_kind IN ('initial', 'rerun')),
      run_number INTEGER NOT NULL,
      source_run_id TEXT REFERENCES step_runs(id) ON DELETE SET NULL,
      selection_mode TEXT NOT NULL DEFAULT '',
      target_count INTEGER,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'partial', 'lost', 'cancelled')),
      created_by_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      created_by_attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(step_id, run_key),
      UNIQUE(step_id, run_number)
    );

    CREATE INDEX IF NOT EXISTS idx_step_runs_task_step
      ON step_runs(task_id, step_id, run_number);

    CREATE TABLE IF NOT EXISTS external_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      step_run_id TEXT REFERENCES step_runs(id) ON DELETE SET NULL,
      origin_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      origin_attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
      source_command_execution_id TEXT REFERENCES command_executions(id) ON DELETE SET NULL,
      skill_invocation_id TEXT REFERENCES skill_invocations(id) ON DELETE SET NULL,
      chain_key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      pid INTEGER,
      pid_start_ticks TEXT NOT NULL DEFAULT '',
      process_group_id INTEGER,
      cgroup_path TEXT NOT NULL DEFAULT '',
      cgroup_inode TEXT NOT NULL DEFAULT '',
      log_path TEXT NOT NULL,
      done_path TEXT NOT NULL DEFAULT '',
      state_path TEXT NOT NULL DEFAULT '',
      meta_path TEXT NOT NULL DEFAULT '',
      artifact_declarations_json TEXT NOT NULL DEFAULT '[]',
      check_interval_seconds INTEGER NOT NULL DEFAULT 300,
      follow_up_prompt TEXT NOT NULL DEFAULT '',
      last_observation TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '{}',
      archived_log_path TEXT NOT NULL DEFAULT '',
      archived_log_bytes INTEGER,
      archived_log_sha256 TEXT NOT NULL DEFAULT '',
      archive_status TEXT NOT NULL DEFAULT 'pending',
      archive_error TEXT NOT NULL DEFAULT '',
      archive_attempt_count INTEGER NOT NULL DEFAULT 0,
      archive_next_retry_at TEXT NOT NULL DEFAULT '',
      archive_lease_owner TEXT NOT NULL DEFAULT '',
      archive_lease_expires_at TEXT NOT NULL DEFAULT '',
      archived_at TEXT NOT NULL DEFAULT '',
      archive_verify_status TEXT NOT NULL DEFAULT 'pending',
      archive_verify_error TEXT NOT NULL DEFAULT '',
      archive_verify_count INTEGER NOT NULL DEFAULT 0,
      archive_verified_at TEXT NOT NULL DEFAULT '',
      archive_verify_next_at TEXT NOT NULL DEFAULT '',
      archive_verify_lease_owner TEXT NOT NULL DEFAULT '',
      archive_verify_lease_expires_at TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      last_checked_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, chain_key, generation)
    );

    CREATE INDEX IF NOT EXISTS idx_external_attempts_task_status
      ON external_attempts(task_id, status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_external_attempts_source_execution
      ON external_attempts(source_command_execution_id)
      WHERE source_command_execution_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      external_attempt_id TEXT REFERENCES external_attempts(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL DEFAULT 1,
      sequence INTEGER NOT NULL DEFAULT 1,
      kind TEXT NOT NULL DEFAULT 'external_check',
      due_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      lease_owner TEXT,
      lease_expires_at TEXT,
      command_id TEXT REFERENCES commands(id) ON DELETE SET NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT '',
      UNIQUE(external_attempt_id, generation, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
      ON scheduled_jobs(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_task
      ON scheduled_jobs(task_id, status, due_at);

    CREATE TABLE IF NOT EXISTS command_executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      runtime_item_id TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      configured_working_directory TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      exit_code INTEGER,
      status TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      raw_event_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(task_id, turn_id, attempt_id, runtime_item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_command_executions_task_finished
      ON command_executions(task_id, finished_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_command_executions_turn
      ON command_executions(turn_id, attempt_id);

    CREATE TABLE IF NOT EXISTS command_skill_attributions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      command_execution_id TEXT NOT NULL REFERENCES command_executions(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL,
      skill_version INTEGER NOT NULL,
      skill_content_hash TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('linked', 'unlinked')),
      source TEXT NOT NULL CHECK(source IN ('runtime', 'operator')),
      reason TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL,
      ts TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_command_skill_attributions_execution
      ON command_skill_attributions(command_execution_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_command_skill_attributions_task
      ON command_skill_attributions(task_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS skill_invocations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
      parent_invocation_id TEXT REFERENCES skill_invocations(id) ON DELETE SET NULL,
      skills_json TEXT NOT NULL,
      command_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'failed', 'interrupted')),
      exit_code INTEGER,
      signal TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_invocations_task_started
      ON skill_invocations(task_id, started_at DESC, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_invocations_attempt
      ON skill_invocations(attempt_id, started_at DESC, sequence DESC);

    CREATE TABLE IF NOT EXISTS skill_reports (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      step_run_id TEXT REFERENCES step_runs(id) ON DELETE SET NULL,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      attempt_id TEXT REFERENCES attempts(id) ON DELETE SET NULL,
      report_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      report_hash TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      skill_id TEXT NOT NULL,
      skill_version INTEGER NOT NULL,
      skill_content_hash TEXT NOT NULL,
      report_type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      published_at TEXT NOT NULL,
      UNIQUE(task_id, report_key, revision)
    );

    CREATE INDEX IF NOT EXISTS idx_skill_reports_task_latest
      ON skill_reports(task_id, report_key, revision DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_reports_task_published
      ON skill_reports(task_id, published_at DESC, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_skill_reports_task_hash
      ON skill_reports(task_id, report_key, report_hash);

    CREATE TABLE IF NOT EXISTS skill_report_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      report_id TEXT NOT NULL REFERENCES skill_reports(id) ON DELETE CASCADE,
      artifact_key TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      managed_path TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      source_sha256 TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(report_id, artifact_key)
    );

    CREATE INDEX IF NOT EXISTS idx_skill_report_artifacts_task
      ON skill_report_artifacts(task_id, report_id);

    CREATE TABLE IF NOT EXISTS skill_report_artifact_resources (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      report_id TEXT NOT NULL REFERENCES skill_reports(id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL REFERENCES skill_report_artifacts(id) ON DELETE CASCADE,
      resource_key TEXT NOT NULL,
      file_name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      managed_path TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(artifact_id, resource_key)
    );

    CREATE INDEX IF NOT EXISTS idx_skill_report_artifact_resources_artifact
      ON skill_report_artifact_resources(task_id, report_id, artifact_id);

    CREATE TABLE IF NOT EXISTS skill_report_artifact_media_views (
      artifact_id TEXT NOT NULL REFERENCES skill_report_artifacts(id) ON DELETE CASCADE,
      media_key TEXT NOT NULL,
      viewed_at TEXT NOT NULL,
      PRIMARY KEY(artifact_id, media_key)
    );

    CREATE TABLE IF NOT EXISTS skill_report_artifact_jobs (
      report_id TEXT PRIMARY KEY REFERENCES skill_reports(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'processing', 'retry', 'completed', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT NOT NULL DEFAULT '',
      next_attempt_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_skill_report_artifact_jobs_due
      ON skill_report_artifact_jobs(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_skill_report_artifact_jobs_task
      ON skill_report_artifact_jobs(task_id, status, updated_at);

    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      worker_id TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      claimed_at TEXT NOT NULL DEFAULT '',
      claim_expires_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_commands_pending
      ON commands(status, created_at);

    CREATE TABLE IF NOT EXISTS worklog_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      turn_id TEXT,
      sequence INTEGER NOT NULL,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT,
      UNIQUE(task_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_worklog_task_sequence
      ON worklog_events(task_id, sequence DESC);
    CREATE INDEX IF NOT EXISTS idx_worklog_task_kind
      ON worklog_events(task_id, kind);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      request_id TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL,
      scope TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      task_id TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      payload_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_task_ts ON audit_events(task_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_kind_ts ON audit_events(kind, ts DESC);

    CREATE TABLE IF NOT EXISTS session_operation_receipts (
      idempotency_key TEXT PRIMARY KEY,
      operation TEXT NOT NULL CHECK(operation IN ('stop', 'complete', 'restore', 'reset', 'delete')),
      task_id TEXT NOT NULL,
      task_created_at TEXT NOT NULL DEFAULT '',
      expected_task_created_at TEXT NOT NULL DEFAULT '',
      response_json TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'operator',
      request_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_session_operation_receipts_task
      ON session_operation_receipts(task_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bridge_cleanup_jobs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_created_at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('completed', 'deleted')),
      session_key TEXT NOT NULL,
      source_dir TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'processing', 'retry', 'completed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT NOT NULL DEFAULT '',
      next_attempt_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT '',
      UNIQUE(task_id, task_created_at, session_key)
    );

    CREATE INDEX IF NOT EXISTS idx_bridge_cleanup_jobs_due
      ON bridge_cleanup_jobs(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_bridge_cleanup_jobs_task
      ON bridge_cleanup_jobs(task_id, task_created_at);

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      origin TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      description TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      read_only INTEGER NOT NULL DEFAULT 0,
      current_version INTEGER NOT NULL DEFAULT 1,
      source_path TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skills_origin_updated
      ON skills(origin, updated_at DESC);

    CREATE TABLE IF NOT EXISTS skill_versions (
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(skill_id, version)
    );

    CREATE TABLE IF NOT EXISTS skill_version_files (
      skill_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      content BLOB NOT NULL,
      mode INTEGER NOT NULL DEFAULT 420,
      content_hash TEXT NOT NULL,
      PRIMARY KEY(skill_id, version, file_path),
      FOREIGN KEY(skill_id, version) REFERENCES skill_versions(skill_id, version) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS skill_snapshots (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_snapshot_entries (
      snapshot_id TEXT NOT NULL REFERENCES skill_snapshots(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      origin TEXT NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      PRIMARY KEY(snapshot_id, skill_id)
    );

    CREATE TABLE IF NOT EXISTS skill_snapshot_files (
      snapshot_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content BLOB NOT NULL,
      mode INTEGER NOT NULL DEFAULT 420,
      content_hash TEXT NOT NULL,
      PRIMARY KEY(snapshot_id, skill_id, file_path),
      FOREIGN KEY(snapshot_id, skill_id) REFERENCES skill_snapshot_entries(snapshot_id, skill_id) ON DELETE CASCADE
    );
  `);

  migrateSkillReportHashUniqueness(db);
  migrateSessionOperationReceiptOperations(db);

  db.exec(`
    INSERT OR IGNORE INTO skill_version_files
      (skill_id, version, file_path, content, mode, content_hash)
    SELECT skill_id, version, 'SKILL.md', CAST(content AS BLOB), 420, content_hash
    FROM skill_versions;

    INSERT OR IGNORE INTO skill_snapshot_files
      (snapshot_id, skill_id, file_path, content, mode, content_hash)
    SELECT snapshot_id, skill_id, 'SKILL.md', CAST(content AS BLOB), 420, content_hash
    FROM skill_snapshot_entries;
  `);

  const commandColumns = new Set(db.pragma('table_info(commands)').map((column) => column.name));
  if (!commandColumns.has('worker_id')) {
    db.exec("ALTER TABLE commands ADD COLUMN worker_id TEXT NOT NULL DEFAULT ''");
  }
  if (!commandColumns.has('claim_expires_at')) {
    db.exec("ALTER TABLE commands ADD COLUMN claim_expires_at TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_commands_claim_expiry ON commands(status, claim_expires_at)');
  const executionColumns = new Set(db.pragma('table_info(command_executions)').map((column) => column.name));
  if (!executionColumns.has('working_directory')) {
    db.exec("ALTER TABLE command_executions ADD COLUMN working_directory TEXT NOT NULL DEFAULT ''");
  }
  if (!executionColumns.has('configured_working_directory')) {
    db.transaction(() => {
      db.exec("ALTER TABLE command_executions ADD COLUMN configured_working_directory TEXT NOT NULL DEFAULT ''");
      const legacyRows = db.prepare(`
        SELECT id, working_directory, raw_event_json FROM command_executions
      `).all();
      const migrateDirectory = db.prepare(`
        UPDATE command_executions
        SET configured_working_directory=?, working_directory=?
        WHERE id=?
      `);
      for (const row of legacyRows) {
        let event = {};
        try { event = JSON.parse(row.raw_event_json || '{}'); } catch {}
        const reportedDirectory = [event?.item?.cwd, event?.item?.working_directory, event?.item?.workingDirectory]
          .find((value) => typeof value === 'string') || '';
        migrateDirectory.run(String(row.working_directory || ''), reportedDirectory, row.id);
      }
    }).immediate();
  }
  const taskColumns = new Set(db.pragma('table_info(tasks)').map((column) => column.name));
  if (!taskColumns.has('recovery_count')) {
    db.exec('ALTER TABLE tasks ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!taskColumns.has('current_pid_start_ticks')) {
    db.exec("ALTER TABLE tasks ADD COLUMN current_pid_start_ticks TEXT NOT NULL DEFAULT ''");
  }
  if (!taskColumns.has('current_process_group_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN current_process_group_id INTEGER');
  }
  const attemptColumns = new Set(db.pragma('table_info(attempts)').map((column) => column.name));
  if (!attemptColumns.has('pid_start_ticks')) {
    db.exec("ALTER TABLE attempts ADD COLUMN pid_start_ticks TEXT NOT NULL DEFAULT ''");
  }
  if (!attemptColumns.has('process_group_id')) {
    db.exec('ALTER TABLE attempts ADD COLUMN process_group_id INTEGER');
  }
  const externalAttemptColumns = new Set(db.pragma('table_info(external_attempts)').map((column) => column.name));
  const externalAttemptMigrations = [
    ['step_run_id', 'ALTER TABLE external_attempts ADD COLUMN step_run_id TEXT REFERENCES step_runs(id) ON DELETE SET NULL'],
    ['skill_invocation_id', 'ALTER TABLE external_attempts ADD COLUMN skill_invocation_id TEXT REFERENCES skill_invocations(id) ON DELETE SET NULL'],
    ['pid_start_ticks', "ALTER TABLE external_attempts ADD COLUMN pid_start_ticks TEXT NOT NULL DEFAULT ''"],
    ['process_group_id', 'ALTER TABLE external_attempts ADD COLUMN process_group_id INTEGER'],
    ['cgroup_path', "ALTER TABLE external_attempts ADD COLUMN cgroup_path TEXT NOT NULL DEFAULT ''"],
    ['cgroup_inode', "ALTER TABLE external_attempts ADD COLUMN cgroup_inode TEXT NOT NULL DEFAULT ''"],
    ['artifact_declarations_json', "ALTER TABLE external_attempts ADD COLUMN artifact_declarations_json TEXT NOT NULL DEFAULT '[]'"],
    ['archived_log_path', "ALTER TABLE external_attempts ADD COLUMN archived_log_path TEXT NOT NULL DEFAULT ''"],
    ['archived_log_bytes', 'ALTER TABLE external_attempts ADD COLUMN archived_log_bytes INTEGER'],
    ['archived_log_sha256', "ALTER TABLE external_attempts ADD COLUMN archived_log_sha256 TEXT NOT NULL DEFAULT ''"],
    ['archive_status', "ALTER TABLE external_attempts ADD COLUMN archive_status TEXT NOT NULL DEFAULT 'pending'"],
    ['archive_error', "ALTER TABLE external_attempts ADD COLUMN archive_error TEXT NOT NULL DEFAULT ''"],
    ['archive_attempt_count', 'ALTER TABLE external_attempts ADD COLUMN archive_attempt_count INTEGER NOT NULL DEFAULT 0'],
    ['archive_next_retry_at', "ALTER TABLE external_attempts ADD COLUMN archive_next_retry_at TEXT NOT NULL DEFAULT ''"],
    ['archive_lease_owner', "ALTER TABLE external_attempts ADD COLUMN archive_lease_owner TEXT NOT NULL DEFAULT ''"],
    ['archive_lease_expires_at', "ALTER TABLE external_attempts ADD COLUMN archive_lease_expires_at TEXT NOT NULL DEFAULT ''"],
    ['archived_at', "ALTER TABLE external_attempts ADD COLUMN archived_at TEXT NOT NULL DEFAULT ''"],
    ['archive_verify_status', "ALTER TABLE external_attempts ADD COLUMN archive_verify_status TEXT NOT NULL DEFAULT 'pending'"],
    ['archive_verify_error', "ALTER TABLE external_attempts ADD COLUMN archive_verify_error TEXT NOT NULL DEFAULT ''"],
    ['archive_verify_count', 'ALTER TABLE external_attempts ADD COLUMN archive_verify_count INTEGER NOT NULL DEFAULT 0'],
    ['archive_verified_at', "ALTER TABLE external_attempts ADD COLUMN archive_verified_at TEXT NOT NULL DEFAULT ''"],
    ['archive_verify_next_at', "ALTER TABLE external_attempts ADD COLUMN archive_verify_next_at TEXT NOT NULL DEFAULT ''"],
    ['archive_verify_lease_owner', "ALTER TABLE external_attempts ADD COLUMN archive_verify_lease_owner TEXT NOT NULL DEFAULT ''"],
    ['archive_verify_lease_expires_at', "ALTER TABLE external_attempts ADD COLUMN archive_verify_lease_expires_at TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [column, statement] of externalAttemptMigrations) {
    if (!externalAttemptColumns.has(column)) db.exec(statement);
  }
  const skillReportColumns = new Set(db.pragma('table_info(skill_reports)').map((column) => column.name));
  if (!skillReportColumns.has('step_run_id')) {
    db.exec('ALTER TABLE skill_reports ADD COLUMN step_run_id TEXT REFERENCES step_runs(id) ON DELETE SET NULL');
  }
  const skillReportArtifactColumns = new Set(
    db.pragma('table_info(skill_report_artifacts)').map((column) => column.name),
  );
  if (!skillReportArtifactColumns.has('source_sha256')) {
    db.exec("ALTER TABLE skill_report_artifacts ADD COLUMN source_sha256 TEXT NOT NULL DEFAULT ''");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_external_attempts_step_run
      ON external_attempts(step_run_id, chain_key, generation DESC);
    CREATE INDEX IF NOT EXISTS idx_external_attempts_skill_invocation
      ON external_attempts(skill_invocation_id)
      WHERE skill_invocation_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_skill_reports_step_run
      ON skill_reports(step_run_id, published_at DESC, sequence DESC);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_external_attempts_archive_queue
      ON external_attempts(archive_status, archive_next_retry_at, finished_at)
      WHERE status<>'running'
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_external_attempts_archive_verify_queue
      ON external_attempts(archive_verify_status, archive_verify_next_at, archive_verified_at)
      WHERE archive_status='archived'
  `);
  db.exec(`
    UPDATE external_attempts
    SET started_at = (
      SELECT command_executions.started_at
      FROM command_executions
      WHERE command_executions.id = external_attempts.source_command_execution_id
    )
    WHERE source_command_execution_id IS NOT NULL
      AND COALESCE((
        SELECT command_executions.started_at
        FROM command_executions
        WHERE command_executions.id = external_attempts.source_command_execution_id
      ), '') > started_at
  `);
}

function getDatabase() {
  if (database) return database;
  ensurePrivateDataDirectory();
  secureDatabaseRuntimeFiles();
  const candidate = new Database(DB_FILE);
  try {
    candidate.pragma('journal_mode = WAL');
    candidate.pragma('synchronous = FULL');
    candidate.pragma('foreign_keys = ON');
    candidate.pragma('busy_timeout = 5000');
    candidate.transaction(() => schema(candidate)).immediate();
    secureDatabaseRuntimeFiles();
  } catch (error) {
    try { candidate.close(); } catch {}
    integrityCache = null;
    throw error;
  }
  database = candidate;
  return database;
}

function closeDatabase() {
  if (!database) return;
  const closing = database;
  database = null;
  integrityCache = null;
  closing.close();
}

function checkDatabaseIntegrity(force = false) {
  if (!force && integrityCache && Date.now() - integrityCache.checkedAtMs < INTEGRITY_CACHE_TTL_MS) {
    return { ...integrityCache.result, cached: true };
  }
  const db = getDatabase();
  const quickCheck = db.pragma('quick_check', { simple: true });
  const foreignKeyViolations = db.pragma('foreign_key_check').length;
  const result = {
    ok: quickCheck === 'ok' && foreignKeyViolations === 0,
    quickCheck,
    foreignKeyViolations,
    checkedAt: new Date().toISOString(),
    cached: false,
  };
  integrityCache = { checkedAtMs: Date.now(), result };
  return result;
}

module.exports = {
  getDatabase,
  closeDatabase,
  checkDatabaseIntegrity,
};
