import { test, expect } from '@playwright/test';
import { stubContent, signIn } from './fixtures.js';

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
 * Baselines for the surfaces that only exist when someone is signed in.
 *
 * These matter more than the public pages. The composer and the studio are
 * where features are planned, so they are the screens most likely to be edited
 * — and, signed out, none of them render at all: /app shows an auth gate, and
 * the feed and gallery hide their buttons. Without a seeded session the
 * committed baseline for /app was a sign-in prompt, which protects nothing.
 *
 * The session is a fixture, not a real credential. It gets the client to render
 * the signed-in state; every write it might attempt is stubbed, and the server
 * would reject the token anyway.
 */

const shot = { fullPage: true, stylePath: 'tests/browser/screenshot.css' };

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await stubContent(page);
});

test('the standalone composer at /app', async ({ page }) => {
  await page.goto('/app');

  // The gate must actually be gone, or this captures the signed-out state
  // again without saying so.
  await expect(page.locator('#composer-panel')).toBeVisible();
  await expect(page.locator('#auth-gate')).toBeHidden();
  await page.evaluate(() => document.fonts.ready);

  await expect(page).toHaveScreenshot('composer-signed-in.png', shot);
});

test('the composer dialog on the feed', async ({ page }) => {
  await page.goto('/feed');

  const open = page.locator('#new-post-btn');
  await expect(open).toBeVisible();
  await open.click();

  const dialog = page.locator('#post-composer-dialog');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  await expect(page).toHaveScreenshot('composer-dialog.png', shot);
});

test('the link-insert panel inside the composer', async ({ page }) => {
  await page.goto('/app');
  await expect(page.locator('#composer-panel')).toBeVisible();

  await page.locator('#insert-link-btn').click();
  await expect(page.locator('#link-insert-panel')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  await expect(page).toHaveScreenshot('composer-link-panel.png', shot);
});

test('the gallery upload modal', async ({ page }) => {
  await page.goto('/gallery');

  const open = page.locator('#upload-btn');
  await expect(open).toBeVisible();
  await open.click();

  await expect(page.locator('#upload-modal')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  await expect(page).toHaveScreenshot('gallery-upload-modal.png', shot);
});

test('the new-thread modal on the community board', async ({ page }) => {
  await page.goto('/community');

  await page.locator('#new-thread-btn').click();
  await expect(page.locator('#new-thread-modal')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  await expect(page).toHaveScreenshot('board-new-thread-modal.png', shot);
});

/**
 * The two lightboxes.
 *
 * Both are hand-rolled `<div role="dialog" aria-modal="true">` overlays — the
 * gallery's own, with previous/next and a counter, and the shared one in
 * lightbox.js used by feed posts and board media. Phase 3 replaces both with
 * native <dialog> (finding F-12: no focus trap, no inert background, no focus
 * restoration). Their layout should survive that swap, which is exactly what a
 * baseline is for.
 *
 * These need no session, but they do need the fixtures, so they live here
 * alongside the other interaction-state captures.
 */
test.describe('lightboxes', () => {
  test('the gallery lightbox, opened on the first item', async ({ page }) => {
    await page.goto('/gallery');

    await page.locator('.gallery-item').first().click();
    await expect(page.locator('#lightbox')).toHaveClass(/active/);
    // The counter proves the gallery's own viewer opened, not the shared one.
    await expect(page.locator('#lightbox-counter')).not.toBeEmpty();
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot('gallery-lightbox.png', shot);
  });

  test('the gallery lightbox after paging to the next item', async ({ page }) => {
    await page.goto('/gallery');
    await page.locator('.gallery-item').first().click();
    await expect(page.locator('#lightbox')).toHaveClass(/active/);

    await page.locator('#lightbox-next').click();
    await expect(page.locator('#lightbox-counter')).toContainText('2');
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot('gallery-lightbox-next.png', shot);
  });

  test('the shared lightbox, opened from a feed post image', async ({ page }) => {
    await page.goto('/feed');

    await page.locator('img.post-image').first().click();
    await expect(page.locator('.sa-lightbox')).toHaveClass(/active/);
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot('feed-lightbox.png', shot);
  });
});
