// seed-firestore.js — load seed/cafes.json into the Firestore `cafes` collection.
//
// Clients can't write `cafes` (see firestore.rules), so this uses the Admin SDK,
// which bypasses rules. Credentials (pick ONE; none of these live in the repo):
//   a) GOOGLE_APPLICATION_CREDENTIALS=<path to a service-account JSON outside the repo>
//   b) `gcloud auth application-default login` (no key file at all)
//   c) FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 to seed the local emulator
// All of these work on the free Spark plan; nothing here needs billing.
//
// Usage:  npm run seed        (reads .env if present)

import { readFile } from "node:fs/promises";
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID;
if (!projectId || projectId === "your-project-id") {
  console.error("Set FIREBASE_PROJECT_ID in .env (see .env.example).");
  process.exit(1);
}

const REQUIRED = {
  name: "string", type: "string", location_desc: "string", lat: "number", lng: "number",
  geofence_m: "number", walk_min: "number", service_sec_per_person: "number",
};

const raw = JSON.parse(await readFile(new URL("../seed/cafes.json", import.meta.url), "utf8"));

// Validate before writing anything, so a typo can't leave a half-seeded database.
for (const cafe of raw.cafes) {
  if (!/^[a-z0-9-]+$/.test(cafe.id ?? "")) throw new Error(`Bad cafe id: ${cafe.id}`);
  for (const [key, type] of Object.entries(REQUIRED)) {
    if (typeof cafe[key] !== type) throw new Error(`${cafe.id}.${key} must be a ${type}`);
  }
}

const options = { projectId };
if (!process.env.FIRESTORE_EMULATOR_HOST) options.credential = applicationDefault();
initializeApp(options);
const db = getFirestore();

const batch = db.batch();
for (const { id, ...fields } of raw.cafes) {
  // Drop any "_comment"-style keys; keep the `placeholder` flag so the UI can warn.
  const clean = Object.fromEntries(Object.entries(fields).filter(([k]) => !k.startsWith("_")));
  batch.set(db.collection("cafes").doc(id), clean);
}
await batch.commit();

const target = process.env.FIRESTORE_EMULATOR_HOST ? `emulator ${process.env.FIRESTORE_EMULATOR_HOST}` : `project ${projectId}`;
console.log(`Seeded ${raw.cafes.length} cafes into ${target}:`, raw.cafes.map((c) => c.id).join(", "));
if (raw.cafes.some((c) => c.placeholder)) {
  console.warn("WARNING: some cafes still have placeholder data — replace with measured values.");
}
