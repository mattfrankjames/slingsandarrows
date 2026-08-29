/**
 * db.mjs — the only file that talks to Postgres.
 *
 * The same boundary store.mjs holds for @netlify/blobs, enforced the same way
 * (see eslint.config.mjs). Changing providers, or moving off the HTTP driver,
 * should be a change to this file rather than a search across the codebase.
 *
 * ── Why the HTTP driver ──────────────────────────────────────────────────────
 *
 * Two reasons, both about running in a function rather than a server.
 *
 * Connections. A pool belongs to a long-lived process, and these handlers are
 * not one — Netlify runs as many concurrent instances as traffic asks for, each
 * with its own module scope. A pool per instance multiplies out to more
 * connections than a small Postgres will accept, and an instance frozen
 * mid-request leaks whatever it was holding. `neon()` issues each query as an
 * ordinary HTTPS request: nothing to exhaust, nothing to leak.
 *
 * Cold starts. Measured on the live site before any of this was written, a cold
 * function costs ~1000ms against ~50ms warm — far more than the queries this
 * phase set out to fix (docs/refactor-status.md). Opening a Postgres connection
 * puts TCP, TLS and authentication *inside* that cold start. An HTTPS request
 * adds nothing the runtime was not already doing.
 *
 * The tradeoff is real: no transactions and one statement per round trip. Every
 * read here is a single statement, and the one place that genuinely needs a
 * transaction — the data migration — uses the WebSocket client below instead.
 *
 * ── Authorisation is not here ────────────────────────────────────────────────
 *
 * This connects as the database owner and can read and write everything. That
 * is the same trust boundary the handlers already had over the Blob stores, and
 * it is why migrations/0001 has no row level security: sign-in is Netlify
 * Identity, whose tokens Postgres cannot read, so policies would have evaluated
 * against a null identity while looking like a defence. Authorisation lives in
 * auth.mjs, in front of the query.
 *
 * The cost is that a bug in a handler is a whole-database bug, which is what
 * scripts/check-bundle-secrets.mjs exists to keep out of the browser.
 */

import { neon, Client } from '@neondatabase/serverless';

/**
 * Netlify DB injects NETLIFY_DATABASE_URL. DATABASE_URL is accepted as a
 * fallback so the migration runner and any local tooling work against a
 * connection string supplied by hand.
 */
function connectionString() {
  const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'No database connection string. Netlify DB sets NETLIFY_DATABASE_URL — ' +
        'run `netlify db init` if it is missing, or set DATABASE_URL to ' +
        'override it locally.'
    );
  }
  return url;
}

/** @type {ReturnType<typeof neon> | null} */
let query = null;

/**
 * The tagged-template query function, memoised per instance.
 *
 * Used as sql`select * from posts where id = ${id}` — interpolations become
 * bind parameters, not string concatenation, so this is the safe construction
 * rather than a convenience. Building a query by joining strings would bypass
 * that; if a query needs to be assembled dynamically, assemble the *parameters*
 * and keep the statement literal.
 *
 * Lazy rather than module scope so importing this file does not require the
 * environment to be configured — the unit tests and the ESLint boundary probe
 * both do exactly that.
 */
/**
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 */
export function sql(strings, ...values) {
  if (!query) query = neon(connectionString());
  return query(strings, ...values);
}

/**
 * A single-use WebSocket client, for the one case the HTTP driver cannot serve:
 * several statements that must succeed or fail together.
 *
 * Only the data migration needs this. A handler reaching for it is a sign the
 * work belongs in one statement instead — Postgres can do far more per
 * statement than the Blob store could, and that is most of the point of moving.
 *
 * The caller owns the connection and must close it; `withTransaction` below is
 * the version that cannot be forgotten.
 */
export async function withTransaction(fn) {
  const client = new Client(connectionString());
  await client.connect();
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
    await client.end();
  }
}

/** Drop the memoised query function. Tests only. */
export function resetDbForTests() {
  query = null;
}
