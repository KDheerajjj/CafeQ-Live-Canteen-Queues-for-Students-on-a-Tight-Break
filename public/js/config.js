// config.js — the ONE place for public configuration and tunable constants.
//
// The Firebase *web* config below is public by design: it only identifies the
// project. Access control comes from firestore.rules, not from hiding this.
// Never put service-account keys or other secrets in any file under /public.
//
// This file has no browser-only code, so the pure modules (and Node tests) can
// import it too.

// ---------------------------------------------------------------------------
// 1. Firebase web config, from Firebase console -> Project settings ->
//    Your apps -> Web app -> Config.
//    measurementId (Google Analytics) is deliberately left out: CafeQ collects
//    no analytics or personal data.
// ---------------------------------------------------------------------------
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDrtZBHsaYhz5WYTzX5zhVwJr4Ay-_R_2c",
  authDomain: "cafeq-8f5a4.firebaseapp.com",
  projectId: "cafeq-8f5a4",
  storageBucket: "cafeq-8f5a4.firebasestorage.app",
  messagingSenderId: "1015247017714",
  appId: "1:1015247017714:web:29151fac36058d1f65a26b",
};

// True once the placeholder above has been replaced. The UI shows a setup
// notice instead of failing silently while this is false.
export const FIREBASE_CONFIGURED = !Object.values(FIREBASE_CONFIG).some((v) =>
  String(v).includes("REPLACE_ME")
);

// Firebase JS SDK, loaded straight from Google's CDN (no build step).
export const FIREBASE_SDK_VERSION = "10.14.1";

// ---------------------------------------------------------------------------
// 2. App constants
// ---------------------------------------------------------------------------

// Day-scholar reference point: where a typical day scholar starts their break
// (e.g. the main academic block). PLACEHOLDER — replace with a measured point.
// cafes.walk_min is measured from here.
export const REFERENCE_POINT = {
  label: "Main academic block (placeholder)",
  lat: 12.92365, // PLACEHOLDER
  lng: 77.49900, // PLACEHOLDER
};

// Minutes a student needs to actually eat once served. Used by "Will I make it?".
export const EATING_BUFFER_MIN = 5;

// A trip is "Go" only if it leaves at least this much slack; otherwise "Risky".
export const SAFETY_MARGIN_MIN = 3;

// ---- Queue-length reporting (v2) -------------------------------------------
// Reporters either tap a bucket or type an exact count. A bucket is stored as
// its midpoint so every report has one number (queue_count).
export const QUEUE_BUCKETS = [
  { id: "0-2", label: "0–2", count: 1 },
  { id: "3-5", label: "3–5", count: 4 },
  { id: "6-10", label: "6–10", count: 8 },
  { id: "10+", label: "10+", count: 12 },
];
export const QUEUE_COUNT_MAX = 100; // the input and firestore.rules both cap at 100

// queue_count -> colour. <= greenMax: green; <= yellowMax: yellow; above: red.
// MUST match the numbers in firestore.rules (a unit test checks this).
export const LEVEL_THRESHOLDS = { greenMax: 2, yellowMax: 6 };

// Any single count above this is stored but IGNORED when aggregating, so one
// troll typing 99 can't skew a cafe's median.
export const OUTLIER_COUNT_CAP = 50;

// Count-based wait:  round(median_count × cafe.service_sec_per_person / 60) + PREP_BUFFER_MIN
// PREP_BUFFER_MIN = time to hand over / make the order once you reach the counter.
export const PREP_BUFFER_MIN = 1;
// Used only if a cafe document has no service_sec_per_person. ASSUMPTION.
export const DEFAULT_SERVICE_SEC_PER_PERSON = 60;

// Crowd COLOUR -> ESTIMATED wait in minutes. FALLBACK ONLY, for cafes whose
// recent reports are all colour-only (pre-v2). Count-based estimates replace it
// as soon as a report with queue_count exists. Guesses, labelled "est." in the UI.
// TODO(phase-2-ml): replace with a per-cafe, per-time-slot prediction.
export const STATUS_WAIT_MIN = {
  green: 2,
  yellow: 6,
  red: 12,
  unknown: null,
};

