// Cache the app shell so the PWA opens offline; API calls always go to the network.
const SHELL = "catapult-shell-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["./", "./index.html", "./manifest.webmanifest", "./icon.svg"])));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  const isAsset = e.request.method === "GET" && url.origin === location.origin && (url.pathname.endsWith("/") || /\.(html|js|css|svg|png|webmanifest)$/.test(url.pathname));
  if (!isAsset) return;
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(SHELL).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request).then((r) => r ?? caches.match("./index.html"))));
});
