'use strict';

/**
 * Postgres connection pool.
 *
 * Railway injects DATABASE_URL and starts the app as soon as the container is
 * up, which can be before the database is accepting connections — so the first
 * connect retries with backoff rather than crash-looping the deploy.
 */

const { Pool } = require('pg');

const CONNECT_ATTEMPTS = 8;
const CONNECT_BACKOFF_MS = 750;

let pool = null;

/**
 * Railway's private network (*.railway.internal) and local development don't
 * use TLS; its public proxy does, with a certificate we can't chain-verify.
 * DATABASE_SSL forces the decision either way.
 */
function sslFor(connectionString) {
  const override = (process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (override === 'disable' || override === 'false' || override === 'off') return false;
  if (override === 'require' || override === 'true' || override === 'on') return { rejectUnauthorized: false };

  let host = '';
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return false;
  }
  if (/sslmode=disable/i.test(connectionString)) return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  if (host.endsWith('.railway.internal')) return false;
  return { rejectUnauthorized: false };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Create the pool and wait until the database actually answers. */
async function connect() {
  const connectionString = (process.env.DATABASE_URL || '').trim();
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Vinboo stores accounts in Postgres — '
      + 'add a Postgres service in Railway, or set DATABASE_URL for local development.',
    );
  }

  pool = new Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: Number(process.env.DATABASE_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // An idle client erroring (a network blip, a database restart) must not take
  // the process down; the pool discards it and the next query gets a new one.
  pool.on('error', (err) => console.error('Postgres idle client error:', err.message));

  let lastError = null;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
    try {
      const result = await pool.query('SELECT current_database() AS db, version() AS version');
      const version = String(result.rows[0].version).split(' ').slice(0, 2).join(' ');
      return { database: result.rows[0].db, version };
    } catch (err) {
      lastError = err;
      if (attempt === CONNECT_ATTEMPTS) break;
      const wait = CONNECT_BACKOFF_MS * attempt;
      console.warn(`Postgres not ready (${err.code || err.message}); retrying in ${wait}ms…`);
      await sleep(wait);
    }
  }
  throw new Error(`Could not reach Postgres after ${CONNECT_ATTEMPTS} attempts: ${lastError.message}`);
}

/**
 * Always returns a promise — including on the "not connected" path, so a
 * caller using .catch() can't be blindsided by a synchronous throw.
 */
async function query(text, params) {
  if (!pool) throw new Error('Database is not connected yet.');
  return pool.query(text, params);
}

/** Run a function inside a transaction, rolling back if it throws. */
async function tx(fn) {
  if (!pool) throw new Error('Database is not connected yet.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The client is already broken; releasing it is all that's left.
    }
    throw err;
  } finally {
    client.release();
  }
}

async function close() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end().catch(() => {});
}

module.exports = { connect, query, tx, close, sslFor };
