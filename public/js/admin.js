// admin.js — protected admin dashboard.
//
// Access: Firebase Email/Password sign-in (free on Spark). Accounts are created
// by the project owner in the Firebase console; an `admins/{uid}` document marks
// who is an admin. This page checks that document BEFORE loading any admin
// data, and firestore.rules enforce the same check on every admin write (and on
// reading feedback), so hiding the UI is not the only protection.
//
// Sections: a) global settings  b) cafes  c) menu + prep times (+ OCR draft)
//           d) stats  e) CSV export.  Every write goes straight to Firestore and
// open student apps pick it up live.

import { getFirebase, registerServiceWorker } from "./firebase-init.js";
import { DEFAULT_SETTINGS, SETTINGS_LIMITS, MENU_SOURCES } from "./config.js";
import { normaliseSettings, settingsErrors } from "./settings.js";
import { esc } from "./ui.js";
import { toCsv, cafeStats, parseOcrLines, cafeErrors, itemErrors, menuItemId, slugify } from "./admin-lib.js";

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const SECTIONS = ["a-loading", "a-login", "a-denied", "a-admin"];
const show = (id) => SECTIONS.forEach((s) => ($(s).hidden = s !== id));
const say = (el, text, ok = true) => {
  el.textContent = text;
  el.className = ok ? "msg-ok" : "msg-err";
};

let fb = null;        // { db, auth, authMod, fs }
let me = null;        // signed-in admin user
let cafes = [];       // all cafes, including inactive
let settings = normaliseSettings(null);
let unsubs = [];      // admin listeners, torn down on sign-out

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
async function main() {
  try {
    fb = await getFirebase();
  } catch (err) {
    show("a-login");
    say($("login-msg"), String(err.message || err), false);
    return;
  }
  const { auth, authMod, db, fs } = fb;

  authMod.onAuthStateChanged(auth, async (user) => {
    unsubs.forEach((u) => u());
    unsubs = [];
    me = null;
    $("who").textContent = "";
    $("sign-out").hidden = true;
    // Anonymous (student) sessions are not admin sessions.
    if (!user || user.isAnonymous) {
      show("a-login");
      return;
    }
    $("who").textContent = user.email || "";
    $("sign-out").hidden = false;
    show("a-loading");
    let isAdmin = false;
    try {
      isAdmin = (await fs.getDoc(fs.doc(db, "admins", user.uid))).exists(); // rules: you may only read your own
    } catch (err) {
      console.warn("Admin check failed:", err);
    }
    if (!isAdmin) {
      $("denied-uid").textContent = user.uid;
      $("denied-email").textContent = user.email || "your@email";
      show("a-denied");
      return;
    }
    me = user;
    show("a-admin");
    startAdmin();
  });

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    say($("login-msg"), "");
    try {
      await authMod.signInWithEmailAndPassword(auth, $("login-email").value.trim(), $("login-password").value);
      $("login-password").value = "";
    } catch (err) {
      const code = err.code || "";
      say(
        $("login-msg"),
        code === "auth/operation-not-allowed"
          ? "Email/password sign-in isn't enabled for this Firebase project yet (Authentication → Sign-in method)."
          : code === "auth/too-many-requests"
            ? "Too many attempts. Wait a minute and try again."
            : "Wrong email or password.",
        false
      );
    }
  });
  $("sign-out").addEventListener("click", () => authMod.signOut(auth));
}

