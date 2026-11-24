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
import { haversineMeters, estimateWalkMinutes } from "./geo.js";
import {
  REFERENCE_POINT,
  EATING_BUFFER_MIN,
  SAFETY_MARGIN_MIN,
  STATUS_WAIT_MIN,
  WALK_SPEED_M_PER_MIN,
  WALK_DETOUR_FACTOR,
} from "./config.js";
import { esc, levelLabel, showNotice, describeError } from "./ui.js";

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const state = {
  rows: null,      // [{cafe, status}] from the live listener
  available: null, // minutes
  here: null,      // {lat, lng} if "my current location" chosen
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

for (const radio of document.querySelectorAll('input[name="start"]')) {
  radio.addEventListener("change", () => (radio.value === "here" ? useMyLocation() : useReference()));
}

function useReference() {
  state.here = null;
  $("loc-note").hidden = true;
  render();
}

function useMyLocation() {
  const note = $("loc-note");
  note.hidden = false;
  note.textContent = "Getting your location…";
  if (!("geolocation" in navigator)) {
    note.textContent = "Location isn't available in this browser — using the reference point.";
    document.querySelector('input[value="ref"]').checked = true;
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      note.textContent = `Walk times estimated from your location (±${Math.round(pos.coords.accuracy)} m), straight-line × ${WALK_DETOUR_FACTOR} at ${WALK_SPEED_M_PER_MIN} m/min.`;
      render();
    },
    () => {
      note.textContent = "Couldn't get your location — using the reference point.";
      document.querySelector('input[value="ref"]').checked = true;
      state.here = null;
      render();
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

/** Walk minutes to a cafe from the chosen start point. */
function walkMinutesTo(cafe) {
  if (!state.here) return cafe.walk_min; // measured (placeholder) value from the reference point
  return estimateWalkMinutes(
    haversineMeters(state.here.lat, state.here.lng, cafe.lat, cafe.lng),
    WALK_SPEED_M_PER_MIN,
    WALK_DETOUR_FACTOR
  );
}

// ---------- render ----------
const VERDICT_TEXT = { go: "Go", risky: "Risky", skip: "Skip" };

function tripHtml({ cafe, status, result }) {
  const walkLabel = $("walkback").checked ? "walk there + back" : "walk";
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

  const trips = state.rows.map(({ cafe, status }) => ({
    cafe,
    status,
    result: evaluateTrip({
      availableMin: state.available,
      walkMin: walkMinutesTo(cafe),
      status: status.status,
      opts: { walkBack: $("walkback").checked },
    }),
  }));
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
