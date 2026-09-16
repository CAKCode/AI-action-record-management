const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ops-reliability-'));
const dataDir = path.join(tempDir, 'data');
const runtimeDir = path.join(tempDir, 'runtime');
const workspaceRoot = path.join(tempDir, 'workspaces');
const sourceHome = path.join(tempDir, 'codex-home');
const sourceSkills = path.join(sourceHome, 'skills');
const workspaceSkills = path.join(tempDir, 'workspace-skills');

for (const dir of [dataDir, runtimeDir, workspaceRoot, sourceSkills, workspaceSkills]) {
  fs.mkdirSync(dir, { recursive: true });
}
for (const relative of ['a.b/dup', 'a-b/dup']) {
  const dir = path.join(sourceSkills, relative);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${relative}\n\nCollision test.\n`, 'utf8');
}
const longSkillDir = path.join(sourceSkills, `long-${'x'.repeat(100)}`);
fs.mkdirSync(longSkillDir, { recursive: true });
fs.writeFileSync(path.join(longSkillDir, 'SKILL.md'), '# Long Source Skill\n\nLong id test.\n', 'utf8');
const linkedSkillDir = path.join(sourceSkills, 'linked-skill');
const linkedSkillTarget = path.join(sourceHome, 'linked-target.md');
fs.mkdirSync(linkedSkillDir, { recursive: true });
fs.writeFileSync(linkedSkillTarget, '# Symlinked Source Skill\n\nMust not be discovered.\n', 'utf8');
fs.symlinkSync(linkedSkillTarget, path.join(linkedSkillDir, 'SKILL.md'));
const workspaceSkillDir = path.join(workspaceSkills, 'platform-api');
fs.mkdirSync(workspaceSkillDir, { recursive: true });
fs.writeFileSync(path.join(workspaceSkillDir, 'SKILL.md'), [
  '---',
  'name: platform-api',
  'description: Workspace source discovery test.',
  '---',
  '# Platform API',
  '',
].join('\n'), 'utf8');
const fakeRuntimeCodex = path.join(tempDir, 'runtime-codex');
fs.writeFileSync(fakeRuntimeCodex, '#!/bin/sh\nexit 0\n', 'utf8');
fs.chmodSync(fakeRuntimeCodex, 0o700);

process.env.CODEX_DESK_DATA_DIR = dataDir;
process.env.CODEX_DESK_RUNTIME_DIR = runtimeDir;
process.env.CODEX_TASK_WORKSPACE_ROOTS = workspaceRoot;
process.env.SOURCE_CODEX_HOME = sourceHome;
process.env.WORKSPACE_CODEX_SKILLS_DIR = workspaceSkills;
process.env.CODEX_TASK_REAL_CODEX_BIN = fakeRuntimeCodex;
process.env.CODEX_ALLOW_ROOT_EXECUTION = '1';

const store = require('../src/store');
const { getDatabase, closeDatabase } = require('../src/database');
const { SESSIONS_DIR, SKILL_SNAPSHOTS_DIR } = require('../src/paths');
const { recoverRollout } = require('../bin/recover-codex-rollout');
const { startSession, heartbeatActive, listActiveSessions } = require('../src/orchestrator');

test.after(() => {
  closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('the production service example supervises the web process without a root override', () => {
  const unit = fs.readFileSync(path.join(ROOT_DIR, 'deploy', 'codex-task-sessions.service.example'), 'utf8');
  assert.match(unit, /^User=codex-task-sessions$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/codex-task-sessions\/bin\/web-supervisor\.js$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^KillMode=control-group$/m);
  assert.match(unit, /^StateDirectory=codex-task-sessions codex-task-workspaces$/m);
  assert.doesNotMatch(unit, /CODEX_ALLOW_ROOT_EXECUTION/);
});

test('the supervised npm command uses the host launcher rather than bypassing it', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['start:supervised'], 'sh start-supervised.sh');
  assert.equal(packageJson.scripts['restart:supervised'], 'node bin/rolling-restart.js');
});

test('the supervised launcher isolates the authentication source from inherited task homes', () => {
  const startScript = fs.readFileSync(path.join(ROOT_DIR, 'start-supervised.sh'), 'utf8');
  assert.match(startScript, /CODEX_SOURCE_HOME=.*SOURCE_CODEX_HOME/);
  assert.match(startScript, /CODEX_HOME=\"\$CODEX_SOURCE_HOME\"/);
  assert.match(startScript, /export PORT HOST CODEX_SOURCE_HOME CODEX_HOME/);
});

test('the worker has no active task concurrency limit', () => {
  const serverSource = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
  const workerSource = fs.readFileSync(path.join(ROOT_DIR, 'worker.js'), 'utf8');
  const startScript = fs.readFileSync(path.join(ROOT_DIR, 'start-supervised.sh'), 'utf8');
  assert.doesNotMatch(serverSource, /CODEX_WORKER_MAX_CONCURRENCY/);
  assert.doesNotMatch(workerSource, /CODEX_WORKER_MAX_CONCURRENCY|availableSlots/);
  assert.match(workerSource, /COMMAND_CLAIM_BATCH_SIZE = 64/);
  assert.doesNotMatch(startScript, /CODEX_WORKER_MAX_CONCURRENCY/);
});

test('worker heartbeats do not write while platform maintenance is active', () => {
  const database = getDatabase();
  const before = database.prepare("SELECT value FROM metadata WHERE key='worker_heartbeat'").get()?.value || null;
  const owner = 'test:maintenance-heartbeat';
  store.acquirePlatformMaintenance('recovery_checkpoint', owner, 30000);
  try {
    heartbeatActive('maintenance-heartbeat-worker');
    const during = database.prepare("SELECT value FROM metadata WHERE key='worker_heartbeat'").get()?.value || null;
    assert.equal(during, before);
  } finally {
    assert.equal(store.releasePlatformMaintenance(owner), true);
  }

  heartbeatActive('maintenance-heartbeat-worker');
  const after = JSON.parse(database.prepare("SELECT value FROM metadata WHERE key='worker_heartbeat'").get().value);
  assert.equal(after.workerId, 'maintenance-heartbeat-worker');
});

test('service startup does not replay storage audit outbox during maintenance', () => {
  const serverSource = fs.readFileSync(path.join(ROOT_DIR, 'server.js'), 'utf8');
  assert.match(serverSource, /if \(!getPlatformMaintenance\(\)\) storageAudit\.retryAll\(\);/);
  assert.match(serverSource, /storageAuditRetryTimer = setInterval\(\(\) => \{\s*if \(getPlatformMaintenance\(\)\) return;\s*storageAudit\.retryAll\(\);/s);
});

test('the task Codex launcher always injects the full-access bypass flag', () => {
  const fakeCodex = path.join(tempDir, 'fake-codex');
  fs.writeFileSync(fakeCodex, '#!/bin/sh\nprintf "%s\\n" "$@"\n', 'utf8');
  fs.chmodSync(fakeCodex, 0o700);
  const launched = spawnSync(path.join(ROOT_DIR, 'bin', 'full-access', 'codex'), ['exec', 'verify'], {
    env: { ...process.env, CODEX_TASK_REAL_CODEX_BIN: fakeCodex },
    encoding: 'utf8',
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.deepEqual(launched.stdout.trim().split('\n'), [
    '--dangerously-bypass-approvals-and-sandbox', 'exec', 'verify',
  ]);
  const alreadyConfigured = spawnSync(path.join(ROOT_DIR, 'bin', 'full-access', 'codex'), [
    '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen', 'verify',
  ], {
    env: { ...process.env, CODEX_TASK_REAL_CODEX_BIN: fakeCodex },
    encoding: 'utf8',
  });
  assert.equal(alreadyConfigured.status, 0, alreadyConfigured.stderr);
  assert.deepEqual(alreadyConfigured.stdout.trim().split('\n'), [
    '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen', 'verify',
  ]);
});

test('the task stream runner keeps only platform-relevant BridgeContext fields', () => {
  const runner = path.join(ROOT_DIR, 'bin', 'bridge-stream-runner.py');
  const sourcePrompt = [
    '[BridgeContext]',
    'botName: task-bot',
    'chatKey: single:task-key',
    'sessionId: session-1234',
    'executionMode: host',
    'SOURCE_DIR: /srv/source',
    'CWD_DIR: /srv/work',
    'CHATFILE_DIR: /srv/audit',
    'effectiveSkills: one, two, three',
    'localSendFileCommand: very long command',
    'Run in CWD_DIR.',
    '[/BridgeContext]',
    '',
    'User request:',
    'Run the task.',
  ].join('\n');
  const compacted = spawnSync('python3', [
    '-c',
    [
      'import importlib.util',
      'import sys',
      'spec = importlib.util.spec_from_file_location("bridge_stream_runner", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'sys.stdout.write(module.compact_bridge_context(sys.stdin.read()))',
    ].join('\n'),
    runner,
  ], {
    input: sourcePrompt,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });

  assert.equal(compacted.status, 0, compacted.stderr);
  assert.equal(compacted.stdout, [
    '[BridgeContext]',
    'sessionId: session-1234',
    'executionMode: host',
    'SOURCE_DIR: /srv/source',
    'CWD_DIR: /srv/work',
    'CHATFILE_DIR: /srv/audit',
    'Run in CWD_DIR.',
    '[/BridgeContext]',
    '',
    'User request:',
    'Run the task.',
  ].join('\n'));
  assert.ok(compacted.stdout.length < sourcePrompt.length - 100);
  assert.doesNotMatch(compacted.stdout, /localSendFileCommand|effectiveSkills|chatKey/);
});

test('the task stream runner replaces codex exec with the real interactive TUI command', () => {
  const runner = path.join(ROOT_DIR, 'bin', 'bridge-stream-runner.py');
  const converted = spawnSync('python3', [
    '-c',
    [
      'import importlib.util',
      'import json',
      'import sys',
      'spec = importlib.util.spec_from_file_location("bridge_stream_runner", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'argv = ("codex", "exec", "resume", "thread-1", "--json", "-o", "/tmp/result", "-")',
      'converted = module.interactive_terminal_argv(argv, "Run the task.", module.Path("/srv/work"))',
      'sys.stdout.write(json.dumps(converted))',
    ].join('\n'),
    runner,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });

  assert.equal(converted.status, 0, converted.stderr);
  assert.deepEqual(JSON.parse(converted.stdout), [
    'codex', '--no-alt-screen', '-C', '/srv/work', 'resume', 'thread-1', '--', 'Run the task.',
  ]);
});

test('the task stream runner atomically persists task workspace trust in private Codex config', () => {
  const runner = path.join(ROOT_DIR, 'bin', 'bridge-stream-runner.py');
  const fixtureRoot = path.join(tempDir, 'trusted-project-config');
  const codexHome = path.join(fixtureRoot, 'codex-home');
  const workingDirectory = path.join(fixtureRoot, 'workspace with spaces');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workingDirectory, { recursive: true });
  const configPath = path.join(codexHome, 'config.toml');
  fs.writeFileSync(configPath, 'model = "gpt-test"\n', { mode: 0o644 });

  const updated = spawnSync('python3', [
    '-c',
    [
      'import importlib.util',
      'import json',
      'import pathlib',
      'import stat',
      'import sys',
      'import tomllib',
      'spec = importlib.util.spec_from_file_location("bridge_stream_runner", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'codex_home = pathlib.Path(sys.argv[2])',
      'working_directory = pathlib.Path(sys.argv[3])',
      'module.ensure_trusted_project(codex_home, working_directory)',
      'module.ensure_trusted_project(codex_home, working_directory)',
      'config_path = codex_home / "config.toml"',
      'parsed = tomllib.loads(config_path.read_text(encoding="utf-8"))',
      'print(json.dumps({',
      '    "model": parsed["model"],',
      '    "project": parsed["projects"][str(working_directory.resolve())],',
      '    "mode": stat.S_IMODE(config_path.stat().st_mode),',
      '    "table_count": config_path.read_text(encoding="utf-8").count("[projects."),',
      '}))',
    ].join('\n'),
    runner,
    codexHome,
    workingDirectory,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });

  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout), {
    model: 'gpt-test',
    project: { trust_level: 'trusted' },
    mode: 0o600,
    table_count: 1,
  });
});

test('the task stream runner refuses conflicting task workspace trust', () => {
  const runner = path.join(ROOT_DIR, 'bin', 'bridge-stream-runner.py');
  const fixtureRoot = path.join(tempDir, 'conflicting-project-config');
  const codexHome = path.join(fixtureRoot, 'codex-home');
  const workingDirectory = path.join(fixtureRoot, 'workspace');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workingDirectory, { recursive: true });
  const configPath = path.join(codexHome, 'config.toml');
  fs.writeFileSync(configPath, [
    `[projects.${JSON.stringify(workingDirectory)}]`,
    'trust_level = "untrusted"',
    '',
  ].join('\n'), { mode: 0o600 });

  const rejected = spawnSync('python3', [
    '-c',
    [
      'import importlib.util',
      'import pathlib',
      'import sys',
      'spec = importlib.util.spec_from_file_location("bridge_stream_runner", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'module.ensure_trusted_project(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))',
    ].join('\n'),
    runner,
    codexHome,
    workingDirectory,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });

  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /conflicting trust setting/);
  assert.equal(fs.readFileSync(configPath, 'utf8').includes('untrusted'), true);
});

test('the PTY runner preserves the real TUI bytes and exits on the structured task_complete event', () => {
  const fixtureRoot = path.join(tempDir, 'managed-pty-success');
  const bridgeRoot = path.join(fixtureRoot, 'bridge');
  const bridgePackage = path.join(bridgeRoot, 'workspace_bridge');
  const sourceDir = path.join(fixtureRoot, 'source');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const chatfileRoot = path.join(fixtureRoot, 'chatfile');
  const codexHome = path.join(fixtureRoot, 'codex-home');
  const outputFile = path.join(fixtureRoot, 'result.txt');
  const stdoutFile = path.join(fixtureRoot, 'stdout.log');
  const stderrFile = path.join(fixtureRoot, 'stderr.log');
  const argvFile = path.join(fixtureRoot, 'argv.json');
  const promptFile = path.join(fixtureRoot, 'prompt.txt');
  const threadFile = path.join(fixtureRoot, 'thread.txt');
  const fakeCodex = path.join(fixtureRoot, 'fake-codex.py');
  for (const directory of [bridgePackage, sourceDir, runtimeRoot, chatfileRoot, codexHome]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(outputFile, '', { mode: 0o600 });
  fs.writeFileSync(path.join(bridgePackage, '__init__.py'), '', 'utf8');
  fs.writeFileSync(path.join(bridgePackage, 'prompting.py'), [
    'def build_prompt(_bot, _launch, message):',
    '    return message',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(bridgePackage, 'runner.py'), [
    'import os',
    'import sys',
    'from types import SimpleNamespace',
    '',
    'def build_runner_invocation(launch, prompt, output_file, **_kwargs):',
    '    env = os.environ.copy()',
    '    return SimpleNamespace(',
    '        argv=[sys.executable, os.environ["FAKE_CODEX_SCRIPT"], "exec", "--json", "-o", str(output_file), "-"],',
    '        cwd=str(launch.cwd), env=env, prompt=prompt,',
    '    )',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(bridgePackage, 'runtime.py'), [
    'import os',
    'import time',
    'from dataclasses import dataclass',
    'from pathlib import Path',
    'from types import SimpleNamespace',
    '',
    '@dataclass(frozen=True)',
    'class SessionRecord:',
    '    updated_at: int = 0',
    '    last_run_at: int = 0',
    '    thread_id: str | None = None',
    '',
    'def build_bot_config(bot_id, bot_name, source_dir, runtime_root, chatfile_root):',
    '    return SimpleNamespace(',
    '        bot_id=bot_id, bot_name=bot_name, source_dir=Path(source_dir),',
    '        runtime_root=Path(runtime_root), chatfile_root=Path(chatfile_root),',
    '    )',
    '',
    'def now_ms():',
    '    return int(time.time() * 1000)',
    '',
    'def prepare_session_run(bot, _chat_key):',
    '    return SimpleNamespace(',
    '        cwd=bot.source_dir,',
    '        session=SimpleNamespace(session_id="test-session", workspace_id="test-workspace", thread_id=None),',
    '        runtime_context=SimpleNamespace(',
    '            cwd_dir=bot.source_dir, chatfile_dir=bot.chatfile_root, effective_skill_names=[],',
    '        ),',
    '    )',
    '',
    'def update_session_record(_runtime_root, _session_id, updater):',
    '    updated = updater(SessionRecord())',
    '    with open(os.environ["FAKE_THREAD_FILE"], "w", encoding="utf-8") as handle:',
    '        handle.write(updated.thread_id or "")',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(fakeCodex, [
    'import json',
    'import os',
    'import pathlib',
    'import signal',
    'import stat',
    'import sys',
    'import time',
    'import tomllib',
    '',
    'assert os.isatty(sys.stdin.fileno())',
    'assert os.isatty(sys.stdout.fileno())',
    'assert os.isatty(sys.stderr.fileno())',
    'with open(os.environ["FAKE_ARGV_FILE"], "w", encoding="utf-8") as handle:',
    '    json.dump(sys.argv[1:], handle)',
    'with open(os.environ["FAKE_PROMPT_FILE"], "w", encoding="utf-8") as handle:',
    '    handle.write(sys.argv[-1])',
    'config_path = pathlib.Path(os.environ["CODEX_HOME"]) / "config.toml"',
    'config = tomllib.loads(config_path.read_text(encoding="utf-8"))',
    'assert config["projects"][os.getcwd()]["trust_level"] == "trusted"',
    'assert stat.S_IMODE(config_path.stat().st_mode) == 0o600',
    'thread_id = "019f-managed-pty-thread"',
    'rollout = pathlib.Path(os.environ["CODEX_HOME"]) / "sessions" / "2026" / "08" / "05" / f"rollout-{thread_id}.jsonl"',
    'rollout.parent.mkdir(parents=True, exist_ok=True)',
    'records = [',
    '    {"timestamp": "2026-08-05T00:00:00.000Z", "type": "session_meta", "payload": {"session_id": thread_id}},',
    '    {"timestamp": "2026-08-05T00:00:01.000Z", "type": "response_item", "payload": {"type": "message", "id": "reply-1", "role": "assistant", "content": [{"type": "output_text", "text": "PTY turn complete"}]}},',
    '    {"timestamp": "2026-08-05T00:00:02.000Z", "type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn-1", "last_agent_message": "PTY turn complete"}},',
    ']',
    'sys.stdout.write("\\x1b[?2026h\\x1b[32mCodex TUI ready\\x1b[0m\\r\\n\\x1b[?2026l")',
    'sys.stdout.flush()',
    'rollout.write_text("\\n".join(json.dumps(record) for record in records) + "\\n", encoding="utf-8")',
    'signal.signal(signal.SIGTERM, lambda _signum, _frame: sys.exit(0))',
    'while True:',
    '    time.sleep(0.1)',
    '',
  ].join('\n'), 'utf8');

  const result = spawnSync('python3', [
    path.join(ROOT_DIR, 'bin', 'bridge-stream-runner.py'),
    '--bot-id', 'test-bot',
    '--bot-name', 'Test Bot',
    '--runtime-root', runtimeRoot,
    '--source-dir', sourceDir,
    '--chatfile-root', chatfileRoot,
    '--chat-key', 'single:test-session',
    '--message', 'Exercise the managed PTY.',
    '--output-file', outputFile,
    '--stdout-file', stdoutFile,
    '--stderr-file', stderrFile,
  ], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CODEX_TASK_BRIDGE_ROOT: bridgeRoot,
      CODEX_HOME: codexHome,
      FAKE_CODEX_SCRIPT: fakeCodex,
      FAKE_ARGV_FILE: argvFile,
      FAKE_PROMPT_FILE: promptFile,
      FAKE_THREAD_FILE: threadFile,
    },
    encoding: 'utf8',
    timeout: 8000,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\u001b\[\?2026h\u001b\[32mCodex TUI ready\u001b\[0m\r\r?\n\u001b\[\?2026l/);
  assert.equal(fs.readFileSync(stdoutFile, 'utf8'), result.stdout);
  assert.equal(fs.readFileSync(stderrFile, 'utf8'), '');
  assert.equal(fs.readFileSync(outputFile, 'utf8'), 'PTY turn complete');
  assert.equal(fs.readFileSync(promptFile, 'utf8'), 'Exercise the managed PTY.');
  assert.equal(fs.readFileSync(threadFile, 'utf8'), '019f-managed-pty-thread');
  const childArgv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert.equal(childArgv.includes('exec'), false);
  assert.equal(childArgv.includes('--json'), false);
  assert.equal(childArgv.includes('-o'), false);
  assert.ok(childArgv.includes('--no-alt-screen'));
  assert.deepEqual(childArgv.slice(-2), ['--', 'Exercise the managed PTY.']);
  const controls = result.stderr.split('\n')
    .filter((line) => line.startsWith('CODEX_TASK_CONTROL '))
    .map((line) => JSON.parse(line.slice('CODEX_TASK_CONTROL '.length)));
  assert.deepEqual(controls.map((control) => control.type), ['pty.started', 'rollout.ready']);
  assert.equal(controls[1].threadId, '019f-managed-pty-thread');
  assert.equal(controls[1].offset, 0);
});

test('the PTY runner fails promptly when a Codex descendant keeps the terminal open', () => {
  const fixtureRoot = path.join(tempDir, 'stderr-drain-timeout');
  const bridgeRoot = path.join(fixtureRoot, 'bridge');
  const bridgePackage = path.join(bridgeRoot, 'workspace_bridge');
  const sourceDir = path.join(fixtureRoot, 'source');
  const runtimeRoot = path.join(fixtureRoot, 'runtime');
  const chatfileRoot = path.join(fixtureRoot, 'chatfile');
  const codexHome = path.join(fixtureRoot, 'codex-home');
  const outputFile = path.join(fixtureRoot, 'result.txt');
  const stdoutFile = path.join(fixtureRoot, 'stdout.log');
  const stderrFile = path.join(fixtureRoot, 'stderr.log');
  const childPidFile = path.join(fixtureRoot, 'child.pid');
  const fakeCodex = path.join(fixtureRoot, 'fake-codex.py');
  for (const directory of [bridgePackage, sourceDir, runtimeRoot, chatfileRoot, codexHome]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(bridgePackage, '__init__.py'), '', 'utf8');
  fs.writeFileSync(path.join(bridgePackage, 'prompting.py'), [
    'def build_prompt(_bot, _launch, message):',
    '    return message',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(bridgePackage, 'runner.py'), [
    'import os',
    'import sys',
    'from types import SimpleNamespace',
    '',
    'def build_runner_invocation(launch, prompt, **_kwargs):',
    '    return SimpleNamespace(',
    '        argv=[sys.executable, os.environ["FAKE_CODEX_SCRIPT"]],',
    '        cwd=str(launch.cwd),',
    '        env=os.environ.copy(),',
    '        prompt=prompt,',
    '    )',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(bridgePackage, 'runtime.py'), [
    'import time',
    'from pathlib import Path',
    'from types import SimpleNamespace',
    '',
    'def build_bot_config(bot_id, bot_name, source_dir, runtime_root, chatfile_root):',
    '    return SimpleNamespace(',
    '        bot_id=bot_id, bot_name=bot_name, source_dir=Path(source_dir),',
    '        runtime_root=Path(runtime_root), chatfile_root=Path(chatfile_root),',
    '    )',
    '',
    'def now_ms():',
    '    return int(time.time() * 1000)',
    '',
    'def prepare_session_run(bot, _chat_key):',
    '    return SimpleNamespace(',
    '        cwd=bot.source_dir,',
    '        session=SimpleNamespace(session_id="test-session", workspace_id="test-workspace", thread_id=None),',
    '        runtime_context=SimpleNamespace(',
    '            cwd_dir=bot.source_dir, chatfile_dir=bot.chatfile_root, effective_skill_names=[],',
    '        ),',
    '    )',
    '',
    'def update_session_record(_runtime_root, _session_id, _updater):',
    '    return None',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(fakeCodex, [
    'import os',
    'import subprocess',
    'import sys',
    '',
    'child = subprocess.Popen(',
    '    [sys.executable, "-c", "import time; time.sleep(30)"],',
    '    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,',
    ')',
    'with open(os.environ["FAKE_CHILD_PID_FILE"], "w", encoding="utf-8") as handle:',
    '    handle.write(str(child.pid))',
    '    handle.flush()',
    'sys.stdout.write("{\\\"type\\\":\\\"turn.completed\\\"}\\n")',
    'sys.stdout.flush()',
    '',
  ].join('\n'), 'utf8');

  let childPid;
  const startedAt = Date.now();
  try {
    const result = spawnSync('python3', [
      path.join(ROOT_DIR, 'bin', 'bridge-stream-runner.py'),
      '--bot-id', 'test-bot',
      '--bot-name', 'Test Bot',
      '--runtime-root', runtimeRoot,
      '--source-dir', sourceDir,
      '--chatfile-root', chatfileRoot,
      '--chat-key', 'single:test-session',
      '--message', 'Exercise stderr drain timeout.',
      '--output-file', outputFile,
      '--stdout-file', stdoutFile,
      '--stderr-file', stderrFile,
    ], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        CODEX_TASK_BRIDGE_ROOT: bridgeRoot,
        CODEX_HOME: codexHome,
        FAKE_CODEX_SCRIPT: fakeCodex,
        FAKE_CHILD_PID_FILE: childPidFile,
      },
      encoding: 'utf8',
      timeout: 8000,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 74, result.stderr);
    assert.ok(elapsedMs >= 1500, `runner exited before the drain timeout: ${elapsedMs}ms`);
    assert.ok(elapsedMs < 7000, `runner remained blocked for ${elapsedMs}ms`);
    assert.match(result.stderr, /PTY remained open for more than 2 seconds after Codex exited/);
    assert.match(result.stdout, /\{"type":"turn\.completed"\}/);
    assert.match(fs.readFileSync(stdoutFile, 'utf8'), /\{"type":"turn\.completed"\}/);
    assert.match(fs.readFileSync(stderrFile, 'utf8'), /PTY remained open for more than 2 seconds/);
    childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
    assert.ok(Number.isInteger(childPid) && childPid > 1);
  } finally {
    if (!childPid && fs.existsSync(childPidFile)) childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
    if (Number.isInteger(childPid) && childPid > 1) {
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
  }
});

test('rollout recovery restores exact Agent replies, commands, and command output idempotently', () => {
  const taskId = 'rollout-recovery-task';
  store.saveSession(taskId, {
    name: 'Rollout Recovery', objective: 'Recover an interrupted Codex event stream.', workingDir: '.',
  });
  const turn = store.createTurn(taskId, 'Run the converter smoke test.');
  const attemptId = 'attempt-rollout-recovery';
  getDatabase().prepare(`
    INSERT INTO attempts(id, task_id, turn_id, attempt_no, worker_id, status, started_at)
    VALUES (?, ?, ?, 1, 'interrupted-worker', 'cancelled', ?)
  `).run(attemptId, taskId, turn.id, '2026-07-31T10:00:00.000Z');
  const command = '/opt/platform/codex-skill-use converter-test run-in-background -- python3 -m pytest -v converter/test_smoke.py';
  const commandOutput = 'Script completed\nWall time 1.2 seconds\nOutput:\n4 failed in 20.00s\n';
  const rolloutPath = path.join(tempDir, 'rollout-recovery.jsonl');
  const toolInput = `const r = await tools.exec_command(${JSON.stringify({ cmd: command, workdir: workspaceRoot })});\ntext(r.output);\n`;
  const records = [
    {
      timestamp: '2026-07-31T10:00:01.000Z', type: 'response_item',
      payload: { type: 'message', id: 'agent-message-1', role: 'assistant', content: [{ type: 'output_text', text: '正在启动 Converter smoke。' }] },
    },
    {
      timestamp: '2026-07-31T10:00:02.000Z', type: 'response_item',
      payload: { type: 'custom_tool_call', id: 'tool-call-1', call_id: 'call-1', name: 'exec', input: toolInput },
    },
    {
      timestamp: '2026-07-31T10:00:03.000Z', type: 'response_item',
      payload: { type: 'custom_tool_call_output', id: 'tool-output-1', call_id: 'call-1', output: [{ type: 'input_text', text: commandOutput }] },
    },
    {
      timestamp: '2026-07-31T10:00:04.000Z', type: 'response_item',
      payload: { type: 'message', id: 'agent-message-2', role: 'assistant', content: [{ type: 'output_text', text: 'Converter smoke 已启动。' }] },
    },
  ];
  fs.writeFileSync(rolloutPath, `${records.map(JSON.stringify).join('\n')}\n`, 'utf8');
  const recoveryOptions = {
    '--task': taskId,
    '--turn': turn.id,
    '--attempt': attemptId,
    '--rollout': rolloutPath,
    '--working-dir': workspaceRoot,
  };
  assert.equal(recoverRollout(recoveryOptions).alreadyRecovered, false);
  const executions = store.listCommandExecutions(taskId);
  assert.equal(executions.length, 1);
  assert.equal(executions[0].command, command);
  assert.equal(executions[0].output, commandOutput);
  assert.equal(executions[0].workingDirectory, workspaceRoot);
  const worklogs = store.listSessionWorklogs(taskId, { limit: 100 });
  assert.ok(worklogs.some((event) => event.message === '正在启动 Converter smoke。'));
  assert.ok(worklogs.some((event) => event.message === 'Converter smoke 已启动。'));

  const countBeforeRetry = worklogs.length;
  assert.equal(recoverRollout(recoveryOptions).alreadyRecovered, true);
  assert.equal(store.listSessionWorklogs(taskId, { limit: 100 }).length, countBeforeRetry);

  const nextOffset = fs.statSync(rolloutPath).size;
  fs.appendFileSync(rolloutPath, `${JSON.stringify({
    timestamp: '2026-07-31T10:01:00.000Z', type: 'response_item',
    payload: {
      type: 'message', id: 'agent-message-3', role: 'assistant',
      content: [{ type: 'output_text', text: 'Only the appended turn is recovered.' }],
    },
  })}\n`, 'utf8');
  const incremental = recoverRollout({ ...recoveryOptions, '--offset': String(nextOffset) });
  assert.equal(incremental.alreadyRecovered, false);
  assert.equal(incremental.rolloutOffset, nextOffset);
  const recoveredMessages = store.listSessionWorklogs(taskId, { limit: 100 })
    .filter((event) => event.kind === 'runtime.item.completed')
    .map((event) => event.message);
  assert.equal(recoveredMessages.filter((message) => message === '正在启动 Converter smoke。').length, 1);
  assert.equal(recoveredMessages.filter((message) => message === 'Only the appended turn is recovered.').length, 1);
});

test('source skill ids remain unique and managed ids are never silently rewritten', () => {
  store.ensureStorage();
  const databaseFiles = [
    path.join(dataDir, 'codex-tasks.db'),
    path.join(dataDir, 'codex-tasks.db-wal'),
    path.join(dataDir, 'codex-tasks.db-shm'),
  ].filter((filePath) => fs.existsSync(filePath));
  assert.ok(databaseFiles.length >= 2);
  for (const filePath of databaseFiles) {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
  store.refreshSourceSkills(true);
  const duplicateSkills = store.listSkillSummaries().filter((skill) => skill.name.endsWith('/dup'));
  assert.equal(duplicateSkills.length, 2);
  assert.equal(new Set(duplicateSkills.map((skill) => skill.id)).size, 2);
  assert.ok(duplicateSkills.every((skill) => /^codex-a-b-dup-[a-f0-9]{8}$/.test(skill.id)));
  const longSkill = store.listSkillSummaries().find((skill) => skill.name === 'Long Source Skill');
  assert.ok(longSkill);
  assert.ok(longSkill.id.length <= 64);
  assert.equal(store.listSkillSummaries().some((skill) => skill.name === 'Symlinked Source Skill'), false);
  const workspaceSkill = store.listSkillSummaries().find((skill) => skill.sourceKey === 'workspace:platform-api');
  assert.ok(workspaceSkill);
  assert.equal(workspaceSkill.id, 'platform-api');
  assert.equal(workspaceSkill.origin, 'codex');
  assert.equal(workspaceSkill.readOnly, true);

  assert.throws(
    () => store.saveSkill('Silently Rewritten', { name: 'Invalid', content: '# Invalid' }),
    (error) => error.statusCode === 400 && /skill id/i.test(error.message),
  );
});

test('Codex source Skill enablement survives source discovery refreshes', () => {
  store.refreshSourceSkills(true);
  const sourceSkill = store.listSkillSummaries().find((skill) => skill.origin === 'codex');
  assert.ok(sourceSkill);
  store.setSkillEnabled(sourceSkill.id, false);
  store.refreshSourceSkills(true);
  assert.equal(store.getSkill(sourceSkill.id).enabled, false);
  store.setSkillEnabled(sourceSkill.id, true);
});

test('multi-file Skill versions remain immutable in task snapshots', () => {
  const markdown = '---\nname: archive-skill\ndescription: Archive persistence test.\n---\n# Archive Skill\n';
  const firstScript = Buffer.from('#!/bin/sh\nprintf first\n');
  const binary = Buffer.from([0, 1, 2, 255]);
  const [imported] = store.importSkillArchive([{
    id: 'archive-skill', name: 'archive-skill', description: 'Archive persistence test.',
    content: markdown,
    files: [
      { path: 'SKILL.md', content: Buffer.from(markdown) },
      { path: 'scripts/run.sh', content: firstScript, mode: 0o755 },
      { path: 'assets/data.bin', content: binary },
    ],
  }]);
  assert.equal(imported.fileCount, 3);

  store.saveSession('archive-snapshot-v1', {
    name: 'Archive Snapshot V1', objective: 'Freeze version one.', workingDir: '.',
  });
  const firstSnapshot = store.ensureTaskSkillSnapshot('archive-snapshot-v1');
  const scriptPath = path.join(firstSnapshot.path, 'archive-skill', 'scripts', 'run.sh');
  const binaryPath = path.join(firstSnapshot.path, 'archive-skill', 'assets', 'data.bin');
  assert.deepEqual(fs.readFileSync(scriptPath), firstScript);
  assert.deepEqual(fs.readFileSync(binaryPath), binary);
  assert.equal(fs.statSync(scriptPath).mode & 0o777, 0o500);

  const secondScript = Buffer.from('#!/bin/sh\nprintf second\n');
  const [updated] = store.importSkillArchive([{
    id: 'archive-skill', name: 'archive-skill', description: 'Archive persistence test.',
    content: markdown,
    files: [
      { path: 'SKILL.md', content: Buffer.from(markdown) },
      { path: 'scripts/run.sh', content: secondScript, mode: 0o755 },
      { path: 'assets/data.bin', content: binary },
    ],
  }], { overwrite: true });
  assert.equal(updated.version, 2);
  assert.deepEqual(fs.readFileSync(store.ensureTaskSkillSnapshot('archive-snapshot-v1').path
    + '/archive-skill/scripts/run.sh'), firstScript);

  store.setSkillEnabled('archive-skill', false);
  store.saveSession('archive-snapshot-disabled', {
    name: 'Archive Snapshot Disabled', objective: 'Exclude disabled Skill.', workingDir: '.',
  });
  const disabledSnapshot = store.ensureTaskSkillSnapshot('archive-snapshot-disabled');
  assert.equal(fs.existsSync(path.join(disabledSnapshot.path, 'archive-skill')), false);
  assert.equal(store.deleteSkill('archive-skill'), true);
  assert.deepEqual(fs.readFileSync(scriptPath), firstScript);
});

test('Skill archive import is atomic when one id conflicts', () => {
  store.saveSkill('archive-conflict', { name: 'Archive Conflict', content: '# Existing' });
  assert.throws(() => store.importSkillArchive([
    { id: 'archive-new', name: 'Archive New', content: '# New' },
    { id: 'archive-conflict', name: 'Archive Conflict', content: '# Replacement' },
  ]), (error) => error.statusCode === 409);
  assert.equal(store.getSkill('archive-new'), null);
  assert.equal(store.getSkill('archive-conflict').content, '# Existing');
});

test('sparse completion events preserve the full command captured at start', () => {
  store.saveSession('sparse-command-task', {
    name: 'Sparse Command Task', objective: 'Preserve the command across sparse runtime events.', workingDir: '.',
  });
  store.queueSessionRun('sparse-command-task', 'Audit this command.', 'sparse-command-run');
  const [command] = store.claimPendingCommands('sparse-worker', 1);
  assert.ok(command);
  assert.equal(store.acquireTaskLease('sparse-command-task', 'sparse-worker'), true);
  const turn = store.beginSessionTurn({
    taskId: 'sparse-command-task', commandId: command.id, workerId: 'sparse-worker',
    input: 'Audit this command.', persistentSessionKey: 'single:sparse-command-task', skillSnapshotId: null,
  }).turn;
  const attemptId = store.createAttempt('sparse-command-task', turn.id, 1, 'sparse-worker');
  store.appendRuntimeWorklog('sparse-command-task', {
    turnId: turn.id, kind: 'runtime.item.started', message: 'command started',
  }, {
    type: 'item.started',
    item: {
      id: 'sparse-command-item', type: 'command_execution', command: "printf 'full-command'",
      cwd: workspaceRoot, status: 'in_progress',
    },
  }, attemptId, workspaceRoot);
  store.appendRuntimeWorklog('sparse-command-task', {
    turnId: turn.id, kind: 'runtime.item.completed', message: 'command completed',
  }, {
    type: 'item.completed',
    item: {
      id: 'sparse-command-item', type: 'command_execution',
      aggregated_output: 'full output\n', exit_code: 0, status: 'completed',
    },
  }, attemptId, workspaceRoot);

  const [execution] = store.listCommandExecutions('sparse-command-task');
  assert.equal(execution.command, "printf 'full-command'");
  assert.equal(execution.output, 'full output\n');
  assert.equal(execution.workingDirectory, workspaceRoot);
  assert.equal(execution.exitCode, 0);
  const fullResult = 'result-line\n'.repeat(500);
  store.finalizeSessionTurn({
    taskId: 'sparse-command-task', turnId: turn.id, attemptId,
    commandId: command.id, workerId: 'sparse-worker', exitCode: 0,
    summary: 'Sparse command audit completed.', resultText: fullResult,
    finalStatus: 'waiting_review', retryCount: 0,
  });
  assert.equal(store.getSession('sparse-command-task').summary, 'Sparse command audit completed.');
  assert.equal(store.listTurns('sparse-command-task')[0].result, fullResult);
});

test('expired leases close execution rows and stale workers cannot finalize a recovered task', () => {
  store.saveSession('ownership-task', {
    name: 'Ownership Task',
    objective: 'Verify strict worker ownership.',
    workingDir: '.',
    autoResume: false,
  });
  store.queueSessionRun('ownership-task', 'First turn', 'ownership-first');
  const [oldCommand] = store.claimPendingCommands('old-worker', 1);
  assert.ok(oldCommand);
  assert.equal(store.acquireTaskLease('ownership-task', 'old-worker'), true);
  const oldTurn = store.beginSessionTurn({
    taskId: 'ownership-task', commandId: oldCommand.id, workerId: 'old-worker',
    input: 'First turn', persistentSessionKey: 'single:ownership-task', skillSnapshotId: null,
  }).turn;
  const oldAttemptId = store.createAttempt('ownership-task', oldTurn.id, 1, 'old-worker');
  store.appendRuntimeWorklog('ownership-task', {
    turnId: oldTurn.id, kind: 'runtime.item.started', message: 'started',
  }, {
    type: 'item.started',
    item: { id: 'old-command-item', type: 'command_execution', command: 'printf old', status: 'in_progress' },
  }, oldAttemptId, workspaceRoot);
  const staleBackgroundBase = path.join(workspaceRoot, 'stale-owner-background');
  store.appendRuntimeWorklog('ownership-task', {
    turnId: oldTurn.id, kind: 'runtime.item.completed', message: 'background launched',
  }, {
    type: 'item.completed',
    item: {
      id: 'old-background-item', type: 'command_execution', status: 'completed', exit_code: 0,
      command: '/opt/platform/codex-skill-use run-in-background -- python3 -m pytest stale.py',
      aggregated_output: [
        'PID=999999999', `LOG=${staleBackgroundBase}.log`, `DONE=${staleBackgroundBase}.done`,
        `STATE=${staleBackgroundBase}.state`, `META=${staleBackgroundBase}.meta`,
      ].join('\n'),
    },
  }, oldAttemptId, workspaceRoot);

  const db = getDatabase();
  db.prepare("UPDATE tasks SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id='ownership-task'").run();
  const recovered = store.recoverExpiredTasks();
  assert.deepEqual(recovered, [{ id: 'ownership-task', resumed: false, status: 'interrupted' }]);
  assert.equal(db.prepare('SELECT status FROM attempts WHERE id=?').get(oldAttemptId).status, 'interrupted');
  assert.equal(db.prepare('SELECT status FROM turns WHERE id=?').get(oldTurn.id).status, 'interrupted');
  assert.equal(db.prepare("SELECT status FROM command_executions WHERE runtime_item_id='old-command-item'").get().status, 'interrupted');
  assert.equal(db.prepare('SELECT status FROM commands WHERE id=?').get(oldCommand.id).status, 'failed');

  store.queueSessionRun('ownership-task', 'Second turn', 'ownership-second');
  const [newCommand] = store.claimPendingCommands('new-worker', 1);
  assert.ok(newCommand);
  assert.equal(store.acquireTaskLease('ownership-task', 'new-worker'), true);
  const newTurn = store.beginSessionTurn({
    taskId: 'ownership-task', commandId: newCommand.id, workerId: 'new-worker',
    input: 'Second turn', persistentSessionKey: 'single:ownership-task', skillSnapshotId: null,
  }).turn;
  const newAttemptId = store.createAttempt('ownership-task', newTurn.id, 1, 'new-worker');

  assert.throws(() => store.finalizeSessionTurn({
    taskId: 'ownership-task', turnId: oldTurn.id, attemptId: oldAttemptId,
    commandId: oldCommand.id, workerId: 'old-worker', exitCode: 0,
    summary: 'stale result', finalStatus: 'waiting_review', retryCount: 0,
  }), (error) => error.statusCode === 409);
  assert.equal(store.getSession('ownership-task').leaseOwner, 'new-worker');
  assert.deepEqual(store.listExternalAttempts('ownership-task'), []);
  assert.deepEqual(store.listScheduledJobs('ownership-task'), []);
  assert.equal(store.listSessionWorklogs('ownership-task').some((event) => event.kind === 'external.attempt.registered'), false);

  const finalized = store.finalizeSessionTurn({
    taskId: 'ownership-task', turnId: newTurn.id, attemptId: newAttemptId,
    commandId: newCommand.id, workerId: 'new-worker', exitCode: 0,
    summary: 'current result', resultText: 'current result', finalStatus: 'waiting_review', retryCount: 0,
  });
  assert.equal(finalized.status, 'waiting_review');
});

test('a stop request after atomic attempt preparation cannot be overwritten by the starting worker', () => {
  store.saveSession('launch-stop-task', {
    name: 'Launch Stop Task', objective: 'Stop during launch.', workingDir: '.', autoResume: false,
  });
  store.queueSessionRun('launch-stop-task', 'Stop during launch.', 'launch-stop-command');
  const [command] = store.claimPendingCommands('launch-worker', 1);
  assert.equal(store.acquireTaskLease('launch-stop-task', 'launch-worker'), true);
  const started = store.beginSessionTurn({
    taskId: 'launch-stop-task', commandId: command.id, workerId: 'launch-worker',
    input: 'Stop during launch.', persistentSessionKey: 'single:launch-stop-task', skillSnapshotId: null,
    createInitialAttempt: true,
  });
  const turn = started.turn;
  assert.match(started.attemptId, /^attempt-/);
  assert.equal(store.requestSessionStop('launch-stop-task'), true);
  assert.throws(
    () => store.createAttempt('launch-stop-task', turn.id, 2, 'launch-worker'),
    (error) => error.statusCode === 409,
  );
  assert.equal(store.failClaimedCommand(command.id, 'launch-worker', new Error('launch cancelled')), true);
  assert.equal(store.getSession('launch-stop-task').status, 'stopped');
  const db = getDatabase();
  assert.equal(db.prepare('SELECT status FROM turns WHERE id=?').get(turn.id).status, 'stopped');
  assert.equal(db.prepare('SELECT status FROM attempts WHERE id=?').get(started.attemptId).status, 'cancelled');
  assert.equal(db.prepare('SELECT status FROM commands WHERE id=?').get(command.id).status, 'cancelled');
});

test('a start worklog failure releases the in-memory worker slot immediately', async () => {
  const taskId = 'start-worklog-failure-task';
  const workerId = 'start-worklog-worker';
  store.saveSession(taskId, {
    name: 'Start Worklog Failure', objective: 'Inject a persistence failure during startup.', workingDir: '.',
  });
  store.queueSessionRun(taskId, 'Start with an injected worklog failure.', 'start-worklog-failure-command');
  const command = store.claimPendingCommands(workerId, 1).find((candidate) => candidate.task_id === taskId);
  assert.ok(command);
  assert.equal(store.acquireTaskLease(taskId, workerId), true);
  const db = getDatabase();
  db.exec(`
    CREATE TRIGGER fail_injected_session_started_worklog
    BEFORE INSERT ON worklog_events
    WHEN NEW.task_id='${taskId}' AND NEW.kind='session.started'
    BEGIN
      SELECT RAISE(ABORT, 'injected session start worklog failure');
    END;
  `);
  try {
    await assert.rejects(
      startSession(command, workerId),
      /injected session start worklog failure/,
    );
    assert.equal(listActiveSessions().some((active) => active.id === taskId), false);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS fail_injected_session_started_worklog');
  }
  assert.equal(store.failClaimedCommand(command.id, workerId, new Error('injected startup persistence failure')), true);
  assert.equal(store.getSession(taskId).status, 'failed');
  assert.equal(store.listTurns(taskId)[0].status, 'failed');
  assert.equal(store.listAttempts(taskId)[0].status, 'failed');
  assert.equal(db.prepare('SELECT status FROM commands WHERE id=?').get(command.id).status, 'failed');
});

test('a stopped queued task cannot acquire a stale execution lease', () => {
  store.saveSession('queued-stop-lease', {
    name: 'Queued Stop Lease', objective: 'Reject stale lease acquisition.', workingDir: '.',
  });
  store.queueSessionRun('queued-stop-lease', 'Stop before lease.', 'queued-stop-lease-command');
  const [command] = store.claimPendingCommands('late-worker', 1);
  assert.ok(command);
  assert.equal(store.requestSessionStop('queued-stop-lease'), true);
  assert.equal(store.acquireTaskLease('queued-stop-lease', 'late-worker'), false);
  assert.equal(store.getSession('queued-stop-lease').leaseOwner, '');
});

test('automatic lease recovery stops after maxRetries is exhausted', () => {
  store.saveSession('recovery-limit-task', {
    name: 'Recovery Limit Task', objective: 'Bound automatic recovery.',
    workingDir: '.', autoResume: true, maxRetries: 1,
  });
  const db = getDatabase();
  const firstVersion = store.getSession('recovery-limit-task').version;
  db.prepare(`
    UPDATE tasks SET status='running', lease_owner='dead-one',
      lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id='recovery-limit-task'
  `).run();
  assert.deepEqual(store.recoverExpiredTasks(), [{ id: 'recovery-limit-task', resumed: true, status: 'queued' }]);
  assert.equal(store.getSession('recovery-limit-task').recoveryCount, 1);
  assert.ok(store.getSession('recovery-limit-task').version > firstVersion);

  db.exec(`
    UPDATE commands SET status='failed' WHERE task_id='recovery-limit-task' AND status='pending';
    UPDATE tasks SET status='running', lease_owner='dead-two',
      lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id='recovery-limit-task';
  `);
  assert.deepEqual(store.recoverExpiredTasks(), [{ id: 'recovery-limit-task', resumed: false, status: 'interrupted' }]);
  const exhausted = store.getSession('recovery-limit-task');
  assert.equal(exhausted.recoveryCount, 1);
  assert.equal(exhausted.recoveryState, 'retry_exhausted');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM commands WHERE task_id='recovery-limit-task' AND type='recovery'").get().count, 1);
});

test('a stopping task recovered after lease expiry records its terminal event', () => {
  store.saveSession('stopping-recovery-task', {
    name: 'Stopping Recovery Task', objective: 'Record the recovered stop.', workingDir: '.',
  });
  const db = getDatabase();
  const initialVersion = store.getSession('stopping-recovery-task').version;
  db.prepare(`
    UPDATE tasks SET status='stopping', lease_owner='gone-worker', cancel_requested=1,
      lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id='stopping-recovery-task'
  `).run();
  assert.deepEqual(store.recoverExpiredTasks(), [{ id: 'stopping-recovery-task', resumed: false, status: 'stopped' }]);
  const recovered = store.getSession('stopping-recovery-task');
  assert.equal(recovered.status, 'stopped');
  assert.ok(recovered.version > initialVersion);
  assert.ok(store.listSessionWorklogs('stopping-recovery-task').some((event) => event.kind === 'session.stopped'));
});

test('terminal artifacts cannot finish a task while its verified background process group is alive', async () => {
  const taskId = 'terminal-artifacts-live-runtime-task';
  const taskBase = path.join(workspaceRoot, 'terminal-artifacts-live-runtime');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  try {
    store.saveSession(taskId, {
      name: 'Terminal artifacts with live runtime',
      objective: 'Keep the task active until its background process exits.',
      workingDir: '.',
    });
    const external = store.registerExternalAttempt({
      taskId,
      pid: child.pid,
      logPath: `${taskBase}.log`,
      donePath: `${taskBase}.done`,
      statePath: `${taskBase}.state`,
      metaPath: `${taskBase}.meta`,
      checkIntervalSeconds: 5,
    });
    fs.writeFileSync(`${taskBase}.done`, '0\n', 'utf8');
    fs.writeFileSync(`${taskBase}.state`, 'finished\n', 'utf8');
    fs.writeFileSync(`${taskBase}.meta`, `ended_at=${new Date().toISOString()}\nexit_code=0\n`, 'utf8');

    store.reconcileExternalAttempts(taskId);
    const running = store.getExternalAttempt(taskId, external.id);
    assert.equal(running.status, 'running');
    assert.equal(running.result.runtimeActive, true);
    assert.equal(running.result.terminalEvidencePending, true);

    process.kill(-child.pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 50));
    store.reconcileExternalAttempts(taskId);
    assert.equal(store.getExternalAttempt(taskId, external.id).status, 'succeeded');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});

test('stopping a scheduled task terminates its tracked background process group', async () => {
  const taskId = 'stop-tracked-background-task';
  const taskBase = path.join(workspaceRoot, 'stop-tracked-background');
  const child = spawn(process.execPath, ['-e', [
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n')], { detached: true, stdio: 'ignore' });
  child.unref();
  try {
    store.saveSession(taskId, {
      name: 'Stop tracked background task', objective: 'Stop the detached process.', workingDir: '.',
    });
    const external = store.registerExternalAttempt({
      taskId,
      pid: child.pid,
      logPath: `${taskBase}.log`,
      donePath: `${taskBase}.done`,
      statePath: `${taskBase}.state`,
      metaPath: `${taskBase}.meta`,
    });
    assert.match(external.pidStartTicks, /^\d+$/);
    assert.equal(external.processGroupId, child.pid);
    getDatabase().prepare(`
      UPDATE tasks SET status='waiting_scheduled', recovery_state='waiting_scheduled'
      WHERE id=?
    `).run(taskId);

    assert.equal(store.requestSessionStop(taskId), true);
    assert.equal(store.getSession(taskId).status, 'stopping');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    assert.equal(store.getSession(taskId).status, 'stopped');
    const worklogs = store.listSessionWorklogs(taskId);
    assert.ok(worklogs.some((entry) => entry.kind === 'external.attempt.stop.signalled'));
    assert.ok(worklogs.some((entry) => entry.kind === 'external.attempt.stop.forced'));
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});

test('repeating stop cleans a residual process group from an already stopped task', async () => {
  const taskId = 'retry-stop-residual-background-task';
  const taskBase = path.join(workspaceRoot, 'retry-stop-residual-background');
  const child = spawn(process.execPath, ['-e', [
    "process.on('SIGTERM', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n')], { detached: true, stdio: 'ignore' });
  child.unref();
  try {
    store.saveSession(taskId, {
      name: 'Retry residual cleanup', objective: 'Stop the leftover detached process.', workingDir: '.',
    });
    const external = store.registerExternalAttempt({
      taskId,
      pid: child.pid,
      logPath: `${taskBase}.log`,
      donePath: `${taskBase}.done`,
      statePath: `${taskBase}.state`,
      metaPath: `${taskBase}.meta`,
    });
    getDatabase().prepare(`
      UPDATE tasks SET status='stopped', recovery_state='stopped' WHERE id=?
    `).run(taskId);
    getDatabase().prepare(`
      UPDATE external_attempts SET status='cancelled' WHERE id=?
    `).run(external.id);

    assert.equal(store.requestSessionStop(taskId), true);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    const worklogs = store.listSessionWorklogs(taskId);
    assert.ok(worklogs.some((entry) => entry.kind === 'session.stop.residual_cleanup'));
    assert.ok(worklogs.some((entry) => entry.kind === 'external.attempt.stop.forced'));
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
});

test('durable background checks release Codex, recover scheduler leases, and resume the same task', () => {
  const taskId = 'durable-background-task';
  const firstWorker = 'background-launch-worker';
  const schedulerWorker = 'background-scheduler-worker';
  const followUpWorker = 'background-follow-up-worker';
  const taskBase = path.join(workspaceRoot, 'durable-background');
  const backgroundCommand = "python3 -m pytest -v converter/test_smoke.py -k test_smoke_converter_single_01";
  fs.writeFileSync(`${taskBase}.log`, '[START]\n', 'utf8');
  fs.writeFileSync(`${taskBase}.cmd`, `${backgroundCommand}\n`, 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'running\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, JSON.stringify({ started_at: new Date().toISOString() }), 'utf8');

  store.saveSession(taskId, {
    name: 'Durable Background Task', objective: 'Track a detached business execution.', workingDir: '.',
  });
  store.queueSessionRun(taskId, 'Launch detached work.', 'durable-background-launch');
  const launchCommand = store.claimPendingCommands(firstWorker, 10).find((command) => command.task_id === taskId);
  assert.ok(launchCommand);
  assert.equal(store.acquireTaskLease(taskId, firstWorker), true);
  const launchTurn = store.beginSessionTurn({
    taskId, commandId: launchCommand.id, workerId: firstWorker, input: launchCommand.input,
    persistentSessionKey: `single:${taskId}`, skillSnapshotId: null,
  }).turn;
  const launchAttemptId = store.createAttempt(taskId, launchTurn.id, 1, firstWorker);
  const external = store.registerExternalAttempt({
    taskId,
    turnId: launchTurn.id,
    attemptId: launchAttemptId,
    pid: null,
    logPath: `${taskBase}.log`,
    donePath: `${taskBase}.done`,
    statePath: `${taskBase}.state`,
    metaPath: `${taskBase}.meta`,
    label: 'converter smoke',
    dueAt: '2000-01-01T00:00:00.000Z',
    checkIntervalSeconds: 5,
  });
  assert.equal(external.commandPath, `${taskBase}.cmd`);
  assert.equal(external.command, `${backgroundCommand}\n`);
  assert.equal(store.listExternalAttempts(taskId)[0].command, `${backgroundCommand}\n`);
  const waiting = store.finalizeSessionTurn({
    taskId, turnId: launchTurn.id, attemptId: launchAttemptId,
    commandId: launchCommand.id, workerId: firstWorker, exitCode: 0,
    summary: 'Detached execution launched.', resultText: 'PID and log returned.',
    finalStatus: 'waiting_review', retryCount: 0,
  });
  assert.equal(waiting.status, 'waiting_scheduled');
  assert.equal(waiting.activeExternalAttempts, 1);
  assert.equal(waiting.activeScheduledJobs, 1);
  assert.throws(() => store.completeSession(taskId), (error) => error.statusCode === 409);

  const [staleLease] = store.claimDueScheduledJobs('stale-scheduler', 1);
  assert.equal(staleLease.externalAttemptId, external.id);
  getDatabase().prepare("UPDATE scheduled_jobs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?")
    .run(staleLease.id);
  const [recoveredLease] = store.claimDueScheduledJobs(schedulerWorker, 1);
  assert.equal(recoveredLease.id, staleLease.id);
  const dispatched = store.dispatchClaimedScheduledJob(recoveredLease.id, schedulerWorker);
  assert.equal(dispatched.status, 'dispatched');
  assert.equal(store.getSession(taskId).status, 'queued');

  const followUpCommand = store.claimPendingCommands(followUpWorker, 10).find((command) => command.task_id === taskId);
  assert.ok(followUpCommand);
  assert.equal(followUpCommand.type, 'scheduled');
  assert.match(followUpCommand.input, new RegExp(external.id));
  assert.equal(store.acquireTaskLease(taskId, followUpWorker), true);
  const followUpTurn = store.beginSessionTurn({
    taskId, commandId: followUpCommand.id, workerId: followUpWorker, input: followUpCommand.input,
    persistentSessionKey: `single:${taskId}`, skillSnapshotId: null,
  }).turn;
  const followUpAttemptId = store.createAttempt(taskId, followUpTurn.id, 1, followUpWorker);
  assert.throws(() => store.registerExternalAttempt({
    taskId,
    turnId: followUpTurn.id,
    attemptId: followUpAttemptId,
    pid: null,
    logPath: `${taskBase}.log`,
    donePath: `${taskBase}.done`,
    statePath: `${taskBase}.state`,
    metaPath: `${taskBase}.meta`,
    label: 'converter smoke rerun',
  }), (error) => error.statusCode === 409 && /active background generation/i.test(error.message));
  const terminalAt = new Date().toISOString();
  fs.writeFileSync(`${taskBase}.meta`, [
    `started_at=${external.startedAt}`,
    `ended_at=${terminalAt}`,
    'exit_code=0',
    'end_signal=EXIT',
    '',
  ].join('\n'), 'utf8');
  const reviewed = store.finalizeSessionTurn({
    taskId, turnId: followUpTurn.id, attemptId: followUpAttemptId,
    commandId: followUpCommand.id, workerId: followUpWorker, exitCode: 0,
    summary: 'Detached execution succeeded.', resultText: 'DONE=0',
    finalStatus: 'waiting_review', retryCount: 0,
  });
  assert.equal(reviewed.status, 'waiting_review');
  assert.equal(reviewed.activeExternalAttempts, 0);
  assert.equal(reviewed.activeScheduledJobs, 0);
  assert.equal(store.listExternalAttempts(taskId)[0].status, 'succeeded');
  assert.equal(store.listExternalAttempts(taskId)[0].result.exitCode, 0);
  assert.equal(store.listScheduledJobs(taskId)[0].status, 'completed');
  assert.equal(store.listTurns(taskId).length, 2);
  assert.equal(store.completeSession(taskId).status, 'completed');

  const kinds = store.listSessionWorklogs(taskId).map((event) => event.kind);
  for (const kind of [
    'external.attempt.registered', 'schedule.created', 'session.waiting_scheduled',
    'schedule.dispatched', 'external.attempt.succeeded', 'schedule.completed',
  ]) assert.ok(kinds.includes(kind), `missing worklog event ${kind}`);
});

test('fast converter failures keep and enrich the scheduled result collection', () => {
  const taskId = 'fast-terminal-converter-task';
  const workerId = 'fast-terminal-launch-worker';
  const schedulerWorker = 'fast-terminal-scheduler-worker';
  const taskBase = path.join(workspaceRoot, 'fast-terminal-converter');
  fs.writeFileSync(`${taskBase}.log`, '[START]\nFAILED converter/test_smoke.py::test_case\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'running\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, '{}\n', 'utf8');

  store.saveSession(taskId, {
    name: 'Fast Terminal Converter', objective: 'Collect a fast converter failure.', workingDir: '.',
  });
  store.queueSessionRun(taskId, 'Launch converter smoke.', 'fast-terminal-launch');
  const command = store.claimPendingCommands(workerId, 10).find((item) => item.task_id === taskId);
  assert.ok(command);
  assert.equal(store.acquireTaskLease(taskId, workerId), true);
  const turn = store.beginSessionTurn({
    taskId, commandId: command.id, workerId, input: command.input,
    persistentSessionKey: `single:${taskId}`, skillSnapshotId: null,
  }).turn;
  const attemptId = store.createAttempt(taskId, turn.id, 1, workerId);
  store.appendRuntimeWorklog(taskId, {
    turnId: turn.id, kind: 'runtime.item.completed', message: 'converter smoke launched',
  }, {
    type: 'item.completed',
    item: {
      id: 'fast-terminal-launch-item', type: 'command_execution', status: 'completed', exit_code: 0,
      command: 'codex-skill-use converter-test run-in-background -- bash launch_converter_smoke.sh',
      aggregated_output: [
        'PID=999999994', `LOG=${taskBase}.log`, `DONE=${taskBase}.done`,
        `STATE=${taskBase}.state`, `META=${taskBase}.meta`,
      ].join('\n'),
    },
  }, attemptId, workspaceRoot);
  const external = store.registerExternalAttempt({
    taskId, turnId: turn.id, attemptId, pid: 999999994,
    logPath: `${taskBase}.log`, donePath: `${taskBase}.done`,
    statePath: `${taskBase}.state`, metaPath: `${taskBase}.meta`,
    stepKey: 'converter-smoke', stepLabel: 'Converter smoke',
    runKey: 'initial', runKind: 'initial',
    dueAt: '2100-01-01T00:00:00.000Z', checkIntervalSeconds: 300,
  });
  fs.writeFileSync(`${taskBase}.done`, '1\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'finished\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, [
    `started_at=${external.startedAt}`,
    `ended_at=${new Date().toISOString()}`,
    'exit_code=1',
    '',
  ].join('\n'), 'utf8');

  const waiting = store.finalizeSessionTurn({
    taskId, turnId: turn.id, attemptId, commandId: command.id, workerId, exitCode: 0,
    summary: 'Converter smoke launched.', finalStatus: 'waiting_review', retryCount: 0,
  });
  assert.equal(waiting.status, 'waiting_scheduled');
  assert.equal(waiting.activeExternalAttempts, 0);
  assert.equal(waiting.activeScheduledJobs, 1);
  assert.equal(store.getExternalAttempt(taskId, external.id).status, 'failed');
  const [scheduled] = store.listScheduledJobs(taskId);
  assert.equal(scheduled.status, 'pending');
  assert.ok(Date.parse(scheduled.dueAt) <= Date.now());
  assert.match(scheduled.payload.prompt, /analyze-failures/);

  const [claimed] = store.claimDueScheduledJobs(schedulerWorker, 1);
  assert.equal(claimed.id, scheduled.id);
  store.dispatchClaimedScheduledJob(claimed.id, schedulerWorker);
  const [followUp] = store.claimPendingCommands('fast-terminal-follow-up-worker', 1);
  assert.match(followUp.input, /analyze-failures/);
  assert.equal(store.requestSessionStop(taskId), true);
  assert.equal(store.getSession(taskId).status, 'stopped');
});

test('a terminal transition during a scheduled Turn keeps one future result collection', () => {
  const taskId = 'terminal-during-scheduled-turn-task';
  const launchWorker = 'terminal-race-launch-worker';
  const schedulerWorker = 'terminal-race-scheduler-worker';
  const followUpWorker = 'terminal-race-follow-up-worker';
  const taskBase = path.join(workspaceRoot, 'terminal-during-scheduled-turn');
  fs.writeFileSync(`${taskBase}.log`, '[START]\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'running\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, '{}\n', 'utf8');

  store.saveSession(taskId, {
    name: 'Terminal during scheduled Turn',
    objective: 'Preserve terminal result collection after a stale running observation.',
    workingDir: '.',
  });
  store.queueSessionRun(taskId, 'Launch detached work.', 'terminal-race-launch');
  const launchCommand = store.claimPendingCommands(launchWorker, 10)
    .find((command) => command.task_id === taskId);
  assert.ok(launchCommand);
  assert.equal(store.acquireTaskLease(taskId, launchWorker), true);
  const launchTurn = store.beginSessionTurn({
    taskId, commandId: launchCommand.id, workerId: launchWorker, input: launchCommand.input,
    persistentSessionKey: `single:${taskId}`, skillSnapshotId: null,
  }).turn;
  const launchAttemptId = store.createAttempt(taskId, launchTurn.id, 1, launchWorker);
  const external = store.registerExternalAttempt({
    taskId, turnId: launchTurn.id, attemptId: launchAttemptId, pid: null,
    logPath: `${taskBase}.log`, donePath: `${taskBase}.done`,
    statePath: `${taskBase}.state`, metaPath: `${taskBase}.meta`,
    label: 'terminal race', dueAt: '2000-01-01T00:00:00.000Z', checkIntervalSeconds: 5,
  });
  assert.equal(store.finalizeSessionTurn({
    taskId, turnId: launchTurn.id, attemptId: launchAttemptId,
    commandId: launchCommand.id, workerId: launchWorker, exitCode: 0,
    summary: 'Detached execution launched.', finalStatus: 'waiting_review', retryCount: 0,
  }).status, 'waiting_scheduled');

  const [claimed] = store.claimDueScheduledJobs(schedulerWorker, 1);
  store.dispatchClaimedScheduledJob(claimed.id, schedulerWorker);
  const followUpCommand = store.claimPendingCommands(followUpWorker, 10)
    .find((command) => command.task_id === taskId);
  assert.ok(followUpCommand);
  assert.equal(store.acquireTaskLease(taskId, followUpWorker), true);
  const followUpTurn = store.beginSessionTurn({
    taskId, commandId: followUpCommand.id, workerId: followUpWorker, input: followUpCommand.input,
    persistentSessionKey: `single:${taskId}`, skillSnapshotId: null,
  }).turn;
  const followUpAttemptId = store.createAttempt(taskId, followUpTurn.id, 1, followUpWorker);

  fs.writeFileSync(`${taskBase}.done`, '1\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'finished\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, [
    `started_at=${external.startedAt}`,
    `ended_at=${new Date().toISOString()}`,
    'exit_code=1',
    '',
  ].join('\n'), 'utf8');
  const reconciled = store.reconcileRunningExternalAttempts()
    .find((result) => result.id === external.id);
  assert.equal(reconciled.status, 'failed');
  const schedulesDuringTurn = store.listScheduledJobs(taskId);
  assert.equal(schedulesDuringTurn.filter((job) => job.status === 'dispatched').length, 1);
  assert.equal(schedulesDuringTurn.filter((job) => job.status === 'pending').length, 1);

  const waiting = store.finalizeSessionTurn({
    taskId, turnId: followUpTurn.id, attemptId: followUpAttemptId,
    commandId: followUpCommand.id, workerId: followUpWorker, exitCode: 0,
    summary: 'Background execution still appears to be running.',
    resultText: 'Stale running observation.',
    finalStatus: 'waiting_review', retryCount: 0,
  });
  assert.equal(waiting.status, 'waiting_scheduled');
  assert.equal(waiting.activeExternalAttempts, 0);
  assert.equal(waiting.activeScheduledJobs, 1);
  const next = store.listScheduledJobs(taskId).find((job) => job.status === 'pending');
  assert.ok(next);
  assert.ok(Date.parse(next.dueAt) <= Date.now());
  assert.equal(store.requestSessionStop(taskId), true);
});

test('reused background paths ignore stale terminal files until the new generation writes evidence', () => {
  const taskId = 'background-evidence-generation-task';
  const taskBase = path.join(workspaceRoot, 'reused-background-evidence');
  const staleTime = new Date('2000-01-01T00:00:00.000Z');
  fs.writeFileSync(`${taskBase}.log`, '[START]\n', 'utf8');
  fs.writeFileSync(`${taskBase}.done`, '0\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'finished\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, 'ended_at=2000-01-01T00:00:00Z\nexit_code=0\n', 'utf8');
  for (const suffix of ['.done', '.state', '.meta']) fs.utimesSync(`${taskBase}${suffix}`, staleTime, staleTime);
  store.saveSession(taskId, {
    name: 'Background Evidence Generation', objective: 'Reject stale terminal evidence.', workingDir: '.',
  });
  const first = store.registerExternalAttempt({
    taskId,
    pid: null,
    logPath: `${taskBase}.log`,
    donePath: `${taskBase}.done`,
    statePath: `${taskBase}.state`,
    metaPath: `${taskBase}.meta`,
    startedAt: '1999-12-31T23:59:00.000Z',
  });
  store.reconcileExternalAttempts(taskId);
  assert.equal(store.getExternalAttempt(taskId, first.id).status, 'succeeded');

  const second = store.registerExternalAttempt({
    taskId,
    pid: null,
    logPath: `${taskBase}.log`,
    donePath: `${taskBase}.done`,
    statePath: `${taskBase}.state`,
    metaPath: `${taskBase}.meta`,
  });
  assert.equal(second.generation, 2);
  store.reconcileExternalAttempts(taskId);
  const ignored = store.getExternalAttempt(taskId, second.id);
  assert.equal(ignored.status, 'running');
  assert.deepEqual(ignored.result.ignoredStaleArtifacts, ['done', 'state', 'meta']);
  assert.match(ignored.lastObservation, /stale_ignored=done,state,meta/);

  const freshTime = new Date(Date.now() + 2000);
  fs.writeFileSync(`${taskBase}.done`, '0\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'finished\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, `ended_at=${new Date().toISOString()}\nexit_code=0\n`, 'utf8');
  for (const suffix of ['.done', '.state', '.meta']) fs.utimesSync(`${taskBase}${suffix}`, freshTime, freshTime);
  store.reconcileExternalAttempts(taskId);
  const completed = store.getExternalAttempt(taskId, second.id);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.exitCode, 0);
  assert.deepEqual(completed.result.ignoredStaleArtifacts, []);
});

test('result collection reuses a terminal background tracker for unchanged process evidence', () => {
  const taskId = 'background-result-collection-idempotency-task';
  const taskBase = path.join(workspaceRoot, 'background-result-collection-idempotency');
  fs.writeFileSync(`${taskBase}.log`, '1 failed\n', 'utf8');
  fs.writeFileSync(`${taskBase}.done`, '1\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'finished\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, 'ended_at=2000-01-01T00:00:01Z\nexit_code=1\n', 'utf8');
  const terminalTime = new Date('2000-01-01T00:00:01.000Z');
  for (const suffix of ['.done', '.state', '.meta']) {
    fs.utimesSync(`${taskBase}${suffix}`, terminalTime, terminalTime);
  }
  store.saveSession(taskId, {
    name: 'Background result collection idempotency',
    objective: 'Do not register collected terminal evidence as a rerun.',
    workingDir: '.',
  });
  const first = store.registerExternalAttempt({
    taskId,
    pid: 999999986,
    logPath: `${taskBase}.log`,
    donePath: `${taskBase}.done`,
    statePath: `${taskBase}.state`,
    metaPath: `${taskBase}.meta`,
    startedAt: '2000-01-01T00:00:00.000Z',
  });
  store.reconcileExternalAttempts(taskId);
  assert.equal(store.getExternalAttempt(taskId, first.id).status, 'failed');

  store.queueSessionRun(taskId, 'Collect the finished result.', 'result-collection-idempotency');
  const workerId = 'result-collection-idempotency-worker';
  const command = store.claimPendingCommands(workerId, 10).find((candidate) => candidate.task_id === taskId);
  assert.ok(command);
  assert.equal(store.acquireTaskLease(taskId, workerId), true);
  const turn = store.beginSessionTurn({
    taskId,
    commandId: command.id,
    workerId,
    input: command.input,
    persistentSessionKey: `single:${taskId}`,
    skillSnapshotId: null,
  }).turn;
  const attemptId = store.createAttempt(taskId, turn.id, 1, workerId);
  const repeated = store.registerExternalAttempt({
    taskId,
    turnId: turn.id,
    attemptId,
    pid: 999999986,
    logPath: `${taskBase}.log`,
    donePath: `${taskBase}.done`,
    statePath: `${taskBase}.state`,
    metaPath: `${taskBase}.meta`,
  });

  assert.equal(repeated.id, first.id);
  assert.equal(repeated.generation, 1);
  assert.equal(store.listExternalAttempts(taskId).length, 1);
  assert.equal(store.requestSessionStop(taskId), true);
  const stopped = store.finalizeSessionTurn({
    taskId,
    turnId: turn.id,
    attemptId,
    commandId: command.id,
    workerId,
    exitCode: 130,
    summary: 'Stopped after idempotent registration verification.',
    finalStatus: 'stopped',
    retryCount: 0,
  });
  assert.equal(stopped.status, 'stopped');
});

test('background evidence freshness survives a new service process', () => {
  const recoveryRoot = path.join(tempDir, 'background-evidence-restart');
  const recoveryData = path.join(recoveryRoot, 'data');
  const recoveryRuntime = path.join(recoveryRoot, 'runtime');
  const recoveryWorkspace = path.join(recoveryRoot, 'workspace');
  const taskBase = path.join(recoveryWorkspace, 'restart-evidence');
  for (const directory of [recoveryData, recoveryRuntime, recoveryWorkspace]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(`${taskBase}.log`, '[START]\n', 'utf8');
  fs.writeFileSync(`${taskBase}.done`, '0\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'finished\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, 'ended_at=2000-01-01T00:00:00Z\nexit_code=0\n', 'utf8');
  const staleTime = new Date('2000-01-01T00:00:00.000Z');
  for (const suffix of ['.done', '.state', '.meta']) fs.utimesSync(`${taskBase}${suffix}`, staleTime, staleTime);
  const environment = {
    ...process.env,
    CODEX_DESK_DATA_DIR: recoveryData,
    CODEX_DESK_RUNTIME_DIR: recoveryRuntime,
    CODEX_TASK_WORKSPACE_ROOTS: recoveryWorkspace,
    SOURCE_CODEX_HOME: path.join(recoveryRoot, 'codex-home'),
    WORKSPACE_CODEX_SKILLS_DIR: path.join(recoveryRoot, 'workspace-skills'),
  };
  const prepare = spawnSync(process.execPath, ['-e', [
    "const store = require('./src/store');",
    `const taskBase = ${JSON.stringify(taskBase)};`,
    "store.saveSession('restart-evidence-task', { name: 'Restart Evidence', objective: 'Persist freshness.', workingDir: '.' });",
    "const first = store.registerExternalAttempt({ taskId: 'restart-evidence-task', pid: null, logPath: taskBase + '.log', donePath: taskBase + '.done', statePath: taskBase + '.state', metaPath: taskBase + '.meta', startedAt: '1999-12-31T23:59:00.000Z' });",
    "store.reconcileExternalAttempts('restart-evidence-task');",
    "if (store.getExternalAttempt('restart-evidence-task', first.id).status !== 'succeeded') process.exit(2);",
    "const second = store.registerExternalAttempt({ taskId: 'restart-evidence-task', pid: null, logPath: taskBase + '.log', donePath: taskBase + '.done', statePath: taskBase + '.state', metaPath: taskBase + '.meta' });",
    "process.stdout.write(second.id);",
  ].join('\n')], { cwd: ROOT_DIR, env: environment, encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stderr);
  const secondId = prepare.stdout.trim();
  assert.match(secondId, /^external-/);

  const recovered = spawnSync(process.execPath, ['-e', [
    "const store = require('./src/store');",
    `const secondId = ${JSON.stringify(secondId)};`,
    "store.reconcileExternalAttempts('restart-evidence-task');",
    "process.stdout.write(JSON.stringify(store.getExternalAttempt('restart-evidence-task', secondId)));",
  ].join('\n')], { cwd: ROOT_DIR, env: environment, encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr);
  const attempt = JSON.parse(recovered.stdout);
  assert.equal(attempt.status, 'running');
  assert.equal(attempt.generation, 2);
  assert.deepEqual(attempt.result.ignoredStaleArtifacts, ['done', 'state', 'meta']);
});

test('background auto-detection refines the evidence start and rejects a second launcher', () => {
  const taskId = 'background-launch-identity-task';
  const workerId = 'background-launch-identity-worker';
  const taskBase = path.join(workspaceRoot, 'background-launch-identity');
  fs.writeFileSync(`${taskBase}.log`, '[START]\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'running\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, '{}\n', 'utf8');

  store.saveSession(taskId, {
    name: 'Background Launch Identity', objective: 'Bind evidence to one launch command.', workingDir: '.',
  });
  store.queueSessionRun(taskId, 'Launch detached work.', 'background-launch-identity');
  const command = store.claimPendingCommands(workerId, 10).find((candidate) => candidate.task_id === taskId);
  assert.ok(command);
  assert.equal(store.acquireTaskLease(taskId, workerId), true);
  const turn = store.beginSessionTurn({
    taskId, commandId: command.id, workerId, input: command.input,
    persistentSessionKey: `single:${taskId}`, skillSnapshotId: null,
  }).turn;
  const attemptId = store.createAttempt(taskId, turn.id, 1, workerId);
  const oldAttemptStart = '2000-01-01T00:00:00.000Z';
  getDatabase().prepare('UPDATE attempts SET started_at=? WHERE id=?').run(oldAttemptStart, attemptId);

  const launchStartedAt = '2026-08-03T04:00:00.000Z';
  store.appendRuntimeWorklog(taskId, {
    turnId: turn.id, kind: 'runtime.item.completed', message: 'detached launch completed', ts: launchStartedAt,
  }, {
    type: 'item.completed',
    item: {
      id: 'launch-one', type: 'command_execution', status: 'completed', exit_code: 0,
      started_at: launchStartedAt,
      command: 'codex-skill-use run-in-background -- bash launch.sh',
      aggregated_output: [
        'PID=999999998', `LOG=${taskBase}.log`, `DONE=${taskBase}.done`,
        `STATE=${taskBase}.state`, `META=${taskBase}.meta`,
      ].join('\n'),
    },
  }, attemptId, workspaceRoot);

  const registered = store.registerExternalAttempt({
    taskId, turnId: turn.id, attemptId, pid: 999999998,
    logPath: `${taskBase}.log`, statePath: `${taskBase}.state`, metaPath: `${taskBase}.meta`,
    stepKey: 'detached-work', stepLabel: 'Detached work',
    runKey: 'initial', runKind: 'initial',
  });
  assert.equal(registered.startedAt, oldAttemptStart);
  const [detected] = store.detectExternalAttemptsForTurn(taskId, turn.id, attemptId);
  const refined = store.getExternalAttempt(taskId, registered.id);
  assert.equal(detected.id, registered.id);
  assert.equal(refined.startedAt, launchStartedAt);
  assert.equal(refined.sourceCommandExecutionId, store.listCommandExecutions(taskId)[0].id);

  store.appendRuntimeWorklog(taskId, {
    turnId: turn.id, kind: 'runtime.item.completed', message: 'second detached launch completed',
    ts: '2026-08-03T04:01:00.000Z',
  }, {
    type: 'item.completed',
    item: {
      id: 'launch-two', type: 'command_execution', status: 'completed', exit_code: 0,
      started_at: '2026-08-03T04:01:00.000Z',
      command: 'codex-skill-use run-in-background -- bash launch-again.sh',
      aggregated_output: [
        'PID=999999997', `LOG=${taskBase}.log`, `DONE=${taskBase}.done`,
        `STATE=${taskBase}.state`, `META=${taskBase}.meta`,
      ].join('\n'),
    },
  }, attemptId, workspaceRoot);
  store.detectExternalAttemptsForTurn(taskId, turn.id, attemptId);
  assert.equal(store.getExternalAttempt(taskId, registered.id).sourceCommandExecutionId, refined.sourceCommandExecutionId);
  assert.ok(store.listSessionWorklogs(taskId).some((entry) => (
    entry.kind === 'external.attempt.registration_missing'
    && entry.payload.commandExecutionId
  )));
  assert.equal(store.requestSessionStop(taskId), true);
  const stopped = store.finalizeSessionTurn({
    taskId, turnId: turn.id, attemptId, commandId: command.id, workerId, exitCode: 130,
    summary: 'Stopped after launch identity verification.', finalStatus: 'stopped', retryCount: 0,
  });
  assert.equal(stopped.status, 'stopped');
});

test('background auto-detection ignores Skill documentation placeholders and repairs legacy false positives', () => {
  const taskId = 'background-placeholder-detection-task';
  const workerId = 'background-placeholder-detection-worker';
  store.saveSession(taskId, {
    name: 'Background Placeholder Detection',
    objective: 'Do not track launch examples as real processes.',
    workingDir: '.',
  });
  store.queueSessionRun(taskId, 'Read the background Skill documentation.', 'background-placeholder-detection');
  const command = store.claimPendingCommands(workerId, 10).find((candidate) => candidate.task_id === taskId);
  assert.ok(command);
  assert.equal(store.acquireTaskLease(taskId, workerId), true);
  const turn = store.beginSessionTurn({
    taskId, commandId: command.id, workerId, input: command.input,
    persistentSessionKey: `single:${taskId}`, skillSnapshotId: null,
  }).turn;
  const attemptId = store.createAttempt(taskId, turn.id, 1, workerId);
  store.appendRuntimeWorklog(taskId, {
    turnId: turn.id, kind: 'runtime.item.completed', message: 'Skill documentation read',
  }, {
    type: 'item.completed',
    item: {
      id: 'placeholder-doc-item', type: 'command_execution', status: 'completed', exit_code: 0,
      command: 'codex-skill-use run-in-background -- cat run-in-background/SKILL.md',
      aggregated_output: [
        'Example output:', 'PID=12345', 'LOG=<LOG>', 'DONE=<DONE>', 'STATE=<STATE>', 'META=<META>',
      ].join('\n'),
    },
  }, attemptId, workspaceRoot);

  const reviewed = store.finalizeSessionTurn({
    taskId, turnId: turn.id, attemptId, commandId: command.id, workerId, exitCode: 0,
    summary: 'Documentation reviewed.', finalStatus: 'waiting_review', retryCount: 0,
  });
  assert.equal(reviewed.status, 'waiting_review');
  assert.deepEqual(store.listExternalAttempts(taskId), []);
  assert.deepEqual(store.listScheduledJobs(taskId), []);

  const [sourceExecution] = store.listCommandExecutions(taskId);
  store.registerExternalAttempt({
    taskId, turnId: turn.id, attemptId, sourceCommandExecutionId: sourceExecution.id,
    workingDirectory: workspaceRoot, pid: 12345,
    logPath: '<LOG>', donePath: '<DONE>', statePath: '<STATE>', metaPath: '<META>',
  });
  assert.equal(store.repairPlaceholderExternalAttemptDetections(), 1);
  assert.deepEqual(store.listExternalAttempts(taskId), []);
  assert.deepEqual(store.listScheduledJobs(taskId), []);
  assert.ok(store.listSessionWorklogs(taskId).some((event) => (
    event.kind === 'external.attempt.false_positive.removed'
    && event.payload.commandExecutionId === sourceExecution.id
  )));
});

test('explicit converter background registration is linked and operator stop cancels a dispatched check', () => {
  const taskId = 'auto-detected-background-task';
  const launchWorker = 'auto-detect-launch-worker';
  const schedulerWorker = 'auto-detect-scheduler-worker';
  const followUpWorker = 'auto-detect-follow-up-worker';
  const taskBase = path.join(workspaceRoot, 'converter_stress_frequency');
  fs.writeFileSync(`${taskBase}.log`, '[START]\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'running\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, '{}', 'utf8');

  store.saveSession(taskId, {
    name: 'Auto Detected Background Task', objective: 'Track converter stress output.', workingDir: '.',
  });
  store.queueSessionRun(taskId, 'Launch converter stress.', 'auto-detect-launch');
  const launchCommand = store.claimPendingCommands(launchWorker, 10).find((command) => command.task_id === taskId);
  assert.ok(launchCommand);
  assert.equal(store.acquireTaskLease(taskId, launchWorker), true);
  const launchTurn = store.beginSessionTurn({
    taskId, commandId: launchCommand.id, workerId: launchWorker, input: launchCommand.input,
    persistentSessionKey: `single:${taskId}`, skillSnapshotId: null,
  }).turn;
  const launchAttemptId = store.createAttempt(taskId, launchTurn.id, 1, launchWorker);
  store.appendRuntimeWorklog(taskId, {
    turnId: launchTurn.id, kind: 'runtime.item.completed', message: 'converter stress launched',
  }, {
    type: 'item.completed',
    item: {
      id: 'auto-detect-launch-item', type: 'command_execution', status: 'completed', exit_code: 0,
      command: 'codex-skill-use converter-test run-in-background -- bash launch_converter_stress.sh',
      aggregated_output: [
        'PID=999999999', `LOG=${taskBase}.log`, `DONE=${taskBase}.done`,
        `STATE=${taskBase}.state`, `META=${taskBase}.meta`,
      ].join('\n'),
    },
  }, launchAttemptId, workspaceRoot);
  store.registerExternalAttempt({
    taskId, turnId: launchTurn.id, attemptId: launchAttemptId, pid: 999999999,
    logPath: `${taskBase}.log`, donePath: `${taskBase}.done`,
    statePath: `${taskBase}.state`, metaPath: `${taskBase}.meta`,
    stepKey: 'converter-stress', stepLabel: 'Converter stress',
    runKey: 'initial', runKind: 'initial',
    checkIntervalSeconds: 1800,
  });
  const waiting = store.finalizeSessionTurn({
    taskId, turnId: launchTurn.id, attemptId: launchAttemptId,
    commandId: launchCommand.id, workerId: launchWorker, exitCode: 0,
    summary: 'Converter stress launched.', finalStatus: 'waiting_review', retryCount: 0,
  });
  assert.equal(waiting.status, 'waiting_scheduled');
  const [external] = store.listExternalAttempts(taskId);
  assert.equal(external.checkIntervalSeconds, 1800);
  assert.match(external.followUpPrompt, /rtsc-stress-report/);

  const database = getDatabase();
  database.prepare("UPDATE scheduled_jobs SET due_at='2000-01-01T00:00:00.000Z' WHERE task_id=? AND status='pending'")
    .run(taskId);
  const [job] = store.claimDueScheduledJobs(schedulerWorker, 1);
  store.dispatchClaimedScheduledJob(job.id, schedulerWorker);
  const followUpCommand = store.claimPendingCommands(followUpWorker, 10).find((command) => command.task_id === taskId);
  assert.ok(followUpCommand);
  assert.equal(store.acquireTaskLease(taskId, followUpWorker), true);
  const followUpTurn = store.beginSessionTurn({
    taskId, commandId: followUpCommand.id, workerId: followUpWorker, input: followUpCommand.input,
    persistentSessionKey: `single:${taskId}`, skillSnapshotId: null,
  }).turn;
  const followUpAttemptId = store.createAttempt(taskId, followUpTurn.id, 1, followUpWorker);
  assert.equal(store.requestSessionStop(taskId), true);
  const stopped = store.finalizeSessionTurn({
    taskId, turnId: followUpTurn.id, attemptId: followUpAttemptId,
    commandId: followUpCommand.id, workerId: followUpWorker, exitCode: 130,
    summary: 'Stopped by operator.', finalStatus: 'stopped', retryCount: 0,
  });
  assert.equal(stopped.status, 'stopped');
  assert.equal(store.listExternalAttempts(taskId)[0].status, 'cancelled');
  assert.equal(store.listScheduledJobs(taskId)[0].status, 'cancelled');
  assert.equal(store.listSessionWorklogs(taskId).some((event) => event.kind === 'schedule.retry_scheduled'), false);
});

test('scheduled command startup failures retry durably and terminate monitoring after exhaustion', () => {
  const taskId = 'scheduled-startup-failure-task';
  const taskBase = path.join(workspaceRoot, 'scheduled-startup-failure');
  fs.writeFileSync(`${taskBase}.log`, '[START]\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'running\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, '{}\n', 'utf8');
  store.saveSession(taskId, {
    name: 'Scheduled Startup Failure', objective: 'Recover a follow-up that cannot start.', workingDir: '.',
  });
  const external = store.registerExternalAttempt({
    taskId, pid: 999999996, logPath: `${taskBase}.log`,
    statePath: `${taskBase}.state`, metaPath: `${taskBase}.meta`,
    dueAt: '2000-01-01T00:00:00.000Z', checkIntervalSeconds: 5,
  });
  const database = getDatabase();
  database.prepare("UPDATE tasks SET status='waiting_scheduled' WHERE id=?").run(taskId);
  database.prepare('UPDATE scheduled_jobs SET max_attempts=2 WHERE external_attempt_id=?').run(external.id);

  const firstScheduler = 'scheduled-startup-first-scheduler';
  const [firstJob] = store.claimDueScheduledJobs(firstScheduler, 1);
  assert.ok(firstJob);
  store.dispatchClaimedScheduledJob(firstJob.id, firstScheduler);
  const firstWorker = 'scheduled-startup-first-worker';
  const [firstCommand] = store.claimPendingCommands(firstWorker, 1);
  assert.ok(firstCommand);
  assert.equal(store.acquireTaskLease(taskId, firstWorker), true);
  assert.equal(store.failClaimedCommand(firstCommand.id, firstWorker, new Error('executor temporarily unavailable')), true);

  const retryingTask = store.getSession(taskId);
  const retryingJob = store.listScheduledJobs(taskId)[0];
  assert.equal(retryingTask.status, 'waiting_scheduled');
  assert.equal(retryingTask.recoveryState, 'scheduled_retry_waiting');
  assert.equal(retryingTask.leaseOwner, '');
  assert.equal(retryingJob.status, 'pending');
  assert.equal(retryingJob.commandId, '');
  assert.equal(retryingJob.attemptCount, 1);
  assert.match(retryingJob.lastError, /temporarily unavailable/);
  assert.equal(store.getExternalAttempt(taskId, external.id).status, 'running');
  assert.equal(database.prepare('SELECT status FROM commands WHERE id=?').get(firstCommand.id).status, 'failed');

  database.prepare("UPDATE scheduled_jobs SET due_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(firstJob.id);
  const secondScheduler = 'scheduled-startup-second-scheduler';
  const [secondJob] = store.claimDueScheduledJobs(secondScheduler, 1);
  assert.ok(secondJob);
  store.dispatchClaimedScheduledJob(secondJob.id, secondScheduler);
  const secondWorker = 'scheduled-startup-second-worker';
  const [secondCommand] = store.claimPendingCommands(secondWorker, 1);
  assert.ok(secondCommand);
  assert.equal(store.acquireTaskLease(taskId, secondWorker), true);
  assert.equal(store.failClaimedCommand(secondCommand.id, secondWorker, new Error('executor still unavailable')), true);

  const failedTask = store.getSession(taskId);
  const failedJob = store.listScheduledJobs(taskId)[0];
  const lostExternal = store.getExternalAttempt(taskId, external.id);
  assert.equal(failedTask.status, 'failed');
  assert.equal(failedTask.leaseOwner, '');
  assert.equal(failedTask.activeExternalAttempts, 0);
  assert.equal(failedTask.activeScheduledJobs, 0);
  assert.equal(failedJob.status, 'failed');
  assert.equal(failedJob.attemptCount, 2);
  assert.equal(lostExternal.status, 'lost');
  assert.equal(lostExternal.result.monitoringFailure.commandId, secondCommand.id);
  const kinds = store.listSessionWorklogs(taskId).map((event) => event.kind);
  assert.ok(kinds.includes('schedule.retry_scheduled'));
  assert.ok(kinds.includes('schedule.failed'));
  assert.ok(kinds.includes('external.attempt.lost'));
  assert.ok(kinds.includes('session.failed'));
});

test('periodic recovery repairs missing background schedules and stranded scheduled waits', () => {
  const recoverableTaskId = 'missing-background-schedule-task';
  const taskBase = path.join(workspaceRoot, 'missing-background-schedule');
  fs.writeFileSync(`${taskBase}.log`, '[START]\n', 'utf8');
  fs.writeFileSync(`${taskBase}.state`, 'running\n', 'utf8');
  fs.writeFileSync(`${taskBase}.meta`, '{}\n', 'utf8');
  store.saveSession(recoverableTaskId, {
    name: 'Missing Background Schedule', objective: 'Recreate a lost durable check.', workingDir: '.',
  });
  const external = store.registerExternalAttempt({
    taskId: recoverableTaskId, pid: 999999995, logPath: `${taskBase}.log`,
    statePath: `${taskBase}.state`, metaPath: `${taskBase}.meta`,
    dueAt: '2100-01-01T00:00:00.000Z', checkIntervalSeconds: 5,
  });
  const database = getDatabase();
  database.prepare("UPDATE tasks SET status='waiting_scheduled' WHERE id=?").run(recoverableTaskId);
  database.prepare(`
    UPDATE scheduled_jobs SET status='failed', last_error='simulated interrupted persistence',
      finished_at='2000-01-01T00:00:00.000Z' WHERE external_attempt_id=?
  `).run(external.id);

  store.recoverExpiredTasks();
  const repaired = store.getSession(recoverableTaskId);
  const repairedJobs = store.listScheduledJobs(recoverableTaskId);
  assert.equal(repaired.status, 'waiting_scheduled');
  assert.equal(repaired.recoveryState, 'scheduled_recovered');
  assert.equal(repaired.activeExternalAttempts, 1);
  assert.equal(repaired.activeScheduledJobs, 1);
  assert.equal(repairedJobs.filter((job) => job.status === 'pending').length, 1);
  assert.equal(repairedJobs.filter((job) => job.status === 'failed').length, 1);
  assert.ok(store.listSessionWorklogs(recoverableTaskId).some((entry) => (
    entry.kind === 'schedule.recovered'
    && entry.payload.reason === 'missing_active_schedule'
  )));

  store.recoverExpiredTasks();
  assert.equal(store.listScheduledJobs(recoverableTaskId).filter((job) => job.status === 'pending').length, 1);
  assert.equal(store.requestSessionStop(recoverableTaskId), true);

  const strandedTaskId = 'empty-scheduled-wait-task';
  store.saveSession(strandedTaskId, {
    name: 'Empty Scheduled Wait', objective: 'Recover to operator review.', workingDir: '.',
  });
  database.prepare(`
    UPDATE tasks SET status='waiting_scheduled', recovery_state='scheduled_waiting' WHERE id=?
  `).run(strandedTaskId);
  store.recoverExpiredTasks();
  const reviewed = store.getSession(strandedTaskId);
  assert.equal(reviewed.status, 'waiting_review');
  assert.equal(reviewed.recoveryState, 'waiting_review');
  assert.ok(store.listSessionWorklogs(strandedTaskId).some((entry) => (
    entry.kind === 'session.waiting_review'
    && entry.payload.reason === 'tracking_state_recovered'
  )));
});

test('terminal background logs are preserved, served from managed storage, and removed with the task', async () => {
  const taskId = 'external-log-archive-task';
  const basePath = path.join(workspaceRoot, 'external-log-archive');
  const logPath = `${basePath}.log`;
  const content = Buffer.concat([
    Buffer.from('python3 -m pytest converter/test_smoke.py -vv\n', 'utf8'),
    Buffer.from([0, 255, 10]),
  ]);
  fs.writeFileSync(logPath, content);
  fs.writeFileSync(`${basePath}.state`, 'running\n');
  fs.writeFileSync(`${basePath}.meta`, '{}\n');
  store.saveSession(taskId, {
    name: 'External log archive', objective: 'Preserve terminal pytest output.', workingDir: '.',
  });
  const external = store.registerExternalAttempt({
    taskId, pid: 999999991, logPath,
    statePath: `${basePath}.state`, metaPath: `${basePath}.meta`,
  });
  fs.writeFileSync(`${basePath}.done`, '0\n');
  fs.writeFileSync(`${basePath}.state`, 'finished\n');
  store.reconcileExternalAttempts(taskId);
  assert.equal(store.getExternalAttempt(taskId, external.id).status, 'succeeded');

  const workerId = 'external-archive-worker';
  const [claimed] = store.claimExternalAttemptArchives(workerId, 1, { taskId });
  assert.equal(claimed.id, external.id);
  assert.equal(store.getPlatformActivityCounts().externalArchives, 1);
  assert.throws(
    () => store.acquirePlatformMaintenance('archive_test', 'test:archive-copy', 30000),
    (error) => error.statusCode === 409 && error.activityCounts.externalArchives === 1,
  );
  assert.throws(
    () => store.deleteSession(taskId),
    (error) => error.statusCode === 409 && /archival or verification is still in progress/.test(error.message),
  );
  const result = await store.processExternalAttemptArchive(claimed.id, workerId);
  assert.equal(result.ok, true, JSON.stringify(result));

  const archived = store.getExternalAttempt(taskId, external.id);
  assert.equal(archived.archiveStatus, 'archived');
  assert.equal(archived.archiveVerifyStatus, 'verified');
  assert.ok(archived.archiveVerifiedAt);
  assert.equal(archived.archivedLogBytes, content.length);
  assert.match(archived.archivedLogSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readFileSync(archived.archivedLogPath), content);
  const tampered = Buffer.from(content);
  tampered[0] ^= 0xff;
  fs.writeFileSync(archived.archivedLogPath, tampered, { mode: 0o600 });
  await assert.rejects(
    store.getExternalAttemptLogFile(taskId, external.id),
    (error) => error.statusCode === 409 && /integrity verification/.test(error.message),
  );
  const detected = store.getExternalAttempt(taskId, external.id);
  assert.equal(detected.archiveStatus, 'failed');
  assert.equal(detected.archiveVerifyStatus, 'failed');
  assert.equal(store.externalArchiveIntegrityStatus().ok, false);
  assert.equal(store.externalArchiveIntegrityStatus().failures, 1);

  const repairWorker = 'external-archive-repair-worker';
  const [repairClaim] = store.claimExternalAttemptArchives(repairWorker, 1, { taskId });
  const repaired = await store.processExternalAttemptArchive(repairClaim.id, repairWorker);
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.equal(repaired.repaired, true);
  assert.ok(repaired.quarantinedPath);
  assert.deepEqual(fs.readFileSync(repaired.quarantinedPath), tampered);
  assert.deepEqual(fs.readFileSync(archived.archivedLogPath), content);
  assert.equal(store.externalArchiveIntegrityStatus().ok, true);
  fs.unlinkSync(logPath);
  assert.equal(await store.getExternalAttemptLogFile(taskId, external.id), archived.archivedLogPath);
  const openedLog = await store.openExternalAttemptLogFile(taskId, external.id);
  const displacedLogPath = `${archived.archivedLogPath}.validated`;
  fs.renameSync(archived.archivedLogPath, displacedLogPath);
  fs.writeFileSync(archived.archivedLogPath, tampered, { mode: 0o600 });
  try {
    assert.deepEqual(await openedLog.fileHandle.readFile(), content);
  } finally {
    await openedLog.fileHandle.close();
    fs.unlinkSync(archived.archivedLogPath);
    fs.renameSync(displacedLogPath, archived.archivedLogPath);
  }
  assert.ok(store.listSessionWorklogs(taskId).some((entry) => (
    entry.kind === 'external.log_archive.completed'
    && entry.payload.sha256 === archived.archivedLogSha256
  )));
  assert.ok(store.listSessionWorklogs(taskId).some((entry) => entry.kind === 'external.log_archive.integrity_failed'));
  assert.ok(store.listSessionWorklogs(taskId).some((entry) => entry.kind === 'external.log_archive.repaired'));
  assert.equal(store.checkStateInvariants().ok, true);

  const sessionDirectory = path.join(SESSIONS_DIR, taskId);
  assert.equal(store.deleteSession(taskId), true);
  assert.equal(fs.existsSync(sessionDirectory), false);
});

test('a missing duplicate log is recovered from the same execution sibling verified archive', async () => {
  const taskId = 'external-log-duplicate-recovery';
  const sharedBasePath = path.join(workspaceRoot, 'external-log-duplicate-shared');
  const sourceLogPath = path.join(workspaceRoot, 'external-log-duplicate-source.log');
  const missingLogPath = path.join(workspaceRoot, 'external-log-duplicate-missing.log');
  const content = Buffer.from('pytest duplicate execution output\n', 'utf8');
  fs.writeFileSync(sourceLogPath, content, { mode: 0o600 });
  fs.writeFileSync(`${sharedBasePath}.done`, '0\n');
  fs.writeFileSync(`${sharedBasePath}.state`, 'finished\n');
  fs.writeFileSync(`${sharedBasePath}.meta`, '{}\n');
  store.saveSession(taskId, {
    name: 'External duplicate recovery',
    objective: 'Recover duplicate tracking from verified execution evidence.',
    workingDir: '.',
  });
  const sharedEvidence = {
    taskId,
    pid: 999999987,
    donePath: `${sharedBasePath}.done`,
    statePath: `${sharedBasePath}.state`,
    metaPath: `${sharedBasePath}.meta`,
  };
  const source = store.registerExternalAttempt({
    ...sharedEvidence,
    label: 'Duplicate source',
    logPath: sourceLogPath,
  });
  const duplicate = store.registerExternalAttempt({
    ...sharedEvidence,
    label: 'Duplicate missing path',
    logPath: missingLogPath,
  });
  store.reconcileExternalAttempts(taskId);
  assert.equal(store.getExternalAttempt(taskId, source.id).status, 'succeeded');
  assert.equal(store.getExternalAttempt(taskId, duplicate.id).status, 'succeeded');
  getDatabase().prepare(`
    UPDATE external_attempts
    SET archive_status='failed', archive_error='Tracked log does not exist',
      archive_next_retry_at='2100-01-01T00:00:00.000Z'
    WHERE id=?
  `).run(duplicate.id);

  const workerId = 'external-duplicate-recovery-worker';
  const [sourceClaim] = store.claimExternalAttemptArchives(workerId, 2, { taskId });
  assert.equal(sourceClaim.id, source.id);
  assert.equal((await store.processExternalAttemptArchive(source.id, workerId)).ok, true);
  const [duplicateClaim] = store.claimExternalAttemptArchives(workerId, 1, { taskId });
  assert.equal(duplicateClaim.id, duplicate.id);
  const recovered = await store.processExternalAttemptArchive(duplicate.id, workerId);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.sourceExternalAttemptId, source.id);

  const archivedSource = store.getExternalAttempt(taskId, source.id);
  const archivedDuplicate = store.getExternalAttempt(taskId, duplicate.id);
  assert.equal(archivedDuplicate.archiveStatus, 'archived');
  assert.equal(archivedDuplicate.archiveVerifyStatus, 'verified');
  assert.equal(archivedDuplicate.archivedLogBytes, content.length);
  assert.equal(archivedDuplicate.archivedLogSha256, archivedSource.archivedLogSha256);
  assert.notEqual(archivedDuplicate.archivedLogPath, archivedSource.archivedLogPath);
  assert.deepEqual(fs.readFileSync(archivedDuplicate.archivedLogPath), content);
  assert.ok(store.listSessionWorklogs(taskId).some((entry) => (
    entry.kind === 'external.log_archive.completed'
    && entry.payload.externalAttemptId === duplicate.id
    && entry.payload.sourceExternalAttemptId === source.id
  )));
  assert.equal(store.externalArchiveIntegrityStatus().ok, true);
});

test('duplicate log recovery rejects mismatched and symbolic-link sibling archives', async () => {
  const taskId = 'external-log-duplicate-recovery-rejected';
  const sharedBasePath = path.join(workspaceRoot, 'external-log-duplicate-rejected-shared');
  const sourceLogPath = path.join(workspaceRoot, 'external-log-duplicate-rejected-source.log');
  const mismatchedLogPath = path.join(workspaceRoot, 'external-log-duplicate-rejected-mismatch.log');
  const linkedLogPath = path.join(workspaceRoot, 'external-log-duplicate-rejected-link.log');
  const content = Buffer.from('trusted pytest output\n', 'utf8');
  fs.writeFileSync(sourceLogPath, content, { mode: 0o600 });
  fs.writeFileSync(`${sharedBasePath}.done`, '0\n');
  fs.writeFileSync(`${sharedBasePath}.state`, 'finished\n');
  fs.writeFileSync(`${sharedBasePath}.meta`, '{}\n');
  store.saveSession(taskId, {
    name: 'Rejected duplicate recovery',
    objective: 'Reject unverified filesystem evidence.',
    workingDir: '.',
  });
  const sharedEvidence = {
    taskId,
    pid: 999999986,
    donePath: `${sharedBasePath}.done`,
    statePath: `${sharedBasePath}.state`,
    metaPath: `${sharedBasePath}.meta`,
  };
  const source = store.registerExternalAttempt({
    ...sharedEvidence, label: 'Trusted source', logPath: sourceLogPath,
  });
  const mismatched = store.registerExternalAttempt({
    ...sharedEvidence, label: 'Mismatched duplicate', logPath: mismatchedLogPath,
  });
  const linked = store.registerExternalAttempt({
    ...sharedEvidence, label: 'Linked duplicate', logPath: linkedLogPath,
  });
  store.reconcileExternalAttempts(taskId);

  const workerId = 'external-duplicate-rejected-worker';
  assert.equal(store.claimExternalAttemptArchives(workerId, 3, { taskId }).length, 3);
  assert.equal((await store.processExternalAttemptArchive(source.id, workerId)).ok, true);
  const archivedSource = store.getExternalAttempt(taskId, source.id);

  fs.writeFileSync(archivedSource.archivedLogPath, Buffer.alloc(content.length, 0x78), { mode: 0o600 });
  const mismatchResult = await store.processExternalAttemptArchive(mismatched.id, workerId);
  assert.equal(mismatchResult.ok, false);
  assert.equal(mismatchResult.errorCode, 'ARCHIVE_SIBLING_DIGEST_MISMATCH');
  assert.equal(fs.existsSync(store.getExternalAttempt(taskId, mismatched.id).archivedLogPath), false);

  fs.unlinkSync(archivedSource.archivedLogPath);
  fs.symlinkSync(sourceLogPath, archivedSource.archivedLogPath);
  const linkedResult = await store.processExternalAttemptArchive(linked.id, workerId);
  assert.equal(linkedResult.ok, false);
  assert.equal(linkedResult.errorCode, 'ARCHIVE_UNSAFE_FILE');
  assert.equal(fs.existsSync(store.getExternalAttempt(taskId, linked.id).archivedLogPath), false);

  assert.equal(store.deleteSession(taskId), true);
  assert.deepEqual(fs.readFileSync(sourceLogPath), content);
  assert.equal(store.externalArchiveIntegrityStatus().ok, true);
});

test('periodic archive verification fails closed when both managed and source evidence are missing', async () => {
  const taskId = 'external-log-verification-missing';
  const logPath = path.join(workspaceRoot, 'external-log-verification-missing.log');
  const content = Buffer.from('terminal evidence before storage loss\n', 'utf8');
  fs.writeFileSync(logPath, content, { mode: 0o600 });
  store.saveSession(taskId, {
    name: 'Missing archive verification', objective: 'Detect lost preserved evidence.', workingDir: '.',
  });
  const external = store.registerExternalAttempt({ taskId, pid: 999999988, logPath });
  const database = getDatabase();
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE external_attempts SET status='succeeded', finished_at=?, updated_at=? WHERE id=?
  `).run(now, now, external.id);
  database.prepare(`
    UPDATE scheduled_jobs SET status='cancelled', finished_at=?, updated_at=?
    WHERE external_attempt_id=?
  `).run(now, now, external.id);
  const archiveWorker = 'missing-verification-archive-worker';
  const [archiveClaim] = store.claimExternalAttemptArchives(archiveWorker, 1, { taskId });
  assert.equal((await store.processExternalAttemptArchive(archiveClaim.id, archiveWorker)).ok, true);
  const archived = store.getExternalAttempt(taskId, external.id);
  fs.unlinkSync(archived.archivedLogPath);
  fs.unlinkSync(logPath);
  database.prepare(`
    UPDATE external_attempts SET archive_verify_next_at='2000-01-01T00:00:00.000Z' WHERE id=?
  `).run(external.id);

  const verifyWorker = 'missing-verification-worker';
  const [verification] = store.claimExternalArchiveVerifications(verifyWorker, 1, { taskId });
  assert.equal(verification.id, external.id);
  assert.equal(store.getPlatformActivityCounts().externalArchiveVerifications, 1);
  const result = await store.processExternalArchiveVerification(verification.id, verifyWorker);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'ARCHIVE_FILE_MISSING');
  assert.equal(store.externalArchiveIntegrityStatus().ok, false);
  await assert.rejects(
    store.getExternalAttemptLogFile(taskId, external.id),
    (error) => error.statusCode === 409 && /integrity repair/.test(error.message),
  );
  assert.equal(store.listSessionWorklogs(taskId).some((entry) => (
    entry.kind === 'external.log_archive.integrity_failed'
    && entry.payload.errorCode === 'ARCHIVE_FILE_MISSING'
  )), true);
  assert.equal(store.deleteSession(taskId), true);
  assert.equal(store.externalArchiveIntegrityStatus().ok, true);
});

