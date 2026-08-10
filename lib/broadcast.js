'use strict';

/**
 * Live slideshow relay.
 *
 * A host browser holds the photos; viewers ask for them by index. The server
 * never reads the files and never writes them to disk — it parks a viewer's
 * request, hands it to the host's long-poll, and streams the bytes the host
 * PUTs back to whoever was waiting. Frames sit in memory only while in flight,
 * plus a small bounded cache so several viewers on the same slide cost one
 * transfer from the host.
 */

const crypto = require('crypto');

// Ambiguous characters (0/O, 1/I/L) are left out so codes are easy to read aloud.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const CODE_LENGTH = 6;
const PASSWORD_GROUPS = 3;
const PASSWORD_GROUP_LENGTH = 4;

const HOST_POLL_MS = 25 * 1000;        // how long a host long-poll parks
const STATE_POLL_MS = 25 * 1000;       // how long a viewer state long-poll parks
const FRAME_WAIT_MS = 30 * 1000;       // how long a viewer waits for its photo
const HOST_TIMEOUT_MS = 60 * 1000;     // host considered gone after this silence
const VIEWER_TIMEOUT_MS = 45 * 1000;   // viewer considered gone after this silence
const CACHE_IDLE_MS = 5 * 60 * 1000;   // drop relayed photo bytes after this quiet
const REDISPATCH_MS = 8 * 1000;        // offer an unanswered job to someone else
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const TICKET_TTL_MS = 3 * 60 * 1000;   // long enough to pick a device, no longer

/*
 * Hand-off mode: the presenter seeds the screens, then leaves. The photos live
 * on those screens, never here, so the limits are about keeping it a *short*
 * arrangement rather than a place to park an album.
 */
const HANDOFF_MAX_PHOTOS = 50;
const HANDOFF_MIN_TTL_MS = 60 * 60 * 1000;        // 1 hour
const HANDOFF_MAX_TTL_MS = 48 * 60 * 60 * 1000;   // 48 hours, and never more in one go

const MAX_CACHED_FRAMES = 6;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_SESSIONS = 200;

