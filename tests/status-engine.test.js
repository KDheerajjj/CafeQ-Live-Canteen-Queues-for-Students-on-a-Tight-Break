import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStatus, sortForDashboard, evaluateTrip, rankTrips } from "../public/js/status-engine.js";

const NOW = Date.UTC(2026, 10, 24, 7, 0, 0);
const ago = (min) => NOW - min * 60 * 1000;
const r = (level, minAgo) => ({ level, created_at: ago(minAgo) });

test("no reports -> unknown, no confidence", () => {
  const s = computeStatus([], NOW);
  assert.equal(s.status, "unknown");
  assert.equal(s.confidence, null);
  assert.equal(s.waitMin, null);
  assert.equal(s.updatedMinAgo, null);
});

test("newest report older than 15 min -> forced unknown", () => {
  const s = computeStatus([r("red", 16), r("red", 20)], NOW);
  assert.equal(s.status, "unknown");
});

test("single report -> that level, low confidence", () => {
  const s = computeStatus([r("yellow", 2)], NOW);
  assert.equal(s.status, "yellow");
  assert.equal(s.confidence, "low");
  assert.equal(s.waitMin, 6);
  assert.equal(s.updatedMinAgo, 2);
});

test("mode wins; two agreeing in last 10 min -> high confidence", () => {
  const s = computeStatus([r("red", 1), r("red", 4), r("green", 0)], NOW);
  assert.equal(s.status, "red");
  assert.equal(s.confidence, "high");
  assert.equal(s.updatedMinAgo, 0);
  assert.equal(s.reportCount, 3);
});

test("agreeing reports outside the 10-min confidence window stay low", () => {
  const s = computeStatus([r("green", 3), r("green", 12)], NOW);
  assert.equal(s.status, "green");
  assert.equal(s.confidence, "low");
});

test("tie -> most recently reported level wins", () => {
  const s = computeStatus([r("green", 8), r("red", 6), r("green", 5), r("red", 1)], NOW);
  assert.equal(s.status, "red");
});

test("invalid levels and missing timestamps are ignored", () => {
  const s = computeStatus([{ level: "purple", created_at: ago(1) }, { level: "red", created_at: null }], NOW);
  assert.equal(s.status, "unknown");
});

test("accepts Date and Firestore-like Timestamp objects", () => {
  const s = computeStatus(
    [{ level: "green", created_at: new Date(ago(1)) }, { level: "green", created_at: { toMillis: () => ago(2) } }],
    NOW
  );
  assert.equal(s.status, "green");
  assert.equal(s.confidence, "high");
});

test("dashboard sort: usable by total time, then red, then unknown", () => {
  const row = (name, walk, status, waitMin) => ({ cafe: { name, walk_min: walk }, status: { status, waitMin } });
  const sorted = sortForDashboard([
    row("U", 1, "unknown", null),
    row("R", 1, "red", 12),
    row("Y", 2, "yellow", 6), // 8
    row("G", 7, "green", 2),  // 9
  ]);
  assert.deepEqual(sorted.map((x) => x.cafe.name), ["Y", "G", "R", "U"]);
});

test("worth-it verdict boundaries (margin 3, eat 5)", () => {
  // walk 4 + green 2 + eat 5 = 11
  assert.equal(evaluateTrip({ availableMin: 14, walkMin: 4, status: "green" }).verdict, "go");    // 11 <= 11
  assert.equal(evaluateTrip({ availableMin: 13, walkMin: 4, status: "green" }).verdict, "risky"); // 10 < 11 <= 13
  assert.equal(evaluateTrip({ availableMin: 11, walkMin: 4, status: "green" }).verdict, "risky"); // 11 <= 11
  assert.equal(evaluateTrip({ availableMin: 10, walkMin: 4, status: "green" }).verdict, "skip");
});

test("worth-it: unknown status assumes worst case (red) and says so", () => {
  const t = evaluateTrip({ availableMin: 30, walkMin: 3, status: "unknown" });
  assert.equal(t.assumedWorstCase, true);
  assert.equal(t.waitMin, 12);
  assert.equal(t.totalMin, 20);
});

test("worth-it ranking: best Go first; no Go -> grab-and-go suggestion", () => {
  const mk = (id, walkMin, status, avail) => ({ id, result: evaluateTrip({ availableMin: avail, walkMin, status }) });
  const a = rankTrips([mk("slow", 7, "red", 20), mk("fast", 2, "green", 20)]);
  assert.equal(a.best.id, "fast");
  assert.equal(a.grabAndGo, null);

  const b = rankTrips([mk("x", 7, "red", 10), mk("y", 4, "yellow", 10)]);
  assert.equal(b.best, null);
  assert.equal(b.grabAndGo.id, "y");
});
