'use strict';

/**
 * Numbered SQL migrations.
 *
 * Files in migrations/ are applied in filename order, each inside its own
 * transaction, and recorded in schema_migrations so they run exactly once.
 *
 * To change the schema later, add a new file — never edit an applied one:
 *   migrations/0002_add_something.sql
 *
 * Railway can start several containers at once during a deploy, so the whole
 * run is wrapped in a Postgres advisory lock. Whoever gets there first
 * migrates; the others wait and then find nothing left to do.
 */

const fs = require('fs/promises');
const path = require('path');
const db = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LOCK_KEY = 8_675_309; // arbitrary but stable, so every instance takes the same lock

async function ensureRegistry() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles() {
  let entries;
  try {
    entries = await fs.readdir(MIGRATIONS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

/** Apply anything not yet recorded. Returns the names that ran. */
async function run({ log = console.log } = {}) {
  await ensureRegistry();

  const files = await listMigrationFiles();
  if (!files.length) return [];

  const applied = [];

  // A session-level lock held for the whole run, so a second booting instance
  // blocks here instead of applying the same file concurrently.
  await db.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    const { rows } = await db.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));

    for (const name of files) {
      if (done.has(name)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, name), 'utf8');

      await db.tx(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      });

      applied.push(name);
      log(`  migration applied: ${name}`);
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  }

  return applied;
}

module.exports = { run };
