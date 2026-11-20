// Service Worker: يخلّي التطبيق يفتح أوفلاين. بيكاشّي ملفات التطبيق ومكتبات Firebase.
// مش بيتدخّل في طلبات Firestore/Auth (دي بيتولاها Firebase SDK بنفسه).
const CACHE = 'pos-shell-v4';
const SHELL = [
  './', './index.html', './app.js', './common.js', './store.js', './sync.js', './print.js',
  './style.css', './firebase-config.js', './manifest.webmanifest', './icon-192.png', './icon-512.png',
  './owner/', './owner/index.html', './owner/owner.js',
];
const CDN_HOSTS = ['www.gstatic.com', 'cdnjs.cloudflare.com'];

// مسار الجذر للتطبيق (يشتغل سواء على دومين رئيسي أو جوه /billing-app/)
const BASE = new URL('./', self.location).pathname;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CDN_HOSTS.includes(url.hostname)) return;

  // صفحات التنقّل: الشبكة أولاً، وبعدين الكاش (علشان التحديثات توصل)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r ||
        caches.match(url.pathname.startsWith(BASE + 'owner')
          ? new URL('./owner/index.html', self.location).href
          : new URL('./index.html', self.location).href)))
    );
    return;
  }

  // باقي الملفات: من الكاش فوراً + تحديث في الخلفية
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