// Status engine windows (minutes).
export const STATUS_WINDOW_MIN = 15;     // reports older than this are ignored; newest older -> "unknown"
export const CONFIDENCE_WINDOW_MIN = 10; // >=2 agreeing reports inside this window -> "high" confidence
export const CONFIDENCE_MIN_REPORTS = 2;

// One report per device per this many minutes (client-side, see README).
export const COOLDOWN_MIN = 3;

// Walking estimate used when the student turns on "Use my location for walk
// times" (otherwise cafes.walk_min, from the reference point, is used).
// ~75 m/min is a normal walking pace; the detour factor turns straight-line
// distance into a rough path distance. Both are estimates.
export const WALK_SPEED_M_PER_MIN = 75;
export const WALK_DETOUR_FACTOR = 1.3;

// Location-based walk times: ignore fixes worse than this (m) and fall back to
// walk_min; re-read the position this often while the app is open and visible,
// and every time it is opened / brought back to the foreground.
export const MAX_LOCATION_ACCURACY_M = 150;
export const LOCATION_REFRESH_MIN = 3;

// Human labels for each level. Every status is shown as icon + text, never
// colour alone: the icons differ in SHAPE so they work for colour-blind users.
export const LEVELS = {
  green: { label: "No wait", icon: "✓" },
  yellow: { label: "Short line", icon: "⏳" },
  red: { label: "Packed", icon: "⛔" },
  unknown: { label: "Unknown", icon: "?" },
};

// When a cafe is RED (packed), counters slow down (crowding at the counter,
// orders backing up), so the queue wait is multiplied by this. ASSUMPTION.
export const CONGESTION_FACTOR = 1.2;

// ---------------------------------------------------------------------------
// 3. Live settings (v3)
// ---------------------------------------------------------------------------
// The admin dashboard edits these in Firestore (`settings/global`) and every
// open app picks them up live, with no redeploy. The values here are only the
// safe DEFAULTS used when the document (or a field in it) is missing or invalid.
// Field names match the Firestore document.
export const DEFAULT_SETTINGS = Object.freeze({
  green_max: LEVEL_THRESHOLDS.greenMax,   // queue <= this -> green
  yellow_max: LEVEL_THRESHOLDS.yellowMax, // queue <= this -> yellow, above -> red
  prep_buffer_min: PREP_BUFFER_MIN,       // generic "make the order" time when no item is picked
  cooldown_min: COOLDOWN_MIN,             // one report per device per N minutes
  stale_min: STATUS_WINDOW_MIN,           // reports older than this are ignored
  outlier_cap: OUTLIER_COUNT_CAP,         // single counts above this are ignored
  eating_buffer_min: EATING_BUFFER_MIN,   // "Will I make it?" eating time
  congestion_factor: CONGESTION_FACTOR,   // queue-wait multiplier when red
});

// Allowed range for each setting: [min, max, integerOnly].
// firestore.rules enforces the same ranges on admin writes (a test checks the
// threshold defaults stay in sync).
export const SETTINGS_LIMITS = Object.freeze({
  green_max: [0, 20, true],
  yellow_max: [1, 50, true],
  prep_buffer_min: [0, 15, false],
  cooldown_min: [0, 30, false],
  stale_min: [5, 60, true],
  outlier_cap: [10, 100, true],
  eating_buffer_min: [0, 30, false],
  congestion_factor: [1, 3, false],
});

// Menu item provenance, kept visible so nobody mistakes a guess for a measurement.
export const MENU_SOURCES = {
  vendor: "Told by the vendor",
  observed: "Timed by us",
  estimate: "Rough estimate",
};

// "How long did it actually take?" quick answers (minutes, from joining the
// line to food in hand). The ONLY source of ML training labels.
export const FEEDBACK_CHOICES = [2, 5, 8, 10, 15, 20, 30, 45];
// Ask for feedback this long after "I'm going", and forget the visit after this.
export const FEEDBACK_ASK_AFTER_MIN = 3;
export const FEEDBACK_FORGET_AFTER_MIN = 240;

// ML policy (see scripts/ml/README.md): the browser only uses public/model.json
// if the offline trainer wrote it AND marked it as beating the formula baseline.
export const MODEL_URL = "./model.json";
