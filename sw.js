/* sw.js — Service Worker
 * 役割: オフラインキャッシュ(アプリの殻を端末に保存) + 通知の表示窓口。
 * データ(記録)はキャッシュしない。記録は localStorage に入る。
 */
const CACHE = 'hanna-v1';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './store.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ネット優先 → 失敗時キャッシュ(オフラインでも開ける)
self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  e.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then((r) => r || caches.match('./index.html')))
  );
});

// アプリ側から通知を依頼されたら表示する
self.addEventListener('message', (e) => {
  const data = e.data || {};
  if (data.type === 'notify') {
    self.registration.showNotification(data.title || 'ハンナ', {
      body: data.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: data.tag || 'hanna',
      renotify: true,
    });
  }
});

// 通知タップでアプリを前面に
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
