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
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

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

function generatePassword() {
  return Array.from({ length: PASSWORD_GROUPS }, () => randomFrom(ALPHABET, PASSWORD_GROUP_LENGTH)).join('-');
}

class Broadcast {
  constructor({ secret }) {
    this.secret = secret;
    this.sessions = new Map(); // code -> session
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
  create({ userId, username, title, photoCount, ttlMs = DEFAULT_TTL_MS }) {
    if (this.sessions.size >= MAX_SESSIONS) {
      throw Object.assign(new Error('Too many live slideshows right now.'), { status: 503 });
    }

    const code = this._newCode();
    const password = generatePassword();
    const salt = crypto.randomBytes(8).toString('hex');
    const now = Date.now();

    const session = {
      code,
      salt,
      passwordHash: this._hash(password, salt),
      nonce: crypto.randomBytes(8).toString('base64url'),
      userId,
      username,
      title,
      photoCount,
      createdAt: now,
      expiresAt: now + ttlMs,
      hostSeenAt: now,
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
    const supplied = this._hash(String(password || '').toUpperCase().trim(), session.salt);
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

  _wakeHost(session) {
    const waiter = session.hostWaiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const jobs = session.queue.splice(0, session.queue.length);
    waiter.respond(jobs.map((reqId) => {
      const entry = session.pending.get(reqId);
      return entry ? { reqId, index: entry.index } : null;
    }).filter(Boolean));
  }

  /** Host supplies the bytes for a parked request. Fans out to every waiter. */
  deliverFrame(session, reqId, buffer, contentType) {
    this.touchHost(session);
    const entry = session.pending.get(reqId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    session.pending.delete(reqId);
    if (session.byIndex.get(entry.index) === reqId) session.byIndex.delete(entry.index);

    this._cacheFrame(session, entry.index, buffer, contentType);
    for (const waiter of entry.waiters) waiter({ buffer, contentType });
    return true;
  }

  /** Host reports it could not read that photo. */
  failFrame(session, reqId, message) {
    this.touchHost(session);
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
      expiresAt: session.expiresAt,
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
      respond({ buffer: cached.buffer, contentType: cached.contentType });
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
    const entry = { index, waiters: [respond], timer: null };
    entry.timer = setTimeout(() => {
      session.pending.delete(reqId);
      if (session.byIndex.get(index) === reqId) session.byIndex.delete(index);
      for (const waiter of entry.waiters) waiter({ error: 'The host did not send that photo in time.' });
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
    return true;
  }

  listForUser(userId) {
    return [...this.sessions.values()]
      .filter((session) => session.userId === userId)
      .map((session) => this.publicState(session));
  }

  sweep() {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      for (const [viewerId, seen] of session.viewers) {
        if (now - seen > VIEWER_TIMEOUT_MS) session.viewers.delete(viewerId);
      }
      if (session.expiresAt < now) {
        this.end(session.code, 'expired');
      } else if (now - session.hostSeenAt > HOST_TIMEOUT_MS) {
        this.end(session.code, 'host-disconnected');
      }
    }
  }
}

module.exports = { Broadcast, DEFAULT_TTL_MS, HOST_TIMEOUT_MS };