test('periodic archive verification treats a lost lease as contention, not corruption', async () => {
  const taskId = 'external-log-verification-lost-lease';
  const logPath = path.join(workspaceRoot, 'external-log-verification-lost-lease.log');
  fs.writeFileSync(logPath, 'preserved evidence remains valid\n', { mode: 0o600 });
  store.saveSession(taskId, {
    name: 'Archive verification lease', objective: 'Do not misreport worker contention.', workingDir: '.',
  });
  const external = store.registerExternalAttempt({ taskId, pid: 999999987, logPath });
  const database = getDatabase();
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE external_attempts SET status='succeeded', finished_at=?, updated_at=? WHERE id=?
  `).run(now, now, external.id);
  database.prepare(`
    UPDATE scheduled_jobs SET status='cancelled', finished_at=?, updated_at=?
    WHERE external_attempt_id=?
  `).run(now, now, external.id);
  const archiveWorker = 'lease-verification-archive-worker';
  const [archiveClaim] = store.claimExternalAttemptArchives(archiveWorker, 1, { taskId });
  assert.equal((await store.processExternalAttemptArchive(archiveClaim.id, archiveWorker)).ok, true);
  database.prepare(`
    UPDATE external_attempts SET archive_verify_next_at='2000-01-01T00:00:00.000Z' WHERE id=?
  `).run(external.id);

  const verifyWorker = 'lease-verification-worker';
  const [verification] = store.claimExternalArchiveVerifications(verifyWorker, 1, { taskId });
  const result = await store.processExternalArchiveVerification(verification.id, verifyWorker, {
    faultInjector(stage) {
      if (stage !== 'after_digest') return;
      database.prepare(`
        UPDATE external_attempts
        SET archive_verify_lease_owner='replacement-worker',
          archive_verify_lease_expires_at='2000-01-01T00:00:00.000Z'
        WHERE id=?
      `).run(external.id);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.lostLease, true);
  assert.equal(result.errorCode, 'ARCHIVE_VERIFY_LEASE_LOST');
  const retained = store.getExternalAttempt(taskId, external.id);
  assert.equal(retained.archiveStatus, 'archived');
  assert.equal(retained.archiveVerifyStatus, 'verifying');
  assert.equal(store.externalArchiveIntegrityStatus().ok, true);
  assert.equal(store.listSessionWorklogs(taskId).some((entry) => (
    entry.kind === 'external.log_archive.integrity_failed'
  )), false);

  const replacementWorker = 'replacement-verification-worker';
  const [replacement] = store.claimExternalArchiveVerifications(replacementWorker, 1, { taskId });
  assert.equal(replacement.id, external.id);
  assert.equal((await store.processExternalArchiveVerification(replacement.id, replacementWorker)).ok, true);
  assert.equal(store.deleteSession(taskId), true);
});

test('missing background logs fail visibly and remain eligible for bounded retry', async () => {
  const taskId = 'external-log-missing-task';
  const logPath = path.join(workspaceRoot, 'missing-external.log');
  store.saveSession(taskId, {
    name: 'Missing external log', objective: 'Expose preservation failures.', workingDir: '.',
  });
  const external = store.registerExternalAttempt({ taskId, pid: 999999990, logPath });
  const database = getDatabase();
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE external_attempts SET status='lost', finished_at=?, updated_at=? WHERE id=?
  `).run(now, now, external.id);
  database.prepare(`
    UPDATE scheduled_jobs SET status='cancelled', finished_at=?, updated_at=?
    WHERE external_attempt_id=?
  `).run(now, now, external.id);

  const workerId = 'missing-archive-worker';
  const [claimed] = store.claimExternalAttemptArchives(workerId, 1, { taskId });
  assert.equal(claimed.id, external.id);
  const result = await store.processExternalAttemptArchive(claimed.id, workerId);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'ARCHIVE_SOURCE_MISSING');
  const failed = store.getExternalAttempt(taskId, external.id);
  assert.equal(failed.archiveStatus, 'failed');
  assert.match(failed.archiveError, /does not exist/);
  assert.ok(Date.parse(failed.archiveNextRetryAt) > Date.now());
  assert.equal(failed.archiveLeaseOwner, '');
  assert.ok(store.listSessionWorklogs(taskId).some((entry) => (
    entry.kind === 'external.log_archive.failed'
    && entry.payload.errorCode === 'ARCHIVE_SOURCE_MISSING'
  )));
});

