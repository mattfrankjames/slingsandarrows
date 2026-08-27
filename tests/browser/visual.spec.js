import { test, expect } from '@playwright/test';
import { PAGES } from './pages.js';
import { stubContent } from './fixtures.js';

// The service worker serves Cloudinary media cache-first (sw.js), and a service
// worker's fetch is not interceptable by page.route — so stubbed images would
// leak the real network response as soon as the worker took control. That is
// not hypothetical: it produced a lightbox baseline containing Cloudinary's
// demo photograph while the thumbnail behind it showed the placeholder,
// because the tile loaded before the worker claimed the page and the lightbox
// image after. Blocking registration keeps every capture deterministic.
//
// Scoped to the visual specs on purpose: the smoke suite should keep
// exercising a page that registers a worker, since that is what real visitors
// get.
test.use({ serviceWorkers: 'block' });


/**
 * Per-page screenshot baselines.
 *
 * These exist for Phase 3, which rebuilds every page shell and moves ~83 KB of
 * inline CSS into a shared stylesheet. Diffing against a baseline captured
 * beforehand is the difference between "the gallery still looks right" as an
 * assertion and as a hope.
 *
 * Three sources of false positives are handled here rather than by lowering the
 * threshold until nothing fails:
 *   - the glitch and static animations (reducedMotion + animations: disabled),
 *   - web fonts landing mid-capture (document.fonts.ready),
 *   - remote Cloudinary media (masked).
 */
for (const page of PAGES) {
  test(`${page.name} matches its baseline`, async ({ page: browserPage }) => {
    // Fixed content, so the cards render from known data and the diff is about
    // layout rather than whatever was posted this week.
    await stubContent(browserPage);
    await browserPage.goto(page.path);
    await browserPage.locator(page.ready).first().waitFor({ timeout: 15_000 });

    // Typekit faces arrive after first paint; capturing before they land makes
    // every subsequent run a false failure.
    await browserPage.evaluate(() => document.fonts.ready);

    await expect(browserPage).toHaveScreenshot(`${page.name}.png`, {
      fullPage: true,
      // See screenshot.css — flattens the hero photograph so the diffs are
      // about layout rather than a background that is not going to change.
      stylePath: 'tests/browser/screenshot.css',
    });
  });
}
