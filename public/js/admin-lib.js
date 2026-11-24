// admin-lib.js — pure helpers for the admin dashboard (no DOM, no Firebase),
// unit-tested in tests/admin-lib.test.js.

import { MENU_SOURCES } from "./config.js";
import { toMillis } from "./status-engine.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Turn a name into a stable id fragment: "Masala Dosa (Ghee)" -> "masala-dosa-ghee". */
export function slugify(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Deterministic menu item id, so re-adding the same item can't create duplicates. */
export function menuItemId(cafeId, name) {
  return `${cafeId}--${slugify(name)}`;
}

/** RFC 4180 CSV: quote every field that needs it, CRLF line endings. */
export function toCsv(rows, columns) {
  const cell = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Local-midnight timestamp (ms) for "today" in the admin's own timezone. */
export function startOfDay(nowMs) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Adoption stats, computed client-side.
 * @param reports [{cafe_id, created_at}] — at least the last 7 days
 * @param cafes   [{id, name, active}]
 * @returns { perCafe: [{id, name, today, week, fresh}], today, week, freshPct, activeCafes }
 */
export function cafeStats(reports, cafes, nowMs, staleMin) {
  const today0 = startOfDay(nowMs);
  const week0 = nowMs - 7 * DAY_MS;
  const fresh0 = nowMs - staleMin * 60 * 1000;
  const per = new Map(cafes.map((c) => [c.id, { id: c.id, name: c.name, active: c.active !== false, today: 0, week: 0, fresh: false }]));
  let today = 0;
  let week = 0;
  for (const r of reports) {
    const t = toMillis(r.created_at);
    if (!Number.isFinite(t) || t < week0) continue;
    const row = per.get(r.cafe_id);
    week += 1;
    if (row) row.week += 1;
    if (t >= today0) {
      today += 1;
      if (row) row.today += 1;
    }
    if (row && t >= fresh0) row.fresh = true;
  }
  const active = [...per.values()].filter((r) => r.active);
  const freshPct = active.length ? Math.round((100 * active.filter((r) => r.fresh).length) / active.length) : 0;
  return { perCafe: [...per.values()], today, week, freshPct, activeCafes: active.length };
}

/**
 * Turn raw OCR text from a menu photo into candidate item NAMES (a draft only).
 * Drops numbering ("12."), leader dots, prices ("70/-", "80/90/100", "Rs 50"),
 * very short lines and duplicates. Never invents anything: every name is a
 * cleaned-up line of the photo's own text.
 */
export function parseOcrLines(text) {
  const seen = new Set();
  const out = [];
  for (let line of String(text || "").split(/\r?\n/)) {
    line = line
      .replace(/^\s*\d{1,3}\s*[.)\-:]\s*/, "")              // "1." / "12)" numbering
      .replace(/[.·…_]{2,}.*$/, "")                          // leader dots and whatever follows (the price)
      .replace(/(rs\.?|₹)\s*\d+.*$/i, "")                    // "Rs 50"
      .replace(/\s+\d{1,4}(\s*\/\s*\d{1,4})*\s*\/?-?\s*$/, "") // trailing "70", "70/-", "80/90/100"
      .replace(/\s{2,}/g, " ")
      .trim();
    if ((line.match(/[a-z]/gi) || []).length < 3) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= 200) break;
  }
  return out;
}

/** Problems with a cafe record before saving (mirrors firestore.rules). */
export function cafeErrors(c) {
  const errs = [];
  const num = (k, lo, hi) => {
    if (typeof c[k] !== "number" || !Number.isFinite(c[k]) || c[k] < lo || c[k] > hi) errs.push(`${k} must be a number from ${lo} to ${hi}.`);
  };
  if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 60) errs.push("name is required (max 60 characters).");
  if (!["canteen", "cafe"].includes(c.type)) errs.push('type must be "canteen" or "cafe".');
  num("lat", -90, 90);
  num("lng", -180, 180);
  num("geofence_m", 10, 500);
  num("walk_min", 0, 60);
  num("service_sec_per_person", 5, 600);
  if (c.location_desc != null && (typeof c.location_desc !== "string" || c.location_desc.length > 120)) errs.push("location_desc max 120 characters.");
  return errs;
}

/** Problems with a menu item before saving (mirrors firestore.rules). */
export function itemErrors(it) {
  const errs = [];
  if (typeof it.name !== "string" || !it.name.trim() || it.name.length > 80) errs.push("Name is required (max 80 characters).");
  if (typeof it.prep_min !== "number" || !Number.isFinite(it.prep_min) || it.prep_min < 0 || it.prep_min > 60)
    errs.push("Prep time must be a real number of minutes from 0 to 60 (time it, or ask the vendor).");
  if (!Object.keys(MENU_SOURCES).includes(it.source)) errs.push("Source must be vendor, observed or estimate.");
  if (typeof it.available !== "boolean") errs.push("Available must be yes/no.");
  if (it.category != null && (typeof it.category !== "string" || it.category.length > 40)) errs.push("Category max 40 characters.");
  return errs;
}