test('archive publication is reconciled after a database-write interruption', async () => {
  const taskId = 'external-log-publish-recovery';
  const basePath = path.join(workspaceRoot, 'external-log-publish-recovery');
  const content = Buffer.from('pytest completed before worker interruption\n', 'utf8');
  fs.writeFileSync(`${basePath}.log`, content);
  store.saveSession(taskId, {
    name: 'Archive publish recovery', objective: 'Adopt an already published managed log.', workingDir: '.',
  });
  const external = store.registerExternalAttempt({ taskId, pid: 999999989, logPath: `${basePath}.log` });
  const database = getDatabase();
  const now = new Date().toISOString();
  database.prepare(`
    UPDATE external_attempts SET status='succeeded', finished_at=?, updated_at=? WHERE id=?
  `).run(now, now, external.id);
  database.prepare(`
    UPDATE scheduled_jobs SET status='cancelled', finished_at=?, updated_at=?
    WHERE external_attempt_id=?
  `).run(now, now, external.id);

  const firstWorker = 'archive-publish-first-worker';
  const [firstClaim] = store.claimExternalAttemptArchives(firstWorker, 1, { taskId });
  const interrupted = await store.processExternalAttemptArchive(firstClaim.id, firstWorker, {
    faultInjector(stage) {
      if (stage === 'after_publish') throw new Error('simulated post-publish interruption');
    },
  });
  assert.equal(interrupted.ok, false);
  const failed = store.getExternalAttempt(taskId, external.id);
  assert.equal(failed.archiveStatus, 'failed');
  assert.deepEqual(fs.readFileSync(failed.archivedLogPath), content);

  fs.unlinkSync(`${basePath}.log`);
  database.prepare("UPDATE external_attempts SET archive_next_retry_at='2000-01-01T00:00:00.000Z' WHERE id=?")
    .run(external.id);
  const secondWorker = 'archive-publish-second-worker';
  const [secondClaim] = store.claimExternalAttemptArchives(secondWorker, 1, { taskId });
  const recovered = await store.processExternalAttemptArchive(secondClaim.id, secondWorker);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.recoveredExisting, true);
  assert.equal(store.getExternalAttempt(taskId, external.id).archiveStatus, 'archived');
});

