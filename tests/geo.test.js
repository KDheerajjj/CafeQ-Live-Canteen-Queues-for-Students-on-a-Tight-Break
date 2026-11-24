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
