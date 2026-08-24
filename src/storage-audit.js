const crypto = require('crypto');

const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function createStorageAuditRecorder(appendEvents, options = {}) {
  if (typeof appendEvents !== 'function') throw new TypeError('appendEvents must be a function');
  const now = options.now || (() => new Date().toISOString());
  const onError = options.onError || (() => {});
  const outbox = options.outbox || null;
  const states = new Map();

  const categoryState = (category) => {
    const normalized = String(category || '');
    if (!CATEGORY_PATTERN.test(normalized)) throw new Error('Invalid storage audit category');
    if (!states.has(normalized)) {
      states.set(normalized, {
        auditFailureCount: 0,
        unrecordedAuditEventCount: 0,
        lastAuditErrorAt: '',
        lastAuditError: '',
        lastAuditRecoveryAt: '',
        auditQueueDurable: true,
        outboxFailureCount: 0,
        lastOutboxErrorAt: '',
        lastOutboxError: '',
        pendingEvents: [],
      });
    }
    return states.get(normalized);
  };

  const pendingCategories = () => Object.fromEntries(
    [...states.entries()]
      .filter(([, state]) => state.pendingEvents.length > 0)
      .map(([category, state]) => [category, state.pendingEvents]),
  );

  const persistPending = (category, publicMessage = 'Storage audit outbox persistence failed') => {
    const state = categoryState(category);
    if (!outbox) {
      state.auditQueueDurable = state.pendingEvents.length === 0;
      return state.auditQueueDurable;
    }
    try {
      outbox.save(pendingCategories());
      for (const current of states.values()) current.auditQueueDurable = true;
      return true;
    } catch (error) {
      state.auditQueueDurable = state.pendingEvents.length === 0;
      state.outboxFailureCount += 1;
      state.lastOutboxErrorAt = now();
      state.lastOutboxError = publicMessage;
      try { onError(error, { category, eventCount: state.pendingEvents.length, context: { outbox: true } }); } catch {}
      return false;
    }
  };

  if (outbox) {
    const loaded = outbox.load();
    for (const [category, events] of Object.entries(loaded)) {
      const state = categoryState(category);
      state.pendingEvents = events;
      state.unrecordedAuditEventCount = events.length;
      state.auditQueueDurable = true;
    }
  }

  const stableEvents = (events) => events.map((event) => ({
    ...event,
    id: event.id || `audit-${crypto.randomUUID()}`,
    ts: event.ts || now(),
  }));

  const finishCommittedBatch = (category, state, batch, recovered) => {
    state.pendingEvents = [];
    state.unrecordedAuditEventCount = 0;
    if (recovered) state.lastAuditRecoveryAt = now();
    if (!persistPending(category, 'Storage audit outbox cleanup failed')) {
      state.pendingEvents = batch;
      state.unrecordedAuditEventCount = 0;
      state.auditQueueDurable = true;
    }
  };

  return {
    record(category, events, context = {}) {
      if (!Array.isArray(events) || events.length === 0) throw new Error('Storage audit events must be a non-empty array');
      const state = categoryState(category);
      const pendingCount = state.pendingEvents.length;
      const batch = [...state.pendingEvents, ...stableEvents(events)];
      state.pendingEvents = batch;
      state.unrecordedAuditEventCount = batch.length;
      persistPending(category);
      try {
        appendEvents(batch);
        finishCommittedBatch(category, state, batch, pendingCount > 0);
        return true;
      } catch (error) {
        state.auditFailureCount += 1;
        state.unrecordedAuditEventCount = batch.length;
        state.lastAuditErrorAt = now();
        state.lastAuditError = String(context.publicMessage || 'Storage audit persistence failed');
        try { onError(error, { category, eventCount: batch.length, context }); } catch {}
        return false;
      }
    },
    retry(category) {
      const state = categoryState(category);
      if (state.pendingEvents.length === 0) return true;
      const pending = [...state.pendingEvents];
      persistPending(category);
      try {
        appendEvents(pending);
        finishCommittedBatch(category, state, pending, true);
        return true;
      } catch (error) {
        state.auditFailureCount += 1;
        state.lastAuditErrorAt = now();
        state.lastAuditError = 'Storage audit retry failed';
        try { onError(error, { category, eventCount: pending.length, context: { retry: true } }); } catch {}
        return false;
      }
    },
    retryAll() {
      let ok = true;
      for (const category of states.keys()) {
        if (!this.retry(category)) ok = false;
      }
      return ok;
    },
    status(category) {
      const { pendingEvents, ...status } = categoryState(category);
      return { ...status };
    },
  };
}

module.exports = { createStorageAuditRecorder };
