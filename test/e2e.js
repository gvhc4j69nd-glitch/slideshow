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
  let r = await call(anon, '/api/broadcast/mine');
  ok('the api requires an account', r.res.status === 401, r.res.status);

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

  r = await call(host, '/api/broadcast/mine');
  ok('a signed-in user reaches the api', r.res.status === 200, r.res.status);

  const other = jar();
  r = await call(other, '/api/auth/login', { method: 'POST', json: { username: 'presenter', password: 'wrong-password' } });
  ok('wrong password rejected', r.res.status === 401, r.res.status);

  r = await call(other, '/api/auth/login', { method: 'POST', json: { username: 'presenter', password: 'correct-horse' } });
  ok('correct password signs in', r.res.status === 200, r.res.status);

  console.log('\n— the address a presenter reads out —');

  r = await call(host, '/api/auth/me');
  ok('the api says which address to show', typeof r.body.siteHost === 'string', JSON.stringify(r.body.siteHost));
  // These tests run against 127.0.0.1, where the real host is the only one that
  // works, so that is what should come back.
  ok('a local server shows its own address', /^(127\.0\.0\.1|localhost)/.test(r.body.siteHost), r.body.siteHost);

  // A deployment answers to whatever hostname the platform handed it. What the
  // presenter needs to read out is the name of the site.
  r = await call(host, '/api/auth/me', {
    headers: { 'X-Forwarded-Host': 'slideshow-production-1c4f.up.railway.app' },
  });
  ok('a deployment shows the site name, not the platform hostname',
    r.body.siteHost === 'vinboo.com', r.body.siteHost);

  r = await call(host, '/api/auth/me', { headers: { 'X-Forwarded-Host': '192.168.1.40:4321' } });
  ok('but a home network still shows the address that works there',
    r.body.siteHost === '192.168.1.40:4321', r.body.siteHost);

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

  console.log('\n— casting to a television —');

  r = await call(host, `/api/broadcast/${share.code}/cast-ticket`, { method: 'POST' });
  ok('owner can mint a cast link', r.res.status === 201 && /\/watch\?ticket=/.test(r.body.url), JSON.stringify(r.body));
  const castUrl = r.body.url;
  const ticket = new URL(castUrl).searchParams.get('ticket');
  ok('the link carries a ticket, not the password',
    !castUrl.includes(share.password) && ticket.length >= 20, castUrl);

  r = await call(anon, `/api/broadcast/${share.code}/cast-ticket`, { method: 'POST' });
  ok('a stranger cannot mint one', r.res.status === 401, r.res.status);

  const tv = jar();
  r = await call(tv, '/api/watch/redeem', { method: 'POST', json: { ticket } });
  ok('a television joins with the ticket alone', r.res.status === 200 && r.body.code === share.code, JSON.stringify(r.body));

  got = await call(tv, `/api/watch/${share.code}/photo/0`, { raw: true });
  ok('and then streams photos like any viewer', got.res.status === 200 && got.buf.equals(PHOTOS[0]), got.res.status);

  const replay = jar();
  r = await call(replay, '/api/watch/redeem', { method: 'POST', json: { ticket } });
  ok('the same ticket cannot be used twice', r.res.status === 401, r.res.status);

  r = await call(jar(), '/api/watch/redeem', { method: 'POST', json: { ticket: 'not-a-real-ticket' } });
  ok('a made-up ticket is refused', r.res.status === 401, r.res.status);

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

  console.log('\n— hand-off mode —');

  r = await call(host, '/api/broadcast', {
    method: 'POST',
    json: { title: 'Party', photoCount: 51, mode: 'handoff', ttlMs: 3600000 },
  });
  ok('refuses more than 50 photos', r.res.status === 400 && /50 photos/.test(r.body.error || ''), JSON.stringify(r.body));

  r = await call(host, '/api/broadcast', {
    method: 'POST',
    json: { title: 'Party', photoCount: 3, mode: 'handoff', ttlMs: 5 * 60 * 1000 },
  });
  const handoff = r.body;
  ok('starts a handed-off show', r.res.status === 201 && handoff.mode === 'handoff', JSON.stringify(handoff));

  // 5 minutes was asked for; the floor is an hour.
  const life = handoff.expiresAt - Date.now();
  ok('clamps a too-short life up to 1 hour', life > 59 * 60 * 1000 && life < 61 * 60 * 1000,
    `${Math.round(life / 60000)} min`);

  r = await call(host, '/api/broadcast', {
    method: 'POST',
    json: { title: 'Party', photoCount: 3, mode: 'handoff', ttlMs: 30 * 24 * 3600 * 1000 },
  });
  const capped = r.body;
  const cappedLife = capped.expiresAt - Date.now();
  ok('clamps a too-long life down to 48 hours', cappedLife <= 48 * 3600 * 1000 + 5000,
    `${(cappedLife / 3600000).toFixed(1)} h`);

  const tv2 = jar();
  r = await call(tv2, '/api/watch/join', { method: 'POST', json: { code: capped.code, password: capped.password } });
  ok('a screen joins a handed-off show', r.res.status === 200 && r.body.mode === 'handoff', JSON.stringify(r.body));
  ok('and is told how to run it itself',
    Number.isFinite(r.body.startedAt) && Number.isFinite(r.body.interval) && Number.isFinite(r.body.now),
    JSON.stringify({ startedAt: r.body.startedAt, interval: r.body.interval, now: r.body.now }));

  r = await call(tv2, `/api/watch/${capped.code}/cached`, { method: 'POST', json: { have: 3 } });
  ok('a screen reports the copy it holds', r.res.status === 200 && r.body.have === 3, JSON.stringify(r.body));

  r = await call(host, `/api/broadcast/${capped.code}/progress`);
  ok('the presenter sees it is safe to close', r.body.complete === 1 && r.body.screens === 1, JSON.stringify(r.body));

  // The crux: a handed-off show must survive the presenter going silent, which
  // is exactly what ends a live one.
  const beforeExtend = capped.expiresAt;
  r = await call(host, `/api/broadcast/${capped.code}/extend`, { method: 'POST', json: { ttlMs: 48 * 3600 * 1000 } });
  ok('the presenter can extend it', r.res.status === 200 && r.body.expiresAt >= beforeExtend - 5000, JSON.stringify(r.body));
  ok('but never beyond 48 hours from now', r.body.expiresAt - Date.now() <= 48 * 3600 * 1000 + 5000,
    `${((r.body.expiresAt - Date.now()) / 3600000).toFixed(1)} h`);

  r = await call(anon, `/api/broadcast/${capped.code}/extend`, { method: 'POST', json: {} });
  ok('a stranger cannot extend it', r.res.status === 401, r.res.status);

  r = await call(host, `/api/broadcast/${handoff.code}/progress`);
  ok('a second share does not kill the first handed-off show', r.res.status === 200, r.res.status);

  // A live show has no deadline to move, so extending one is meaningless.
  r = await call(host, '/api/broadcast', { method: 'POST', json: { title: 'Live one', photoCount: 2 } });
  const liveOne = r.body;
  r = await call(host, `/api/broadcast/${liveOne.code}/extend`, { method: 'POST', json: {} });
  ok('extending a live show is refused', r.res.status === 400, r.res.status);

  r = await call(host, '/api/broadcast', {
    method: 'POST', json: { title: 'Third', photoCount: 2, mode: 'handoff' },
  });
  const third = r.body;
  r = await call(host, '/api/broadcast', {
    method: 'POST', json: { title: 'Fourth', photoCount: 2, mode: 'handoff' },
  });
  ok('caps how many handed-off shows one account can leave standing', r.res.status === 409, r.res.status);
  await call(host, `/api/broadcast/${third.code}`, { method: 'DELETE' });

  console.log('\n— a screen seeds to one that joins later —');

  /*
   * Eight photos, because the relay caches six. Whatever it still holds could
   * answer on its own, so the proof has to be a slide it has already evicted.
   */
  const MANY = Array.from({ length: 8 }, (unused, i) =>
    Buffer.from(`SEED-PHOTO-${i}-` + String.fromCharCode(97 + i).repeat(40)));

  r = await call(host, '/api/broadcast', {
    method: 'POST', json: { title: 'Seeded', photoCount: MANY.length, mode: 'handoff' },
  });
  const seeded = r.body;

  let hostServing = true;
  (async function seedHostLoop() {
    while (hostServing) {
      try {
        const { res, body } = await call(host, `/api/broadcast/${seeded.code}/requests`);
        if (res.status !== 200) { await new Promise(r2 => setTimeout(r2, 50)); continue; }
        for (const job of body.requests) {
          if (!hostServing) return;
          await call(host, `/api/broadcast/${seeded.code}/frame/${job.reqId}`, {
            method: 'PUT', body: MANY[job.index], headers: { 'Content-Type': 'image/png' },
          });
        }
      } catch { if (hostServing) await new Promise(r2 => setTimeout(r2, 50)); }
    }
  })();

  // First screen takes its copy while the presenter is still here.
  const screenA = jar();
  await call(screenA, '/api/watch/join', { method: 'POST', json: { code: seeded.code, password: seeded.password } });
  const copyA = new Map();
  for (let i = 0; i < MANY.length; i += 1) {
    const got2 = await call(screenA, `/api/watch/${seeded.code}/photo/${i}`, { raw: true });
    if (got2.res.status === 200) copyA.set(i, got2.buf);
  }
  ok('the first screen takes a full copy', copyA.size === MANY.length, `${copyA.size}/${MANY.length}`);

  r = await call(screenA, `/api/watch/${seeded.code}/cached`, { method: 'POST', json: { have: copyA.size } });
  ok('and says so', r.body.have === MANY.length, JSON.stringify(r.body));

  r = await call(screenA, `/api/watch/${seeded.code}/state`);
  ok('the relay counts it as a source', r.body.seeds === 1, JSON.stringify({ seeds: r.body.seeds }));

  // The presenter closes the tab.
  hostServing = false;

  // That screen now answers on the presenter's behalf.
  let seedServed = 0;
  (async function screenSeedLoop() {
    while (seedServed < 4) {
      try {
        const { res, body } = await call(screenA, `/api/watch/${seeded.code}/requests`);
        if (res.status !== 200) { await new Promise(r2 => setTimeout(r2, 50)); continue; }
        for (const job of body.requests) {
          seedServed += 1;
          await call(screenA, `/api/watch/${seeded.code}/frame/${job.reqId}`, {
            method: 'PUT', body: copyA.get(job.index), headers: { 'Content-Type': 'image/png' },
          });
        }
      } catch { await new Promise(r2 => setTimeout(r2, 50)); }
    }
  })();

  const screenB = jar();
  r = await call(screenB, '/api/watch/join', { method: 'POST', json: { code: seeded.code, password: seeded.password } });
  ok('a screen can still join after the presenter has gone', r.res.status === 200, r.res.status);

  // 0 and 1 are the slides the relay evicted, so these can only come from screen A.
  got = await call(screenB, `/api/watch/${seeded.code}/photo/0`, { raw: true });
  ok('and is served a slide the relay no longer holds',
    got.res.status === 200 && got.buf.equals(MANY[0]), got.res.status);

  got = await call(screenB, `/api/watch/${seeded.code}/photo/1`, { raw: true });
  ok('and another', got.res.status === 200 && got.buf.equals(MANY[1]), got.res.status);
  ok('which came from the other screen, not the presenter', seedServed > 0, `${seedServed} served`);

  // A screen that holds nothing must not be allowed to pose as a source.
  r = await call(screenB, `/api/watch/${seeded.code}/requests`);
  ok('a screen without a full copy cannot seed', r.res.status === 409, r.res.status);

  seedServed = 99;
  await call(host, `/api/broadcast/${seeded.code}`, { method: 'DELETE' });

  r = await call(host, `/api/broadcast/${capped.code}`, { method: 'DELETE' });
  ok('the presenter can take it down early', r.res.status === 200, r.res.status);
  r = await call(tv2, `/api/watch/${capped.code}/state`);
  ok('and the screens are told it ended', r.res.status === 404, r.res.status);

  await call(host, `/api/broadcast/${handoff.code}`, { method: 'DELETE' });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('test crashed:', err); process.exit(1); });
