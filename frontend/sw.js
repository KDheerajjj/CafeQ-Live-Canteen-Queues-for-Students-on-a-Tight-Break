/*
 * CafeQ service worker.
 *
 * Only two jobs:
 *  1. Receive Web Push messages (delivered by FCM on Android Chrome) and show
 *     them as notifications — this works even when the dashboard is closed.
 *  2. On notification tap, focus an open dashboard tab or open a new one.
 *
 * Deliberately NO offline caching of /api responses: an offline copy of a
 * "green" status is exactly the stale data this project refuses to show.
 */

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : "" };
  }

  var title = data.title || "CafeQ — cafe status";
  var options = {
    body: data.body || "Open CafeQ to see live cafe status.",
    icon: data.icon || "/assets/icon-192.png",
    badge: "/assets/icon-192.png",
    // Same tag = a newer reminder replaces the older one instead of stacking.
    tag: "cafeq-status",
    renotify: true,
    data: { url: data.url || "/" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        var client = clients[i];
        if (client.url.indexOf(self.location.origin) === 0 && "focus" in client) {
          if ("navigate" in client && client.url !== target) client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
