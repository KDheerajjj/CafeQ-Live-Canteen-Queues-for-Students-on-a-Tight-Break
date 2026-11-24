// feedback.js — "How long did it actually take?" (the ONLY source of ML labels).
//
// Flow: on "Will I make it?", a student taps "I'm going" on a cafe. We remember
// that visit on this device (cafe, item, queue size and our estimate at that
// moment). Next time they open CafeQ — at least FEEDBACK_ASK_AFTER_MIN minutes
// later and within FEEDBACK_FORGET_AFTER_MIN — a card asks one optional,
// one-tap question. The answer becomes a `feedback` doc:
//   { cafe_id, item_id?, item_prep_min?, queue_count_at_report?, est_total_min?,
//     actual_total_min, started_at?, created_at, uid }
// actual_total_min = minutes from joining the line to having the food.
// Without these real answers there is no model; nothing is ever made up.

import { ensureAnonUser, getFirebase } from "./firebase-init.js";
import { FEEDBACK_CHOICES, FEEDBACK_ASK_AFTER_MIN, FEEDBACK_FORGET_AFTER_MIN } from "./config.js";
import { esc } from "./ui.js";

const KEY = "cafeq.pendingVisit";
const MIN_MS = 60 * 1000;

function readPending() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    return null;
  }
}
function clearPending() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Remember "I'm going to <cafe>" so we can ask how it went later. */
export function rememberVisit({ cafe, item, status, est }) {
  const visit = {
    cafe_id: cafe.id,
    cafe_name: cafe.name,
    item_id: item?.id ?? null,
    item_name: item?.name ?? null,
    item_prep_min: item?.prep_min ?? null,
    queue_count: status?.queueCount != null ? Math.round(status.queueCount) : null,
    est_total_min: est?.min ?? null,
    started_at: Date.now(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(visit));
  } catch {
    /* storage blocked: no follow-up question, that's fine */
  }
  return visit;
}

/** Is there a visit old enough to ask about (and not too old to remember)? */
export function pendingVisitToAsk(now = Date.now()) {
  const v = readPending();
  if (!v || !v.cafe_id || !Number.isFinite(v.started_at)) return null;
  const age = now - v.started_at;
  if (age > FEEDBACK_FORGET_AFTER_MIN * MIN_MS) {
    clearPending();
    return null;
  }
  return age >= FEEDBACK_ASK_AFTER_MIN * MIN_MS ? v : null;
}

async function submitFeedback(v, actualMin) {
  const uid = await ensureAnonUser();
  const { db, fs } = await getFirebase();
  const doc = {
    cafe_id: v.cafe_id,
    actual_total_min: actualMin,
    uid,
    created_at: fs.serverTimestamp(),
    started_at: fs.Timestamp.fromMillis(v.started_at),
  };
  // Optional context, only when known (rules validate each one).
  if (v.item_id) doc.item_id = v.item_id;
  if (typeof v.item_prep_min === "number") doc.item_prep_min = v.item_prep_min;
  if (Number.isInteger(v.queue_count)) doc.queue_count_at_report = v.queue_count;
  if (typeof v.est_total_min === "number") doc.est_total_min = v.est_total_min;
  await fs.addDoc(fs.collection(db, "feedback"), doc);
}

/** Render the follow-up card into `container` if there's a visit to ask about. */
export function mountFeedbackPrompt(container) {
  const v = pendingVisitToAsk();
  if (!v || !container) return;
  const what = v.item_name ? ` (${esc(v.item_name)})` : "";
  container.innerHTML = `
    <div class="feedback-card" role="region" aria-label="Quick question">
      <strong>How long did ${esc(v.cafe_name)}${what} actually take?</strong>
      <p>From joining the line to having your food. One tap, optional; it makes the estimates better.</p>
      <div class="chips">
        ${FEEDBACK_CHOICES.map((m, i) => `<button class="chip" type="button" data-min="${m}">${m}${i === FEEDBACK_CHOICES.length - 1 ? "+" : ""} min</button>`).join("")}
        <button class="chip" type="button" data-skip="1">Didn't go</button>
      </div>
      <p class="hint" data-msg></p>
    </div>`;
  container.onclick = async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const msg = container.querySelector("[data-msg]");
    if (btn.dataset.skip) {
      clearPending();
      container.innerHTML = "";
      return;
    }
    container.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await submitFeedback(v, Number(btn.dataset.min));
      clearPending();
      container.innerHTML = `<div class="feedback-card"><strong>Thanks! 🙏</strong><p>That helps CafeQ learn real waiting times.</p></div>`;
    } catch (err) {
      console.error(err);
      msg.textContent = "Couldn't send right now. We'll ask again next time.";
      container.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  };
}
