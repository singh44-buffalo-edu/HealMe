/*
 * HealMeDaily service worker — offline shell only.
 * Caches build assets (cache-first). Never caches FHIR or AI-service responses:
 * health data stays in the record, not in browser caches.
 */
const CACHE = 'hmd-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return; // never intercept FHIR/AI-service calls or writes
  }
  const isAsset = url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname);
  if (!isAsset) {
    // SPA navigation: network first, fall back to cached shell when offline
    if (event.request.mode === 'navigate') {
      event.respondWith(fetch(event.request).catch(() => caches.match('/')));
    }
    return;
  }
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ||
        fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
          return res;
        })
    )
  );
});
