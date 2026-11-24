# CafeQ: Live Canteen Queues for Students on a Tight Break

**Live dashboard: <https://cafeq-8f5a4.web.app>**

CafeQ is a free, installable mobile web app (PWA) that shows **day scholars at RV College of
Engineering** how crowded each campus cafe is right now, so they can choose where to eat in a
short break and still get back to class on time.

The live signal is **crowdsourced**: anyone standing at a cafe scans the QR at the counter and
taps how long the line is (0–2 / 3–5 / 6–10 / 10+, or types the exact number). It takes about
two seconds and needs no login and no app install. **Vendors don't need to do anything.**

> **Status: v3.** Cafe names and counter coordinates are real. Menu item **names** come from photos
> of the boards, but **no prep times have been collected yet**, so the live menus are empty until
> real ones are entered. These are still **placeholders or assumptions**: walk times, the reference
> point, each counter's **serving speed** (`service_sec_per_person`: canteen 60 s, cafes 45 s) and
> the congestion factor (1.2). There is **no trained ML model yet**: estimates come from a
> transparent formula until real feedback exists (see [Formula vs ML](#formula-vs-ml)).

---

## Contents
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Setup (free, about 15 minutes)](#setup-free-about-15-minutes)
- [Deploy](#deploy)
- [Data model](#data-model)
- [Status engine](#status-engine)
- [Walk times from your location](#walk-times-from-your-location)
- [Menu and item-aware estimate](#menu-and-item-aware-estimate)
- ["Will I make it?" maths](#will-i-make-it-maths)
- [Feedback and the ML pipeline](#feedback-and-the-ml-pipeline)
- [Formula vs ML](#formula-vs-ml)
- [Admin dashboard](#admin-dashboard)
- [Theme and accessibility](#theme-and-accessibility)
- [Trust model and its limits (read this)](#trust-model-and-its-limits-read-this)
- [Cost: why this stays free](#cost-why-this-stays-free)
- [Testing](#testing)
- [Future work](#future-work)

---

## How it works

```
 Student at the counter                         Student deciding where to eat
 ─────────────────────                          ────────────────────────────
 scans QR → report.html?cafe=cafe-a             opens index.html / worthit.html
   1. load cafe (name, lat/lng, geofence)         realtime listeners on:
   2. silent anonymous sign-in                      • cafes
   3. cooldown check (3 min / device)               • reports from the last 15 min
   4. GPS → haversine → within geofence?          status-engine.js (in the browser)
   5. tap queue size → append to `reports`         → median queue, colour, est. wait
                │                                  → sorted cards / Go-Risky-Skip
                └──────────► Firestore ◄───────────┘
```

No status is ever stored. Every screen recomputes it from recent reports, so an old status
can't get stuck.

## Project layout

```
public/                    static site: deploys unchanged to Firebase Hosting or Vercel
  index.html               dashboard (view side)
  report.html              report crowd (update side, opened by QR: ?cafe=ID)
  worthit.html             "Will I make it?" checker
  admin.html               protected admin dashboard (settings, cafes, menus, stats, CSV)
  css/styles.css           light/dark theme tokens + all styles
  js/config.js             Firebase web config, static constants, DEFAULTS for live settings
  js/settings.js           live settings/global listener; defaults as fallback (pure helpers)
  js/firebase-init.js      init app, anonymous auth, service-worker registration
  js/status-engine.js      PURE: median queue, colour, confidence, wait, item-aware estimate, verdicts
  js/geo.js                PURE: haversine distance, geofence, walk estimate
  js/location.js           opt-in "use my location" tracker for personal walk times
  js/model.js              loads public/model.json IF a trained model was published (pure tree walker)
  js/feedback.js           "How long did it actually take?" follow-up (the only ML label source)
  js/theme.js              light/dark switch in every header
  js/data.js               shared realtime listeners: settings, cafes, reports, menus
  js/ui.js                 small shared DOM helpers (labels, item picker, notices)
  js/admin.js, admin-lib.js  admin page controller + its pure helpers (CSV, stats, OCR clean-up)
  js/dashboard.js, report.js, worthit.js   page controllers
  manifest.webmanifest, service-worker.js, icons/
assets/icon-source.png     the CafeQ app-icon artwork (source for every icon size)
seed/cafes.json            the campus cafes (walk times + serving speeds still assumptions)
seed/menus/<cafe>.json     menu fill-in templates: names from the menu photos, prep_min EMPTY
scripts/seed-firestore.js  first-time setup: cafes, settings, menu items with real prep times
scripts/make-admin.js      mark an existing email/password user as an admin
scripts/make-qr.js         qr/<cafe>.png + printable qr/posters.html
scripts/make-icons.js      build icons/ (192, 512, maskable 512, apple-touch 180, favicon 32)
scripts/ml/                OFFLINE Python pipeline: baseline vs random forest, model.json export
tests/                     Node unit tests for the pure modules (+ rules/config sync checks)
firestore.rules, firestore.indexes.json, firebase.json, vercel.json
```

There's no framework and no build step. The browser loads the Firebase SDK as ES modules
straight from Google's CDN.

## Setup (free, about 15 minutes)

You need **Node 22.9 or newer** and a Google account. **Do not enable billing anywhere.**

1. **Create a Firebase project** at <https://console.firebase.google.com>. Stay on the
   **Spark (free)** plan and skip Google Analytics.
2. **Enable sign-in methods**: Build → Authentication → Get started → Sign-in method →
   enable **Anonymous** (students) and **Email/Password** (admins only). Both are free on Spark.
3. **Create Firestore**: Build → Firestore Database → Create database → *production mode* →
   pick a region near Bengaluru (e.g. `asia-south1`).
4. **Register a web app**: Project settings → Your apps → `</>` (Web). Copy the `firebaseConfig`
   object into `FIREBASE_CONFIG` in [`public/js/config.js`](public/js/config.js). This config is
   public by design; access is controlled by `firestore.rules`.
5. **Install script dependencies and configure:**
   ```powershell
   npm install
   copy .env.example .env      # then edit FIREBASE_PROJECT_ID and CAFEQ_BASE_URL
   npx firebase-tools login
   npx firebase-tools use --add   # pick your project (writes .firebaserc, which is git-ignored)
   ```
6. **Measure your cafes.** Edit `seed/cafes.json`: stand at each counter and read the GPS lat/lng
   (Google Maps → long-press), time the walk from the reference point, set `geofence_m`,
   and set `"placeholder": false`. Update `REFERENCE_POINT` in `config.js` the same way.
   *Geofence (report radius):* Mingos Canteen **200 m**; Cafe Mingos, M M Foods and M M Foods
   (Library) **70 m** each. These are generous, to allow for indoor GPS error (often 20–50 m), so
   neighbouring zones overlap (the cafes are only 84–123 m apart). A student standing at one
   counter could report for a nearby one, so the QR at each counter is what decides which cafe
   gets the report. Change a radius live on `/admin.html` → Cafes.
7. **Seed the cafes.** `cafes` is read-only to clients, so seeding uses the Admin SDK. Pick one
   of these credential options; **none of them puts a key in the repo**:
   - `gcloud auth application-default login` (no key file), **or**
   - download a service-account key (Project settings → Service accounts), save it **outside
     this folder**, and set `GOOGLE_APPLICATION_CREDENTIALS` in `.env` to its path.
   ```powershell
   npm run seed
   ```
   This creates the cafes, `settings/global` (with the defaults) and any menu items that already
   have a real `prep_min`. It is **create-only**: existing documents are kept, so it never undoes
   admin edits. Use `npm run seed -- --force` to overwrite deliberately.
   No CLI? You can also add the `cafes` documents by hand in the Firestore console, using
   the same ids and fields.
8. **Deploy rules and indexes** (indexes take a few minutes to build):
   ```powershell
   npm run deploy:rules
   ```
9. **Admin setup.** Firebase console → Authentication → Users → **Add user** (the admin chooses
   their own password; never put it in the repo). Then, with the same credentials as seeding:
   ```powershell
   npm run make-admin -- admin@example.com
   ```
   This writes `admins/{uid}`. Without a key you can create that document by hand in the
   Firestore console instead (collection `admins`, document id = the user's UID). Sign in at
   `/admin.html`. Remove an admin with `npm run make-admin -- admin@example.com --remove`.

Local preview: `npm run serve`, then open <http://localhost:5000>. Browsers allow geolocation on
`localhost`, so the report flow works locally too, but your GPS has to be inside a cafe's
geofence.

## Deploy

**Firebase Hosting (free):**
```powershell
npm run deploy:hosting
```
Your app is then live at `https://<project-id>.web.app` over HTTPS, which geolocation and PWA
install both need.

**Vercel (alternative, also free):** import the repo and set the output directory to `public`
(`vercel.json` already does this). No build command. Then add the Vercel domain under Firebase
console → Authentication → Settings → **Authorized domains**.

**QR posters:** set `CAFEQ_BASE_URL` in `.env` to the live HTTPS URL, then:
```powershell
npm run qr
```
This writes `qr/cafe-a.png` and the rest, plus `qr/posters.html`. Open the posters page, print
it, and stick one at each counter.

**Verify on a phone:** open the URL in Android Chrome and confirm the dashboard loads. Use
⋮ → *Install app* and check the home-screen icon is the CafeQ cup tile. Scan a QR at the counter,
allow location, and tap a queue size; the dashboard on another phone should show "~N in line"
within a second or two. Turn on airplane mode and reopen the app: the shell should still load.

**Every deploy that changes the UI or icons: bump the service-worker cache.** Change
`CACHE_VERSION` in `public/service-worker.js` (e.g. `cafeq-cache-v7` → `v8`), and add any new
file to its `SHELL` list. On activate, the worker deletes every cache with a different name.
Without the bump, installed apps keep showing the **old** cached icon and pages. To change the
icon, replace `assets/icon-source.png` (ideally ≥ 1024 px square), run `npm run icons`, then bump.

`firebase.json` also serves every file with `Cache-Control: no-cache`: the browser revalidates
each file with a cheap ETag check instead of reusing it for an hour, which is Firebase Hosting's default. The
service worker precaches with `cache: "reload"`, so a new version never stores a stale file.

## Data model

Who can do what is enforced by `firestore.rules`:

| collection | read | write |
|---|---|---|
| `cafes`, `settings`, `menu_items` | anyone | admins only (shape + range checked) |
| `admins` | your own document only | nobody from the app (`npm run make-admin` / console) |
| `reports` | anyone | any signed-in device, append-only, validated |
| `feedback` | admins only | any signed-in device, append-only, validated |

**`settings/global`**: the live, admin-editable numbers. If the document or a field is missing or
out of range, the app uses `DEFAULT_SETTINGS` from `config.js`.

| field | default | range | meaning |
|---|---|---|---|
| `green_max` | 2 | 0–20 (int) | queue ≤ this → green |
| `yellow_max` | 6 | 1–50 (int), > green_max | queue ≤ this → yellow, above → red |
| `prep_buffer_min` | 1 | 0–15 | generic "make the order" time when no item is picked |
| `cooldown_min` | 3 | 0–30 | one report per device per N minutes |
| `stale_min` | 15 | 5–60 (int) | reports older than this are ignored |
| `outlier_cap` | 50 | 10–100 (int) | single counts above this are ignored |
| `eating_buffer_min` | 5 | 0–30 | "Will I make it?" eating time |
| `congestion_factor` | 1.2 | 1–3 | queue-wait multiplier when red (**assumption**) |
| `updated_at`, `updated_by` | | | set on every admin save |

**`cafes/{id}`**: seeded once, then edited on `/admin.html`.

| field | type | meaning |
|---|---|---|
| *(doc id)* | string | e.g. `cafe-a`; used in QR links |
| `name` | string | display name |
| `type` | `"canteen"` or `"cafe"` | Mingos Canteen is the canteen; the rest are cafes |
| `location_desc` | string | human description of where it is |
| `lat`, `lng` | number | counter location |
| `geofence_m` | number | max distance (m) from which a report is accepted (canteen 200 m, cafes 70 m) |
| `walk_min` | number | typical walk (min) from the day-scholar reference point |
| `service_sec_per_person` | number | seconds the counter takes to serve one person. **ASSUMPTION** (canteen 60, cafes 45), to calibrate |
| `active` | bool | `false` hides the cafe from students (cafes are never deleted) |
| `placeholder` | bool | `true` while data is unmeasured; the UI shows a warning |

**`menu_items/{cafe_id}--{slug}`**: one document per item, edited on `/admin.html`.

| field | type | meaning |
|---|---|---|
| `cafe_id` | string | an existing cafe |
| `name`, `category` | string | category optional |
| `prep_min` | number 0–60 | average minutes to **make one serving**. **Real data only** (vendor or timed) |
| `available` | bool | `false` = sold out, hidden from the student picker |
| `source` | `"vendor"`, `"observed"` or `"estimate"` | provenance, kept visible for honesty |

**`feedback/{auto-id}`**: one optional answer per visit, append-only. These are the ML labels.

| field | type | meaning |
|---|---|---|
| `cafe_id` | string | where they went |
| `actual_total_min` | integer 1–120 | minutes from joining the line to having the food (one-tap answer) |
| `item_id`, `item_prep_min` | optional | the item they picked and its prep time **at that moment** |
| `queue_count_at_report` | optional int | the median queue shown when they chose to go |
| `est_total_min` | optional | what CafeQ estimated (lets you measure the formula's error) |
| `started_at` | optional timestamp | when they tapped "I'm going" (gives hour / weekday) |
| `uid`, `created_at` | | anonymous device id, server time |

**`admins/{uid}`**: `{ email, added_at }`. Its existence makes that account an admin.

**`reports/{auto-id}`**: append-only, one document per tap.

| field | type | meaning |
|---|---|---|
| `cafe_id` | string | must match an existing cafe (enforced by rules) |
| `queue_count` | integer 0–100 | people in line: the typed number, or a bucket's midpoint (0–2 → 1, 3–5 → 4, 6–10 → 8, 10+ → 12). **Required on new reports** |
| `level` | `"green"`, `"yellow"` or `"red"` | **derived** from `queue_count` (≤ 2 green, 3–6 yellow, ≥ 7 red); rules reject a mismatch |
| `uid` | string | random anonymous-auth id; must equal the writer's uid |
| `created_at` | timestamp | server time; rules require `== request.time` |
| `acc` | number (optional) | GPS accuracy in metres, kept for later filtering |

Older colour-only reports (no `queue_count`) are still read and handled. See below.

No location coordinates, names, emails or device details are stored.

## Status engine

`public/js/status-engine.js` is pure and unit-tested. The numbers below are the defaults. Every one
of them is a **live admin setting** (`settings/global`), so changing it on `/admin.html` updates all
open apps at once. For each cafe:

1. Keep reports from the last **15 min** (`stale_min`), newest first. **Outlier guard:** a single
   `queue_count` above **50** (`outlier_cap`) is stored but ignored here.
2. **0 usable reports** gives `unknown` (grey) with no confidence. If the newest report is
   older than 15 min, the window is empty, so the status is forced to `unknown`.
3. **Queue length = MEDIAN `queue_count`** of the window. The median is robust: one person typing
   99, or one stale guess, can't drag it. The dashboard shows it as **"~N in line"**.
4. **Colour = thresholds on the median** (`green_max`, `yellow_max`): ≤ 2 green, 3–6 yellow,
   ≥ 7 red. `firestore.rules` reads the **same** live thresholds from `settings/global` (falling
   back to 2 and 6) to reject a report whose colour doesn't match its count, and a test checks the
   fallbacks match `config.js`.
5. **Estimated wait (count-based):**
   ```
   queue_wait = median_count × cafe.service_sec_per_person ÷ 60
                × congestion_factor (1.2)      ← only when the cafe is red (packed)
   wait       = round(queue_wait + prep_buffer_min (1))           (no item picked)
   ```
   The congestion factor models counters slowing down when crowded. It is an **assumption** the
   admin can tune (set it to 1 to switch it off).
   For the same queue, a cafe (45 s per person) shows a slightly shorter wait than the canteen
   (60 s per person). **These serving speeds are starting assumptions, not measurements.**
   Calibrate each one by timing how long its counter takes to serve, say, 10 people.
6. **Backward compatibility:** if a cafe's window holds only old colour-only reports, the status
   is their **mode** (a tie goes to the most recent) and the wait comes from the fallback map
   `STATUS_WAIT_MIN` (green 2, yellow 6, red 12 min). If both kinds are present, the counts decide.
7. **Confidence** is `high` if at least 2 reports in the last **10 min** have the same colour as
   the status (a count report's colour comes from its count); otherwise `low`.
8. "updated N min ago" comes from the newest report.

Dashboard order: cafes you can use soonest come first, sorted by walk plus estimated wait. Packed
(red) cafes come next, and unknown cafes go last.

## Walk times from your location

By default, walk times are each cafe's `walk_min`, measured from the day-scholar reference
point. A student who taps **📍 Use my location for walk times** on the dashboard, or picks
*My current location* on "Will I make it?" (they share one setting), gets personal estimates
instead:

```
walk ≈ straight-line distance × 1.3 (detour) ÷ 75 m/min      (minimum 1 min)
```

- **Opt-in, remembered on this device.** A first-time visitor never sees a location prompt just
  for opening the app.
- **Refreshed** when the app opens, whenever it comes back to the foreground, and every
  3 minutes while it stays open (`LOCATION_REFRESH_MIN`).
- **Falls back** to `walk_min` if permission is denied, there's no fix, or the fix is worse
  than ±150 m (`MAX_LOCATION_ACCURACY_M`). Cards say which is in use: "~4 min walk from you
  (est.)" or "4 min walk".
- **Private.** The position is used in the browser only. It is never written to Firestore or
  saved on the device.
- **No background updates.** Browsers don't let a closed web app read location. Timed updates
  "10 minutes before class ends" need push notifications; see
  [docs/push-notifications.md](docs/push-notifications.md).

## Menu and item-aware estimate

On the dashboard and on "Will I make it?", a student can pick **what they'll order** from that
cafe's available menu. Sold-out items are hidden. The choice is remembered on the device and
shared by both pages. The time at the cafe then becomes:

```
est_total = queue_wait (× congestion when red) + item.prep_min        ← the baseline FORMULA
```

This formula is what ships: transparent, explainable, and every input is visible. Cards say
"~9 min for Masala Dosa (est.)".

**`prep_min` is real data, never invented.** The menu ships **empty**. `seed/menus/<cafe>.json`
already lists the item **names** (328 items, transcribed from photos of the four menu boards on
24 Nov 2026, spelling as on the board, prices left out), but every `prep_min` is blank. Fill one in
only after the vendor tells you or you time servings, with `source` set honestly
(`vendor` / `observed` / `estimate`). You can also enter items directly on `/admin.html`. Items
without a prep time never reach the app.

## "Will I make it?" maths

```
total = walk_min + time_at_cafe + eating_buffer (5 min)
time_at_cafe = the item-aware estimate above (or the ML model, if one was published)
Go    : total ≤ available − 3
Risky : available − 3 < total ≤ available
Skip  : total > available
```
- The best **Go** cafe is shown first. If nothing is Go, the app suggests the lowest-total cafe
  as **grab-and-go only**.
- `estimated_wait` is the cafe's **count-based** estimate when queue reports exist (see the
  status engine), otherwise the colour fallback. Every row shows its maths, for example
  `3 walk + 4 wait (est., ~4 in line) + 5 eat = 12 min of 15`.
- A cafe with **no recent report is assumed packed** (red wait), and the app says so, so the
  verdict errs toward getting you back on time.
- The spec's formula counts the walk **once**. Tick *Also count the walk back to class* to count
  both directions.
- *My current location* replaces `walk_min` with an estimate from where you are (see
  [Walk times from your location](#walk-times-from-your-location)).
- Each Go or Risky row has an **"I'm going here →"** button that starts the feedback loop below.

## Feedback and the ML pipeline

**Labels.** After "I'm going here", CafeQ remembers the visit on the device: cafe, item, queue size,
its own estimate and the time. The next time the student opens the app (at least 3 minutes later,
within 4 hours), one optional card asks *"How long did <cafe> actually take?"*. One tap: 2 / 5 / 8 /
10 / 15 / 20 / 30 / 45+ min, or "Didn't go". The answer becomes a `feedback` document. **This is the
only source of training labels.** No answers, no model.

**Pipeline.** `scripts/ml/` (Python, scikit-learn) runs **offline**, never in the web app. See
[scripts/ml/README.md](scripts/ml/README.md).
1. Download `feedback.csv` from `/admin.html` → Export.
2. Run `py -3 scripts/ml/train.py --data cafeq-feedback.csv`.
3. It compares the **formula** with a **random forest** (features: queue count, hour, weekday,
   item prep time, canteen or cafe, serving speed) using **leave-one-day-out** cross-validation,
   and prints **both MAEs**.
4. It writes `public/model.json` only if the forest wins **and** there are ≥ 150 real rows over
   ≥ 3 days. Then `npm run deploy:hosting`.

`scripts/ml/generate_sample_data.py` makes **synthetic** rows (`source=synthetic`) for demonstrating
the pipeline only. They can't be mixed with real rows, demo models are never written to `public/`,
and the app refuses any model flagged synthetic.

## Formula vs ML

| | Formula (ships now) | Trained model (later, maybe) |
|---|---|---|
| Needs | queue reports + serving speed + prep times | **≥ 150–200 real feedback answers** over ≥ 3 days |
| Where it runs | browser | trained offline; predicts in the browser from `model.json` |
| When it's used | always, unless a model is published | only if it **beat the formula's MAE** under leave-one-day-out CV |
| Shown as | "est." | "est., ML model" + both MAEs in the fine print |

Today there is **no model**: `public/model.json` does not exist and every estimate is the formula.
Report both MAEs whenever you train. If the forest doesn't win, that's a valid result: say the
formula is good enough.

## Admin dashboard

`/admin.html` (not linked from the student pages). Sign in with an email/password admin account
([setup step 9](#setup-free-about-15-minutes)). Non-admins see "Not authorised" and no admin data
loads. The rules block their writes anyway.

- **Settings:** every value in `settings/global`, with ranges, defaults and "Fill in defaults".
- **Cafes:** name, place, type, coordinates, report radius, walk time, serving speed, active,
  placeholder flag. You can also add a new cafe (then run `npm run qr` for its poster).
- **Menu:** add / edit / delete items, prep time + source, a sold-out toggle that saves instantly.
  Optional **OCR import**: tesseract.js reads a menu photo **in the browser** and lists candidate
  item names. Tap one to pre-fill the form. It's a rough draft: on the RVCE board photos it caught
  some names among a lot of noise, so check every line. Nothing is saved automatically, and prep
  times are always typed by a person.
- **Stats:** reports today / last 7 days per cafe, % of active cafes with a fresh report now, total
  reports, and feedback answers collected (vs the ~150 needed for ML). All computed in the browser.
- **Export:** `reports.csv` (last N days) and `feedback.csv` (ML input). No anonymous ids, no
  personal data.

## Theme and accessibility

- **Light and dark themes**, taken from the logo. A switch in the header of every page defaults
  to the phone's setting; once tapped, the choice is remembered on the device. An inline script
  in each `<head>` applies it before first paint (no flash).
- Tokens are CSS custom properties: `:root` / `[data-theme="dark"]` and `[data-theme="light"]` in
  `css/styles.css`.

  | token | dark | light |
  |---|---|---|
  | `--bg` | `#241409` deep brown | `#f6ecdf` beige |
  | `--surface` | `#3a2215` warm brown | `#ffffff` |
  | `--text` | `#fbf3e8` | `#3a1e12` dark brown |
  | `--brand` (accent) | `#f0963c` logo orange | `#a84f14` deeper orange |
  | `--green` / `--yellow` / `--red` | `#4fd18b` / `#f5c842` / `#ff7a6b` | `#15803d` / `#8a5a00` / `#c0271e` |

- Every text/background pair was checked for **WCAG AA (≥ 4.5:1)** in both themes.
- **Never colour alone:** each status is a shape icon plus text (✓ No wait, ⏳ Short line, ⛔ Packed,
  ? Unknown), with the coloured dot as an extra cue, so it works for colour-blind users.

## Trust model and its limits (read this)

Trust comes from **proximity + agreement + freshness**, not identity:
- **Proximity:** a report is only accepted from within the cafe's geofence (GPS + haversine).
- **Agreement:** the queue length is the *median* of recent reports (one outlier can't move it,
  and counts above 50 are ignored), and confidence needs at least 2 agreeing reports.
- **Freshness:** only the last 15 minutes count; anything older becomes `unknown`.

**Enforced server-side by `firestore.rules`:** the writer is signed in and the report carries
their own uid; `queue_count` is a whole number from 0 to 100 and `level` is exactly the colour
that count maps to (no "1 person, Packed"); the cafe exists; the timestamp is the server's; reports
can't be edited or deleted. Only accounts listed in `admins/` can change `cafes`, `settings` or
`menu_items`, and every admin write is shape- and range-checked. Feedback is validated
(1–120 min, an existing cafe, a start time within the last 6 hours) and only admins can read it.

**Enforced only client-side in Phase 1:** the **geofence**, the **3-minute cooldown** and
**one feedback answer per visit**. Rules
can't see a phone's GPS, and anonymous accounts are free to create. A determined user who edits
the JavaScript or calls the Firestore API directly **could bypass both** and post fake reports.
The median, the outlier cap and confidence limit the damage from a single bad actor, but they
don't prevent it.

**Phase-2 hardening** would route reports through a **Cloud Function** that re-checks location,
rate-limits per uid and IP, and drops outliers. Cloud Functions need the **Blaze (pay-as-you-go)
plan**, which requires billing, so they are deliberately **not** part of Phase 1. A free partial
step is **Firebase App Check** with reCAPTCHA, which makes scripted abuse harder.

## Cost: why this stays free

- Firebase **Spark** plan: Firestore (50k reads / 20k writes per day), Anonymous + Email/Password
  Auth, Hosting.
- No Cloud Functions; all aggregation, admin stats and CSV export run in the browser. OCR runs in
  the admin's browser (tesseract.js). ML training runs offline on a laptop.
- The dashboard uses **one** listener for all recent reports, not one per cafe, and re-anchors
  the 15-minute window every 5 minutes so each read stays small.
- QR codes and icons are generated locally.

Nothing in this repo requires billing. If any future feature does, it goes to "Future work".

## Testing

```powershell
npm test
```
These Node unit tests (built-in `node:test`) cover the haversine distance and geofence, status
(mode, tie-break, confidence, staleness), queue counts (thresholds, bucket midpoints, median,
outlier cap, per-cafe serving speed, colour-only fallback), live settings (validation, fallback,
thresholds and windows applied live), the item-aware estimate and congestion factor, the model
tree walker (and refusing unpublished or synthetic models), admin helpers (CSV, stats, OCR
clean-up, validation), personal walk times, dashboard sorting, the Go/Risky/Skip boundaries, and
checks that `firestore.rules` uses the same thresholds and setting ranges as `config.js`.

The ML side: `py -3 scripts/ml/train.py --data scripts/ml/data/synthetic_feedback.csv --demo` runs
the whole pipeline on synthetic data. The JS tree walker matched sklearn to 0.0001 min on the
parity samples.

## Future work

Not built in Phase 1. Look for `TODO(phase-2-…)` comments in the code.
- **Push or reminder notifications** (FCM) before a chosen time, e.g. "10 minutes before class
  ends: Mingos Canteen has no wait". Requirements, design and the free-hosting options are in
  [docs/push-notifications.md](docs/push-notifications.md).
- **Train the ML model** once ≥ 150–200 real feedback answers exist. The pipeline is built (see
  [Formula vs ML](#formula-vs-ml)); the data isn't collected yet.
- **Collect prep times** for the 328 menu items in `seed/menus/` (vendor or timed).
- **Faster-item suggestions** ("the dosa takes 6 min, the vada 2"), once prep times exist.
- **Server-side report validation** (Cloud Function, Blaze plan). See the trust model above.
- Using `acc` (GPS accuracy) to down-weight imprecise reports.
- **Out of scope by design:** vendor pages, vendor login, and payments.

## License

Academic-use placeholder. See [LICENSE](LICENSE).
