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

/**
 * The hero photograph must render the same way on every page.
 *
 * This is the kind of property a screenshot is bad at. The baselines could not
 * see it at all — `screenshot.css` replaces the remote hero to keep the images
 * off Cloudinary, and with nothing behind it `background-size: cover` has
 * nothing to scale and `backdrop-filter` has nothing to blur. A regression
 * where the feed enlarged the hero 6.8x while the home page shrank it to 0.83x,
 * and where two pages were missing the frosting the rest had, passed all 30
 * comparisons in silence.
 *
 * Comparing pages to each other, rather than to a picture, states the invariant
 * directly and does not need a baseline at all.
 */
test.describe('hero background', () => {
  const PAGES_WITH_FROSTING = ['/feed', '/community', '/gallery', '/shows', '/studio', '/app', '/post'];

  async function heroOf(page, path) {
    await page.goto(path);
    await page.waitForLoadState('domcontentloaded');
    return page.evaluate(() => {
      const wrapper = document.querySelector('.wrapper');
      const backdrop = getComputedStyle(wrapper, '::before');
      return {
        // Fixed to the viewport, so the image never scales with page length.
        position: backdrop.position,
        size: backdrop.backgroundSize,
        // The crop, not just the scale. Centring the overflow pushed the band
        // out of frame on the home page while every cross-page assertion here
        // still passed, because none of them looked at where the image sat.
        crop: backdrop.backgroundPosition,
        image: backdrop.backgroundImage.replace(/w_\d+/g, 'w_N'),
        blur: getComputedStyle(document.querySelector('main')).backdropFilter,
        pageHeight: Math.round(wrapper.getBoundingClientRect().height),
      };
    });
  }

  test('is sized by the viewport, not by page length', async ({ page }) => {
    const feed = await heroOf(page, '/feed');
    const home = await heroOf(page, '/');

    // The feed is many times taller than the home page. If the backdrop were
    // sized by the element rather than the viewport, `cover` would scale the
    // image by that ratio.
    expect(feed.pageHeight).toBeGreaterThan(home.pageHeight * 1.5);
    expect(feed.position, 'the hero backdrop must be viewport-fixed').toBe('fixed');
    expect(home.position).toBe('fixed');
    expect(feed.size).toBe(home.size);
    expect(feed.image).toBe(home.image);
  });

  test('is identical on every page', async ({ page }) => {
    const reference = await heroOf(page, '/feed');

    for (const path of ['/', '/community', '/gallery', '/shows', '/studio', '/app', '/post']) {
      const hero = await heroOf(page, path);
      expect(hero.image, `hero image on ${path}`).toBe(reference.image);
      expect(hero.size, `background-size on ${path}`).toBe(reference.size);
      expect(hero.position, `backdrop position on ${path}`).toBe(reference.position);
      expect(hero.crop, `background-position on ${path}`).toBe(reference.crop);
    }
  });

  /**
   * Measures the frosting rather than the declaration.
   *
   * Asserting `backdrop-filter` is set catches a missing rule, but not a rule
   * that is present and does nothing — an ancestor breaking the backdrop root,
   * or a `main` that no longer spans the area behind the content, would both
   * leave the property in place and the page unfrosted.
   *
   * Blurring flattens local contrast, so the average difference between
   * neighbouring pixels reads directly on whether it happened. Sampled from the
   * outer 60px of a 1400px viewport, which is outside every content container,
   * so it sees only backdrop.
   */
  test('actually blurs the photograph, not just declares it', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });

    const sharpnessAt = async path => {
      await page.goto(path);
      await page.waitForLoadState('networkidle').catch(() => {});
      const shot = await page.screenshot({ clip: { x: 4, y: 320, width: 60, height: 300 } });
      return page.evaluate(async base64 => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + base64;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let total = 0, count = 0;
        for (let y = 1; y < canvas.height - 1; y++) {
          for (let x = 1; x < canvas.width - 1; x++) {
            const a = (y * canvas.width + x) * 4;
            const b = (y * canvas.width + x + 1) * 4;
            total += Math.abs(px[a] - px[b]) + Math.abs(px[a + 1] - px[b + 1]) + Math.abs(px[a + 2] - px[b + 2]);
            count++;
          }
        }
        return total / count;
      }, shot.toString('base64'));
    };

    // The home page shows the photograph unfrosted, so it is the control: a
    // frosted page must come out markedly flatter than it.
    const unfrosted = await sharpnessAt('/');
    expect(unfrosted, 'the home page should show a sharp photograph').toBeGreaterThan(2);

    for (const path of PAGES_WITH_FROSTING) {
      const frosted = await sharpnessAt(path);
      expect(frosted, `${path} should be visibly frosted, not merely declared so`)
        .toBeLessThan(unfrosted / 4);
    }
  });

  // Every page frosts the photograph behind its content except the home page,
  // where the photograph is the point. This was declared in five of seven page
  // stylesheets and simply missing from two.
  test('is frosted behind the content on every page but home', async ({ page }) => {
    for (const path of PAGES_WITH_FROSTING) {
      const hero = await heroOf(page, path);
      expect(hero.blur, `backdrop-filter on ${path}`).toMatch(/blur/);
    }

    const home = await heroOf(page, '/');
    expect(home.blur, 'the home page deliberately shows the photograph unfrosted').toBe('none');
  });
});
