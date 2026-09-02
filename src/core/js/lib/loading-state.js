/**
 * Show a loading state only when there is genuinely something to wait for.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 *
 * The four pages that fetch their content shipped `<div id="loading">Loading…`
 * visible in the HTML, and hid it once the fetch resolved. That is right when
 * the fetch is slow and wrong the rest of the time, and the rest of the time is
 * most of the time.
 *
 * Measured on the live feed, on a repeat visit: `domContentLoaded` at 299ms,
 * the request for /api/v1/posts starting at 303ms and finishing at 305ms — two
 * milliseconds, served from the service worker's cache. The loader was on
 * screen from HTML parse until the module graph finished loading and running.
 * It was never waiting for data. It was waiting for JavaScript, with the answer
 * already in cache, and it flashed for roughly two hundred milliseconds every
 * single visit.
 *
 * ── What this does ───────────────────────────────────────────────────────────
 *
 * The element starts hidden in the markup, and is revealed only if the work is
 * still unfinished after a threshold. A fetch that resolves from cache never
 * reveals it; a cold visit, where the same request took over a second, does.
 *
 * That also fixes the announcement. These elements carry `role="status"` and
 * `aria-live="polite"`, so a screen reader announced "Loading…" on every visit
 * regardless. Now it is announced when it is true.
 *
 * ── On the threshold ─────────────────────────────────────────────────────────
 *
 * 250ms. Below roughly a tenth of a second a response reads as instant, and up
 * to a few tenths it reads as responsive; a spinner inside that window adds
 * noise and no information. Past it, silence starts to read as broken.
 *
 * It is deliberately not zero. A threshold of zero is the current behaviour
 * with extra steps.
 */

/** @type {number} */
const DEFAULT_DELAY_MS = 250;

/**
 * Arm a loading indicator, and return the function that stands it down.
 *
 * The returned function is safe to call more than once and safe to call before
 * the delay elapses — which is the common case, and the point.
 *
 * @param {HTMLElement | null} element  The indicator. Null is tolerated so a
 *   page without one needs no special case at the call site.
 * @param {number} [delayMs]
 * @returns {() => void} Call when the work finishes, successfully or not.
 */
export function loadingIndicator(element, delayMs = DEFAULT_DELAY_MS) {
  if (!element) return () => {};

  element.hidden = true;

  const timer = setTimeout(() => {
    element.hidden = false;
  }, delayMs);

  return () => {
    clearTimeout(timer);
    element.hidden = true;
  };
}
