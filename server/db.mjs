// SQLite storage for the prayer tracker.
// Uses node:sqlite (built into Node 22+), so the project has zero npm dependencies.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Every member column the app actually reads or writes. Order matters: the
// upsert statement below is generated from this list.
export const MEMBER_FIELDS = [
  'first', 'last', 'phone', 'email', 'dob',
  'status', 'statusDate', 'notes', 'lastPrayerRef',
  'hasCalling', 'notBaptized', 'deceasedDate', 'movedDate', 'followupOverride',
];

// hasCalling/notBaptized are booleans in the app but INTEGER in SQLite.
const BOOL_FIELDS = new Set(['hasCalling', 'notBaptized']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id               TEXT PRIMARY KEY,
  first            TEXT NOT NULL DEFAULT '',
  last             TEXT NOT NULL DEFAULT '',
  phone            TEXT,
  email            TEXT,
  dob              TEXT,
  status           TEXT NOT NULL DEFAULT 'active',
  statusDate       TEXT,
  notes            TEXT,
  lastPrayerRef    TEXT,
  hasCalling       INTEGER NOT NULL DEFAULT 0,
  notBaptized      INTEGER NOT NULL DEFAULT 0,
  deceasedDate     TEXT,
  movedDate        TEXT,
  followupOverride TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One prayer assignment per Sunday; the date is the natural key, matching the
-- app's own "one log entry per date" rule.
CREATE TABLE IF NOT EXISTS log (
  date       TEXT PRIMARY KEY,
  opening    TEXT REFERENCES members(id) ON DELETE SET NULL,
  closing    TEXT REFERENCES members(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_log_opening    ON log(opening);
CREATE INDEX IF NOT EXISTS idx_log_closing    ON log(closing);
`;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL keeps reads from blocking the writer — matters once the phone and the
  // desktop are both polling.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function rowToMember(row) {
  const m = { id: row.id };
  for (const f of MEMBER_FIELDS) {
    const v = row[f];
    if (BOOL_FIELDS.has(f)) {
      // The app treats these as plain booleans and omits them when false.
      if (v) m[f] = true;
    } else {
      m[f] = v === null ? (f === 'notes' ? '' : null) : v;
    }
  }
  return m;
}

// Rebuilds the exact object shape the browser app expects, so the client-side
// code that renders it needs no changes.
export function readState(db) {
  const members = db
    .prepare('SELECT * FROM members ORDER BY last, first')
    .all()
    .map(rowToMember);

  const log = db
    .prepare('SELECT date, opening, closing FROM log ORDER BY date DESC')
    .all()
    .map((r) => ({ date: r.date, opening: r.opening, closing: r.closing }));

  // Two namespaces live in `settings`: 'ypt.*' is the training-email wording,
  // 'suggest.*' is the per-group suggestion tuning the Suggest tab exposes.
  const ypt = {};
  const suggest = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    const v = r.value === null ? null : JSON.parse(r.value);
    if (r.key.startsWith('ypt.')) ypt[r.key.slice(4)] = v;
    else if (r.key.startsWith('suggest.')) suggest[r.key.slice(8)] = v;
  }

  return { members, log, ypt, suggest };
}

export function countRows(db) {
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return { members: n('members'), log: n('log'), settings: n('settings') };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const UPSERT_MEMBER = `
INSERT INTO members (id, ${MEMBER_FIELDS.join(', ')}, updated_at)
VALUES (?, ${MEMBER_FIELDS.map(() => '?').join(', ')}, datetime('now'))
ON CONFLICT(id) DO UPDATE SET
  ${MEMBER_FIELDS.map((f) => `${f} = excluded.${f}`).join(',\n  ')},
  updated_at = datetime('now')
`;

const UPSERT_LOG = `
INSERT INTO log (date, opening, closing, updated_at)
VALUES (?, ?, ?, datetime('now'))
ON CONFLICT(date) DO UPDATE SET
  opening = excluded.opening,
  closing = excluded.closing,
  updated_at = datetime('now')
`;

function memberParams(m) {
  const out = [m.id];
  for (const f of MEMBER_FIELDS) {
    let v = m[f];
    if (BOOL_FIELDS.has(f)) v = v ? 1 : 0;
    else if (v === undefined) v = null;
    else if (typeof v === 'boolean') v = v ? 1 : 0;
    out.push(v);
  }
  return out;
}

/**
 * Applies a delta produced by the browser. Everything runs in one transaction,
 * so a failed sync leaves the database exactly as it was.
 *
 * delta = {
 *   members:        [ {...} ],   // upserts
 *   deletedMembers: [ 'id' ],
 *   log:            [ {date, opening, closing} ],
 *   deletedLog:     [ 'YYYY-MM-DD' ],
 *   settings:       { 'ypt.subject': <value>, ... },
 *   replaceAll:     false        // true => wipe first (import / reset)
 * }
 */
export function applyDelta(db, delta) {
  const upsertMember = db.prepare(UPSERT_MEMBER);
  const upsertLog = db.prepare(UPSERT_LOG);
  const delMember = db.prepare('DELETE FROM members WHERE id = ?');
  const delLog = db.prepare('DELETE FROM log WHERE date = ?');
  const putSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );

  const applied = { members: 0, deletedMembers: 0, log: 0, deletedLog: 0, settings: 0 };

  db.exec('BEGIN IMMEDIATE');
  try {
    if (delta.replaceAll) {
      // "Replace all current data" means settings too, otherwise importing a
      // backup that carries no ypt block leaves the old wording in place.
      db.exec('DELETE FROM log');
      db.exec('DELETE FROM members');
      db.exec('DELETE FROM settings');
    }

    // Members before log entries, so the log's foreign keys always resolve.
    for (const m of delta.members ?? []) {
      if (!m || !m.id) continue;
      upsertMember.run(...memberParams(m));
      applied.members++;
    }

    for (const date of delta.deletedLog ?? []) {
      delLog.run(date);
      applied.deletedLog++;
    }

    // Drop log rows that point at a member being removed, otherwise the
    // ON DELETE SET NULL would silently leave a half-empty entry behind.
    for (const id of delta.deletedMembers ?? []) {
      delMember.run(id);
      applied.deletedMembers++;
    }

    for (const e of delta.log ?? []) {
      if (!e || !e.date) continue;
      upsertLog.run(e.date, e.opening ?? null, e.closing ?? null);
      applied.log++;
    }

    for (const [k, v] of Object.entries(delta.settings ?? {})) {
      putSetting.run(k, v === undefined ? null : JSON.stringify(v));
      applied.settings++;
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return applied;
}

// Loads a whole exported state object, replacing everything. Used by import.mjs
// and by the app's "import backup" button.
export function replaceState(db, state) {
  const settings = {};
  for (const [k, v] of Object.entries(state.ypt ?? {})) settings['ypt.' + k] = v;
  for (const [k, v] of Object.entries(state.suggest ?? {})) settings['suggest.' + k] = v;
  return applyDelta(db, {
    replaceAll: true,
    members: state.members ?? [],
    log: state.log ?? [],
    settings,
  });
}
