/**
 * Run the tests that need a real Postgres.
 *
 *   npm run test:db
 *
 * Finds a database in the first place one exists:
 *
 *   1. DATABASE_URL already in the environment
 *   2. .env in the repo root — where the Neon connection string lives
 *   3. the local WASM Postgres, if `netlify dev` is running
 *
 * The order matters. Neon is the real target and should win; the local database
 * is the fallback for working offline, and it is a different build of Postgres
 * on a different transport, so a pass there is weaker evidence.
 *
 * `.env` is read here rather than sourced by the shell because a Neon
 * connection string contains `&`, which the shell splits on.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fromEnvFile() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return null;
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find(l => l.startsWith('DATABASE_URL='));
  return line ? line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '') : null;
}

function fromLocalNetlify() {
  const result = spawnSync('npx', ['netlify', 'database', 'connect', '--query', 'select 1'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return result.stdout?.match(/postgres(ql)?:\/\/\S+/)?.[0] ?? null;
}

const url = process.env.DATABASE_URL || fromEnvFile() || fromLocalNetlify();

if (!url) {
  console.error('No database.');
  console.error('  Set DATABASE_URL, put it in .env, or start one with `npx netlify dev`.');
  process.exit(1);
}

// Say which, without saying what. Knowing whether a pass came from Neon or the
// local WASM build changes how much it is worth.
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
})();
console.log(`Testing against ${host.endsWith('.neon.tech') ? 'Neon' : 'a local Postgres'} (${host})\n`);

const run = spawnSync('npx', ['vitest', 'run', 'store-pg', 'handlers-pg'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url },
});

process.exit(run.status ?? 1);
