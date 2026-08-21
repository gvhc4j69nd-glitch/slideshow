'use strict';

/**
 * Where a show is written down.
 *
 * The relay itself keeps no database import — it is a pure in-memory machine and
 * its tests run without Postgres. This is the piece that gives it a memory, and
 * it is handed in rather than reached for, so `new Broadcast({ secret })` still
 * behaves exactly as it always has and only the server wires up the durable
 * version.
 *
 * Everything here is best-effort. A show that fails to save is still a show: the
 * cost of a failed write is that a restart forgets it, which is precisely the
 * behaviour of the system before this file existed. Losing the broadcast because
 * the database hiccuped would be a worse trade than losing its durability, so
 * every method swallows its errors and says so in the log.
 */

const db = require('./db');

const ms = (value) => (value instanceof Date ? value.getTime() : Number(value));

/*
 * The password hash is a raw Buffer, because it is compared with
 * timingSafeEqual and that needs bytes of equal length rather than a string.
 * Raw bytes are not text, though — writing one straight into a text column is
 * rejected by Postgres as invalid UTF-8 the moment a digest contains a byte
 * above 0x7f, which is most of them. Hex both ways, and the Buffer that comes
 * back out is byte-identical to the one that went in.
 */
const hashOut = (buf) => Buffer.from(buf).toString('hex');
const hashIn = (hex) => Buffer.from(String(hex), 'hex');

function warn(what, err) {
  console.error(`Show store: could not ${what}: ${err.message}`);
}

/** Everything the relay needs to rebuild a session that is not a picture. */
function rowToRecord(row) {
  return {
    code: row.code,
    salt: row.salt,
    passwordHash: hashIn(row.password_hash),
    nonce: row.nonce,
    userId: row.user_id,
    username: row.username,
    title: row.title,
    photoCount: row.photo_count,
    mode: row.mode,
    interval: row.interval_ms,
    createdAt: ms(row.created_at),
    expiresAt: ms(row.expires_at),
  };
}

/** Write a new show down. */
async function save(session) {
  try {
    await db.query(
      `INSERT INTO shows
         (code, salt, password_hash, nonce, user_id, username, title,
          photo_count, mode, interval_ms, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_timestamp($11/1000.0),to_timestamp($12/1000.0))
       ON CONFLICT (code) DO NOTHING`,
      [session.code, session.salt, hashOut(session.passwordHash), session.nonce,
        session.userId, session.username, session.title, session.photoCount,
        session.mode, session.interval, session.createdAt, session.expiresAt],
    );
  } catch (err) {
    warn(`save show ${session.code}`, err);
  }
}

/** A show's life was extended; only its expiry can change. */
async function touch(code, expiresAt) {
  try {
    await db.query(
      'UPDATE shows SET expires_at = to_timestamp($2/1000.0) WHERE code = $1',
      [code, expiresAt],
    );
  } catch (err) {
    warn(`extend show ${code}`, err);
  }
}

/** A show ended, was replaced, or expired. */
async function remove(code) {
  try {
    await db.query('DELETE FROM shows WHERE code = $1', [code]);
  } catch (err) {
    warn(`forget show ${code}`, err);
  }
}

/**
 * Every show that has not expired, for rebuilding after a restart.
 *
 * Expired rows are cleared on the way past. They cannot be served and a
 * long-lived hand-off deck could otherwise leave weeks of them behind.
 */
async function loadAll() {
  try {
    await db.query('DELETE FROM shows WHERE expires_at <= now()');
    const result = await db.query(
      'SELECT * FROM shows WHERE expires_at > now() ORDER BY created_at',
    );
    return result.rows.map(rowToRecord);
  } catch (err) {
    warn('read the shows back', err);
    return [];
  }
}

module.exports = { save, touch, remove, loadAll };
