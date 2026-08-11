#!/usr/bin/env node
'use strict';

/**
 * Vinboo (vinboo.com) — a zero-dependency photo slideshow server.
 *
 * Two things live here:
 *   1. Accounts. Everything except the viewer flow needs a signed-in user.
 *   2. A live relay so a signed-in user can stream a slideshow straight from
 *      their own machine to other browsers, using a share code and a temporary
 *      password.
 *
 * Nothing about a slideshow is stored server side. Photos and slides live on
 * the presenter's device and pass through memory only while in flight, so this
 * process keeps no media on disk and needs no volume.
 *
 * Environment:
 *   PORT             port to listen on (Railway injects this)
 *   HOST             bind address (default 0.0.0.0)
 *   DATABASE_URL     Postgres connection string (Railway injects this)
 *   DATA_ROOT        legacy accounts file, imported once on first boot
 *   SIGNUP_CODE      if set, required to create an account
 *   SESSION_SECRET   overrides the signing key kept in the database
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// Load .env for local development. In production the real environment is
// already populated and there is no file, which is not an error.
try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  // No .env here — expected on Railway.
}

const {
  sendJson, sendError, readJsonBody, readRawBody,
  parseCookies, buildCookie, clientIp, createLimiter,
} = require('./lib/http');
const { Store } = require('./lib/store');
const dbase = require('./lib/db');
const migrate = require('./lib/migrate');
const {
  Broadcast, HANDOFF_MAX_PHOTOS, HANDOFF_MIN_TTL_MS, HANDOFF_MAX_TTL_MS,
} = require('./lib/broadcast');
const auth = require('./lib/auth');

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_FRAME_BYTES = Number(process.env.MAX_FRAME_BYTES) || 25 * 1024 * 1024;

// Handed-off shows outlive the tab that made them, so cap how many one account
// can leave standing at once.
const MAX_HANDOFF_PER_USER = 3;

// ACCESS_CODE was the old whole-app gate; accounts replaced it, so it now acts
// as the signup code if SIGNUP_CODE isn't set.
const SIGNUP_CODE = (process.env.SIGNUP_CODE || process.env.ACCESS_CODE || '').trim();

const USER_COOKIE = 'slideshow_sid';
const VIEW_COOKIE = 'slideshow_view';
const USER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VIEW_TTL_MS = 12 * 60 * 60 * 1000;

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const store = new Store();
let broadcast = null;

const loginLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const joinLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const registerLimiter = createLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

/* ── Session helpers ──────────────────────────────────────────────────────── */

async function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[USER_COOKIE];
  const payload = auth.readToken(store.secret, token);
  if (!payload || payload.kind !== 'user') return null;
  return store.findUserById(payload.uid);
}

function userCookie(req, user) {
  const token = user ? auth.makeToken(store.secret, { kind: 'user', uid: user.id }, USER_TTL_MS) : '';
  return buildCookie(req, USER_COOKIE, token, Math.floor(USER_TTL_MS / 1000));
}

function viewerFor(req, code) {
  const token = parseCookies(req.headers.cookie)[VIEW_COOKIE];
  const payload = auth.readToken(store.secret, token);
  if (!payload || payload.kind !== 'view') return null;
  if (payload.code !== code) return null;
  return payload;
}

const publicUser = (user) => ({ id: user.id, username: user.username });

/**
 * The origin a television should load. A Cast device fetches the URL itself, so
 * it has to be the public one — not whatever host the presenter happens to be
 * using. SITE_URL wins; otherwise trust the proxy headers Railway sets.
 */
