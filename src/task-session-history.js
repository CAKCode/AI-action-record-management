'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SESSIONS_DIR } = require('./paths');
const { resolveBridgeSessionRuntime } = require('./bridge-runtime-cleanup');

function historyDirectory(taskId, sessionKey) {
  const key = crypto.createHash('sha256').update(sessionKey).digest('hex');
  return path.join(SESSIONS_DIR, taskId, 'session-history', key);
}

function regularDirectory(directory) {
  try { const stat = fs.lstatSync(directory); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// These are resume files, never media or tool caches. Hard links also survive a
// separate Bridge TTL cleanup of its temporary Codex Home without another copy.
function linkRollouts(source, target) {
  if (!regularDirectory(source)) return 0;
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) { count += linkRollouts(from, to); continue; }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const sourceStat = fs.statSync(from);
    let targetStat;
    try { targetStat = fs.lstatSync(to); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) throw Error('Session history path is not a regular file');
    if (targetStat && ((targetStat.dev === sourceStat.dev && targetStat.ino === sourceStat.ino)
      || targetStat.size > sourceStat.size)) { count++; continue; }
    const temporary = to + '.' + crypto.randomUUID() + '.tmp';
    try {
      try { fs.linkSync(from, temporary); } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        fs.copyFileSync(from, temporary);
      }
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, to);
      count++;
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  return count;
}

function retainTaskSessionHistory(taskId, sessionKey, runtime = resolveBridgeSessionRuntime(sessionKey)) {
  if (!runtime) return 0;
  return linkRollouts(path.join(runtime.codexHome, 'sessions'), historyDirectory(taskId, sessionKey));
}

function refreshTaskCredentials(codexHome, environment) {
  const sourceHome = environment.CODEX_SOURCE_HOME || environment.SOURCE_CODEX_HOME || environment.CODEX_HOME;
  if (!sourceHome || path.resolve(sourceHome) === path.resolve(codexHome)) return;
  for (const fileName of ['auth.json', 'config.toml']) {
    const source = path.join(sourceHome, fileName);
    let stat;
    try { stat = fs.statSync(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile()) continue;
    const target = path.join(codexHome, fileName);
    const temporary = target + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, fs.readFileSync(source), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, target);
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}

function restoreTaskSessionHistory(taskId, runtime) {
  const retained = historyDirectory(taskId, runtime.sessionKey);
  const sessions = path.join(runtime.codexHome, 'sessions');
  if (regularDirectory(retained)) {
    fs.mkdirSync(runtime.codexHome, { recursive: true, mode: 0o700 });
    linkRollouts(retained, sessions);
  }
}

function prepareTaskSessionResume(taskId, runtime, environment = process.env) {
  restoreTaskSessionHistory(taskId, runtime);
  const sessions = path.join(runtime.codexHome, 'sessions');
  if (!regularDirectory(sessions)) {
    const error = new Error('This Task session history was previously removed; its thread ID alone cannot restore it. Task reports and transcripts are retained.');
    error.statusCode = 409;
    throw error;
  }
  retainTaskSessionHistory(taskId, runtime.sessionKey, runtime);
  refreshTaskCredentials(runtime.codexHome, environment);
}

module.exports = { historyDirectory, retainTaskSessionHistory, restoreTaskSessionHistory, prepareTaskSessionResume };
