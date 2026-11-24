// status-engine.js — turn raw crowd reports into a status the UI can show.
//
// Pure functions only (no DOM, no Firebase), shared by the dashboard, the
// report page, and the worth-it checker, and unit-tested in Node (tests/).
//
// Nothing is stored: the current status is always recomputed from the recent
// reports at read time, so a stale status can never "stick".

import {
  STATUS_WINDOW_MIN,
  CONFIDENCE_WINDOW_MIN,
  CONFIDENCE_MIN_REPORTS,
  STATUS_WAIT_MIN,
  EATING_BUFFER_MIN,
  SAFETY_MARGIN_MIN,
  LEVEL_THRESHOLDS,
  OUTLIER_COUNT_CAP,
  PREP_BUFFER_MIN,
  DEFAULT_SERVICE_SEC_PER_PERSON,
  QUEUE_COUNT_MAX,
  CONGESTION_FACTOR,
} from "./config.js";

const MIN_MS = 60 * 1000;
const VALID_LEVELS = ["green", "yellow", "red"];

/** Normalise a timestamp (Date, Firestore Timestamp, or ms) to epoch ms. */
export function toMillis(t) {
  if (t == null) return NaN;
  if (typeof t === "number") return t;
  if (t instanceof Date) return t.getTime();
  if (typeof t.toMillis === "function") return t.toMillis(); // Firestore Timestamp
  return NaN;
}

// ---------------------------------------------------------------------------
// Queue counts
// ---------------------------------------------------------------------------

/** Is this a valid stored queue count (integer 0..QUEUE_COUNT_MAX)? */
export function isValidCount(n) {
  return Number.isInteger(n) && n >= 0 && n <= QUEUE_COUNT_MAX;
}

/**
 * Colour for a queue length. Same thresholds as firestore.rules:
 *   count <= 2 -> green,  3..6 -> yellow,  >= 7 -> red   (by default).
 * Works for fractional medians too (e.g. 2.5 -> yellow).
 */
export function levelForCount(count, t = LEVEL_THRESHOLDS) {
  if (count <= t.greenMax) return "green";
  if (count <= t.yellowMax) return "yellow";
  return "red";
}

/** Median of a non-empty list of numbers (average of the middle two if even). */
export function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Minutes spent IN THE LINE (before your order is made). ESTIMATE built on a
 * per-cafe service-rate ASSUMPTION:
 *   queue_wait = queueCount × secondsPerPerson / 60,  × congestion factor when red
 * Left unrounded so it can be combined with an item's prep time first.
 */
export function queueWaitMinutes(queueCount, secPerPerson, { congested = false, congestionFactor = CONGESTION_FACTOR } = {}) {
  const base = (queueCount * secPerPerson) / 60;
  return congested ? base * congestionFactor : base;
}

/**
 * Generic wait (no item picked) = round(queue wait + prep buffer).
 * Pass congestionFactor > 1 together with congested=true for a red cafe.
 */
export function waitFromCount(queueCount, secPerPerson, prepBufferMin = PREP_BUFFER_MIN, congestion = {}) {
  return Math.round(queueWaitMinutes(queueCount, secPerPerson, congestion) + prepBufferMin);
}

// ---------------------------------------------------------------------------
// Per-cafe status
// ---------------------------------------------------------------------------

/**
 * Compute one cafe's status from its reports.
 *
 *  All the numbers below (15 min, 50, thresholds, buffers, congestion factor)
 *  are LIVE admin settings (settings/global); config.js only holds the defaults.
 *
 *  1. Keep reports from the last stale_min (15) minutes, newest first.
 *     Drop outliers: any single queue_count > outlier_cap (50) is ignored here.
 *  2. Nothing left -> "unknown", no confidence. (Covers "newest report older
 *     than 15 min -> force unknown".)
 *  3. If any report carries a queue_count (v2):
 *       queueCount = MEDIAN of the counts  (robust: one silly entry can't move it)
 *       status     = levelForCount(median)
 *       queueWaitMin = median × cafe's service_sec_per_person / 60
 *                      × congestion_factor (1.2) if the status is red
 *       waitMin    = round(queueWaitMin + prep buffer)   (no item picked)
 *     Otherwise (only old colour-only reports):
 *       status     = MODE of the colours (tie -> most recently reported colour)
 *       waitMin    = STATUS_WAIT_MIN fallback map
 *  4. Confidence = "high" if >= 2 reports in the last 10 minutes have the same
 *     colour as the status (a count report's colour is derived from its count),
 *     otherwise "low".
 *  5. "updated N min ago" comes from the newest kept report.
 *
 * @param {Array<{level?: string, queue_count?: number, created_at: any}>} reports  any order
 * @param {number} nowMs  current time (injected so tests are deterministic)
 * @param {object} [opts] built by settings.engineOpts(settings, cafe):
 *        { windowMin, thresholds, outlierCap, prepBufferMin, congestionFactor, serviceSecPerPerson }
 */
