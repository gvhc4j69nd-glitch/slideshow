/**
 * Database tests: migrations, the account store, and connection handling.
 *
 * Needs a Postgres database whose name ends in _test — the suite truncates
 * tables, so it refuses to run anywhere else:
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5432/vinboo_test node test/db.js
 */

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const db = require('../lib/db');
const migrate = require('../lib/migrate');
const { Store } = require('../lib/store');

let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

function guardTargetDatabase() {
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) {
    console.error('\nDATABASE_URL is not set.'
      + '\nThese tests need a throwaway Postgres database, e.g.'
      + '\n  DATABASE_URL=postgres://postgres@127.0.0.1:5432/vinboo_test node test/db.js\n');
    process.exit(1);
  }
  let name = '';
  try {
    name = new URL(url).pathname.replace(/^\//, '');
  } catch {
    console.error('\nDATABASE_URL is not a valid URL.\n');
    process.exit(1);
  }
  // Truncating someone's real database would be a very bad afternoon.
  if (!name.endsWith('_test')) {
    console.error(`\nRefusing to run against "${name}": these tests wipe tables,`
      + ' so the database name must end in _test.\n');
    process.exit(1);
  }
}

const wipe = () => db.query('TRUNCATE users, app_settings RESTART IDENTITY');

(async () => {
  guardTargetDatabase();

  console.log('\n— connection —');

  const info = await db.connect();
  await check('connects and reports the server', () => {
    assert.ok(info.database, 'database name');
    assert.match(info.version, /PostgreSQL/);
  });

  await check('ssl is off for localhost and Railway private networking', () => {
    assert.strictEqual(db.sslFor('postgres://u:p@localhost:5432/x'), false);
    assert.strictEqual(db.sslFor('postgres://u:p@127.0.0.1:5432/x'), false);
    assert.strictEqual(db.sslFor('postgres://u:p@postgres.railway.internal:5432/x'), false);
  });

  await check('ssl is on for an external host', () => {
    assert.deepStrictEqual(db.sslFor('postgres://u:p@db.example.com:5432/x'), { rejectUnauthorized: false });
  });

  await check('sslmode=disable is honoured', () => {
    assert.strictEqual(db.sslFor('postgres://u:p@db.example.com:5432/x?sslmode=disable'), false);
  });

  console.log('\n— finding the connection string —');

  await check('prefers DATABASE_URL', () => {
    const got = db.resolveConnectionString({ DATABASE_URL: 'postgres://a/x', POSTGRES_URL: 'postgres://b/y' });
    assert.strictEqual(got.url, 'postgres://a/x');
    assert.strictEqual(got.source, 'DATABASE_URL');
  });

  await check('accepts the other common spellings', () => {
    for (const name of ['DATABASE_PRIVATE_URL', 'POSTGRES_URL', 'POSTGRESQL_URL', 'PG_URL', 'DATABASE_PUBLIC_URL']) {
      const got = db.resolveConnectionString({ [name]: 'postgres://h/db' });
      assert.ok(got, `${name} should be accepted`);
      assert.strictEqual(got.source, name);
    }
  });

  await check('prefers the private URL over the public one', () => {
    const got = db.resolveConnectionString({
      DATABASE_PRIVATE_URL: 'postgres://internal/x',
      DATABASE_PUBLIC_URL: 'postgres://public/x',
    });
    assert.strictEqual(got.source, 'DATABASE_PRIVATE_URL');
  });

  await check('assembles a URL from discrete PG* variables', () => {
    const got = db.resolveConnectionString({
      PGHOST: 'db.internal', PGUSER: 'me', PGPASSWORD: 'p@ss word', PGDATABASE: 'vinboo', PGPORT: '5433',
    });
    assert.strictEqual(got.url, 'postgres://me:p%40ss%20word@db.internal:5433/vinboo');

    // A password with an @ or a space has to survive being put in a URL and
    // parsed back out by pg, or the connection fails with a confusing error.
    const parsed = require('pg-connection-string').parse(got.url);
    assert.strictEqual(parsed.password, 'p@ss word');
    assert.strictEqual(parsed.user, 'me');
    assert.strictEqual(parsed.host, 'db.internal');
    assert.strictEqual(parsed.port, '5433');
    assert.strictEqual(parsed.database, 'vinboo');
  });

  await check('returns null when nothing is configured', () => {
    assert.strictEqual(db.resolveConnectionString({}), null);
    assert.strictEqual(db.resolveConnectionString({ DATABASE_URL: '   ' }), null);
    assert.strictEqual(db.resolveConnectionString({ PGHOST: 'h' }), null, 'a partial PG* set is not enough');
  });

  await check('finds a Postgres URL under any variable name', () => {
    // Someone naming their reference DB_URL or MY_PG should still just work.
    for (const name of ['DB_URL', 'MY_PG', 'SUPABASE_CONN', 'x']) {
      const got = db.resolveConnectionString({ [name]: 'postgres://u:p@h:5432/db' });
      assert.ok(got, `${name} should be found by its value`);
      assert.strictEqual(got.source, name);
    }
    assert.ok(db.resolveConnectionString({ Q: 'postgresql://u@h/db' }), 'postgresql:// scheme too');
  });

  await check('a known name still wins over an arbitrary one', () => {
    const got = db.resolveConnectionString({ ZZZ: 'postgres://custom/x', DATABASE_URL: 'postgres://known/x' });
    assert.strictEqual(got.url, 'postgres://known/x');
  });

  await check('ignores a Railway reference that did not resolve', () => {
    // Passing "${{ Postgres.DATABASE_URL }}" to pg fails with a baffling error;
    // treating it as absent lets the startup message explain the real problem.
    assert.strictEqual(db.resolveConnectionString({ DATABASE_URL: '${{ Postgres.DATABASE_URL }}' }), null);
  });

  await check('ignores values that are not connection strings', () => {
    assert.strictEqual(db.resolveConnectionString({ DATABASE_URL: 'true' }), null);
    assert.strictEqual(db.resolveConnectionString({ SOME_FLAG: 'postgres' }), null);
  });

  console.log('\n— the startup diagnostic —');

  await check('lists database-ish variable names it can see', () => {
    const msg = db.missingUrlMessage({ PORT: '8080', PGHOST: 'h', DATABASE_SSL: 'require' });
    assert.match(msg, /PGHOST/);
    assert.match(msg, /DATABASE_SSL/);
  });

  await check('never prints a value, only names', () => {
    const secret = 'postgres://user:sup3r-s3cret@db.internal:5432/prod';
    // A value that is a URL would have been used, so use one that is not.
    const msg = db.missingUrlMessage({ DATABASE_PASSWORD: 'sup3r-s3cret', PGUSER: 'admin', OTHER: secret });
    assert.ok(!msg.includes('sup3r-s3cret'), 'credentials must never reach the log');
    assert.ok(!msg.includes('admin'), 'values must never reach the log');
    assert.match(msg, /DATABASE_PASSWORD/, 'but the name is useful');
  });

  await check('calls out an unresolved reference specifically', () => {
    const msg = db.missingUrlMessage({ DATABASE_URL: '${{ Postgres.DATABASE_URL }}' });
    assert.match(msg, /unresolved Railway reference: DATABASE_URL/);
    assert.match(msg, /does not match any service/);
  });

  await check('otherwise explains how to add the reference', () => {
    const msg = db.missingUrlMessage({ PORT: '8080' });
    assert.match(msg, /Variables\s+->\s+New Variable/);
    assert.match(msg, /none of them database related/);
  });

  console.log('\n— migrations —');

  await check('applies migrations and records them', async () => {
    await migrate.run({ log: () => {} });
    const { rows } = await db.query('SELECT name FROM schema_migrations ORDER BY name');
    assert.ok(rows.length >= 1, 'at least one migration recorded');
    assert.ok(rows.some((r) => r.name === '0001_init.sql'));
  });

  await check('creates the expected tables', async () => {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = rows.map((r) => r.table_name);
    for (const table of ['app_settings', 'schema_migrations', 'users']) {
      assert.ok(names.includes(table), `missing table ${table}`);
    }
  });

  await check('re-running applies nothing', async () => {
    const applied = await migrate.run({ log: () => {} });
    assert.deepStrictEqual(applied, [], 'second run should be a no-op');
  });

  console.log('\n— accounts —');

  await wipe();
  const store = new Store();
  await store.init();

  await check('starts empty', async () => {
    assert.strictEqual(await store.userCount(), 0);
  });

  let created;
  await check('creates an account', async () => {
    created = await store.addUser({ username: 'Ada', passwordHash: 'scrypt$fake$hash' });
    assert.match(created.id, /^[0-9a-f-]{36}$/i);
    assert.strictEqual(created.username, 'Ada');
    assert.ok(created.createdAt instanceof Date);
    assert.strictEqual(await store.userCount(), 1);
  });

  await check('finds by username, case-insensitively', async () => {
    for (const name of ['Ada', 'ada', 'ADA']) {
      const found = await store.findUser(name);
      assert.ok(found, `should find ${name}`);
      assert.strictEqual(found.id, created.id);
    }
  });

  await check('finds by id and carries the password hash', async () => {
    const found = await store.findUserById(created.id);
    assert.strictEqual(found.username, 'Ada');
    assert.strictEqual(found.passwordHash, 'scrypt$fake$hash');
  });

  await check('unknown lookups return null, not a throw', async () => {
    assert.strictEqual(await store.findUser('nobody'), null);
    assert.strictEqual(await store.findUser(''), null);
    assert.strictEqual(await store.findUserById(crypto.randomUUID()), null);
    assert.strictEqual(await store.findUserById(null), null);
  });

  await check('rejects a duplicate username in another case', async () => {
    await assert.rejects(
      () => store.addUser({ username: 'ADA', passwordHash: 'x' }),
      (err) => err.taken === true,
    );
    assert.strictEqual(await store.userCount(), 1, 'the failed insert must not count');
  });

  await check('a malformed id is rejected without crashing', async () => {
    // Postgres would raise 22P02 on a bad uuid; make sure it surfaces as an error
    // rather than taking a request down silently.
    await assert.rejects(() => store.findUserById('not-a-uuid'));
  });

  await check('cached reads still reflect a fresh account', async () => {
    const second = await store.addUser({ username: 'grace', passwordHash: 'h2' });
    assert.strictEqual((await store.findUserById(second.id)).username, 'grace');
    assert.strictEqual(await store.userCount(), 2);
  });

  console.log('\n— signing key —');

  await check('the key persists, so sessions survive a restart', async () => {
    const again = new Store();
    await again.init();
    assert.ok(Buffer.isBuffer(again.secret));
    assert.strictEqual(again.secret.length, 32);
    assert.ok(again.secret.equals(store.secret), 'a second boot must reuse the stored key');
  });

  await check('SESSION_SECRET overrides the stored key', async () => {
    process.env.SESSION_SECRET = 'an-explicit-secret';
    const overridden = new Store();
    await overridden.init();
    delete process.env.SESSION_SECRET;
    assert.ok(!overridden.secret.equals(store.secret));
    assert.strictEqual(overridden.secret.length, 32);
  });

  console.log('\n— importing the old users.json —');

  await check('imports legacy accounts into an empty table', async () => {
    await wipe();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vinboo-legacy-'));
    await fs.writeFile(path.join(dir, 'users.json'), JSON.stringify({
      users: [
        { id: crypto.randomUUID(), username: 'legacy1', passwordHash: 'h1', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'not-a-uuid', username: 'legacy2', passwordHash: 'h2' },
      ],
    }));

    const fresh = new Store();
    await fresh.init();
    assert.strictEqual(await fresh.importLegacyUsers(dir, () => {}), 2);
    assert.strictEqual((await fresh.findUser('legacy1')).passwordHash, 'h1');
    assert.ok(await fresh.findUser('legacy2'), 'a bad legacy id should be replaced, not dropped');

    // Second call must be a no-op now that the table has rows.
    assert.strictEqual(await fresh.importLegacyUsers(dir, () => {}), 0);
    assert.strictEqual(await fresh.userCount(), 2);
    await fs.rm(dir, { recursive: true, force: true });
  });

  await check('missing or unreadable legacy file is not an error', async () => {
    await wipe();
    const fresh = new Store();
    await fresh.init();
    assert.strictEqual(await fresh.importLegacyUsers('/nonexistent/path', () => {}), 0);
    assert.strictEqual(await fresh.importLegacyUsers(null, () => {}), 0);
  });

  console.log('\n— transactions —');

  await check('rolls back on failure', async () => {
    await wipe();
    await assert.rejects(() => db.tx(async (client) => {
      await client.query(
        'INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), 'rollback-me', 'h'],
      );
      throw new Error('boom');
    }));
    const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
    assert.strictEqual(rows[0].n, 0, 'the insert must not survive the rollback');
  });

  await check('commits on success', async () => {
    await db.tx(async (client) => {
      await client.query(
        'INSERT INTO users (id, username, password_hash) VALUES ($1, $2, $3)',
        [crypto.randomUUID(), 'committed', 'h'],
      );
    });
    const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
    assert.strictEqual(rows[0].n, 1);
  });

  await wipe();
  await db.close();

  await check('queries after close fail loudly', async () => {
    await assert.rejects(() => db.query('SELECT 1'), /not connected/);
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error('test crashed:', err);
  await db.close().catch(() => {});
  process.exit(1);
});
