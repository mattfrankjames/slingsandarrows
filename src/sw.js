// ─── Service Worker — Slings & Arrows ────────────────────────────────────────
// Strategy:
//   • App shell (HTML pages, CSS, icons, manifest) → Cache-first, update in bg
//   • API calls (/api/*) → Network-only (never cache)
//   • Images from Cloudinary → Stale-while-revalidate with a dedicated cache
//   • Navigation requests that fail offline → serve /app.html or /posts.html
//     from cache so the app still opens when there's no network.
//
// Bump SHELL_VERSION whenever you deploy a meaningful change to force clients
// to pick up the new shell on next visit.
// ─────────────────────────────────────────────────────────────────────────────

const SHELL_VERSION  = 'sa-shell-v3';
const IMAGE_VERSION  = 'sa-images-v1';

// Pages / assets to precache on install.
// These are the minimal set needed for the app to work offline.
const PRECACHE_URLS = [
  '/app',
  '/posts',
  '/app.html',
  '/posts.html',
  '/sw.js',
];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_VERSION).then(cache => {
      // addAll will fail silently per-URL if a resource 404s during dev;
      // we wrap individual adds so one bad URL doesn't block the whole install.
      return Promise.allSettled(
        PRECACHE_URLS.map(url =>
          cache.add(url).catch(err =>
            console.warn('[SW] precache miss:', url, err.message)
          )
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  const keep = [SHELL_VERSION, IMAGE_VERSION];
  e.waitUntil(
    caches.keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => !keep.includes(k))
            .map(k => {
              console.log('[SW] deleting old cache:', k);
              return caches.delete(k);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // 1. Never intercept API calls — always go to the network.
  if (url.pathname.startsWith('/api/')) return;

  // 2. Netlify Identity widget / external scripts — network-only.
  if (url.hostname === 'identity.netlify.com') return;

  // 3. Cloudinary images — stale-while-revalidate.
  if (url.hostname === 'res.cloudinary.com') {
    e.respondWith(staleWhileRevalidate(request, IMAGE_VERSION));
    return;
  }

  // 4. Navigation requests (HTML pages) — network-first with offline fallback.
  if (request.mode === 'navigate') {
    e.respondWith(networkFirstWithOfflineFallback(request));
    return;
  }

  // 5. Everything else (CSS, JS, fonts, SVG icons) — cache-first, update in bg.
  e.respondWith(cacheFirstWithBackgroundUpdate(request));
});

// ── Strategies ────────────────────────────────────────────────────────────────

/**
 * Cache-first: serve from cache immediately; fetch fresh copy in background
 * and update the cache for next time.
 */
async function cacheFirstWithBackgroundUpdate(request) {
  const cache = await caches.open(SHELL_VERSION);
  const cached = await cache.match(request);

  // Kick off a background refresh regardless.
  const freshPromise = fetch(request)
    .then(res => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  return cached || freshPromise;
}

/**
 * Stale-while-revalidate: serve cached copy instantly, update cache in bg.
 * Falls back to network when there's no cached copy.
 */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);

  return cached || fetchPromise;
}

/**
 * Network-first: try the network; if it fails (offline) serve from cache.
 * For navigation, fall back to the appropriate cached shell page so the app
 * at least renders rather than showing the browser's offline dinosaur.
 */
async function networkFirstWithOfflineFallback(request) {
  const cache = await caches.open(SHELL_VERSION);

  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    // Serve the cached version of this exact URL if we have it …
    const cached = await cache.match(request);
    if (cached) return cached;

    // … otherwise fall back to the appropriate shell page.
    const url = new URL(request.url);
    const fallback = url.pathname.startsWith('/posts')
      ? await cache.match('/posts.html') || await cache.match('/posts')
      : await cache.match('/app.html')   || await cache.match('/app');

    if (fallback) return fallback;

    // Last resort: a minimal offline response.
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">
       <title>Slings & Arrows — Offline</title>
       <meta name="viewport" content="width=device-width,initial-scale=1">
       <style>
         body{background:#000;color:#fff;font-family:sans-serif;
              display:grid;place-items:center;min-height:100svh;margin:0}
         h1{font-size:2rem;text-align:center}
         p{opacity:.6;text-align:center}
       </style></head>
       <body>
         <div>
           <h1>Slings &amp; Arrows</h1>
           <p>You're offline. Check your connection and try again.</p>
         </div>
       </body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}
