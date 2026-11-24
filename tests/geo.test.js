import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineMeters, isWithinGeofence, estimateWalkMinutes } from "../public/js/geo.js";

test("haversine: same point is 0 m", () => {
  assert.equal(haversineMeters(12.9237, 77.4987, 12.9237, 77.4987), 0);
});

test("haversine: 0.001° latitude ≈ 111 m", () => {
  const d = haversineMeters(12.9237, 77.4987, 12.9247, 77.4987);
  assert.ok(Math.abs(d - 111.2) < 0.5, `got ${d}`);
});

test("haversine: Bengaluru -> Mysuru ≈ 128 km straight line", () => {
  const d = haversineMeters(12.9716, 77.5946, 12.2958, 76.6394);
  assert.ok(d > 125000 && d < 131000, `got ${d}`);
});

test("geofence: inside, on the edge, outside", () => {
  assert.equal(isWithinGeofence(10, 90), true);
  assert.equal(isWithinGeofence(90, 90), true);
  assert.equal(isWithinGeofence(90.1, 90), false);
  assert.equal(isWithinGeofence(NaN, 90), false);
});

test("walk estimate never returns less than 1 min", () => {
  assert.equal(estimateWalkMinutes(0, 75, 1.3), 1);
  assert.equal(estimateWalkMinutes(300, 75, 1.3), 5); // 390 m path / 75 = 5.2
});

import { resolveWalkMinutes } from "../public/js/geo.js";
const OPTS = { speedMPerMin: 75, detourFactor: 1.3, maxAccuracyM: 150 };
const CAFE = { lat: 12.923484, lng: 77.499839, walk_min: 4 };

test("walk: no position -> reference walk_min", () => {
  assert.deepEqual(resolveWalkMinutes(CAFE, null, OPTS), { min: 4, source: "reference" });
});

test("walk: accurate position -> estimate from the student", () => {
  // ~0.003° lat ≈ 334 m north -> 334*1.3/75 ≈ 5.8 -> 6 min
  const r = resolveWalkMinutes(CAFE, { lat: 12.926484, lng: 77.499839, accuracy: 20 }, OPTS);
  assert.deepEqual(r, { min: 6, source: "you" });
});

test("walk: standing at the cafe -> 1 min minimum", () => {
  assert.equal(resolveWalkMinutes(CAFE, { lat: CAFE.lat, lng: CAFE.lng, accuracy: 5 }, OPTS).min, 1);
});

test("walk: too-rough GPS fix falls back to walk_min", () => {
  const r = resolveWalkMinutes(CAFE, { lat: 12.926484, lng: 77.499839, accuracy: 400 }, OPTS);
  assert.equal(r.source, "reference");
});
