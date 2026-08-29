/**
 * db.mjs — the only file that talks to Supabase.
 *
 * The same boundary store.mjs holds for @netlify/blobs, and enforced the same
 * way (see eslint.config.mjs). Swapping providers, or moving off PostgREST to a
 * direct connection, should be a change to this file rather than a search.
 *
 * ── Why PostgREST rather than a `pg` connection ──────────────────────────────
 *
 * Two reasons, both about running in a function rather than a server.
 *
 * Connections. A pool belongs to a long-lived process. These handlers are not
 * one — Netlify runs as many concurrent instances as traffic asks for, each
 * with its own module scope, and a pool per instance multiplies out to more
 * connections than a small Postgres will accept. Supabase's pooler exists for
 * exactly this and would work, but PostgREST is HTTP: stateless, nothing to
 * exhaust, nothing to leak when an instance is frozen mid-request.
 *
 * Cold starts. Measured before any of this was written, a cold function on this
 * site costs ~1000ms, against ~50ms warm — far more than the queries it fixes
 * (see docs/refactor-status.md). Opening a Postgres connection means TCP, TLS
 * and authentication *inside* that cold start. An HTTPS request to PostgREST is
 * one round trip on a connection the runtime already knows how to make. This
 * phase should not make the number that actually hurts worse.
 *
 * ── Why the secret key ───────────────────────────────────────────────────────
 *
 * It bypasses row level security completely. That is deliberate for now, and
 * worth being clear-eyed about: sign-in is still Netlify Identity, whose tokens
 * mean nothing to policies that read `request.jwt.claims` from a Supabase JWT.
 * Until auth moves, the policies cannot be the gate, so authorisation stays
 * where it is today — in auth.mjs, checked before the query.
 *
 * This is not a loosening. Functions already had unrestricted access to every
 * Blob store; the trust boundary is unchanged. What changed is that RLS now
 * exists underneath it, correct and dormant, so moving auth later is a cutover
 * rather than a security project.
 *
 * The cost is that a bug in a handler is a whole-database bug. That is why
 * scripts/check-bundle-secrets.mjs fails the build if this key ever reaches a
 * browser bundle.
 */

import { createClient } from '@supabase/supabase-js';

/**
 * Read an environment variable or fail loudly at import time.
 *
 * Failing here rather than at the first query is deliberate: a missing key
 * otherwise surfaces as a PostgREST 401 on one endpoint, which reads like a
 * permissions bug and sends you looking at policies.
 */
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Add it in Netlify → Site configuration → ` +
        `Environment variables. SUPABASE_SECRET_KEY must be scoped to ` +
        `functions only — it bypasses row level security.`
    );
  }
  return value;
}

/**
 * One client per instance, reused across warm invocations.
 *
 * Created lazily rather than at module scope so that importing this file — as
 * the unit tests and the ESLint boundary probe both do — does not require the
 * environment to be configured.
 */
/** @type {import('@supabase/supabase-js').SupabaseClient | null} */
let client = null;

export function db() {
  if (client) return client;

  client = createClient(required('SUPABASE_URL'), required('SUPABASE_SECRET_KEY'), {
    auth: {
      // No user session is involved. Without these the client tries to persist
      // and refresh a session it will never have, and keeps a refresh timer
      // alive that can hold a function instance open past its response.
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: { 'X-Client-Info': 'slingsandarrows/functions' },
    },
  });

  return client;
}

/** Reset the memoised client. Tests only — nothing in a handler should call it. */
export function resetDbForTests() {
  client = null;
}