test('configuration export contains portable configuration only', () => {
  store.saveSkill('portable-skill', {
    name: 'Portable Skill', category: 'Audit', description: 'Portable configuration.',
    tags: ['audit'], enabled: true, content: '# Portable Skill',
  });
  store.saveSession('completed-audit-history', {
    name: 'Completed Audit History', objective: 'Must remain immutable.', workingDir: '.', status: 'completed',
  });
  const bundle = store.exportConfigBundle();
  const task = bundle.sessions.find((session) => session.id === 'ownership-task');
  assert.deepEqual(Object.keys(task).sort(), [
    'autoResume', 'enabled', 'id', 'maxRetries', 'name', 'notes', 'objective', 'workingDir',
  ].sort());
  assert.equal(JSON.stringify(task).includes('single:ownership-task'), false);
  assert.equal(bundle.sessions.some((session) => session.id === 'completed-audit-history'), false);

  const skill = bundle.skills.find((item) => item.id === 'portable-skill');
  assert.deepEqual(Object.keys(skill).sort(), [
    'category', 'content', 'description', 'enabled', 'id', 'name', 'tags',
  ].sort());
});

test('replace import removes stale task files before reusing task ids', () => {
  const sessionDir = path.join(SESSIONS_DIR, 'ownership-task');
  const snapshotDir = path.join(SKILL_SNAPSHOTS_DIR, 'ownership-task');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'stale.log'), 'stale', 'utf8');
  fs.writeFileSync(path.join(snapshotDir, 'stale.txt'), 'stale', 'utf8');

  const conflictingSourceId = store.listSkillSummaries().find((skill) => skill.origin === 'codex').id;
  assert.throws(() => store.importConfigBundle({
    format: 'codex-ops-bundle', version: 3,
    skills: [{ id: conflictingSourceId, name: 'Conflict', content: '# Conflict' }],
    sessions: [],
  }, 'replace'), (error) => error.statusCode === 409);
  assert.equal(fs.readFileSync(path.join(sessionDir, 'stale.log'), 'utf8'), 'stale');
  assert.equal(fs.readFileSync(path.join(snapshotDir, 'stale.txt'), 'utf8'), 'stale');
  assert.equal(store.getSession('ownership-task').status, 'waiting_review');

  assert.throws(() => store.importConfigBundle({
    format: 'codex-ops-bundle', version: 3, skills: [],
    sessions: [{
      id: 'completed-audit-history', name: 'Overwrite History', objective: 'Must fail.', workingDir: '.',
    }],
  }, 'replace'), (error) => error.statusCode === 409 && /immutable completed history/i.test(error.message));
  assert.equal(store.getSession('completed-audit-history').status, 'completed');

  const result = store.importConfigBundle({
    format: 'codex-ops-bundle', version: 3, skills: [],
    sessions: [{
      id: 'ownership-task', name: 'Reimported Task', objective: 'Fresh configuration.',
      workingDir: '.', notes: '', enabled: true, autoResume: true, maxRetries: 1,
    }],
  }, 'replace');

  assert.equal(result.counts.sessions, 1);
  assert.equal(store.getSession('ownership-task').status, 'idle');
  assert.equal(store.getSession('completed-audit-history').status, 'completed');
  assert.equal(fs.existsSync(path.join(sessionDir, 'stale.log')), false);
  assert.equal(fs.existsSync(path.join(snapshotDir, 'stale.txt')), false);
});

