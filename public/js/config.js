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

// Crowd status -> ESTIMATED wait in minutes.
// PLACEHOLDER until the Phase-2 ML model exists. These are guesses, not
// measurements, and the UI always labels them "est.".
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

// Human labels for each level. Keep in sync with firestore.rules.
export const LEVELS = {
  green: { label: "No wait", emoji: "🟢" },
  yellow: { label: "Short line", emoji: "🟡" },
  red: { label: "Packed", emoji: "🔴" },
  unknown: { label: "Unknown", emoji: "⚪" },
};