function publicOrigin(req) {
  const configured = (process.env.SITE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket.encrypted ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

// The name of the site, as it should be read out to somebody standing at a
// television. Set SITE_HOST (or SITE_URL) when self-hosting.
const CANONICAL_HOST = (process.env.SITE_HOST || 'vinboo.com').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|.+\.local)(:\d+)?$/i;
const PRIVATE_HOST = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * The address to *show* a presenter, which is not the address they are on.
 *
 * A deployment answers to whatever hostname the platform gave it —
 * "slideshow-production-1c4f.up.railway.app" — and reading that out to somebody
 * holding a TV remote is useless. What they need is the name of the site.
 *
 * Serving from a laptop or over a home network is the exception: there the real
 * host is the only one that works, so it wins.
 */
function displayHost(req) {
  const configured = (process.env.SITE_URL || '').trim();
  if (configured) return configured.replace(/^https?:\/\//, '').replace(/\/+$/, '');

  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (host && (LOCAL_HOST.test(host) || PRIVATE_HOST.test(host))) return host;
  return CANONICAL_HOST || host;
}

/* ── Accounts ─────────────────────────────────────────────────────────────── */

async function handleRegister(req, res) {
  const ip = clientIp(req);
  if (registerLimiter.hit(ip)) return sendError(res, 429, 'Too many sign-up attempts. Try again later.');

  const body = await readJsonBody(req);
  if (body === null) return sendError(res, 400, 'Invalid request.');

  if (SIGNUP_CODE) {
    const supplied = Buffer.from(String(body.signupCode || ''), 'utf8');
    const expected = Buffer.from(SIGNUP_CODE, 'utf8');
    const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (!ok) return sendError(res, 403, 'That sign-up code is not right.');
  }

  const username = auth.validateEmail(body.username);
  if (username.error) return sendError(res, 400, username.error);

  const password = auth.validatePassword(body.password);
  if (password.error) return sendError(res, 400, password.error);

  if (await store.findUser(username.value)) return sendError(res, 409, 'That email already has an account.');

  const passwordHash = await auth.hashPassword(password.value);
  let user;
  try {
    user = await store.addUser({ username: username.value, passwordHash });
  } catch (err) {
    // Two sign-ups for the same address can pass the check above at once;
    // the unique index is what actually settles it.
    if (err.taken) return sendError(res, 409, 'That email already has an account.');
    throw err;
  }

  sendJson(res, 201, { user: publicUser(user) }, { 'Set-Cookie': userCookie(req, user) });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (loginLimiter.hit(ip)) return sendError(res, 429, 'Too many sign-in attempts. Wait a few minutes.');

  const body = await readJsonBody(req);
  if (body === null) return sendError(res, 400, 'Invalid request.');

  const user = await store.findUser(body.username);
  // Hash even when the user is unknown, so a miss doesn't return noticeably faster.
  const stored = user ? user.passwordHash : await auth.hashPassword('placeholder-for-timing');
  const ok = await auth.verifyPassword(String(body.password || ''), stored);

  if (!user || !ok) return sendError(res, 401, 'Wrong email or password.');

  loginLimiter.reset(ip);
  sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': userCookie(req, user) });
}

/* ── Broadcast: host endpoints ────────────────────────────────────────────── */

async function handleCreateBroadcast(req, res, user) {
  const body = await readJsonBody(req);
  if (body === null) return sendError(res, 400, 'Invalid request.');

  const title = String(body.title || 'Slideshow').slice(0, 120);
  const photoCount = Number(body.photoCount);
  if (!Number.isInteger(photoCount) || photoCount < 1) {
    return sendError(res, 400, 'That slideshow has no photos to share.');
  }

  const mode = body.mode === 'handoff' ? 'handoff' : 'live';

  /*
   * One *live* broadcast per user keeps the mental model simple — a live show
   * needs this tab, and a tab can only present one thing. Handed-off shows are
   * different: they are meant to keep running while you go and do something
   * else, so starting a new share must not quietly kill them.
   */
  const mine = broadcast.listForUser(user.id);
  for (const existing of mine) {
    if (existing.mode !== 'handoff') broadcast.end(existing.code, 'replaced');
  }

  const standing = mine.filter((sessionState) => sessionState.mode === 'handoff').length;
  if (mode === 'handoff' && standing >= MAX_HANDOFF_PER_USER) {
    return sendError(res, 409,
      `You already have ${standing} handed-off slideshows running. `
      + 'Take one down before starting another.');
  }

  let created;
  try {
    created = broadcast.create({
      userId: user.id,
      username: auth.displayName(user.username),
      title,
      photoCount,
      mode,
      ttlMs: Number(body.ttlMs),
      interval: Number(body.interval),
    });
  } catch (err) {
    return sendError(res, err.status || 500, err.message);
  }

  sendJson(res, 201, {
    code: created.session.code,
    password: created.password,
    title: created.session.title,
    photoCount: created.session.photoCount,
    expiresAt: created.session.expiresAt,
    mode: created.session.mode,
    interval: created.session.interval,
  });
}

function requireOwnedSession(req, res, code, user) {
  const session = broadcast.get(code);
  if (!session) {
    sendError(res, 404, 'That slideshow is not running any more.');
    return null;
  }
  if (session.userId !== user.id) {
    sendError(res, 403, 'That slideshow belongs to someone else.');
    return null;
  }
  return session;
}

/** Long-poll: resolves when a viewer asks for a photo, or after a timeout. */
function handleHostRequests(req, res, session) {
  let settled = false;
  const waiter = broadcast.waitForRequests(session, (jobs) => {
    if (settled) return;
    settled = true;
    sendJson(res, 200, { requests: jobs, viewers: session.viewers.size, code: session.code });
  });
  res.on('close', () => {
    if (settled) return;
    settled = true;
    broadcast.cancelHostWaiter(session, waiter);
  });
}

async function handleHostFrame(req, res, session, reqId) {
  const buffer = await readRawBody(req, MAX_FRAME_BYTES);
  if (buffer === null) return sendError(res, 413, 'That photo is too large to stream.');
  if (!buffer.length) return sendError(res, 400, 'Empty photo body.');

  const contentType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  const delivered = broadcast.deliverFrame(session, reqId, buffer, contentType);
  sendJson(res, delivered ? 200 : 410, delivered ? { ok: true } : { error: 'Nobody was waiting for that photo.' });
}

/** Long-poll for a seeding screen: same shape as the host's, different source. */
function handleSeedRequests(req, res, session, viewerId) {
  let settled = false;
  const waiter = broadcast.waitForSeedRequests(session, viewerId, (jobs) => {
    if (settled) return;
    settled = true;
    sendJson(res, 200, { requests: jobs, viewers: session.viewers.size, code: session.code });
  });
  res.on('close', () => {
    if (settled) return;
    settled = true;
    broadcast.cancelSeedWaiter(session, waiter);
  });
}

async function handleSeedFrame(req, res, session, reqId) {
  const buffer = await readRawBody(req, MAX_FRAME_BYTES);
  if (buffer === null) return sendError(res, 413, 'That photo is too large to stream.');
  if (!buffer.length) return sendError(res, 400, 'Empty photo body.');

  const contentType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  const delivered = broadcast.deliverFrame(session, reqId, buffer, contentType, { fromHost: false });
  sendJson(res, delivered ? 200 : 410, delivered ? { ok: true } : { error: 'Nobody was waiting for that photo.' });
}

/* ── Broadcast: viewer endpoints ──────────────────────────────────────────── */

async function handleWatchJoin(req, res) {
  const ip = clientIp(req);
  if (joinLimiter.hit(ip)) return sendError(res, 429, 'Too many attempts. Wait a few minutes.');

  const body = await readJsonBody(req);
  if (body === null) return sendError(res, 400, 'Invalid request.');

  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const session = broadcast.get(code);
  // Same message either way, so a wrong code can't be told from a wrong password.
  if (!session || !broadcast.verifyPassword(session, body.password)) {
    return sendError(res, 401, 'That code and password do not match a running slideshow.');
  }

  joinLimiter.reset(ip);
  const viewerId = crypto.randomBytes(8).toString('base64url');
  const token = auth.makeToken(store.secret, {
    kind: 'view', code: session.code, nonce: session.nonce, vid: viewerId,
  }, VIEW_TTL_MS);

  broadcast.touchViewer(session, viewerId);
  sendJson(res, 200, broadcast.publicState(session), {
    'Set-Cookie': buildCookie(req, VIEW_COOKIE, token, Math.floor(VIEW_TTL_MS / 1000)),
  });
}

async function handleWatchRedeem(req, res) {
  const ip = clientIp(req);
  if (joinLimiter.hit(ip)) return sendError(res, 429, 'Too many attempts. Wait a few minutes.');

  const body = await readJsonBody(req);
  if (body === null) return sendError(res, 400, 'Invalid request.');

  const session = broadcast.redeemTicket(body.ticket);
  if (!session) {
    return sendError(res, 401, 'That link has already been used or has expired. Ask for a new one.');
  }

  joinLimiter.reset(ip);
  const viewerId = crypto.randomBytes(8).toString('base64url');
  const token = auth.makeToken(store.secret, {
    kind: 'view', code: session.code, nonce: session.nonce, vid: viewerId,
  }, VIEW_TTL_MS);

  broadcast.touchViewer(session, viewerId);
  sendJson(res, 200, broadcast.publicState(session), {
    'Set-Cookie': buildCookie(req, VIEW_COOKIE, token, Math.floor(VIEW_TTL_MS / 1000)),
  });
}

function requireViewer(req, res, code) {
  const session = broadcast.get(code);
  if (!session) {
    sendJson(res, 404, { error: 'That slideshow has ended.', ended: true });
    return null;
  }
  const viewer = viewerFor(req, session.code);
  if (!viewer || viewer.nonce !== session.nonce) {
    sendError(res, 401, 'Enter the code and password again.');
    return null;
  }
  broadcast.touchViewer(session, viewer.vid);
  return session;
}

function handleWatchState(req, res, session, sinceParam) {
  const since = Number(sinceParam);
  let settled = false;
  const waiter = broadcast.waitForState(session, Number.isInteger(since) ? since : null, (state) => {
    if (settled) return;
    settled = true;
    sendJson(res, 200, state);
  });
  res.on('close', () => {
    if (settled) return;
    settled = true;
    broadcast.cancelStateWaiter(session, waiter);
  });
}

function handleWatchPhoto(req, res, session, indexParam) {
  const index = Number(indexParam);
  if (!Number.isInteger(index) || index < 0 || index >= session.photoCount) {
    return sendError(res, 400, 'No such photo in this slideshow.');
  }

  let settled = false;
  const cancel = broadcast.requestPhoto(session, index, (result) => {
    if (settled) return;
    settled = true;
    if (result.error) return sendError(res, 504, result.error);
    res.writeHead(200, {
      'Content-Type': result.contentType || 'application/octet-stream',
      'Content-Length': result.buffer.length,
      // Relayed live from someone's machine — never let a proxy keep a copy.
      'Cache-Control': 'no-store, private',
    });
    res.end(result.buffer);
  });

  res.on('close', () => {
    if (settled) return;
    settled = true;
    cancel();
  });
}

/* ── Static + media ───────────────────────────────────────────────────────── */

async function serveStatic(req, res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    return sendError(res, 400, 'Invalid path.');
  }
  if (!rel) rel = 'index.html';
  if (rel === 'watch') rel = 'watch.html';
  if (rel.split('/').some((seg) => seg === '..')) return sendError(res, 400, 'Invalid path.');

  const abs = path.resolve(PUBLIC_DIR, rel);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return sendError(res, 400, 'Invalid path.');

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return sendError(res, 404, 'Not found.');
  }
  if (!stat.isFile()) return sendError(res, 404, 'Not found.');

  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs).pipe(res);
}