// ---------------------------------------------------------------------------
// Admin sections
// ---------------------------------------------------------------------------
function startAdmin() {
  const { db, fs } = fb;
  buildSettingsForm();

  unsubs.push(
    fs.onSnapshot(fs.doc(db, "settings", "global"), (snap) => {
      settings = normaliseSettings(snap.exists() ? snap.data() : null);
      $("settings-source").textContent = snap.exists()
        ? "Loaded from Firestore (settings/global)."
        : "No settings document yet: the apps are using the built-in defaults shown below. Save to create it.";
      if (!$("settings-form").dataset.dirty) fillSettingsForm(settings);
    })
  );

  unsubs.push(
    fs.onSnapshot(fs.collection(db, "cafes"), (snap) => {
      cafes = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      renderCafes();
      renderMenuCafePicker();
    })
  );

  $("menu-cafe").addEventListener("change", watchMenu);
  $("item-form").addEventListener("submit", addItem);
  $("ocr-file").addEventListener("change", runOcr);
  $("stats-refresh").addEventListener("click", refreshStats);
  $("export-reports").addEventListener("click", exportReports);
  $("export-feedback").addEventListener("click", exportFeedback);
  refreshStats();
}

// ---------- a) settings ----------
const SETTING_LABELS = {
  green_max: "Green if queue ≤",
  yellow_max: "Yellow if queue ≤ (else red)",
  prep_buffer_min: "Generic prep time (min)",
  cooldown_min: "Report cooldown (min)",
  stale_min: "Reports count for (min)",
  outlier_cap: "Ignore single counts above",
  eating_buffer_min: "Eating time (min)",
  congestion_factor: "Congestion × when packed",
};

function buildSettingsForm() {
  const form = $("settings-form");
  form.innerHTML = Object.entries(SETTINGS_LIMITS)
    .map(([key, [lo, hi, intOnly]]) => `
      <label>${esc(SETTING_LABELS[key] || key)}
        <input name="${key}" type="number" min="${lo}" max="${hi}" step="${intOnly ? 1 : 0.1}" required>
        <span class="hint">${key} · ${lo}–${hi} · default ${DEFAULT_SETTINGS[key]}</span>
      </label>`)
    .join("");
  form.addEventListener("input", () => (form.dataset.dirty = "1"));
  $("settings-defaults").addEventListener("click", () => {
    fillSettingsForm(DEFAULT_SETTINGS);
    form.dataset.dirty = "1";
  });
  $("settings-save").addEventListener("click", saveSettings);
}

function fillSettingsForm(s) {
  for (const key of Object.keys(SETTINGS_LIMITS)) $("settings-form").elements[key].value = s[key];
}

async function saveSettings() {
  const { db, fs } = fb;
  const form = $("settings-form");
  const values = {};
  for (const key of Object.keys(SETTINGS_LIMITS)) values[key] = Number(form.elements[key].value);
  const errs = settingsErrors(values);
  if (errs.length) return say($("settings-msg"), errs.join(" "), false);
  try {
    await fs.setDoc(fs.doc(db, "settings", "global"), { ...values, updated_at: fs.serverTimestamp(), updated_by: me.uid });
    delete form.dataset.dirty;
    say($("settings-msg"), "Saved. Open apps are using the new settings now.");
  } catch (err) {
    say($("settings-msg"), `Not saved: ${err.code || err.message}`, false);
  }
}

// ---------- b) cafes ----------
const CAFE_FIELDS = [
  ["name", "Name", "text"],
  ["location_desc", "Where", "text"],
  ["type", "Type", "type"],
  ["lat", "Latitude", "number", "any"],
  ["lng", "Longitude", "number", "any"],
  ["geofence_m", "Report radius (m)", "number", "1"],
  ["walk_min", "Walk from ref. point (min)", "number", "0.5"],
  ["service_sec_per_person", "Serving time (s / person)", "number", "1"],
  ["active", "Active (shown to students)", "check"],
  ["placeholder", "Some values unmeasured", "check"],
];

