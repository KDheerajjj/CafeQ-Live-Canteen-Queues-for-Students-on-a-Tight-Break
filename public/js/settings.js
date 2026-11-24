// settings.js — live, admin-editable settings (Firestore `settings/global`).
//
// The admin dashboard writes the document; every open student app listens to
// it and recomputes immediately, so changing a threshold or buffer needs no
// redeploy. If the document (or any field) is missing or out of range, the
// DEFAULT_SETTINGS from config.js are used instead, so the app always works.

import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from "./config.js";
import { getFirebase } from "./firebase-init.js";

/** Is `v` an acceptable value for setting `key`? */
export function isValidSetting(key, v) {
  const lim = SETTINGS_LIMITS[key];
  if (!lim || typeof v !== "number" || !Number.isFinite(v)) return false;
  const [lo, hi, intOnly] = lim;
  return v >= lo && v <= hi && (!intOnly || Number.isInteger(v));
}

/**
 * Merge a raw Firestore document over the defaults, field by field.
 * Invalid fields fall back to their default; if the two thresholds end up in
 * the wrong order, both fall back together (they only make sense as a pair).
 */
export function normaliseSettings(raw) {
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (raw && isValidSetting(key, raw[key])) out[key] = raw[key];
  }
  if (out.yellow_max <= out.green_max) {
    out.green_max = DEFAULT_SETTINGS.green_max;
    out.yellow_max = DEFAULT_SETTINGS.yellow_max;
  }
  return out;
}

/** Human-readable problems with a settings object (for the admin form). */
export function settingsErrors(s) {
  const errs = [];
  for (const [key, [lo, hi, intOnly]] of Object.entries(SETTINGS_LIMITS)) {
    if (!isValidSetting(key, s[key])) errs.push(`${key} must be ${intOnly ? "a whole number" : "a number"} from ${lo} to ${hi}.`);
  }
  if (!(s.yellow_max > s.green_max)) errs.push("yellow_max must be greater than green_max.");
  return errs;
}

/** Options for status-engine.computeStatus() from settings + one cafe. */
export function engineOpts(settings, cafe) {
  return {
    windowMin: settings.stale_min,
    thresholds: { greenMax: settings.green_max, yellowMax: settings.yellow_max },
    outlierCap: settings.outlier_cap,
    prepBufferMin: settings.prep_buffer_min,
    congestionFactor: settings.congestion_factor,
    serviceSecPerPerson: cafe?.service_sec_per_person,
  };
}

/**
 * Listen to settings/global. onChange(settings, fromServer) fires immediately
 * with the defaults if the read fails, so callers never wait forever.
 * Returns an unsubscribe function.
 */
export async function watchSettings(onChange) {
  const { db, fs } = await getFirebase();
  return fs.onSnapshot(
    fs.doc(db, "settings", "global"),
    (snap) => onChange(normaliseSettings(snap.exists() ? snap.data() : null), snap.exists()),
    (err) => {
      console.warn("Settings unavailable, using defaults.", err);
      onChange(normaliseSettings(null), false);
    }
  );
}
