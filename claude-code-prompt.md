# Claude Code Prompt — Full Project Build

> Copy-paste this entire prompt into Claude Code to scaffold and build the project from scratch.

---

## PROJECT IDENTITY

- **Title:** Data-Driven Wait-Time Visibility and Load Balancing Across Multiple Campus Cafes
- **Repo name:** `data-driven-cafe-wait-time`
- **One-liner:** A mobile-first PWA dashboard showing real-time and predicted crowd/wait times across campus cafes, with crowdsourced status updates and browser push notifications.
- **Context:** This is a DTL (Design Thinking Lab) academic project by a 2nd-year CSE student at RV College of Engineering, Bengaluru. The system targets a campus with 3–5 cafes where students face unpredictable wait times during short academic breaks.

---

## TECH STACK (all free tier)

| Layer | Technology | Reason |
|---|---|---|
| Backend | Python 3.11+ with **FastAPI** | Async, auto-generates OpenAPI docs, easy to learn |
| Database | **SQLite** (dev) / **Supabase PostgreSQL** (prod, free tier) | SQLite = zero setup for dev; Supabase = free hosted Postgres with REST API |
| Frontend | **Vanilla HTML + CSS + JavaScript** (no framework) | Simplest possible; mobile-first responsive design |
| Push Notifications | **Firebase Cloud Messaging (FCM)** via Web Push API | Free, works on Android Chrome even when browser is closed |
| Hosting | **Render.com** free tier (backend + frontend served together) | Single deploy, free, supports Python |
| Version Control | **GitHub** | Public repo |
| Data logging | **Google Sheets API** (optional, for Phase 1 manual logging fallback) | Familiar to team, zero-cost |

---

## FOLDER STRUCTURE

Create this exact structure:

