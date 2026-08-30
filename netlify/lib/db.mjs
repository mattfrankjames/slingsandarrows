/**
 * db.mjs — the only file that talks to Postgres.
 *
 * The same boundary store.mjs holds for @netlify/blobs, enforced the same way
 * (see eslint.config.mjs). Changing providers, or moving off the HTTP driver,
 * should be a change to this file rather than a search across the codebase.
 *
 * ── Why @netlify/database rather than the Neon driver directly ───────────────
 *
 * getDatabase() picks the transport from the connection string: Neon's HTTP
 * client against a Neon host, an ordinary pg pool against anything else. That
 * second case is not a nicety. `netlify dev` runs a real PostgreSQL 17 compiled
 * to WebAssembly on this machine, and the Neon HTTP driver cannot talk to it —
 * it expects Neon's endpoint and rejects the local connection string outright.
 *
 * Which is the difference between a schema that has been executed and one that
 * has only been parsed. migrations/0001 now applies locally, and the
 * constraints it claims can be tested by violating them, rather than believed.
 *
 * The HTTP transport is still what runs in production, and the reasons hold.
 * A pool belongs to a long-lived process; these handlers are not one, and
 * Netlify runs as many concurrent instances as traffic asks for, each with its
 * own module scope. And a cold function on this site measured ~1000ms against
 * ~50ms warm, far more than the queries this phase set out to fix — opening a
 * connection would put TCP, TLS and authentication inside that cold start,
 * where an HTTPS request adds nothing the runtime was not already doing.
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

import { getDatabase } from '@netlify/database';

/** @type {ReturnType<typeof getDatabase> | null} */
let connection = null;

/**
 * The connection, memoised per instance.
 *
 * Lazy rather than module scope so importing this file does not require a
 * database to exist — the unit tests and the ESLint boundary probe both do
 * exactly that.
 */
function conn() {
  if (connection) return connection;

  const connectionString = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'No database connection string. Netlify DB sets NETLIFY_DATABASE_URL on ' +
        'deploy — the database is provisioned by deploying with @netlify/database ' +
        'installed, not by the CLI. Set DATABASE_URL to point somewhere else locally.'
    );
  }

  connection = getDatabase({ connectionString });
  return connection;
}

/**
 * Tagged-template query: sql`select * from posts where id = ${id}`.
 *
 * Interpolations become bind parameters rather than string concatenation, so
 * this is the safe construction and not merely the tidy one. Assembling a
 * statement by joining strings bypasses that entirely; when a query has to vary,
 * vary the *parameters* and keep the statement literal.
 *
 * @param {TemplateStringsArray} strings
 * @param {...unknown} values
 */
export function sql(strings, ...values) {
  return conn().sql(strings, ...values);
}

/**
 * A parameterised statement whose text is not a template literal.
 *
 * The tagged template above cannot express a table name, and a table name
 * cannot be a bind parameter — so store-pg.mjs composes the identifier and
 * passes the values here. Identifiers come from a fixed map in that file and
 * can never derive from a request; everything a caller supplies goes through
 * `params` and is bound.
 *
 * This exists so that nothing has to hand-roll quote escaping. A homemade
 * escape() is the wrong answer to SQL injection every time, and having no
 * parameterised escape hatch is what pushes people into writing one.
 *
 * @param {string} text   Statement with $1, $2 … placeholders.
 * @param {unknown[]} [params]
 */
export async function query(text, params = []) {
  const result = await conn().pool.query(text, params);
  return result.rows;
}

/**
 * Several statements that must succeed or fail together.
 *
 * Only the data migration needs this. A handler reaching for it is usually a
 * sign the work belongs in one statement — Postgres can do far more per
 * statement than the Blob store could, which is most of the point of moving.
 */
export async function withTransaction(fn) {
  const client = await conn().pool.connect();
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
  }
}

/** Drop the memoised connection. Tests only. */
export function resetDbForTests() {
  connection = null;
}
