// v3: live settings, item-aware estimates, the model walker, admin helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../public/js/config.js";
import { normaliseSettings, settingsErrors, engineOpts } from "../public/js/settings.js";
import { computeStatus, estimateFor, levelForCount, sortForDashboard } from "../public/js/status-engine.js";
import { predictForest, predictTree, isUsableModel, encodeFeatures } from "../public/js/model.js";
import { toCsv, cafeStats, parseOcrLines, cafeErrors, itemErrors, menuItemId, slugify } from "../public/js/admin-lib.js";

const NOW = Date.UTC(2026, 10, 24, 7, 0, 0);
const ago = (min) => NOW - min * 60 * 1000;
const q = (count, minAgo) => ({ queue_count: count, created_at: ago(minAgo) });
const S = normaliseSettings(null);
const CAFE = { id: "cafe-a", type: "cafe", service_sec_per_person: 45 };

// ---------- settings ----------
test("missing settings doc -> defaults", () => {
  assert.deepEqual(normaliseSettings(null), { ...DEFAULT_SETTINGS });
});

test("valid fields override, invalid fields fall back one by one", () => {
  const s = normaliseSettings({ green_max: 3, cooldown_min: -5, congestion_factor: 1.5, stale_min: 7.5 });
  assert.equal(s.green_max, 3);
  assert.equal(s.cooldown_min, DEFAULT_SETTINGS.cooldown_min); // out of range
  assert.equal(s.congestion_factor, 1.5);
  assert.equal(s.stale_min, DEFAULT_SETTINGS.stale_min); // must be a whole number
});

test("thresholds in the wrong order fall back together", () => {
  const s = normaliseSettings({ green_max: 8, yellow_max: 5 });
  assert.equal(s.green_max, DEFAULT_SETTINGS.green_max);
  assert.equal(s.yellow_max, DEFAULT_SETTINGS.yellow_max);
});

test("settingsErrors explains problems for the admin form", () => {
  assert.deepEqual(settingsErrors(DEFAULT_SETTINGS), []);
  const errs = settingsErrors({ ...DEFAULT_SETTINGS, yellow_max: 2, congestion_factor: 9 });
  assert.ok(errs.some((e) => e.includes("yellow_max must be greater")));
  assert.ok(errs.some((e) => e.includes("congestion_factor")));
});

test("live thresholds change the colour (admin sets green <= 4)", () => {
  const live = normaliseSettings({ green_max: 4, yellow_max: 8 });
  assert.equal(computeStatus([q(4, 1)], NOW, engineOpts(live, CAFE)).status, "green");
  assert.equal(levelForCount(4), "yellow"); // with the defaults it would be yellow
});

test("live stale window: a 20-min-old report counts when stale_min = 30", () => {
  const live = normaliseSettings({ stale_min: 30 });
  assert.equal(computeStatus([q(3, 20)], NOW, engineOpts(live, CAFE)).status, "yellow");
  assert.equal(computeStatus([q(3, 20)], NOW, engineOpts(S, CAFE)).status, "unknown");
});

// ---------- item-aware estimate ----------
test("formula: queue wait + item prep (not red, no congestion)", () => {
  const status = computeStatus([q(4, 1), q(4, 2)], NOW, engineOpts(S, CAFE)); // 4 x 45 s = 3 min
  assert.equal(status.queueWaitMin, 3);
  assert.deepEqual(estimateFor({ status, cafe: CAFE, item: { prep_min: 6 }, settings: S }), { min: 9, method: "formula" });
  assert.deepEqual(estimateFor({ status, cafe: CAFE, item: null, settings: S }), { min: 4, method: "formula" }); // + prep buffer 1
});

test("formula: congestion factor applies to the queue wait when red", () => {
  const status = computeStatus([q(10, 1)], NOW, engineOpts(S, CAFE)); // 10 x 45 s = 7.5, x1.2 = 9
  assert.equal(status.status, "red");
  assert.equal(status.queueWaitMin, 9);
  assert.equal(estimateFor({ status, cafe: CAFE, item: { prep_min: 2 }, settings: S }).min, 11);
});

test("admin congestion factor 1.5 is used live", () => {
  const live = normaliseSettings({ congestion_factor: 1.5 });
  assert.equal(computeStatus([q(10, 1)], NOW, engineOpts(live, CAFE)).queueWaitMin, 11.25);
});

test("unknown -> no estimate; colour-only fallback -> 'fallback'", () => {
  const unknown = computeStatus([], NOW, engineOpts(S, CAFE));
  assert.deepEqual(estimateFor({ status: unknown, cafe: CAFE, settings: S }), { min: null, method: null });
  const colour = computeStatus([{ level: "yellow", created_at: ago(1) }], NOW, engineOpts(S, CAFE));
  assert.deepEqual(estimateFor({ status: colour, cafe: CAFE, item: { prep_min: 3 }, settings: S }), { min: 9, method: "fallback" });
});

