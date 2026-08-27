/**
 * The site's public pages, and what proves each one actually rendered.
 *
 * `ready` is a locator that only resolves once the page's real content is
 * there — a title alone would pass on a page whose JavaScript threw.
 */
export const PAGES = [
  { path: '/',          name: 'home',      ready: '.iframe-container iframe' },
  { path: '/feed',      name: 'feed',      ready: '#posts-feed' },
  { path: '/community', name: 'community', ready: '#threads-list, #empty-state:not([hidden])' },
  { path: '/gallery',   name: 'gallery',   ready: '#gallery-grid, #empty-state:not([hidden])' },
  { path: '/shows',     name: 'shows',     ready: '#past-shows .show' },
  { path: '/studio',    name: 'studio',    ready: '#keyboard .key' },
  { path: '/app',       name: 'composer',  ready: '#auth-gate, #composer-panel' },
];
