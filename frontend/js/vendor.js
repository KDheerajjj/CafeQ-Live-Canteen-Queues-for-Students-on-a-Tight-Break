/*
 * CafeQ — vendor dashboard.
 *
 * Built for someone serving a queue with one hand: every action is one tap,
 * buttons are huge, and feedback is instant (vibration + toast). The vendor's
 * status tap is the most trusted signal in the system, so the page also shows
 * when the current status will expire (15 min) to prompt a re-tap.
 *
 * Auth is a shared demo PIN (see project constraints): verified once against
 * /api/admin/verify, then kept in sessionStorage (cleared when the tab closes)
 * and sent in the X-Vendor-PIN header — never in a URL.
 */
(function () {
  "use strict";

  var LABEL = { green: "FREE", yellow: "MODERATE", red: "BUSY", unknown: "UNKNOWN" };
  var PIN_KEY = "cafeq.vendorPin";
  var CAFE_KEY = "cafeq.vendorCafe";

  var pin = null;
  var cafes = [];
  var pollTimer = null;
  var busy = false;
  var statusSeq = 0;   // bumped on every status tap; stale poll responses are dropped

  function $(id) { return document.getElementById(id); }

  function session(key, value) {
    try {
      if (value === undefined) return window.sessionStorage.getItem(key);
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch (e) { return null; }
  }
  function local(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) { return null; }
  }

  function api(path, options) {
    options = options || {};
    var headers = { "Content-Type": "application/json" };
    if (pin) headers["X-Vendor-PIN"] = pin;
    return fetch(path, Object.assign({}, options, { headers: headers })).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(typeof body.detail === "string" ? body.detail : "Error " + res.status);
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  var toastTimer;
  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  function buzz() {
    if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* ignore */ } }
  }

  function currentCafe() { return $("vendor-cafe").value; }

  function hourLabel(h) {
    if (h === null || h === undefined) return "—";
    var end = (h + 1) % 24;
    function fmt(x) { return (x % 12 === 0 ? 12 : x % 12) + (x < 12 ? "am" : "pm"); }
    return fmt(h) + "–" + fmt(end);
  }

  // ---------- login ----------

  function showDashboard(cafeList) {
    cafes = cafeList || [];
    $("pin-form").hidden = true;
    $("dashboard").hidden = false;
    $("logout-btn").hidden = false;

    var select = $("vendor-cafe");
    select.textContent = "";
    cafes.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      select.appendChild(o);
    });
    var remembered = local(CAFE_KEY);
    if (remembered && cafes.some(function (c) { return c.id === remembered; })) select.value = remembered;
    // Only show the dropdown if this vendor actually has a choice to make.
    $("cafe-field").hidden = cafes.length <= 1;

    loadItems();
    refreshAll();
  }

  function login(candidate) {
    pin = candidate;
    return api("/api/admin/verify").then(function (res) {
      session(PIN_KEY, candidate);
      showDashboard(res.cafes);
    }).catch(function (err) {
      pin = null;
      session(PIN_KEY, null);
      throw err;
    });
  }

  function logout() {
    pin = null;
    session(PIN_KEY, null);
    clearTimeout(pollTimer);
    $("dashboard").hidden = true;
    $("logout-btn").hidden = true;
    $("pin-form").hidden = false;
    $("pin-input").value = "";
    $("pin-input").focus();
  }

  // ---------- data ----------

  function loadItems() {
    api("/api/orders/items").then(function (res) {
      var select = $("order-item");
      Array.prototype.slice.call(select.options).forEach(function (o) { if (o.value) o.remove(); });
      res.items.forEach(function (item) {
        var o = document.createElement("option");
        o.value = item.name;
        o.textContent = item.name.charAt(0).toUpperCase() + item.name.slice(1);
        select.appendChild(o);
      });
    }).catch(function () { /* dropdown is optional */ });
  }

  function renderStatus(s) {
    var buttons = document.querySelectorAll("#status-buttons .vendor-btn");
    buttons.forEach(function (b) { b.classList.toggle("selected", s.source === "vendor" && b.dataset.status === s.status); });
    $("current-dot").className = "dot " + s.status;

    var text;
    if (s.status === "unknown") {
      text = "Students see: UNKNOWN — tap a button to set your status.";
    } else if (s.source === "vendor") {
      var age = Math.floor(s.update_age_minutes || 0);
      var left = Math.max(0, 15 - age);
      text = "Students see: " + LABEL[s.status] + " · set " + (age === 0 ? "just now" : age + " min ago") +
        " · expires in " + left + " min";
    } else {
      text = "Students see: " + LABEL[s.status] + " (from " + s.crowd_report_count + " student report" +
        (s.crowd_report_count === 1 ? "" : "s") + ") — your tap overrides it.";
    }
    $("current-text").textContent = text;
    $("stat-reports").textContent = String(s.crowd_report_count || 0);
  }

  function renderCounts(c) {
    $("order-counter").textContent = "Orders today: " + c.orders_today;
    $("stat-total").textContent = String(c.orders_today);
    $("stat-busiest").textContent = c.busiest_hour_today === null ? "—" : hourLabel(c.busiest_hour_today);
    $("stat-15").textContent = String(c.count);
  }

  function refreshAll() {
    var cafeId = currentCafe();
    if (!cafeId) return;
    clearTimeout(pollTimer);
    var seq = statusSeq;
    Promise.all([
      api("/api/status/" + encodeURIComponent(cafeId)).then(function (s) {
        // A tap made while this poll was in flight is newer; don't overwrite it.
        if (seq === statusSeq) renderStatus(s);
      }),
      api("/api/orders/count/" + encodeURIComponent(cafeId) + "?minutes=15").then(renderCounts)
    ]).catch(function (err) {
      if (err.status === 401) { logout(); toast("Please log in again."); }
    }).then(function () {
      pollTimer = setTimeout(refreshAll, 30000);
    });
  }

  // ---------- actions ----------

  function setStatus(status) {
    if (busy) return;
    busy = true;
    statusSeq++;
    buzz();
    api("/api/status", {
      method: "POST",
      body: JSON.stringify({ cafe_id: currentCafe(), status: status, source: "vendor" })
    }).then(function (s) {
      renderStatus(s);
      toast("Status set: " + LABEL[status]);
    }).catch(function (err) {
      if (err.status === 401) logout();
      toast(err.message);
    }).then(function () { busy = false; });
  }

  function orderServed() {
    buzz();
    var btn = $("order-btn");
    btn.disabled = true;
    var item = $("order-item").value || null;
    // Optimistic counter bump so rapid taps feel instant.
    var counter = $("order-counter");
    var m = /(\d+)/.exec(counter.textContent);
    if (m) counter.textContent = "Orders today: " + (parseInt(m[1], 10) + 1);

    api("/api/orders", { method: "POST", body: JSON.stringify({ cafe_id: currentCafe(), item_name: item }) })
      .then(function () {
        return api("/api/orders/count/" + encodeURIComponent(currentCafe()) + "?minutes=15").then(renderCounts);
      })
      .catch(function (err) {
        if (err.status === 401) logout();
        toast("Not saved: " + err.message);
        refreshAll();
      })
      .then(function () {
        // Short lock prevents an accidental double-tap logging two orders.
        setTimeout(function () { btn.disabled = false; }, 350);
      });
  }

  // ---------- boot ----------

  function init() {
    $("pin-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var value = $("pin-input").value.trim();
      $("pin-error").textContent = "";
      login(value).catch(function (err) {
        $("pin-error").textContent = err.status === 401 ? "Wrong PIN. Try again." : "Can't reach the server.";
        $("pin-input").select();
      });
    });

    $("logout-btn").addEventListener("click", logout);
    $("vendor-cafe").addEventListener("change", function () {
      local(CAFE_KEY, currentCafe());
      refreshAll();
    });
    $("status-buttons").addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-status]");
      if (btn) setStatus(btn.dataset.status);
    });
    $("order-btn").addEventListener("click", orderServed);

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && pin) refreshAll();
    });

    // Resume a session after a page reload.
    var saved = session(PIN_KEY);
    if (saved) login(saved).catch(function () { $("pin-input").focus(); });
    else $("pin-input").focus();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
