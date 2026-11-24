// worthit.js — "Will I make it?" checker.
//
// For every cafe:  total = walk + time at the cafe + eating buffer
//   time at the cafe = status-engine.estimateFor(): queue wait (× congestion if
//   packed) + the prep time of the item the student picked (or a generic buffer),
//   or the ML model's prediction if a trained model was published.
//   Go    : total <= available - 3
//   Risky : available - 3 < total <= available
//   Skip  : total > available
// The maths lives in status-engine.js (estimateFor / evaluateTrip / rankTrips)
// so it's unit-tested. This file gathers inputs, listens to live data, renders,
// and records "I'm going" so feedback.js can ask how long it really took.

import { registerServiceWorker } from "./firebase-init.js";
import { watchLiveStatuses } from "./data.js";
import { evaluateTrip, rankTrips, estimateFor } from "./status-engine.js";
import { resolveWalkMinutes } from "./geo.js";
import { createLocationTracker, usablePosition } from "./location.js";
import { loadModel } from "./model.js";
import { mountFeedbackPrompt, rememberVisit } from "./feedback.js";
import {
  REFERENCE_POINT,
  SAFETY_MARGIN_MIN,
  STATUS_WAIT_MIN,
  WALK_SPEED_M_PER_MIN,
  WALK_DETOUR_FACTOR,
  MAX_LOCATION_ACCURACY_M,
} from "./config.js";
import { esc, queueText, statusLabelHtml, chosenItem, setItemChoice, itemSelectHtml, showNotice, describeError } from "./ui.js";

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const WALK_OPTS = { speedMPerMin: WALK_SPEED_M_PER_MIN, detourFactor: WALK_DETOUR_FACTOR, maxAccuracyM: MAX_LOCATION_ACCURACY_M };
const state = {
  live: null,      // { rows, settings, menu } from the live listener
  available: null, // minutes
  loc: null,       // location tracker state (shared opt-in with the dashboard)
  model: null,     // published ML model, or null (formula only)
  trips: [],       // last computed trips (for the "I'm going" button)
  going: null,     // cafe id the student said they're going to
};

$("ref-label").textContent = REFERENCE_POINT.label;

function renderAssumptions(s) {
  $("assumptions").innerHTML =
    `Assumptions (live settings): eating takes ${s.eating_buffer_min} min; "Go" needs ${SAFETY_MARGIN_MIN} min spare. ` +
    `Time at the cafe is an <strong>estimate</strong>: the median reported queue × that counter's assumed serving time per person ` +
    `(canteen ≈ 60 s, cafes ≈ 45 s — still to be calibrated), × ${s.congestion_factor} when it's packed, ` +
    `+ your item's prep time (or ${s.prep_buffer_min} min if you don't pick one). ` +
    `Cafes with only older colour reports use a rough fallback (≈ ${STATUS_WAIT_MIN.green} / ${STATUS_WAIT_MIN.yellow} / ${STATUS_WAIT_MIN.red} min). ` +
    `If a cafe has no recent report we assume it's packed. Walk times from the reference point are placeholders until measured.` +
    (state.model ? ` Estimates use the ML model trained on ${state.model.meta.n_rows} real answers.` : "");
}

// ---------- inputs ----------
const minutesInput = $("minutes");
const chips = [...document.querySelectorAll("#form .chip")];

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
const VERDICT_TEXT = { go: "✓ Go", risky: "⚠ Risky", skip: "✕ Skip" };

function tripHtml({ cafe, status, result, walkSource, est, item, items }) {
  const walkLabel =
    ($("walkback").checked ? "walk there + back" : "walk") + (walkSource === "you" ? " (from you, est.)" : "");
  const at = item ? ` for ${item.name}` : "";
  const how = est.method === "model" ? "ML model" : est.method === "fallback" ? "rough" : "est.";
  const waitLabel = result.assumedWorstCase
    ? "at cafe (no report — assumed packed)"
    : status.queueCount != null
      ? `at cafe${at} (${how}, ${queueText(status.queueCount)})`
      : `at cafe${at} (${how})`;
  const canGo = result.verdict !== "skip";
  const going = state.going === cafe.id;
  return `
    <li class="card trip">
      <div class="card-head">
        <span class="dot ${esc(status.status)}" aria-hidden="true"></span>
        <span class="card-name">${esc(cafe.name)}</span>
        ${statusLabelHtml(status.status)}
      </div>
      <span class="verdict ${result.verdict}">${VERDICT_TEXT[result.verdict]}</span>
      <div class="maths">
        ${result.walkMin} ${walkLabel} + ${result.waitMin} ${esc(waitLabel)} + ${result.eatMin} eat
        = <strong>${result.totalMin} min</strong> of ${state.available}
      </div>
      <div style="grid-column: 1 / -1">${itemSelectHtml(cafe, items, item)}</div>
      ${canGo ? `<div style="grid-column: 1 / -1" class="row-actions">
        <button class="going-btn" type="button" data-going="${esc(cafe.id)}"${going ? " disabled" : ""}>
          ${going ? "✓ Enjoy! We'll ask how long it took next time" : "I'm going here →"}</button></div>` : ""}
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
  if (!state.live) return;
  if (document.activeElement && document.activeElement.matches("select[data-item-for]")) return; // don't close an open picker
  const { rows, settings, menu } = state.live;
  renderAssumptions(settings);
  if (state.available == null) {
    $("verdict").innerHTML = "";
    $("trips").innerHTML = "";
    showNotice($("notice"), "How long do you have?", "Enter your minutes or tap a quick pick above.");
    return;
  }
  $("notice").innerHTML = "";

  const now = new Date();
  state.trips = rows.map(({ cafe, status }) => {
    const walk = walkTo(cafe);
    const items = menu[cafe.id] || [];
    const item = chosenItem(cafe.id, items);
    const est = estimateFor({ status, cafe, item, settings, model: state.model, now });
    return {
      cafe,
      status,
      items,
      item,
      est,
      walkSource: walk.source,
      result: evaluateTrip({
        availableMin: state.available,
        walkMin: walk.min,
        status: status.status,
        waitMin: est.min, // item-aware estimate (null when unknown -> worst case)
        opts: { walkBack: $("walkback").checked, eatingBufferMin: settings.eating_buffer_min },
      }),
    };
  });
  const { ranked, best, grabAndGo } = rankTrips(state.trips);
  $("verdict").innerHTML = verdictHtml({ best, grabAndGo });
  $("trips").innerHTML = ranked.map(tripHtml).join("");
}

$("trips").addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-item-for]");
  if (!sel) return;
  setItemChoice(sel.dataset.itemFor, sel.value || null);
  sel.blur();
  render();
});
$("trips").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-going]");
  if (!btn) return;
  const trip = state.trips.find((t) => t.cafe.id === btn.dataset.going);
  if (!trip) return;
  rememberVisit(trip); // feedback.js asks "how long did it take?" next time
  state.going = trip.cafe.id;
  render();
});

function fail(err) {
  console.error(err);
  $("loading").hidden = true;
  if (!state.live) {
    const [title, body] = describeError(err);
    showNotice($("notice"), title, body);
  }
}

mountFeedbackPrompt($("feedback"));
loadModel().then((m) => {
  state.model = m;
  render();
});

$("loading").hidden = false;
watchLiveStatuses((live) => {
  $("loading").hidden = true;
  state.live = live;
  render();
}, fail).catch(fail);
