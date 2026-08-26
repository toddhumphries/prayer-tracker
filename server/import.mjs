// Seed the database from a prayer-tracker backup JSON export.
//
//   node import.mjs ../prayer-tracker-backup-2026-05-21.json
//   node import.mjs backup.json --db data/prayer-tracker.db
//
// This REPLACES everything currently in the database.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, replaceState, countRows } from './db.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const file = process.argv[2];
if (!file || file.startsWith('--')) {
  console.error('usage: node import.mjs <backup.json> [--db path]');
  process.exit(1);
}

const dbPath = arg('db', join(ROOT, 'data', 'prayer-tracker.db'));
const state = JSON.parse(readFileSync(file, 'utf8'));

if (!Array.isArray(state.members) || !Array.isArray(state.log)) {
  console.error('Not a prayer-tracker backup: expected members[] and log[].');
  process.exit(1);
}

const db = openDb(dbPath);
const before = countRows(db);
if (before.members > 0) {
  console.log(`warning: replacing existing data (${before.members} members, ${before.log} log entries)`);
}

const applied = replaceState(db, state);
const after = countRows(db);

console.log(`imported ${file}`);
console.log(`  -> ${dbPath}`);
console.log(`  ${after.members} members, ${after.log} log entries, ${after.settings} settings`);

// Cross-check that nothing was silently dropped by a missing id.
const skipped = state.members.length - applied.members;
if (skipped > 0) console.log(`  note: ${skipped} member record(s) skipped (missing id)`);

db.close();
