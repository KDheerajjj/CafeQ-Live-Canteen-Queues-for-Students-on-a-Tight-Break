// ui.js — tiny DOM helpers shared by the three pages. No logic lives here.

import { LEVELS } from "./config.js";

/** Escape text for safe insertion into innerHTML (cafe names come from Firestore). */
export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const levelLabel = (level) => (LEVELS[level] || LEVELS.unknown).label;

/** "just now" / "1 min ago" / "7 min ago". */
export function minutesAgo(n) {
  if (n == null) return "";
  if (n < 1) return "just now";
  return `${n} min ago`;
}

/** Wait text. Always says "est." — these are placeholders until the ML phase. */
export function waitText(waitMin) {
  return waitMin == null ? "Wait unknown" : `~${waitMin} min wait (est.)`;
}

/** "~4 in line" from a (possibly fractional) median queue count. */
export function queueText(count) {
  return count == null ? "" : `~${Math.round(count)} in line`;
}

/** Show a friendly notice in place of the page content (setup / errors). */
export function showNotice(container, title, body) {
  container.innerHTML = `<div class="notice" role="status"><strong>${esc(title)}</strong><p>${esc(body)}</p></div>`;
}

/** Human message for a Firestore / Firebase error. */
export function describeError(err) {
  const msg = String(err?.message || err);
  if (msg.includes("not configured")) return ["Setup needed", msg];
  if (err?.code === "permission-denied") return ["Access denied", "Firestore rules rejected the request. Have the rules been deployed?"];
  if (err?.code === "failed-precondition" && msg.includes("index")) return ["Index building", "A Firestore index is still being created. Try again in a few minutes."];
  if (err?.code === "unavailable") return ["You're offline", "Can't reach the server right now. Showing what we have."];
  return ["Something went wrong", msg];
}
