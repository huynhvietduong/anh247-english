// Service worker: cho phép cài đặt PWA, chạy offline và hiển thị thông báo
const CACHE = 'englishdaily-v12';
const ASSET_V = '12';                 // phải khớp với ?v= trong index.html
const SHELL = [
  './',
  './index.html',
  './style.css?v=' + ASSET_V,
  './data.js?v=' + ASSET_V,
  './data2.js?v=' + ASSET_V,
  './data3.js?v=' + ASSET_V,
  './app.js?v=' + ASSET_V,
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' → luôn lấy từ mạng, không dùng bản cũ trong bộ đệm HTTP
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u =>
        fetch(new Request(u, { cache: 'reload' })).then(r => r.ok && c.put(u, r)).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
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
// Thẻ từ vựng có nút bấm ngay trên thông báo → học & chấm nhớ/quên ngay ở màn hình khóa
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch (err) {}
  const opts = {
    body: d.body || 'Đến giờ học tiếng Anh rồi!',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: 'englishdaily-push',
    renotify: true,
    requireInteraction: !!d.item,          // thẻ từ vựng: giữ trên màn hình khóa tới khi trả lời
    data: d,
  };
  // Chỉ thẻ từ vựng (có `item`) mới cho bấm trả lời tại chỗ
  if (d.item) opts.actions = [
    { action: 'reveal', title: '👁️ Xem nghĩa' },
    { action: 'know', title: '✓ Đã nhớ' },
  ];
  e.waitUntil(self.registration.showNotification(d.title || '📚 EnglishDaily', opts));
});

async function gradeCard(d, remembered) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch('/api/push/grade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint, item: d.item, remembered }),
    });
  } catch (err) {}
}

function openApp() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./index.html');
  });
}

self.addEventListener('notificationclick', e => {
  const d = e.notification.data || {};
  const act = e.action;

  // Bước 1: lật thẻ — hiện nghĩa + ví dụ, đổi thành 2 nút chấm điểm
  if (act === 'reveal') {
    e.notification.close();
    e.waitUntil(self.registration.showNotification(`💡 ${d.word || ''} = ${d.meaning || ''}`, {
      body: d.ex ? `"${d.ex}"\nBạn có nhớ từ này không?` : 'Bạn có nhớ từ này không?',
      icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
      tag: 'englishdaily-push', renotify: true, requireInteraction: true, data: d,
      actions: [
        { action: 'know', title: '✓ Đã nhớ' },
        { action: 'forgot', title: '✗ Chưa nhớ' },
      ],
    }));
    return;
  }

  // Bước 2: chấm điểm — ghi vào lịch ôn trên máy chủ, không cần mở app
  if (act === 'know' || act === 'forgot') {
    e.notification.close();
    e.waitUntil(gradeCard(d, act === 'know').then(() => {
      if (act === 'forgot') {   // quên thì cho xem lại nghĩa để nhớ thêm
        return self.registration.showNotification(`📖 ${d.word || ''} = ${d.meaning || ''}`, {
          body: d.ex ? `"${d.ex}"\nĐã xếp lịch ôn lại vào ngày mai 💪` : 'Đã xếp lịch ôn lại vào ngày mai 💪',
          icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'englishdaily-push', data: {},
        });
      }
    }));
    return;
  }

  // Chạm vào thân thông báo → mở app
  e.notification.close();
  e.waitUntil(openApp());
});
