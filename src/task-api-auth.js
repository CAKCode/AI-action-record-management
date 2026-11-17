const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { RUNTIME_DIR } = require('./paths');

const AUTH_FILE = path.join(RUNTIME_DIR, 'task-api-auth.json');

function writeTaskApiAuthentication({ baseUrl, user, password }, file = AUTH_FILE) {
  if (!user || !password) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ baseUrl, user, password }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function taskApiEnvironment(environment, args, file = AUTH_FILE) {
  if (environment.CODEX_TASK_API_USER || environment.CODEX_TASK_API_PASSWORD) return environment;
  let descriptor;
  let authentication;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('Invalid authentication context');
    authentication = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return environment;
    throw new Error('Local Task API authentication context could not be read');
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  const option = args.findIndex(arg => arg === '--base-url' || arg.startsWith('--base-url='));
  const explicitUrl = option < 0 ? '' : (args[option].includes('=') ? args[option].slice('--base-url='.length) : args[option + 1]);
  const target = explicitUrl || environment.CODEX_TASK_API_URL || authentication.baseUrl;
  if (!authentication.user || !authentication.password || !authentication.baseUrl) {
    throw new Error('Local Task API authentication context is incomplete');
  }
  if (new URL(target).origin !== new URL(authentication.baseUrl).origin) return environment;
  return { ...environment, CODEX_TASK_API_URL: target,
    CODEX_TASK_API_USER: authentication.user, CODEX_TASK_API_PASSWORD: authentication.password };
}

module.exports = { writeTaskApiAuthentication, taskApiEnvironment };
