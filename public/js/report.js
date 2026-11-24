// report.js — the "anyone nearby" update side. Opened from the QR at the counter:
//   report.html?cafe=<cafe id>
//
// Flow (one screen, two taps max):
//   1. read ?cafe= and load that cafe (name, coords, geofence)
//   2. silent anonymous sign-in
//   3. cooldown check (localStorage + Firestore query): one report / device / 3 min
//   4. geolocation -> haversine distance -> must be inside the cafe's geofence
//   5. three big buttons; one tap writes a `reports` doc -> thank-you + live status
//
// NOTE: steps 3 and 4 run in the browser only (Phase 1). Firestore rules can't
// see GPS, so a determined user could bypass them. See README "Trust model".
// TODO(phase-2-hardening): send reports through a Cloud Function that re-checks
//   location and rate-limits per uid (needs the Blaze plan — not in Phase 1).
// TODO(phase-2-accuracy): use the stored `acc` to down-weight imprecise GPS fixes.

import { ensureAnonUser, getFirebase, registerServiceWorker } from "./firebase-init.js";
import { haversineMeters, isWithinGeofence } from "./geo.js";
import { computeStatus } from "./status-engine.js";
import { reportFromDoc } from "./data.js";
import { COOLDOWN_MIN, STATUS_WINDOW_MIN } from "./config.js";
import { levelLabel, minutesAgo, waitText, describeError } from "./ui.js";

registerServiceWorker();

const MIN_MS = 60 * 1000;
const LAST_REPORT_KEY = "cafeq.lastReportAt";
const $ = (id) => document.getElementById(id);

// ---------- screen switching ----------
const SECTIONS = ["s-loading", "s-message", "s-choose", "s-thanks"];
function show(id) {
  for (const s of SECTIONS) $(s).hidden = s !== id;
}
function loading(text) {
  $("loading-text").textContent = text;
  show("s-loading");
}
function message(title, body, { retry = null } = {}) {
  $("msg-title").textContent = title;
  $("msg-body").textContent = body;
  $("retry").hidden = !retry;
  $("retry").onclick = retry;
  show("s-message");
}

// ---------- cooldown ----------
function localLastReport() {
  try {
    return Number(localStorage.getItem(LAST_REPORT_KEY)) || 0;
  } catch {
    return 0; // storage blocked (private mode) — the Firestore check still runs
  }
}
function rememberReport() {
  try {
    localStorage.setItem(LAST_REPORT_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

/** True if this device reported in the last COOLDOWN_MIN minutes. Checks
 * localStorage first (instant), then Firestore by uid (survives cleared storage
 * as long as the anonymous session survives). */
async function inCooldown(db, fs, uid) {
  const since = Date.now() - COOLDOWN_MIN * MIN_MS;
  if (localLastReport() >= since) return true;
  try {
    const q = fs.query(
      fs.collection(db, "reports"),
      fs.where("uid", "==", uid),
      fs.where("created_at", ">=", fs.Timestamp.fromMillis(since)),
      fs.limit(1)
    );
    const snap = await fs.getDocs(q);
    return !snap.empty;
  } catch (err) {
    // e.g. index still building / offline: fall back to the local check only.
    console.warn("Cooldown query failed; using local check only.", err);
    return false;
  }
}

// ---------- geolocation ----------
function getPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject({ code: "unsupported" });
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 30000,
    });
  });
}

// ---------- after submit: live status of this cafe ----------
function watchCafeStatus(db, fs, cafeId) {
  const since = fs.Timestamp.fromMillis(Date.now() - STATUS_WINDOW_MIN * MIN_MS);
  const q = fs.query(
    fs.collection(db, "reports"),
    fs.where("cafe_id", "==", cafeId),
    fs.where("created_at", ">=", since),
    fs.orderBy("created_at", "desc")
  );
  fs.onSnapshot(
    q,
    (snap) => {
      const s = computeStatus(snap.docs.map(reportFromDoc), Date.now());
      $("now-dot").className = `dot ${s.status}`;
      $("now-label").textContent = levelLabel(s.status);
      $("now-meta").textContent =
        s.status === "unknown"
          ? "No recent reports."
          : `${waitText(s.waitMin)} · ${s.reportCount} report${s.reportCount === 1 ? "" : "s"} in 15 min · ` +
            `${s.confidence} confidence · updated ${minutesAgo(s.updatedMinAgo)}`;
    },
    (err) => {
      console.warn(err);
      $("now-meta").textContent = "Couldn't load the live status right now.";
    }
  );
}

