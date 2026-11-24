// v2: queue-count reports, median aggregation, per-cafe service speed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStatus, levelForCount, median, waitFromCount, evaluateTrip } from "../public/js/status-engine.js";
import { QUEUE_BUCKETS } from "../public/js/config.js";

const NOW = Date.UTC(2026, 10, 24, 7, 0, 0);
const ago = (min) => NOW - min * 60 * 1000;
const q = (count, minAgo) => ({ queue_count: count, level: levelForCount(count), created_at: ago(minAgo) });

test("count -> colour thresholds: <=2 green, 3-6 yellow, >=7 red", () => {
  assert.deepEqual([0, 2, 3, 6, 7, 100].map((n) => levelForCount(n)), ["green", "green", "yellow", "yellow", "red", "red"]);
  assert.equal(levelForCount(2.5), "yellow"); // fractional medians
});

test("bucket midpoints map to the expected colours", () => {
  assert.deepEqual(QUEUE_BUCKETS.map((b) => [b.id, b.count, levelForCount(b.count)]), [
    ["0-2", 1, "green"], ["3-5", 4, "yellow"], ["6-10", 8, "red"], ["10+", 12, "red"],
  ]);
});

test("median: odd, even, unsorted", () => {
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 4]), 4);
  assert.equal(median([1, 2, 3, 10]), 2.5);
});

test("wait = round(count × sec/person ÷ 60) + 1 min prep", () => {
  assert.equal(waitFromCount(4, 60), 5);  // canteen: 4 people × 60 s = 4 min + 1
  assert.equal(waitFromCount(4, 45), 4);  // cafe:    4 × 45 s = 3 min + 1
  assert.equal(waitFromCount(0, 45), 1);  // empty counter still takes a minute
});

test("same queue -> the cafe shows a shorter wait than the canteen (8 = red, x1.2 congestion)", () => {
  const reports = [q(8, 1), q(8, 3)];
  const canteen = computeStatus(reports, NOW, { serviceSecPerPerson: 60 });
  const cafe = computeStatus(reports, NOW, { serviceSecPerPerson: 45 });
  assert.equal(canteen.waitMin, 11); // 8x60/60 = 8, x1.2 = 9.6, +1 = 10.6 -> 11
  assert.equal(cafe.waitMin, 8);     // 8x45/60 = 6, x1.2 = 7.2, +1 = 8.2 -> 8
  assert.ok(cafe.waitMin < canteen.waitMin);
});

test("median drives status, queueCount and wait", () => {
  const s = computeStatus([q(2, 1), q(4, 2), q(5, 4)], NOW, { serviceSecPerPerson: 45 });
  assert.equal(s.queueCount, 4);
  assert.equal(s.status, "yellow");
  assert.equal(s.waitSource, "count");
  assert.equal(s.waitMin, 4); // round(4*45/60)=3 + 1
});

test("one troll typing 99 is ignored (cap 50), and doesn't move the median", () => {
  const s = computeStatus([q(1, 1), q(2, 2), q(99, 0)], NOW, { serviceSecPerPerson: 45 });
  assert.equal(s.ignoredCount, 1);
  assert.equal(s.reportCount, 2);
  assert.equal(s.queueCount, 1.5);
  assert.equal(s.status, "green");
});

test("a large but plausible count (<= 50) still counts", () => {
  const s = computeStatus([q(30, 1)], NOW, { serviceSecPerPerson: 60 });
  assert.equal(s.status, "red");
  assert.equal(s.waitMin, 37); // 30 x 1.2 congestion + 1
});

test("only outliers -> unknown", () => {
  assert.equal(computeStatus([q(80, 1)], NOW).status, "unknown");
});

test("backward compatible: colour-only reports still work with the fallback wait map", () => {
  const s = computeStatus([{ level: "yellow", created_at: ago(1) }, { level: "yellow", created_at: ago(2) }], NOW, {
    serviceSecPerPerson: 45,
  });
  assert.equal(s.status, "yellow");
  assert.equal(s.queueCount, null);
  assert.equal(s.waitSource, "colour");
  assert.equal(s.waitMin, 6);
  assert.equal(s.confidence, "high");
});

test("mixed window: counts win over old colour-only reports", () => {
  const s = computeStatus([{ level: "red", created_at: ago(2) }, q(1, 1)], NOW, { serviceSecPerPerson: 45 });
  assert.equal(s.status, "green");
  assert.equal(s.queueCount, 1);
  assert.equal(s.reportCount, 2);
});

test("confidence: two count reports in 10 min with the same colour -> high", () => {
  assert.equal(computeStatus([q(3, 1), q(5, 6)], NOW).confidence, "high");  // both yellow
  assert.equal(computeStatus([q(3, 1), q(8, 6)], NOW).confidence, "low");   // yellow + red
  assert.equal(computeStatus([q(3, 1), q(4, 12)], NOW).confidence, "low");  // 2nd outside 10 min
});

test("stale counts -> unknown", () => {
  assert.equal(computeStatus([q(4, 16)], NOW).status, "unknown");
});

test("worth-it uses the count-based wait when given", () => {
  const t = evaluateTrip({ availableMin: 20, walkMin: 3, status: "red", waitMin: 7 });
  assert.equal(t.waitMin, 7);
  assert.equal(t.totalMin, 15);
  assert.equal(t.verdict, "go");
  assert.equal(t.assumedWorstCase, false);
});
