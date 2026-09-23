/**
 * Service worker.
 *
 * Its whole job is to make the app open instantly on a phone. It deliberately
 * does NOT try to make the app work offline in any meaningful sense: the data
 * lives in Supabase, and a budget showing yesterday's numbers with no hint
 * that they are stale is worse than a screen saying it cannot reach the
 * network.
 *
 * So: the shell is cached, everything to do with data and auth is not.
 *
 * The failure mode to respect here is a service worker pinning someone to an
 * old build forever. Guards against that:
 *   - the version below is part of the cache name, so a new deploy starts a
 *     new cache and the old one is deleted outright
 *   - skipWaiting + clients.claim, so an update takes effect on next launch
 *     rather than waiting for every tab to close
 *   - navigations are network-first, so a running app picks up a new deploy
 *     as soon as it is online, and only falls back to cache when offline
 */
const VERSION = 'v1';
const CACHE = `pfa-shell-${VERSION}`;

/** Only the entry point. Hashed assets are cached as they are requested. */
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // `cache: 'reload'` is load-bearing. Without it these requests may be
    // answered from the browser's own HTTP cache, so a freshly installed
    // worker can cache the PREVIOUS build's index.html and keep serving it —
    // exactly the stale-forever failure this version scheme exists to avoid.
    //
    // addAll fails the whole install if any one request fails; the shell is
    // small and must be complete, so that is the behaviour we want.
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/** Anything that is someone's data, or proves who they are, is never cached. */
function isData(url) {
  if (url.origin !== self.location.origin) return true;       // Supabase, Google
  return url.pathname.startsWith('/auth') || url.pathname.startsWith('/rest');
}

/** Vite's build gives these content-hashed names, so they never change under us. */
function isImmutableAsset(url) {
  return url.origin === self.location.origin
    && (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/'));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (isData(url)) return;  // straight to the network, not our business

  // A navigation gets the newest app the network can provide, and the cached
  // shell only when there is no network at all.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        // Only a real page gets remembered as the offline fallback; caching a
        // 404 or a proxy error page here would strand the app on it.
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put('/index.html', fresh.clone());
        }
        return fresh;
      } catch {
        const cached = await caches.match('/index.html');
        return cached ?? Response.error();
      }
    })());
    return;
  }

  if (isImmutableAsset(url)) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const fresh = await fetch(request);
      // Only store a real success; an error page cached under an asset URL
      // would survive until the next version bump.
      if (fresh.ok && fresh.status === 200) {
        const cache = await caches.open(CACHE);
        cache.put(request, fresh.clone());
      }
      return fresh;
    })());
  }
});

/** Lets the page tell a waiting worker to take over immediately. */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
