const CACHE = 'sa-shell-v2';

// ─── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', () => {
  self.skipWaiting();
});

// ─── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ─── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept API calls — let the app handle offline queuing itself
  if (url.pathname.startsWith('/api/')) return;

  // Only handle GET requests for caching
  if (e.request.method !== 'GET') return;

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
