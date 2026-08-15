const CACHE       = 'sa-shell-v3';   // app-shell assets (HTML, CSS, JS)
const IMAGE_CACHE = 'sa-images-v1';  // long-lived cache-first store for Cloudinary assets
const API_CACHE   = 'sa-api-v1';     // short-lived network-first cache for API responses

// Maximum number of Cloudinary images to keep in the image cache.
// Older entries are evicted once this limit is exceeded.
const IMAGE_CACHE_LIMIT = 100;

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', () => {
  self.skipWaiting();
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  const KNOWN_CACHES = [CACHE, IMAGE_CACHE, API_CACHE];
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !KNOWN_CACHES.includes(k))
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Only cache GET requests
  if (e.request.method !== 'GET') return;

  // ── Cloudinary images/videos: cache-first (URLs are content-addressed) ────
  if (url.hostname.includes('cloudinary.com')) {
    e.respondWith(
      caches.open(IMAGE_CACHE).then(cache =>
        cache.match(e.request).then(hit => {
          if (hit) return hit;

          return fetch(e.request).then(res => {
            if (res.ok) {
              // Store the response, then asynchronously trim the cache to
              // IMAGE_CACHE_LIMIT entries so we don't grow without bound.
              cache.put(e.request, res.clone()).then(() => trimImageCache(cache));
            }
            return res;
          }).catch(() =>
            // Network failed and nothing cached — return a minimal 503 so the
            // browser doesn't show a broken-image icon forever.
            new Response('', { status: 503, statusText: 'Image unavailable offline' })
          );
        })
      )
    );
    return;
  }

  // ── API calls: stale-while-revalidate ──────────────────────────────────────
  // Serve the cached response immediately if we have one (so repeat visits to
  // the feed/board/gallery paint instantly instead of waiting on a network
  // round-trip), then revalidate in the background. If the fresh response
  // differs from what was cached, tell open pages so they can silently
  // re-render without the user having to reload.
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      caches.open(API_CACHE).then(async cache => {
        const cached = await cache.match(e.request);

        if (cached) {
          // Clone before handing off: `cached` is about to be consumed to
          // deliver the response to the page, and a Response body can only
          // be read once. Without cloning here, revalidateApiCache's later
          // clone() (after its own network round-trip) throws on an
          // already-read body — silently, since it's inside a catch-all —
          // so the cache would never actually update.
          e.waitUntil(revalidateApiCache(e.request, cache, cached.clone()));
          return cached;
        }

        // Nothing cached yet — this request has to wait on the network, but
        // populate the cache so the next visit can paint instantly.
        return fetch(e.request)
          .then(res => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          })
          .catch(() => new Response('[]', {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }));
      })
    );
    return;
  }

  // ── Static shell assets: stale-while-revalidate ───────────────────────────
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(hit => {
        const fresh = fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        }).catch(() => hit); // return stale on network failure
        return hit || fresh;
      })
    )
  );
});

// ─── Background Sync ──────────────────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'sync-posts') {
    e.waitUntil(syncPendingPosts());
  }
});

async function syncPendingPosts() {
  let db;
  try {
    db = await openDB();
  } catch (err) {
    console.error('[SW] Could not open IndexedDB:', err);
    return;
  }

  const pending = await getAllPending(db);
  if (!pending.length) return;

  for (const post of pending) {
    try {
      const response = await fetch('/api/create-post', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Token is stored alongside the post data for offline use
          ...(post.token ? { Authorization: `Bearer ${post.token}` } : {}),
        },
        body: JSON.stringify(post.data),
      });

      if (response.ok) {
        await deletePending(db, post.id);
        notifyClients({ type: 'POST_SYNCED', postId: post.id, post: await response.json() });
      } else {
        // 4xx errors won't succeed on retry — remove them and report
        if (response.status >= 400 && response.status < 500) {
          await deletePending(db, post.id);
          notifyClients({ type: 'POST_SYNC_FAILED', postId: post.id, status: response.status });
        }
        // 5xx: leave in queue, sync will retry
      }
    } catch (err) {
      // Network error — leave in queue for next sync attempt
      console.error('[SW] Sync failed for post:', post.id, err);
    }
  }
}

function notifyClients(msg) {
  self.clients.matchAll({ includeUncontrolled: true }).then(clients =>
    clients.forEach(c => c.postMessage(msg))
  );
}

// ─── API cache revalidation ───────────────────────────────────────────────────
/**
 * Background half of the stale-while-revalidate strategy for /api/* GETs.
 * Fetches a fresh copy, updates the cache, and — only if the response body
 * actually changed — notifies open pages via postMessage so they can
 * silently re-render instead of showing stale data until the next reload.
 */
async function revalidateApiCache(request, cache, cachedResponse) {
  try {
    const res = await fetch(request);
    if (!res.ok) return;

    const [freshText, cachedText] = await Promise.all([
      res.clone().text(),
      cachedResponse.clone().text(),
    ]);

    await cache.put(request, res.clone());

    if (freshText !== cachedText) {
      notifyClients({ type: 'API_UPDATED', url: request.url });
    }
  } catch (err) {
    // Usually just offline/network error — the cached copy was already
    // served to the page, nothing more to do until the next request. Logged
    // (not swallowed silently) since a bug here means the cache never
    // updates again for this URL, with no other visible symptom.
    console.warn('[SW] revalidateApiCache error for', request.url, err);
  }
}

// ─── Image cache eviction ─────────────────────────────────────────────────────
/**
 * Keep the image cache under IMAGE_CACHE_LIMIT entries by deleting the oldest
 * requests (Cache Storage preserves insertion order via keys()).
 */
async function trimImageCache(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length <= IMAGE_CACHE_LIMIT) return;
    const toDelete = keys.slice(0, keys.length - IMAGE_CACHE_LIMIT);
    await Promise.all(toDelete.map(req => cache.delete(req)));
  } catch (err) {
    console.warn('[SW] trimImageCache error:', err);
  }
}

// ─── Cache invalidation message handler ──────────────────────────────────────
/**
 * Clients can send { type: 'INVALIDATE_IMAGE', url: '...' } to remove a
 * specific Cloudinary URL from the image cache (e.g. after deleting a post).
 */
self.addEventListener('message', async e => {
  if (!e.data) return;

  if (e.data.type === 'INVALIDATE_IMAGE' && e.data.url) {
    try {
      const cache = await caches.open(IMAGE_CACHE);
      await cache.delete(e.data.url);
    } catch (err) {
      console.warn('[SW] INVALIDATE_IMAGE error:', err);
    }
  }

  if (e.data.type === 'GET_CACHE_STATS') {
    try {
      const [shellKeys, imageKeys] = await Promise.all([
        caches.open(CACHE).then(c => c.keys()),
        caches.open(IMAGE_CACHE).then(c => c.keys()),
      ]);
      e.source?.postMessage({
        type: 'CACHE_STATS',
        shell: shellKeys.length,
        images: imageKeys.length,
        imageLimit: IMAGE_CACHE_LIMIT,
      });
    } catch (err) {
      console.warn('[SW] GET_CACHE_STATS error:', err);
    }
  }
});

// ─── IndexedDB helpers (service worker context) ───────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('SlingsArrows', 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pending-posts')) {
        db.createObjectStore('pending-posts', { keyPath: 'id' });
      }
    };
  });
}

function getAllPending(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending-posts'], 'readonly');
    const req = tx.objectStore('pending-posts').getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result || []);
  });
}

function deletePending(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending-posts'], 'readwrite');
    const req = tx.objectStore('pending-posts').delete(id);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}
