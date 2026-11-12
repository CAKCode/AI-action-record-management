const crypto = require('crypto');
const { claimReleaseCycleDeletions, processReleaseCycleDeletion } = require('./store');

function createReleaseCycleDeletionManager(options = {}) {
  const owner = `cycle-deletion-${process.pid}-${crypto.randomUUID()}`;
  let pending = null;
  let stopped = false;
  function sweep() {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      for (const job of claimReleaseCycleDeletions(owner)) {
        await processReleaseCycleDeletion(job, owner, options);
      }
    }).finally(() => { pending = null; });
    return pending;
  }
  async function shutdown() {
    stopped = true;
    if (pending) await pending;
  }
  return { sweep, shutdown };
}

module.exports = { createReleaseCycleDeletionManager };
