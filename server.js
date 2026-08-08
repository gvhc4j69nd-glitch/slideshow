#!/usr/bin/env node
'use strict';

/**
 * Slideshow — a zero-dependency photo slideshow server.
 *
 * Photos live in subfolders of PHOTOS_ROOT (default ./photos). The browser UI
 * lists those subfolders, lets you upload into them, and plays a slideshow of
 * whichever one you pick.
 *
 * Environment:
 *   PORT             port to listen on (Railway injects this)
 *   HOST             bind address (default 0.0.0.0)
 *   PHOTOS_ROOT      photo library path; point this at a mounted volume in prod
 *   ACCESS_CODE      if set, visitors must enter this code before using the app
 *   SESSION_SECRET   extra entropy for session cookies (optional)
 *   MAX_UPLOAD_BYTES per-file upload cap (default 100 MB)
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '0.0.0.0';
const PHOTOS_ROOT = path.resolve(process.env.PHOTOS_ROOT || path.join(__dirname, 'photos'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES) || 100 * 1024 * 1024;
const MAX_SCAN_DEPTH = 6;

const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const AUTH_REQUIRED = ACCESS_CODE.length > 0;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_COOKIE = 'slideshow_sid';
const SESSION_KEY = crypto
  .createHash('sha256')
  .update(`${ACCESS_CODE}:${process.env.SESSION_SECRET || ''}`)
  .digest();

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
const isHidden = (name) => name.startsWith('.');

/* ── Path safety ──────────────────────────────────────────────────────────── */

/**
 * Resolve a client-supplied relative path inside PHOTOS_ROOT.
 * Returns null if it escapes the root (traversal, absolute paths, etc).
 */
function safeResolve(relPath) {
  const cleaned = String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.split('/').some((seg) => seg === '..')) return null;
  const abs = path.resolve(PHOTOS_ROOT, cleaned);
  if (abs !== PHOTOS_ROOT && !abs.startsWith(PHOTOS_ROOT + path.sep)) return null;
  return abs;
}

/** Reject folder names that would create nesting or escape the root. */
function validFolderName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n || n.length > 120) return null;
  if (n === '.' || n === '..') return null;
  if (/[/\\:\s]/.test(n)) return null;
  if (n.startsWith('.')) return null;
  return n;
}

/** Strip any directory component from an uploaded filename. */
function safeFileName(name) {
  const base = path.basename(String(name == null ? '' : name).replace(/\\/g, '/')).trim();
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return null;
  if (base.length > 200) return null;
  if (!isImage(base)) return null;
  return base;
}

/* ── Responses ────────────────────────────────────────────────────────────── */

function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/* ── Sessions ─────────────────────────────────────────────────────────────── */

function sign(value) {
  return crypto.createHmac('sha256', SESSION_KEY).update(value).digest('base64url');
}

function makeToken() {
  const expires = String(Date.now() + SESSION_TTL_MS);
  return `${expires}.${sign(expires)}`;
}

function tokenIsValid(token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const expires = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(expires);
  if (signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  return Number(expires) > Date.now();
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket.encrypted);
}