// ---------- main flow ----------
async function run() {
  // 1. Which cafe?
  const cafeId = new URLSearchParams(location.search).get("cafe");
  if (!cafeId) {
    message("No cafe selected", "Open this page by scanning the CafeQ QR code at a cafe counter.");
    return;
  }

  loading("Loading cafe…");
  let db, fs;
  try {
    ({ db, fs } = await getFirebase());
  } catch (err) {
    const [t, b] = describeError(err);
    message(t, b);
    return;
  }

  let cafe;
  try {
    const snap = await fs.getDoc(fs.doc(db, "cafes", cafeId));
    if (!snap.exists()) {
      message("Unknown cafe", `There's no cafe with id "${cafeId}". The QR code may be out of date.`);
      return;
    }
    cafe = { id: snap.id, ...snap.data() };
  } catch (err) {
    const [t, b] = describeError(err);
    message(t, b, { retry: run });
    return;
  }
  $("cafe-name").textContent = cafe.name;
  $("cafe-desc").textContent = cafe.location_desc || "";
  document.title = `CafeQ — ${cafe.name}`;

  // 2. Silent anonymous sign-in.
  let uid;
  try {
    uid = await ensureAnonUser();
  } catch (err) {
    message("Couldn't connect", "Anonymous sign-in failed. Check your connection and try again.", { retry: run });
    return;
  }

  // 3. Cooldown.
  loading("Checking…");
  if (await inCooldown(db, fs, uid)) {
    message("Thanks — you just reported.", `You can report again ${COOLDOWN_MIN} minutes after your last report.`);
    return;
  }

  // 4. Location gate (no bypass).
  loading("Confirming you're at the cafe…");
  let pos;
  try {
    pos = await getPosition();
  } catch (err) {
    if (err.code === 1) {
      message(
        "Location needed",
        "Reports need your location once, just to confirm you're actually at the cafe — that's what keeps the crowd levels trustworthy. Allow location for this site and try again."
      , { retry: run });
    } else if (err.code === "unsupported") {
      message("Location not supported", "This browser can't share location, so it can't confirm you're at the cafe.");
    } else {
      message("Couldn't get your location", "No GPS fix yet. Step outside or near a window and try again.", { retry: run });
    }
    return;
  }

  const { latitude, longitude, accuracy } = pos.coords;
  const distance = haversineMeters(latitude, longitude, cafe.lat, cafe.lng);
  if (!isWithinGeofence(distance, cafe.geofence_m)) {
    message(
      `You look too far from ${cafe.name} to report.`,
      `Open this from the QR at the counter. (You seem to be about ${Math.round(distance)} m away; reports must be within ${cafe.geofence_m} m.)`,
      { retry: run }
    );
    return;
  }

  // 5. Choose level.
  $("distance-note").textContent = `📍 You're about ${Math.round(distance)} m from the counter (GPS ±${Math.round(accuracy)} m).`;
  show("s-choose");
  const buttons = [...document.querySelectorAll(".level-btn")];
  buttons.forEach((btn) => {
    btn.onclick = async () => {
      buttons.forEach((b) => (b.disabled = true)); // prevent double taps
      await submit({ db, fs, cafe, uid, level: btn.dataset.level, accuracy });
    };
  });
}

async function submit({ db, fs, cafe, uid, level, accuracy }) {
  loading("Sending…");
  const write = fs.addDoc(fs.collection(db, "reports"), {
    cafe_id: cafe.id,
    level,
    uid,
    created_at: fs.serverTimestamp(), // rules require == request.time
    acc: Math.round(accuracy),        // GPS accuracy (m), kept for later filtering
  });

  // Firestore queues writes while offline and resolves only when the server
  // confirms. Don't leave the student staring at a spinner: after 8 s, say it's queued.
  const timeout = new Promise((resolve) => setTimeout(() => resolve("queued"), 8000));
  try {
    const result = await Promise.race([write, timeout]);
    rememberReport();
    $("thanks-note").textContent =
      result === "queued"
        ? `You reported "${levelLabel(level)}". Weak signal — it will send automatically when you're back online.`
        : `You reported "${levelLabel(level)}" for ${cafe.name}.`;
    show("s-thanks");
    watchCafeStatus(db, fs, cafe.id);
  } catch (err) {
    console.error(err);
    const [t, b] = describeError(err);
    message(t, b, { retry: run });
  }
}

run();
