// report.js — the "anyone nearby" update side. Opened from the QR at the counter:
//   report.html?cafe=<cafe id>
//
// Flow (one screen, two taps max):
//   1. read ?cafe= and load that cafe (name, coords, geofence)
//   2. silent anonymous sign-in
//   3. cooldown check (localStorage + Firestore query): one report / device / 3 min
//   4. geolocation -> haversine distance -> must be inside the cafe's geofence
//   5. queue length: tap a bucket (0–2 / 3–5 / 6–10 / 10+) OR type an exact count.
//      The count (bucket midpoint, or the typed number) is stored as queue_count,
//      and the colour `level` is DERIVED from it with LEVEL_THRESHOLDS
//      (firestore.rules rejects a report whose level doesn't match its count).
//      One write -> thank-you + live status.
//
// NOTE: steps 3 and 4 run in the browser only (Phase 1). Firestore rules can't
// see GPS, so a determined user could bypass them. See README "Trust model".
// TODO(phase-2-hardening): send reports through a Cloud Function that re-checks
//   location and rate-limits per uid (needs the Blaze plan — not in Phase 1).
// TODO(phase-2-accuracy): use the stored `acc` to down-weight imprecise GPS fixes.

import { ensureAnonUser, getFirebase, registerServiceWorker } from "./firebase-init.js";
import { haversineMeters, isWithinGeofence } from "./geo.js";
import { computeStatus, levelForCount, isValidCount } from "./status-engine.js";
import { reportFromDoc } from "./data.js";
import { QUEUE_BUCKETS, QUEUE_COUNT_MAX, LEVELS } from "./config.js";
import { normaliseSettings, engineOpts } from "./settings.js";
import { esc, levelLabel, minutesAgo, waitText, queueText, describeError } from "./ui.js";

registerServiceWorker();

const MIN_MS = 60 * 1000;
// Live admin settings (thresholds, cooldown, stale window). Read once per page
// load; the colour of a report MUST use the same thresholds as firestore.rules,
// which read the same settings/global document.
let settings = normaliseSettings(null);
const thresholds = () => ({ greenMax: settings.green_max, yellowMax: settings.yellow_max });
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

/** True if this device reported in the last cooldown_min minutes. Checks
 * localStorage first (instant), then Firestore by uid (survives cleared storage
 * as long as the anonymous session survives). */
async function inCooldown(db, fs, uid) {
  const since = Date.now() - settings.cooldown_min * MIN_MS;
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
function watchCafeStatus(db, fs, cafe) {
  const since = fs.Timestamp.fromMillis(Date.now() - settings.stale_min * MIN_MS);
  const q = fs.query(
    fs.collection(db, "reports"),
    fs.where("cafe_id", "==", cafe.id),
    fs.where("created_at", ">=", since),
    fs.orderBy("created_at", "desc")
  );
  fs.onSnapshot(
    q,
    (snap) => {
      const s = computeStatus(snap.docs.map(reportFromDoc), Date.now(), engineOpts(settings, cafe));
      $("now-dot").className = `dot ${s.status}`;
      $("now-label").textContent =
        levelLabel(s.status) + (s.queueCount != null ? ` · ${queueText(s.queueCount)}` : "");
      $("now-meta").textContent =
        s.status === "unknown"
          ? "No recent reports."
          : `${waitText(s.waitMin)} · ${s.reportCount} report${s.reportCount === 1 ? "" : "s"} in ${settings.stale_min} min · ` +
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
    const [snap, settingsSnap] = await Promise.all([
      fs.getDoc(fs.doc(db, "cafes", cafeId)),
      fs.getDoc(fs.doc(db, "settings", "global")).catch(() => null), // defaults if unreadable
    ]);
    settings = normaliseSettings(settingsSnap && settingsSnap.exists() ? settingsSnap.data() : null);
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
    message("Thanks — you just reported.", `You can report again ${settings.cooldown_min} minutes after your last report.`);
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

  // 5. Queue length: bucket tap OR exact number.
  $("distance-note").textContent = `📍 You're about ${Math.round(distance)} m from the counter (GPS ±${Math.round(accuracy)} m).`;
  show("s-choose");

  let sent = false; // guards against double taps / double submits
  const send = async (queueCount, how) => {
    if (sent) return;
    sent = true;
    document.querySelectorAll("#s-choose button").forEach((b) => (b.disabled = true));
    await submit({ db, fs, cafe, uid, queueCount, how, accuracy });
  };

  // Bucket buttons, coloured by the level their midpoint maps to.
  $("buckets").innerHTML = QUEUE_BUCKETS.map((b) => {
    const level = levelForCount(b.count, thresholds());
    return `<button class="level-btn ${level}" type="button" data-count="${b.count}" data-label="${esc(b.label)}"
        aria-label="${esc(b.label)} people in line">
        <span class="emoji" aria-hidden="true">${LEVELS[level].icon}</span>
        <span>${esc(b.label)}<small>people · ${esc(LEVELS[level].label)}</small></span>
      </button>`;
  }).join("");
  $("buckets").onclick = (e) => {
    const btn = e.target.closest("button[data-count]");
    if (btn) send(Number(btn.dataset.count), `${btn.dataset.label} people`);
  };

  // Exact count: whole number 0..100, with a live colour preview.
  const input = $("exact-count");
  const parseExact = () => {
    const raw = input.value.trim();
    if (!/^\d{1,3}$/.test(raw)) return null;
    const n = Number(raw);
    return isValidCount(n) ? n : null;
  };
  input.oninput = () => {
    const n = parseExact();
    $("exact-send").disabled = n === null;
    $("exact-preview").textContent =
      input.value.trim() === ""
        ? ""
        : n === null
          ? `Enter a whole number from 0 to ${QUEUE_COUNT_MAX}.`
          : `${n} in line → ${LEVELS[levelForCount(n, thresholds())].icon} ${levelLabel(levelForCount(n, thresholds()))}`;
  };
  $("exact-form").onsubmit = (e) => {
    e.preventDefault();
    const n = parseExact();
    if (n !== null) send(n, `${n} in line`);
  };
}

async function submit({ db, fs, cafe, uid, queueCount, how, accuracy }) {
  loading("Sending…");
  const level = levelForCount(queueCount, thresholds()); // derived (live thresholds), never chosen separately
  const write = fs.addDoc(fs.collection(db, "reports"), {
    cafe_id: cafe.id,
    queue_count: queueCount,          // integer 0..100 (bucket midpoint or exact)
    level,                            // must match queue_count (enforced by rules)
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
        ? `You reported ${how} (${levelLabel(level)}). Weak signal — it will send automatically when you're back online.`
        : `You reported ${how} (${levelLabel(level)}) at ${cafe.name}.`;
    show("s-thanks");
    watchCafeStatus(db, fs, cafe);
  } catch (err) {
    console.error(err);
    const [t, b] = describeError(err);
    message(t, b, { retry: run });
  }
}

run();
