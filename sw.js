/* Herd PWA service worker — caches the app shell for offline launch.
   API calls (Herdwatch + Anthropic) always go to the network, never cached. */
const CACHE = "herd-v8";
const SHELL = ["./", "./index.html", "./manifest.webmanifest",
               "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Live data + LLM: always network, don't touch the cache.
  if (url.hostname.endsWith("hwbe.io") || url.hostname.endsWith("herdwatch.com") || url.hostname === "api.anthropic.com") return;
  if (e.request.method !== "GET") return;
  // App shell: serve from cache, fall back to network.
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
