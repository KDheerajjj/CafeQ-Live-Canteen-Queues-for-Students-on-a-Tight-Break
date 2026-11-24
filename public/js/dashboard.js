// dashboard.js — student view: live cards for every cafe.
//
// Data flow:  Firestore (cafes + last-15-min reports, realtime)
//             -> data.js -> status-engine.js (computeStatus per cafe)
//             + location.js (optional: the student's own position -> walk times)
//             -> sortForDashboard -> render cards.

import { registerServiceWorker } from "./firebase-init.js";
import { watchLiveStatuses } from "./data.js";
import { sortForDashboard } from "./status-engine.js";
import { resolveWalkMinutes } from "./geo.js";
import { createLocationTracker, usablePosition } from "./location.js";
import { WALK_SPEED_M_PER_MIN, WALK_DETOUR_FACTOR, MAX_LOCATION_ACCURACY_M } from "./config.js";
import { esc, levelLabel, minutesAgo, waitText, showNotice, describeError } from "./ui.js";

registerServiceWorker();

// TODO(phase-2-notify): "remind me before my break" push notifications.
//   Requirements and design: docs/push-notifications.md

const $ = (id) => document.getElementById(id);
const cardsEl = $("cards");
const liveEl = $("live");
const WALK_OPTS = { speedMPerMin: WALK_SPEED_M_PER_MIN, detourFactor: WALK_DETOUR_FACTOR, maxAccuracyM: MAX_LOCATION_ACCURACY_M };

let latest = null;   // last { cafes, rows } from Firestore
let locState = null; // last state from the location tracker

function confidenceBadge(status) {
  if (status.status === "unknown") return `<span class="badge need">Needs a report</span>`;
  if (status.confidence === "high") return `<span class="badge high">High confidence</span>`;
  return `<span class="badge low">Low confidence</span>`;
}

function walkText(walk) {
  return walk.source === "you" ? `🚶 ~${walk.min} min walk from you (est.)` : `🚶 ${walk.min} min walk`;
}

function cardHtml({ cafe, status, walk }) {
  const known = status.status !== "unknown";
  const reports = known ? `${status.reportCount} report${status.reportCount === 1 ? "" : "s"}` : "";
  return `
    <li class="card ${known ? "" : "is-unknown"}">
      <div class="card-head">
        <span class="dot ${esc(status.status)}" aria-hidden="true"></span>
        <span class="card-name">${esc(cafe.name)}</span>
        <span class="card-status">${esc(levelLabel(status.status))}</span>
      </div>
      <div class="card-meta">
        <span>${esc(waitText(status.waitMin))}</span>
        <span>${esc(walkText(walk))}</span>
        ${known ? `<span>updated ${esc(minutesAgo(status.updatedMinAgo))} · ${reports}</span>` : `<span>no report in the last 15 min</span>`}
      </div>
      <div class="card-foot">
        ${confidenceBadge(status)}
        <a class="card-link" href="./report.html?cafe=${encodeURIComponent(cafe.id)}">I'm here — report</a>
      </div>
    </li>`;
}

function render() {
  if (!latest) return;
  const { cafes, rows } = latest;
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

  // Attach this student's walk time to each row, then sort with it.
  const withWalk = rows.map((r) => {
    const walk = resolveWalkMinutes(r.cafe, pos, WALK_OPTS);
    return { ...r, walk, walkMin: walk.min };
  });
  cardsEl.innerHTML = sortForDashboard(withWalk).map(cardHtml).join("");
}

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
