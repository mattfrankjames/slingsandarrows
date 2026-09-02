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

/**
 * The URL fragments Netlify Identity uses to hand a token to the page.
 *
 * These arrive from an email — confirm your address, reset your password,
 * accept an invite, confirm an address change. Visiting the link does not
 * confirm anything server-side; it drops the reader here with the token in the
 * hash, and only the initialised widget exchanges it for a session.
 */
const TOKEN_HASHES = [
  'confirmation_token=',
  'recovery_token=',
  'invite_token=',
  'email_change_token=',
];

/** Is this page load the landing of one of those emails? */
export function hasIdentityToken(hash = window.location.hash) {
  return TOKEN_HASHES.some(token => hash.includes(token));
}

/** @type {Promise<void> | null} */
let loading = null;

/**
 * Fetch the widget script, once, and initialise it.
 *
 * It used to be a static `<script async>` in the head of all eight pages. That
 * is 481ms of third-party download — measured, the single slowest resource on a
 * cold visit — on every page view, to support two flows that almost no page
 * view uses: exchanging an emailed token, and opening the password-reset
 * dialog.
 *
 * Async meant it never blocked rendering, so this is not about unblocking. It
 * is about not competing for bandwidth, connections and main-thread parse time
 * with the CSS and JavaScript that content actually waits on.
 *
 * Resolves either way. A blocked or failed script leaves `window.netlifyIdentity`
 * undefined, which every caller already tolerates — they were written against a
 * script that might not have arrived yet.
 */
export function loadIdentityWidget() {
  if (loading) return loading;

  loading = new Promise(resolve => {
    if (window.netlifyIdentity) return resolve();

    const script = document.createElement('script');
    script.src = 'https://identity.netlify.com/v1/netlify-identity-widget.js';
    script.async = true;
    script.addEventListener('load', () => {
      initIdentityWidget();
      resolve();
    });
    // Ad blockers and offline both land here. Callers degrade rather than hang.
    script.addEventListener('error', () => resolve());
    document.head.appendChild(script);
  });

  return loading;
}

/**
 * Load the widget only if this page load needs it immediately.
 *
 * Called on every page, so a token link works wherever it lands — the default
 * Netlify template sends people to the site root, but the template is editable
 * and a link that silently does nothing is a miserable thing to debug.
 */
export function loadIdentityWidgetIfTokenPresent() {
  if (!hasIdentityToken()) return Promise.resolve();
  return loadIdentityWidget();
}
