/*
 * CafeQ — push notification opt-in.
 *
 * Flow: banner "Get notified before your break 🔔 [Enable]"
 *   -> Notification.requestPermission()      (must run inside the tap)
 *   -> ask for break time + favourite cafe
 *   -> pushManager.subscribe(VAPID key)       (Chrome hands this to FCM)
 *   -> POST /api/subscribe
 *
 * Graceful fallback (project rule): if the browser lacks Service Workers,
 * the Push API or Notifications — e.g. iOS Safari outside an installed PWA —
 * the banner simply never appears. No error, no alert, nothing to dismiss.
 * The same silence applies if the server has no VAPID keys configured.
 */
(function () {
  "use strict";

  var DISMISS_KEY = "cafeq.notifyDismissed";
  var SUBSCRIBED_KEY = "cafeq.notifySubscribed";

  function supported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window &&
      window.isSecureContext;
  }

  // VAPID keys are base64url; pushManager.subscribe wants raw bytes.
  function urlBase64ToUint8Array(base64String) {
    var padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    var raw = window.atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function init() {
    var banner = document.getElementById("notify-banner");
    var modal = document.getElementById("notify-modal");
    if (!banner || !modal || !supported() || !window.CafeQ) return; // silent fallback

    var Q = window.CafeQ;
    var vapidKey = null;

    function hideBanner() { banner.hidden = true; }

    // Only offer what the server can actually deliver.
    Q.api("/api/notify/vapid-public-key").then(function (res) {
      if (!res.enabled || !res.public_key) return;
      vapidKey = res.public_key;
      if (Notification.permission === "denied") return;           // user said no; respect it
      if (Q.storageGet(DISMISS_KEY) === "1") return;
      if (Q.storageGet(SUBSCRIBED_KEY) === "1" && Notification.permission === "granted") return;
      banner.hidden = false;
    }).catch(function () { /* silent */ });

    document.getElementById("notify-dismiss").addEventListener("click", function () {
      Q.storageSet(DISMISS_KEY, "1");
      hideBanner();
    });

    document.getElementById("notify-enable").addEventListener("click", function () {
      // requestPermission must be called directly from the tap handler.
      var request = Notification.requestPermission();
      Promise.resolve(request).then(function (permission) {
        if (permission !== "granted") {
          hideBanner();
          return;
        }
        Q.openModal(modal);
      }).catch(hideBanner);
    });

    document.getElementById("notify-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var breakTime = document.getElementById("notify-time").value;
      var cafeId = document.getElementById("notify-cafe").value || null;
      var btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true;

      navigator.serviceWorker.register("/sw.js")
        .then(function () { return navigator.serviceWorker.ready; })
        .then(function (reg) {
          return reg.pushManager.getSubscription().then(function (existing) {
            return existing || reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(vapidKey)
            });
          });
        })
        .then(function (subscription) {
          var json = subscription.toJSON();
          return Q.api("/api/subscribe", {
            method: "POST",
            body: JSON.stringify({
              endpoint: json.endpoint,
              keys: json.keys,
              break_time: breakTime,
              preferred_cafe_id: cafeId
            })
          });
        })
        .then(function () {
          Q.storageSet(SUBSCRIBED_KEY, "1");
          Q.closeModal(modal);
          hideBanner();
          Q.toast("Done! We'll ping you 10 min before " + breakTime + ".");
        })
        .catch(function () {
          // Keep it gentle: notifications are a bonus, the dashboard still works.
          Q.closeModal(modal);
          hideBanner();
          Q.toast("Couldn't turn on reminders on this device.");
        })
        .then(function () { btn.disabled = false; });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