function cafeFormHtml(c, isNew = false) {
  const field = ([key, label, kind, step]) => {
    const v = c[key];
    if (kind === "check") {
      const checked = key === "active" ? v !== false : !!v;
      return `<label class="check"><input name="${key}" type="checkbox"${checked ? " checked" : ""}> ${esc(label)}</label>`;
    }
    if (kind === "type") {
      return `<label>${esc(label)}<select name="type">
        <option value="cafe"${v !== "canteen" ? " selected" : ""}>cafe</option>
        <option value="canteen"${v === "canteen" ? " selected" : ""}>canteen</option></select></label>`;
    }
    return `<label>${esc(label)}<input name="${key}" type="${kind}"${step ? ` step="${step}"` : ""} value="${esc(v ?? "")}"></label>`;
  };
  return `
    <form class="grid-form" data-cafe="${esc(c.id || "")}" novalidate>
      ${isNew ? `<label>Id (letters, digits, -)<input name="id" placeholder="e.g. cafe-e" pattern="[a-z0-9-]+"></label>` : ""}
      ${CAFE_FIELDS.map(field).join("")}
    </form>
    <div class="row-actions">
      <button class="btn small" type="button" data-save-cafe="${esc(c.id || "")}">${isNew ? "Add cafe" : "Save cafe"}</button>
      <span data-cafe-msg="${esc(c.id || "")}"></span>
    </div>`;
}

function renderCafes() {
  const list = $("cafe-list");
  // Don't throw away someone's unsaved edits when another change arrives.
  if (list.querySelector("form[data-dirty]")) return;
  list.innerHTML = cafes
    .map((c) => `<div class="cafe-editor"><h3>${esc(c.name)} <span class="hint">(${esc(c.id)}${c.active === false ? ", inactive" : ""})</span></h3>${cafeFormHtml(c)}</div>`)
    .join("");
  if (!$("cafe-new").innerHTML) $("cafe-new").innerHTML = cafeFormHtml({ type: "cafe", geofence_m: 40, walk_min: 5, service_sec_per_person: 45, active: true, placeholder: true }, true);
}

function readCafeForm(form) {
  const v = (k) => form.elements[k];
  const n = (k) => (v(k).value.trim() === "" ? NaN : Number(v(k).value));
  return {
    name: v("name").value.trim(),
    location_desc: v("location_desc").value.trim(),
    type: v("type").value,
    lat: n("lat"),
    lng: n("lng"),
    geofence_m: n("geofence_m"),
    walk_min: n("walk_min"),
    service_sec_per_person: n("service_sec_per_person"),
    active: v("active").checked,
    placeholder: v("placeholder").checked,
  };
}

document.addEventListener("input", (e) => {
  const form = e.target.closest("#cafes form");
  if (form) form.dataset.dirty = "1";
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-save-cafe]");
  if (!btn || !me) return;
  const { db, fs } = fb;
  const isNew = btn.closest("#cafe-new") !== null;
  const form = btn.closest(".row-actions").previousElementSibling;
  const msg = btn.parentElement.querySelector("[data-cafe-msg]");
  const data = readCafeForm(form);
  let id = btn.dataset.saveCafe;
  if (isNew) {
    id = slugify(form.elements.id.value);
    if (!id) return say(msg, "Give the new cafe an id (e.g. cafe-e).", false);
    if (cafes.some((c) => c.id === id)) return say(msg, `A cafe with id "${id}" already exists.`, false);
  }
  const errs = cafeErrors(data);
  if (errs.length) return say(msg, errs.join(" "), false);
  try {
    await fs.setDoc(fs.doc(db, "cafes", id), { ...data, updated_at: fs.serverTimestamp(), updated_by: me.uid });
    delete form.dataset.dirty;
    say(msg, isNew ? `Added "${id}". Print its QR: npm run qr.` : "Saved.");
    if (isNew) $("cafe-new").innerHTML = "";
    renderCafes();
  } catch (err) {
    say(msg, `Not saved: ${err.code || err.message}`, false);
  }
});

// ---------- c) menu ----------
let offMenu = null;
let menuItems = [];

function renderMenuCafePicker() {
  const sel = $("menu-cafe");
  const current = sel.value;
  sel.innerHTML = cafes.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  if (current && cafes.some((c) => c.id === current)) sel.value = current;
  if (!offMenu || current !== sel.value) watchMenu();
}

function watchMenu() {
  const { db, fs } = fb;
  offMenu?.();
  const cafeId = $("menu-cafe").value;
  if (!cafeId) return;
  offMenu = fs.onSnapshot(fs.query(fs.collection(db, "menu_items"), fs.where("cafe_id", "==", cafeId)), (snap) => {
    menuItems = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    renderMenu();
  });
  unsubs.push(() => offMenu?.());
}

