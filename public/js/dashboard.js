// dashboard.js — student view: live cards for every cafe.
//
// Data flow:  Firestore (settings + cafes + recent reports + menus, realtime)
//             -> data.js -> status-engine.computeStatus per cafe
//             + location.js (optional: the student's own position -> walk times)
//             + the student's picked item -> status-engine.estimateFor
//             (+ model.js, only if a trained model was published)
//             -> sortForDashboard -> render cards.

import { registerServiceWorker } from "./firebase-init.js";
import { watchLiveStatuses } from "./data.js";
import { sortForDashboard, estimateFor } from "./status-engine.js";
import { resolveWalkMinutes } from "./geo.js";
import { createLocationTracker, usablePosition } from "./location.js";
import { loadModel } from "./model.js";
import { mountFeedbackPrompt } from "./feedback.js";
import { WALK_SPEED_M_PER_MIN, WALK_DETOUR_FACTOR, MAX_LOCATION_ACCURACY_M } from "./config.js";
import {
  esc, minutesAgo, queueText, statusLabelHtml, estimateText, chosenItem, setItemChoice,
  itemSelectHtml, showNotice, describeError,
} from "./ui.js";

registerServiceWorker();

// TODO(phase-2-notify): "remind me before my break" push notifications.
//   Requirements and design: docs/push-notifications.md

const $ = (id) => document.getElementById(id);
const cardsEl = $("cards");
const liveEl = $("live");
const WALK_OPTS = { speedMPerMin: WALK_SPEED_M_PER_MIN, detourFactor: WALK_DETOUR_FACTOR, maxAccuracyM: MAX_LOCATION_ACCURACY_M };

let latest = null;   // last { cafes, rows, settings, menu } from Firestore
let locState = null; // last state from the location tracker
let model = null;    // published ML model, or null (formula only)
let pendingRender = false;

function confidenceBadge(status) {
  if (status.status === "unknown") return `<span class="badge need">Needs a report</span>`;
  if (status.confidence === "high") return `<span class="badge high">High confidence</span>`;
  return `<span class="badge low">Low confidence</span>`;
}

function walkText(walk) {
  return walk.source === "you" ? `🚶 ~${walk.min} min walk from you (est.)` : `🚶 ${walk.min} min walk`;
}

function estimateTitle(est, status) {
  if (est.method === "model") return "Predicted by the ML model trained on real feedback";
  if (est.method === "formula") return "Median queue × this counter's assumed serving time (× congestion if packed) + making your order";
  if (est.method === "fallback") return "Rough estimate from older colour-only reports";
  return status.status === "unknown" ? "No recent report" : "";
}

function cardHtml({ cafe, status, walk, est, item, items }) {
  const known = status.status !== "unknown";
  const reports = known ? `${status.reportCount} report${status.reportCount === 1 ? "" : "s"}` : "";
  return `
    <li class="card ${known ? "" : "is-unknown"}">
      <div class="card-head">
        <span class="dot ${esc(status.status)}" aria-hidden="true"></span>
        <span class="card-name">${esc(cafe.name)}</span>
        ${statusLabelHtml(status.status)}
      </div>
      <div class="card-meta">
        ${status.queueCount != null ? `<span class="queue">${esc(queueText(status.queueCount))}</span>` : ""}
        <span title="${esc(estimateTitle(est, status))}">${esc(estimateText(est, item))}</span>
        <span>${esc(walkText(walk))}</span>
        ${known ? `<span>updated ${esc(minutesAgo(status.updatedMinAgo))} · ${reports}</span>` : `<span>no report recently</span>`}
      </div>
      ${itemSelectHtml(cafe, items, item)}
      <div class="card-foot">
        ${confidenceBadge(status)}
        <a class="card-link" href="./report.html?cafe=${encodeURIComponent(cafe.id)}">I'm here — report</a>
      </div>
    </li>`;
}

function render() {
  if (!latest) return;
  // Don't rebuild the cards while the student has a menu picker open.
  if (document.activeElement && document.activeElement.matches("select[data-item-for]")) {
    pendingRender = true;
    return;
  }
  pendingRender = false;
  const { cafes, rows, settings, menu } = latest;
  $("loading").hidden = true;
  liveEl.textContent = "live";
  liveEl.classList.remove("off");
  const pos = locState ? usablePosition(locState) : null;
  // The placeholder warning is about reference-point walk times; it doesn't
  // apply while walk times come from the student's own location.
  $("placeholder-banner").hidden = !cafes.some((c) => c.placeholder) || pos !== null;

  if (cafes.length === 0) {
    showNotice($("notice"), "No cafes yet", "The cafes list is empty. Run `npm run seed` to load seed/cafes.json.");
    return;
  }
  $("notice").innerHTML = "";
  $("empty").hidden = !rows.every((r) => r.status.status === "unknown");

  // Attach this student's walk time, picked item and estimate, then sort with them.
  const now = new Date();
  const full = rows.map((r) => {
    const walk = resolveWalkMinutes(r.cafe, pos, WALK_OPTS);
    const items = menu[r.cafe.id] || [];
    const item = chosenItem(r.cafe.id, items);
    const est = estimateFor({ status: r.status, cafe: r.cafe, item, settings, model, now });
    return { ...r, walk, walkMin: walk.min, items, item, est };
  });
  cardsEl.innerHTML = sortForDashboard(full).map(cardHtml).join("");
  $("est-note").textContent = model
    ? `Estimates come from an ML model trained on ${model.meta.n_rows} real answers (MAE ${model.meta.mae_model} min vs formula ${model.meta.mae_baseline} min).`
    : "";
}

// Item picker: remember the choice per cafe (shared with "Will I make it?").
cardsEl.addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-item-for]");
  if (!sel) return;
  setItemChoice(sel.dataset.itemFor, sel.value || null);
  sel.blur();
  render();
});
cardsEl.addEventListener("focusout", () => setTimeout(() => pendingRender && render(), 0));

// ---------- location toggle ----------
const locBtn = $("loc-toggle");
const locStatus = $("loc-status");

function renderLocation(state) {
  locState = state;
  const on = state.status !== "off" && state.status !== "denied";
  locBtn.setAttribute("aria-pressed", String(on));
  locBtn.textContent = on ? "📍 Walk times from your location" : "📍 Use my location for walk times";
  const acc = state.pos ? Math.round(state.pos.accuracy) : null;
  locStatus.textContent = {
    off: "",
    locating: "Finding you…",
    on: `±${acc} m · tap to turn off`,
    inaccurate: `GPS too rough (±${acc} m) — using standard walk times`,
    denied: "Location blocked — using standard walk times",
    unavailable: "No GPS fix yet — using standard walk times",
  }[state.status];
  render();
}

const tracker = createLocationTracker(renderLocation);
locBtn.addEventListener("click", () => {
  const s = tracker.getState().status;
  if (s === "off" || s === "denied") tracker.enable();
  else tracker.disable();
});

// ---------- feedback follow-up + model ----------
mountFeedbackPrompt($("feedback"));
loadModel().then((m) => {
  model = m; // null unless a trained model that beat the formula was published
  render();
});

// ---------- live data ----------
function fail(err) {
  console.error(err);
  $("loading").hidden = true;
  liveEl.textContent = "offline";
  liveEl.classList.add("off");
  // Keep last-rendered cards if we have them; otherwise explain.
  if (!cardsEl.children.length) {
    const [title, body] = describeError(err);
    showNotice($("notice"), title, body);
  }
}

watchLiveStatuses((data) => {
  latest = data;
  render();
}, fail).catch(fail);