/* ── Router ───────────────────────────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendError(res, 400, 'Bad request.');
  }
  const { pathname } = url;
  const method = req.method || 'GET';
  const segments = pathname.split('/').filter(Boolean);

  try {
    if (pathname === '/healthz') {
      try {
        const { rows } = await dbase.query('SELECT current_database() AS db');
        return sendJson(res, 200, { ok: true, db: 'up', database: rows[0].db });
      } catch (err) {
        return sendJson(res, 503, { ok: false, db: 'down', error: err.message });
      }
    }

    /* Accounts */
    if (pathname === '/api/auth/me' && method === 'GET') {
      const user = await currentUser(req);
      return sendJson(res, 200, {
        user: user ? publicUser(user) : null,
        signupCodeRequired: Boolean(SIGNUP_CODE),
        siteHost: displayHost(req),
      });
    }
    if (pathname === '/api/auth/register' && method === 'POST') return await handleRegister(req, res);
    if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/auth/logout' && method === 'POST') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': userCookie(req, null) });
    }

    /* Viewer flow — deliberately open, since viewers have no account. */
    if (pathname === '/api/watch/join' && method === 'POST') return await handleWatchJoin(req, res);
    if (pathname === '/api/watch/redeem' && method === 'POST') return await handleWatchRedeem(req, res);

    if (segments[0] === 'api' && segments[1] === 'watch' && segments.length >= 4) {
      const code = segments[2].toUpperCase();
      const session = requireViewer(req, res, code);
      if (!session) return undefined;

      if (segments[3] === 'state' && method === 'GET') {
        return handleWatchState(req, res, session, url.searchParams.get('since'));
      }
      if (segments[3] === 'photo' && segments.length === 5 && method === 'GET') {
        return handleWatchPhoto(req, res, session, segments[4]);
      }
      if (segments[3] === 'cached' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) return sendError(res, 400, 'Invalid request.');
        const viewer = viewerFor(req, session.code);
        const held = broadcast.recordCached(session, viewer.vid, body.have);
        return sendJson(res, 200, { have: held, of: session.photoCount });
      }

      /*
       * Seeding: a screen that holds the whole show can answer requests from
       * screens that join later, which is what keeps a handed-off slideshow
       * joinable after the presenter's tab has gone.
       */
      if (segments[3] === 'requests' && method === 'GET') {
        const viewer = viewerFor(req, session.code);
        if (!broadcast.canSeed(session, viewer.vid)) {
          return sendError(res, 409, 'This screen does not hold a full copy yet.');
        }
        return handleSeedRequests(req, res, session, viewer.vid);
      }

      if (segments[3] === 'frame' && segments.length >= 5) {
        const viewer = viewerFor(req, session.code);
        if (!broadcast.canSeed(session, viewer.vid)) {
          return sendError(res, 409, 'This screen does not hold a full copy yet.');
        }
        const reqId = decodeURIComponent(segments[4]);
        if (segments.length === 6 && segments[5] === 'error' && method === 'POST') {
          const body = await readJsonBody(req);
          broadcast.failFrame(session, reqId, body && body.message, { fromHost: false });
          return sendJson(res, 200, { ok: true });
        }
        if (method === 'PUT' || method === 'POST') {
          return await handleSeedFrame(req, res, session, reqId);
        }
      }
      return sendError(res, 404, 'Unknown endpoint.');
    }

    /* Everything below needs an account. */
    const user = await currentUser(req);
    if (pathname.startsWith('/api/')) {
      if (!user) return sendError(res, 401, 'Sign in to continue.');
    }

    /* Broadcast host endpoints */
    if (pathname === '/api/broadcast' && method === 'POST') return await handleCreateBroadcast(req, res, user);
    if (pathname === '/api/broadcast/mine' && method === 'GET') {
      return sendJson(res, 200, {
        sessions: broadcast.listForUser(user.id),
        handoff: {
          maxPhotos: HANDOFF_MAX_PHOTOS,
          minTtlMs: HANDOFF_MIN_TTL_MS,
          maxTtlMs: HANDOFF_MAX_TTL_MS,
        },
      });
    }

    if (segments[0] === 'api' && segments[1] === 'broadcast' && segments.length >= 3) {
      const code = segments[2].toUpperCase();

      if (segments.length === 3 && method === 'DELETE') {
        const session = requireOwnedSession(req, res, code, user);
        if (!session) return undefined;
        broadcast.end(code, 'ended');
        return sendJson(res, 200, { ok: true });
      }

      const session = requireOwnedSession(req, res, code, user);
      if (!session) return undefined;

      if (segments[3] === 'extend' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) return sendError(res, 400, 'Invalid request.');
        if (session.mode !== 'handoff') {
          return sendError(res, 400, 'Only a handed-off slideshow has a deadline to extend.');
        }
        const expiresAt = broadcast.extend(session, Number(body.ttlMs));
        return sendJson(res, 200, { expiresAt, ...broadcast.cacheProgress(session) });
      }

      if (segments[3] === 'progress' && method === 'GET') {
        return sendJson(res, 200, {
          ...broadcast.publicState(session),
          ...broadcast.cacheProgress(session),
        });
      }

      if (segments[3] === 'cast-ticket' && method === 'POST') {
        const { ticket, expiresAt } = broadcast.createTicket(session);
        return sendJson(res, 201, {
          url: `${publicOrigin(req)}/watch?ticket=${encodeURIComponent(ticket)}`,
          expiresAt,
        });
      }

      if (segments[3] === 'requests' && method === 'GET') return handleHostRequests(req, res, session);

      // sendBeacon can only POST, so a closing tab ends its broadcast here.
      if (segments[3] === 'end' && method === 'POST') {
        broadcast.end(session.code, 'ended');
        return sendJson(res, 200, { ok: true });
      }

      if (segments[3] === 'state' && method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) return sendError(res, 400, 'Invalid request.');
        broadcast.updateState(session, body);
        return sendJson(res, 200, broadcast.publicState(session));
      }

      if (segments[3] === 'frame' && segments.length >= 5) {
        const reqId = decodeURIComponent(segments[4]);
        if (segments.length === 6 && segments[5] === 'error' && method === 'POST') {
          const body = await readJsonBody(req);
          broadcast.failFrame(session, reqId, body && body.message);
          return sendJson(res, 200, { ok: true });
        }
        if (method === 'PUT' || method === 'POST') return await handleHostFrame(req, res, session, reqId);
      }
      return sendError(res, 404, 'Unknown endpoint.');
    }

    if (pathname.startsWith('/api/')) return sendError(res, 404, 'Unknown endpoint.');
    if (method === 'GET' || method === 'HEAD') return await serveStatic(req, res, pathname);
    return sendError(res, 405, 'Method not allowed.');
  } catch (err) {
    console.error('Request failed:', err);
    if (!res.headersSent) sendError(res, 500, 'Internal server error.');
    else res.destroy();
  }
});

// Long-polls are meant to hang; don't let Node time them out underneath us.
server.requestTimeout = 0;
server.headersTimeout = 65 * 1000;
server.keepAliveTimeout = 72 * 1000;

/* ── Startup ──────────────────────────────────────────────────────────────── */

(async () => {
  const info = await dbase.connect();
  console.log(`\n  Postgres:      ${info.database} (${info.version})`);
  await migrate.run();
  await store.init();
  await store.importLegacyUsers(DATA_ROOT);

  broadcast = new Broadcast({ secret: store.secret });

  const accounts = await store.userCount();

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  Vinboo is running');
    console.log(`  →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  Accounts:      ${accounts}`);
    console.log(`  Sign-up code:  ${SIGNUP_CODE ? 'required' : 'not set (anyone can register)'}`);
    if (!SIGNUP_CODE && process.env.RAILWAY_ENVIRONMENT) {
      console.warn('  WARNING: no SIGNUP_CODE set — anyone with the URL can create an account.');
    }
    console.log('');
  });
})().catch((err) => {
  console.error(err.missingUrl ? `\n${err.message}\n` : `Could not start: ${err.message}`);
  process.exit(1);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=5000 npm start`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await dbase.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