function sourceSelect(value) {
  return `<select name="source">${Object.entries(MENU_SOURCES)
    .map(([k, label]) => `<option value="${k}"${k === value ? " selected" : ""}>${esc(label)}</option>`)
    .join("")}</select>`;
}

function renderMenu() {
  const t = $("menu-table");
  if (menuItems.length === 0) {
    t.innerHTML = `<tr><td class="hint">No items yet for this cafe. Add them below. Item names from the menu photos are in
      <code>seed/menus/${esc($("menu-cafe").value)}.json</code>, waiting for real prep times.</td></tr>`;
    return;
  }
  t.innerHTML =
    `<thead><tr><th>Name</th><th>Category</th><th>Prep (min)</th><th>Source</th><th>Available</th><th></th></tr></thead><tbody>` +
    menuItems
      .map((it) => `
        <tr data-item="${esc(it.id)}">
          <td><input name="name" value="${esc(it.name)}" maxlength="80"></td>
          <td><input name="category" value="${esc(it.category ?? "")}" maxlength="40"></td>
          <td><input name="prep_min" type="number" min="0" max="60" step="0.5" value="${esc(it.prep_min)}"></td>
          <td>${sourceSelect(it.source)}</td>
          <td><input name="available" type="checkbox"${it.available !== false ? " checked" : ""} aria-label="Available (untick when sold out)"></td>
          <td style="white-space:nowrap">
            <button class="btn small" type="button" data-act="save">Save</button>
            <button class="btn small secondary" type="button" data-act="delete">Delete</button>
          </td>
        </tr>`)
      .join("") +
    `</tbody>`;
}

function itemFromRow(tr, cafeId) {
  const get = (n) => tr.querySelector(`[name="${n}"]`);
  const category = get("category").value.trim();
  return {
    cafe_id: cafeId,
    name: get("name").value.trim(),
    ...(category ? { category } : {}),
    prep_min: get("prep_min").value === "" ? NaN : Number(get("prep_min").value),
    source: get("source").value,
    available: get("available").checked,
  };
}

$("menu-table").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const { db, fs } = fb;
  const tr = btn.closest("tr[data-item]");
  const id = tr.dataset.item;
  if (btn.dataset.act === "delete") {
    if (!confirm("Delete this menu item? Students will no longer see it.")) return;
    try {
      await fs.deleteDoc(fs.doc(db, "menu_items", id));
      say($("menu-msg"), "Deleted.");
    } catch (err) {
      say($("menu-msg"), `Not deleted: ${err.code || err.message}`, false);
    }
    return;
  }
  const item = itemFromRow(tr, $("menu-cafe").value);
  const errs = itemErrors(item);
  if (errs.length) return say($("menu-msg"), errs.join(" "), false);
  try {
    await fs.setDoc(fs.doc(db, "menu_items", id), { ...item, updated_at: fs.serverTimestamp(), updated_by: me.uid });
    say($("menu-msg"), `Saved "${item.name}".`);
  } catch (err) {
    say($("menu-msg"), `Not saved: ${err.code || err.message}`, false);
  }
});

// Sold-out toggle saves immediately (the most common quick edit).
$("menu-table").addEventListener("change", async (e) => {
  if (e.target.name !== "available") return;
  const { db, fs } = fb;
  const tr = e.target.closest("tr[data-item]");
  try {
    await fs.updateDoc(fs.doc(db, "menu_items", tr.dataset.item), { available: e.target.checked, updated_at: fs.serverTimestamp(), updated_by: me.uid });
    say($("menu-msg"), e.target.checked ? "Marked available." : "Marked sold out (hidden from students).");
  } catch (err) {
    say($("menu-msg"), `Not saved: ${err.code || err.message}`, false);
  }
});

