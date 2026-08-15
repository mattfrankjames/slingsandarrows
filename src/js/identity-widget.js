// Split out from auth-modal.js so pages with no sign-in UI (index, shows,
// studio) don't have to pull in the full custom auth modal — which builds
// and injects its whole login/signup DOM into the page as an import
// side-effect — just to initialize the Netlify Identity widget.

export const GOTRUE_API_URL = 'https://slingsandarrows.band/.netlify/identity';

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
