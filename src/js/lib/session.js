/**
 * session.js — one place to read the current session token.
 *
 * This logic existed inline in posts.js, board.js, gallery.js and app.js, in
 * four subtly different versions, because the site runs two auth systems side
 * by side: the Netlify Identity widget and the custom sign-in modal, which
 * stores a GoTrue session in localStorage under `gotrue.user`. Every caller had
 * to know about both. Now they don't.
 *
 * Phase 1 folds the rest of the duplicated session handling in here; Phase 4
 * collapses the two systems into one and most of this disappears.
 */

import { ensureFreshSession } from '../auth-modal.js';

/**
 * The current access token, or null when nobody is signed in.
 *
 * Refreshes an expired custom-modal token first, so a session older than its
 * one-hour access token still works instead of looking signed-out.
 *
 * @returns {Promise<string | null>}
 */
export async function getToken() {
  try {
    await ensureFreshSession();

    // 1. Netlify Identity widget session — it manages its own refresh.
    const identity = window.netlifyIdentity;
    if (identity) {
      const user = identity.currentUser();
      if (user) return await user.jwt();
    }

    // 2. Custom-modal session in localStorage.
    const raw = localStorage.getItem('gotrue.user');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.access_token) {
        if (!parsed.expires_at || parsed.expires_at > Date.now()) {
          return parsed.access_token;
        }
        // Expired and ensureFreshSession() could not renew it — drop it so the
        // UI shows a clean signed-out state rather than sending a dead token.
        localStorage.removeItem('gotrue.user');
      }
    }
  } catch {
    // Any failure here means "not signed in" as far as callers are concerned.
  }
  return null;
}

/**
 * Whether someone is signed in, without paying for a token refresh.
 * @returns {boolean}
 */
export function isLoggedIn() {
  if (window.netlifyIdentity?.currentUser?.()) return true;
  try {
    const raw = localStorage.getItem('gotrue.user');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed?.access_token || !parsed?.email) return false;
    return !parsed.expires_at || parsed.expires_at > Date.now();
  } catch {
    return false;
  }
}