export function computeStatus(reports, nowMs, opts = {}) {
  const windowMin = opts.windowMin ?? STATUS_WINDOW_MIN;
  const confWindowMin = opts.confidenceWindowMin ?? CONFIDENCE_WINDOW_MIN;
  const confMin = opts.confidenceMinReports ?? CONFIDENCE_MIN_REPORTS;
  const waitMap = opts.waitMap ?? STATUS_WAIT_MIN;
  const secPerPerson = opts.serviceSecPerPerson ?? DEFAULT_SERVICE_SEC_PER_PERSON;
  const outlierCap = opts.outlierCap ?? OUTLIER_COUNT_CAP;
  const thresholds = opts.thresholds ?? LEVEL_THRESHOLDS;
  const prepBufferMin = opts.prepBufferMin ?? PREP_BUFFER_MIN;
  const congestionFactor = opts.congestionFactor ?? CONGESTION_FACTOR;

  const windowStart = nowMs - windowMin * MIN_MS;
  let ignored = 0;
  const recent = [];
  for (const r of reports || []) {
    const t = toMillis(r.created_at);
    if (!Number.isFinite(t) || t < windowStart) continue;
    const count = isValidCount(r.queue_count) ? r.queue_count : null;
    if (count !== null && count > outlierCap) {
      ignored += 1; // stored in Firestore, but not trusted for aggregation
      continue;
    }
    // A count report's colour is re-derived from its count; old reports keep their colour.
    const level = count !== null ? levelForCount(count, thresholds) : r.level;
    if (!VALID_LEVELS.includes(level)) continue;
    recent.push({ t, level, count });
  }
  recent.sort((a, b) => b.t - a.t); // newest first

  const counts = { green: 0, yellow: 0, red: 0 };
  if (recent.length === 0) {
    return {
      status: "unknown", confidence: null, waitMin: waitMap.unknown ?? null, queueWaitMin: null, waitSource: null,
      queueCount: null, updatedMinAgo: null, reportCount: 0, ignoredCount: ignored, counts,
    };
  }

  const lastSeen = {};
  for (const r of recent) {
    counts[r.level] += 1;
    if (lastSeen[r.level] === undefined) lastSeen[r.level] = r.t; // first hit = newest
  }

  const countValues = recent.filter((r) => r.count !== null).map((r) => r.count);
  let status, waitMin, waitSource, queueCount, queueWaitMin;

  if (countValues.length > 0) {
    // v2 path: median queue length drives everything.
    queueCount = median(countValues);
    status = levelForCount(queueCount, thresholds);
    queueWaitMin = queueWaitMinutes(queueCount, secPerPerson, { congested: status === "red", congestionFactor });
    waitMin = Math.round(queueWaitMin + prepBufferMin);
    waitSource = "count";
  } else {
    // Backward-compatible path: colour-only reports. Mode with recency tie-break.
    status = null;
    for (const level of VALID_LEVELS) {
      if (counts[level] === 0) continue;
      if (
        status === null ||
        counts[level] > counts[status] ||
        (counts[level] === counts[status] && lastSeen[level] > lastSeen[status])
      ) {
        status = level;
      }
    }
    queueCount = null;
    waitMin = waitMap[status] ?? null;
    queueWaitMin = waitMin; // the rough fallback is treated as time in the line
    waitSource = "colour";
  }

  const confStart = nowMs - confWindowMin * MIN_MS;
  const agreeing = recent.filter((r) => r.t >= confStart && r.level === status).length;
  const confidence = agreeing >= confMin ? "high" : "low";

  return {
    status,
    confidence,
    waitMin,      // ESTIMATE (count × service-rate assumption, or the colour fallback map)
    queueWaitMin, // unrounded minutes in the line, before any item prep
    waitSource,   // "count" | "colour"
    queueCount,   // median count, or null when only colour reports exist
    updatedMinAgo: Math.max(0, Math.floor((nowMs - recent[0].t) / MIN_MS)),
    reportCount: recent.length,
    ignoredCount: ignored,
    counts,
  };
}

/**
 * Time-at-the-cafe estimate for one student: queue + making THEIR order.
 *
 *   Baseline FORMULA (what ships):  est_total = queueWaitMin + item.prep_min
 *     (no item picked -> + prep_buffer_min instead; queueWaitMin already
 *      includes the congestion factor when the cafe is red)
 *   Optional MODEL: if `model` is given (public/model.json, trained offline and
 *     only published when it beat this formula), its prediction is used instead,
 *     but only for count-based statuses (the model was trained on queue counts).
 *
 * Returns { min, method } where method is "formula" | "model" | "fallback"
 * (old colour-only reports) | null (unknown — no estimate).
 *
 * @param {{status, cafe, item?, settings, model?, now?: Date}} args
 */
