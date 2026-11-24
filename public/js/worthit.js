// worthit.js — "Will I make it?" checker.
//
// For every cafe:  total = walk + estimated wait + eating buffer
//   Go    : total <= available - 3
//   Risky : available - 3 < total <= available
//   Skip  : total > available
// The maths lives in status-engine.js (evaluateTrip / rankTrips) so it's tested.
// This file only gathers inputs, listens to live statuses, and renders.
// TODO(phase-2-items): suggest faster menu items using per-item prep times.

import { registerServiceWorker } from "./firebase-init.js";
import { watchLiveStatuses } from "./data.js";
import { evaluateTrip, rankTrips } from "./status-engine.js";
import { resolveWalkMinutes } from "./geo.js";
import { createLocationTracker, usablePosition } from "./location.js";
import {
  REFERENCE_POINT,
  EATING_BUFFER_MIN,
  SAFETY_MARGIN_MIN,
  STATUS_WAIT_MIN,
  WALK_SPEED_M_PER_MIN,
  WALK_DETOUR_FACTOR,
  MAX_LOCATION_ACCURACY_M,
} from "./config.js";
import { esc, levelLabel, showNotice, describeError } from "./ui.js";

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const WALK_OPTS = { speedMPerMin: WALK_SPEED_M_PER_MIN, detourFactor: WALK_DETOUR_FACTOR, maxAccuracyM: MAX_LOCATION_ACCURACY_M };
const state = {
  rows: null,      // [{cafe, status}] from the live listener
  available: null, // minutes
  loc: null,       // location tracker state (shared opt-in with the dashboard)
};

$("ref-label").textContent = REFERENCE_POINT.label;
$("assumptions").innerHTML =
  `Assumptions: eating takes ${EATING_BUFFER_MIN} min; "Go" needs ${SAFETY_MARGIN_MIN} min spare. ` +
  `Waits are <strong>estimates</strong> from the crowd level (No wait ≈ ${STATUS_WAIT_MIN.green}, Short line ≈ ${STATUS_WAIT_MIN.yellow}, Packed ≈ ${STATUS_WAIT_MIN.red} min), not measurements. ` +
  `If a cafe has no recent report we assume it's packed. Walk times from the reference point are placeholders until measured.`;

// ---------- inputs ----------
const minutesInput = $("minutes");
const chips = [...document.querySelectorAll(".chip")];

function setAvailable(value) {
  const n = Number(value);
  state.available = Number.isFinite(n) && n > 0 ? n : null;
  chips.forEach((c) => c.setAttribute("aria-pressed", String(Number(c.dataset.min) === state.available)));
  render();
}
minutesInput.addEventListener("input", () => setAvailable(minutesInput.value));
chips.forEach((chip) =>
  chip.addEventListener("click", () => {
    minutesInput.value = chip.dataset.min;
    setAvailable(chip.dataset.min);
  })
);
$("walkback").addEventListener("change", render);

// "Starting from" uses the same remembered opt-in as the dashboard's location
// toggle, and the position refreshes on open / return to foreground.
function renderLocation(loc) {
  state.loc = loc;
  const here = loc.status !== "off" && loc.status !== "denied";
  document.querySelector(`input[name="start"][value="${here ? "here" : "ref"}"]`).checked = true;
  const note = $("loc-note");
  const acc = loc.pos ? Math.round(loc.pos.accuracy) : null;
  note.hidden = loc.status === "off";
  note.textContent = {
    off: "",
    locating: "Getting your location…",
    on: `Walk times estimated from your location (±${acc} m): straight-line × ${WALK_DETOUR_FACTOR} at ${WALK_SPEED_M_PER_MIN} m/min.`,
    inaccurate: `GPS too rough (±${acc} m) — using reference-point walk times.`,
    denied: "Location is blocked for this site — using the reference point.",
    unavailable: "Couldn't get your location yet — using reference-point walk times.",
  }[loc.status];
  render();
}
const tracker = createLocationTracker(renderLocation);

for (const radio of document.querySelectorAll('input[name="start"]')) {
  radio.addEventListener("change", () => (radio.value === "here" ? tracker.enable() : tracker.disable()));
}

/** Walk time to a cafe from the chosen start point: { min, source }. */
function walkTo(cafe) {
  return resolveWalkMinutes(cafe, state.loc ? usablePosition(state.loc) : null, WALK_OPTS);
}

// ---------- render ----------
const VERDICT_TEXT = { go: "Go", risky: "Risky", skip: "Skip" };

function tripHtml({ cafe, status, result, walkSource }) {
  const walkLabel =
    ($("walkback").checked ? "walk there + back" : "walk") + (walkSource === "you" ? " (from you, est.)" : "");
  const waitLabel = result.assumedWorstCase ? "wait (no report — assumed packed)" : `wait (est., ${levelLabel(status.status).toLowerCase()})`;
  return `
    <li class="card trip">
      <div class="card-head">
        <span class="dot ${esc(status.status)}" aria-hidden="true"></span>
        <span class="card-name">${esc(cafe.name)}</span>
      </div>
      <span class="verdict ${result.verdict}">${VERDICT_TEXT[result.verdict]}</span>
      <div class="maths">
        ${result.walkMin} ${walkLabel} + ${result.waitMin} ${esc(waitLabel)} + ${result.eatMin} eat
        = <strong>${result.totalMin} min</strong> of ${state.available}
      </div>
    </li>`;
}

function verdictHtml({ best, grabAndGo }) {
  if (best) {
    const spare = best.result.slackMin;
    return `<div class="verdict-box go"><h2>✅ Go to ${esc(best.cafe.name)}</h2>
      <p>About ${best.result.totalMin} min in total — ${spare} min to spare.</p></div>`;
  }
  if (grabAndGo) {
    return `<div class="verdict-box grab"><h2>⚠ No cafe fits comfortably</h2>
      <p>Closest option: <strong>${esc(grabAndGo.cafe.name)}</strong> (~${grabAndGo.result.totalMin} min). Grab-and-go only — eat on the way back.</p></div>`;
  }
  return "";
}

function render() {
  if (!state.rows) return;
  if (state.available == null) {
    $("verdict").innerHTML = "";
    $("trips").innerHTML = "";
    showNotice($("notice"), "How long do you have?", "Enter your minutes or tap a quick pick above.");
    return;
  }
  $("notice").innerHTML = "";

  const trips = state.rows.map(({ cafe, status }) => {
    const walk = walkTo(cafe);
    return {
      cafe,
      status,
      walkSource: walk.source,
      result: evaluateTrip({
        availableMin: state.available,
        walkMin: walk.min,
        status: status.status,
        opts: { walkBack: $("walkback").checked },
      }),
    };
  });
  const { ranked, best, grabAndGo } = rankTrips(trips);
  $("verdict").innerHTML = verdictHtml({ best, grabAndGo });
  $("trips").innerHTML = ranked.map(tripHtml).join("");
}

function fail(err) {
  console.error(err);
  $("loading").hidden = true;
  if (!state.rows) {
    const [title, body] = describeError(err);
    showNotice($("notice"), title, body);
  }
}

$("loading").hidden = false;
watchLiveStatuses(({ rows }) => {
  $("loading").hidden = true;
  state.rows = rows;
  render();
}, fail).catch(fail);
