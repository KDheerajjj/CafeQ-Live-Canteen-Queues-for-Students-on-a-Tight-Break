// data.js — the only module that talks to Firestore for reading live data.
// Shared by the dashboard and the worth-it checker so both see identical numbers.
//
// Cost design (free Spark plan): ONE realtime listener on `cafes` and ONE on
// recent `reports` (all cafes together, last 15 min only). Grouping per cafe
// and all aggregation happen in the browser (status-engine.js) — no Cloud
// Functions, so nothing here needs billing.

import { getFirebase } from "./firebase-init.js";
import { computeStatus, groupByCafe } from "./status-engine.js";
import { STATUS_WINDOW_MIN } from "./config.js";

const MIN_MS = 60 * 1000;
// Firestore can't express "the last 15 minutes" as a moving window, so the
// listener uses a fixed start time and is re-created every few minutes to
// keep the result set small. The status engine still filters exactly by time.
const RESUBSCRIBE_MS = 5 * MIN_MS;
// Re-render periodically so "updated N min ago" and staleness stay correct
// even when no new report arrives.
const TICK_MS = 30 * 1000;

/** Convert a report snapshot to a plain object. Pending server timestamps
 * (our own just-written report) use the SDK's local estimate. */
export function reportFromDoc(d) {
  return {
    id: d.id,
    cafe_id: d.get("cafe_id"),
    level: d.get("level"),
    created_at: d.get("created_at", { serverTimestamps: "estimate" }),
  };
}

/**
 * Subscribe to every cafe plus its live computed status.
 * Calls onUpdate({ cafes, rows: [{ cafe, status }] }) on every change and tick.
 * Calls onError(err) if Firestore fails. Returns an unsubscribe function.
 */
export async function watchLiveStatuses(onUpdate, onError) {
  const { db, fs } = await getFirebase();
  let cafes = null; // null = not loaded yet
  let reports = [];
  let offReports = () => {};

  const emit = () => {
    if (!cafes) return;
    const now = Date.now();
    const byCafe = groupByCafe(reports);
    const rows = cafes.map((cafe) => ({ cafe, status: computeStatus(byCafe[cafe.id] || [], now) }));
    onUpdate({ cafes, rows });
  };

  const offCafes = fs.onSnapshot(
    fs.collection(db, "cafes"),
    (snap) => {
      cafes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      emit();
    },
    onError
  );

  const subscribeReports = () => {
    offReports();
    const since = fs.Timestamp.fromMillis(Date.now() - STATUS_WINDOW_MIN * MIN_MS);
    const q = fs.query(
      fs.collection(db, "reports"),
      fs.where("created_at", ">=", since),
      fs.orderBy("created_at", "desc")
    );
    offReports = fs.onSnapshot(
      q,
      (snap) => {
        reports = snap.docs.map(reportFromDoc);
        emit();
      },
      onError
    );
  };
  subscribeReports();

  const resub = setInterval(subscribeReports, RESUBSCRIBE_MS);
  const tick = setInterval(emit, TICK_MS);

  return () => {
    offCafes();
    offReports();
    clearInterval(resub);
    clearInterval(tick);
  };
}
