// service-worker.js — PWA offline shell.
//
// Strategy:
//  - App shell (our own HTML/CSS/JS/icons): network-first, falling back to the
//    cache, so students always get the latest version online and the app still
//    opens offline. Precached on install.
//  - Firebase SDK files from gstatic (versioned URLs, never change): cache-first.
//  - Firestore / Auth traffic (googleapis.com etc.): NOT intercepted — it goes
//    straight to the network ("network-first for Firestore"). The Firestore SDK
//    has its own offline cache for data.
//
// Bump CACHE_VERSION when you change the list below.

const CACHE_VERSION = "cafeq-v2";
const SHELL = [
  "./",
  "./index.html",
  "./report.html",
  "./worthit.html",
  "./css/styles.css",
  "./js/config.js",
  "./js/firebase-init.js",
  "./js/data.js",
  "./js/ui.js",
  "./js/status-engine.js",
  "./js/geo.js",
  "./js/dashboard.js",
  "./js/report.js",
  "./js/worthit.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Firebase SDK (immutable, versioned) -> cache-first.
  if (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
            return res;
          })
      )
    );
    return;
  }

  // Anything else cross-origin (Firestore, Auth, ...) -> leave to the network.
  if (url.origin !== self.location.origin) return;

  // Same-origin app shell -> network-first, cache fallback.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        // ignoreSearch so report.html?cafe=x still opens offline.
        caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("./index.html"))
      )
  );
});
