// Starts a server on a throwaway database, runs both suites against it, and
// cleans up. Never touches data/prayer-tracker.db.
//
//   npm test

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanDb(db) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(db + suffix); } catch {}
  }
}

async function waitForServer(port) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

// Each suite gets a fresh database and its own server, so one suite's leftovers
// can never make the next one pass or fail spuriously.
async function suite(name, script, port) {
  const db = join(ROOT, 'data', `ci-${name}.db`);
  cleanDb(db);
  const server = spawn(
    process.execPath,
    ['--no-warnings', 'server.mjs', '--port', String(port), '--db', db, '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] }
  );
  try {
    if (!(await waitForServer(port))) {
      console.error(`${name}: server did not come up`);
      return 1;
    }
    console.log(`=== ${name} suite ===`);
    return await new Promise((resolve) => {
      const p = spawn(process.execPath, ['--no-warnings', script, '--port', String(port)], { cwd: ROOT, stdio: 'inherit' });
      p.on('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    server.kill();
    await sleep(400);
    cleanDb(db);
  }
}

const a = await suite('api', 'test-api.mjs', 8899);
console.log('');
const b = await suite('client', 'test-client.mjs', 8898);

const failed = a || b;
console.log(failed ? '\nFAILED' : '\nALL SUITES PASSED');
process.exitCode = failed;
