#!/usr/bin/env node
'use strict';

/**
 * Vinboo (vinboo.com) — a zero-dependency photo slideshow server.
 *
 * Three things live here:
 *   1. Accounts. Everything except the viewer flow needs a signed-in user.
 *   2. A server-side photo library (subfolders of PHOTOS_ROOT).
 *   3. A live relay so a signed-in user can stream a slideshow straight from
 *      their own machine to other browsers, using a share code and a temporary
 *      password. Photos in that flow are never written to disk here.
 *
 * Environment:
 *   PORT             port to listen on (Railway injects this)
 *   HOST             bind address (default 0.0.0.0)
 *   DATABASE_URL     Postgres connection string (Railway injects this)
 *   PHOTOS_ROOT      server photo library; point at a mounted volume in prod
 *   DATA_ROOT        legacy accounts file, imported once on first boot
 *   SIGNUP_CODE      if set, required to create an account
 *   SESSION_SECRET   overrides the signing key kept in the database
 *   MAX_UPLOAD_BYTES per-file upload cap (default 100 MB)
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const {
  sendJson, sendError, readJsonBody, readRawBody,
  parseCookies, buildCookie, clientIp, createLimiter,
} = require('./lib/http');
const { Store } = require('./lib/store');
const dbase = require('./lib/db');
const migrate = require('./lib/migrate');
const { Broadcast } = require('./lib/broadcast');
const auth = require('./lib/auth');

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '0.0.0.0';
const PHOTOS_ROOT = path.resolve(process.env.PHOTOS_ROOT || path.join(__dirname, 'photos'));
const DATA_ROOT = path.resolve(process.env.DATA_ROOT || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 100 * 1024 * 1024;
const MAX_FRAME_BYTES = Number(process.env.MAX_FRAME_BYTES) || 25 * 1024 * 1024;
const MAX_SCAN_DEPTH = 6;

// ACCESS_CODE was the old whole-app gate; accounts replaced it, so it now acts
// as the signup code if SIGNUP_CODE isn't set.
const SIGNUP_CODE = (process.env.SIGNUP_CODE || process.env.ACCESS_CODE || '').trim();

const USER_COOKIE = 'slideshow_sid';
const VIEW_COOKIE = 'slideshow_view';
const USER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VIEW_TTL_MS = 12 * 60 * 60 * 1000;

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

const DECK_TYPES = {
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const isImage = (name) => Object.prototype.hasOwnProperty.call(IMAGE_TYPES, path.extname(name).toLowerCase());
const isDeck = (name) => Object.prototype.hasOwnProperty.call(DECK_TYPES, path.extname(name).toLowerCase());
const isPlayable = (name) => isImage(name) || isDeck(name);
const isHidden = (name) => name.startsWith('.');

const store = new Store();
let broadcast = null;

const loginLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const joinLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
const registerLimiter = createLimiter({ max: 10, windowMs: 60 * 60 * 1000 });

/* ── Path safety ──────────────────────────────────────────────────────────── */

function safeResolve(relPath) {
  const cleaned = String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.split('/').some((seg) => seg === '..')) return null;
  const abs = path.resolve(PHOTOS_ROOT, cleaned);
  if (abs !== PHOTOS_ROOT && !abs.startsWith(PHOTOS_ROOT + path.sep)) return null;
  return abs;
}

function validFolderName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n || n.length > 120) return null;
  if (n === '.' || n === '..') return null;
  if (/[/\\:\s]/.test(n)) return null;
  if (n.startsWith('.')) return null;
  return n;
}

function safeFileName(name) {
  const base = path.basename(String(name == null ? '' : name).replace(/\\/g, '/')).trim();
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return null;
  if (base.length > 200) return null;
  if (!isPlayable(base)) return null;
  return base;
}

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

  const username = auth.validateUsername(body.username);
  if (username.error) return sendError(res, 400, username.error);

  const password = auth.validatePassword(body.password);
  if (password.error) return sendError(res, 400, password.error);

  if (await store.findUser(username.value)) return sendError(res, 409, 'That username is taken.');

  const passwordHash = await auth.hashPassword(password.value);
  let user;
  try {
    user = await store.addUser({ username: username.value, passwordHash });
  } catch (err) {
    // Two sign-ups for the same name can pass the check above simultaneously;
    // the unique index is what actually settles it.
    if (err.taken) return sendError(res, 409, 'That username is taken.');
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

  if (!user || !ok) return sendError(res, 401, 'Wrong username or password.');

  loginLimiter.reset(ip);
  sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': userCookie(req, user) });
}

/* ── Folder + photo listing ───────────────────────────────────────────────── */

