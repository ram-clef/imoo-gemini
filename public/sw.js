const name = 'imoo-anlz-hosted-v16';
const shell = ['/', '/app.js', '/collage.js', '/workflow.js', '/style.css', '/logo.png', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(name);
    await cache.addAll(shell.map(path => new Request(path, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const old = keys.filter(key => key !== name && (key.startsWith('imoo-anlz-shell-') || key.startsWith('imoo-anlz-hosted-')));
    await Promise.all(old.map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || !shell.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).catch(async () => (await caches.open(name)).match(url.pathname)));
});
