'use strict';

/**
 * Accounts and server settings, backed by Postgres.
 *
 * Reads go through a short-lived cache because currentUser() runs on every
 * request — including each photo the player pulls — and a slideshow would
 * otherwise mean one SELECT per frame. The window is small enough that a
 * removed account stops working within seconds.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const db = require('./db');

const USER_CACHE_TTL_MS = 30 * 1000;

const rowToUser = (row) => (row ? {
  id: row.id,
  username: row.username,
  passwordHash: row.password_hash,
  createdAt: row.created_at,
} : null);

class Store {
  constructor() {
    this.secret = null;
    this.byId = new Map();       // id -> { user, expires }
  }

  async init() {
    this.secret = await this._loadSecret();
  }

  /**
   * A stable signing key keeps sessions valid across restarts. SESSION_SECRET
   * wins if set; otherwise one is generated once and kept in the database, so
   * every instance signs identically and nothing depends on a disk volume.
   */
  async _loadSecret() {
    const fromEnv = (process.env.SESSION_SECRET || '').trim();
    if (fromEnv) return crypto.createHash('sha256').update(fromEnv).digest();

    const generated = crypto.randomBytes(32).toString('base64');
    // Two instances booting together race here; the loser's insert is ignored
    // and the follow-up SELECT gives both the same key.
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ('session_secret', $1)
       ON CONFLICT (key) DO NOTHING`,
      [generated],
    );
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = 'session_secret'`);
    return Buffer.from(rows[0].value, 'base64');
  }

  _cache(user) {
    if (user) this.byId.set(user.id, { user, expires: Date.now() + USER_CACHE_TTL_MS });
    return user;
  }

  async userCount() {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
    return rows[0].n;
  }

  async findUser(username) {
    const name = String(username == null ? '' : username).trim();
    if (!name) return null;
    const { rows } = await db.query(
      'SELECT id, username, password_hash, created_at FROM users WHERE lower(username) = lower($1)',
      [name],
    );
    return this._cache(rowToUser(rows[0]));
  }

  async findUserById(id) {
    if (!id) return null;
    const hit = this.byId.get(id);
    if (hit && hit.expires > Date.now()) return hit.user;
    this.byId.delete(id);

    const { rows } = await db.query(
      'SELECT id, username, password_hash, created_at FROM users WHERE id = $1',
      [id],
    );
    return this._cache(rowToUser(rows[0]));
  }

  async addUser({ username, passwordHash }) {
    const id = crypto.randomUUID();
    try {
      const { rows } = await db.query(
        `INSERT INTO users (id, username, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, username, password_hash, created_at`,
        [id, username, passwordHash],
      );
      return this._cache(rowToUser(rows[0]));
    } catch (err) {
      // The unique index on lower(username) is the real guard against two
      // simultaneous sign-ups claiming the same name.
      if (err.code === '23505') {
        throw Object.assign(new Error('That username is taken.'), { taken: true });
      }
      throw err;
    }
  }

  /* ── Feedback ───────────────────────────────────────────────────────────── */

  /**
   * Record a message. Nothing here is cached: it is written once and read by a
   * person, not by the request path.
   */
  async addFeedback({ subject, body, email, userId, userAgent }) {
    const id = crypto.randomUUID();
    const { rows } = await db.query(
      `INSERT INTO feedback (id, subject, body, email, user_id, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [id, subject, body, email || null, userId || null, userAgent || null],
    );
    return { id: rows[0].id, createdAt: rows[0].created_at };
  }

  /** Most recent first, for whoever is reading it. */
  async recentFeedback(limit = 50) {
    const { rows } = await db.query(
      `SELECT f.id, f.subject, f.body, f.email, f.user_id, f.user_agent, f.created_at,
              u.username
         FROM feedback f
         LEFT JOIN users u ON u.id = f.user_id
        ORDER BY f.created_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(500, Number(limit) || 50))],
    );
    return rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      body: row.body,
      email: row.email,
      from: row.username || null,
      userAgent: row.user_agent,
      createdAt: row.created_at,
    }));
  }

  /**
   * One-time lift of accounts from the old users.json file. Runs only while the
   * table is still empty, so it can't clobber or duplicate live data.
   */
  async importLegacyUsers(dataRoot, log = console.log) {
    if (!dataRoot) return 0;
    if (await this.userCount() > 0) return 0;

    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(dataRoot, 'users.json'), 'utf8'));
    } catch {
      return 0;   // nothing to import
    }
    const legacy = Array.isArray(parsed && parsed.users) ? parsed.users : [];
    if (!legacy.length) return 0;

    let imported = 0;
    for (const user of legacy) {
      if (!user || !user.username || !user.passwordHash) continue;
      const id = /^[0-9a-f-]{36}$/i.test(user.id || '') ? user.id : crypto.randomUUID();
      const { rowCount } = await db.query(
        `INSERT INTO users (id, username, password_hash, created_at)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))
         ON CONFLICT DO NOTHING`,
        [id, user.username, user.passwordHash, user.createdAt || null],
      );
      imported += rowCount;
    }
    if (imported) log(`  imported ${imported} account(s) from ${dataRoot}/users.json`);
    return imported;
  }
}

module.exports = { Store };
