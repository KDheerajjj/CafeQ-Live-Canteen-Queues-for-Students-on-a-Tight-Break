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

/**
 * Compute one cafe's status from its reports.
 *
 * Rules (from the Phase-1 spec):
 *  1. Keep only valid reports from the last STATUS_WINDOW_MIN (15) minutes, newest first.
 *  2. 0 reports in the window -> "unknown", no confidence. (This also covers
 *     "newest report older than 15 min -> force unknown".)
 *  3. Otherwise status = the MODE (most common level) in the window.
 *     Tie-break: the tied level that was reported most recently wins, because
 *     a crowd changes over time and the latest observation is the best tiebreaker.
 *  4. Confidence = "high" if >= 2 reports within the last 10 minutes agree with
 *     the mode; otherwise "low".
 *  5. "updated N min ago" comes from the newest report.
 *
 * @param {Array<{level: string, created_at: any}>} reports  any order
 * @param {number} nowMs  current time (injected so tests are deterministic)
 * @returns {{status, confidence, waitMin, updatedMinAgo, reportCount, counts}}
 */
export function computeStatus(reports, nowMs, opts = {}) {
  const windowMin = opts.windowMin ?? STATUS_WINDOW_MIN;
  const confWindowMin = opts.confidenceWindowMin ?? CONFIDENCE_WINDOW_MIN;
  const confMin = opts.confidenceMinReports ?? CONFIDENCE_MIN_REPORTS;
  const waitMap = opts.waitMap ?? STATUS_WAIT_MIN;

  const windowStart = nowMs - windowMin * MIN_MS;
  const recent = (reports || [])
    .map((r) => ({ level: r.level, t: toMillis(r.created_at) }))
    .filter((r) => VALID_LEVELS.includes(r.level) && Number.isFinite(r.t))
    // Reports slightly "in the future" (client/server clock skew) count as now.
    .filter((r) => r.t >= windowStart)
    .sort((a, b) => b.t - a.t); // newest first

  const counts = { green: 0, yellow: 0, red: 0 };
  if (recent.length === 0) {
    return { status: "unknown", confidence: null, waitMin: waitMap.unknown ?? null, updatedMinAgo: null, reportCount: 0, counts };
  }

  // Tally levels, remembering when each level was last seen (for tie-breaks).
  const lastSeen = {};
  for (const r of recent) {
    counts[r.level] += 1;
    if (lastSeen[r.level] === undefined) lastSeen[r.level] = r.t; // first hit = newest
  }

  // Mode with recency tie-break.
  let status = null;
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

  const confStart = nowMs - confWindowMin * MIN_MS;
  const agreeing = recent.filter((r) => r.t >= confStart && r.level === status).length;
  const confidence = agreeing >= confMin ? "high" : "low";

  const updatedMinAgo = Math.max(0, Math.floor((nowMs - recent[0].t) / MIN_MS));

  return {
    status,
    confidence,
    waitMin: waitMap[status] ?? null, // ESTIMATE from the placeholder map
    updatedMinAgo,
    reportCount: recent.length,
    counts,
  };
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
 * Each row may carry `walkMin` (e.g. from the student's own location); if it
 * doesn't, the cafe's reference-point walk_min is used.
 * @param {Array<{cafe, status, walkMin?}>} rows
 */
export function sortForDashboard(rows) {
  const bucket = (s) => (s.status === "unknown" ? 2 : s.status === "red" ? 1 : 0);
  const walk = (row) => row.walkMin ?? row.cafe.walk_min ?? 0;
  return [...rows].sort((a, b) => {
    const d = bucket(a.status) - bucket(b.status);
    if (d !== 0) return d;
    const ta = walk(a) + (a.status.waitMin ?? 0);
    const tb = walk(b) + (b.status.waitMin ?? 0);
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
 * Note on round trips: the spec's formula counts the walk ONCE (to the cafe).
 * Pass `walkBack: true` to also count the walk back to class.
 *
 * When the cafe's status is unknown there is no wait estimate. Rather than
 * guess optimistically, we assume the WORST known case (red) and flag it, so
 * the verdict errs on the side of getting the student back on time.
 */
export function evaluateTrip({ availableMin, walkMin, status, opts = {} }) {
  const waitMap = opts.waitMap ?? STATUS_WAIT_MIN;
  const eatMin = opts.eatingBufferMin ?? EATING_BUFFER_MIN;
  const margin = opts.safetyMarginMin ?? SAFETY_MARGIN_MIN;
  const walkLegs = opts.walkBack ? 2 : 1;

  const assumedWorstCase = status === "unknown" || waitMap[status] == null;
  const waitMin = assumedWorstCase ? waitMap.red : waitMap[status];
  const walkTotal = walkMin * walkLegs;
  const totalMin = walkTotal + waitMin + eatMin;

  let verdict;
  if (totalMin <= availableMin - margin) verdict = "go";
  else if (totalMin <= availableMin) verdict = "risky";
  else verdict = "skip";

  return { verdict, totalMin, walkMin: walkTotal, waitMin, eatMin, assumedWorstCase, slackMin: availableMin - totalMin };
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
