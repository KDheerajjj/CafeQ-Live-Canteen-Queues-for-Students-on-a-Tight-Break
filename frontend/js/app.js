/*
 * CafeQ — student dashboard.
 *
 * Responsibilities:
 *  - Poll /api/status every 30 s and render one card per cafe.
 *  - Re-apply the stale rule in the browser too: if an update is older than
 *    the threshold (15 min) the card goes grey "Unknown", even if the tab has
 *    been sitting in the background and the last fetch was a while ago.
 *    A stale green is the single worst thing this app could show.
 *  - "Report Crowd" modal (anonymous one-tap reports).
 *  - "Worth it?" form that calls the decision engine.
 */
(function () {
  "use strict";

  var STATUS_LABEL = { green: "Free", yellow: "Moderate", red: "Busy", unknown: "Unknown" };

  var state = {
    cafes: [],             // from /api/cafes
    statuses: [],          // from /api/status
    staleMinutes: 15,
    refreshSeconds: 30,
    // Server clock at last fetch, and our clock at that moment. Ages are
    // computed against server time so a phone with a wrong clock still works.
    serverNowMs: null,
    fetchedAtMs: null,
    timer: null,
    expanded: {}           // cafe_id -> true when the card's heatmap is open
  };

  var els = {};

  // ---------- small helpers ----------

  function $(id) { return document.getElementById(id); }

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* private mode etc. */ }
  }

  // Server timestamps are UTC "YYYY-MM-DD HH:MM:SS".
  function parseUtc(ts) {
    if (!ts) return null;
    var ms = Date.parse(String(ts).replace(" ", "T") + "Z");
    return isNaN(ms) ? null : ms;
  }

  function serverNow() {
    if (state.serverNowMs === null) return Date.now();
    return state.serverNowMs + (Date.now() - state.fetchedAtMs);
  }

  function api(path, options) {
    options = options || {};
    var headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    return fetch(path, Object.assign({}, options, { headers: headers })).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var msg = (body && body.detail) ? (typeof body.detail === "string" ? body.detail : "Invalid input") : ("Error " + res.status);
          var err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  var toastTimer = null;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 3200);
  }

  function showNotice(message, isError) {
    els.notice.textContent = message || "";
    els.notice.hidden = !message;
    els.notice.classList.toggle("error", !!isError);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------- modals ----------

  var lastFocus = null;
  function openModal(modal) {
    lastFocus = document.activeElement;
    modal.hidden = false;
    var first = modal.querySelector("select, input, button:not([data-close])");
    if (first) first.focus();
  }
  function closeModal(modal) {
    modal.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function wireModal(modal) {
    modal.addEventListener("click", function (e) {
      if (e.target === modal || e.target.hasAttribute("data-close")) closeModal(modal);
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    document.querySelectorAll(".modal:not([hidden])").forEach(closeModal);
  });

  function fillCafeSelect(select, opts) {
    opts = opts || {};
    var keep = select.value;
    // Keep any static leading options (e.g. "No preference").
    Array.prototype.slice.call(select.options).forEach(function (o) {
      if (!o.hasAttribute("data-static") && o.value !== "") select.removeChild(o);
    });
    state.cafes.forEach(function (cafe) {
      var o = document.createElement("option");
      o.value = cafe.id;
      o.textContent = cafe.name;
      select.appendChild(o);
    });
    var preferred = keep || (opts.rememberKey && storageGet(opts.rememberKey));
    if (preferred && state.cafes.some(function (c) { return c.id === preferred; })) select.value = preferred;
  }

  // ---------- rendering ----------

  // Applies the client-side stale rule and returns what the card should show.
  function effectiveStatus(s) {
    var updatedMs = parseUtc(s.last_updated);
    var ageMin = updatedMs === null ? null : (serverNow() - updatedMs) / 60000;
    var stale = ageMin === null || ageMin > state.staleMinutes;
    if (s.status === "unknown" || stale) {
      return { status: "unknown", ageMin: ageMin, wait: "—" };
    }
    return { status: s.status, ageMin: ageMin, wait: s.wait_estimate || "—" };
  }

  function ageText(ageMin) {
    if (ageMin === null) return "No recent updates";
    var m = Math.max(0, Math.floor(ageMin));
    if (m === 0) return "Updated just now";
    if (m === 1) return "Updated 1 min ago";
    if (m < 120) return "Updated " + m + " min ago";
    return "Updated over 2 h ago";
  }

  function buildCard(cafeId) {
    var card = el("article", "card");
    card.dataset.cafeId = cafeId;

    var main = el("button", "card-main");
    main.type = "button";
    main.setAttribute("aria-expanded", "false");

    var titleRow = el("div", "title-row");
    var dot = el("span", "dot unknown");
    dot.setAttribute("aria-hidden", "true");
    titleRow.appendChild(dot);
    titleRow.appendChild(el("span", "cafe-name"));

    var wait = el("div", "wait");
    wait.appendChild(el("span", "value", "—"));
    wait.appendChild(el("span", "label", "est. wait"));

    var meta = el("div", "meta");
    meta.appendChild(el("span", "age"));

    main.appendChild(titleRow);
    main.appendChild(wait);
    main.appendChild(el("div", "status-text unknown", "Unknown"));
    main.appendChild(meta);

    var detail = el("div", "card-detail");
    detail.hidden = true;
    detail.appendChild(el("h3", null, "Best time to visit"));
    detail.appendChild(el("p", "hint", "Typical wait by weekday and hour (8am–8pm). Tap again to close."));
    detail.appendChild(el("div", "heatmap-host"));

    main.addEventListener("click", function () {
      var open = detail.hidden;
      detail.hidden = !open;
      main.setAttribute("aria-expanded", String(open));
      state.expanded[cafeId] = open;
      if (open && window.CafeHeatmap) {
        window.CafeHeatmap.render(detail.querySelector(".heatmap-host"), cafeId);
      }
    });

    card.appendChild(main);
    card.appendChild(detail);
    return card;
  }

  function updateCard(card, s) {
    var eff = effectiveStatus(s);
    card.querySelector(".dot").className = "dot " + eff.status;
    card.querySelector(".cafe-name").textContent = s.name;

    var statusText = card.querySelector(".status-text");
    statusText.className = "status-text " + eff.status;
    statusText.textContent = STATUS_LABEL[eff.status];

    card.querySelector(".wait .value").textContent = eff.wait;

    // Age colour: grey normally, orange after 10 min, red after 15 min.
    var age = card.querySelector(".age");
    age.textContent = ageText(eff.ageMin);
    age.className = "age" + (eff.ageMin === null ? "" :
      eff.ageMin > state.staleMinutes ? " stale" : eff.ageMin > 10 ? " warn" : "");

    var meta = card.querySelector(".meta");
    meta.querySelectorAll(".chip").forEach(function (c) { c.remove(); });
    if (eff.status !== "unknown") {
      var sourceText = s.source === "vendor" ? "Vendor update"
        : s.crowd_report_count + " student report" + (s.crowd_report_count === 1 ? "" : "s");
      meta.appendChild(el("span", "chip", sourceText));
      if (s.confidence === "low") meta.appendChild(el("span", "chip", "Low confidence"));
    }

    card.querySelector(".card-main").setAttribute(
      "aria-label",
      s.name + ": " + STATUS_LABEL[eff.status] + ", estimated wait " + eff.wait + ". " + ageText(eff.ageMin)
    );
  }

  function render() {
    if (!state.statuses.length) {
      els.cards.textContent = "";
      showNotice("No cafes are set up yet.", false);
      return;
    }
    var existing = {};
    els.cards.querySelectorAll(".card").forEach(function (c) { existing[c.dataset.cafeId] = c; });

    state.statuses.forEach(function (s) {
      var card = existing[s.cafe_id] || buildCard(s.cafe_id);
      updateCard(card, s);
      els.cards.appendChild(card); // appendChild also re-orders existing cards
      delete existing[s.cafe_id];
    });
    Object.keys(existing).forEach(function (id) { existing[id].remove(); });
  }

  function updateRefreshLabel() {
    if (!state.fetchedAtMs) return;
    var secs = Math.round((Date.now() - state.fetchedAtMs) / 1000);
    els.lastRefresh.textContent = secs < 5 ? "Live · just refreshed" : "Live · refreshed " + secs + " s ago";
  }

  // ---------- data loading ----------

  function loadCafes() {
    return api("/api/cafes").then(function (cafes) {
      state.cafes = cafes;
      fillCafeSelect(els.reportCafe, { rememberKey: "cafeq.reportCafe" });
      fillCafeSelect(els.worthitCafe, { rememberKey: "cafeq.worthitCafe" });
      fillCafeSelect(els.worthitFrom);
      var notifyCafe = $("notify-cafe");
      if (notifyCafe) fillCafeSelect(notifyCafe);
    });
  }

  function refresh() {
    els.refreshBtn.classList.add("spinning");
    return api("/api/status")
      .then(function (data) {
        state.statuses = data.cafes || [];
        state.staleMinutes = data.stale_threshold_minutes || 15;
        state.refreshSeconds = data.refresh_seconds || 30;
        state.serverNowMs = parseUtc(data.generated_at) || Date.now();
        state.fetchedAtMs = Date.now();
        els.staleMin.textContent = state.staleMinutes;
        showNotice("");
        render();
        updateRefreshLabel();
      })
      .catch(function () {
        // Keep showing cards, but the stale rule will grey them out over time.
        showNotice("Can't reach the server — retrying. Older statuses will turn grey.", true);
        if (state.statuses.length) render();
        els.lastRefresh.textContent = "Offline";
      })
      .then(function () {
        els.refreshBtn.classList.remove("spinning");
        schedule();
      });
  }

  function schedule() {
    clearTimeout(state.timer);
    if (document.hidden) return; // don't poll in a background tab
    state.timer = setTimeout(refresh, state.refreshSeconds * 1000);
  }

  // ---------- report crowd ----------

  function submitReport(status) {
    var cafeId = els.reportCafe.value;
    if (!cafeId) return;
    storageSet("cafeq.reportCafe", cafeId);
    var buttons = els.reportChoices.querySelectorAll("button");
    buttons.forEach(function (b) { b.disabled = true; });
    api("/api/report", { method: "POST", body: JSON.stringify({ cafe_id: cafeId, reported_status: status }) })
      .then(function () {
        closeModal(els.reportModal);
        toast("Thanks! Your report helps everyone. 🙌");
        refresh();
      })
      .catch(function (err) { toast(err.message); })
      .then(function () { buttons.forEach(function (b) { b.disabled = false; }); });
  }

  // ---------- worth it? ----------

  function renderWorthIt(r) {
    var box = els.worthitResult;
    box.textContent = "";
    box.className = "result " + r.recommendation;
    var verdict = { go: "✅ Go for it", alternative: "↪️ Try another cafe", skip: "⏭️ Skip it" }[r.recommendation];
    box.appendChild(el("div", "verdict", verdict));
    box.appendChild(el("div", null, r.message));

    if (r.options && r.options.length) {
      var table = el("table");
      var head = el("tr");
      ["Cafe", "Walk", "Wait", "Total"].forEach(function (h) { head.appendChild(el("th", null, h)); });
      table.appendChild(head);
      r.options.forEach(function (o) {
        var tr = el("tr");
        tr.appendChild(el("td", null, o.name.split(" (")[0]));
        tr.appendChild(el("td", null, o.walk_minutes + "m"));
        tr.appendChild(el("td", null, o.predicted_wait_minutes + "m"));
        tr.appendChild(el("td", null, o.total_minutes + "m"));
        table.appendChild(tr);
      });
      box.appendChild(table);
      box.appendChild(el("p", "footer-note", "Total = walk + predicted wait + " + r.requested.eating_buffer_minutes + " min to eat."));
    }
    box.hidden = false;
  }

  function submitWorthIt(e) {
    e.preventDefault();
    var cafeId = els.worthitCafe.value;
    var minutes = parseFloat($("worthit-minutes").value);
    if (!cafeId || !(minutes > 0)) return;
    storageSet("cafeq.worthitCafe", cafeId);
    var params = new URLSearchParams({ cafe_id: cafeId, available_minutes: String(minutes) });
    if (els.worthitFrom.value) params.set("from_cafe_id", els.worthitFrom.value);
    var btn = els.worthitForm.querySelector("button[type=submit]");
    btn.disabled = true;
    api("/api/predict/worthit?" + params.toString())
      .then(renderWorthIt)
      .catch(function (err) { toast(err.message); })
      .then(function () { btn.disabled = false; });
  }

  // ---------- boot ----------

  function init() {
    els = {
      cards: $("cards"),
      notice: $("notice"),
      toast: $("toast"),
      lastRefresh: $("last-refresh"),
      refreshBtn: $("refresh-btn"),
      staleMin: $("stale-min"),
      reportModal: $("report-modal"),
      reportCafe: $("report-cafe"),
      reportChoices: $("report-choices"),
      worthitModal: $("worthit-modal"),
      worthitForm: $("worthit-form"),
      worthitCafe: $("worthit-cafe"),
      worthitFrom: $("worthit-from"),
      worthitResult: $("worthit-result")
    };

    [els.reportModal, els.worthitModal, $("notify-modal")].forEach(function (m) { if (m) wireModal(m); });

    els.refreshBtn.addEventListener("click", refresh);
    $("report-open").addEventListener("click", function () { openModal(els.reportModal); });
    $("worthit-open").addEventListener("click", function () {
      els.worthitResult.hidden = true;
      openModal(els.worthitModal);
    });
    els.reportChoices.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-status]");
      if (btn) submitReport(btn.dataset.status);
    });
    els.worthitForm.addEventListener("submit", submitWorthIt);

    // Pause polling in background tabs; catch up immediately on return.
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) clearTimeout(state.timer);
      else refresh();
    });
    // Re-evaluate ages every 15 s so cards go grey on time even between fetches.
    setInterval(function () {
      if (state.statuses.length) render();
      updateRefreshLabel();
    }, 15000);

    loadCafes().catch(function () { /* status fetch will surface the error */ });
    refresh();

    // Service worker: enables "Add to Home Screen" and receiving push messages.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(function () { /* PWA features just stay off */ });
    }
  }

  // Shared with notifications.js / heatmap.js
  window.CafeQ = {
    api: api,
    toast: toast,
    openModal: openModal,
    closeModal: closeModal,
    storageGet: storageGet,
    storageSet: storageSet,
    getCafes: function () { return state.cafes; }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