test('skill snapshot materialization repairs changed and unexpected files', () => {
  store.saveSkill('snapshot-integrity-skill', {
    name: 'Snapshot Integrity Skill', content: '# Snapshot Integrity\n\nOriginal content.\n',
  });
  store.saveSession('snapshot-integrity-task', {
    name: 'Snapshot Integrity Task', objective: 'Verify immutable materialization.', workingDir: '.',
  });
  const first = store.ensureTaskSkillSnapshot('snapshot-integrity-task');
  const skillFile = path.join(first.path, 'snapshot-integrity-skill', 'SKILL.md');
  fs.chmodSync(first.path, 0o700);
  fs.chmodSync(path.dirname(skillFile), 0o700);
  fs.chmodSync(skillFile, 0o600);
  fs.writeFileSync(skillFile, '# Tampered\n', 'utf8');
  fs.mkdirSync(path.join(first.path, 'unexpected-skill'));
  fs.writeFileSync(path.join(first.path, 'unexpected-skill', 'SKILL.md'), '# Unexpected\n', 'utf8');

  const repaired = store.ensureTaskSkillSnapshot('snapshot-integrity-task');
  assert.equal(repaired.path, first.path);
  assert.equal(fs.readFileSync(skillFile, 'utf8'), '# Snapshot Integrity\n\nOriginal content.\n');
  assert.equal(fs.existsSync(path.join(first.path, 'unexpected-skill')), false);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o500);
  assert.equal(fs.statSync(skillFile).mode & 0o777, 0o400);
});

