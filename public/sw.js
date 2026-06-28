/*
 * Ovid service worker — deliberately conservative.
 *
 * - Never touches /api/* (auth, book data, credits) or cross-origin requests
 *   (R2 cover assets, Google Fonts) — those manage their own freshness.
 * - Navigations: network-first, falling back to the cached app shell offline,
 *   so a deploy is always picked up online.
 * - Hashed build assets (/static/*): cache-first — filenames change per build,
 *   so cached entries can never go stale.
 */
const VERSION = 'v1';
const CACHE = `ovid-${VERSION}`;
const SHELL = '/index.html';

self.addEventListener('install', (event) => {
  // Note: we do NOT skipWaiting() here. A new SW stays in "waiting" until the
  // app asks it to activate (see the SKIP_WAITING message) — that powers the
  // "new version available, tap to refresh" prompt.
  event.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL).catch(() => {})));
});

// The page posts this when the user accepts an update.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // skip cross-origin
  if (url.pathname.startsWith('/api/')) return; // never cache API / auth

  // Navigations: network-first, refresh the shell cache, offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(SHELL, copy));
          return res;
        })
        .catch(() => caches.match(SHELL))
    );
    return;
  }

  // Content-hashed build assets: cache-first.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          })
      )
    );
    return;
  }

  // Everything else: straight to network.
});