async function addItem(e) {
  e.preventDefault();
  const { db, fs } = fb;
  const cafeId = $("menu-cafe").value;
  const category = $("item-category").value.trim();
  const item = {
    cafe_id: cafeId,
    name: $("item-name").value.trim(),
    ...(category ? { category } : {}),
    prep_min: $("item-prep").value === "" ? NaN : Number($("item-prep").value),
    source: $("item-source").value,
    available: $("item-available").checked,
  };
  const errs = itemErrors(item);
  if (errs.length) return say($("menu-msg"), errs.join(" "), false);
  const id = menuItemId(cafeId, item.name);
  if (menuItems.some((it) => it.id === id)) return say($("menu-msg"), `"${item.name}" is already on this menu; edit it in the table.`, false);
  try {
    await fs.setDoc(fs.doc(db, "menu_items", id), { ...item, updated_at: fs.serverTimestamp(), updated_by: me.uid });
    say($("menu-msg"), `Added "${item.name}".`);
    $("item-form").reset();
    $("item-available").checked = true;
  } catch (err) {
    say($("menu-msg"), `Not added: ${err.code || err.message}`, false);
  }
}

// OCR draft: names only, reviewed by a human, never saved automatically.
const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TESSERACT_URL;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error("Couldn't load the OCR library (are you offline?)."));
    document.head.appendChild(s);
  });
}

async function runOcr(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const msg = $("ocr-msg");
  $("ocr-lines").innerHTML = "";
  msg.textContent = "Loading the OCR library (first time can take ~10 s)…";
  try {
    const Tesseract = await loadTesseract();
    const { data } = await Tesseract.recognize(file, "eng", {
      logger: (m) => {
        if (m.status === "recognizing text") msg.textContent = `Reading the photo… ${Math.round(m.progress * 100)}%`;
      },
    });
    const lines = parseOcrLines(data.text);
    msg.textContent = lines.length
      ? `Draft: ${lines.length} possible item names. Tap one to copy it into "Add item", then check it and add the prep time.`
      : "No item names recognised. Try a sharper, straight-on photo.";
    $("ocr-lines").innerHTML = lines.map((l) => `<button class="chip" type="button">${esc(l)}</button>`).join("");
  } catch (err) {
    msg.textContent = String(err.message || err);
  }
}
$("ocr-lines").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  $("item-name").value = b.textContent;
  $("item-prep").focus();
});

// ---------- d) stats ----------
async function refreshStats() {
  const { db, fs } = fb;
  const out = $("stats-out");
  out.textContent = "Loading…";
  try {
    const since = fs.Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [weekSnap, totalReports, totalFeedback] = await Promise.all([
      fs.getDocs(fs.query(fs.collection(db, "reports"), fs.where("created_at", ">=", since))),
      fs.getCountFromServer(fs.collection(db, "reports")),
      fs.getCountFromServer(fs.collection(db, "feedback")),
    ]);
    const reports = weekSnap.docs.map((d) => ({ cafe_id: d.get("cafe_id"), created_at: d.get("created_at") }));
    const s = cafeStats(reports, cafes, Date.now(), settings.stale_min);
    const labels = totalFeedback.data().count;
    out.innerHTML = `
      <div class="stat-tiles">
        <div class="stat-tile"><b>${totalReports.data().count}</b>reports, all time</div>
        <div class="stat-tile"><b>${s.today}</b>reports today</div>
        <div class="stat-tile"><b>${s.week}</b>reports, last 7 days</div>
        <div class="stat-tile"><b>${s.freshPct}%</b>of ${s.activeCafes} active cafes have a fresh report now</div>
        <div class="stat-tile"><b>${labels}</b>feedback answers (ML labels; ~150–200 needed before training)</div>
      </div>
      <div class="table-wrap" style="margin-top:12px"><table class="data">
        <thead><tr><th>Cafe</th><th>Today</th><th>Last 7 days</th><th>Fresh now</th></tr></thead>
        <tbody>${s.perCafe
          .map((r) => `<tr><td>${esc(r.name)}${r.active ? "" : " (inactive)"}</td><td>${r.today}</td><td>${r.week}</td><td>${r.fresh ? "✓ yes" : "– no"}</td></tr>`)
          .join("")}</tbody></table></div>
      <p class="hint">"Fresh" = a report in the last ${settings.stale_min} min. Updated ${new Date().toLocaleTimeString()}.</p>`;
  } catch (err) {
    out.textContent = `Couldn't load stats: ${err.code || err.message}`;
  }
}