test('Session and Skill snapshot directories reject symbolic-link targets', () => {
  const sessionTarget = path.join(tempDir, 'linked-session-target');
  const sessionPath = path.join(SESSIONS_DIR, 'linked-session-storage');
  fs.mkdirSync(sessionTarget, { mode: 0o755 });
  fs.chmodSync(sessionTarget, 0o755);
  store.saveSession('linked-session-storage', {
    name: 'Linked Session Storage', objective: 'Reject linked storage.', workingDir: '.',
  });
  fs.symlinkSync(sessionTarget, sessionPath, 'dir');
  assert.throws(
    () => store.appendSessionLatestLog('linked-session-storage', 'must not escape', true),
    /Session storage directory is not a regular directory/,
  );
  assert.equal(fs.statSync(sessionTarget).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(sessionTarget), []);
  fs.unlinkSync(sessionPath);

  const snapshotTarget = path.join(tempDir, 'linked-snapshot-target');
  const taskSnapshotPath = path.join(SKILL_SNAPSHOTS_DIR, 'linked-snapshot-storage');
  fs.mkdirSync(snapshotTarget, { mode: 0o755 });
  fs.chmodSync(snapshotTarget, 0o755);
  store.saveSession('linked-snapshot-storage', {
    name: 'Linked Snapshot Storage', objective: 'Reject linked snapshots.', workingDir: '.',
  });
  fs.symlinkSync(snapshotTarget, taskSnapshotPath, 'dir');
  assert.throws(
    () => store.ensureTaskSkillSnapshot('linked-snapshot-storage'),
    /Task Skill snapshot directory is not a regular directory/,
  );
  assert.equal(fs.statSync(snapshotTarget).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(snapshotTarget), []);
  fs.unlinkSync(taskSnapshotPath);
  assert.ok(store.ensureTaskSkillSnapshot('linked-snapshot-storage').path);
});

