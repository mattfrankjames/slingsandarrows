/**
 * Service Worker — Slings & Arrows
 *
 * Strategy:
 *  • On install  → pre-cache the app shell (HTML pages + CSS + icons)
 *  • On activate → purge old caches
 *  • On fetch    → API calls bypass the cache entirely (network-only)
 *                  Navigation requests use network-first with offline fallback
 *                  Static assets use stale-while-revalidate
 */

const SHELL_CACHE   = 'sa-shell-v2';
const RUNTIME_CACHE = 'sa-runtime-v2';

// App shell — pre-cached at install time so the app works offline immediately
const SHELL_ASSETS = [
  '/',
  '/app',
  '/posts',
  '/offline',
  // CSS is fingerprinted by Parcel; we cache it at runtime on first visit.
  // Icons are small and stable — pre-cache them.
  '/images/icon-192.png',
  '/images/icon-512.png',
  '/images/icon-maskable-512.png',
];

/* ─── Install ─────────────────────────────────────────────────────────────── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(cache => {
      // addAll fails atomically — if any resource 404s we skip it gracefully
      return Promise.allSettled(
        SHELL_ASSETS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] pre-cache miss: ${url}`, err.message)
          )
        )
      );
    }).then(() => self.skipWaiting())
  );
});

/* ─── Activate ────────────────────────────────────────────────────────────── */
self.addEventListener('activate', e => {
  const keep = [SHELL_CACHE, RUNTIME_CACHE];
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !keep.includes(k)).map(k => {
          console.log('[SW] deleting old cache:', k);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
  );
});

/* ─── Fetch ───────────────────────────────────────────────────────────────── */
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // 1. Skip non-GET and cross-origin requests (except typekit / cloudinary)
  if (request.method !== 'GET') return;

  // 2. API calls — network only, never cache
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) return;

  // 3. Netlify Identity widget — network only
  if (url.hostname === 'identity.netlify.com') return;

  // 4. Navigation requests — network-first, fall back to offline page
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then(res => {
          // Cache a fresh copy of navigated pages in the runtime cache
          if (res.ok) {
            const clone = res.clone();
            caches.open(RUNTIME_CACHE).then(c => c.put(request, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(request)
            .then(cached => cached || caches.match('/offline'))
        )
    );
    return;
  }

  // 5. Typekit / Adobe fonts — stale-while-revalidate
  if (url.hostname.includes('typekit.net') || url.hostname.includes('use.typekit.net')) {
    e.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
    return;
  }

  // 6. Cloudinary images — cache-first (images are immutable by URL)
  if (url.hostname.includes('cloudinary.com')) {
    e.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  // 7. Everything else (local CSS, JS, images) — stale-while-revalidate
  e.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
});

/* ─── Cache strategies ────────────────────────────────────────────────────── */

/** Returns the cached response immediately, revalidates in the background. */
async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkFetch = fetch(request).then(res => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);

  return cached || await networkFetch;
}

/** Returns the cached response; only goes to network on a miss. */
async function cacheFirst(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

/* ─── Push notifications (future-ready stub) ─────────────────────────────── */
self.addEventListener('push', e => {
  if (!e.data) return;
  let data;
  try { data = e.data.json(); } catch { data = { title: 'Slings & Arrows', body: e.data.text() }; }

  e.waitUntil(
    self.registration.showNotification(data.title || 'Slings & Arrows', {
      body:  data.body  || '',
      icon:  '/images/icon-192.png',
      badge: '/images/icon-192.png',
      data:  { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const target = e.notification.data?.url || '/';
      const existing = list.find(c => c.url === target && 'focus' in c);
      return existing ? existing.focus() : clients.openWindow(target);
    })
  );
});
