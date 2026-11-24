// The count -> colour thresholds live in two places that can't share code:
// public/js/config.js (browser) and firestore.rules (server). This test fails
// if someone tunes one and forgets the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LEVEL_THRESHOLDS, QUEUE_COUNT_MAX } from "../public/js/config.js";

const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");

test("firestore.rules levelFor() uses the same thresholds as config.js", () => {
  const m = rules.match(/count <= (\d+) \? 'green' : \(count <= (\d+) \? 'yellow' : 'red'\)/);
  assert.ok(m, "levelFor() not found in firestore.rules");
  assert.equal(Number(m[1]), LEVEL_THRESHOLDS.greenMax);
  assert.equal(Number(m[2]), LEVEL_THRESHOLDS.yellowMax);
});

test("firestore.rules caps queue_count at the same maximum as config.js", () => {
  const m = rules.match(/queue_count <= (\d+)/);
  assert.ok(m);
  assert.equal(Number(m[1]), QUEUE_COUNT_MAX);
});
