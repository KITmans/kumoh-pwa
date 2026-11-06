const CACHE_NAME = 'kit-app-shell-v10';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg',
  './FlightSans-Regular.ttf',
  './FlightSans-Bold.ttf'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  const isData = url.hostname === 'raw.githubusercontent.com' ||
    (url.origin === self.location.origin && url.pathname.includes('/data/'));
  if (!isData && url.origin !== self.location.origin) return;

  // 데이터 JSON: 네트워크 우선 (항상 최신), 오프라인이면 마지막으로 받은 것을 사용
  if (isData) {
    const key = req.url.split('?')[0]; // ?t=... 같은 캐시 방지용 값은 저장 키에서 제외
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(key, clone));
        }
        return res;
      }).catch(() => caches.match(key))
    );
    return;
  }

  // 앱 셸: 캐시로 즉시 응답하고, 뒤에서 갱신 (다음 실행 때 새 버전 반영)
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

// ===== 서버 푸시 수신 (앱을 꺼도 알림) =====
// GitHub Actions 가 보낸 푸시를 받아서 알림으로 보여준다.
// 주의: 푸시를 받으면 반드시 알림을 띄워야 해요. 아무것도 안 보여주면 아이폰이 구독을 해지할 수 있어요.
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  const title = d.title || '금오공대';
  const options = {
    body: d.body || '',
    icon: './icons/icon-192.png',
    tag: d.tag || undefined,
    data: { url: d.url || './' }
  };
  event.waitUntil(Promise.all([
    Promise.resolve(self.registration.showNotification(title, options)).catch(() => {}),
    logNotif(title, options.body).catch(() => {})
  ]));
});

// 받은 알림을 IndexedDB 에 저장 (앱의 종 모양 알림 기록에서 읽음)
function logNotif(title, body) {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open('kit-notif', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('log', { keyPath: 'id', autoIncrement: true });
      r.onerror = () => resolve();
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction('log', 'readwrite');
        const s = tx.objectStore('log');
        s.add({ title, body, ts: Date.now() });
        const c = s.getAllKeys();
        c.onsuccess = () => { const k = c.result || []; for (let i = 0; i < k.length - 100; i++) s.delete(k[i]); };
        tx.oncomplete = () => {
          db.close();
          self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((list) => list.forEach((c2) => c2.postMessage({ type: 'notif-log' })))
            .then(resolve, resolve);
        };
        tx.onerror = () => resolve();
      };
    } catch (e) { resolve(); }
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
