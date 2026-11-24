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
// Bump CACHE_VERSION on EVERY deploy that changes the UI, icons or this list.
// The activate handler deletes every cache whose name differs, so installed
// apps drop the old icon/UI instead of serving stale copies.

const CACHE_VERSION = "cafeq-cache-v7";
// model.json is NOT precached: it usually does not exist (the app then uses the
// formula). When it does, the network-first handler below caches it on first use.
const SHELL = [
  "./",
  "./index.html",
  "./report.html",
  "./worthit.html",
  "./admin.html",
  "./css/styles.css",
  "./js/config.js",
  "./js/firebase-init.js",
  "./js/data.js",
  "./js/ui.js",
  "./js/status-engine.js",
  "./js/geo.js",
  "./js/location.js",
  "./js/settings.js",
  "./js/theme.js",
  "./js/model.js",
  "./js/feedback.js",
  "./js/admin.js",
  "./js/admin-lib.js",
  "./js/dashboard.js",
  "./js/report.js",
  "./js/worthit.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  // cache: "reload" bypasses the browser's HTTP cache, so a new version never
  // precaches a stale copy of a file (e.g. the old icon) from before the deploy.
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
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

  // Same-origin app shell -> network-first, cache fallback. "no-cache" makes the
  // browser revalidate with the server (cheap 304 via ETag) instead of reusing
  // an HTTP-cached copy, so a deploy shows up on the next load.
  event.respondWith(
    fetch(req, { cache: "no-cache" })
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
