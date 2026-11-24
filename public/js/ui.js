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

/** Status as icon + text (+ colour as a third, optional cue). Colour-blind safe. */
export function statusLabelHtml(level) {
  const l = LEVELS[level] || LEVELS.unknown;
  return `<span class="status-label ${esc(level)}"><span class="icon" aria-hidden="true">${l.icon}</span>${esc(l.label)}</span>`;
}

/** Estimate text with its method, e.g. "~9 min for Masala Dosa (est.)". */
export function estimateText(est, item) {
  if (!est || est.min == null) return "Wait unknown";
  const what = item ? ` for ${item.name}` : " wait";
  const how = est.method === "model" ? "est., ML model" : est.method === "fallback" ? "rough est." : "est.";
  return `~${est.min} min${what} (${how})`;
}

// ---------- the student's intended item per cafe (remembered on this device) ----------
const ITEM_KEY = "cafeq.itemChoice";

export function getItemChoices() {
  try {
    return JSON.parse(localStorage.getItem(ITEM_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

export function setItemChoice(cafeId, itemId) {
  const all = getItemChoices();
  if (itemId) all[cafeId] = itemId;
  else delete all[cafeId];
  try {
    localStorage.setItem(ITEM_KEY, JSON.stringify(all));
  } catch {
    /* not remembered; still works for this page view */
  }
}

/**
 * The chosen item for a cafe, but only if it's still on the menu AND available
 * (sold-out items are never used for estimates).
 */
export function chosenItem(cafeId, items) {
  const id = getItemChoices()[cafeId];
  return (items || []).find((it) => it.id === id && it.available !== false) || null;
}

/** "What will you order?" picker. Sold-out items are hidden. Empty menu -> "". */
export function itemSelectHtml(cafe, items, selected) {
  const avail = (items || []).filter((it) => it.available !== false);
  if (avail.length === 0) return "";
  const opts = avail
    .map((it) => `<option value="${esc(it.id)}"${selected && selected.id === it.id ? " selected" : ""}>${esc(it.name)} (~${esc(it.prep_min)} min to make)</option>`)
    .join("");
  return `<label class="item-pick">Your order:
      <select data-item-for="${esc(cafe.id)}" aria-label="What will you order at ${esc(cafe.name)}?">
        <option value="">Not sure / anything quick</option>${opts}
      </select></label>`;
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
