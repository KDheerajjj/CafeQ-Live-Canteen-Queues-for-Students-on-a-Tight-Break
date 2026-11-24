# CafeQ: Live Canteen Queues for Students on a Tight Break

**Live dashboard: <https://cafeq-8f5a4.web.app>**

CafeQ is a free, installable mobile web app (PWA) that shows **day scholars at RV College of
Engineering** how crowded each campus cafe is right now, so they can choose where to eat in a
short break and still get back to class on time.

The live signal is **crowdsourced**: anyone standing at a cafe scans the QR at the counter and
taps its crowd level (🟢 No wait / 🟡 Short line / 🔴 Packed). It takes about two seconds and
needs no login and no app install. **Vendors don't need to do anything.**

> **Status: Phase 1.** Cafe names and counter coordinates are real. Walk times in `seed/cafes.json`, the reference
> point in `config.js`, and the crowd-level → wait-minutes map are **placeholders**. Replace them
> with measured values before you present any numbers as real.

---

## Contents
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Setup (free, about 15 minutes)](#setup-free-about-15-minutes)
- [Deploy](#deploy)
- [Data model](#data-model)
- [Status engine](#status-engine)
- [Walk times from your location](#walk-times-from-your-location)
- ["Will I make it?" maths](#will-i-make-it-maths)
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
   5. tap 🟢/🟡/🔴 → append to `reports`            → status, confidence, est. wait
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
  css/styles.css
  js/config.js             public Firebase web config + every tunable constant
  js/firebase-init.js      init app, anonymous auth, service-worker registration
  js/status-engine.js      PURE: reports → status/confidence; sort; trip verdicts
  js/geo.js                PURE: haversine distance, geofence, walk estimate
  js/location.js           opt-in "use my location" tracker for personal walk times
  js/data.js               shared realtime Firestore listeners (dashboard + worth-it)
  js/ui.js                 small shared DOM helpers (escaping, labels, notices)
  js/dashboard.js, report.js, worthit.js   page controllers
  manifest.webmanifest, service-worker.js, icons/
seed/cafes.json            the campus cafes (walk times still placeholders)
scripts/seed-firestore.js  load cafes.json into Firestore (Admin SDK)
scripts/make-qr.js         qr/<cafe>.png + printable qr/posters.html
scripts/make-icons.js      regenerate placeholder PWA icons
tests/                     Node unit tests for the pure modules
firestore.rules, firestore.indexes.json, firebase.json, vercel.json
```

There's no framework and no build step. The browser loads the Firebase SDK as ES modules
straight from Google's CDN.

## Setup (free, about 15 minutes)

You need **Node 22.9 or newer** and a Google account. **Do not enable billing anywhere.**

1. **Create a Firebase project** at <https://console.firebase.google.com>. Stay on the
   **Spark (free)** plan and skip Google Analytics.
2. **Enable Anonymous Auth**: Build → Authentication → Get started → Sign-in method →
   Anonymous → Enable.
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
   *Geofence:* the RVCE cafes use **40 m**. That's small enough that the M M Foods and
   Cafe Mingos zones (84 m apart) don't overlap. If genuine reports get rejected at a counter
   (indoor GPS is often off by 20–50 m), raise that one cafe to 50–60 m.
7. **Seed the cafes.** `cafes` is read-only to clients, so seeding uses the Admin SDK. Pick one
   of these credential options; **none of them puts a key in the repo**:
   - `gcloud auth application-default login` (no key file), **or**
   - download a service-account key (Project settings → Service accounts), save it **outside
     this folder**, and set `GOOGLE_APPLICATION_CREDENTIALS` in `.env` to its path.
   ```powershell
   npm run seed
   ```
   No CLI? You can also add the `cafes` documents by hand in the Firestore console, using
   the same ids and fields.
8. **Deploy rules and indexes** (indexes take a few minutes to build):
   ```powershell
   npm run deploy:rules
   ```

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
⋮ → *Install app*. Scan a QR at the counter, allow location, and tap a level; the dashboard on
another phone should update within a second or two. Turn on airplane mode and reopen the app:
the shell should still load.

## Data model

**`cafes/{id}`**: seeded, rarely changes, read-only to clients.

| field | type | meaning |
|---|---|---|
| *(doc id)* | string | e.g. `cafe-a`; used in QR links |
| `name` | string | display name |
| `location_desc` | string | human description of where it is |
| `lat`, `lng` | number | counter location |
| `geofence_m` | number | max distance (m) from which a report is accepted |
| `walk_min` | number | typical walk (min) from the day-scholar reference point |
| `placeholder` | bool | `true` while data is unmeasured; the UI shows a warning |

**`reports/{auto-id}`**: append-only, one document per tap.

| field | type | meaning |
|---|---|---|
| `cafe_id` | string | must match an existing cafe (enforced by rules) |
| `level` | `"green"`, `"yellow"` or `"red"` | crowd level (enforced by rules) |
| `uid` | string | random anonymous-auth id; must equal the writer's uid |
| `created_at` | timestamp | server time; rules require `== request.time` |
| `acc` | number (optional) | GPS accuracy in metres, kept for later filtering |

No location coordinates, names, emails or device details are stored.

## Status engine

`public/js/status-engine.js` is pure and unit-tested. For each cafe:

1. Keep reports from the last **15 min**, newest first.
2. **0 reports** gives `unknown` (grey) with no confidence. If the newest report is older than
   15 min, the window is empty, so the status is forced to `unknown`.
3. Otherwise, **status = mode** (most common level). A tie goes to the level reported most
   recently.
4. **Confidence** is `high` if at least 2 reports in the last **10 min** agree with the mode;
   otherwise `low`.
5. "updated N min ago" comes from the newest report.
6. **Estimated wait** comes from `STATUS_WAIT_MIN` in `config.js`: green = 2, yellow = 6,
   red = 12 min. This is a **placeholder estimate, not a measurement**, until the ML phase.

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

## "Will I make it?" maths

```
total = walk_min + estimated_wait + eating_buffer (5 min)
Go    : total ≤ available − 3
Risky : available − 3 < total ≤ available
Skip  : total > available
```
- The best **Go** cafe is shown first. If nothing is Go, the app suggests the lowest-total cafe
  as **grab-and-go only**.
- Every row shows its maths, for example `3 walk + 6 wait (est.) + 5 eat = 14 min of 15`.
- A cafe with **no recent report is assumed packed** (red wait), and the app says so, so the
  verdict errs toward getting you back on time.
- The spec's formula counts the walk **once**. Tick *Also count the walk back to class* to count
  both directions.
- *My current location* replaces `walk_min` with an estimate from where you are (see
  [Walk times from your location](#walk-times-from-your-location)).

## Trust model and its limits (read this)

Trust comes from **proximity + agreement + freshness**, not identity:
- **Proximity:** a report is only accepted from within the cafe's geofence (GPS + haversine).
- **Agreement:** the status is the *mode* of recent reports, and confidence needs at least 2
  agreeing reports.
- **Freshness:** only the last 15 minutes count; anything older becomes `unknown`.

**Enforced server-side by `firestore.rules`:** the writer is signed in and the report carries
their own uid; the level is valid; the cafe exists; the timestamp is the server's; reports
can't be edited or deleted; `cafes` can't be written by clients.

**Enforced only client-side in Phase 1:** the **geofence** and the **3-minute cooldown**. Rules
can't see a phone's GPS, and anonymous accounts are free to create. A determined user who edits
the JavaScript or calls the Firestore API directly **could bypass both** and post fake reports.
Mode and confidence limit the damage from a single bad actor, but they don't prevent it.

**Phase-2 hardening** would route reports through a **Cloud Function** that re-checks location,
rate-limits per uid and IP, and drops outliers. Cloud Functions need the **Blaze (pay-as-you-go)
plan**, which requires billing, so they are deliberately **not** part of Phase 1. A free partial
step is **Firebase App Check** with reCAPTCHA, which makes scripted abuse harder.

## Cost: why this stays free

- Firebase **Spark** plan: Firestore (50k reads / 20k writes per day), Anonymous Auth, Hosting.
- No Cloud Functions; all aggregation runs in the browser.
- The dashboard uses **one** listener for all recent reports, not one per cafe, and re-anchors
  the 15-minute window every 5 minutes so each read stays small.
- QR codes and icons are generated locally.

Nothing in this repo requires billing. If any future feature does, it goes to "Future work".

## Testing

```powershell
npm test
```
These Node unit tests (built-in `node:test`) cover the haversine distance and geofence, status
(mode, tie-break, confidence, staleness), dashboard sorting, and the Go/Risky/Skip boundaries.

## Future work

Not built in Phase 1. Look for `TODO(phase-2-…)` comments in the code.
- **Push or reminder notifications** (FCM) before a chosen time, e.g. "10 minutes before class
  ends: Mingos Canteen has no wait". Requirements, design and the free-hosting options are in
  [docs/push-notifications.md](docs/push-notifications.md).
- **ML crowd and wait prediction** per cafe and time slot, replacing the placeholder
  `STATUS_WAIT_MIN` map. It can be trained on the accumulated `reports` collection.
- **Faster-item suggestions** and per-item prep times.
- **Server-side report validation** (Cloud Function, Blaze plan). See the trust model above.
- Using `acc` (GPS accuracy) to down-weight imprecise reports.
- **Out of scope by design:** vendor pages, vendor login, and payments.

## License

Academic-use placeholder. See [LICENSE](LICENSE).
