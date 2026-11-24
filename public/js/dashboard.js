// dashboard.js — student view: live cards for every cafe.
//
// Data flow:  Firestore (cafes + last-15-min reports, realtime)
//             -> data.js -> status-engine.js (computeStatus per cafe)
//             -> sortForDashboard -> render cards.

import { registerServiceWorker } from "./firebase-init.js";
import { watchLiveStatuses } from "./data.js";
import { sortForDashboard } from "./status-engine.js";
import { esc, levelLabel, minutesAgo, waitText, showNotice, describeError } from "./ui.js";

registerServiceWorker();

// TODO(phase-2-notify): FCM "remind me before my break" push notifications.

const $ = (id) => document.getElementById(id);
const cardsEl = $("cards");
const liveEl = $("live");

function confidenceBadge(status) {
  if (status.status === "unknown") return `<span class="badge need">Needs a report</span>`;
  if (status.confidence === "high") return `<span class="badge high">High confidence</span>`;
  return `<span class="badge low">Low confidence</span>`;
}

function cardHtml({ cafe, status }) {
  const known = status.status !== "unknown";
  const reports = known ? `${status.reportCount} report${status.reportCount === 1 ? "" : "s"}` : "";
  return `
    <li class="card ${known ? "" : "is-unknown"}">
      <div class="card-head">
        <span class="dot ${esc(status.status)}" aria-hidden="true"></span>
        <span class="card-name">${esc(cafe.name)}</span>
        <span class="card-status">${esc(levelLabel(status.status))}</span>
      </div>
      <div class="card-meta">
        <span>${esc(waitText(status.waitMin))}</span>
        <span>🚶 ${esc(cafe.walk_min)} min walk</span>
        ${known ? `<span>updated ${esc(minutesAgo(status.updatedMinAgo))} · ${reports}</span>` : `<span>no report in the last 15 min</span>`}
      </div>
      <div class="card-foot">
        ${confidenceBadge(status)}
        <a class="card-link" href="./report.html?cafe=${encodeURIComponent(cafe.id)}">I'm here — report</a>
      </div>
    </li>`;
}

function render({ cafes, rows }) {
  $("loading").hidden = true;
  liveEl.textContent = "live";
  liveEl.classList.remove("off");
  $("placeholder-banner").hidden = !cafes.some((c) => c.placeholder);

  if (cafes.length === 0) {
    showNotice($("notice"), "No cafes yet", "The cafes list is empty. Run `npm run seed` to load seed/cafes.json.");
    return;
  }
  $("notice").innerHTML = "";
  $("empty").hidden = !rows.every((r) => r.status.status === "unknown");
  cardsEl.innerHTML = sortForDashboard(rows).map(cardHtml).join("");
}

function fail(err) {
  console.error(err);
  $("loading").hidden = true;
  liveEl.textContent = "offline";
  liveEl.classList.add("off");
  // Keep last-rendered cards if we have them; otherwise explain.
  if (!cardsEl.children.length) {
    const [title, body] = describeError(err);
    showNotice($("notice"), title, body);
  }
}

watchLiveStatuses(render, fail).catch(fail);
