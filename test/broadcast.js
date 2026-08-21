/**
 * Tests for the relay's own bookkeeping — the parts driven by the clock, which
 * the end-to-end suite can only reach by waiting minutes. Here the clock is
 * moved by hand instead: a session's timestamps are just numbers, so a tab that
 * closed two minutes ago is one assignment away.
 */

const assert = require('assert');
const {
  Broadcast, HOST_TIMEOUT_MS, HANDOFF_MAX_PHOTOS, HANDOFF_MIN_TTL_MS, HANDOFF_MAX_TTL_MS,
} = require('../lib/broadcast.js');

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const relay = () => new Broadcast({ secret: 'test-secret' });
const HOUR = 60 * 60 * 1000;

// create() hands back the session and the one-time password; every test here
// wants the session.
const start = (b, opts) => b.create({ userId: 1, username: 'p', title: 'x', photoCount: 3, ...opts }).session;

// A screen only counts towards progress while it is actually watching, so the
// tests that ask about seeding have to put one on the session first.
function watching(session, id, held) {
  session.viewers.set(id, Date.now());
  return { session, id, held };
}

console.log('\n— the presenter closes the tab —');

check('a live show dies when the host goes quiet', () => {
  const b = relay();
  const session = start(b, { title: 'Live' });
  session.hostSeenAt = Date.now() - HOST_TIMEOUT_MS - 1000;
  b.sweep();
  assert.strictEqual(b.sessions.has(session.code), false, 'live show should have been swept');
});

check('a handed-off show survives the same silence', () => {
  const b = relay();
  const session = start(b, { title: 'Party', mode: 'handoff' });
  session.hostSeenAt = Date.now() - HOST_TIMEOUT_MS * 100;
  b.sweep();
  assert.ok(b.sessions.has(session.code), 'handed-off show should still be running');
});

check('but it is taken down when its time is up', () => {
  const b = relay();
  const session = start(b, { title: 'Party', mode: 'handoff' });
  session.expiresAt = Date.now() - 1;
  b.sweep();
  assert.strictEqual(b.sessions.has(session.code), false, 'expired show should have been swept');
});

console.log('\n— typing the temporary password —');

