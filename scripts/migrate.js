#!/usr/bin/env node
'use strict';

/**
 * Apply pending migrations without starting the server.
 *
 *   npm run migrate
 *
 * The server does this on boot too, so this is for checking what a deploy
 * would do, or for running a change against a database by hand.
 */

const db = require('../lib/db');
const migrate = require('../lib/migrate');

(async () => {
  const info = await db.connect();
  console.log(`Connected to ${info.database} (${info.version})`);

  const applied = await migrate.run();
  if (applied.length) console.log(`Applied ${applied.length} migration(s).`);
  else console.log('Already up to date — nothing to apply.');

  const { rows } = await db.query('SELECT name, applied_at FROM schema_migrations ORDER BY name');
  for (const row of rows) console.log(`  ${row.name}  ${row.applied_at.toISOString()}`);

  await db.close();
})().catch(async (err) => {
  console.error(`Migration failed: ${err.message}`);
  await db.close().catch(() => {});
  process.exit(1);
});