function randomFrom(alphabet, length) {
  const bytes = crypto.randomBytes(length * 2);
  let out = '';
  for (let i = 0; out.length < length && i < bytes.length; i += 1) {
    // Reject values that would bias the modulo, then map into the alphabet.
    const limit = 256 - (256 % alphabet.length);
    if (bytes[i] >= limit) continue;
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out.length === length ? out : randomFrom(alphabet, length);
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

const NO_SOURCE_MESSAGE = 'No screen with a copy of this slideshow is here to send it. '
  + 'Ask the presenter to open the slideshow again to add this screen.';

/*
 * Compare on the letters alone. The hyphens are there to make a password
 * readable over the room, not to be part of the secret, so someone typing
 * "dkcadedxefex" on a television remote gets in just as someone pasting
 * "DKCA-DEDX-EFEX" does. Spacing and case carry no entropy either way.
 */
function normalisePassword(password) {
  return String(password || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generatePassword() {
  return Array.from({ length: PASSWORD_GROUPS }, () => randomFrom(ALPHABET, PASSWORD_GROUP_LENGTH)).join('-');
}

class Broadcast {
  constructor({ secret }) {
    this.secret = secret;
    this.sessions = new Map(); // code -> session
    this.tickets = new Map();  // one-time cast ticket -> {code, nonce, expires}
    const sweeper = setInterval(() => this.sweep(), 10 * 1000);
    sweeper.unref();
  }

  _hash(value, salt) {
    return crypto.createHmac('sha256', this.secret).update(`${salt}:${value}`).digest();
  }

  _newCode() {
    for (let i = 0; i < 50; i += 1) {
      const code = randomFrom(ALPHABET, CODE_LENGTH);
      if (!this.sessions.has(code)) return code;
    }
    throw new Error('Could not allocate a share code.');
  }

  /** Start a broadcast. Returns the session plus the one-time plaintext password. */
  create({ userId, username, title, photoCount, mode = 'live', ttlMs, interval }) {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw Object.assign(new Error('Too many live slideshows right now.'), { status: 503 });
    }

    const handoff = mode === 'handoff';
    if (handoff && photoCount > HANDOFF_MAX_PHOTOS) {
      throw Object.assign(
        new Error(`Hand-off is limited to ${HANDOFF_MAX_PHOTOS} photos; this show has ${photoCount}.`),
        { status: 400 },
      );
    }
    const life = handoff
      ? clamp(Number(ttlMs) || HANDOFF_MAX_TTL_MS, HANDOFF_MIN_TTL_MS, HANDOFF_MAX_TTL_MS)
      : DEFAULT_TTL_MS;

    const code = this._newCode();
    const password = generatePassword();
    const salt = crypto.randomBytes(8).toString('hex');
    const now = Date.now();

    const session = {
      code,
      salt,
      passwordHash: this._hash(normalisePassword(password), salt),
      nonce: crypto.randomBytes(8).toString('base64url'),
      userId,
      username,
      title,
      photoCount,
      createdAt: now,
      expiresAt: now + life,
      hostSeenAt: now,
      mode,
      /*
       * Hand-off playback is driven by the clock rather than by the presenter,
       * so every screen derives the same slide from the same arithmetic and
       * needs nobody to tell it what to show.
       */
      interval: Math.max(1000, Number(interval) || 5000),
      gen: 0,
      state: { index: 0, playing: true, version: 1, updatedAt: now },
      viewers: new Map(),      // viewerId -> lastSeen
      pending: new Map(),      // reqId -> {index, waiters:[res], timer}
      byIndex: new Map(),      // index -> reqId, so duplicate asks share one fetch
      queue: [],               // reqIds the host hasn't picked up yet
      hostWaiters: [],         // parked host long-polls
      stateWaiters: [],        // parked viewer state long-polls
      cache: new Map(),        // index -> {buffer, contentType}
      cacheBytes: 0,
      cacheUsedAt: now,        // last time those bytes were asked for or added
      cachedBy: new Map(),     // viewerId -> how many slides that screen holds
      seedWaiters: [],         // parked long-polls from screens willing to seed
    };

    this.sessions.set(code, session);
    return { session, password };
  }

  get(code) {
    const session = this.sessions.get(String(code || '').toUpperCase().trim());
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.end(session.code, 'expired');
      return null;
    }
    return session;
  }

  verifyPassword(session, password) {
    const supplied = this._hash(normalisePassword(password), session.salt);
    return crypto.timingSafeEqual(supplied, session.passwordHash);
  }

  /* ── Host side ──────────────────────────────────────────────────────────── */

  touchHost(session) {
    session.hostSeenAt = Date.now();
  }

  /**
   * Park a host long-poll until a viewer asks for a photo (or we time out).
   * `respond` is called with the list of pending requests.
   */
  waitForRequests(session, respond) {
    this.touchHost(session);

    if (session.queue.length) {
      const jobs = session.queue.splice(0, session.queue.length);
      respond(jobs.map((reqId) => {
        const entry = session.pending.get(reqId);
        return entry ? { reqId, index: entry.index } : null;
      }).filter(Boolean));
      return null;
    }

    const waiter = { respond, timer: null };
    waiter.timer = setTimeout(() => {
      const i = session.hostWaiters.indexOf(waiter);
      if (i >= 0) session.hostWaiters.splice(i, 1);
      respond([]);
    }, HOST_POLL_MS);
    session.hostWaiters.push(waiter);
    return waiter;
  }

  cancelHostWaiter(session, waiter) {
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const i = session.hostWaiters.indexOf(waiter);
    if (i >= 0) session.hostWaiters.splice(i, 1);
  }

  _takeQueue(session) {
    const now = Date.now();
    const jobs = session.queue.splice(0, session.queue.length);
    return jobs.map((reqId) => {
      const entry = session.pending.get(reqId);
      if (!entry) return null;
      entry.dispatchedAt = now;
      return { reqId, index: entry.index };
    }).filter(Boolean);
  }

  /*
   * A job handed to a long-poll that never answers would otherwise sit until
   * the viewer's wait ran out. That happens exactly when a presenter's tab dies
   * without closing its connection cleanly — the case hand-off is built for. So
   * anything unanswered goes back in the queue, where a seeding screen can take
   * it instead.
   */
  _redispatchStale(session) {
    const now = Date.now();
    let requeued = false;
    for (const [reqId, entry] of session.pending) {
      if (!entry.dispatchedAt || now - entry.dispatchedAt < REDISPATCH_MS) continue;
      entry.dispatchedAt = 0;
      if (!session.queue.includes(reqId)) session.queue.push(reqId);
      requeued = true;
    }
    if (requeued) this._dispatch(session);
  }

  /*
   * Hand a batch of pending requests to whoever can answer it.
   *
   * The presenting tab gets first refusal — it has the original files. Once it
   * has gone there is still a copy of every photo on each screen that finished
   * seeding, so a screen answers instead. That is what lets a television join
   * the party an hour after the presenter put their phone away.
   */
  _dispatch(session) {
    const waiter = session.hostWaiters.shift()
      || (session.mode === 'handoff' ? session.seedWaiters.shift() : null);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.respond(this._takeQueue(session));
  }

  _wakeHost(session) {
    this._dispatch(session);
  }

  /**
   * Park a seeding screen until somebody needs a photo it holds.
   *
   * A screen only takes work when no host poll is parked. While the presenter's
   * tab is open it almost always has one waiting, so the seeders stay idle and
   * the originals keep being the source.
   */
  waitForSeedRequests(session, viewerId, respond) {
    this.touchViewer(session, viewerId);

    if (session.queue.length && !session.hostWaiters.length) {
      respond(this._takeQueue(session));
      return null;
    }

    const waiter = { viewerId, respond, timer: null };
    waiter.timer = setTimeout(() => {
      const i = session.seedWaiters.indexOf(waiter);
      if (i >= 0) session.seedWaiters.splice(i, 1);
      respond([]);
    }, HOST_POLL_MS);
    session.seedWaiters.push(waiter);
    return waiter;
  }

  cancelSeedWaiter(session, waiter) {
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const i = session.seedWaiters.indexOf(waiter);
    if (i >= 0) session.seedWaiters.splice(i, 1);
  }

  /** Whether this screen holds the whole show and so may serve it to others. */
  canSeed(session, viewerId) {
    return session.mode === 'handoff'
      && (session.cachedBy.get(viewerId) || 0) >= session.photoCount;
  }

  /**
   * Why a photo never turned up.
   *
   * "The host did not send it in time" is misleading for a handed-off show
   * whose presenter left hours ago and where no screen holds a copy — that is
   * a screen arriving too late, and it deserves to be told so.
   */
  timeoutMessage(session) {
    if (session.mode !== 'handoff') return 'The host did not send that photo in time.';
    if (this.hasSource(session)) return 'That photo did not arrive in time.';
    return NO_SOURCE_MESSAGE;
  }

  /**
   * How many screens hold a full copy *and* are still here to hand it over.
   *
   * Freshness is checked directly rather than trusting the sweep, so a screen
   * that was switched off stops counting as a source straight away instead of
   * up to a sweep later.
   */
  seedCount(session) {
    const now = Date.now();
    let n = 0;
    for (const [viewerId, seen] of session.viewers) {
      if (now - seen > VIEWER_TIMEOUT_MS) continue;
      if ((session.cachedBy.get(viewerId) || 0) >= session.photoCount) n += 1;
    }
    return n;
  }

  /** Is there anything at all that could send a photo right now? */
  hasSource(session) {
    if (Date.now() - session.hostSeenAt < HOST_TIMEOUT_MS) return true;
    return session.mode === 'handoff' && this.seedCount(session) > 0;
  }

  /**
   * Supply the bytes for a parked request. Fans out to every waiter.
   *
   * `fromHost` matters: a seeding screen answering a request must not make the
   * presenter look present, or a live show would never time out.
   */
  deliverFrame(session, reqId, buffer, contentType, { fromHost = true } = {}) {
    if (fromHost) this.touchHost(session);
    const entry = session.pending.get(reqId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    session.pending.delete(reqId);
    if (session.byIndex.get(entry.index) === reqId) session.byIndex.delete(entry.index);

    this._cacheFrame(session, entry.index, buffer, contentType);
    for (const waiter of entry.waiters) waiter({ buffer, contentType });
    return true;
  }

  /** The source reports it could not read that photo. */
  failFrame(session, reqId, message, { fromHost = true } = {}) {
    if (fromHost) this.touchHost(session);
    const entry = session.pending.get(reqId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    session.pending.delete(reqId);
    if (session.byIndex.get(entry.index) === reqId) session.byIndex.delete(entry.index);
    for (const waiter of entry.waiters) waiter({ error: message || 'The host could not read that photo.' });
    return true;
  }

  _cacheFrame(session, index, buffer, contentType) {
    if (buffer.length > MAX_CACHE_BYTES) return;
    session.cacheUsedAt = Date.now();
    session.cache.set(index, { buffer, contentType });
    session.cacheBytes += buffer.length;

    while (session.cache.size > MAX_CACHED_FRAMES || session.cacheBytes > MAX_CACHE_BYTES) {
      const oldestKey = session.cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = session.cache.get(oldestKey);
      session.cache.delete(oldestKey);
      session.cacheBytes -= oldest.buffer.length;
    }
  }

  /** Host moved to a different slide or paused. Wakes every parked viewer. */
  updateState(session, { index, playing, photoCount, title, gen }) {
    this.touchHost(session);
    if (Number.isInteger(index)) session.state.index = index;
    if (typeof playing === 'boolean') session.state.playing = playing;
    if (Number.isInteger(photoCount) && photoCount > 0) session.photoCount = photoCount;
    if (typeof title === 'string' && title) session.title = title;

    // The host reordered the playlist, so viewers must drop cached slides —
    // index 3 no longer means the same photo it did a moment ago.
    if (Number.isInteger(gen) && gen !== session.gen) {
      session.gen = gen;
      session.cache.clear();
      session.cacheBytes = 0;
    }

    session.state.version += 1;
    session.state.updatedAt = Date.now();
    this._wakeStateWaiters(session);
  }

  _wakeStateWaiters(session) {
    const waiters = session.stateWaiters.splice(0, session.stateWaiters.length);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.respond(this.publicState(session));
    }
  }

  /* ── Viewer side ────────────────────────────────────────────────────────── */

  publicState(session) {
    return {
      code: session.code,
      title: session.title,
      host: session.username,
      photoCount: session.photoCount,
      gen: session.gen,
      index: session.state.index,
      playing: session.state.playing,
      version: session.state.version,
      viewers: session.viewers.size,
      hostLive: Date.now() - session.hostSeenAt < HOST_TIMEOUT_MS,
      seeds: session.mode === 'handoff' ? this.seedCount(session) : 0,
      expiresAt: session.expiresAt,
      mode: session.mode,
      // Hand-off screens run the show themselves from these three numbers.
      startedAt: session.createdAt,
      interval: session.interval,
      now: Date.now(),          // lets a screen correct for its own clock drift
    };
  }

  touchViewer(session, viewerId) {
    session.viewers.set(viewerId, Date.now());
  }

  /** Park a viewer until the host's state moves past `sinceVersion`. */
  waitForState(session, sinceVersion, respond) {
    if (!Number.isInteger(sinceVersion) || session.state.version !== sinceVersion) {
      respond(this.publicState(session));
      return null;
    }
    const waiter = { respond, timer: null };
    waiter.timer = setTimeout(() => {
      const i = session.stateWaiters.indexOf(waiter);
      if (i >= 0) session.stateWaiters.splice(i, 1);
      respond(this.publicState(session));
    }, STATE_POLL_MS);
    session.stateWaiters.push(waiter);
    return waiter;
  }

  cancelStateWaiter(session, waiter) {
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const i = session.stateWaiters.indexOf(waiter);
    if (i >= 0) session.stateWaiters.splice(i, 1);
  }

  /**
   * Ask for a photo. `respond` gets {buffer, contentType} or {error}.
   * Returns a cancel function for when the viewer disconnects early.
   */
  requestPhoto(session, index, respond) {
    const cached = session.cache.get(index);
    if (cached) {
      session.cacheUsedAt = Date.now();
      respond({ buffer: cached.buffer, contentType: cached.contentType });
      return () => {};
    }

    /*
     * Nothing can answer: the presenter has gone and no screen holding a copy
     * is here. Waiting the full thirty seconds to say so just leaves a
     * television staring at a spinner, so say it now.
     */
    if (!this.hasSource(session)) {
      respond({ error: NO_SOURCE_MESSAGE });
      return () => {};
    }

    // Somebody already asked for this slide — ride along with their request.
    const existingId = session.byIndex.get(index);
    const existing = existingId ? session.pending.get(existingId) : null;
    if (existing) {
      existing.waiters.push(respond);
      return () => {
        const i = existing.waiters.indexOf(respond);
        if (i >= 0) existing.waiters.splice(i, 1);
      };
    }

    const reqId = crypto.randomBytes(6).toString('base64url');
    const entry = { index, waiters: [respond], timer: null, dispatchedAt: 0 };
    entry.timer = setTimeout(() => {
      session.pending.delete(reqId);
      if (session.byIndex.get(index) === reqId) session.byIndex.delete(index);
      const message = this.timeoutMessage(session);
      for (const waiter of entry.waiters) waiter({ error: message });
    }, FRAME_WAIT_MS);

    session.pending.set(reqId, entry);
    session.byIndex.set(index, reqId);
    session.queue.push(reqId);
    this._wakeHost(session);

    return () => {
      const i = entry.waiters.indexOf(respond);
      if (i >= 0) entry.waiters.splice(i, 1);
    };
  }

  /* ── Hand-off ───────────────────────────────────────────────────────────── */

  /**
   * Push the end further out. Deliberately not cumulative: an extension sets a
   * new deadline at most 48 hours from now, so a show can be kept alive by
   * someone tending it but never quietly becomes permanent.
   */
  extend(session, ttlMs) {
    const life = clamp(Number(ttlMs) || HANDOFF_MAX_TTL_MS, HANDOFF_MIN_TTL_MS, HANDOFF_MAX_TTL_MS);
    session.expiresAt = Date.now() + life;
    this.touchHost(session);
    this._wakeStateWaiters(session);   // screens learn the new deadline at once
    return session.expiresAt;
  }

  /** A screen reports how much of the show it now holds locally. */
  recordCached(session, viewerId, count) {
    const held = Math.max(0, Math.min(session.photoCount, Math.floor(Number(count) || 0)));
    session.cachedBy.set(viewerId, held);
    this._wakeStateWaiters(session);   // the presenter is watching this number
    return held;
  }

  /** How the seeding is going, for the "safe to close" prompt. */
  cacheProgress(session) {
    const screens = [...session.viewers.keys()].map((id) => session.cachedBy.get(id) || 0);
    return {
      screens: screens.length,
      complete: screens.filter((n) => n >= session.photoCount).length,
      slidesHeld: screens.reduce((a, b) => a + b, 0),
      slidesNeeded: screens.length * session.photoCount,
    };
  }

  /* ── Cast tickets ───────────────────────────────────────────────────────── */

  /**
   * A single-use ticket that stands in for the code and password.
   *
   * Casting means handing a URL to a television, and a URL is the wrong place
   * for a credential — it ends up in history, in logs, and on screen. The
   * ticket is unguessable, good for a couple of minutes, and dies the moment
   * it is used, so a URL that leaks afterwards opens nothing.
   */
  createTicket(session, ttlMs = TICKET_TTL_MS) {
    const ticket = crypto.randomBytes(18).toString('base64url');
    this.tickets.set(ticket, { code: session.code, nonce: session.nonce, expires: Date.now() + ttlMs });
    return { ticket, expiresAt: Date.now() + ttlMs };
  }

  /** Exchange a ticket for its session, consuming it. */
  redeemTicket(ticket) {
    const entry = this.tickets.get(String(ticket || ''));
    if (!entry) return null;
    this.tickets.delete(ticket);                       // single use, always
    if (entry.expires < Date.now()) return null;

    const session = this.get(entry.code);
    // A broadcast that stopped and restarted gets a new nonce, so an old
    // ticket can't quietly attach to the new one.
    if (!session || session.nonce !== entry.nonce) return null;
    return session;
  }

  /* ── Lifecycle ──────────────────────────────────────────────────────────── */

  end(code, reason = 'ended') {
    const session = this.sessions.get(code);
    if (!session) return false;
    this.sessions.delete(code);

    for (const waiter of session.hostWaiters) {
      clearTimeout(waiter.timer);
      waiter.respond([]);
    }
    for (const waiter of session.stateWaiters) {
      clearTimeout(waiter.timer);
      waiter.respond({ ...this.publicState(session), ended: true, reason });
    }
    for (const entry of session.pending.values()) {
      clearTimeout(entry.timer);
      for (const waiter of entry.waiters) waiter({ error: 'The slideshow ended.' });
    }
    session.cache.clear();
    session.cacheBytes = 0;
    for (const [ticket, entry] of this.tickets) {
      if (entry.code === code) this.tickets.delete(ticket);
    }
    return true;
  }

  listForUser(userId) {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .map((session) => this.publicState(session));
  }

  /*
   * The frame cache exists so that ten screens copying the same slide cost one
   * upload rather than ten. Once the copying is over it is just photo bytes
   * held for nothing — and a handed-off show can sit for two days. So it is
   * dropped as soon as it stops being useful. The screens have their own
   * copies; nothing here needs to survive.
   */
  _dropIdleCache(session) {
    if (!session.cache.size) return;
    if (Date.now() - session.cacheUsedAt < CACHE_IDLE_MS) return;
    session.cache.clear();
    session.cacheBytes = 0;
  }

  sweep() {
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expires < now) this.tickets.delete(ticket);
    }
    for (const session of [...this.sessions.values()]) {
      for (const [viewerId, seen] of session.viewers) {
        if (now - seen > VIEWER_TIMEOUT_MS) {
          session.viewers.delete(viewerId);
          session.cachedBy.delete(viewerId);
          for (const waiter of session.seedWaiters.filter((w) => w.viewerId === viewerId)) {
            this.cancelSeedWaiter(session, waiter);
            waiter.respond([]);
          }
        }
      }
      this._dropIdleCache(session);
      this._redispatchStale(session);

      if (session.expiresAt < now) {
        this.end(session.code, 'expired');
      } else if (session.mode !== 'handoff' && now - session.hostSeenAt > HOST_TIMEOUT_MS) {
        this.end(session.code, 'host-disconnected');
      }
    }
  }
}

module.exports = {
  Broadcast, DEFAULT_TTL_MS, HOST_TIMEOUT_MS, TICKET_TTL_MS, CACHE_IDLE_MS,
  HANDOFF_MAX_PHOTOS, HANDOFF_MIN_TTL_MS, HANDOFF_MAX_TTL_MS,
};
