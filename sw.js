// Service worker: cho phép cài đặt PWA, chạy offline và hiển thị thông báo
const CACHE = 'englishdaily-v9';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './data.js',
  './data2.js',
  './data3.js',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Ưu tiên mạng (luôn lấy bản mới nhất khi online), rớt mạng thì dùng cache
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(hit => hit || caches.match('./index.html')))
  );
});

// Nhận thông báo đẩy từ máy chủ (hoạt động cả khi app/trình duyệt đã đóng)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || '📚 EnglishDaily', {
    body: d.body || 'Đến giờ học tiếng Anh rồi!',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'englishdaily-push',
    data: { url: d.url || './index.html' },
  }));
});

// Bấm vào thông báo → mở app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow('./index.html');
    })
  );
});
