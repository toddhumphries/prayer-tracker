// Prayer tracker server: static files + a small JSON API over SQLite.
// No npm dependencies — node:http and node:sqlite only.
//
//   node server.mjs [--port 8787] [--db data/prayer-tracker.db]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, readState, applyDelta, replaceState, countRows } from './db.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.PORT || 8787));
// '::' binds dual-stack, accepting both IPv6 and IPv4. Windows resolves
// "localhost" to ::1 first, so an IPv4-only bind makes localhost flaky.
const HOST = arg('host', process.env.HOST || '::');
const DB_PATH = arg('db', process.env.DB_PATH || join(ROOT, 'data', 'prayer-tracker.db'));

const db = openDb(DB_PATH);

// Bumped on every successful write. The client sends the version it last saw;
// if the server has moved past it, the client knows to reload before saving.
let version = 1;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function serveStatic(req, res, pathname) {
  // normalize + prefix check keeps "../.." out of the filesystem.
  const rel = normalize(pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''));
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      // The app is edited in place often enough that caching just causes confusion.
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    // --- API ---------------------------------------------------------------

    // Whole state, in the shape the browser app already uses.
    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, { version, state: readState(db) });
    }

    // Cheap poll target so other devices notice changes without pulling 125KB.
    if (pathname === '/api/version' && req.method === 'GET') {
      return sendJson(res, 200, { version });
    }

    // Incremental save. Body: { baseVersion, delta }
    if (pathname === '/api/sync' && req.method === 'POST') {
      const body = await readBody(req);
      const { baseVersion, delta } = body;

      // Someone else wrote since this client last read. Tell it to reload and
      // replay rather than overwriting their changes.
      if (typeof baseVersion === 'number' && baseVersion !== version) {
        return sendJson(res, 409, {
          error: 'stale',
          version,
          state: readState(db),
        });
      }

      const applied = applyDelta(db, delta ?? {});
      version++;
      return sendJson(res, 200, { version, applied });
    }

    // Full replace, used by the app's "import backup" button.
    if (pathname === '/api/import' && req.method === 'POST') {
      const state = await readBody(req);
      if (!Array.isArray(state.members) || !Array.isArray(state.log)) {
        return sendJson(res, 400, { error: 'Expected an object with members[] and log[].' });
      }
      const applied = replaceState(db, state);
      version++;
      return sendJson(res, 200, { version, applied, state: readState(db) });
    }

    // Server-side backup download, so a phone can grab a backup too.
    if (pathname === '/api/export' && req.method === 'GET') {
      const state = readState(db);
      const name = 'prayer-tracker-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      const buf = Buffer.from(JSON.stringify(state, null, 2));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Content-Length': buf.length,
      });
      return res.end(buf);
    }

    if (pathname === '/api/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, version, counts: countRows(db), db: DB_PATH });
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'Unknown endpoint ' + pathname });
    }

    // --- Static ------------------------------------------------------------
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(`[error] ${req.method} ${pathname}:`, err.message);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
    else res.end();
  }
});

function announce() {
  const counts = countRows(db);
  console.log(`prayer-tracker listening on port ${PORT}`);
  console.log(`  local:    http://localhost:${PORT}`);
  console.log(`  database: ${DB_PATH}`);
  console.log(`  contents: ${counts.members} members, ${counts.log} log entries`);
  if (counts.members === 0) {
    console.log('  (empty — seed it with:  node import.mjs <backup.json>)');
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — is the server already running?`);
    console.error(`use a different one with:  node server.mjs --port 8788`);
    process.exit(1);
  }
  // Hosts with IPv6 disabled can't bind '::'; fall back to IPv4.
  if (HOST === '::' && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL' || err.code === 'EINVAL')) {
    console.log("IPv6 unavailable, falling back to IPv4");
    server.listen(PORT, '0.0.0.0', announce);
    return;
  }
  console.error('server error:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, announce);

// Make sure WAL contents are folded back into the .db file on a clean exit.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nshutting down…');
    try { db.close(); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
