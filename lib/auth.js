'use strict';

/** Password hashing and signed-token helpers. */

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 },
      (err, derived) => (err ? reject(err) : resolve(derived)),
    );
  });
}

/** Returns a self-describing hash string: scrypt$N$r$p$salt$hash */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt);
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  let expected;
  try {
    expected = Buffer.from(hashB64, 'base64url');
  } catch {
    return false;
  }

  let derived;
  try {
    derived = await new Promise((resolve, reject) => {
      crypto.scrypt(
        password,
        Buffer.from(saltB64, 'base64url'),
        expected.length,
        { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(out)),
      );
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/* ── Signed tokens ────────────────────────────────────────────────────────── */

function sign(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}

/**
 * Token format: base64url(JSON payload).signature
 * The payload always carries `exp` (epoch ms).
 */
function makeToken(key, payload, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  return `${body}.${sign(key, body)}`;
}

/** Returns the payload, or null if the signature is bad or it has expired. */
function readToken(key, token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(key, body);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return payload;
}

/* ── Validation ───────────────────────────────────────────────────────────── */

const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;

function validateUsername(name) {
  const value = String(name == null ? '' : name).trim();
  if (!USERNAME_RE.test(value)) {
    return { error: 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.' };
  }
  return { value };
}

function validatePassword(password) {
  const value = String(password == null ? '' : password);
  if (value.length < 8) return { error: 'Password must be at least 8 characters.' };
  if (value.length > 200) return { error: 'Password must be under 200 characters.' };
  return { value };
}

module.exports = {
  hashPassword,
  verifyPassword,
  makeToken,
  readToken,
  validateUsername,
  validatePassword,
};
