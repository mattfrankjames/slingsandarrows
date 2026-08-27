// Split out from auth-modal.js so pages with no sign-in UI (index, shows,
// studio) don't have to pull in the full custom auth modal — which builds
// and injects its whole login/signup DOM into the page as an import
// side-effect — just to initialize the Netlify Identity widget.

/**
 * This site's Identity (GoTrue) endpoint.
 *
 * Derived from wherever the page is served rather than hardcoded. The literal
 * production URL that used to live here meant a deploy preview authenticated
 * against production across origins — and, once this code is shared, that any
 * other band's deployment would silently sign users in against *this* band's
 * Identity instance.
 *
 * Locally this needs `netlify dev`, which serves /.netlify/identity on the dev
 * origin — the same thing the /api routes already require. Under a plain
 * `parcel serve` there is no Identity endpoint to talk to either way.
 */
export const GOTRUE_API_URL = `${window.location.origin}/.netlify/identity`;

/**
 * Initialize the Netlify Identity widget with this site's APIUrl.
 *
 * This has to run on every page that could plausibly be where a
 * confirmation/recovery/invite email link lands. Those links don't confirm
 * an account server-side just by being visited — they drop the user on the
 * site with a `#confirmation_token=...` (etc.) hash, and only the widget,
 * once initialized, detects that hash and exchanges it for a confirmed
 * session. If the landing page never initializes the widget, the click does
 * nothing: the account stays unconfirmed, and a later sign-in fails with
 * "email is not verified" even though the user genuinely clicked the link.
 *
 * Safe to call more than once, and safe to call before the widget script has
 * finished loading (e.g. slow network, ad blocker) — it's just a no-op then.
 */
export function initIdentityWidget() {
  window.netlifyIdentity?.init({ APIUrl: GOTRUE_API_URL });
}
