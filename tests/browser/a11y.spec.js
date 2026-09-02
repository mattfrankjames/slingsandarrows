import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PAGES } from './pages.js';

/**
 * Automated accessibility checks. axe catches roughly a third of real issues —
 * the mechanical third — which is a third nobody has to remember. Phase 3's
 * findings (no skip link, hand-rolled modals with no focus trap, unguarded
 * infinite animation) are mostly in the other two thirds and are tracked there.
 */
for (const page of PAGES) {
  test(`${page.name} has no serious axe violations`, async ({ page: browserPage }) => {
    await browserPage.goto(page.path);
    await browserPage.locator(page.ready).first().waitFor({ timeout: 15_000 });

    const { violations } = await new AxeBuilder({ page: browserPage })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      // The Bandcamp player is third-party markup inside an iframe. Its
      // violations are real but not ours to fix, and including them would keep
      // this permanently red.
      .exclude('iframe')
      .analyze();

    const serious = violations.filter(v => ['serious', 'critical'].includes(v.impact));

    // Report what failed and where, rather than just a count.
    const summary = serious.map(v =>
      `${v.impact.toUpperCase()} ${v.id}: ${v.help}\n` +
      v.nodes.slice(0, 3).map(n => `    ${n.target.join(' ')}`).join('\n')
    ).join('\n\n');

    expect(summary, `Accessibility violations on ${page.path}`).toBe('');
  });
}

test.describe('keyboard', () => {
  test('the studio tab strip is operable with arrow keys', async ({ page }) => {
    await page.goto('/studio');
    await page.locator('#tab-synth').waitFor();

    await page.locator('#tab-synth').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#tab-drums')).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('End');
    await expect(page.locator('#tab-mixer')).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Home');
    await expect(page.locator('#tab-synth')).toHaveAttribute('aria-selected', 'true');
  });

  test('every page exposes a visible focus indicator on its first link', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');

    const outline = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    });

    expect(outline, 'Tab should move focus to a focusable element').not.toBeNull();
  });
});

/**
 * What the <dialog> conversion was for.
 *
 * The modals were `<div role="dialog" aria-modal="true">`, which promises
 * behaviour the browser then has to be told to provide. None of it was: focus
 * stayed on the page behind, Tab walked straight out of an open dialog into the
 * content underneath, and closing never returned focus to whatever opened it
 * (F-12).
 *
 * These assert the behaviour rather than the element, so they would still hold
 * if the implementation changed again — and they fail against the old
 * hand-rolled version, which is the point.
 */
const DIALOGS = [
  { name: 'gallery upload', path: '/gallery',   trigger: '#upload-btn',     dialog: '#upload-modal' },
  { name: 'new thread',     path: '/community', trigger: '#new-thread-btn', dialog: '#new-thread-modal' },
  { name: 'gallery lightbox', path: '/gallery', trigger: '.gallery-item',   dialog: '#lightbox' },
];

test.describe('modal dialogs', () => {
  // Signed in, so the buttons that open these are rendered at all.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('gotrue.user', JSON.stringify({
        access_token: 'test-token-not-valid-server-side',
        expires_at: Date.now() + 86_400_000,
        email: 'band@slingsandarrows.test',
      }));
    });
  });

  for (const { name, path, trigger, dialog } of DIALOGS) {
    test(`${name}: traps focus, closes on Escape, and restores focus`, async ({ page }) => {
      await page.goto(path);

      const opener = page.locator(trigger).first();
      await opener.waitFor();
      await opener.click();

      const modal = page.locator(dialog);
      await expect(modal).toHaveAttribute('open', '');

      // Focus must be inside the dialog, not left on the page behind it.
      expect(
        await page.evaluate(sel => document.querySelector(sel).contains(document.activeElement), dialog),
        'focus should move into the dialog'
      ).toBe(true);

      // Tabbing repeatedly must never reach anything behind the dialog.
      //
      // Focus is allowed to land on <body> — when the cycle wraps past the last
      // focusable child it goes out to the browser's own UI, and the page sees
      // that as body. What must never happen is focus landing on a real element
      // underneath, which is exactly what the div version did.
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        const where = await page.evaluate(sel => {
          const active = document.activeElement;
          if (!active || active === document.body || active === document.documentElement) return 'body';
          return document.querySelector(sel).contains(active) ? 'dialog' : `escaped: ${active.tagName}.${active.className}`;
        }, dialog);
        expect(where, `after ${i + 1} tabs`).not.toMatch(/^escaped/);
      }

      // Escape is the platform's, not a hand-written keydown listener.
      await page.keyboard.press('Escape');
      await expect(modal).not.toHaveAttribute('open', '');
    });

    /*
     * Black-on-black. The UA stylesheet puts `color: CanvasText` on the dialog
     * element itself, which beats the white inherited from body no matter how
     * dark the page is, so every dialog rendered its heading and body text in
     * black on its own near-black surface. Only the post composer escaped, by
     * happening to declare its own colour.
     *
     * The focus-trap tests above passed throughout — they assert behaviour, and
     * the behaviour was fine. So did axe, which only ever saw these dialogs
     * closed. Nothing looked at the text until someone opened one.
     */
    test(`${name}: renders legible text on its dark surface`, async ({ page }) => {
      await page.goto(path);
      const opener = page.locator(trigger).first();
      await opener.waitFor();
      await opener.click();
      await expect(page.locator(dialog)).toHaveAttribute('open', '');

      const luminance = await page.evaluate(sel => {
        const [r, g, b] = getComputedStyle(document.querySelector(sel))
          .color.match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number);
        const lin = c => {
          const v = c / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      }, dialog);

      // Every surface on this site is dark, so the text on it must be light.
      // CanvasText is 0; white is 1.
      expect(luminance, 'dialog text should be light, not the UA default').toBeGreaterThan(0.5);
    });

    test(`${name}: makes the page behind it inert`, async ({ page }) => {
      await page.goto(path);
      const opener = page.locator(trigger).first();
      await opener.waitFor();
      await opener.click();
      await expect(page.locator(dialog)).toHaveAttribute('open', '');

      // A link in the header is visible but must not be reachable or clickable
      // while a modal dialog is open — that is what showModal() provides and
      // aria-modal on a div never did.
      const navLink = page.locator('.site-nav a').first();
      await expect(navLink).toBeVisible();
      expect(
        await navLink.evaluate(el => {
          el.focus();
          return document.activeElement === el;
        }),
        'the page behind an open dialog should be inert'
      ).toBe(false);
    });
  }
});