// ---------- e) CSV export ----------
const iso = (ts) => (ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : "");

function download(name, csv) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportReports() {
  const { db, fs } = fb;
  const days = Math.min(365, Math.max(1, Number($("export-days").value) || 30));
  say($("export-msg"), "Exporting…");
  try {
    const since = fs.Timestamp.fromMillis(Date.now() - days * 24 * 60 * 60 * 1000);
    const snap = await fs.getDocs(fs.query(fs.collection(db, "reports"), fs.where("created_at", ">=", since), fs.orderBy("created_at", "asc")));
    const names = Object.fromEntries(cafes.map((c) => [c.id, c.name]));
    const rows = snap.docs.map((d) => ({
      id: d.id,
      cafe_id: d.get("cafe_id"),
      cafe_name: names[d.get("cafe_id")] ?? "",
      queue_count: d.get("queue_count") ?? "",
      level: d.get("level"),
      created_at: iso(d.get("created_at")),
      gps_accuracy_m: d.get("acc") ?? "",
    }));
    download(`cafeq-reports-last-${days}d.csv`, toCsv(rows, ["id", "cafe_id", "cafe_name", "queue_count", "level", "created_at", "gps_accuracy_m"]));
    say($("export-msg"), `Exported ${rows.length} reports.`);
  } catch (err) {
    say($("export-msg"), `Export failed: ${err.code || err.message}`, false);
  }
}

/** Columns = exactly what scripts/ml/train.py reads. source="real" marks genuine answers. */
export const FEEDBACK_COLUMNS = [
  "source", "id", "cafe_id", "cafe_name", "cafe_type", "service_sec_per_person",
  "item_id", "item_name", "item_prep_min", "queue_count_at_report", "est_total_min",
  "actual_total_min", "started_at", "created_at",
];

async function exportFeedback() {
  const { db, fs } = fb;
  say($("export-msg"), "Exporting…");
  try {
    const [snap, menuSnap] = await Promise.all([
      fs.getDocs(fs.query(fs.collection(db, "feedback"), fs.orderBy("created_at", "asc"))),
      fs.getDocs(fs.collection(db, "menu_items")),
    ]);
    const cafeById = Object.fromEntries(cafes.map((c) => [c.id, c]));
    const itemById = Object.fromEntries(menuSnap.docs.map((d) => [d.id, d.data()]));
    const rows = snap.docs.map((d) => {
      const f = d.data();
      const cafe = cafeById[f.cafe_id] || {};
      const item = f.item_id ? itemById[f.item_id] : null;
      return {
        source: "real",
        id: d.id,
        cafe_id: f.cafe_id,
        cafe_name: cafe.name ?? "",
        cafe_type: cafe.type ?? "",
        service_sec_per_person: cafe.service_sec_per_person ?? "",
        item_id: f.item_id ?? "",
        item_name: item?.name ?? "",
        // the prep time recorded at the visit wins; else today's menu value
        item_prep_min: f.item_prep_min ?? item?.prep_min ?? "",
        queue_count_at_report: f.queue_count_at_report ?? "",
        est_total_min: f.est_total_min ?? "",
        actual_total_min: f.actual_total_min,
        started_at: iso(f.started_at),
        created_at: iso(f.created_at),
      };
    });
    download("cafeq-feedback.csv", toCsv(rows, FEEDBACK_COLUMNS));
    say($("export-msg"), `Exported ${rows.length} feedback answers.`);
  } catch (err) {
    say($("export-msg"), `Export failed: ${err.code || err.message}`, false);
  }
}

main();