test("model is used when published, only for count-based statuses", () => {
  const seen = [];
  const model = { predict: (f) => (seen.push(f), 12.6) };
  const status = computeStatus([q(4, 1)], NOW, engineOpts(S, CAFE));
  const when = new Date(2026, 10, 23, 13, 5); // a Monday, 13:05 local time
  const est = estimateFor({ status, cafe: CAFE, item: { prep_min: 5 }, settings: S, model, now: when });
  assert.deepEqual(est, { min: 13, method: "model" });
  assert.deepEqual(seen[0], { queue_count: 4, hour: 13, day_of_week: 0, item_prep_min: 5, cafe_type: "cafe", service_sec_per_person: 45 });
  const colour = computeStatus([{ level: "green", created_at: ago(1) }], NOW, engineOpts(S, CAFE));
  assert.equal(estimateFor({ status: colour, cafe: CAFE, settings: S, model }).method, "fallback");
});

test("dashboard sort uses the item-aware estimate", () => {
  const row = (name, est) => ({ cafe: { name, walk_min: 2 }, status: { status: "green", waitMin: 2 }, est: { min: est } });
  assert.deepEqual(sortForDashboard([row("A", 12), row("B", 3)]).map((r) => r.cafe.name), ["B", "A"]);
});

// ---------- model walker ----------
const TREE = { left: [1, -1, -1], right: [2, -1, -1], feature: [0, -2, -2], threshold: [5, 0, 0], value: [0, 4, 10] };
const MODEL = { type: "random_forest", use_model: true, features: ["queue_count", "is_canteen"], trees: [TREE, { ...TREE, value: [0, 6, 12] }] };

test("tree walk: x <= threshold goes left", () => {
  assert.equal(predictTree(TREE, [5]), 4);
  assert.equal(predictTree(TREE, [6]), 10);
});

test("forest = mean of trees; a missing feature -> NaN", () => {
  assert.equal(predictForest(MODEL, { queue_count: 3, cafe_type: "cafe" }), 5);
  assert.equal(predictForest(MODEL, { queue_count: 9, cafe_type: "canteen" }), 11);
  assert.ok(Number.isNaN(predictForest(MODEL, { cafe_type: "cafe" })));
  assert.deepEqual(encodeFeatures(["is_canteen"], { cafe_type: "canteen" }), [1]);
});

test("unpublished or synthetic models are refused", () => {
  assert.equal(isUsableModel(MODEL), true);
  assert.equal(isUsableModel({ ...MODEL, use_model: false }), false);
  assert.equal(isUsableModel({ ...MODEL, synthetic: true }), false);
  assert.equal(isUsableModel(null), false);
});

// ---------- admin helpers ----------
test("CSV escaping (commas, quotes, newlines) and CRLF", () => {
  const csv = toCsv([{ a: 'x,"y"', b: "line1\nline2", c: null }], ["a", "b", "c"]);
  assert.equal(csv, 'a,b,c\r\n"x,""y""","line1\nline2",\r\n');
});

test("menu ids are stable and slugged", () => {
  assert.equal(slugify("Idli (2 Pieces)"), "idli-2-pieces");
  assert.equal(menuItemId("cafe-a", "Ghee Masala Dosa"), "cafe-a--ghee-masala-dosa");
});

test("stats: today / 7 days / fresh %", () => {
  const now = new Date(2026, 10, 24, 13, 0).getTime();
  const cafes = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C", active: false }];
  const reports = [
    { cafe_id: "a", created_at: now - 5 * 60e3 }, // today, fresh
    { cafe_id: "a", created_at: now - 3 * 3600e3 }, // today
    { cafe_id: "b", created_at: now - 2 * 86400e3 }, // this week
    { cafe_id: "b", created_at: now - 9 * 86400e3 }, // too old
  ];
  const s = cafeStats(reports, cafes, now, 15);
  assert.equal(s.today, 2);
  assert.equal(s.week, 3);
  assert.equal(s.activeCafes, 2);
  assert.equal(s.freshPct, 50);
});

test("OCR clean-up keeps names, drops numbering, dots and prices", () => {
  const text = "MENU\n1.Gobi Manchurian.............100/-\n12) Paneer Chilli 130/-\nVeg / Egg / Chicken 80/90/100\nRs 50\n70\nGobi Manchurian 100";
  assert.deepEqual(parseOcrLines(text), ["MENU", "Gobi Manchurian", "Paneer Chilli", "Veg / Egg / Chicken"]);
});

test("cafe and item validation mirror the rules", () => {
  assert.deepEqual(cafeErrors({ name: "X", type: "cafe", lat: 12.9, lng: 77.5, geofence_m: 40, walk_min: 3, service_sec_per_person: 45 }), []);
  assert.ok(cafeErrors({ name: "", type: "bar", lat: 200 }).length >= 3);
  assert.deepEqual(itemErrors({ name: "Vada", prep_min: 2, source: "observed", available: true }), []);
  assert.ok(itemErrors({ name: "Vada", prep_min: NaN, source: "observed", available: true }).some((e) => e.includes("Prep time")));
  assert.equal(itemErrors({ name: "Vada", prep_min: 2, source: "guess", available: true }).length, 1);
});