function sessionCookie(req, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    token ? `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` : 'Max-Age=0',
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function isAuthed(req) {
  if (!AUTH_REQUIRED) return true;
  return tokenIsValid(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

// Light brute-force brake on the login endpoint, keyed by client IP.
const loginAttempts = new Map();
function loginThrottled(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.first > 15 * 60 * 1000) {
    loginAttempts.set(ip, { count: 1, first: now });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [ip, entry] of loginAttempts) if (entry.first < cutoff) loginAttempts.delete(ip);
}, 5 * 60 * 1000).unref();

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

async function handleLogin(req, res) {
  if (!AUTH_REQUIRED) return sendJson(res, 200, { authed: true, required: false });

  if (loginThrottled(clientIp(req))) {
    return sendError(res, 429, 'Too many attempts. Wait a few minutes and try again.');
  }

  const body = await readJsonBody(req, 4 * 1024);
  if (body === null) return sendError(res, 400, 'Invalid request.');

  const supplied = Buffer.from(String(body.code || ''), 'utf8');
  const expected = Buffer.from(ACCESS_CODE, 'utf8');
  const ok = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (!ok) return sendError(res, 401, 'Incorrect access code.');

  loginAttempts.delete(clientIp(req));
  sendJson(res, 200, { authed: true, required: true }, { 'Set-Cookie': sessionCookie(req, makeToken()) });
}

/* ── Folder + photo listing ───────────────────────────────────────────────── */

/** Recursively collect folders under the library root. */
async function scanFolders(absDir, relDir, depth, out) {
  let entries;
  try {
    entries = await fsp.readdir(absDir, { withFileTypes: true });
  } catch {
    return out;
  }

  const images = [];
  const subdirs = [];
  for (const entry of entries) {
    if (isHidden(entry.name)) continue;
    if (entry.isDirectory()) subdirs.push(entry.name);
    else if (entry.isFile() && isImage(entry.name)) images.push(entry.name);
  }

  if (relDir && images.length > 0) {
    images.sort(collator.compare);
    out.push({
      path: relDir,
      name: path.basename(relDir),
      count: images.length,
      cover: `${relDir}/${images[0]}`,
    });
  } else if (relDir && images.length === 0 && subdirs.length === 0) {
    // Surface empty folders so a freshly created one is still visible.
    out.push({ path: relDir, name: path.basename(relDir), count: 0, cover: null });
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

  for (const entry of entries) {
    if (!entry.isFile() || isHidden(entry.name) || !isImage(entry.name)) continue;
    let info;
    try {
      info = await fsp.stat(path.join(abs, entry.name));
    } catch {
      continue;
    }
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    photos.push({
      name: entry.name,
      path: relPath,
      url: `/media/${relPath.split('/').map(encodeURIComponent).join('/')}`,
      size: info.size,
      mtime: info.mtimeMs,
    });
  }

  photos.sort((a, b) => collator.compare(a.name, b.name));
  sendJson(res, 200, { folder: rel, count: photos.length, photos });
}

async function handleCreateFolder(req, res) {
  const body = await readJsonBody(req, 8 * 1024);
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

/* ── Upload ───────────────────────────────────────────────────────────────── */

/** Upload one image as a raw request body: PUT /api/upload?folder=…&name=… */
async function handleUpload(req, res, query) {
  const abs = safeResolve(query.get('folder') || '');
  if (!abs) return sendError(res, 400, 'Invalid folder path.');

  const fileName = safeFileName(query.get('name'));
  if (!fileName) return sendError(res, 400, 'Unsupported or invalid file name. Images only.');

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

  // Never clobber an existing photo — fall back to a "name (2).jpg" style suffix.
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

async function readJsonBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) return null;
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/* ── Static + media ───────────────────────────────────────────────────────── */

async function serveMedia(req, res, relPath) {
  const abs = safeResolve(relPath);
  if (!abs || abs === PHOTOS_ROOT) return sendError(res, 400, 'Invalid path.');
  if (!isImage(abs)) return sendError(res, 403, 'Not an image.');

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

  res.writeHead(200, {
    'Content-Type': IMAGE_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream',
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
    rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    return sendError(res, 400, 'Invalid path.');
  }
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

  try {
    // Health check for Railway.
    if (pathname === '/healthz') return sendJson(res, 200, { ok: true });

    if (pathname === '/api/session') {
      if (method === 'GET') return sendJson(res, 200, { required: AUTH_REQUIRED, authed: isAuthed(req) });
      if (method === 'POST') return await handleLogin(req, res);
      if (method === 'DELETE') {
        return sendJson(res, 200, { authed: false }, { 'Set-Cookie': sessionCookie(req, '') });
      }
      return sendError(res, 405, 'Method not allowed.');
    }

    // Everything that touches photos sits behind the access code.
    const isProtected = pathname.startsWith('/api/') || pathname.startsWith('/media/');
    if (isProtected && !isAuthed(req)) return sendError(res, 401, 'Access code required.');

    if (pathname === '/api/folders' && (method === 'GET' || method === 'HEAD')) {
      return await handleListFolders(res);
    }
    if (pathname === '/api/folders' && method === 'POST') {
      return await handleCreateFolder(req, res);
    }
    if (pathname === '/api/photos' && (method === 'GET' || method === 'HEAD')) {
      return await handleListPhotos(res, url.searchParams.get('folder') || '');
    }
    if (pathname === '/api/upload' && (method === 'PUT' || method === 'POST')) {
      return await handleUpload(req, res, url.searchParams);
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

/* ── Startup ──────────────────────────────────────────────────────────────── */

fsp.mkdir(PHOTOS_ROOT, { recursive: true })
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log('');
      console.log('  Slideshow is running');
      console.log(`  →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      console.log(`  Photo library: ${PHOTOS_ROOT}`);
      console.log(`  Access code:   ${AUTH_REQUIRED ? 'required' : 'not set (open access)'}`);
      if (!AUTH_REQUIRED && process.env.RAILWAY_ENVIRONMENT) {
        console.warn('  WARNING: deployed with no ACCESS_CODE — anyone with the URL can upload.');
      }
      console.log('');
    });
  })
  .catch((err) => {
    console.error(`Could not create photo library at ${PHOTOS_ROOT}:`, err.message);
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
