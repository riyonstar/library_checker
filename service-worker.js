/* Service Worker
 * - アプリ本体(HTML/CSS/JS/データ)をキャッシュしてオフラインでも起動できるようにする
 * - 図書館の在架状況(APIの応答)は一切キャッシュしない(古い情報を最新と誤認させないため)
 * - Web Push を受けたら、バックエンドに通知本文を取りに行って表示する(ペイロードなしのPush)
 *
 * ファイルを更新したら CACHE_VERSION を上げてください。
 */
const CACHE_VERSION = 'kitalib-v1';
const APP_SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'config.js', 'data.js',
  'books.json', 'libraries.json', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // 1つ取れなくても全体を失敗させない
      .then((cache) => Promise.all(APP_SHELL.map((u) => cache.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 別オリジン(バックエンドAPIなど)はキャッシュしない = 在架状況は常に新しく取りに行く
  if (url.origin !== self.location.origin) return;

  // ページ遷移: ネット優先、オフラインのときだけキャッシュ
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put('index.html', copy)); return res; })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }
  // 静的ファイル: キャッシュ優先 + 裏で更新(stale-while-revalidate)
  event.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});

/* ---------- Web Push ---------- */
// Push には本文を載せない(暗号化処理を不要にして単純・堅牢にするため)。
// 受信したら、保存済みの購読ID(endpoint のハッシュ)でバックエンドから通知を取得して表示する。
const IDB_NAME = 'kitalib-sw';
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function sha256Hex(text) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function backendUrl() {
  // config.js をSW内で読む(同じ設定ファイルを共有する)
  try { importScripts('config.js'); } catch (e) { /* noop */ }
  return ((self.APP_CONFIG && self.APP_CONFIG.BACKEND_URL) || '').replace(/\/+$/, '');
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let shown = 0;
    try {
      const sub = await self.registration.pushManager.getSubscription();
      const base = await backendUrl();
      if (sub && base) {
        const res = await fetch(base + '/api/notifications/pull', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          body: JSON.stringify({ sub: await sha256Hex(sub.endpoint) }),
        });
        const data = await res.json();
        for (const m of (data.messages || [])) {
          await self.registration.showNotification(m.title || '📚 本が借りられます', {
            body: m.body, tag: m.id, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: m.bookId ? `./#/book/${encodeURIComponent(m.bookId)}` : './#/notifications' },
          });
          shown++;
        }
        // アプリ側(開いていれば)にも取り込みを促す
        const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        cs.forEach((c) => c.postMessage({ type: 'pull' }));
      }
    } catch (e) { /* 取得失敗時は下の汎用通知 */ }
    // iOS/Safari は Push を受けたら必ず通知を表示する必要がある(表示しないと購読が無効化される)
    if (!shown) {
      await self.registration.showNotification('📚 図書館のお知らせ', { body: 'お気に入りの本の状況が更新されました。アプリを開いて確認してください。', icon: 'icon-192.png', tag: 'kitalib-generic', data: { url: './#/notifications' } });
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) {
      if ('focus' in c) { await c.focus(); if ('navigate' in c) { try { await c.navigate(new URL(target, self.registration.scope).href); } catch (e) { /* noop */ } } return; }
    }
    await self.clients.openWindow(new URL(target, self.registration.scope).href);
  })());
});
