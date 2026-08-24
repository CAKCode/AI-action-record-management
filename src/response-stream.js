'use strict';

function pipeResponseStream(res, stream, options = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let idleTimer = null;
    const idleTimeoutMs = Number(options.idleTimeoutMs || 0);
    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const refreshIdleTimer = () => {
      if (!idleTimeoutMs || settled || stream.destroyed) return;
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (settled || stream.destroyed || res.destroyed || res.writableEnded) return;
        options.onIdleTimeout?.();
        const error = Object.assign(new Error('Log stream made no transfer progress before its idle timeout'), {
          code: 'LOG_STREAM_IDLE_TIMEOUT',
        });
        stream.destroy(error);
      }, idleTimeoutMs);
      idleTimer.unref();
    };
    const onResponseClose = () => {
      clearIdleTimer();
      stream.destroy();
    };
    const onStreamError = (error) => {
      if (!res.destroyed) res.destroy(error);
    };
    const onStreamClose = () => {
      if (settled) return;
      settled = true;
      clearIdleTimer();
      res.off('close', onResponseClose);
      res.off('drain', refreshIdleTimer);
      stream.off('data', refreshIdleTimer);
      stream.off('error', onStreamError);
      resolve();
    };
    res.once('close', onResponseClose);
    res.on('drain', refreshIdleTimer);
    stream.on('data', refreshIdleTimer);
    stream.once('error', onStreamError);
    stream.once('close', onStreamClose);
    if (res.destroyed || res.writableEnded) {
      stream.destroy();
      return;
    }
    refreshIdleTimer();
    stream.pipe(res);
  });
}

module.exports = { pipeResponseStream };
