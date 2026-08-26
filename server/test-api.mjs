// Exercises the sync API against a running server. Uses a throwaway database,
// so it never touches real data:
//
//   node server.mjs --port 8788 --db data/test.db   (in another shell)
//   node test-api.mjs --port 8788

const port = process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1] : '8788';
const BASE = `http://127.0.0.1:${port}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
const api = async (path, opts) => {
  const r = await fetch(BASE + path, opts);
  return { status: r.status, body: await r.json() };
};
const post = (path, obj) => api(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
});

console.log('seeding');
const seed = {
  members: [
    { id: 'aaa', first: 'Ann', last: 'Alpha', phone: '(801) 555-0100', email: 'a@x.com', dob: '1980-01-01', status: 'active', statusDate: null, notes: '', lastPrayerRef: null, hasCalling: true },
    { id: 'bbb', first: 'Bob', last: 'Beta', phone: null, email: '', dob: '2010-06-15', status: 'inactive', statusDate: '2026-01-05', notes: 'note', lastPrayerRef: '2024-03-03', hasCalling: false, notBaptized: true },
    { id: 'ccc', first: 'Cy', last: 'Gamma', status: 'moved', movedDate: '2026-02-02', notes: '' },
  ],
  log: [{ date: '2026-08-02', opening: 'aaa', closing: 'bbb' }],
  ypt: { subject: 'Subj', link: 'http://l', template: 'Body', lastSent: null },
};
let r = await post('/api/import', seed);
check('import returns 200', r.status === 200, JSON.stringify(r.body).slice(0, 120));
let version = r.body.version;

r = await api('/api/state');
check('3 members stored', r.body.state.members.length === 3);
check('booleans survive', r.body.state.members.find(m => m.id === 'aaa').hasCalling === true);
check('false boolean omitted', !('hasCalling' in r.body.state.members.find(m => m.id === 'ccc')));
check('notBaptized survives', r.body.state.members.find(m => m.id === 'bbb').notBaptized === true);
check('settings survive', r.body.state.ypt.subject === 'Subj');
check('null phone survives', r.body.state.members.find(m => m.id === 'bbb').phone === null);
version = r.body.version;

console.log('\nincremental update');
r = await post('/api/sync', {
  baseVersion: version,
  delta: { members: [{ id: 'aaa', first: 'Ann', last: 'Alpha', status: 'lessactive', statusDate: '2026-08-07', notes: 'changed', hasCalling: true }], deletedMembers: [], log: [], deletedLog: [], settings: {} },
});
check('sync 200', r.status === 200);
check('version bumped', r.body.version === version + 1, `${version} -> ${r.body.version}`);
version = r.body.version;
r = await api('/api/state');
const ann = r.body.state.members.find(m => m.id === 'aaa');
check('field updated', ann.status === 'lessactive' && ann.notes === 'changed');
check('other members untouched', r.body.state.members.length === 3);

console.log('\nstale write is rejected');
r = await post('/api/sync', {
  baseVersion: version - 1,
  delta: { members: [{ id: 'aaa', first: 'CLOBBER', last: 'X', status: 'active' }] },
});
check('409 on stale baseVersion', r.status === 409, 'got ' + r.status);
check('409 returns current state', Array.isArray(r.body.state?.members));
r = await api('/api/state');
check('stale write did NOT apply', r.body.state.members.find(m => m.id === 'aaa').first === 'Ann');

console.log('\ndeletes + log');
r = await post('/api/sync', {
  baseVersion: version,
  delta: {
    members: [], deletedMembers: ['ccc'],
    log: [{ date: '2026-08-09', opening: 'bbb', closing: null }],
    deletedLog: ['2026-08-02'], settings: { 'ypt.lastSent': '2026-08-07' },
  },
});
check('sync 200', r.status === 200);
version = r.body.version;
r = await api('/api/state');
check('member deleted', !r.body.state.members.some(m => m.id === 'ccc'));
check('log entry added', r.body.state.log.some(e => e.date === '2026-08-09'));
check('log entry deleted', !r.body.state.log.some(e => e.date === '2026-08-02'));
check('null closing kept', r.body.state.log.find(e => e.date === '2026-08-09').closing === null);
check('setting updated', r.body.state.ypt.lastSent === '2026-08-07');

console.log('\nsuggestion settings round-trip');
r = await post('/api/sync', {
  baseVersion: version,
  delta: { settings: { 'suggest.adult': { callingNever: 4, never: 1, oldest: 6, minWeeks: 40, poolSize: 30, randomize: false } } },
});
check('sync 200', r.status === 200);
version = r.body.version;
r = await api('/api/state');
check('suggest block returned', r.body.state.suggest?.adult?.oldest === 6,
  'got ' + JSON.stringify(r.body.state.suggest));
check('suggest booleans survive', r.body.state.suggest.adult.randomize === false);
check('suggest kept out of ypt', r.body.state.ypt.adult === undefined);

console.log('\ndeleting a member clears their log references');
await post('/api/sync', { baseVersion: version, delta: { members: [], deletedMembers: ['bbb'] } });
r = await api('/api/state');
check('log FK set null, entry survives', r.body.state.log.find(e => e.date === '2026-08-09')?.opening === null);

console.log('\nimport replaces settings too');
await post('/api/import', { members: [], log: [], ypt: { subject: 'OLD' }, suggest: { youth: { oldest: 9 } } });
r = await api('/api/state');
check('setting present after first import', r.body.state.ypt.subject === 'OLD');
check('suggest block survives import', r.body.state.suggest.youth.oldest === 9);
await post('/api/import', { members: [], log: [] });   // backup with no ypt block
r = await api('/api/state');
check('stale setting cleared', r.body.state.ypt.subject === undefined,
  'got ' + JSON.stringify(r.body.state.ypt));

console.log('\nrollback on a bad delta');
const before = (await api('/api/state')).body;
r = await post('/api/sync', {
  baseVersion: before.version,
  delta: { members: [{ id: 'zzz', first: 'Z', last: 'Z' }], log: [{ date: '2026-08-10', opening: 'does-not-exist' }] },
});
check('bad FK rejected', r.status === 500, 'got ' + r.status);
const after = (await api('/api/state')).body;
check('no partial write (zzz absent)', !after.state.members.some(m => m.id === 'zzz'));

console.log(`\n${pass} passed, ${fail} failed`);
// Let Node drain its keep-alive sockets; process.exit() here trips a libuv
// assertion on Windows.
process.exitCode = fail ? 1 : 0;
