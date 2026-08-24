#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  appendAuditEvent,
  appendRuntimeWorklog,
  appendSessionLatestLog,
  appendSessionWorklog,
  getSession,
  listAttempts,
  listTurns,
} = require('../src/store');
const { closeDatabase, getDatabase } = require('../src/database');

function fail(message, code = 64) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function parseArguments(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value == null) fail(`missing value for ${key || 'argument'}`);
    result[key] = value;
  }
  const required = ['--task', '--turn', '--attempt', '--rollout'];
  for (const key of required) if (!String(result[key] || '').trim()) fail(`${key} is required`);
  return result;
}

function rolloutOffset(value, size) {
  if (value == null || value === '') return 0;
  if (!/^\d+$/.test(String(value))) fail('--offset must be a non-negative integer');
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset > size) fail('--offset exceeds the rollout size');
  return offset;
}

function readRolloutIncrement(rolloutPath, offset) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(rolloutPath, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) fail('rollout must be a regular file');
    if (offset > stat.size) fail('rollout shrank before its increment could be read');
    if (offset > 0) {
      const boundary = Buffer.allocUnsafe(1);
      if (fs.readSync(descriptor, boundary, 0, 1, offset - 1) !== 1 || boundary[0] !== 0x0a) {
        fail('rollout increment does not start at a record boundary');
      }
    }
    const bytes = stat.size - offset;
    if (bytes > 128 * 1024 * 1024) fail('rollout increment exceeds the 128 MiB recovery limit');
    const content = Buffer.allocUnsafe(bytes);
    let position = 0;
    while (position < bytes) {
      const length = fs.readSync(descriptor, content, position, bytes - position, offset + position);
      if (!length) fail('rollout changed while its increment was being read');
      position += length;
    }
    return content.toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseJsonObjectsAfter(source, token) {
  const values = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const tokenAt = source.indexOf(token, searchFrom);
    if (tokenAt === -1) break;
    let start = tokenAt + token.length;
    while (/\s/.test(source[start] || '')) start += 1;
    if (source[start] !== '{') {
      searchFrom = start + 1;
      continue;
    }
    let depth = 0;
    let quote = '';
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"') {
        quote = char;
        continue;
      }
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end === -1) break;
    try { values.push(JSON.parse(source.slice(start, end))); } catch {}
    searchFrom = end;
  }
  return values;
}

function toolCommands(payload) {
  const source = String(payload.input || '');
  const commands = parseJsonObjectsAfter(source, 'tools.exec_command(')
    .filter((value) => value && Object.hasOwn(value, 'cmd'))
    .map((value) => ({
      command: typeof value.cmd === 'string' ? value.cmd : JSON.stringify(value.cmd),
      cwd: String(value.workdir || ''),
    }));
  if (commands.length) return commands;
  return [{
    command: `[Codex tool: ${String(payload.name || 'unknown')}]\n${source}`,
    cwd: '',
  }];
}

function toolOutputText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return value == null ? '' : JSON.stringify(value);
  return value.map((item) => {
    if (item && typeof item === 'object' && typeof item.text === 'string') return item.text;
    return typeof item === 'string' ? item : JSON.stringify(item);
  }).join('');
}

function assistantText(payload) {
  if (payload.type !== 'message' || payload.role !== 'assistant' || !Array.isArray(payload.content)) return '';
  return payload.content
    .filter((item) => item && ['output_text', 'text'].includes(item.type))
    .map((item) => String(item.text || ''))
    .join('');
}

