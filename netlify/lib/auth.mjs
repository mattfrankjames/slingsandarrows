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

/** Parse a comma-separated allowlist env var into lowercased addresses. */
function emailList(value) {
  return (value || '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * May this user publish posts and gallery items?
 *
 * Note the empty-list behaviour: if ALLOWED_AUTHORS is unset, nobody is an
 * author. Failing closed matters more than convenience for a publish gate.
 *
 * @param {{ email: string } | null} user
 */
export function isAuthor(user) {
  if (!user?.email) return false;
  return emailList(process.env.ALLOWED_AUTHORS).includes(user.email.toLowerCase());
}

/**
 * May this user delete other people's board and comment content?
 * Falls back to the author list when ALLOWED_ADMINS is unset, matching the
 * behaviour the individual functions had before.
 *
 * @param {{ email: string } | null} user
 */
export function isAdmin(user) {
  if (!user?.email) return false;
  const admins = emailList(process.env.ALLOWED_ADMINS || process.env.ALLOWED_AUTHORS);
  return admins.includes(user.email.toLowerCase());
}

/**
 * May this user delete a piece of content owned by `ownerEmail`?
 * Owners can always remove their own; admins can remove anyone's.
 *
 * @param {{ email: string } | null} user
 * @param {string} ownerEmail
 */
export function canModerate(user, ownerEmail) {
  if (!user?.email) return false;
  if (isAdmin(user)) return true;
  return user.email.toLowerCase() === (ownerEmail || '').toLowerCase();
}
