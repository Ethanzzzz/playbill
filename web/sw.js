// sw.js — Service Worker
// 策略：
//  - 导航请求（打开页面）：网络优先，失败才回退缓存 → 保证能拿到最新版本
//  - 静态资源：先用缓存秒开，同时后台拉新并更新缓存（stale-while-revalidate）
//  - /api/ 永远走网络，不缓存
const CACHE = "psn-spend-v17-swiss";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/api/")) return; // API 不缓存
  if (e.request.method !== "GET") return;

  // 导航：网络优先
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const network = fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
