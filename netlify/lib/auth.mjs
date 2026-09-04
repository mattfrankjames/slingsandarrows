/**
 * auth.mjs — the single place this site decides who a request is from.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Every function used to carry its own copy of a `getUserFromRequest()` that
 * split the JWT on '.', base64-decoded the middle segment, and trusted the
 * `email` claim it found there. Decoding is not verifying: a token's payload is
 * just base64, so anyone could hand-write `{"email":"<an allowed author>"}`,
 * skip the signature entirely, and pass both the author allowlist and the admin
 * allowlist. That is now fixed here, once, for all callers.
 *
 * ── Why we call GoTrue instead of checking the signature locally ─────────────
 * Netlify Identity signs with HS256 using a symmetric secret that Netlify holds
 * and does not expose — there is no JWKS endpoint and no way to read the key,
 * so local verification with a JWT library is not possible for this provider.
 * Netlify's documented answer is to ask the Identity service itself: GET
 * /.netlify/identity/user with the bearer token returns the user for a valid
 * token and 401 for anything else. That is an authoritative check — it also
 * catches revoked and expired tokens, which signature verification alone would
 * not.
 *
 * The cost is one HTTPS round-trip per authenticated request, mitigated by the
 * short-lived cache below. When auth moves to Supabase, this module's exports
 * stay the same and the body becomes local JWKS verification with no network
 * call — callers won't change.
 */

import { unauthorized, forbidden } from './http.mjs';
import { usingPostgres } from './store.mjs';

/** How long a successfully verified token is trusted without re-asking GoTrue. */
const CACHE_TTL_MS = 60_000;

/** Hard ceiling on cached tokens so a busy instance can't grow without bound. */
const CACHE_MAX_ENTRIES = 500;

/** How long to wait on GoTrue before giving up and failing closed. */
const VERIFY_TIMEOUT_MS = 5_000;

/** token -> { user, expiresAt }. Successes only; failures are never cached. */
const verifiedTokens = new Map();

/**
 * Base URL of this site's Identity (GoTrue) instance.
 *
 * Three sources, most explicit first:
 *   1. IDENTITY_URL — a complete endpoint, used verbatim. For local development.
 *   2. URL — the site root, set by Netlify. Gets /.netlify/identity appended.
 *   3. The origin of the incoming request, likewise.
 *
 * The third exists so that authentication cannot be taken down by a missing
 * environment variable. Every deploy context — production, branch deploys,
 * deploy previews — serves /.netlify/identity on its own origin, so the request
 * we are already handling is a reliable last resort.
 *
 * @param {Request} req
 */
function identityUrl(req) {
  // Used as given: this one names the Identity endpoint itself, not a site root.
  if (process.env.IDENTITY_URL) return process.env.IDENTITY_URL.replace(/\/$/, '');

  let siteUrl = process.env.URL;
  if (!siteUrl) {
    try {
      siteUrl = new URL(req.url).origin;
    } catch {
      return null;
    }
  }

  return `${siteUrl.replace(/\/$/, '')}/.netlify/identity`;
}

/** Pull the bearer token out of the Authorization header, or null. */
function bearerToken(req) {
  const header = req.headers.get('Authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;

  const token = match[1].trim();
  // A JWT is three dot-separated segments. Rejecting anything else here saves a
  // pointless round-trip on obviously junk input; it is not a security check.
  return /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) ? token : null;
}

function cacheGet(token) {
  const hit = verifiedTokens.get(token);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    verifiedTokens.delete(token);
    return null;
  }
  return hit.user;
}