function recoverRollout(options) {
  const taskId = String(options['--task']);
  const turnId = String(options['--turn']);
  const attemptId = String(options['--attempt']);
  const rolloutPath = path.resolve(options['--rollout']);
  const configuredWorkingDirectory = String(options['--working-dir'] || '');

  const task = getSession(taskId);
  if (!task) fail(`task not found: ${taskId}`);
  if (!listTurns(taskId, 500, 0).some((turn) => turn.id === turnId)) {
    fail(`turn does not belong to task: ${turnId}`);
  }
  if (!listAttempts(taskId, { limit: 500 }).some((attempt) => attempt.id === attemptId && attempt.turnId === turnId)) {
    fail(`attempt does not belong to turn: ${attemptId}`);
  }

  let stat;
  try { stat = fs.lstatSync(rolloutPath); } catch { fail(`rollout not found: ${rolloutPath}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail('rollout must be a regular file');
  const offset = rolloutOffset(options['--offset'], stat.size);
  const source = readRolloutIncrement(rolloutPath, offset);
  const sourceHash = crypto.createHash('sha256')
    .update(`${rolloutPath}\0${offset}\0`)
    .update(source)
    .digest('hex');
  const recoveryKey = sourceHash.slice(0, 24);
  const markerId = `rollout-recovery-${recoveryKey}`;
  const db = getDatabase();
  if (db.prepare('SELECT 1 FROM worklog_events WHERE id=?').get(markerId)) {
    return { ok: true, alreadyRecovered: true, taskId, sourceHash };
  }

  const records = source.split('\n').map((line, index) => {
    if (!line.trim()) return null;
    try { return { line: index + 1, value: JSON.parse(line) }; } catch { return null; }
  }).filter(Boolean);
  const pendingTools = new Map();
  let agentMessages = 0;
  let commandStarts = 0;
  let commandCompletions = 0;

  function appendRecovered(record, suffix, event, message, level = 'info') {
    const id = `rollout-${recoveryKey}-${record.line}-${suffix}`;
    if (db.prepare('SELECT 1 FROM worklog_events WHERE id=?').get(id)) return false;
    appendRuntimeWorklog(taskId, {
      id,
      turnId,
      ts: record.value.timestamp,
      kind: `runtime.${event.type}`,
      level,
      message,
      payload: {
        turnId,
        attemptId,
        recoveredFromRollout: true,
        rolloutLine: record.line,
        event,
      },
    }, event, attemptId, configuredWorkingDirectory);
    appendSessionLatestLog(taskId, `${JSON.stringify(event)}\n`);
    return true;
  }

  appendSessionLatestLog(taskId, `\nRECOVERED CODEX SESSION EVENTS sha256=${sourceHash}\n`);
  for (const record of records) {
    const envelope = record.value;
    const payload = envelope.payload || {};
    if (envelope.type === 'response_item') {
      const text = assistantText(payload);
      if (text) {
        const event = {
          type: 'item.completed',
          item: { id: payload.id, type: 'agent_message', text },
          recovered_from_rollout: { timestamp: envelope.timestamp, line: record.line },
        };
        if (appendRecovered(record, 'agent', event, text)) agentMessages += 1;
        continue;
      }
      if (payload.type === 'custom_tool_call') {
        const commands = toolCommands(payload).map((command, index) => ({
          ...command,
          runtimeItemId: commandsId(payload.call_id || payload.id, index),
        }));
        pendingTools.set(String(payload.call_id || payload.id), { record, payload, commands });
        for (const command of commands) {
          const event = {
            type: 'item.started',
            item: {
              id: command.runtimeItemId,
              type: 'command_execution',
              command: command.command,
              cwd: command.cwd || undefined,
              status: 'in_progress',
            },
            recovered_from_rollout: { timestamp: envelope.timestamp, line: record.line, tool: payload.name },
          };
          if (appendRecovered(record, `command-${command.runtimeItemId}-started`, event, command.command)) commandStarts += 1;
        }
        continue;
      }
      if (payload.type === 'custom_tool_call_output') {
        const callId = String(payload.call_id || '');
        const pending = pendingTools.get(callId);
        if (!pending) continue;
        const output = toolOutputText(payload.output);
        for (const command of pending.commands) {
          const event = {
            type: 'item.completed',
            item: {
              id: command.runtimeItemId,
              type: 'command_execution',
              command: command.command,
              cwd: command.cwd || undefined,
              aggregated_output: output,
              exit_code: null,
              status: 'completed',
            },
            recovered_from_rollout: { timestamp: envelope.timestamp, line: record.line, tool: pending.payload.name },
          };
          if (appendRecovered(record, `command-${command.runtimeItemId}-completed`, event, command.command)) commandCompletions += 1;
        }
        pendingTools.delete(callId);
      }
    }
  }

  for (const pending of pendingTools.values()) {
    for (const command of pending.commands) {
      const event = {
        type: 'item.completed',
        item: {
          id: command.runtimeItemId,
          type: 'command_execution',
          command: command.command,
          cwd: command.cwd || undefined,
          aggregated_output: 'No tool output was recorded before the Codex turn was interrupted.',
          exit_code: null,
          status: 'interrupted',
        },
        recovered_from_rollout: { timestamp: pending.record.value.timestamp, line: pending.record.line, tool: pending.payload.name },
      };
      if (appendRecovered(pending.record, `command-${command.runtimeItemId}-interrupted`, event, command.command, 'warn')) {
        commandCompletions += 1;
      }
    }
  }

  const summary = {
    sourceHash,
    rolloutPath,
    rolloutOffset: offset,
    agentMessages,
    commandStarts,
    commandCompletions,
  };
  appendSessionWorklog(taskId, {
    id: markerId,
    turnId,
    kind: 'runtime.rollout.recovered',
    message: `Recovered ${agentMessages} Agent messages and ${commandCompletions} command outputs from the Codex Session rollout.`,
    payload: summary,
  });
  appendAuditEvent({
    id: `audit-${markerId}`,
    actor: 'recovery-tool',
    scope: 'session',
    kind: 'session.rollout.recovered',
    message: `Recovered original Codex Session events for ${taskId}`,
    taskId,
    entityType: 'turn',
    entityId: turnId,
    payload: summary,
  });
  return { ok: true, alreadyRecovered: false, taskId, ...summary };
}

function commandsId(callId, index) {
  return `${String(callId || 'tool-call')}-${index + 1}`;
}

function main() {
  const result = recoverRollout(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = { recoverRollout, toolCommands, toolOutputText };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`recover-codex-rollout: ${error.stack || error.message}\n`);
    process.exitCode = Number(error.exitCode || 1);
  } finally {
    try { closeDatabase(); } catch {}
  }
}