```
data-driven-cafe-wait-time/
├── README.md                          # Project roadmap, setup instructions, architecture
├── .gitignore                         # Python, Node, env, SQLite, __pycache__
├── requirements.txt                   # All Python dependencies
├── .env.example                       # Template for environment variables
│
├── backend/
│   ├── main.py                        # FastAPI app entry point, CORS, lifespan
│   ├── config.py                      # Settings loaded from .env (DB path, FCM key, etc.)
│   ├── database.py                    # SQLite connection, table creation, migrations
│   │
│   ├── models/
│   │   ├── __init__.py
│   │   ├── cafe.py                    # Cafe model (id, name, location_description, walk_times)
│   │   ├── status_update.py           # StatusUpdate model (cafe_id, status, source, timestamp)
│   │   ├── order_log.py               # OrderLog model (cafe_id, timestamp, item_name, prep_time_est)
│   │   ├── prediction.py              # Prediction model (cafe_id, predicted_wait, confidence, timestamp)
│   │   └── subscriber.py              # PushSubscriber model (endpoint, keys, break_time, cafe_pref)
│   │
│   ├── routers/
│   │   ├── __init__.py
│   │   ├── status.py                  # GET /api/status — current status of all cafes
│   │   │                              # GET /api/status/{cafe_id} — single cafe status
│   │   │                              # POST /api/status — vendor/student submits a status update
│   │   ├── crowdsource.py             # POST /api/report — student reports crowd level (Green/Yellow/Red)
│   │   │                              # GET /api/report/recent/{cafe_id} — recent crowd reports
│   │   ├── orders.py                  # POST /api/orders — vendor logs an order served
│   │   │                              # GET /api/orders/count/{cafe_id} — order count in last N minutes
│   │   ├── predict.py                 # GET /api/predict/{cafe_id} — ML/baseline predicted wait
│   │   │                              # GET /api/predict/worthit — "is it worth waiting?" endpoint
│   │   │                              #   Query params: cafe_id, available_minutes
│   │   │                              #   Returns: recommendation + alternative cafe suggestion
│   │   ├── history.py                 # GET /api/history/{cafe_id} — historical crowd data for heatmap
│   │   │                              # GET /api/history/heatmap — aggregated best-time-to-visit data
│   │   ├── notify.py                  # POST /api/subscribe — register push subscription
│   │   │                              # DELETE /api/subscribe — unsubscribe
│   │   │                              # POST /api/notify/send — trigger notification (internal/cron)
│   │   └── admin.py                   # GET /api/admin/stats — daily order counts, peak hours, usage
│   │                                  # POST /api/admin/cafe — add/edit cafe details
│   │                                  # Protected by a simple API key in .env
│   │
│   ├── services/
│   │   ├── __init__.py
│   │   ├── status_engine.py           # Business logic: compute current cafe status from recent updates
│   │   │                              #   - If latest vendor update < 15 min old → use it
│   │   │                              #   - Else if crowdsourced reports exist < 10 min → aggregate them
│   │   │                              #   - Else → mark as "Unknown" (stale)
│   │   │                              #   - Weighted average: vendor weight = 3, student weight = 1
│   │   ├── prediction_engine.py       # Phase 3: ML prediction logic
│   │   │                              #   - Baseline: historical avg wait by (cafe, day_of_week, 30-min slot)
│   │   │                              #   - ML: RandomForestRegressor from scikit-learn
│   │   │                              #   - Features: hour, minute_bin, day_of_week, orders_last_15min
│   │   │                              #   - Output: predicted_wait_minutes, confidence_level
│   │   │                              #   - Fallback: if <200 data points, use baseline only
│   │   ├── worthit_engine.py          # "Is it worth waiting?" logic
│   │   │                              #   - Input: cafe_id, available_minutes
│   │   │                              #   - Calculation: walk_time + predicted_wait + 10 min eating buffer
│   │   │                              #   - If total <= available_minutes → "Yes, go ahead"
│   │   │                              #   - Else → suggest alternative cafe with lowest total_time
│   │   │                              #   - Edge case: if ALL cafes exceed time → "Grab a quick snack"
│   │   ├── notification_service.py    # Firebase Cloud Messaging push sender
│   │   │                              #   - Uses pywebpush library
│   │   │                              #   - Sends to all subscribers whose break_time is 10 min away
│   │   │                              #   - Notification body: "Cafe A is 🟢 Free. Cafe B is 🟡 ~8 min."
│   │   └── sheets_logger.py           # (Optional) Google Sheets logger for Phase 1 fallback
│   │
│   ├── ml/
│   │   ├── __init__.py
│   │   ├── train.py                   # Script to train model from SQLite data
│   │   │                              #   - Reads order_logs and status_updates tables
│   │   │                              #   - Computes features, trains RandomForest
│   │   │                              #   - Saves model to ml/model.joblib
│   │   │                              #   - Prints MAE, compares to baseline, warns if <200 rows
│   │   ├── evaluate.py                # Leave-one-day-out cross-validation script
│   │   │                              #   - Reports per-fold MAE and overall MAE
│   │   │                              #   - Prints: "Baseline MAE: X.X min | RF MAE: Y.Y min"
│   │   ├── model.joblib               # Trained model file (gitignored, generated by train.py)
│   │   └── generate_sample_data.py    # Generates realistic synthetic data for testing/demo
│   │                                  #   - 3 cafes, 30 simulated days, peak at 12:00-13:00
│   │                                  #   - CLEARLY LABELLED as synthetic in all outputs
│   │                                  #   - Populates SQLite with ~900 rows for demo purposes
│   │
│   ├── seed/
│   │   └── cafes.json                 # Initial cafe data to seed the database
│   │                                  # [
│   │                                  #   {
│   │                                  #     "id": "cafe-a",
│   │                                  #     "name": "Cafe A (Main Canteen)",
│   │                                  #     "location": "Near Main Building",
│   │                                  #     "walk_times": {"cafe-b": 3, "cafe-c": 5}
│   │                                  #   },
│   │                                  #   ... (repeat for each cafe)
│   │                                  # ]
│   │
│   └── tests/
│       ├── __init__.py
│       ├── test_status_engine.py      # Unit tests for status computation logic
│       ├── test_worthit_engine.py     # Unit tests for "is it worth waiting?" logic
│       └── test_api.py               # Integration tests for API endpoints using TestClient
│
├── frontend/
│   ├── index.html                     # Student dashboard — single page app
│   │                                  # LAYOUT (mobile-first, 360px min-width):
│   │                                  #   - Header: "Campus Cafe Status" + last refresh time
│   │                                  #   - 3-5 cafe cards, each showing:
│   │                                  #       - Cafe name
│   │                                  #       - Status dot (green/yellow/red/grey)
│   │                                  #       - Status text ("Free", "Moderate", "Busy", "Unknown")
│   │                                  #       - Estimated wait: "~8 min" or "—"
│   │                                  #       - "Updated 3 min ago" timestamp
│   │                                  #       - Tap to expand → "Best time to visit" mini-heatmap
│   │                                  #   - Bottom bar: "Report Crowd" button → opens modal
│   │                                  #   - "Worth it?" floating button → opens input form
│   │                                  #   - Notification opt-in banner (if not subscribed)
│   │
│   ├── vendor.html                    # Vendor dashboard — password-protected page
│   │                                  # LAYOUT:
│   │                                  #   - Simple login: just a PIN stored in .env (not a full auth system)
│   │                                  #   - Select cafe dropdown (if vendor manages multiple)
│   │                                  #   - Three BIG buttons: 🟢 FREE | 🟡 MODERATE | 🔴 BUSY
│   │                                  #   - One "ORDER SERVED ✓" button (tapped per order)
│   │                                  #   - Optional: item selector (dropdown of 8-10 items) before "ORDER SERVED"
│   │                                  #   - Daily summary at bottom: total orders today, busiest hour
│   │
│   ├── css/
│   │   └── style.css                  # Mobile-first responsive CSS
│   │                                  #   - Max-width container: 480px, centered
│   │                                  #   - Color variables: --green: #22c55e, --yellow: #eab308, --red: #ef4444, --grey: #9ca3af
│   │                                  #   - Status cards: rounded corners, subtle shadow, tap feedback
│   │                                  #   - Large touch targets: buttons min 48px height
│   │                                  #   - Dark mode support via prefers-color-scheme
│   │                                  #   - Vendor page: extra-large buttons (80px+ height) for fast tapping
│   │
│   ├── js/
│   │   ├── app.js                     # Student dashboard logic
│   │   │                              #   - Fetch /api/status every 30 seconds, update cards
│   │   │                              #   - Render status dot color + text + wait time
│   │   │                              #   - If update_age > 15 min → show grey "Unknown"
│   │   │                              #   - "Report Crowd" modal: select cafe → tap Green/Yellow/Red → POST /api/report
│   │   │                              #   - "Worth it?" form: select cafe + enter minutes → GET /api/predict/worthit → show result
│   │   │                              #   - Heatmap: fetch /api/history/heatmap, render as colored grid (7 days × 12 slots)
│   │   │
│   │   ├── vendor.js                  # Vendor page logic
│   │   │                              #   - PIN login check against /api/admin/verify (simple comparison, not hashed — this is a demo)
│   │   │                              #   - Status buttons: POST /api/status with source="vendor"
│   │   │                              #   - Order served button: POST /api/orders
│   │   │                              #   - Auto-refresh daily stats every 60 seconds
│   │   │
│   │   ├── notifications.js           # Push notification registration
│   │   │                              #   - Check if browser supports Push API + Service Workers
│   │   │                              #   - If yes → show opt-in banner
│   │   │                              #   - On click → request permission → subscribe via FCM
│   │   │                              #   - Send subscription object to POST /api/subscribe
│   │   │                              #   - If not supported (iOS) → hide banner, no error shown
│   │   │
│   │   └── heatmap.js                 # Renders the "best time to visit" heatmap
│   │                                  #   - 7-column (Mon-Sun) × 12-row (8am-8pm, 1hr slots) grid
│   │                                  #   - Each cell colored by historical avg crowd level
│   │                                  #   - Green = historically free, Red = historically busy
│   │                                  #   - Data from /api/history/heatmap
│   │
│   ├── sw.js                          # Service Worker for push notifications
│   │                                  #   - Listens for 'push' event
│   │                                  #   - Displays notification with title, body, icon
│   │                                  #   - On notification click → open the dashboard URL
│   │
│   ├── manifest.json                  # PWA manifest
│   │                                  #   - name: "CafeQ - Campus Cafe Status"
│   │                                  #   - short_name: "CafeQ"
│   │                                  #   - start_url: "/"
│   │                                  #   - display: "standalone"
│   │                                  #   - theme_color: "#1e293b"
│   │                                  #   - background_color: "#f8fafc"
│   │                                  #   - icons: 192x192 and 512x512
│   │
│   └── assets/
│       ├── icon-192.png               # PWA icon (simple cafe/coffee cup icon)
│       └── icon-512.png               # PWA icon large
│
├── docs/
│   ├── architecture.md                # System architecture diagram (text-based)
│   ├── api-reference.md               # Full API endpoint documentation
│   ├── deployment-guide.md            # Step-by-step Render.com deployment
│   ├── fcm-setup-guide.md             # How to set up Firebase Cloud Messaging
│   └── data-dictionary.md             # All database tables, columns, types, constraints
│
├── data/
│   ├── .gitkeep                       # Keeps the folder in git (actual data files gitignored)
│   └── sample_survey_summary.md       # Summary statistics from Oct 2026 student survey
│                                      # (NO raw survey data — just aggregated stats)
│
└── scripts/
    ├── seed_db.py                     # Reads seed/cafes.json and populates SQLite
    ├── generate_sample_data.py        # Symlink or copy of ml/generate_sample_data.py
    └── send_test_notification.py      # Manual script to test FCM push to a test subscriber
```

