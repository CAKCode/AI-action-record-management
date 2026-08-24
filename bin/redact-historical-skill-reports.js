#!/usr/bin/env node

process.umask(0o077);

const { redactHistoricalSkillReports } = require('../src/store');
const { closeDatabase } = require('../src/database');

function parseArguments(argv) {
  if (argv.length === 0) return { apply: false };
  if (argv.length === 1 && argv[0] === '--apply') return { apply: true };
  throw new Error('Usage: redact-historical-skill-reports.js [--apply]');
}

async function main() {
  const { apply } = parseArguments(process.argv.slice(2));
  const result = redactHistoricalSkillReports();
  return { applied: apply, ...result };
}

main().then((result) => {
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
}).finally(() => {
  closeDatabase();
});
