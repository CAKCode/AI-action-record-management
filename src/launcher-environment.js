const RESTART_ENVIRONMENT_NAMES = Object.freeze([
  'HOST',
  'PORT',
  'CODEX_HOME',
  'CODEX_ALLOW_ROOT_EXECUTION',
  'CODEX_API_IDLE_TIMEOUT_MS',
  'CODEX_API_MAX_CONCURRENCY',
  'CODEX_BIN',
  'CODEX_DB_BACKUP_INTERVAL_HOURS',
  'CODEX_DB_BACKUP_RETENTION',
  'CODEX_DESK_AUTH_PASSWORD',
  'CODEX_DESK_AUTH_USER',
  'CODEX_DESK_BACKUP_DIR',
  'CODEX_DESK_DATA_DIR',
  'CODEX_DESK_RUNTIME_DIR',
  'CODEX_DISABLE_WORKER',
  'CODEX_INTERACTIVE_MAX_TERMINALS',
  'CODEX_INTERACTIVE_DISCONNECT_TIMEOUT_MS',
  'CODEX_INTERACTIVE_REPLAY_BYTES',
  'CODEX_LOG_STREAM_IDLE_TIMEOUT_MS',
  'CODEX_LOG_STREAM_MAX_CONCURRENCY',
  'CODEX_RECOVERY_CHECKPOINT_INTERVAL_HOURS',
  'CODEX_RECOVERY_CHECKPOINT_RETENTION',
  'CODEX_RELEASE_ID',
  'CODEX_SOURCE_HOME',
  'CODEX_TASK_REAL_CODEX_BIN',
  'CODEX_TASK_WORKSPACE_ROOTS',
  'CODEX_WEB_SUPERVISOR_LOG_MAX_BYTES',
  'CODEX_WEB_SUPERVISOR_LOG_RETENTION',
  'CODEX_WEB_SUPERVISOR_LOG_STDIO',
  'SOURCE_CODEX_HOME',
  'WORKSPACE_CODEX_SKILLS_DIR',
  'BRIDGE_BOT_ID',
  'BRIDGE_BOT_NAME',
  'BRIDGE_CHATFILE_ROOT',
  'BRIDGE_PYTHON',
  'BRIDGE_RUNNER',
  'BRIDGE_RUNTIME_ROOT',
]);

const MAX_RESTART_ENVIRONMENT_VALUE_BYTES = 8192;
const MAX_RESTART_ENVIRONMENT_BYTES = 49152;

function restartEnvironmentByteLength(value) {
  return Object.entries(value)
    .reduce((total, [name, entry]) => total + Buffer.byteLength(name) + Buffer.byteLength(entry) + 2, 0);
}

function restartEnvironment(environment = process.env) {
  const result = {};
  for (const name of RESTART_ENVIRONMENT_NAMES) {
    if (environment[name] == null) continue;
    const value = String(environment[name]);
    if (Buffer.byteLength(value) > MAX_RESTART_ENVIRONMENT_VALUE_BYTES) {
      throw new Error(`Launcher restart environment ${name} is unexpectedly large`);
    }
    result[name] = value;
  }
  if (restartEnvironmentByteLength(result) > MAX_RESTART_ENVIRONMENT_BYTES) {
    throw new Error('Launcher restart environment is unexpectedly large');
  }
  return result;
}

function validRestartEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [name, entry] of Object.entries(value)) {
    if (!RESTART_ENVIRONMENT_NAMES.includes(name)
      || typeof entry !== 'string'
      || Buffer.byteLength(entry) > MAX_RESTART_ENVIRONMENT_VALUE_BYTES) return false;
  }
  return restartEnvironmentByteLength(value) <= MAX_RESTART_ENVIRONMENT_BYTES;
}

module.exports = {
  restartEnvironment,
  validRestartEnvironment,
};