---

## DATABASE SCHEMA (SQLite)

```sql
CREATE TABLE cafes (
    id TEXT PRIMARY KEY,                    -- e.g., "cafe-a"
    name TEXT NOT NULL,                     -- e.g., "Cafe A (Main Canteen)"
    location_description TEXT,             -- e.g., "Near Main Building, Ground Floor"
    walk_times_json TEXT,                  -- JSON: {"cafe-b": 3, "cafe-c": 5} (minutes)
    is_active BOOLEAN DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE status_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id TEXT NOT NULL REFERENCES cafes(id),
    status TEXT NOT NULL CHECK(status IN ('green', 'yellow', 'red')),
    source TEXT NOT NULL CHECK(source IN ('vendor', 'crowdsource', 'ml')),
    reporter_id TEXT,                      -- optional: anonymous hash or "vendor"
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id TEXT NOT NULL REFERENCES cafes(id),
    item_name TEXT,                         -- optional: "dosa", "biryani", etc.
    estimated_prep_minutes REAL,           -- optional: estimated prep time
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE crowd_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id TEXT NOT NULL REFERENCES cafes(id),
    reported_status TEXT NOT NULL CHECK(reported_status IN ('green', 'yellow', 'red')),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE push_subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh_key TEXT NOT NULL,
    auth_key TEXT NOT NULL,
    break_time TEXT,                        -- e.g., "12:30" — when to send reminder
    preferred_cafe_id TEXT REFERENCES cafes(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id TEXT NOT NULL REFERENCES cafes(id),
    predicted_wait_minutes REAL NOT NULL,
    model_type TEXT NOT NULL CHECK(model_type IN ('baseline', 'rf', 'manual')),
    confidence TEXT CHECK(confidence IN ('low', 'medium', 'high')),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_status_updates_cafe_time ON status_updates(cafe_id, timestamp DESC);
CREATE INDEX idx_order_logs_cafe_time ON order_logs(cafe_id, timestamp DESC);
CREATE INDEX idx_crowd_reports_cafe_time ON crowd_reports(cafe_id, timestamp DESC);
CREATE INDEX idx_push_subscribers_break ON push_subscribers(break_time);
```

