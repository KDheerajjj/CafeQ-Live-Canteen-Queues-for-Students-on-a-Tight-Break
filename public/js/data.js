// data.js — the only module that reads live data for the student pages.
// Shared by the dashboard and the worth-it checker so both see identical numbers.
//
// Listeners (free Spark plan, all aggregation in the browser, no Cloud Functions):
//   settings/global   admin-tunable numbers (thresholds, buffers, windows...)
//   cafes             cafe config (inactive cafes are hidden from students)
//   reports           last `stale_min` minutes only, all cafes together
//   menu_items        the per-cafe menus with prep times (small collection)
// Everything is recomputed on any change, so an admin edit shows up live.

import { getFirebase } from "./firebase-init.js";
import { computeStatus, groupByCafe } from "./status-engine.js";
import { watchSettings, engineOpts, normaliseSettings } from "./settings.js";

const MIN_MS = 60 * 1000;
// Firestore can't express "the last N minutes" as a moving window, so the
// reports listener uses a fixed start time and is re-created every few minutes
// (and whenever stale_min changes). The status engine still filters exactly.
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
    queue_count: d.get("queue_count") ?? null, // missing on old colour-only reports
    created_at: d.get("created_at", { serverTimestamps: "estimate" }),
  };
}

/** Group menu items by cafe, sorted by name. Includes sold-out items (flag: available). */
export function menuByCafe(items) {
  const out = {};
  for (const it of items) (out[it.cafe_id] ||= []).push(it);
  for (const list of Object.values(out)) list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return out;
}

/**
 * Subscribe to everything a student page needs.
 * onUpdate({ cafes, rows: [{ cafe, status }], settings, menu }) fires on every
 * change and every 30 s. onError(err) if Firestore fails. Returns unsubscribe.
 */
export async function watchLiveStatuses(onUpdate, onError) {
  const { db, fs } = await getFirebase();
  let settings = normaliseSettings(null);
  let cafes = null; // null = not loaded yet
  let reports = [];
  let menu = {};
  let offReports = () => {};
  let windowMin = null;

  const emit = () => {
    if (!cafes) return;
    const now = Date.now();
    const byCafe = groupByCafe(reports);
    const active = cafes.filter((c) => c.active !== false); // missing = active
    const rows = active.map((cafe) => ({
      cafe,
      status: computeStatus(byCafe[cafe.id] || [], now, engineOpts(settings, cafe)),
    }));
    onUpdate({ cafes: active, rows, settings, menu });
  };

  const subscribeReports = () => {
    offReports();
    windowMin = settings.stale_min;
    const since = fs.Timestamp.fromMillis(Date.now() - windowMin * MIN_MS);
    const q = fs.query(fs.collection(db, "reports"), fs.where("created_at", ">=", since), fs.orderBy("created_at", "desc"));
    offReports = fs.onSnapshot(
      q,
      (snap) => {
        reports = snap.docs.map(reportFromDoc);
        emit();
      },
      onError
    );
  };

  const offSettings = await watchSettings((s) => {
    settings = s;
    if (windowMin !== s.stale_min) subscribeReports(); // window changed -> re-query
    else emit();
  });

  const offCafes = fs.onSnapshot(
    fs.collection(db, "cafes"),
    (snap) => {
      cafes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      emit();
    },
    onError
  );

  const offMenu = fs.onSnapshot(
    fs.collection(db, "menu_items"),
    (snap) => {
      menu = menuByCafe(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      emit();
    },
    (err) => console.warn("Menu unavailable:", err) // menus are optional; don't break the page
  );

  if (windowMin === null) subscribeReports();
  const resub = setInterval(subscribeReports, RESUBSCRIBE_MS);
  const tick = setInterval(emit, TICK_MS);

  return () => {
    offSettings();
    offCafes();
    offMenu();
    offReports();
    clearInterval(resub);
    clearInterval(tick);
  };
}