test('execution storage preflight rejects linked logs before creating a Turn', async () => {
  const taskId = 'linked-latest-log';
  const workerId = 'linked-latest-worker';
  const target = path.join(tempDir, 'linked-latest-target.log');
  store.saveSession(taskId, {
    name: 'Linked Latest Log', objective: 'Reject linked latest log.', workingDir: '.',
  });
  store.appendSessionLatestLog(taskId, 'original latest', true);
  const latestPath = path.join(SESSIONS_DIR, taskId, 'latest.log');
  fs.unlinkSync(latestPath);
  fs.writeFileSync(target, 'outside latest', { mode: 0o644 });
  fs.chmodSync(target, 0o644);
  fs.symlinkSync(target, latestPath);
  store.queueSessionRun(taskId, 'Run with unsafe latest log.', 'linked-latest-command');
  const command = store.claimPendingCommands(workerId, 10).find((item) => item.task_id === taskId);
  assert.ok(command);
  assert.equal(store.acquireTaskLease(taskId, workerId), true);

  await assert.rejects(startSession(command, workerId), /Session latest log is not a regular file/);
  assert.equal(store.listTurns(taskId).length, 0);
  assert.equal(store.listAttempts(taskId).length, 0);
  assert.equal(listActiveSessions().some((session) => session.id === taskId), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'outside latest');
  assert.equal(fs.statSync(target).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(path.join(SESSIONS_DIR, taskId, 'bridge-output.txt')), false);
  fs.unlinkSync(latestPath);
  assert.equal(store.failClaimedCommand(command.id, workerId, new Error('unsafe latest log')), true);
});

