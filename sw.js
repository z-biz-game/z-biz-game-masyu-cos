/* 数链 · Masyu 的 service worker
 *
 * 只有一种策略：**网络优先，失败退缓存**。为什么不做 cache-first——这个页面是
 * `<script type="module">` + 相对路径 import 的一堆同源子资源（js/engine/*.js 六张模块），
 * cache-first 会把它们连同 index.html 一起钉死在第一次抓取的那版上：出新 HTML 配旧引擎，
 * 玩家看到的是永远修不好的鬼状态，而且他自己刷不掉。版本号写在 cache 名里，
 * 每次发布改 VERSION ⇒ activate 时旧桶整桶删掉，不会留下越攒越多的孤儿缓存。
 *
 * file:// 下这个文件根本不会被注册（index.html 里那段守卫负责），所以这里不假设自己存在。
 */
const VERSION = 'v0.1.0-1';
const CACHE = `masyu-${VERSION}`;
const APP_SHELL = [
  './',
  'index.html',
  'css/game.css',
  'manifest.webmanifest',
  'icons/favicon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'art/board-texture.png',
  'art/fx-sprites.png',
];

self.addEventListener('install', (e) => {
  // 预热只是"顺手"：拿不到（离线装、Pages 前缀不同形状）也不该让安装失败。
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(APP_SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外链一律不接管（这页面也没有外链）
  if (url.pathname.endsWith('/sw.js')) return; // 自己永远走网络，否则新版本永远下不来

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      })
      .catch(() =>
        caches
          .match(req)
          .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
          .then((hit) => hit || Response.error())
      )
  );
});