---

## .env.example

```env
# Database
DATABASE_URL=sqlite:///./data/cafeq.db

# Vendor PIN (simple auth for vendor page)
VENDOR_PIN=1234

# Admin API key
ADMIN_API_KEY=your-random-admin-key-here

# Firebase Cloud Messaging (get from Firebase Console)
FCM_SERVER_KEY=your-fcm-server-key
VAPID_PUBLIC_KEY=your-vapid-public-key
VAPID_PRIVATE_KEY=your-vapid-private-key
VAPID_EMAIL=mailto:your-email@example.com

# App settings
STALE_THRESHOLD_MINUTES=15
STATUS_REFRESH_SECONDS=30
REMINDER_LEAD_MINUTES=10
DEFAULT_EATING_BUFFER_MINUTES=10
```

---

## KEY BUSINESS LOGIC RULES

### Status Engine (status_engine.py)
1. Fetch all status_updates and crowd_reports for a cafe in the last 15 minutes.
2. If a vendor update exists within 15 min → use it (highest trust).
3. Else if 2+ crowd reports exist within 10 min → take the mode (most common status).
4. Else if 1 crowd report exists within 10 min → use it but mark confidence as "low."
5. Else → return status "unknown" (grey), wait_estimate = null.
6. Estimated wait mapping: green = 0-5 min, yellow = 5-12 min, red = 12+ min.
   (These are rough estimates; Phase 3 ML replaces them with data-driven predictions.)