test('Bridge result and Attempt output links are rejected without touching their targets', async () => {
  for (const scenario of [
    { taskId: 'linked-bridge-result', entry: 'bridge-output.txt', targetKind: 'file', error: /Bridge result file is not a regular file/ },
    { taskId: 'linked-attempt-output', entry: 'attempt-output', targetKind: 'directory', error: /Attempt output directory is not a regular directory/ },
  ]) {
    const workerId = `${scenario.taskId}-worker`;
    const sessionPath = path.join(SESSIONS_DIR, scenario.taskId);
    const target = path.join(tempDir, `${scenario.taskId}-target`);
    store.saveSession(scenario.taskId, {
      name: scenario.taskId, objective: 'Reject linked execution storage.', workingDir: '.',
    });
    store.appendSessionLatestLog(scenario.taskId, 'seed', true);
    if (scenario.targetKind === 'file') {
      fs.writeFileSync(target, 'outside bridge result', { mode: 0o644 });
      fs.chmodSync(target, 0o644);
    } else {
      fs.mkdirSync(target, { mode: 0o755 });
      fs.chmodSync(target, 0o755);
    }
    fs.symlinkSync(target, path.join(sessionPath, scenario.entry), scenario.targetKind === 'directory' ? 'dir' : 'file');
    store.queueSessionRun(scenario.taskId, 'Run with unsafe execution storage.', `${scenario.taskId}-command`);
    const command = store.claimPendingCommands(workerId, 10).find((item) => item.task_id === scenario.taskId);
    assert.ok(command);
    assert.equal(store.acquireTaskLease(scenario.taskId, workerId), true);

    await assert.rejects(startSession(command, workerId), scenario.error);
    assert.equal(store.listTurns(scenario.taskId).length, 0);
    assert.equal(store.listAttempts(scenario.taskId).length, 0);
    assert.equal(listActiveSessions().some((session) => session.id === scenario.taskId), false);
    if (scenario.targetKind === 'file') {
      assert.equal(fs.readFileSync(target, 'utf8'), 'outside bridge result');
      assert.equal(fs.statSync(target).mode & 0o777, 0o644);
    } else {
      assert.deepEqual(fs.readdirSync(target), []);
      assert.equal(fs.statSync(target).mode & 0o777, 0o755);
    }
    fs.unlinkSync(path.join(sessionPath, scenario.entry));
    assert.equal(store.failClaimedCommand(command.id, workerId, new Error('unsafe execution storage')), true);
  }
});

test('startup reconciles task files left staged by an interrupted delete', () => {
  const recoveryRoot = path.join(tempDir, 'staged-file-recovery');
  const recoveryData = path.join(recoveryRoot, 'data');
  const recoveryRuntime = path.join(recoveryRoot, 'runtime');
  const environment = {
    ...process.env,
    CODEX_DESK_DATA_DIR: recoveryData,
    CODEX_DESK_RUNTIME_DIR: recoveryRuntime,
    CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
    SOURCE_CODEX_HOME: sourceHome,
  };
  const prepare = spawnSync(process.execPath, ['-e', [
    "const fs = require('fs');",
    "const path = require('path');",
    "const store = require('./src/store');",
    "const paths = require('./src/paths');",
    "const crypto = require('crypto');",
    "const task = store.saveSession('restore-staged', { name: 'Restore Staged', objective: 'Restore files.', workingDir: '.' });",
    "const target = path.join(paths.SESSIONS_DIR, 'restore-staged');",
    "fs.mkdirSync(target, { recursive: true });",
    "fs.writeFileSync(path.join(target, 'latest.log'), 'preserved');",
    "const generation = crypto.createHash('sha256').update(task.createdAt).digest('hex').slice(0, 16);",
    "fs.renameSync(target, target + '.deleting-' + generation + '-11111111-1111-1111-1111-111111111111');",
    "store.saveSession('discard-staged', { name: 'Discard Staged', objective: 'Discard another generation.', workingDir: '.' });",
    "const discardTarget = path.join(paths.SESSIONS_DIR, 'discard-staged');",
    "fs.mkdirSync(discardTarget, { recursive: true });",
    "fs.writeFileSync(path.join(discardTarget, 'latest.log'), 'stale');",
    "fs.renameSync(discardTarget, discardTarget + '.deleting-0000000000000000-22222222-2222-2222-2222-222222222222');",
  ].join('\n')], { cwd: path.resolve(__dirname, '..'), env: environment, encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stderr);
  const recover = spawnSync(process.execPath, ['-e', "require('./src/store').ensureStorage()"], {
    cwd: path.resolve(__dirname, '..'), env: environment, encoding: 'utf8',
  });
  assert.equal(recover.status, 0, recover.stderr);
  assert.equal(fs.readFileSync(path.join(recoveryData, 'sessions', 'restore-staged', 'latest.log'), 'utf8'), 'preserved');
  assert.equal(fs.existsSync(path.join(recoveryData, 'sessions', 'discard-staged')), false);
  assert.equal(fs.readdirSync(path.join(recoveryData, 'sessions')).some((name) => name.includes('.deleting-')), false);
});

test('startup tightens legacy data permissions without following symbolic links', () => {
  const storageRoot = path.join(tempDir, 'legacy-permission-recovery');
  const legacyData = path.join(storageRoot, 'data');
  const legacyRuntime = path.join(storageRoot, 'runtime');
  const outsideTarget = path.join(storageRoot, 'outside-target.txt');
  const legacyDirectories = [
    path.join(legacyData, 'agents'),
    path.join(legacyData, 'runs', 'old-run'),
    path.join(legacyData, 'sessions', 'old-session'),
    path.join(legacyData, 'skills', 'old-skill'),
  ];
  for (const directory of legacyDirectories) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    fs.chmodSync(directory, 0o755);
  }
  const legacyFiles = [
    path.join(legacyData, 'audit.ndjson'),
    path.join(legacyData, 'agents', 'builder.json'),
    path.join(legacyData, 'runs', 'old-run', 'worklog.ndjson'),
    path.join(legacyData, 'sessions', 'old-session', 'latest.log'),
    path.join(legacyData, 'skills', 'old-skill', 'SKILL.md'),
  ];
  for (const filePath of legacyFiles) {
    fs.writeFileSync(filePath, '', { mode: 0o644 });
    fs.chmodSync(filePath, 0o644);
  }
  fs.writeFileSync(outsideTarget, 'outside', { mode: 0o644 });
  fs.chmodSync(outsideTarget, 0o644);
  fs.symlinkSync(outsideTarget, path.join(legacyData, 'legacy-link'));

  const result = spawnSync(process.execPath, ['-e', "require('./src/store').ensureStorage()"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CODEX_DESK_DATA_DIR: legacyData,
      CODEX_DESK_RUNTIME_DIR: legacyRuntime,
      CODEX_TASK_WORKSPACE_ROOTS: path.join(storageRoot, 'workspaces'),
      SOURCE_CODEX_HOME: path.join(storageRoot, 'codex-home'),
      WORKSPACE_CODEX_SKILLS_DIR: path.join(storageRoot, 'workspace-skills'),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  for (const directory of [legacyData, ...legacyDirectories]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700, directory);
  }
  for (const filePath of legacyFiles) {
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, filePath);
  }
  assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'outside');
  assert.equal(fs.statSync(outsideTarget).mode & 0o777, 0o644);
  assert.equal(fs.lstatSync(path.join(legacyData, 'legacy-link')).isSymbolicLink(), true);
});

test('startup rejects a symbolic-link Session root without modifying its target', () => {
  const storageRoot = path.join(tempDir, 'session-root-symlink');
  const linkedData = path.join(storageRoot, 'data');
  const linkedRuntime = path.join(storageRoot, 'runtime');
  const outsideSessions = path.join(storageRoot, 'outside-sessions');
  fs.mkdirSync(linkedData, { recursive: true });
  fs.mkdirSync(outsideSessions, { recursive: true, mode: 0o755 });
  fs.chmodSync(outsideSessions, 0o755);
  fs.symlinkSync(outsideSessions, path.join(linkedData, 'sessions'), 'dir');

  const result = spawnSync(process.execPath, ['-e', "require('./src/store').ensureStorage()"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CODEX_DESK_DATA_DIR: linkedData,
      CODEX_DESK_RUNTIME_DIR: linkedRuntime,
      CODEX_TASK_WORKSPACE_ROOTS: path.join(storageRoot, 'workspaces'),
      SOURCE_CODEX_HOME: path.join(storageRoot, 'codex-home'),
      WORKSPACE_CODEX_SKILLS_DIR: path.join(storageRoot, 'workspace-skills'),
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Session storage root is not a regular directory/);
  assert.equal(fs.statSync(outsideSessions).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(outsideSessions), []);
});

test('legacy migration does not traverse a symbolic-link Skill root', () => {
  const storageRoot = path.join(tempDir, 'legacy-skill-root-symlink');
  const linkedData = path.join(storageRoot, 'data');
  const linkedRuntime = path.join(storageRoot, 'runtime');
  const outsideSkill = path.join(storageRoot, 'outside-skills', 'outside-skill');
  fs.mkdirSync(linkedData, { recursive: true });
  fs.mkdirSync(outsideSkill, { recursive: true, mode: 0o755 });
  fs.chmodSync(path.dirname(outsideSkill), 0o755);
  fs.chmodSync(outsideSkill, 0o755);
  fs.writeFileSync(path.join(outsideSkill, 'meta.json'), JSON.stringify({ id: 'outside-skill', name: 'Outside' }), { mode: 0o644 });
  fs.writeFileSync(path.join(outsideSkill, 'SKILL.md'), '# Outside\n', { mode: 0o644 });
  fs.symlinkSync(path.dirname(outsideSkill), path.join(linkedData, 'skills'), 'dir');

  const script = [
    "const store = require('./src/store');",
    'store.ensureStorage();',
    "if (store.getSkill('outside-skill')) throw new Error('linked Skill source was migrated');",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      CODEX_DESK_DATA_DIR: linkedData,
      CODEX_DESK_RUNTIME_DIR: linkedRuntime,
      CODEX_TASK_WORKSPACE_ROOTS: path.join(storageRoot, 'workspaces'),
      SOURCE_CODEX_HOME: path.join(storageRoot, 'codex-home'),
      WORKSPACE_CODEX_SKILLS_DIR: path.join(storageRoot, 'workspace-skills'),
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(path.dirname(outsideSkill)).mode & 0o777, 0o755);
  assert.equal(fs.statSync(outsideSkill).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(outsideSkill, 'SKILL.md')).mode & 0o777, 0o644);
});

test('existing execution and report tables migrate before new indexes are created', () => {
  const migrationRoot = path.join(tempDir, 'schema-migration');
  const migrationData = path.join(migrationRoot, 'data');
  fs.mkdirSync(migrationData, { recursive: true });
  const migrationDbFile = path.join(migrationData, 'codex-tasks.db');
  const oldDb = new (require('better-sqlite3'))(migrationDbFile);
  oldDb.exec(`
    CREATE TABLE command_executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      runtime_item_id TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      exit_code INTEGER,
      status TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      raw_event_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(task_id, turn_id, attempt_id, runtime_item_id)
    );

    CREATE TABLE session_operation_receipts (
      idempotency_key TEXT PRIMARY KEY,
      operation TEXT NOT NULL CHECK(operation IN ('stop', 'complete', 'delete')),
      task_id TEXT NOT NULL,
      task_created_at TEXT NOT NULL DEFAULT '',
      expected_task_created_at TEXT NOT NULL DEFAULT '',
      response_json TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'operator',
      request_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE external_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      origin_turn_id TEXT,
      origin_attempt_id TEXT,
      source_command_execution_id TEXT,
      chain_key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running',
      pid INTEGER,
      log_path TEXT NOT NULL,
      done_path TEXT NOT NULL DEFAULT '',
      state_path TEXT NOT NULL DEFAULT '',
      meta_path TEXT NOT NULL DEFAULT '',
      check_interval_seconds INTEGER NOT NULL DEFAULT 300,
      follow_up_prompt TEXT NOT NULL DEFAULT '',
      last_observation TEXT NOT NULL DEFAULT '',
      result_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      last_checked_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, chain_key, generation)
    );

    CREATE TABLE skill_reports (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      task_id TEXT NOT NULL,
      turn_id TEXT,
      attempt_id TEXT,
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

    INSERT INTO session_operation_receipts (
      idempotency_key, operation, task_id, response_json, created_at
    ) VALUES ('legacy-stop-receipt', 'stop', 'legacy-task', '{"ok":true}', '2026-08-01T00:00:00.000Z');
  `);
  const insertLegacyExecution = oldDb.prepare(`
    INSERT INTO command_executions
      (id, task_id, turn_id, attempt_id, runtime_item_id, working_directory, raw_event_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertLegacyExecution.run(
    'legacy-unreported', 'legacy-task', 'legacy-turn', 'legacy-attempt', 'legacy-item-1',
    '/configured/legacy-task',
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pwd' } }),
  );
  insertLegacyExecution.run(
    'legacy-reported', 'legacy-task', 'legacy-turn', 'legacy-attempt', 'legacy-item-2',
    '/configured/legacy-task',
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'pwd', cwd: '/runtime/reported-task' },
    }),
  );
  oldDb.close();

  const { spawnSync } = require('node:child_process');
  const migrated = spawnSync(process.execPath, ['-e', [
    "const { getDatabase, checkDatabaseIntegrity } = require('./src/database');",
    "const db = getDatabase();",
    "db.prepare(\"INSERT INTO session_operation_receipts (idempotency_key, operation, task_id, response_json, created_at) VALUES ('restore-receipt', 'restore', 'legacy-task', '{}', '2026-08-02T00:00:00.000Z')\").run();",
    "console.log(JSON.stringify({ columns: db.pragma('table_info(command_executions)').map((column) => column.name), taskColumns: db.pragma('table_info(tasks)').map((column) => column.name), externalColumns: db.pragma('table_info(external_attempts)').map((column) => column.name), reportColumns: db.pragma('table_info(skill_reports)').map((column) => column.name), stepIndexes: db.prepare(\"SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_external_attempts_step_run', 'idx_skill_reports_step_run') ORDER BY name\").all().map((row) => row.name), executionRows: db.prepare('SELECT id, working_directory, configured_working_directory FROM command_executions ORDER BY id').all(), receiptOperations: db.prepare('SELECT operation FROM session_operation_receipts ORDER BY created_at').all().map((row) => row.operation), integrity: checkDatabaseIntegrity() }));",
  ].join('\n')], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      CODEX_DESK_DATA_DIR: migrationData,
      CODEX_DESK_RUNTIME_DIR: path.join(migrationRoot, 'runtime'),
      CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
      SOURCE_CODEX_HOME: sourceHome,
    },
    encoding: 'utf8',
  });
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.ok(migrated.stdout.trim(), JSON.stringify({ status: migrated.status, signal: migrated.signal, error: migrated.error, stderr: migrated.stderr }));
  const payload = JSON.parse(migrated.stdout.trim());
  assert.ok(payload.columns.includes('working_directory'));
  assert.ok(payload.columns.includes('configured_working_directory'));
  assert.ok(payload.taskColumns.includes('recovery_count'));
  assert.ok(payload.externalColumns.includes('step_run_id'));
  assert.ok(payload.reportColumns.includes('step_run_id'));
  assert.deepEqual(payload.stepIndexes, [
    'idx_external_attempts_step_run',
    'idx_skill_reports_step_run',
  ]);
  assert.deepEqual(payload.executionRows, [
    {
      id: 'legacy-reported',
      working_directory: '/runtime/reported-task',
      configured_working_directory: '/configured/legacy-task',
    },
    {
      id: 'legacy-unreported',
      working_directory: '',
      configured_working_directory: '/configured/legacy-task',
    },
  ]);
  assert.deepEqual(payload.receiptOperations, ['stop', 'restore']);
  assert.equal(payload.integrity.ok, true);
  assert.equal(payload.integrity.quickCheck, 'ok');
  assert.equal(payload.integrity.foreignKeyViolations, 0);
  assert.match(payload.integrity.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('overlapping data and runtime directories are rejected before storage opens', () => {
  const { spawnSync } = require('node:child_process');
  const overlap = path.join(tempDir, 'overlap');
  const result = spawnSync(process.execPath, ['-e', "require('./src/paths')"], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      CODEX_DESK_DATA_DIR: overlap,
      CODEX_DESK_RUNTIME_DIR: overlap,
      CODEX_TASK_WORKSPACE_ROOTS: workspaceRoot,
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not overlap/);
});

test('invalid storage capacity thresholds fail before the service can accept work', () => {
  const invalidBytes = spawnSync(process.execPath, ['-e', "require('./src/storage-capacity')"], {
    cwd: ROOT_DIR,
    env: { ...process.env, CODEX_MIN_FREE_BYTES: '-1' },
    encoding: 'utf8',
  });
  assert.notEqual(invalidBytes.status, 0);
  assert.match(invalidBytes.stderr, /CODEX_MIN_FREE_BYTES must be a non-negative integer/);

  const invalidPercent = spawnSync(process.execPath, ['-e', "require('./src/storage-capacity')"], {
    cwd: ROOT_DIR,
    env: { ...process.env, CODEX_MIN_FREE_PERCENT: '101' },
    encoding: 'utf8',
  });
  assert.notEqual(invalidPercent.status, 0);
  assert.match(invalidPercent.stderr, /CODEX_MIN_FREE_PERCENT must be a number between 0 and 100/);
});
