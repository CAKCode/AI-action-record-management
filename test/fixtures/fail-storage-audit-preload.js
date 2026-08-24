const store = require('../../src/store');

const targetKind = String(process.env.CODEX_TEST_STORAGE_AUDIT_KIND || '');
let remainingFailures = Number(process.env.CODEX_TEST_STORAGE_AUDIT_FAILURES || 1);

for (const method of ['appendAuditEvents', 'appendAuditEventsIdempotent']) {
  const original = store[method];
  store[method] = (events, ...args) => {
    if (remainingFailures > 0 && events.some((event) => event.kind === targetKind)) {
      remainingFailures -= 1;
      const error = new Error(`Injected storage audit failure for ${targetKind}`);
      error.code = 'INJECTED_STORAGE_AUDIT_FAILURE';
      throw error;
    }
    return original(events, ...args);
  };
}
