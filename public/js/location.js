// location.js — the student's OWN position, for personal walk times.
//
// Opt-in: nothing is requested until the student turns on "Use my location for
// walk times" (dashboard) or picks "My current location" (worth-it). The choice
// is remembered on this device only (localStorage), so a first-time visitor
// never sees a permission prompt just for opening the app.
//
// Once opted in, the position is re-read:
//   - when the page opens,
//   - whenever the app comes back to the foreground (visibilitychange),
//   - every LOCATION_REFRESH_MIN minutes while it stays open and visible.
// Browsers do not allow location reads while a web app is closed or in the
// background, so there is no background updating (see docs/push-notifications.md).
//
// Privacy: the position stays in memory in this tab. It is never written to
// Firestore or localStorage.

import { LOCATION_REFRESH_MIN, MAX_LOCATION_ACCURACY_M } from "./config.js";

const OPT_IN_KEY = "cafeq.useLocation";

export function isLocationOptedIn() {
  try {
    return localStorage.getItem(OPT_IN_KEY) === "1";
  } catch {
    return false;
  }
}

function setOptIn(on) {
  try {
    if (on) localStorage.setItem(OPT_IN_KEY, "1");
    else localStorage.removeItem(OPT_IN_KEY);
  } catch {
    /* storage blocked: the setting just won't be remembered */
  }
}

function readPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject({ code: "unsupported" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
          at: Date.now(),
        }),
      reject,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  });
}

/**
 * Start tracking. onChange(state) is called whenever something changes, where
 * state = { status, pos } and status is one of:
 *   "off"         not opted in (use reference-point walk times)
 *   "locating"    opted in, waiting for the first fix
 *   "on"          pos is usable for walk times
 *   "inaccurate"  latest fix is worse than MAX_LOCATION_ACCURACY_M (falls back)
 *   "denied"      permission refused; opt-in has been switched off
 *   "unavailable" no fix / unsupported (falls back; keeps trying while opted in)
 * Returns { enable, disable, refresh, getState }.
 */
export function createLocationTracker(onChange) {
  let state = { status: isLocationOptedIn() ? "locating" : "off", pos: null };
  let inflight = null;

  const emit = (next) => {
    state = next;
    onChange(state);
  };

  async function refresh() {
    if (!isLocationOptedIn()) return;
    if (inflight) return inflight; // don't stack GPS requests
    if (!state.pos) emit({ status: "locating", pos: null });
    inflight = (async () => {
      try {
        const pos = await readPosition();
        emit({ status: pos.accuracy <= MAX_LOCATION_ACCURACY_M ? "on" : "inaccurate", pos });
      } catch (err) {
        if (err && err.code === 1) {
          // PERMISSION_DENIED: respect it and stop asking.
          setOptIn(false);
          emit({ status: "denied", pos: null });
        } else {
          // Timeout / no fix: keep the last good position if we have one.
          emit(state.pos ? { status: state.status, pos: state.pos } : { status: "unavailable", pos: null });
        }
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, LOCATION_REFRESH_MIN * 60 * 1000);

  onChange(state);
  refresh();

  return {
    enable() {
      setOptIn(true);
      refresh();
    },
    disable() {
      setOptIn(false);
      emit({ status: "off", pos: null });
    },
    refresh,
    getState: () => state,
  };
}

/** Position to use for walk times, or null to fall back to walk_min. */
export function usablePosition(state) {
  return state.status === "on" ? state.pos : null;
}
