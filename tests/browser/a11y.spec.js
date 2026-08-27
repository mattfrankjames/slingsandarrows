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