async function scanFolders(absDir, relDir, depth, out) {
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }

  const images = [];
  const decks = [];
  const subdirs = [];
  for (const entry of entries) {
    if (isHidden(entry.name)) continue;
    if (entry.isDirectory()) subdirs.push(entry.name);
    else if (entry.isFile() && isImage(entry.name)) images.push(entry.name);
    else if (entry.isFile() && isDeck(entry.name)) decks.push(entry.name);
  }

  if (relDir && (images.length > 0 || decks.length > 0)) {
    images.sort(collator.compare);
    decks.sort(collator.compare);
    out.push({
      path: relDir,
      name: path.basename(relDir),
      count: images.length,
      decks: decks.length,
      deckNames: decks,
      cover: images.length ? `${relDir}/${images[0]}` : null,
    });
  } else if (relDir && subdirs.length === 0) {
    out.push({ path: relDir, name: path.basename(relDir), count: 0, decks: 0, deckNames: [], cover: null });
  }

  if (depth < MAX_SCAN_DEPTH) {
    subdirs.sort(collator.compare);
    for (const dir of subdirs) {
      await scanFolders(path.join(absDir, dir), relDir ? `${relDir}/${dir}` : dir, depth + 1, out);
    }
  }
  return out;
}

async function handleListFolders(res) {
  await fsp.mkdir(PHOTOS_ROOT, { recursive: true });
  const folders = await scanFolders(PHOTOS_ROOT, '', 0, []);
  folders.sort((a, b) => collator.compare(a.path, b.path));
  sendJson(res, 200, { root: PHOTOS_ROOT, folders });
}

async function handleListPhotos(res, folderParam) {
  const abs = safeResolve(folderParam);
  if (!abs) return sendError(res, 400, 'Invalid folder path.');

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return sendError(res, 404, 'Folder not found.');
  }
  if (!stat.isDirectory()) return sendError(res, 400, 'Not a folder.');

  const rel = path.relative(PHOTOS_ROOT, abs).split(path.sep).join('/');
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const photos = [];
  const decks = [];

  for (const entry of entries) {
    if (!entry.isFile() || isHidden(entry.name) || !isPlayable(entry.name)) continue;
    let info;
    try {
      info = await fsp.stat(path.join(abs, entry.name));
    } catch {
      continue;
    }
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const item = {
      name: entry.name,
      path: relPath,
      url: `/media/${relPath.split('/').map(encodeURIComponent).join('/')}`,
      size: info.size,
      mtime: info.mtimeMs,
    };
    (isDeck(entry.name) ? decks : photos).push(item);
  }

  photos.sort((a, b) => collator.compare(a.name, b.name));
  decks.sort((a, b) => collator.compare(a.name, b.name));
  sendJson(res, 200, { folder: rel, count: photos.length, photos, decks });
}

async function handleCreateFolder(req, res) {
  const body = await readJsonBody(req);
  if (body === null) return sendError(res, 400, 'Invalid JSON body.');

  const name = validFolderName(body.name);
  if (!name) return sendError(res, 400, 'Folder name must be non-empty with no slashes or spaces.');

  const parentAbs = safeResolve(body.parent || '');
  if (!parentAbs) return sendError(res, 400, 'Invalid parent folder.');

  const abs = path.join(parentAbs, name);
  if (!safeResolve(path.relative(PHOTOS_ROOT, abs))) return sendError(res, 400, 'Invalid folder path.');

  try {
    await fsp.mkdir(abs, { recursive: false });
  } catch (err) {
    if (err.code === 'EEXIST') return sendError(res, 409, 'A folder with that name already exists.');
    return sendError(res, 500, `Could not create folder: ${err.code || 'unknown error'}`);
  }
  sendJson(res, 201, { folder: path.relative(PHOTOS_ROOT, abs).split(path.sep).join('/') });
}

