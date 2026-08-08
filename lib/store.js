'use strict';

/**
 * Persistence for accounts and the server's signing secret.
 *
 * Accounts live in a single JSON file. This app is meant for a handful of
 * people sharing one instance, so a file plus an in-memory index is plenty —
 * there's no need for a database here.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dataRoot) {
    this.dataRoot = path.resolve(dataRoot);
    this.usersFile = path.join(this.dataRoot, 'users.json');
    this.secretFile = path.join(this.dataRoot, 'secret.key');
    this.users = new Map();   // lowercased username -> user record
    this.secret = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await fsp.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    await this._loadSecret();
    await this._loadUsers();
  }

  /**
   * A stable secret keeps login sessions valid across restarts. If the
   * operator supplies SESSION_SECRET we use that; otherwise we generate one
   * and keep it in the data directory.
   */
  async _loadSecret() {
    const fromEnv = (process.env.SESSION_SECRET || '').trim();
    if (fromEnv) {
      this.secret = crypto.createHash('sha256').update(fromEnv).digest();
      return;
    }
    try {
      const stored = await fsp.readFile(this.secretFile);
      if (stored.length >= 32) {
        this.secret = stored.subarray(0, 32);
        return;
      }
    } catch {
      // fall through and generate a fresh one
    }
    this.secret = crypto.randomBytes(32);
    await fsp.writeFile(this.secretFile, this.secret, { mode: 0o600 });
  }

  async _loadUsers() {
    let raw;
    try {
      raw = await fsp.readFile(this.usersFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${this.usersFile} is not valid JSON — refusing to start and overwrite it.`);
    }
    for (const user of parsed.users || []) this.users.set(user.username.toLowerCase(), user);
  }

  /** Serialise writes so concurrent registrations can't interleave. */
  _persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      const payload = JSON.stringify({ users: [...this.users.values()] }, null, 2);
      const tmp = `${this.usersFile}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, payload, { mode: 0o600 });
      await fsp.rename(tmp, this.usersFile);
    }).catch((err) => {
      console.error('Could not save accounts:', err.message);
    });
    return this.writeQueue;
  }

  get userCount() {
    return this.users.size;
  }

  findUser(username) {
    return this.users.get(String(username || '').toLowerCase()) || null;
  }

  findUserById(id) {
    for (const user of this.users.values()) if (user.id === id) return user;
    return null;
  }

  async addUser({ username, passwordHash }) {
    const record = {
      id: crypto.randomUUID(),
      username,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    this.users.set(username.toLowerCase(), record);
    await this._persist();
    return record;
  }
}

module.exports = { Store };
