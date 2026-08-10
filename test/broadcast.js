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