function cacheSet(token, user) {
  // Crude but bounded: drop everything rather than track insertion order. At
  // this site's volume the cache will never realistically reach the ceiling.
  if (verifiedTokens.size >= CACHE_MAX_ENTRIES) verifiedTokens.clear();
  verifiedTokens.set(token, { user, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Resolve the verified user behind a request.
 *
 * Returns `null` for every failure mode — no token, malformed token, invalid or
 * expired token, Identity unreachable, Identity misconfigured. Callers treat
 * null as 401. Failing closed on a network error is deliberate: an outage must
 * not become an authorization bypass.
 *
 * @param {Request} req
 * @returns {Promise<{ email: string, id?: string, roles: string[] } | null>}
 */
export async function getUser(req) {
  const token = bearerToken(req);
  if (!token) return null;

  const cached = cacheGet(token);
  if (cached) return cached;

  const base = identityUrl(req);
  if (!base) {
    console.error('[auth] Could not determine the Identity URL — cannot verify tokens');
    return null;
  }

  let res;
  try {
    res = await fetch(`${base}/user`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[auth] Identity request failed:', err.message);
    return null;
  }

  if (!res.ok) return null;

  let payload;
  try {
    payload = await res.json();
  } catch {
    console.error('[auth] Identity returned a non-JSON body');
    return null;
  }

  const email = typeof payload?.email === 'string' ? payload.email.trim() : '';
  if (!email) return null;

  const user = {
    email,
    id: payload.id,
    roles: payload.app_metadata?.roles || [],
  };

  cacheSet(token, user);
  return user;
}

/**
 * Roles used to be comma-separated environment variables: invisible to the app,
 * unauditable, and needing a redeploy to change. Phase 4 moves them to a table.
 *
 * Both are live, chosen the same way as the storage layer, so authorisation and
 * data cut over together — a deploy reading posts from Postgres while deciding
 * who may publish from a stale env var is a confusing half-state to debug.
 *
 * These became async as a result. Nothing outside this file called them
 * directly; the require* wrappers below were already async.
 */
// Imported rather than re-derived: this used to read process.env directly, and
// so did store.mjs, which is two places to get a two-system flag wrong. See the
// USE_POSTGRES note in store.mjs for why the environment is not the whole
// answer on Netlify.

/** Parse a comma-separated allowlist env var into lowercased addresses. */
function emailList(value) {
  return (value || '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Does this person hold this role?
 *
 * Failing closed is the whole point of the empty-list behaviour below, and it
 * has to survive the move: a database that is unreachable must not make
 * everyone an author. The query is allowed to throw and the caller turns that
 * into a 500, rather than being caught and treated as "no role" — which would
 * be indistinguishable from a correct denial in the logs.
 */
async function hasRole(email, role) {
  const address = String(email).toLowerCase();

  if (!usingPostgres()) {
    const list =
      role === 'admin'
        ? emailList(process.env.ALLOWED_ADMINS || process.env.ALLOWED_AUTHORS)
        : emailList(process.env.ALLOWED_AUTHORS);
    return list.includes(address);
  }

  const { query } = await import('./db.mjs');
  const rows = await query('select 1 from roles where email = $1 and role = $2 limit 1', [
    address,
    role,
  ]);
  return rows.length > 0;
}

/**
 * May this user publish posts and gallery items?
 *
 * Note the empty-list behaviour: if nobody is granted the role, nobody is an
 * author. Failing closed matters more than convenience for a publish gate.
 *
 * @param {{ email: string } | null} user
 */
export async function isAuthor(user) {
  if (!user?.email) return false;
  return hasRole(user.email, 'author');
}

/**
 * May this user delete other people's board and comment content?
 *
 * On the env-var path this falls back to the author list when ALLOWED_ADMINS is
 * unset, matching the behaviour the individual functions had before. The table
 * has no such fallback — a role is granted or it is not, which is the point of
 * moving them somewhere auditable.
 *
 * @param {{ email: string } | null} user
 */
export async function isAdmin(user) {
  if (!user?.email) return false;
  return hasRole(user.email, 'admin');
}

/**
 * May this user delete a piece of content owned by `ownerEmail`?
 * Owners can always remove their own; admins can remove anyone's.
 *
 * @param {{ email: string } | null} user
 * @param {string} ownerEmail
 */
export async function canModerate(user, ownerEmail) {
  if (!user?.email) return false;
  if (user.email.toLowerCase() === (ownerEmail || '').toLowerCase()) return true;
  return isAdmin(user);
}

// ── Throwing variants ────────────────────────────────────────────────────────
// The predicates above answer questions; these enforce answers. Handlers were
// all repeating the same shape — call, check for null, hand-build a 401 — so
// the enforcement now lives here and the failure travels as an HttpError that
// http.route() turns into a response.

/**
 * The verified user, or a 401.
 * @param {Request} req
 */
export async function requireUser(req) {
  const user = await getUser(req);
  if (!user) throw unauthorized();
  return user;
}

/**
 * The verified user, or a 401/403 — for publishing posts and gallery items.
 * @param {Request} req
 */
export async function requireAuthor(req) {
  const user = await requireUser(req);
  if (!(await isAuthor(user))) throw forbidden('Only band members can publish');
  return user;
}

/**
 * The verified user, or a 401/403 — for removing content owned by `ownerEmail`.
 * @param {Request} req
 * @param {string} ownerEmail
 */
export async function requireModerator(req, ownerEmail) {
  const user = await requireUser(req);
  if (!(await canModerate(user, ownerEmail))) throw forbidden('That is not yours to delete');
  return user;
}