### "Worth It?" Engine (worthit_engine.py)
1. Input: cafe_id, available_minutes (how long before the student's next class).
2. Get predicted_wait for the requested cafe.
3. Get walk_time from student's assumed location (default: "main building"; future: GPS).
4. total_time = walk_time + predicted_wait + eating_buffer (default 10 min).
5. If total_time <= available_minutes → return {recommendation: "go", cafe: cafe_id, time_left_to_eat: available_minutes - total_time}.
6. Else → check all other active cafes, compute total_time for each, return the one with lowest total_time.
7. If ALL cafes exceed available_minutes → return {recommendation: "skip", message: "Grab a quick snack instead"}.

### Notification Service (notification_service.py)
1. Every minute (via a background task or cron), query push_subscribers where break_time is 10 minutes from now.
2. For each matched subscriber, get current status of all cafes.
3. Compose notification: "Cafe A 🟢 Free | Cafe B 🟡 ~8 min | Cafe C 🔴 Busy"
4. Send via pywebpush to the subscriber's endpoint.
5. If send fails (expired subscription), delete the subscriber row.

---

## FRONTEND DESIGN SPECIFICATIONS

### Student Dashboard (index.html)
- **Mobile-first**: designed for 360px width, scales up to 480px max
- **Background**: #f8fafc (light grey-white)
- **Header**: sticky, dark (#1e293b), white text, "Campus Cafe Status", refresh icon
- **Cafe cards**: white background, 12px rounded corners, 1px #e2e8f0 border, subtle shadow
  - Status dot: 12px circle, colored by status
  - Cafe name: 16px semibold
  - Status text: 14px, same color as dot
  - Wait time: 20px bold if available, "—" if unknown
  - "Updated X min ago": 12px grey text; turns orange if >10 min, red if >15 min
  - Tap to expand: reveals 7×12 heatmap grid for that cafe
- **Report button**: fixed bottom bar, full-width, blue (#3b82f6), "📊 Report Crowd"
- **Worth-it button**: floating action button, bottom-right, circular, green
- **Notification banner**: top banner, dismissible, "Get notified before your break 🔔"
- **No framework**: vanilla HTML/CSS/JS only. No React, no Tailwind CDN.

### Vendor Dashboard (vendor.html)
- **PIN entry**: simple input + submit, no complex auth
- **Three status buttons**: full-width, 80px tall, colored (green/yellow/red), large text
- **Order served button**: full-width, 60px tall, blue, with a counter showing today's orders
- **Item selector** (optional): dropdown above the order button with 8-10 common items
- **Daily stats**: bottom section showing orders today and busiest hour
- **Large touch targets everywhere**: vendor is tapping fast during rush hour

---

## BUILD ORDER

Build files in this exact order to ensure each step is testable:

1. `requirements.txt`, `.gitignore`, `.env.example`
2. `backend/config.py`, `backend/database.py` — DB setup
3. `backend/seed/cafes.json`, `scripts/seed_db.py` — seed 3 cafes
4. `backend/models/` — all Pydantic models
5. `backend/routers/status.py` — GET and POST status (test with curl)
6. `backend/services/status_engine.py` — status computation logic
7. `backend/routers/crowdsource.py` — student crowd reporting
8. `backend/main.py` — wire up all routers, CORS, static files
9. `frontend/css/style.css` — complete mobile-first stylesheet
10. `frontend/index.html` — student dashboard structure
11. `frontend/js/app.js` — fetch + render status cards
12. `frontend/vendor.html` + `frontend/js/vendor.js` — vendor page
13. `backend/routers/orders.py` — order logging endpoint
14. `backend/services/worthit_engine.py` + `backend/routers/predict.py` — worth-it logic
15. `frontend/js/heatmap.js` + `backend/routers/history.py` — heatmap
16. `frontend/manifest.json` + `frontend/sw.js` + `frontend/js/notifications.js` — PWA + push
17. `backend/services/notification_service.py` + `backend/routers/notify.py` — FCM push
18. `backend/ml/generate_sample_data.py` — synthetic data for demo
19. `backend/ml/train.py` + `backend/ml/evaluate.py` — ML pipeline
20. `backend/tests/` — unit + integration tests
21. `docs/` — all documentation files
22. `README.md` — final comprehensive README

---

## IMPORTANT CONSTRAINTS

- **No invented data.** The generate_sample_data.py script must clearly print "⚠️ This is SYNTHETIC data for demo/testing purposes only. Not real observations." every time it runs. All synthetic data must be labelled in the database with a flag or a source field.
- **No complex auth.** Vendor page uses a simple PIN. No JWT, no OAuth, no user accounts. This is a DTL demo, not a production app.
- **No payment integration.** No UPI, no pre-ordering, no payment gateway. Mention these in README under "Future Work."
- **Graceful iOS fallback.** If Push API is not supported, hide the notification banner silently. Never show an error to the user.
- **Stale data handling.** Any status older than 15 minutes must show as "Unknown" (grey). Never show a stale green when the cafe might actually be busy.
- **Baseline before ML.** The prediction engine must compute and report the baseline (historical average) MAE alongside any ML model MAE. If the ML model doesn't beat the baseline, the code should log a warning and fall back to baseline.
- **All code must have comments** explaining the business logic, not just what the code does.
