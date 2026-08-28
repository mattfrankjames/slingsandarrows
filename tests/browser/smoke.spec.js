import { test, expect } from '@playwright/test';
import { PAGES } from './pages.js';

/**
 * Every page loads, renders its real content, and does so without console
 * errors. This is the suite that protects the Phase 3 templating work: it runs
 * before the refactor to establish a baseline and after it to prove nothing
 * moved that shouldn't have.
 */
for (const page of PAGES) {
  test.describe(page.name, () => {
    test('renders its content', async ({ page: browserPage }) => {
      const response = await browserPage.goto(page.path);
      expect(response?.status(), `${page.path} should not error`).toBeLessThan(400);

      await expect(browserPage.locator(page.ready).first()).toBeVisible({ timeout: 15_000 });
      await expect(browserPage).toHaveTitle(/Slings/i);
    });

    test('has no console errors', async ({ page: browserPage }) => {
      const errors = [];
      browserPage.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
      browserPage.on('pageerror', err => errors.push(String(err)));

      await browserPage.goto(page.path);
      await browserPage.locator(page.ready).first().waitFor({ timeout: 15_000 });

      // The Identity widget is a third-party script we do not control; its
      // noise would make this permanently red.
      const ours = errors.filter(e => !/netlify-identity|identity\.netlify/i.test(e));
      expect(ours, `console errors on ${page.path}`).toEqual([]);
    });

    test('has exactly one h1 and a main landmark', async ({ page: browserPage }) => {
      await browserPage.goto(page.path);
      await browserPage.locator(page.ready).first().waitFor({ timeout: 15_000 });

      await expect(browserPage.locator('main')).toHaveCount(1);
      expect(await browserPage.locator('h1').count()).toBeGreaterThan(0);
    });
  });
}

test.describe('routing', () => {
  // These rewrites live in netlify.toml and only exist on a real deployment —
  // the reason this suite runs against a Deploy Preview rather than localhost.
  test('clean URLs resolve without .html', async ({ page }) => {
    for (const path of ['/feed', '/community', '/gallery', '/shows', '/studio']) {
      const response = await page.goto(path);
      expect(response?.status(), `${path}`).toBe(200);
    }
  });

  // Asserted by what the visitor ends up looking at, not by the mechanism.
  // These two behave differently today — /posts emits a 301 while /board is
  // resolved to the community page in place, with a 200 at the /board URL —
  // and the contract that matters is that both land on the right page.
  test('retired routes reach their replacement', async ({ page }) => {
    await page.goto('/board');
    await expect(page.locator('#threads-list')).toBeAttached({ timeout: 15_000 });
    await expect(page).toHaveTitle(/Community/i);

    await page.goto('/posts');
    await expect(page.locator('#posts-feed')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveTitle(/Feed/i);
  });

  test('RSS feeds are served as XML', async ({ request }) => {
    for (const path of ['/feed.xml', '/community.xml']) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()['content-type'], path).toContain('xml');
      expect(await response.text()).toContain('<rss');
    }
  });
});

/**
 * The service worker backs offline support, the offline post queue's background
 * sync, and the Cloudinary image cache. All of it fails silently when
 * registration fails, so nothing else in this suite would notice.
 *
 * That is not hypothetical. Moving sw.js into a subdirectory made the build
 * emit it at /core/sw.js, where a worker cannot claim scope '/' — lint, types
 * and 101 unit tests all passed, and only reading the built importmap caught
 * it.
 *
 * The split between registering and not registering is inherited, not
 * intentional: registration lives in five feature modules, and the three pages
 * that load none of them get no worker. Consolidating the page shells is the
 * point at which that becomes one decision instead of five.
 */
test.describe('service worker', () => {
  const REGISTERS = ['/feed', '/community', '/gallery', '/app'];

  for (const path of REGISTERS) {
    test(`${path} registers a worker scoped to the site root`, async ({ page }) => {
      await page.goto(path);

      const registration = await page.evaluate(() =>
        Promise.race([
          navigator.serviceWorker.ready.then(r => ({
            scope: r.scope,
            script: r.active?.scriptURL ?? r.installing?.scriptURL ?? null,
          })),
          new Promise(resolve => setTimeout(() => resolve(null), 10_000)),
        ])
      );

      expect(registration, `no worker registered on ${path}`).not.toBeNull();

      // Scope must be the origin root. A worker served from anywhere below it
      // controls only that subtree, which is the failure this guards against.
      const origin = new URL(page.url()).origin;
      expect(registration.scope).toBe(`${origin}/`);
      expect(registration.script).toBe(`${origin}/sw.js`);
    });
  }
});
