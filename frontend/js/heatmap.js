/*
 * CafeQ — "Best time to visit" heatmap.
 *
 * Renders a 7 x 12 grid (Mon–Sun x hourly slots 8am–8pm) from
 * GET /api/history/heatmap?cafe_id=X. Each cell is coloured with the same
 * traffic-light thresholds as the live status, so "green at 3pm Tuesday"
 * means the same thing everywhere in the app. Empty cells = no data yet.
 *
 * Purpose: shift demand. If students can see that Cafe B is reliably quiet at
 * 11:00, some will go then instead of joining the 12:30 rush.
 */
(function () {
  "use strict";

  var cache = {};                 // cafe_id -> { at: ms, data: {...} }
  var CACHE_MS = 5 * 60 * 1000;   // history changes slowly; avoid refetching on every tap

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function hourLabel(h) {
    var suffix = h < 12 ? "a" : "p";
    var twelve = h % 12 === 0 ? 12 : h % 12;
    return twelve + suffix;
  }

  function draw(host, data) {
    host.textContent = "";
    var grid = el("div", "heatmap");
    grid.setAttribute("role", "table");
    grid.setAttribute("aria-label", "Average wait by day and hour");

    // Header row: hour labels (every other hour, to fit 360px screens).
    grid.appendChild(el("span"));
    data.hours.forEach(function (h, i) {
      grid.appendChild(el("span", "hlabel", i % 2 === 0 ? hourLabel(h) : ""));
    });

    // Highlight "now" so students can read across to later, quieter slots.
    var now = new Date();
    var today = (now.getDay() + 6) % 7; // JS Sunday=0 -> Monday=0
    var hourNow = now.getHours();

    data.grid.forEach(function (row, d) {
      grid.appendChild(el("span", "dlabel", data.days[d]));
      row.forEach(function (cell, i) {
        var c = el("span", "cell" + (cell.level ? " " + cell.level : ""));
        if (d === today && data.hours[i] === hourNow) c.className += " now";
        var label = data.days[d] + " " + hourLabel(data.hours[i]) + ": " +
          (cell.avg_wait === null ? "no data" : "~" + cell.avg_wait + " min (" + cell.samples + " samples)");
        c.title = label;
        c.setAttribute("aria-label", label);
        c.setAttribute("role", "cell");
        grid.appendChild(c);
      });
    });
    host.appendChild(grid);

    var legend = el("div", "heatmap-legend");
    [["var(--green)", "< 5 min"], ["var(--yellow)", "5–12 min"], ["var(--red)", "12+ min"], ["var(--heat-empty)", "No data"]]
      .forEach(function (item) {
        var s = el("span", null, item[1]);
        s.style.setProperty("--c", item[0]);
        legend.appendChild(s);
      });
    host.appendChild(legend);

    if (data.best_slot) {
      host.appendChild(el("p", "hint",
        "Usually quietest: " + data.best_slot.day + " around " + hourLabel(data.best_slot.hour) +
        " (~" + data.best_slot.avg_wait + " min)."));
    }
    if (data.data_source === "synthetic") {
      // Honesty rule: demo data is always labelled as such.
      host.appendChild(el("span", "synthetic-tag", "⚠️ Synthetic demo data — not real observations"));
    } else if (data.data_source === "none") {
      host.appendChild(el("p", "hint", "No history yet. The grid fills in as vendors and students report."));
    } else if (!data.best_slot) {
      host.appendChild(el("p", "hint",
        "Only " + data.total_samples + " reading" + (data.total_samples === 1 ? "" : "s") +
        " so far — patterns appear as vendors and students keep reporting."));
    }
  }

  function render(host, cafeId) {
    var hit = cache[cafeId];
    if (hit && Date.now() - hit.at < CACHE_MS) {
      draw(host, hit.data);
      return;
    }
    host.textContent = "Loading history…";
    fetch("/api/history/heatmap?cafe_id=" + encodeURIComponent(cafeId))
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        cache[cafeId] = { at: Date.now(), data: data };
        draw(host, data);
      })
      .catch(function () {
        host.textContent = "Couldn't load history right now.";
      });
  }

  window.CafeHeatmap = { render: render };
})();