check('the hyphens are presentation, not part of the secret', () => {
  const b = relay();
  const { session, password } = b.create({
    userId: 1, username: 'p', title: 'x', photoCount: 3,
  });
  assert.match(password, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

  const letters = password.replace(/-/g, '');
  assert.ok(b.verifyPassword(session, password), 'as printed');
  assert.ok(b.verifyPassword(session, letters), 'typed without hyphens');
  assert.ok(b.verifyPassword(session, letters.toLowerCase()), 'in lower case');
  assert.ok(b.verifyPassword(session, ` ${password} `), 'with stray spaces');
  assert.ok(b.verifyPassword(session, password.replace(/-/g, ' ')), 'with spaces for hyphens');
});

check('a wrong password is still wrong', () => {
  const b = relay();
  const { session, password } = b.create({
    userId: 1, username: 'p', title: 'x', photoCount: 3,
  });
  const letters = password.replace(/-/g, '');
  const wrong = (letters[0] === 'A' ? 'B' : 'A') + letters.slice(1);
  assert.strictEqual(b.verifyPassword(session, wrong), false);
  assert.strictEqual(b.verifyPassword(session, ''), false);
  assert.strictEqual(b.verifyPassword(session, letters.slice(0, 11)), false);
});

console.log('\n— the limits —');

check('hand-off refuses more than the photo cap', () => {
  const b = relay();
  assert.throws(
    () => start(b, { photoCount: HANDOFF_MAX_PHOTOS + 1, mode: 'handoff' }),
    /150 photos/,
  );
});

check('a live show has no photo cap', () => {
  const b = relay();
  const session = start(b, { photoCount: 5000 });
  assert.ok(session.code);
});

check('a requested life below an hour is raised to an hour', () => {
  const b = relay();
  const session = start(b, { mode: 'handoff', ttlMs: 1000 });
  assert.ok(Math.abs((session.expiresAt - Date.now()) - HANDOFF_MIN_TTL_MS) < 2000);
});

check('a requested life above 48 hours is cut to 48', () => {
  const b = relay();
  const session = start(b, { mode: 'handoff', ttlMs: 90 * HOUR });
  assert.ok((session.expiresAt - Date.now()) <= HANDOFF_MAX_TTL_MS + 2000);
});

console.log('\n— coming back to extend —');

check('extending never stacks up beyond 48 hours', () => {
  const b = relay();
  const session = start(b, { mode: 'handoff', ttlMs: HANDOFF_MAX_TTL_MS });
  // Extend three times over. A cumulative deadline would now sit six days out.
  b.extend(session, HANDOFF_MAX_TTL_MS);
  b.extend(session, HANDOFF_MAX_TTL_MS);
  const deadline = b.extend(session, HANDOFF_MAX_TTL_MS);
  assert.ok(deadline - Date.now() <= HANDOFF_MAX_TTL_MS + 2000,
    `deadline is ${((deadline - Date.now()) / HOUR).toFixed(1)}h out`);
});

check('extending can also shorten the show', () => {
  const b = relay();
  const session = start(b, { mode: 'handoff', ttlMs: HANDOFF_MAX_TTL_MS });
  const deadline = b.extend(session, HOUR);
  assert.ok(Math.abs((deadline - Date.now()) - HOUR) < 2000);
});

console.log('\n— knowing when it is safe to close —');

check('progress counts the screens holding a full copy', () => {
  const b = relay();
  const session = start(b, { photoCount: 4, mode: 'handoff' });

  watching(session, 'tv-1');
  watching(session, 'tv-2');
  b.recordCached(session, 'tv-1', 4);
  b.recordCached(session, 'tv-2', 2);
  const progress = b.cacheProgress(session);
  assert.strictEqual(progress.screens, 2);
  assert.strictEqual(progress.complete, 1, 'only one screen has every slide');
  assert.strictEqual(progress.slidesHeld, 6);
  assert.strictEqual(progress.slidesNeeded, 8);
});

check('a screen cannot claim more slides than exist', () => {
  const b = relay();
  const session = start(b, { photoCount: 4, mode: 'handoff' });
  watching(session, 'tv-1');
  b.recordCached(session, 'tv-1', 999);
  assert.strictEqual(b.cacheProgress(session).slidesHeld, 4);
});

check('a screen that goes away stops counting', () => {
  const b = relay();
  const session = start(b, { photoCount: 2, mode: 'handoff' });
  watching(session, 'tv-1');
  b.recordCached(session, 'tv-1', 2);
  session.viewers.set('tv-1', Date.now() - 10 * 60 * 1000);
  b.sweep();
  assert.strictEqual(b.cacheProgress(session).screens, 0);
});

console.log('\n— a screen seeds to screens that arrive later —');

check('a screen may only seed once it holds the whole show', () => {
  const b = relay();
  const session = start(b, { photoCount: 3, mode: 'handoff' });
  watching(session, 'tv-1');
  b.recordCached(session, 'tv-1', 2);
  assert.strictEqual(b.canSeed(session, 'tv-1'), false, 'a partial copy must not seed');
  b.recordCached(session, 'tv-1', 3);
  assert.strictEqual(b.canSeed(session, 'tv-1'), true);
});

check('a live show never promotes a screen to seed', () => {
  const b = relay();
  const session = start(b, { photoCount: 3 });
  watching(session, 'tv-1');
  b.recordCached(session, 'tv-1', 3);
  assert.strictEqual(b.canSeed(session, 'tv-1'), false);
});

check('with the presenter gone, a request goes to a seeding screen', () => {
  const b = relay();
  const session = start(b, { photoCount: 3, mode: 'handoff' });
  watching(session, 'tv-1');
  b.recordCached(session, 'tv-1', 3);
  session.hostSeenAt = Date.now() - HOST_TIMEOUT_MS * 10;   // the tab closed hours ago

  let handed = null;
  b.waitForSeedRequests(session, 'tv-1', (jobs) => { handed = jobs; });
  b.requestPhoto(session, 2, () => {});

  assert.ok(handed && handed.length === 1, 'the seeder should have been given the job');
  assert.strictEqual(handed[0].index, 2);
});

check('the presenting tab still gets first refusal', () => {
  const b = relay();
  const session = start(b, { photoCount: 3, mode: 'handoff' });
  watching(session, 'tv-1');
  b.recordCached(session, 'tv-1', 3);

  let toSeeder = null;
  let toHost = null;
  b.waitForSeedRequests(session, 'tv-1', (jobs) => { toSeeder = jobs; });
  b.waitForRequests(session, (jobs) => { toHost = jobs; });
  b.requestPhoto(session, 1, () => {});

  assert.ok(toHost && toHost.length === 1, 'the host should have been given the job');
  assert.strictEqual(toSeeder, null, 'the seeder should still be parked');
});

check('a seeder answering does not make the presenter look present', () => {
  const b = relay();
  const session = start(b, { photoCount: 3, mode: 'handoff' });
  watching(session, 'tv-1');
  b.recordCached(session, 'tv-1', 3);

  session.hostSeenAt = Date.now() - HOST_TIMEOUT_MS * 5;
  const stale = session.hostSeenAt;

  let job = null;
  b.waitForSeedRequests(session, 'tv-1', (jobs) => { [job] = jobs; });
  let served = null;
  b.requestPhoto(session, 0, (result) => { served = result; });
  b.deliverFrame(session, job.reqId, Buffer.from('bytes'), 'image/png', { fromHost: false });

  assert.ok(served && served.buffer.equals(Buffer.from('bytes')), 'the photo should have been relayed');
  assert.strictEqual(session.hostSeenAt, stale, 'host liveness must not have been touched');
});

check('a late joiner is told plainly when no screen can serve it', () => {
  const b = relay();
  const session = start(b, { photoCount: 3, mode: 'handoff' });
  session.hostSeenAt = Date.now() - HOST_TIMEOUT_MS * 10;
  assert.strictEqual(b.hasSource(session), false);
  assert.match(b.timeoutMessage(session), /nobody with a copy/i);

  watching(session, 'tv-1');
  b.recordCached(session, 'tv-1', 3);
  assert.strictEqual(b.hasSource(session), true);
  assert.match(b.timeoutMessage(session), /did not arrive in time/i);
});

check('and is told at once rather than after a long wait', () => {
  const b = relay();
  const session = start(b, { photoCount: 3, mode: 'handoff' });
  session.hostSeenAt = Date.now() - HOST_TIMEOUT_MS * 10;

  let answer = null;
  b.requestPhoto(session, 0, (result) => { answer = result; });
  assert.ok(answer && /nobody with a copy/i.test(answer.error), JSON.stringify(answer));
  // The way back must not point at a code that can never work again.
  assert.ok(/new code/i.test(answer.error), answer.error);
  assert.ok(!/open the slideshow again/i.test(answer.error), answer.error);
  assert.strictEqual(session.pending.size, 0, 'nothing should have been left queued');
});

check('a screen that was switched off stops counting as a source', () => {
  const b = relay();
  const session = start(b, { photoCount: 2, mode: 'handoff' });
  session.hostSeenAt = Date.now() - HOST_TIMEOUT_MS * 10;
  watching(session, 'tv-1');
  b.recordCached(session, 'tv-1', 2);
  assert.strictEqual(b.hasSource(session), true);

  // The television is unplugged: it stops answering, without telling anyone.
  session.viewers.set('tv-1', Date.now() - 60 * 1000);
  assert.strictEqual(b.hasSource(session), false, 'a silent screen must not count');
});

check('a job the presenter never answered is offered to a screen instead', () => {
  const b = relay();
  const session = start(b, { photoCount: 3, mode: 'handoff' });
  watching(session, 'tv-1');
  b.recordCached(session, 'tv-1', 3);

  // The presenting tab has a poll parked but is about to die without answering.
  b.waitForRequests(session, () => {});
  b.requestPhoto(session, 2, () => {});
  assert.strictEqual(session.queue.length, 0, 'the host should have taken it');

  let handed = null;
  b.waitForSeedRequests(session, 'tv-1', (jobs) => { handed = jobs; });
  assert.strictEqual(handed, null, 'the seeder should still be parked');

  // Time passes and no bytes arrive.
  for (const entry of session.pending.values()) {
    entry.dispatchedAt = Date.now() - 30 * 1000;
  }
  b.sweep();

  assert.ok(handed && handed.length === 1, 'the seeder should have been offered the job');
  assert.strictEqual(handed[0].index, 2);
});

check('a live show keeps its own timeout wording', () => {
  const b = relay();
  const session = start(b, { photoCount: 3 });
  assert.match(b.timeoutMessage(session), /host did not send/i);
});

check('seedCount only counts screens still watching', () => {
  const b = relay();
  const session = start(b, { photoCount: 2, mode: 'handoff' });
  watching(session, 'tv-1');
  watching(session, 'tv-2');
  b.recordCached(session, 'tv-1', 2);
  b.recordCached(session, 'tv-2', 1);
  assert.strictEqual(b.seedCount(session), 1);

  session.viewers.set('tv-1', Date.now() - 10 * 60 * 1000);
  b.sweep();
  assert.strictEqual(b.seedCount(session), 0);
});

console.log('\n— what a screen is told —');

check('a handed-off show hands out the clock, not a slide index', () => {
  const b = relay();
  const session = start(b, { mode: 'handoff', interval: 7000 });
  const state = b.publicState(session);
  assert.strictEqual(state.mode, 'handoff');
  assert.strictEqual(state.interval, 7000);
  assert.ok(Number.isFinite(state.startedAt));
  assert.ok(Number.isFinite(state.now));
});

console.log('\n— shows that outlive the process —');

/* A store that records what it was told, so the relay can be tested without a
   database. This is exactly the shape server.js hands in. */
function fakeStore(initial = []) {
  return {
    saved: [], touched: [], removed: [], rows: initial,
    save(session) { this.saved.push(session.code); },
    touch(code, expiresAt) { this.touched.push({ code, expiresAt }); },
    remove(code) { this.removed.push(code); },
    async loadAll() { return this.rows; },
  };
}

check('with no store the relay behaves exactly as it always did', () => {
  // The injection has to be optional, or every existing caller changes.
  const b = relay();
  const session = start(b);
  assert.ok(b.sessions.has(session.code));
  assert.strictEqual(b.store, null);
  assert.doesNotThrow(() => b.end(session.code));
});

check('starting, extending and ending a show are each written down', () => {
  const store = fakeStore();
  const b = new Broadcast({ secret: 'test-secret', store });
  const session = start(b, { mode: 'handoff', ttlMs: 2 * HOUR });
  assert.deepStrictEqual(store.saved, [session.code]);

  b.extend(session, 3 * HOUR);
  assert.strictEqual(store.touched.length, 1);
  assert.strictEqual(store.touched[0].code, session.code);
  assert.strictEqual(store.touched[0].expiresAt, session.expiresAt);

  b.end(session.code);
  assert.deepStrictEqual(store.removed, [session.code]);
});

check('a show comes back after the process did not', async () => {
  const original = { code: 'KEPT01', salt: 'aa', passwordHash: Buffer.alloc(32, 7),
    nonce: 'n', userId: 1, username: 'p', title: 'Kept', photoCount: 9,
    mode: 'handoff', interval: 5000,
    createdAt: Date.now() - 60_000, expiresAt: Date.now() + HOUR };

  const b = new Broadcast({ secret: 'test-secret', store: fakeStore([original]) });
  assert.strictEqual(await b.restore(), 1);

  const session = b.get('KEPT01');
  assert.ok(session, 'the show did not come back');
  assert.strictEqual(session.photoCount, 9);
  assert.strictEqual(session.mode, 'handoff');

  // The clock is the whole point: a handed-off screen works out which slide to
  // show from when the show started, so restoring it to "now" would jump it
  // back to the beginning.
  assert.strictEqual(session.createdAt, original.createdAt);
  assert.strictEqual(b.publicState(session).startedAt, original.createdAt);
});

check('a restored show still checks the password it was made with', async () => {
  const b0 = new Broadcast({ secret: 'test-secret' });
  const { session: made, password } = b0.create({
    userId: 1, username: 'p', title: 'x', photoCount: 3, mode: 'handoff', ttlMs: HOUR,
  });

  const b = new Broadcast({ secret: 'test-secret', store: fakeStore([{ ...made }]) });
  await b.restore();
  const back = b.get(made.code);

  assert.ok(b.verifyPassword(back, password), 'the right password was refused');
  assert.ok(!b.verifyPassword(back, 'WRON-GPAS-SWRD'), 'the wrong password was accepted');
});

check('nothing about who was watching survives, and it should not', async () => {
  // Viewers, parked polls and cached bytes all describe connections that died
  // with the old process. Each repairs itself within a poll.
  const b = new Broadcast({ secret: 'test-secret', store: fakeStore([{
    code: 'FRESH1', salt: 'aa', passwordHash: Buffer.alloc(32, 1), nonce: 'n',
    userId: 1, username: 'p', title: 'x', photoCount: 4, mode: 'handoff',
    interval: 5000, createdAt: Date.now(), expiresAt: Date.now() + HOUR,
  }]) });
  await b.restore();
  const s = b.get('FRESH1');

  assert.strictEqual(s.viewers.size, 0);
  assert.strictEqual(s.cache.size, 0);
  assert.strictEqual(s.cacheBytes, 0);
  assert.strictEqual(s.hostWaiters.length, 0);
  assert.strictEqual(s.stateWaiters.length, 0);
  assert.strictEqual(s.seedWaiters.length, 0);
  assert.strictEqual(s.pending.size, 0);
});

check('an expired show is not brought back to life', async () => {
  const b = new Broadcast({ secret: 'test-secret', store: fakeStore([{
    code: 'DEAD01', salt: 'aa', passwordHash: Buffer.alloc(32, 1), nonce: 'n',
    userId: 1, username: 'p', title: 'x', photoCount: 4, mode: 'handoff',
    interval: 5000, createdAt: Date.now() - 2 * HOUR, expiresAt: Date.now() - HOUR,
  }]) });
  assert.strictEqual(await b.restore(), 0);
  assert.strictEqual(b.get('DEAD01'), undefined);
});

check('a live show is given the presenter time to come back', async () => {
  // Restoring with hostSeenAt in the past would have the sweeper end the show
  // on its first tick, before the presenter's tab has reconnected.
  const b = new Broadcast({ secret: 'test-secret', store: fakeStore([{
    code: 'LIVE01', salt: 'aa', passwordHash: Buffer.alloc(32, 1), nonce: 'n',
    userId: 1, username: 'p', title: 'x', photoCount: 4, mode: 'live',
    interval: 5000, createdAt: Date.now() - HOUR, expiresAt: Date.now() + HOUR,
  }]) });
  await b.restore();
  b.sweep();
  assert.ok(b.get('LIVE01'), 'the sweeper ended a show the presenter could still return to');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
