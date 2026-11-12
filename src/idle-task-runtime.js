'use strict';

const { releaseBridgeSessionProcessAndWait } = require('./bridge-runtime-cleanup');

// Runs beside the interactive CLI manager, so cleanup can exclude every live CLI.
// The short database lease also makes Worker starts wait for process exit.
function createIdleTaskRuntimeManager(options) {
  const pending = new Map();
  const release = options.release || releaseBridgeSessionProcessAndWait;
  let stopped = false;
  let cycle = null;

  function releaseTask(taskId) {
    if (stopped || options.isInteractive(taskId) || pending.has(taskId)) return null;
    const lease = options.claim(taskId);
    if (!lease) return null;
    const operation = Promise.resolve().then(async () => {
      options.retain?.(lease.taskId, lease.sessionKey);
      const result = await release(lease.sessionKey, { sourceDir: lease.sourceDir, includeCliMain: true });
      options.retain?.(lease.taskId, lease.sessionKey);
      return result;
    })
      .catch(error => ({ sessionId: '', released: [], errors: [{ error: error.message }] }))
      .then(result => {
        options.finish(lease, result);
        if (!result.errors.length && !result.skipped) options.onReleased?.(lease, result);
        return result;
      }).finally(() => pending.delete(taskId));
    pending.set(taskId, operation);
    return operation;
  }

  function sweep() {
    if (stopped) return Promise.resolve([]);
    if (cycle) return cycle;
    cycle = (async () => {
      const results = [];
      for (const taskId of options.list()) {
        if (stopped) break;
        try {
          const operation = releaseTask(taskId);
          if (operation) results.push(await operation);
        } catch (error) { options.onError?.(error); }
      }
      if (!stopped && options.sweepOrphans) {
        try { results.push(...await options.sweepOrphans()); }
        catch (error) { options.onError?.(error); }
      }
      return results;
    })().finally(() => { cycle = null; });
    return cycle;
  }

  async function beforeConnect(taskId) {
    const operation = pending.get(taskId);
    if (operation) await operation;
    // A previous Web process may have stopped in the middle of a release.
    while (options.getRelease(taskId)) await new Promise(resolve => setTimeout(resolve, 50));
  }

  async function shutdown() {
    stopped = true;
    if (cycle) await cycle;
    await Promise.allSettled([...pending.values()]);
  }

  return { sweep, beforeConnect, shutdown };
}

module.exports = { createIdleTaskRuntimeManager };
