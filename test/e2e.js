// End-to-end exercise of accounts + the live relay, against a running server.
const BASE = process.env.BASE || 'http://127.0.0.1:4399';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

// Minimal cookie jars so host and viewer stay distinct identities.
function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb: (res) => {
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        if (!value || /Max-Age=0/.test(raw)) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
  };
}

async function call(j, path, { method = 'GET', json, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (j.header()) h.Cookie = j.header();
  if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(BASE + path, { method, headers: h, body });
  j.absorb(res);
  if (raw) return { res, buf: Buffer.from(await res.arrayBuffer()) };
  const ct = res.headers.get('content-type') || '';
  return { res, body: ct.includes('json') ? await res.json() : await res.text() };
}

async function guardTargetServer() {
  let health;
  try {
    health = await (await fetch(`${BASE}/healthz`)).json();
  } catch (err) {
    console.error(`\nNo server answering at ${BASE} — start one first:`
      + '\n  DATABASE_URL=postgres://localhost/vinboo_test PORT=4399 node server.js\n');
    process.exit(1);
  }
  // This suite registers accounts and ends broadcasts. If a stray server from
  // another run is holding the port, its database is not ours to churn.
  if (!health.database || !health.database.endsWith('_test')) {
    console.error(`\nThe server on ${BASE} is using database "${health.database}".`
      + '\nThese tests create and delete accounts, so they only run against a'
      + ' database whose name ends in _test.'
      + '\nSomething else may be holding the port:  lsof -ti:4399\n');
    process.exit(1);
  }
  return health.database;
}

(async () => {
  const host = jar(), viewer = jar(), anon = jar();
  const database = await guardTargetServer();
  console.log(`\nserver at ${BASE} using database ${database}`);

  console.log('\n— accounts —');
  let r = await call(anon, '/api/folders');
  ok('library requires an account', r.res.status === 401, r.res.status);

  r = await call(host, '/api/auth/register', { method: 'POST', json: { username: 'ab', password: 'longenough1' } });
  if (r.res.status === 429) {
    // Sign-ups are rate limited per IP, so a re-used server poisons the run.
    console.error('\nThis server has already used its sign-up allowance.'
      + '\nStart a fresh one with an empty DATA_ROOT and run again:'
      + '\n  PORT=4399 DATA_ROOT=$(mktemp -d) node server.js\n');
    process.exit(1);
  }
  ok('rejects short username', r.res.status === 400, JSON.stringify(r.body));

  r = await call(host, '/api/auth/register', { method: 'POST', json: { username: 'presenter', password: 'short' } });
  ok('rejects short password', r.res.status === 400, JSON.stringify(r.body));

  r = await call(host, '/api/auth/register', { method: 'POST', json: { username: 'presenter', password: 'correct-horse' } });
  ok('registers an account', r.res.status === 201 && r.body.user.username === 'presenter', JSON.stringify(r.body));

  r = await call(anon, '/api/auth/register', { method: 'POST', json: { username: 'PRESENTER', password: 'another-one' } });
  ok('username uniqueness is case-insensitive', r.res.status === 409, JSON.stringify(r.body));

  r = await call(host, '/api/folders');
  ok('signed-in user reaches the library', r.res.status === 200, r.res.status);

  const other = jar();
  r = await call(other, '/api/auth/login', { method: 'POST', json: { username: 'presenter', password: 'wrong-password' } });
  ok('wrong password rejected', r.res.status === 401, r.res.status);

  r = await call(other, '/api/auth/login', { method: 'POST', json: { username: 'presenter', password: 'correct-horse' } });
  ok('correct password signs in', r.res.status === 200, r.res.status);

  console.log('\n— starting a broadcast —');
  const PHOTOS = [
    Buffer.from('PHOTO-ZERO-' + 'a'.repeat(50)),
    Buffer.from('PHOTO-ONE-' + 'b'.repeat(50)),
    Buffer.from('PHOTO-TWO-' + 'c'.repeat(50)),
  ];

  r = await call(host, '/api/broadcast', { method: 'POST', json: { title: 'Holiday', photoCount: PHOTOS.length } });
  const share = r.body;
  ok('broadcast created', r.res.status === 201 && /^[A-Z0-9]{6}$/.test(share.code), JSON.stringify(share));
  ok('temp password looks right', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(share.password), share.password);
  console.log(`       code=${share.code} password=${share.password}`);

  r = await call(anon, '/api/broadcast', { method: 'POST', json: { title: 'x', photoCount: 1 } });
  ok('anonymous cannot broadcast', r.res.status === 401, r.res.status);

  // The host's serve loop: answer every photo request with real bytes.
  let served = 0;
  let hosting = true;
  (async function serveLoop() {
    while (hosting) {
      try {
        const { res, body } = await call(host, `/api/broadcast/${share.code}/requests`);
        if (res.status !== 200) { await new Promise(r => setTimeout(r, 100)); continue; }
        for (const job of body.requests) {
          served++;
          await call(host, `/api/broadcast/${share.code}/frame/${job.reqId}`, {
            method: 'PUT', body: PHOTOS[job.index], headers: { 'Content-Type': 'image/png' },
          });
        }
      } catch { if (hosting) await new Promise(r => setTimeout(r, 100)); }
    }
  })();

  console.log('\n— viewer joins —');
  r = await call(viewer, '/api/watch/join', { method: 'POST', json: { code: share.code, password: 'AAAA-BBBB-CCCC' } });
  ok('wrong temp password rejected', r.res.status === 401, r.res.status);

  r = await call(viewer, '/api/watch/join', { method: 'POST', json: { code: 'ZZZZZZ', password: share.password } });
  ok('unknown code rejected', r.res.status === 401, r.res.status);

  r = await call(anon, `/api/watch/${share.code}/photo/0`);
  ok('photo needs a joined viewer', r.res.status === 401, r.res.status);

  r = await call(viewer, '/api/watch/join', { method: 'POST', json: { code: share.code.toLowerCase(), password: share.password.toLowerCase() } });
  ok('join accepts lowercase input', r.res.status === 200, JSON.stringify(r.body));
  ok('viewer sees the title', r.body.title === 'Holiday', r.body.title);
  ok('viewer sees photo count', r.body.photoCount === 3, r.body.photoCount);
  ok('viewer needs no account', true);

  console.log('\n— streaming photos —');
  let got = await call(viewer, `/api/watch/${share.code}/photo/0`, { raw: true });
  ok('photo 0 streams through', got.res.status === 200 && got.buf.equals(PHOTOS[0]), got.res.status);
  ok('relayed photo keeps its type', got.res.headers.get('content-type') === 'image/png', got.res.headers.get('content-type'));
  ok('relayed photo is not cacheable', /no-store/.test(got.res.headers.get('cache-control') || ''), got.res.headers.get('cache-control'));

  got = await call(viewer, `/api/watch/${share.code}/photo/2`, { raw: true });
  ok('photo 2 streams through', got.res.status === 200 && got.buf.equals(PHOTOS[2]), got.res.status);

  got = await call(viewer, `/api/watch/${share.code}/photo/9`, { raw: true });
  ok('out-of-range photo rejected', got.res.status === 400, got.res.status);

  // Two viewers on the same slide should cost the host one transfer.
  const viewer2 = jar();
  await call(viewer2, '/api/watch/join', { method: 'POST', json: { code: share.code, password: share.password } });
  const before = served;
  const [a, b] = await Promise.all([
    call(viewer2, `/api/watch/${share.code}/photo/1`, { raw: true }),
    call(viewer, `/api/watch/${share.code}/photo/1`, { raw: true }),
  ]);
  ok('both viewers get photo 1', a.buf.equals(PHOTOS[1]) && b.buf.equals(PHOTOS[1]));
  ok('duplicate request served once by host', served - before <= 1, `host served ${served - before}`);

  console.log('\n— following the presenter —');
  r = await call(host, `/api/broadcast/${share.code}/state`, { method: 'POST', json: { index: 2, playing: true, gen: 0 } });
  ok('host can push state', r.res.status === 200, r.res.status);

  r = await call(viewer, `/api/watch/${share.code}/state`);
  ok('viewer sees the new slide', r.body.index === 2, JSON.stringify(r.body));
  ok('viewer count is reported', r.body.viewers >= 2, r.body.viewers);
  ok('host shows as live', r.body.hostLive === true);

  // Long-poll: parked until the host moves, then returns promptly.
  const version = r.body.version;
  const started = Date.now();
  const parked = call(viewer, `/api/watch/${share.code}/state?since=${version}`);
  await new Promise(r => setTimeout(r, 300));
  await call(host, `/api/broadcast/${share.code}/state`, { method: 'POST', json: { index: 1 } });
  const woke = await parked;
  const waited = Date.now() - started;
  ok('long-poll wakes on host change', woke.body.index === 1 && waited < 5000, `index=${woke.body.index} after ${waited}ms`);

  console.log('\n— ownership + shutdown —');
  const intruder = jar();
  await call(intruder, '/api/auth/register', { method: 'POST', json: { username: 'intruder', password: 'correct-horse' } });
  r = await call(intruder, `/api/broadcast/${share.code}/state`, { method: 'POST', json: { index: 0 } });
  ok("another account can't drive the broadcast", r.res.status === 403, r.res.status);
  r = await call(intruder, `/api/broadcast/${share.code}`, { method: 'DELETE' });
  ok("another account can't end it", r.res.status === 403, r.res.status);

  hosting = false;
  r = await call(host, `/api/broadcast/${share.code}`, { method: 'DELETE' });
  ok('owner ends the broadcast', r.res.status === 200, r.res.status);

  r = await call(viewer, `/api/watch/${share.code}/state`);
  ok('code stops working once ended', r.res.status === 404, r.res.status);

  r = await call(viewer, '/api/watch/join', { method: 'POST', json: { code: share.code, password: share.password } });
  ok('temp password is dead after ending', r.res.status === 401, r.res.status);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('test crashed:', err); process.exit(1); });
