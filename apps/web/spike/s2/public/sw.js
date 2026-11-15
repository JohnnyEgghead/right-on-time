// SPDX-License-Identifier: AGPL-3.0-or-later
// Spike S2 (G-S2-TWA-OFFLINE): THROWAWAY hand-written service worker (SPECIFICATIONS SD-47).
// Precaches the shell; serves it cache-first so the app opens with no signal. API calls are not
// intercepted: queued items live in IndexedDB (app.js), never in the service worker.
const CACHE = 'bw-s2-shell-v1';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      // Refresh the copy in the background when online; a failure (no signal) is ignored.
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      if (hit) {
        event.waitUntil(refresh);
        return hit;
      }
      const res = await refresh;
      return res || new Response('offline and not cached', { status: 503 });
    }),
  );
});
