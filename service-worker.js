// service-worker.js
// Bump CACHE_VERSION on every deploy where you want to force a fast refresh
// for users who already have the app open/installed as a PWA.
const CACHE_VERSION = 'v8';
const CACHE_NAME = `woodpayvtu-${CACHE_VERSION}`;
const APP_SHELL = ['/', '/index.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  // Don't wait for old tabs to close — install immediately.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// Lets the page force this worker to take over immediately once installed,
// instead of waiting for all tabs to close.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isHTML = request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // Network-first for pages: a new deploy is visible on next load instead
    // of being masked by a stale cached shell. Falls back to cache offline.
    event.respondWith(
      fetch(request, { cache: 'no-store' })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  // Cache-first for everything else (fonts, icons, other static assets),
  // falling back to network and populating the cache as things are fetched.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((res) => {
          if (res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return res;
        })
    )
  );
});

// ── Push Notifications ──────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { title: 'WoodPay', body: 'You have a new notification.' };
  try { data = event.data.json(); } catch(e) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'WoodPay', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'woodpay-notification',
      requireInteraction: false,
      vibrate: [200, 100, 200],
      data: { 
        url: data.url || '/',
        sound: data.sound || true
      }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
