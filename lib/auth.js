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

/*
 * An account is identified by an email address.
 *
 * This is deliberately not an attempt at RFC 5322 — that grammar admits quoted
 * strings, comments and address literals that no sign-up form should accept,
 * and a regex claiming to implement it is always wrong somewhere. What is
 * checked here is the shape people actually type, and the only real proof that
 * an address works is sending something to it.
 */
// The apostrophe stays in: O'Brien is a name, not an attack. It is the double
// quote that opens a quoted local part, so that is what is kept out.
const EMAIL_RE = /^[^\s@"<>()\[\],;:\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const MAX_EMAIL = 254;          // the longest an address may be, per RFC 5321
const MAX_LOCAL = 64;           // and the longest its local part may be

function validateEmail(value) {
  const email = String(value == null ? '' : value).trim().toLowerCase();

  if (!email) return { error: 'Enter your email address.' };
  if (email.length > MAX_EMAIL) return { error: 'That email address is too long.' };
  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address, like you@example.com.' };
  if (email.slice(0, email.lastIndexOf('@')).length > MAX_LOCAL) {
    return { error: 'That email address is too long.' };
  }
  if (email.includes('..')) return { error: 'Enter a valid email address, like you@example.com.' };

  return { value: email };
}

/**
 * The name to show other people.
 *
 * An account name is an email address, and the presenter's name is sent to
 * every screen watching — so the address itself must never leave the account
 * that owns it. Viewers see the part before the @, which is enough to say who
 * is presenting without handing out a way to contact them.
 */
function displayName(username) {
  const name = String(username == null ? '' : username).trim();
  const at = name.lastIndexOf('@');
  return at > 0 ? name.slice(0, at) : name;
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
  validateEmail,
  displayName,
  validatePassword,
};
