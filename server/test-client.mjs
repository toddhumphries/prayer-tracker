// Runs the browser app's real storage layer (extracted verbatim from
// public/index.html) against a live server, under a minimal DOM stub.
// This is what proves the diff logic in the page actually works.
//
//   node server.mjs --port 8790 --db data/test-client.db   (other shell)
//   node test-client.mjs --port 8790

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const port = process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1] : '8790';
const BASE = `http://127.0.0.1:${port}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polls instead of guessing a fixed delay, so the debounce + round trip can't
// make a passing case look like a failure.
async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(100); }
  return false;
}
const serverState = async () => (await (await fetch('/api/state')).json()).state;

// --- extract the storage layer straight out of the page --------------------
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const START = '/* ---------------------------------------------------------------------------\n   Server-backed storage.';
const END = 'function resetAllData(){';
const from = html.indexOf(START);
const to = html.indexOf(END);
if (from < 0 || to < 0) { console.error('could not locate the storage block in index.html'); process.exit(1); }
const storageSrc = html.slice(from, to);
console.log(`extracted ${storageSrc.split('\n').length} lines of storage code from index.html\n`);

// --- minimal environment ---------------------------------------------------
const statusEl = { className: '', textContent: '', title: '', addEventListener() {} };
globalThis.document = {
  getElementById: (id) => (id === 'sync-status' ? statusEl : null),
  addEventListener() {},
  visibilityState: 'visible',
};
globalThis.window = { addEventListener() {} };
const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, v),
};
// Node defines navigator as a getter-only global, so patch the object instead.
if (!globalThis.navigator.sendBeacon) globalThis.navigator.sendBeacon = () => true;
globalThis.Blob = class { constructor(p) { this.p = p; } };
// Rewrite the page's same-origin paths onto the test server.
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(u.startsWith('/') ? BASE + u : u, o);

const YPT_DEFAULT_SUBJECT = 'Subject default';
const YPT_DEFAULT_LINK = 'https://example.invalid/ypt';
const YPT_DEFAULT_TEMPLATE = 'Template default';
const LS_KEY = 'ward-prayer-tracker-v1';
const stripNameMarkers = (s) => String(s || '').replace(/\s*(not\s*bapti[sz]ed|unbapti[sz]ed)\s*/ig, ' ').replace(/\s+/g, ' ').trim();

let state = { members: [], log: [], ypt: {} };

// Evaluate the extracted code, then hand back the bindings it declared.
// `setInterval` is shadowed by a no-op so the page's background poll timer
// doesn't keep this process alive; pollRemote is driven directly instead.
const factory = new Function(
  'YPT_DEFAULT_SUBJECT', 'YPT_DEFAULT_LINK', 'YPT_DEFAULT_TEMPLATE', 'LS_KEY',
  'stripNameMarkers', 'getState', 'setState', 'setInterval',
  `let state = getState();
   const __syncState = () => { state = getState(); };
   ${storageSrc}
   return {
     loadState, saveState, buildDelta, flushSync, pollRemote,
     get state(){ return state; },
     set state(v){ state = v; setState(v); },
     pull: () => { state = getState(); },
     status: () => ({ v: syncVersion, failed: syncFailed }),
     base: () => syncBase,
   };`
);
const S = factory(
  YPT_DEFAULT_SUBJECT, YPT_DEFAULT_LINK, YPT_DEFAULT_TEMPLATE, LS_KEY,
  stripNameMarkers, () => state, (v) => { state = v; }, () => 0
);
// Keep the outer `state` pointing at whatever the module holds.
const sync = () => { state = S.state; };

// --- seed the server -------------------------------------------------------
const seed = {
  members: [
    { id: 'm1', first: 'Ann', last: 'Alpha', phone: '(801) 555-0100', email: 'a@x.com', dob: '1980-01-01', status: 'active', statusDate: null, notes: '', lastPrayerRef: null, hasCalling: true },
    { id: 'm2', first: 'Bob', last: 'Beta', phone: null, email: '', dob: '2010-06-15', status: 'active', statusDate: null, notes: '', lastPrayerRef: null },
    { id: 'm3', first: 'Cy', last: 'Gamma', status: 'active', notes: '', email: '' },
  ],
  log: [{ date: '2026-08-02', opening: 'm1', closing: 'm2' }],
  ypt: {},
};
await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(seed) });

console.log('load');
await S.loadState();
sync();
check('members loaded', S.state.members.length === 3);
check('log loaded', S.state.log.length === 1);
check('ypt defaults filled in', S.state.ypt.subject === YPT_DEFAULT_SUBJECT);
check('suggest defaults filled in', S.state.suggest.adult.callingNever > 0
  && S.state.suggest.youth.minWeeks > 0);
check('defaults persisted to server',
  await waitFor(async () => (await serverState()).ypt.subject === YPT_DEFAULT_SUBJECT));
check('suggest defaults persisted to server',
  await waitFor(async () => (await serverState()).suggest?.adult?.callingNever > 0));

console.log('\nsuggestion settings sync like any other record');
S.state.suggest.adult.oldest = 7;
const sugDelta = S.buildDelta();
check('only the changed group in the delta',
  Object.keys(sugDelta.settings).join() === 'suggest.adult', JSON.stringify(sugDelta.settings));
S.saveState();
check('reaches the server',
  await waitFor(async () => (await serverState()).suggest.adult.oldest === 7));

console.log('\ndelta contains only what changed');
S.state.members.find((m) => m.id === 'm2').status = 'inactive';
S.state.members.find((m) => m.id === 'm2').statusDate = '2026-08-07';
let d = S.buildDelta();
check('1 member in delta', d.members.length === 1, JSON.stringify(d.members.map((m) => m.id)));
check('correct member', d.members[0]?.id === 'm2');
check('no spurious deletes', d.deletedMembers.length === 0);
check('no spurious log writes', d.log.length === 0 && d.deletedLog.length === 0);
check('no spurious settings', Object.keys(d.settings).length === 0, JSON.stringify(d.settings));

console.log('\nsave persists it');
S.saveState();
check('server has the change',
  await waitFor(async () => (await serverState()).members.find((m) => m.id === 'm2').status === 'inactive'));
let srv = await serverState();
check('server left others alone', srv.members.find((m) => m.id === 'm1').status === 'active');
check('delta now empty', (() => { const x = S.buildDelta(); return x.members.length === 0 && x.deletedMembers.length === 0; })());

console.log('\nadd, delete, and log in one save');
S.state.members.push({ id: 'm4', first: 'Dee', last: 'Delta', status: 'active', notes: '' });
S.state.members = S.state.members.filter((m) => m.id !== 'm3');
S.state.log.push({ date: '2026-08-09', opening: 'm4', closing: null });
d = S.buildDelta();
check('add detected', d.members.some((m) => m.id === 'm4'));
check('delete detected', d.deletedMembers.includes('m3'));
check('log add detected', d.log.some((e) => e.date === '2026-08-09'));
S.saveState();
await waitFor(async () => (await serverState()).members.some((m) => m.id === 'm4'));
srv = await serverState();
check('m4 on server', srv.members.some((m) => m.id === 'm4'));
check('m3 gone from server', !srv.members.some((m) => m.id === 'm3'));
check('log entry on server', srv.log.some((e) => e.date === '2026-08-09'));

console.log('\nconcurrent write from "another device" is merged, not lost');
// Another client edits m1 directly, bumping the server version.
await fetch('/api/sync', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ delta: { members: [{ id: 'm1', first: 'Ann', last: 'Alpha', status: 'active', notes: 'edited elsewhere', hasCalling: true }] } }),
});
// This client, unaware, edits a different member and saves.
S.state.members.find((m) => m.id === 'm2').notes = 'edited here';
S.saveState();
await waitFor(async () => (await serverState()).members.find((m) => m.id === 'm2').notes === 'edited here');
srv = await serverState();
check('other device\'s edit survived', srv.members.find((m) => m.id === 'm1').notes === 'edited elsewhere',
  'got ' + JSON.stringify(srv.members.find((m) => m.id === 'm1').notes));
check('this device\'s edit survived', srv.members.find((m) => m.id === 'm2').notes === 'edited here');
check('not stuck in failed state', S.status().failed === false);
check('local view picked up the other device\'s edit',
  S.state.members.find((m) => m.id === 'm1').notes === 'edited elsewhere');
check('no pending delta left over', (() => { const x = S.buildDelta(); return x.members.length === 0; })(),
  JSON.stringify(S.buildDelta().members.map((m) => m.id)));

console.log('\npolling picks up another device\'s change');
S.state.members.find((m) => m.id === 'm2').notes = 'local unsaved';  // pending, unsaved
await fetch('/api/sync', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ delta: { members: [{ id: 'm1', first: 'Ann', last: 'Alpha', status: 'active', notes: 'remote change 2', hasCalling: true }] } }),
});
await S.pollRemote();
check('remote change pulled into local view',
  S.state.members.find((m) => m.id === 'm1').notes === 'remote change 2',
  'got ' + JSON.stringify(S.state.members.find((m) => m.id === 'm1').notes));
check('local unsaved edit not lost',
  S.state.members.find((m) => m.id === 'm2').notes === 'local unsaved');
check('local edit then reaches the server',
  await waitFor(async () => (await serverState()).members.find((m) => m.id === 'm2').notes === 'local unsaved'));
check('remote change not clobbered by the flush',
  (await serverState()).members.find((m) => m.id === 'm1').notes === 'remote change 2');

console.log('\nno-op save sends nothing');
const before = (await (await fetch('/api/health')).json()).version;
S.saveState();
await sleep(1200);
const after = (await (await fetch('/api/health')).json()).version;
check('version unchanged on no-op', before === after, `${before} -> ${after}`);

console.log('\nlocalStorage mirror still written as a crash net');
check('mirror present', !!lsStore.get(LS_KEY));
check('mirror parses', (() => { try { return JSON.parse(lsStore.get(LS_KEY)).members.length > 0; } catch { return false; } })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
