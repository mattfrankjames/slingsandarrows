const CACHE = 'sa-shell-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (new URL(e.request.url).pathname.startsWith('/api/')) return;

  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(hit => {
        const fresh = fetch(e.request).then(res => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        });
        return hit || fresh;
      })
    )
  );
});
