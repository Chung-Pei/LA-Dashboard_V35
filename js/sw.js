// ══════════════════════════════════════════════════════════
// sw.js — 學習數據分析儀表板 Service Worker
// 策略：App Shell (Cache First) + data/*.json (Network First)
//       帶 ?v= 版本參數的 JS → Cache First（版本號即 cache key）
//       index.html → Stale-While-Revalidate（快取先回、背景更新）
// 更新：2026-05-24 效能優化：JS 模組改 Cache First
// ══════════════════════════════════════════════════════════

const CACHE_VERSION = 'la-dash-v6-20260527a';
const DATA_CACHE    = 'la-dash-data-v6-20260527a';

// App Shell：靜態資源，安裝時全部快取
// ⚠ CDN 資源釘定版本號，確保快取與 HTML 引用一致
const CHARTJS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';

const APP_SHELL = [
  './index.html',
  './manifest.json',
  // Icons（含新增 167/120）
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './icons/icon-167.png',
  './icons/icon-120.png',
  // Vendor (本地化)
  './js/vendor/chart.umd.min.js',
  './js/vendor/chartjs-plugin-annotation.min.js',
  './js/vendor/pwacompat.min.js',
  // 安全模組（同步載入，無版本參數）
  './js/frame-guard.js',
  // 篩選引擎（無版本參數）
  './js/filter-engine.js',
  // 主應用邏輯
  './js/main.js',
  // 學習行為模組（版本釘定 ?v=20260527）
  './js/chart-registry.js?v=20260527',
  './js/behavior-loader.js?v=20260527',
  './js/tab-behavior-radar.js?v=20260527',
  './js/tab-behavior-correlation.js?v=20260527',
  './js/tab-behavior-time.js?v=20260527',
  './js/behavior-init.js?v=20260527',
  './js/at-risk-report.js?v=20260527',
  // CDN 備援（版本釘定）
  CHARTJS_URL,
];

// ── 安裝：快取 App Shell ──────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Install cache failed:', err))
  );
});

// ── 啟動：清除舊快取 ──────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION && key !== DATA_CACHE)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── 攔截請求 ─────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // 只處理 GET
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // HTML 導覽頁 → Stale-While-Revalidate（先吐快取、背景更新，消除白屏等待）
  if (request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // data/*.json → Network First（確保每次取得最新資料）
  if (url.pathname.endsWith('data.json') || /\/data\/.+\.json$/.test(url.pathname)) {
    event.respondWith(networkFirstData(request));
    return;
  }

  // Chart.js CDN → Cache First（版本已釘定）
  if (url.href === CHARTJS_URL) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Google Fonts → Cache First
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(request));
    return;
  }

  // js/vendor/* → Cache First（本地化版本釘定）
  if (url.pathname.includes('/js/vendor/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // frame-guard.js 同步載入 → Network First（安全關鍵，優先取新版）
  if (url.pathname.endsWith('frame-guard.js')) {
    event.respondWith(networkFirst(request));
    return;
  }

  // ★ 帶 ?v= 版本參數的 JS → Cache First（版本號已確保唯一性，無需網路驗證）
  if (url.pathname.endsWith('.js') && url.search.includes('v=')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 其他 JS（無版本參數，如 main.js、filter-engine.js）→ Stale-While-Revalidate
  if (url.pathname.endsWith('.js')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 其他 App Shell 靜態資源 → Cache First
  if (url.pathname.match(/\.(css|png|svg|ico|webmanifest|json)$/)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 其他 → Network First
  event.respondWith(networkFirst(request));
});

// ── Cache First 策略 ──────────────────────────────────────
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      await safePut(cache, request, response.clone());
    }
    return response;
  } catch {
    return new Response('離線中，此資源尚未快取', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// ── Stale-While-Revalidate 策略 ──────────────────────────
// 立即回傳快取（消除白屏），同時背景更新快取
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  // 背景更新（不阻塞回應）
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) {
      safePut(cache, request, response.clone());
    }
    return response;
  }).catch(err => {
    // Bug B fix: log instead of silently swallowing
    console.warn('[SW] staleWhileRevalidate background fetch failed:', request.url, err?.message);
    return null;
  });

  // 有快取就立即回傳，無快取才等網路
  return cached || fetchPromise;
}

// ── Network First（資料 JSON 專用，帶離線回退）────────────
async function networkFirstData(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DATA_CACHE);
      await safePut(cache, request, response.clone());
    }
    return response;
  } catch {
    // 離線：嘗試回傳上次快取的資料 JSON
    const cached = await caches.match(request, { cacheName: DATA_CACHE });
    if (cached) {
      console.log('[SW] Offline: serving cached data JSON');
      return cached;
    }
    return new Response(JSON.stringify({
      error: 'offline',
      message: '目前離線且無快取資料，請連線後重新整理'
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}

// ── Network First 通用 ────────────────────────────────────
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      await safePut(cache, request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('離線中', { status: 503 });
  }
}

// ── 安全快取（避免 QuotaExceededError）───────────────────
async function safePut(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      console.warn('[SW] Cache quota exceeded, pruning...');
      await pruneCache(cache);
      // Bug A fix: retry put after pruning to actually persist the resource
      try { await cache.put(request, response); } catch { /* give up gracefully */ }
    }
  }
}

async function pruneCache(cache) {
  const keys = await cache.keys();
  if (keys.length > 30) {                          // Bug A fix: tighter threshold (30 vs 40)
    const toDelete = keys.slice(0, keys.length - 30);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}

// ── 接收來自主頁面的訊息 ──────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: CACHE_VERSION });
  }
});
