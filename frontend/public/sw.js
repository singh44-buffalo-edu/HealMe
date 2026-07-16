/*
 * HealMeDaily service worker — offline SHELL only. Registered by
 * src/main.tsx in production builds; dev never registers it.
 *
 * Caches build assets cache-first (content-hashed filenames make them
 * effectively immutable). It NEVER caches FHIR or AI-service responses —
 * and why: health data belongs in the Medplum CDR behind auth, not in a
 * browser cache. A cached copy would outlive sign-out, bypass server-side
 * access control (AccessPolicies, audit), go stale silently, and leak the
 * record to anyone who opens the browser. The privacy promise is that the
 * app shell may work offline; the data may not. Structurally those calls
 * are cross-origin (:8103 / :8000), so the fetch handler below ignores
 * them entirely — keep it that way.
 */
const CACHE = 'hmd-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

// Install: pre-cache the minimal shell and take over without waiting.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

// Activate: drop caches from older shell versions (bump CACHE to invalidate).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Fetch: same-origin GETs only. Everything else — FHIR (:8103), ai-service
// (:8000), any write — falls through to the network untouched.
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
  // Shell/assets: cache-first; a miss is fetched once, then stored for offline.
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
