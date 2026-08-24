'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { inspectProcess } = require('./process-identity');

const CGROUP_MOUNT = '/sys/fs/cgroup';

function taskCgroupName(taskId) {
  return `task-${crypto.createHash('sha256').update(String(taskId)).digest('hex').slice(0, 32)}`;
}

function configuredCgroupRoot(fsModule = fs, cgroupMount = CGROUP_MOUNT) {
  const configured = String(process.env.CODEX_TASK_CGROUP_ROOT || '').trim()
    || currentProcessCgroupPath(fsModule, cgroupMount);
  if (!configured || !path.isAbsolute(configured)) return null;
  let root;
  try {
    root = fsModule.realpathSync(configured);
    const stat = fsModule.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    if (!pathContains(cgroupMount, root)) return null;
    if (!fsModule.existsSync(path.join(root, 'cgroup.procs'))
      || !fsModule.existsSync(path.join(root, 'cgroup.controllers'))) return null;
  } catch {
    return null;
  }
  return root;
}

function currentProcessCgroupPath(fsModule, cgroupMount) {
  try {
    const record = fsModule.readFileSync('/proc/self/cgroup', 'utf8')
      .split(/\r?\n/)
      .find((line) => line.startsWith('0::'));
    const relative = String(record || '').slice(3);
    if (!relative.startsWith('/') || relative.includes('\0')) return '';
    const segments = relative.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '.' || segment === '..')) return '';
    return path.join(cgroupMount, ...segments);
  } catch {
    return '';
  }
}

function pathContains(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function taskCgroupPath(taskId, fsModule = fs, cgroupMount = CGROUP_MOUNT) {
  const root = configuredCgroupRoot(fsModule, cgroupMount);
  return root ? path.join(root, taskCgroupName(taskId)) : null;
}

function groupMembers(identity, procRoot = '/proc') {
  let entries;
  try {
    entries = fs.readdirSync(procRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return [];
    const member = inspectProcess(Number(entry.name));
    return member
      && member.processGroupId === Number(identity.processGroupId)
      && member.sessionId === Number(identity.pid)
      ? [member.pid]
      : [];
  });
}

function placeExternalAttemptInTaskCgroup({ taskId, identity }, options = {}) {
  const fsModule = options.fsModule || fs;
  const members = options.groupMembers || groupMembers;
  if (!identity || !Number.isInteger(Number(identity.pid)) || !/^\d+$/.test(String(identity.startTicks || ''))) {
    return { attached: false, reason: 'invalid_identity' };
  }
  const root = configuredCgroupRoot(fsModule, options.cgroupMount || CGROUP_MOUNT);
  if (!root) return { attached: false, reason: 'cgroup_unavailable' };
  const cgroupPath = path.join(root, taskCgroupName(taskId));
  try {
    fsModule.mkdirSync(cgroupPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return { attached: false, reason: error?.code || 'cgroup_create_failed' };
  }
  let stat;
  try {
    stat = fsModule.lstatSync(cgroupPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { attached: false, reason: 'cgroup_path_invalid' };
    const pids = members(identity);
    if (!pids.length) return { attached: false, reason: 'process_group_not_running' };
    for (const pid of pids) fsModule.writeFileSync(path.join(cgroupPath, 'cgroup.procs'), `${pid}\n`);
    return { attached: true, path: cgroupPath, inode: String(stat.ino), members: pids.length };
  } catch (error) {
    return { attached: false, reason: error?.code || 'cgroup_attach_failed' };
  }
}

function killVerifiedTaskCgroup({ taskId, cgroupPath, cgroupInode }, options = {}) {
  const fsModule = options.fsModule || fs;
  const root = configuredCgroupRoot(fsModule, options.cgroupMount || CGROUP_MOUNT);
  const expectedPath = root ? path.join(root, taskCgroupName(taskId)) : null;
  if (!root || !expectedPath || path.resolve(cgroupPath || '') !== expectedPath) {
    return { killed: false, reason: 'cgroup_unavailable_or_mismatch' };
  }
  try {
    const stat = fsModule.lstatSync(expectedPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.ino) !== String(cgroupInode || '')) {
      return { killed: false, reason: 'cgroup_identity_mismatch' };
    }
    const members = String(fsModule.readFileSync(path.join(expectedPath, 'cgroup.procs'), 'utf8'))
      .trim().split(/\s+/).filter(Boolean);
    if (!members.length) return { killed: false, reason: 'cgroup_empty' };
    fsModule.writeFileSync(path.join(expectedPath, 'cgroup.kill'), '1\n');
    return { killed: true, reason: '', members: members.length };
  } catch (error) {
    return { killed: false, reason: error?.code || 'cgroup_kill_failed' };
  }
}

function inspectVerifiedTaskCgroup({ taskId, cgroupPath, cgroupInode }, options = {}) {
  const fsModule = options.fsModule || fs;
  const root = configuredCgroupRoot(fsModule, options.cgroupMount || CGROUP_MOUNT);
  const expectedPath = root ? path.join(root, taskCgroupName(taskId)) : null;
  if (!root || !expectedPath || path.resolve(cgroupPath || '') !== expectedPath) {
    return { verified: false, active: false, reason: 'cgroup_unavailable_or_mismatch' };
  }
  try {
    const stat = fsModule.lstatSync(expectedPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.ino) !== String(cgroupInode || '')) {
      return { verified: false, active: false, reason: 'cgroup_identity_mismatch' };
    }
    const readIds = (name) => String(fsModule.readFileSync(path.join(expectedPath, name), 'utf8'))
      .trim().split(/\s+/).filter((value) => /^\d+$/.test(value));
    const processes = readIds('cgroup.procs');
    let threads = [];
    try { threads = readIds('cgroup.threads'); } catch {}
    return {
      verified: true,
      active: processes.length > 0 || threads.length > 0,
      reason: '',
      processes: processes.length,
      threads: threads.length,
    };
  } catch (error) {
    return { verified: false, active: false, reason: error?.code || 'cgroup_inspection_failed' };
  }
}

module.exports = {
  configuredCgroupRoot,
  currentProcessCgroupPath,
  taskCgroupName,
  taskCgroupPath,
  placeExternalAttemptInTaskCgroup,
  killVerifiedTaskCgroup,
  inspectVerifiedTaskCgroup,
};
