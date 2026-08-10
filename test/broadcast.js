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

console.log('\n— the limits —');

check('hand-off refuses more than the photo cap', () => {
  const b = relay();
  assert.throws(
    () => start(b, { photoCount: HANDOFF_MAX_PHOTOS + 1, mode: 'handoff' }),
    /50 photos/,
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
  assert.match(b.timeoutMessage(session), /no screen with a copy/i);

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
  assert.ok(answer && /no screen with a copy/i.test(answer.error), JSON.stringify(answer));
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
