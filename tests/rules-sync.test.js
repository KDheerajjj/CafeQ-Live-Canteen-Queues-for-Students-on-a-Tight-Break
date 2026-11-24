// Values that live in two places that can't share code: public/js/config.js
// (browser) and firestore.rules (server). These tests fail if someone tunes one
// and forgets the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SETTINGS, SETTINGS_LIMITS, QUEUE_COUNT_MAX } from "../public/js/config.js";

const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");

test("rules fall back to the same default thresholds as config.js", () => {
  assert.ok(rules.includes(`data.green_max : ${DEFAULT_SETTINGS.green_max};`));
  assert.ok(rules.includes(`data.yellow_max : ${DEFAULT_SETTINGS.yellow_max};`));
});

test("rules levelFor() uses the live thresholds (<= green -> green, <= yellow -> yellow, else red)", () => {
  assert.ok(rules.includes("count <= greenMax() ? 'green' : (count <= yellowMax() ? 'yellow' : 'red')"));
});

test("rules cap queue_count at the same maximum as config.js", () => {
  assert.ok(rules.includes(`isInt(request.resource.data.queue_count, 0, ${QUEUE_COUNT_MAX})`));
});

test("rules enforce the same range for every admin setting as SETTINGS_LIMITS", () => {
  for (const [key, [lo, hi, intOnly]] of Object.entries(SETTINGS_LIMITS)) {
    const expected = `${intOnly ? "isInt" : "isNum"}(d.${key}, ${lo}, ${hi})`;
    assert.ok(rules.includes(expected), `${key}: expected "${expected}" in firestore.rules`);
  }
});
