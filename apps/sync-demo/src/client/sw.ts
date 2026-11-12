/// <reference lib="webworker" />
/**
 * The app shell, cached so that a device opened with no network still starts: the data comes from
 * OPFS, which needs no network at all.
 *
 * 🔴 Network-first, not cache-first. The original demo was cache-first, and after a rebuild it served
 * a stale worker for one load. The cache here is only what is served when the network is gone.
 * Replication traffic (`/net/…`) and the control API are never cached.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = 'typedblite-demo-shell';
const SHELL = ['/', '/main.js', '/worker.js', '/sqlite3.wasm', '/manifest.webmanifest', '/icon.svg'];

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== sw.location.origin) return;
  if (url.pathname.startsWith('/net/') || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(event.request.mode === 'navigate' ? '/' : event.request, response.clone());
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request.mode === 'navigate' ? '/' : event.request, { ignoreSearch: true });
        return cached ?? new Response('offline, and not cached', { status: 503 });
      }),
  );
});
