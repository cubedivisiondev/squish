/* SQUISH service worker.
 * Precaches the app shell + the local font/logo copies so the tool works offline
 * after the first load. All precache URLs are RELATIVE to this script, so the app
 * runs at any mount point (site root, a subpath, a webview). Scope defaults to
 * this script's directory. Cross-origin CDN assets (gifsicle, the ffmpeg core)
 * are never intercepted. */

const VERSION = 'squish-1.0.0';

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png',
  'icons/icon-512-maskable.png',
  'favicon.svg',
  'vendor/ffmpeg/ffmpeg.js',
  'vendor/ffmpeg/util.js',
  'vendor/ffmpeg/814.ffmpeg.js',
  'puddy-logo.svg',
  'favicon-32.png',
  'favicon-16.png',
  'fonts/Jost-400.woff2',
  'fonts/Jost-700.woff2',
  'fonts/Manrope-400.woff2',
  'fonts/Manrope-700.woff2',
  'fonts/SpaceMono-400.woff2',
  'fonts/SpaceMono-700.woff2',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(VERSION).then((cache) =>
      // resilient: a single missing asset shouldn't abort the whole install
      Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' }))))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // ONLY handle same-origin requests. Cross-origin CDN assets (gifsicle, the
  // ffmpeg core/worker) MUST pass straight through to the network untouched: the
  // ffmpeg worker loads its core via importScripts(), and a SW-reconstructed
  // response breaks that (opaque cross-origin scripts cannot be re-served). The
  // browser HTTP cache still covers those; we just do not intercept them.
  if (url.origin !== self.location.origin) return;

  // App shell (same origin) -> network-first so a new deploy shows immediately;
  // fall back to cache only when offline. cache:'no-cache' makes the fetch
  // REVALIDATE with the server (cheap ETag 304) instead of trusting the browser
  // HTTP cache - without it, "network-first" silently becomes "browser-cache-
  // first" and a deploy can stay invisible for hours (static hosts often send no
  // Cache-Control, so browsers cache heuristically).
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const fallback = await cache.match(req);
      if (fallback) return fallback;
      throw err;
    }
  })());
});
