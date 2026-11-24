// seed-firestore.js — first-time setup of Firestore from the files in /seed.
//
//   seed/cafes.json         -> cafes/{id}
//   (config.js defaults)    -> settings/global
//   seed/menus/<cafe>.json  -> menu_items/{cafe}--{slug}   (ONLY items with a real prep_min)
//
// Since v3 the admin dashboard edits all of these live, so this script is
// CREATE-ONLY by default: it never overwrites a document that already exists
// (that would undo admin edits). Pass --force to overwrite deliberately.
//
// Clients can't write these collections without being admins (firestore.rules),
// so this uses the Admin SDK. Credentials (pick ONE; none of these live in the repo):
//   a) GOOGLE_APPLICATION_CREDENTIALS=<path to a service-account JSON outside the repo>
//   b) `gcloud auth application-default login` (no key file at all)
//   c) FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 to seed the local emulator
// All of these work on the free Spark plan; nothing here needs billing.
//
// Usage:  npm run seed               (create missing docs only)
//         npm run seed -- --force    (overwrite cafes/settings/menu items from the files)

import { readFile, readdir } from "node:fs/promises";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { DEFAULT_SETTINGS } from "../public/js/config.js";
import { menuItemId, itemErrors } from "../public/js/admin-lib.js";

const FORCE = process.argv.includes("--force");
const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId || projectId === "your-project-id") {
  console.error("Set FIREBASE_PROJECT_ID in .env (see .env.example).");
  process.exit(1);
}

const REQUIRED = {
  name: "string", type: "string", location_desc: "string", lat: "number", lng: "number",
  geofence_m: "number", walk_min: "number", service_sec_per_person: "number",
};
const stripPrivate = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));

// ---------- read + validate everything before writing anything ----------
const raw = JSON.parse(await readFile(new URL("../seed/cafes.json", import.meta.url), "utf8"));
for (const cafe of raw.cafes) {
  if (!/^[a-z0-9-]+$/.test(cafe.id ?? "")) throw new Error(`Bad cafe id: ${cafe.id}`);
  for (const [key, type] of Object.entries(REQUIRED)) {
    if (typeof cafe[key] !== type) throw new Error(`${cafe.id}.${key} must be a ${type}`);
  }
}
const cafeIds = new Set(raw.cafes.map((c) => c.id));

const menuDir = new URL("../seed/menus/", import.meta.url);
const menuItems = [];
let skippedNoPrep = 0;
for (const file of (await readdir(menuDir)).filter((f) => f.endsWith(".json"))) {
  const menu = JSON.parse(await readFile(new URL(file, menuDir), "utf8"));
  if (!cafeIds.has(menu.cafe_id)) throw new Error(`${file}: unknown cafe_id ${menu.cafe_id}`);
  for (const it of menu.items) {
    // prep_min is REAL data: items whose prep time hasn't been measured yet are skipped.
    if (typeof it.prep_min !== "number") {
      skippedNoPrep += 1;
      continue;
    }
    const item = {
      cafe_id: menu.cafe_id,
      name: it.name,
      ...(it.category ? { category: it.category } : {}),
      prep_min: it.prep_min,
      source: it.source,
      available: it.available !== false,
    };
    const errs = itemErrors(item);
    if (errs.length) throw new Error(`${file} "${it.name}": ${errs.join(" ")}`);
    menuItems.push({ id: menuItemId(menu.cafe_id, it.name), data: item });
  }
}

// ---------- write ----------
const options = { projectId };
if (!process.env.FIRESTORE_EMULATOR_HOST) options.credential = applicationDefault();
initializeApp(options);
const db = getFirestore();

async function put(ref, data) {
  if (!FORCE && (await ref.get()).exists) return "kept";
  await ref.set({ ...data, updated_at: FieldValue.serverTimestamp(), updated_by: "seed-script" });
  return "written";
}
const tally = { written: 0, kept: 0 };
const count = (r) => (tally[r] += 1);

for (const { id, ...fields } of raw.cafes) {
  count(await put(db.collection("cafes").doc(id), { active: true, ...stripPrivate(fields) }));
}
count(await put(db.doc("settings/global"), { ...DEFAULT_SETTINGS }));
for (const { id, data } of menuItems) count(await put(db.collection("menu_items").doc(id), data));

const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : `project ${projectId}`;
console.log(
  `Seed into ${target}: ${tally.written} written, ${tally.kept} already existed (kept; use --force to overwrite). ` +
    `${raw.cafes.length} cafes, settings/global, ${menuItems.length} menu items with prep times.`
);
if (skippedNoPrep) console.log(`${skippedNoPrep} menu items skipped: no prep_min yet (time them, then fill seed/menus/*.json or use the admin page).`);
if (raw.cafes.some((c) => c.placeholder)) console.warn("WARNING: some cafes still have placeholder data — replace with measured values.");
