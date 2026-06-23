// remote-cc Service Worker —— 极简、network-only,绝不缓存任何应用资源。
// 目的:满足 PWA「可安装」体验 + 留个将来扩展点;
// 刻意不做离线缓存,从根上杜绝「改完代码重建后浏览器还吃旧前端」(本项目硬纪律:必须重建才生效)。
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// 所有请求一律直通网络,不读写 Cache。
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