async function handleUpload(req, res, query) {
  const abs = safeResolve(query.get('folder') || '');
  if (!abs) return sendError(res, 400, 'Invalid folder path.');

  const fileName = safeFileName(query.get('name'));
  if (!fileName) return sendError(res, 400, 'Unsupported file name. Images and .pptx only.');

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return sendError(res, 404, 'Folder not found.');
  }
  if (!stat.isDirectory()) return sendError(res, 400, 'Not a folder.');

  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return sendError(res, 413, 'File is larger than the upload limit.');
  }

  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let target = path.join(abs, fileName);
  for (let n = 2; fs.existsSync(target); n += 1) {
    if (n > 999) return sendError(res, 409, 'Too many files with that name.');
    target = path.join(abs, `${stem} (${n})${ext}`);
  }

  const tmp = path.join(abs, `.upload-${crypto.randomBytes(6).toString('hex')}`);
  const out = fs.createWriteStream(tmp);
  const cleanup = () => fsp.rm(tmp, { force: true }).catch(() => {});
  let received = 0;
  let aborted = false;

  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES && !aborted) {
          aborted = true;
          out.destroy();
          reject(Object.assign(new Error('too large'), { tooLarge: true }));
        }
      });
      req.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
  } catch (err) {
    await cleanup();
    if (err.tooLarge) return sendError(res, 413, 'File is larger than the upload limit.');
    return sendError(res, 500, 'Upload failed.');
  }

  if (received === 0) {
    await cleanup();
    return sendError(res, 400, 'Empty file.');
  }

  try {
    await fsp.rename(tmp, target);
  } catch {
    await cleanup();
    return sendError(res, 500, 'Could not save file.');
  }

  sendJson(res, 201, {
    path: path.relative(PHOTOS_ROOT, target).split(path.sep).join('/'),
    name: path.basename(target),
    size: received,
  });
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

  // One live broadcast per user keeps the mental model simple.
  for (const existing of broadcast.listForUser(user.id)) broadcast.end(existing.code, 'replaced');

  let created;
  try {
    created = broadcast.create({ userId: user.id, username: user.username, title, photoCount });
  } catch (err) {
    return sendError(res, err.status || 500, err.message);
  }

  sendJson(res, 201, {
    code: created.session.code,
    password: created.password,
    title: created.session.title,
    photoCount: created.session.photoCount,
    expiresAt: created.session.expiresAt,
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

async function serveMedia(req, res, relPath) {
  const abs = safeResolve(relPath);
  if (!abs || abs === PHOTOS_ROOT) return sendError(res, 400, 'Invalid path.');
  if (!isPlayable(abs)) return sendError(res, 403, 'Not a photo or presentation.');

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return sendError(res, 404, 'Photo not found.');
  }
  if (!stat.isFile()) return sendError(res, 404, 'Photo not found.');

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    return res.end();
  }

  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, {
    'Content-Type': IMAGE_TYPES[ext] || DECK_TYPES[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=300',
    ETag: etag,
  });
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(abs);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

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
        await dbase.query('SELECT 1');
        return sendJson(res, 200, { ok: true, db: 'up' });
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
      });
    }
    if (pathname === '/api/auth/register' && method === 'POST') return await handleRegister(req, res);
    if (pathname === '/api/auth/login' && method === 'POST') return await handleLogin(req, res);
    if (pathname === '/api/auth/logout' && method === 'POST') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': userCookie(req, null) });
    }

    /* Viewer flow — deliberately open, since viewers have no account. */
    if (pathname === '/api/watch/join' && method === 'POST') return await handleWatchJoin(req, res);

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
      return sendError(res, 404, 'Unknown endpoint.');
    }

    /* Everything below needs an account. */
    const user = await currentUser(req);
    if (pathname.startsWith('/api/') || pathname.startsWith('/media/')) {
      if (!user) return sendError(res, 401, 'Sign in to continue.');
    }

    if (pathname === '/api/folders' && (method === 'GET' || method === 'HEAD')) return await handleListFolders(res);
    if (pathname === '/api/folders' && method === 'POST') return await handleCreateFolder(req, res);
    if (pathname === '/api/photos' && (method === 'GET' || method === 'HEAD')) {
      return await handleListPhotos(res, url.searchParams.get('folder') || '');
    }
    if (pathname === '/api/upload' && (method === 'PUT' || method === 'POST')) {
      return await handleUpload(req, res, url.searchParams);
    }

    /* Broadcast host endpoints */
    if (pathname === '/api/broadcast' && method === 'POST') return await handleCreateBroadcast(req, res, user);
    if (pathname === '/api/broadcast/mine' && method === 'GET') {
      return sendJson(res, 200, { sessions: broadcast.listForUser(user.id) });
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

    if (pathname.startsWith('/media/') && (method === 'GET' || method === 'HEAD')) {
      let rel;
      try {
        rel = decodeURIComponent(pathname.slice('/media/'.length));
      } catch {
        return sendError(res, 400, 'Invalid path.');
      }
      return await serveMedia(req, res, rel);
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
  await fsp.mkdir(PHOTOS_ROOT, { recursive: true });

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
    console.log(`  Photo library: ${PHOTOS_ROOT}`);
    console.log(`  Accounts:      ${accounts}`);
    console.log(`  Sign-up code:  ${SIGNUP_CODE ? 'required' : 'not set (anyone can register)'}`);
    if (!SIGNUP_CODE && process.env.RAILWAY_ENVIRONMENT) {
      console.warn('  WARNING: no SIGNUP_CODE set — anyone with the URL can create an account.');
    }
    console.log('');
  });
})().catch((err) => {
  console.error('Could not start:', err.message);
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
