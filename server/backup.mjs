// Writes a timestamped backup. Safe to run while the server is running:
// VACUUM INTO takes a consistent snapshot without stopping writes, and the
// JSON copy stays readable by the app's own "import backup" button.
//
//   node backup.mjs                  -> backups/prayer-tracker-YYYY-MM-DD.{db,json}
//   node backup.mjs --out D:/somewhere --keep 30

import { mkdirSync, writeFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, readState, countRows } from './db.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dbPath = arg('db', join(ROOT, 'data', 'prayer-tracker.db'));
const outDir = arg('out', join(ROOT, 'backups'));
const keep = Number(arg('keep', 30));

mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const db = openDb(dbPath);
const counts = countRows(db);

// Binary snapshot — the thing to restore from.
const dbOut = join(outDir, `prayer-tracker-${stamp}.db`);
db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);

// JSON copy — readable, and importable through the app's own UI.
const jsonOut = join(outDir, `prayer-tracker-${stamp}.json`);
writeFileSync(jsonOut, JSON.stringify(readState(db), null, 2));
db.close();

console.log(`backed up ${counts.members} members, ${counts.log} log entries`);
console.log(`  ${dbOut}`);
console.log(`  ${jsonOut}`);

// Retention: keep the N most recent of each kind.
for (const ext of ['.db', '.json']) {
  const files = readdirSync(outDir)
    .filter((f) => f.startsWith('prayer-tracker-') && f.endsWith(ext))
    .map((f) => ({ f, t: statSync(join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) {
    unlinkSync(join(outDir, f));
    console.log(`  removed old backup ${f}`);
  }
}
