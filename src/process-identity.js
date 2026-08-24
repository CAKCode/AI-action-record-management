const fs = require('fs');

function inspectProcess(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid < 2 || process.platform !== 'linux') return null;
  let value;
  try {
    value = fs.readFileSync(`/proc/${normalizedPid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const commandEnd = value.lastIndexOf(') ');
  if (commandEnd < 0) return null;
  const fields = value.slice(commandEnd + 2).trim().split(/\s+/);
  const state = String(fields[0] || '');
  const parentPid = Number(fields[1]);
  const processGroupId = Number(fields[2]);
  const sessionId = Number(fields[3]);
  const startTicks = String(fields[19] || '');
  if (!/^[A-Za-z]$/.test(state)
    || ![parentPid, processGroupId, sessionId].every(Number.isInteger)
    || !/^\d+$/.test(startTicks)) return null;
  return {
    pid: normalizedPid,
    state,
    parentPid,
    processGroupId,
    sessionId,
    startTicks,
  };
}

function sameProcess(identity, options = {}) {
  if (!identity) return false;
  const current = inspectProcess(identity.pid);
  if (!current || current.startTicks !== String(identity.startTicks || '')) return false;
  if (Number(identity.processGroupId) !== current.processGroupId) return false;
  if (options.requireGroupLeader && current.processGroupId !== current.pid) return false;
  if (options.requireSessionLeader && current.sessionId !== current.pid) return false;
  if (options.parentPid != null && current.parentPid !== Number(options.parentPid)) return false;
  return true;
}

function processGroupStillBelongsTo(identity) {
  const leader = inspectProcess(identity?.pid);
  if (leader && leader.state !== 'Z') {
    return sameProcess(identity, { requireGroupLeader: true, requireSessionLeader: true });
  }
  if (process.platform !== 'linux') return false;
  let entries;
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return false;
    const member = inspectProcess(Number(entry.name));
    return member
      && member.state !== 'Z'
      && member.processGroupId === Number(identity.processGroupId)
      && member.sessionId === Number(identity.pid);
  });
}

function signalVerifiedProcessGroup(identity, signal = 'SIGKILL') {
  if (!processGroupStillBelongsTo(identity)) {
    return { signalled: false, reason: 'identity_mismatch' };
  }
  try {
    process.kill(-Number(identity.processGroupId), signal);
    return { signalled: true, reason: '' };
  } catch (error) {
    if (error?.code === 'ESRCH') return { signalled: false, reason: 'not_running' };
    throw error;
  }
}

module.exports = {
  inspectProcess,
  sameProcess,
  processGroupStillBelongsTo,
  signalVerifiedProcessGroup,
};
