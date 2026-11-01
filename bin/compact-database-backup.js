#!/usr/bin/env node

process.umask(0o077);

const Database = require('better-sqlite3');

// Only the unpublished backup copy is opened here. Run VACUUM outside Web's
// event loop so report requests and Task heartbeats continue during compaction.
const database = new Database(process.argv[2], { fileMustExist: true });
try {
  database.pragma('journal_mode = DELETE');
  database.prepare('VACUUM INTO ?').run(process.argv[3]);
} finally {
  database.close();
}
