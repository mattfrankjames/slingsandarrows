/**
 * Apply pending migrations, in order, exactly once each.
 *
 * The first schema went in by pasting a file into a web console. That works
 * once. It does not tell you what has already run, it cannot be replayed
 * against a fresh database to prove the bootstrap path, and it cannot run in
 * CI — which is where the from-zero path the template depends on has to be
 * proven continuously rather than remembered.
 *
 *   node scripts/migrate.mjs           apply anything pending
 *   node scripts/migrate.mjs --dry-run list what would run, touch nothing
 *
 * Reads NETLIFY_DATABASE_URL, or DATABASE_URL as an override.
 *
 * Each migration runs inside a transaction with its bookkeeping row, so a
 * failure leaves neither a half-applied schema nor a claim that it applied.
 * Postgres DDL is transactional, which is what makes that possible — it is not
 * true of every database and is worth not relying on accidentally.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withTransaction, query } from '../netlify/lib/db.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const digest = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Migrations in filename order. The 0001_ prefix is what makes that meaningful. */
export function readMigrations(dir = DIR) {
  return readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .sort()
    .map(name => {
      const sqlText = readFileSync(join(dir, name), 'utf8');
      return { name, sql: sqlText, checksum: digest(sqlText) };
    });
}

/**
 * Which migrations still need applying, and whether any applied one has since
 * been edited.
 *
 * The checksum is not paranoia. Editing a migration that has already run is
 * the single easiest way to get two databases that disagree while both report
 * being up to date — the change silently applies to every environment created
 * afterwards and to none of the ones created before.
 */
export function plan(available, applied) {
  const byName = new Map(applied.map(r => [r.name, r.checksum]));
  const pending = [];
  const altered = [];

  for (const migration of available) {
    if (!byName.has(migration.name)) pending.push(migration);
    else if (byName.get(migration.name) !== migration.checksum) altered.push(migration.name);
  }

  return { pending, altered };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  await query(`create table if not exists schema_migrations (
    name       text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  )`);

  const available = readMigrations();
  const applied = await query(`select name, checksum from schema_migrations`);
  const { pending, altered } = plan(available, applied);

  if (altered.length) {
    console.error('These migrations have changed since they were applied:');
    for (const name of altered) console.error(`  ${name}`);
    console.error('');
    console.error('Editing an applied migration produces databases that disagree');
    console.error('while both report being up to date. Add a new migration instead.');
    process.exit(1);
  }

  if (!pending.length) {
    console.log(`Up to date — ${applied.length} migration(s) applied.`);
    return;
  }

  console.log(`${pending.length} pending:`);
  for (const m of pending) console.log(`  ${m.name}`);

  if (dryRun) {
    console.log('\n--dry-run: nothing applied.');
    return;
  }

  for (const migration of pending) {
    process.stdout.write(`  applying ${migration.name} … `);
    await withTransaction(async client => {
      await client.query(migration.sql);
      await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
    });
    console.log('ok');
  }

  console.log(`\nApplied ${pending.length} migration(s).`);
}

// Importable for tests; only connects when run directly.
if (process.argv[1] && process.argv[1].endsWith('migrate.mjs')) {
  main().catch(err => {
    console.error(`\nMigration failed: ${err.message}`);
    process.exit(1);
  });
}
