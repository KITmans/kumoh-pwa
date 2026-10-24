const CACHE_NAME = 'kit-app-shell-v3';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg'
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