/**
 * Motion and focus.
 *
 * The masthead ran two animations that never stopped — a ten-step grain overlay
 * on `infinite`, and the glitch treatment on the title — and nothing in the
 * codebase asked whether the visitor wanted them (F-13). Keyboard focus had no
 * visible indicator anywhere outside form fields, so you could tab a whole page
 * without knowing where you were.
 */
test.describe('motion and focus', () => {
  test('honours prefers-reduced-motion', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('h1.glitch').waitFor();

    const durations = await page.evaluate(() =>
      [...document.querySelectorAll('h1.glitch, h1.glitch span, header')]
        .map(el => getComputedStyle(el).animationDuration)
        .filter(Boolean)
    );

    // Near-zero rather than 'none', so animation events still fire for any
    // script waiting on them.
    for (const duration of durations) {
      expect(parseFloat(duration), `animation-duration ${duration}`).toBeLessThan(0.05);
    }
    await context.close();
  });

  /*
   * The loading state is built from the masthead's two animations — the grain
   * scrolling and the glitch displacing three shadow colours. Under reduced
   * motion the blanket rule in base.css near-zeroes both, which would otherwise
   * leave the grain frozen mid-scroll and the glyphs stuck at whatever
   * displacement the last frame had: legible, but it reads as a rendering fault
   * rather than a design. components.css states a still version deliberately,
   * and this checks the two rules actually compose that way.
   */
  test('the loading state is still legible with motion reduced', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('/feed');

    const style = await page.evaluate(() => {
      const el = document.getElementById('loading');
      el.hidden = false; // only shown after a real wait; force it to measure
      const cs = getComputedStyle(el);
      return {
        durations: cs.animationDuration.split(',').map(d => parseFloat(d)),
        shadowLayers: cs.textShadow.split('rgb').length - 1,
        fontSize: parseFloat(cs.fontSize),
        clipsToText: (cs.webkitBackgroundClip || cs.backgroundClip) === 'text',
      };
    });

    // Motion is gone…
    for (const d of style.durations) expect(d).toBeLessThan(0.05);

    // …but the treatment is not. Grain still fills the glyphs, and one shadow
    // remains so the letters do not read as flat body text.
    expect(style.clipsToText, 'the grain should still show through').toBe(true);
    expect(style.shadowLayers, 'a still displacement, not three moving ones').toBeGreaterThan(0);

    // And it stays large enough that the em-based treatment is visible at all.
    expect(style.fontSize).toBeGreaterThan(20);

    await context.close();
  });

  test('leaves animation alone when motion is not reduced', async ({ browser }) => {
    // The guard must be conditional, not a permanent disable.
    const context = await browser.newContext({ reducedMotion: 'no-preference' });
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('h1.glitch').waitFor();

    const durations = await page.evaluate(() =>
      [...document.querySelectorAll('h1.glitch span')].map(el => getComputedStyle(el).animationDuration)
    );
    expect(durations.some(d => parseFloat(d) > 0.05), 'the glitch should still run normally').toBe(true);
    await context.close();
  });

  // Tabbed to, not focus()'d: :focus-visible deliberately does not match
  // programmatic focus, so calling el.focus() measures :focus only and reports
  // no ring even when one is working. That cost me a wrong diagnosis.
  test('gives keyboard focus a visible ring', async ({ page }) => {
    await page.goto('/studio');
    await page.locator('#universal-bpm').waitFor();
    await page.locator('body').click({ position: { x: 5, y: 5 } });

    // The BPM slider is a custom-styled range, the control most likely to have
    // had its focus ring removed for cosmetic reasons — and it had.
    let reached = false;
    for (let i = 0; i < 40 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement?.id === 'universal-bpm');
    }
    expect(reached, 'the BPM slider should be reachable by keyboard').toBe(true);

    const ring = await page.evaluate(() => {
      const el = document.getElementById('universal-bpm');
      const cs = getComputedStyle(el);
      return { matches: el.matches(':focus-visible'), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });

    expect(ring.matches, 'keyboard focus should match :focus-visible').toBe(true);
    expect(ring.style, 'a keyboard-focused control needs a visible outline').not.toBe('none');
    expect(ring.width).toBeGreaterThan(0);
  });
});
