import { test, expect } from '@playwright/test';
import { stubContent, signIn } from './fixtures.js';

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
