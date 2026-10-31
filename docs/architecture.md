# Architecture

CafeQ is one FastAPI process that serves both the JSON API and the static PWA. There is no
build step, no frontend framework, and no paid service anywhere.

```
 STUDENT PHONE (PWA)                          VENDOR PHONE
 ┌───────────────────────────────┐            ┌─────────────────────────────┐
 │ index.html                    │            │ vendor.html (PIN)           │
 │  app.js        cards, modals  │            │  vendor.js                  │
 │  heatmap.js    best-time grid │            │  [FREE] [MODERATE] [BUSY]   │
 │  notifications.js  opt-in     │            │  [ORDER SERVED ✓]  stats    │
 │  sw.js  (push receiver)       │            └──────────────┬──────────────┘
 └──────┬──────────────▲─────────┘                           │ X-Vendor-PIN
        │ fetch /api/* │ Web Push (FCM on Android Chrome)    │
        ▼              │                                     ▼
 ┌─────────────────────┴──────────────────────────────────────────────────┐
 │ FastAPI  (backend/main.py)                                             │
 │                                                                        │
 │  routers/   status · crowdsource · orders · predict · history ·        │
 │             notify · admin                       (thin HTTP layer)     │
 │                                                                        │
 │  services/  status_engine      trust rules → green/yellow/red/unknown  │
 │             prediction_engine  baseline lookup + RandomForest          │
 │             worthit_engine     walk + wait + eat ≤ time available?     │
 │             notification_service  once-a-minute reminder loop          │
 │             sheets_logger      optional Google Sheets mirror           │
 │                                                                        │
 │  database.py  plain SQL, SQLite (dev) / PostgreSQL adapter (prod)      │
 └───────────────┬────────────────────────────────────────┬───────────────┘
                 ▼                                        ▼
        data/cafeq.db (SQLite)                  backend/ml/model.joblib
        cafes, status_updates, order_logs,      (written by ml/train.py,
        crowd_reports, push_subscribers,         hot-reloaded by the API)
        predictions
```

## Request flows

**Live status (every 30 s).** `GET /api/status` → `status_engine.get_all_statuses()` reads only
the last 15 minutes of vendor updates and crowd reports and applies the trust rules:

1. Vendor update ≤ 15 min old → use it (confidence *high*).
2. Else 2+ crowd reports ≤ 10 min old → mode; ties go to the more severe level (*medium*).
3. Else 1 crowd report ≤ 10 min old → use it (*low*).
4. Else → `unknown` (grey), no wait estimate.

The browser re-applies the 15-minute rule using the server's clock, so a tab left open in a
bag never shows a stale green.

**Vendor tap.** `POST /api/status` (PIN header) inserts into `status_updates` and returns the
recomputed status. `POST /api/orders` logs throughput — the `orders_last_15min` ML feature.

**Crowd report.** `POST /api/report` → `crowd_reports`. A per-client, per-cafe cooldown
(2 min) stops one person from faking a consensus.

**Worth it?** `GET /api/predict/worthit` → for the requested cafe:
`walk + predicted_wait + eating_buffer ≤ available_minutes`? If not, the cheapest other cafe
that fits is suggested; if none fits → "Grab a quick snack instead."

**Prediction.** `GET /api/predict/{cafe_id}`:
RandomForest (if trained *and* it beat the baseline) → else baseline average for
(weekday, half-hour) → else typical wait of the live status → else a cautious default.
When a live status exists, the number is clamped into that status's range.

**Reminders.** A background task ticks at each minute boundary, selects subscribers whose
`break_time` is 10 minutes ahead (campus time), computes all statuses once, and sends
`Cafe A 🟢 Free | Cafe B 🟡 ~8 min | Cafe C 🔴 Busy` via pywebpush. 404/410 → subscriber deleted.

## Key design decisions

| Decision | Why |
|---|---|
| Single process serves API + static files | Fits one free Render service; no CORS for the app itself |
| Plain SQL instead of an ORM | The schema in `database.py` *is* the documented schema; easy to explain in a viva |
| Timestamps stored as UTC text | Sort/compare correctly as strings; hour/day logic converts to IST only when bucketing |
| `source` column on every data table | Synthetic rows can never mix with real observations |
| Status engine is a pure function | Business rules are unit-tested without a database |
| No offline caching of `/api` in the service worker | An offline green is a stale green |
| Standard Web Push + VAPID instead of the Firebase JS SDK | Same FCM delivery on Android, zero extra JS, no Firebase config in the page |
| Shared vendor PIN, admin key | Demo-grade by design — no accounts, no JWT/OAuth (see constraints) |

## Time zones

All "hour of day", "day of week" and "today" logic uses `TIMEZONE` (default `Asia/Kolkata`).
Render servers run in UTC, so mixing the two would put the lunch peak at 06:30.
