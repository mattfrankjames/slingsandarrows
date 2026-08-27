import { test, expect } from '@playwright/test';
import { PAGES } from './pages.js';
import { stubContent } from './fixtures.js';

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
