'use strict';

/** Small shared HTTP helpers used across the server. */

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

/** Read and JSON-parse a request body. Returns null on bad JSON or oversize. */
async function readJsonBody(req, limit = 16 * 1024) {
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

/** Buffer a raw request body up to `limit` bytes. Returns null if too large. */
async function readRawBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) return null;

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    const key = part.slice(0, idx).trim();
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https' || Boolean(req.socket.encrypted);
}

/** Build a Set-Cookie value. Pass an empty `value` to clear the cookie. */
function buildCookie(req, name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    value ? `Max-Age=${maxAgeSeconds}` : 'Max-Age=0',
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

/**
 * Fixed-window attempt limiter, keyed by whatever string you pass in.
 * Used to slow down password and access-code guessing.
 */
function createLimiter({ max, windowMs }) {
  const hits = new Map();

  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of hits) if (entry.first < cutoff) hits.delete(key);
  }, Math.max(windowMs / 3, 30 * 1000));
  timer.unref();

  return {
    /** Returns true when the caller has exceeded the limit. */
    hit(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || now - entry.first > windowMs) {
        hits.set(key, { count: 1, first: now });
        return false;
      }
      entry.count += 1;
      return entry.count > max;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

module.exports = {
  sendJson,
  sendError,
  readJsonBody,
  readRawBody,
  parseCookies,
  isSecureRequest,
  buildCookie,
  clientIp,
  createLimiter,
};
