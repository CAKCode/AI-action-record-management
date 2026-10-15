const fs = require('node:fs');
const path = require('node:path');

function measureTaskStorage(sessionRoot, snapshotRoot) {
  const usage = { platformBytes: 0, archiveBytes: 0, snapshotBytes: 0, files: 0, unreadableEntries: 0 };
  const seen = new Set();
  const pending = [
    { target: sessionRoot, bucket: 'platformBytes' },
    { target: snapshotRoot, bucket: 'snapshotBytes' },
  ];
  while (pending.length) {
    const { target, bucket } = pending.pop();
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (error.code !== 'ENOENT') usage.unreadableEntries += 1;
      continue;
    }
    const identity = `${stat.dev}:${stat.ino}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    usage[bucket] += Number(stat.size || 0);
    if (stat.isFile()) usage.files += 1;
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    try {
      for (const entry of fs.readdirSync(target)) {
        pending.push({
          target: path.join(target, entry),
          bucket: target === sessionRoot && entry === 'skill-report-artifacts' ? 'archiveBytes' : bucket,
        });
      }
    } catch {
      usage.unreadableEntries += 1;
    }
  }
  usage.totalBytes = usage.platformBytes + usage.archiveBytes + usage.snapshotBytes;
  return usage;
}

module.exports = { measureTaskStorage };
