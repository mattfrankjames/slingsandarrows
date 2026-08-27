/**
 * session.js — the only module that touches the stored session.
 *
 * The site runs two auth systems side by side: the Netlify Identity widget, and
 * the custom sign-in modal, which keeps a GoTrue session in localStorage under
 * `gotrue.user`. Every consumer used to know about both and reach into
 * localStorage itself — the same twenty lines appeared in post-render.js,
 * board.js, gallery.js, app.js, post-composer.js and auth-modal.js, in five
 * variants. Two of them forgot to check `expires_at`.
 *
 * Now `gotrue.user` is written and read here and nowhere else. Phase 4
 * collapses the two systems into one, and only this file changes.
 */

import { GOTRUE_API_URL } from '../identity-widget.js';

const KEY = 'gotrue.user';

/** Refresh this long before expiry, so a request can't land as the token dies. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// ── Storage ──────────────────────────────────────────────────────────────────
// localStorage throws in private-mode Safari and when storage is disabled, so
// every access is guarded. A missing session reads as "signed out", which is
// the correct degradation.

/** @returns {{access_token: string, refresh_token?: string, expires_at?: number, email?: string} | null} */
export function readSession() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Persist a GoTrue token response. Called by the sign-in modal and by refresh. */
export function saveSession({ access_token, refresh_token, expires_in, email }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      access_token,
      refresh_token,
      expires_at: Date.now() + (expires_in || 3600) * 1000,
      email,
    }));
  } catch {
    // Storage unavailable — the session lives for this page only. Not fatal.
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do; if we can't clear it we also couldn't have written it.
  }
}

/** True when the stored session has an access token that hasn't expired. */
function isLive(session) {
  if (!session?.access_token) return false;
  return !session.expires_at || session.expires_at > Date.now();
}

// ── Refresh ──────────────────────────────────────────────────────────────────
/**
 * Exchange an expiring access token for a fresh one.
 *
 * GoTrue access tokens last an hour, but a refresh token is stored alongside.
 * Without this, every visit more than an hour after sign-in looked signed-out
 * even though the session was still good. Call it once, awaited, before
 * anything reads the session.
 *
 * A failed refresh clears the session: the refresh token is dead, so the honest
 * result is a clean sign-in prompt rather than requests carrying a token the
 * server will reject.
 */
export async function ensureFreshSession() {
  const session = readSession();
  if (!session?.refresh_token) return;
  if (session.expires_at && session.expires_at - Date.now() > REFRESH_MARGIN_MS) return;

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refresh_token,
    });

    const res = await fetch(`${GOTRUE_API_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error('refresh rejected');

    const data = await res.json();
    saveSession({
      access_token:  data.access_token,
      refresh_token: data.refresh_token || session.refresh_token,
      expires_in:    data.expires_in,
      email:         session.email,
    });
  } catch {
    clearSession();
  }
}

// ── What callers actually want ───────────────────────────────────────────────

/**
 * A usable access token, or null. Refreshes first when needed.
 * @returns {Promise<string | null>}
 */
export async function getToken() {
  try {
    await ensureFreshSession();

    // The widget manages its own refresh, so prefer it when present.
    const widgetUser = window.netlifyIdentity?.currentUser?.();
    if (widgetUser) return await widgetUser.jwt();

    const session = readSession();
    if (isLive(session)) return session.access_token;
    if (session) clearSession();
  } catch {
    // Treated as signed out.
  }
  return null;
}

/** Whether someone is signed in, without paying for a refresh. */
export function isLoggedIn() {
  if (window.netlifyIdentity?.currentUser?.()) return true;
  const session = readSession();
  return isLive(session) && Boolean(session.email);
}

/** The signed-in address, or null. */
export function currentEmail() {
  const widgetUser = window.netlifyIdentity?.currentUser?.();
  if (widgetUser?.email) return widgetUser.email;

  const session = readSession();
  return isLive(session) ? (session.email ?? null) : null;
}

/** Sign out of both systems. */
export function signOut() {
  try {
    window.netlifyIdentity?.currentUser?.() && window.netlifyIdentity.logout();
  } catch {
    // Widget missing or already signed out.
  }
  clearSession();
}
