/**
 * db.mjs — the only file that talks to Postgres.
 *
 * The same boundary store-blobs.mjs holds for @netlify/blobs, enforced the same
 * way (see eslint.config.mjs). Changing transports should be a change here
 * rather than a search across the codebase.
 *
 * ── Two transports, chosen by connection string ──────────────────────────────
 *
 * Neon's HTTP driver against a Neon host, an ordinary pg pool against anything
 * else. The second case is not a nicety: `netlify dev` runs a real PostgreSQL 17
 * compiled to WebAssembly on this machine, and the Neon HTTP driver cannot talk
 * to it — it expects Neon's endpoint and rejects the local string outright.
 * That local database is the difference between a schema that has been executed
 * and one that has only been parsed.
 *
 * This selection came from @netlify/database, which did it well. That package is
 * gone because merely installing it makes every Netlify build attempt to
 * provision a database, and this account answers `403 database feature not
 * available` — so the dependency broke deploys for a service we cannot use. It
 * is a dozen lines here, against dependencies we already have.
 *
 * The HTTP transport is what runs in production, and the reasons hold. A pool
 * belongs to a long-lived process; these handlers are not one, and Netlify runs
 * as many concurrent instances as traffic asks for, each with its own module
 * scope. And a cold function on this site measured ~1000ms against ~50ms warm,
 * far more than the queries this phase set out to fix — opening a connection
 * would put TCP, TLS and authentication inside that cold start.
 *
 * ── Authorisation is not here ────────────────────────────────────────────────
 *
 * This connects as the database owner and can read and write everything, which
 * is the same trust boundary the handlers already had over the Blob stores. It
 * is why migrations/0001 has no row level security: sign-in is Netlify Identity,
 * whose tokens Postgres cannot read, so policies would have evaluated against a
 * null identity while looking like a defence. Authorisation lives in auth.mjs,
 * in front of the query.
 *
 * The cost is that a bug in a handler is a whole-database bug, which is what
 * scripts/check-bundle-secrets.mjs exists to keep out of the browser.
 */

import { neon } from '@neondatabase/serverless';
import pg from 'pg';

function connectionString() {
  const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'No database connection string. Set DATABASE_URL (or NETLIFY_DATABASE_URL) ' +
        'in Netlify → Site configuration → Environment variables, scoped to ' +
        'functions. Locally, `npx netlify dev` runs one and ' +
        '`npx netlify database connect --query "select 1"` prints its URL — ' +
        'which changes on every run, so re-read it rather than caching it.'
    );
  }
  return url;
}

/**
 * Neon serves its HTTP endpoint from *.neon.tech. Anything else — the local
 * WASM Postgres, a container in CI — gets the wire protocol.
 */
function isNeon(url) {
  try {
    return new URL(url).hostname.endsWith('.neon.tech');
  } catch {
    return false;
  }
}

/** @type {{ http: ReturnType<typeof neon>|null, pool: pg.Pool|null }|null} */
let connection = null;

/** Lazy, so importing this file does not require a database to exist. */
function conn() {
  if (connection) return connection;
  const url = connectionString();

  connection = isNeon(url)
    ? { http: neon(url), pool: null }
    : { http: null, pool: new pg.Pool({ connectionString: url }) };

  return connection;
}

/**
 * A parameterised statement.
 *
 * A table name cannot be a bind parameter, so store-pg.mjs composes the
 * identifier and passes the values here. Identifiers come from a fixed map in
 * that file and can never derive from a request; everything a caller supplies
 * goes through `params` and is bound.
 *
 * This is the only query path, deliberately. Without a parameterised escape
 * hatch, the pressure is to hand-roll quote escaping — which is the wrong
 * answer to SQL injection every time, and which an earlier draft of store-pg.mjs
 * had already done.
 *
 * @param {string} text   Statement with $1, $2 … placeholders.
 * @param {unknown[]} [params]
 * @returns {Promise<Record<string, any>[]>}
 */
export async function query(text, params = []) {
  const { http, pool } = conn();

  if (http) {
    // Neon's types allow several shapes depending on options we do not set.
    // With the defaults it resolves to rows, which is what pg returns too.
    const rows = await http.query(text, params);
    return /** @type {Record<string, any>[]} */ (rows);
  }

  const result = await pool.query(text, params);
  return result.rows;
}

/**
 * Several statements that must succeed or fail together.
 *
 * Only the migration runner needs this. A handler reaching for it is usually a
 * sign the work belongs in one statement — Postgres can do far more per
 * statement than the Blob store could, which is most of the point of moving.
 *
 * Neon's HTTP transport has no session and cannot hold a transaction open, so
 * this opens its own short-lived pool when that is the live transport. That is
 * the right shape for the one caller: migrations run against a connection
 * string, not inside a request.
 */
export async function withTransaction(fn) {
  const { pool } = conn();
  const owned = pool ?? new pg.Pool({ connectionString: connectionString() });
  const client = await owned.connect();

  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    // Rolling back can itself fail if the connection is already gone. The
    // original error is the one worth surfacing, so this one is swallowed.
    try {
      await client.query('rollback');
    } catch {
      // Connection lost — the transaction is already discarded server-side.
    }
    throw err;
  } finally {
    client.release();
    if (!pool) await owned.end();
  }
}

/** Drop the memoised connection. Tests only. */
export function resetDbForTests() {
  connection = null;
}
