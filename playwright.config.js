import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against a real deployment, not a local dev server.
 *
 * BASE_URL points at the pull request's Netlify Deploy Preview in CI. That
 * matters here specifically: the clean-URL rewrites, the RSS routes, the cache
 * headers and the functions all live in netlify.toml, and none of them exist
 * in front of `parcel serve`. A suite that passed against localhost would have
 * no opinion about the parts most likely to break.
 *
 * Locally, `npm start` in another terminal plus BASE_URL=http://localhost:1234
 * covers the static pages; anything touching /api needs `netlify dev`.
 */
const baseURL = process.env.BASE_URL || 'http://localhost:1234';

export default defineConfig({
  testDir: 'tests/browser',
  // Visual specs run everywhere now that baselines are committed. They were
  // excluded while none existed, because an absent snapshot fails the build
  // with a file it has just written.
  //
  // VISUAL=1 remains as a way to run *only* them (npm run test:visual).
  // Screenshot comparisons live next to the specs so they're reviewable in a diff.
  // {projectName} is load-bearing: without it the desktop and mobile projects
  // write to the same file and the second silently overwrites the first.
  //
  // {platform} likewise: text rasterisation differs between macOS and the
  // Linux runners, enough that a baseline captured on one fails on the other
  // for reasons that have nothing to do with the change under review. Each
  // platform keeps its own set; CI's is the one that gates a merge.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{projectName}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // The site animates its title and background indefinitely. Without this
    // every screenshot captures a different frame and every diff is noise.
    reducedMotion: 'reduce',
  },

  expect: {
    toHaveScreenshot: {
      // Font rendering and image decoding differ enough between machines that a
      // zero threshold fails on cosmetically identical pages.
      maxDiffPixelRatio: 0.02,
      animations: 'disabled',
    },
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
    { name: 'mobile',  use: { ...devices['Pixel 7'] } },
  ],
});