export function estimateFor({ status, cafe, item = null, settings, model = null, now = new Date() }) {
  if (!status || status.status === "unknown" || status.waitMin == null) return { min: null, method: null };
  const prepMin = item ? item.prep_min : settings.prep_buffer_min;

  if (model && status.waitSource === "count") {
    const predicted = model.predict({
      queue_count: status.queueCount,
      hour: now.getHours(),
      day_of_week: (now.getDay() + 6) % 7, // Monday = 0, like Python's weekday()
      item_prep_min: prepMin,
      cafe_type: cafe?.type,
      service_sec_per_person: cafe?.service_sec_per_person,
    });
    if (Number.isFinite(predicted)) return { min: Math.max(1, Math.round(predicted)), method: "model" };
  }
  if (status.waitSource === "count") {
    return { min: Math.round(status.queueWaitMin + prepMin), method: "formula" };
  }
  // Colour-only fallback: rough line wait (+ the item's prep if one is picked).
  return { min: Math.round(status.waitMin + (item ? item.prep_min : 0)), method: "fallback" };
}

/** Group a flat list of report objects by cafe_id. */
export function groupByCafe(reports) {
  const out = {};
  for (const r of reports) (out[r.cafe_id] ||= []).push(r);
  return out;
}

/**
 * Dashboard ordering: "soonest usable first".
 * Known, non-red cafes come first, ordered by walk + estimated wait (ascending);
 * then red (packed) cafes; unknown cafes last. Ties break by name.
 * Each row may carry `walkMin` (e.g. from the student's own location) and
 * `est` (the item-aware estimate from estimateFor); otherwise the cafe's
 * reference-point walk_min and the generic status wait are used.
 * @param {Array<{cafe, status, walkMin?, est?}>} rows
 */
export function sortForDashboard(rows) {
  const bucket = (s) => (s.status === "unknown" ? 2 : s.status === "red" ? 1 : 0);
  const walk = (row) => row.walkMin ?? row.cafe.walk_min ?? 0;
  return [...rows].sort((a, b) => {
    const d = bucket(a.status) - bucket(b.status);
    if (d !== 0) return d;
    const ta = walk(a) + (a.est?.min ?? a.status.waitMin ?? 0);
    const tb = walk(b) + (b.est?.min ?? b.status.waitMin ?? 0);
    if (ta !== tb) return ta - tb;
    return String(a.cafe.name).localeCompare(String(b.cafe.name));
  });
}

/**
 * "Will I make it?" maths for one cafe.
 *   total = walk + estimated wait + eating buffer
 *   Go    : total <= available - margin   (margin = 3 min)
 *   Risky : available - margin < total <= available
 *   Skip  : total > available
 *
 * `waitMin` is the cafe's current estimate from computeStatus (count-based when
 * available). If it's missing — status unknown — we assume the WORST known case
 * (the "red" fallback wait) and flag it, so the verdict errs on the side of
 * getting the student back on time.
 *
 * Note on round trips: the spec's formula counts the walk ONCE (to the cafe).
 * Pass `walkBack: true` to also count the walk back to class.
 */
export function evaluateTrip({ availableMin, walkMin, status, waitMin, opts = {} }) {
  const waitMap = opts.waitMap ?? STATUS_WAIT_MIN;
  const eatMin = opts.eatingBufferMin ?? EATING_BUFFER_MIN;
  const margin = opts.safetyMarginMin ?? SAFETY_MARGIN_MIN;
  const walkLegs = opts.walkBack ? 2 : 1;

  // Prefer the explicit estimate; fall back to the colour map; unknown -> worst case.
  const known = status !== "unknown";
  const estimate = waitMin ?? (known ? waitMap[status] : null);
  const assumedWorstCase = estimate == null;
  const wait = assumedWorstCase ? waitMap.red : estimate;
  const walkTotal = walkMin * walkLegs;
  const totalMin = walkTotal + wait + eatMin;

  let verdict;
  if (totalMin <= availableMin - margin) verdict = "go";
  else if (totalMin <= availableMin) verdict = "risky";
  else verdict = "skip";

  return { verdict, totalMin, walkMin: walkTotal, waitMin: wait, eatMin, assumedWorstCase, slackMin: availableMin - totalMin };
}

/**
 * Rank all cafes for the worth-it page.
 * Returns { ranked, best, grabAndGo }:
 *  - ranked: Go first, then Risky, then Skip; inside each, lowest total first.
 *  - best: the top "Go" cafe, or null.
 *  - grabAndGo: when there is no Go cafe, the lowest-total cafe to suggest
 *    as "grab-and-go only".
 */
export function rankTrips(trips) {
  const order = { go: 0, risky: 1, skip: 2 };
  const ranked = [...trips].sort(
    (a, b) => order[a.result.verdict] - order[b.result.verdict] || a.result.totalMin - b.result.totalMin
  );
  const best = ranked.find((t) => t.result.verdict === "go") ?? null;
  const grabAndGo = best
    ? null
    : [...trips].sort((a, b) => a.result.totalMin - b.result.totalMin)[0] ?? null;
  return { ranked, best, grabAndGo };
}
