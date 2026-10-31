# Data-Driven Wait-Time Visibility and Load Balancing Across Multiple Campus Cafes

**CafeQ** — a mobile-first Progressive Web App (PWA) that shows live and predicted crowd levels and
wait times across campus cafes, so students can decide *where* and *whether* to eat during short
academic breaks — and so demand spreads out instead of piling onto one counter.

> **Academic context:** DTL (Design Thinking Lab) project — 2nd Year CSE, RV College of Engineering, Bengaluru.

---

## Problem statement

Students at RVCE face unpredictable wait times across 3–5 campus cafes during 15–30 minute breaks.
With no visibility into which cafe is busy, students waste their break in long queues, skip meals,
or all crowd the nearest cafe — creating uneven demand and a poor experience for everyone.

**Research backing**

- A participatory observational study at VIT Vellore (250 observations, 5 canteens) found that
  dissatisfaction correlates more with uncertainty, congestion and lack of information than with
  actual wait duration (Pusuluri, 2024).
- A crowdsourced queue-estimation system at the University of Oulu reached ~2 minute mean absolute
  error with only ~7% of customers contributing (Goncalves et al., CSCW 2016).

CafeQ applies both findings: remove uncertainty with an honest live status, and let a small number
of crowd reports plus one-tap vendor updates do the work — at zero cost.

---

## Features

| Feature | Where |
|---|---|
| Live 🟢/🟡/🔴 status per cafe, auto-refresh every 30 s | `index.html`, `status_engine.py` |
| Vendor one-tap status + "ORDER SERVED ✓" counter (PIN-protected) | `vendor.html`, `routers/orders.py` |
| Anonymous student crowd reports with anti-spam cooldown | `routers/crowdsource.py` |
| **Stale-data rule:** anything older than 15 min shows grey "Unknown" — never a stale green | backend **and** browser |
| "Is it worth waiting?" — walk + wait + eating time vs. time before class, suggests a better cafe | `worthit_engine.py` |
| "Best time to visit" heatmap (Mon–Sun × 8am–8pm) | `heatmap.js`, `routers/history.py` |
| Push reminder 10 min before your break: `Cafe A 🟢 Free \| Cafe B 🟡 ~8 min \| Cafe C 🔴 Busy` | `notification_service.py`, `sw.js` |
| Wait prediction: baseline lookup + RandomForest, RF used only if it beats the baseline | `prediction_engine.py`, `ml/` |
| Installable PWA, dark mode, 360 px+ layouts, 48–80 px touch targets | `manifest.json`, `style.css` |

---

## Architecture

```
 STUDENT PHONE (PWA)                          VENDOR PHONE
 ┌───────────────────────────────┐            ┌─────────────────────────────┐
 │ index.html                    │            │ vendor.html (PIN)           │
 │  app.js        cards, modals  │            │  [🟢 FREE] [🟡 MODERATE]    │
 │  heatmap.js    best-time grid │            │  [🔴 BUSY]                  │
 │  notifications.js  opt-in     │            │  [ORDER SERVED ✓] Orders: 87│
 │  sw.js  (push receiver)       │            └──────────────┬──────────────┘
 └──────┬──────────────▲─────────┘                           │ X-Vendor-PIN
        │ fetch /api/* │ Web Push (delivered by FCM)         │
        ▼              │                                     ▼
 ┌─────────────────────┴──────────────────────────────────────────────────┐
 │ FastAPI on Render (backend/main.py) — serves API + static frontend     │
 │                                                                        │
 │  routers/   status · crowdsource · orders · predict · history ·        │
 │             notify · admin                                             │
 │  services/  status_engine · prediction_engine · worthit_engine ·       │
 │             notification_service (1-min loop) · sheets_logger (opt.)   │
 │  database.py  plain SQL                                                │
 └───────────────┬────────────────────────────────────────┬───────────────┘
                 ▼                                        ▼
     SQLite (dev) / Supabase Postgres (prod)     ml/model.joblib
     cafes · status_updates · order_logs ·       (ml/train.py; hot-reloaded)
     crowd_reports · push_subscribers · predictions
```

**Status trust rules** (`backend/services/status_engine.py`):

1. Vendor update in the last 15 min → use it (confidence *high*).
2. Else 2+ crowd reports in the last 10 min → most common status; ties → the worse level (*medium*).
3. Else 1 crowd report in the last 10 min → use it (*low* confidence, shown on the card).
4. Else → **Unknown** (grey), no wait estimate.

Wait ranges: green 0–5 min, yellow 5–12 min, red 12+ min. More detail: [docs/architecture.md](docs/architecture.md).

---

## Roadmap

### Phase 0: Foundation (Weeks 1–2)
- [x] Student needs-assessment survey (Google Forms, Oct 3–7 2026, ~60 responses) — summarise in [data/sample_survey_summary.md](data/sample_survey_summary.md)
- [x] Literature review (VIT queue study, Oulu crowdsourcing paper)
- [x] Technology stack selection
- [x] Architecture decision: PWA + FastAPI + SQLite
- [ ] Vendor stakeholder interviews (2–3 cafe operators)
- [ ] Ethics/permission from admin or DTL faculty

### Phase 1: Live Status Dashboard (Weeks 3–5)
- [x] Database schema and seed data for 3 cafes
- [x] FastAPI backend with status, crowdsource and order endpoints
- [x] Student dashboard (mobile-first status cards, report modal)
- [x] Vendor dashboard (PIN login, status buttons, order-served button, daily stats)
- [x] Stale-data rule: status older than 15 min shown as "Unknown"
- [ ] 3–5 day manual data collection at 1–2 cafes during peak hours
- [ ] Deploy to Render.com free tier

### Phase 2: Decision Support + Notifications (Weeks 6–8)
- [x] "Is it worth waiting?" engine and API endpoint
- [ ] Walk-time data between buildings and cafes (manually measured — seed values are placeholders)
- [x] Historical heatmap: "best time to visit" by day and hour
- [x] Web Push via FCM (VAPID) + service worker
- [x] Notification scheduler: 10-min-before-break alerts
- [ ] Test push on students' Android phones
- [ ] Optional Telegram channel auto-posting status every 15 min

### Phase 3: ML Prediction (Weeks 9–11)
- [x] Baseline: historical avg wait by (cafe, day_of_week, 30-min slot)
- [x] Features: hour, minute_bin, day_of_week, orders_last_15min
- [x] RandomForestRegressor (scikit-learn), trained only with 200+ rows per cafe
- [x] Leave-one-day-out cross-validation; baseline MAE always reported next to RF MAE
- [x] Automatic fallback to baseline (with a logged warning) if RF doesn't win
- [x] Synthetic data generator for demo (clearly labelled)
- [ ] Train and evaluate on **real** collected data; report the result honestly

### Phase 4: Polish + Report (Weeks 12–13)
- [ ] Quick-item suggestions (if per-item prep data is available)
- [ ] UI polish from user testing
- [ ] Final project report (academic format)
- [ ] Presentation slides, poster, demo video

---

## Tech stack

| Layer | Technology | Cost |
|---|---|---|
| Backend | Python 3.11+ / FastAPI | Free |
| Database | SQLite (dev) / Supabase PostgreSQL (prod) | Free |
| Frontend | Vanilla HTML + CSS + JavaScript (no framework) | Free |
| Push notifications | Web Push API + VAPID via `pywebpush`, delivered by Firebase Cloud Messaging | Free |
| Hosting | Render.com | Free tier |
| ML | scikit-learn (RandomForestRegressor), pandas, joblib | Free |
| Version control | GitHub | Free |

---

## Getting started

### Prerequisites
- Python 3.11+
- Git
- Chrome (to test push notifications)

### Setup

```bash
git clone https://github.com/YOUR-USERNAME/data-driven-cafe-wait-time.git
cd data-driven-cafe-wait-time

python -m venv venv
venv\Scripts\activate                 # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt

copy .env.example .env                # macOS/Linux: cp .env.example .env
# edit .env — at least change VENDOR_PIN and ADMIN_API_KEY

python scripts/seed_db.py
uvicorn backend.main:app --reload --port 8000
```

| Page | URL |
|---|---|
| Student dashboard | http://localhost:8000/ |
| Vendor dashboard | http://localhost:8000/vendor.html |
| API docs (Swagger) | http://localhost:8000/docs |

### Optional: demo data, ML and tests

```bash
python backend/ml/generate_sample_data.py   # ⚠️ SYNTHETIC — prints a warning every run
python backend/ml/train.py                  # trains per-cafe models -> backend/ml/model.joblib
python backend/ml/evaluate.py               # "Baseline MAE: X.X min | RF MAE: Y.Y min"
python -m pytest backend/tests -q           # 52 tests
```

### Optional: push notifications

```bash
python scripts/send_test_notification.py --gen-keys   # paste the keys into .env, restart
python scripts/send_test_notification.py              # after tapping "Enable" in the dashboard
```

See [docs/fcm-setup-guide.md](docs/fcm-setup-guide.md) and [docs/deployment-guide.md](docs/deployment-guide.md) (Render + Supabase).

---

## API endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/status` | — | Current status of all cafes |
| GET | `/api/status/{cafe_id}` | — | Status of one cafe |
| POST | `/api/status` | Vendor PIN (if `source=vendor`) | Vendor (or student) submits a status |
| POST | `/api/report` | — | Student reports crowd level |
| GET | `/api/report/recent/{cafe_id}` | — | Recent crowd reports |
| POST | `/api/orders` | Vendor PIN | Log an order served |
| GET | `/api/orders/count/{cafe_id}` | — | Orders in last N min, today, busiest hour |
| GET | `/api/predict/{cafe_id}` | — | Predicted wait time |
| GET | `/api/predict/worthit?cafe_id=X&available_minutes=Y` | — | "Is it worth waiting?" |
| GET | `/api/history/{cafe_id}` | — | Recent real events |
| GET | `/api/history/heatmap` | — | Best-time-to-visit grid |
| GET | `/api/notify/vapid-public-key` | — | Push public key |
| POST | `/api/subscribe` | — | Register for push notifications |
| DELETE | `/api/subscribe` | — | Unsubscribe |
| POST | `/api/notify/send` | Admin key | Run reminders now / broadcast |
| GET | `/api/admin/verify` | Vendor PIN | Vendor login check |
| GET | `/api/admin/stats` | Admin key | Data-collection statistics |
| POST | `/api/admin/cafe` | Admin key | Add/update a cafe |
| GET | `/api/cafes`, `/api/orders/items`, `/api/health` | — | Helpers |

Full request/response examples: [docs/api-reference.md](docs/api-reference.md). Schema: [docs/data-dictionary.md](docs/data-dictionary.md).

---

## Data collection & ethics

- **Vendor input:** one tap per status change; one tap per order served (optionally with the item and prep time).
- **Student crowdsourcing:** anonymous one-tap reports; per-client cooldown against spam.
- **Manual observation (planned):** team members log queue length and wait time during peak hours for 3–5 days per cafe.
- No personal data is collected — no names, accounts, photos or locations. Push subscriptions store only the browser's opaque endpoint and the chosen break time.
- Vendor participation is voluntary.
- **Synthetic data is labelled at every level:** `source='synthetic'` on every row, a printed warning on every generator run, "SYNTHETIC demo data" in every prediction explanation and heatmap that uses it. Live status, vendor stats and order counts ignore synthetic rows completely.

---

## ML model details

**Target:** `order_logs.estimated_prep_minutes` — minutes from ordering to being served.

**Baseline (always computed first):** mean wait per (cafe, day_of_week, 30-minute slot), backing
off to per-slot and then overall means. A lookup table, no ML — the benchmark any model must beat.

**RandomForestRegressor:** features `hour`, `minute_bin` (0/30), `day_of_week`,
`orders_last_15min`; 100 trees, max depth 8, min 3 samples per leaf. Trained per cafe, only when
that cafe has **200+ rows**.

**Evaluation:** leave-one-day-out cross-validation (train on every other day, test on the held-out
day), MAE in minutes. RF is used only if its MAE is lower than the baseline's; otherwise a warning
is logged and the cafe falls back to the baseline.

**Live correction:** if a vendor/crowd status is currently known, the predicted number is clamped
into that status's range (e.g. never "3 min" while the vendor says BUSY).

**Current result — synthetic data only (30 simulated days, ~950 rows, seed 42):**

| Cafe | Baseline MAE | RF MAE |
|---|---|---|
| cafe-a | 1.19 min | 1.00 min |
| cafe-b | 1.18 min | 1.03 min |
| cafe-c | 1.07 min | 0.98 min |

⚠️ These numbers say **nothing about real cafes.** The generator adds uniform ±2 min noise, whose
own MAE is 1.0 min, so the RF is simply recovering the pattern the generator was told to produce.
They only show that the pipeline runs end to end.

### Honest limitations
- One semester of data captures routine weekday patterns but cannot generalise to exam weeks,
  fests, holidays or timetable changes without retraining.
- The target depends on vendors entering prep times; if few do, the model falls back to typical
  item times, which are placeholders.
- Crowd reports are subjective and can be gamed; the cooldown is a speed bump, not security.
- With a few hundred rows, a RandomForest may well **not** beat the baseline. That is a valid
  finding and will be reported as such, not hidden.
- Walk times in `seed/cafes.json` must be replaced with measured values.
- The PostgreSQL adapter is not covered by the automated tests (they use SQLite).

---

## Project structure

```
├── backend/
│   ├── main.py, config.py, database.py
│   ├── models/      Pydantic models
│   ├── routers/     status, crowdsource, orders, predict, history, notify, admin
│   ├── services/    status_engine, prediction_engine, worthit_engine, notification_service, sheets_logger
│   ├── ml/          generate_sample_data.py, train.py, evaluate.py
│   ├── seed/        cafes.json
│   └── tests/       test_status_engine.py, test_worthit_engine.py, test_api.py
├── frontend/        index.html, vendor.html, css/, js/, sw.js, manifest.json, assets/
├── docs/            architecture, api-reference, deployment-guide, fcm-setup-guide, data-dictionary
├── data/            SQLite database (git-ignored), survey summary
└── scripts/         seed_db.py, send_test_notification.py
```

---

## Future work
- **Pre-ordering** with UPI payment integration (deliberately out of scope for this phase)
- **WhatsApp Business API** notifications for universal device coverage, including iPhones
- **Camera-based crowd counting** with computer vision (needs hardware and privacy approval)
- Multi-campus deployment
- Menu integration with real-time item availability
- Feedback loop where students rate wait-time accuracy to improve predictions

---

## References

1. Pusuluri, S. (2024). "Queue Management in College Canteens: A Participatory and Observational Approach to Understanding Waiting Experience and Process Delays." Case Study, VIT Vellore.
2. Goncalves, J., Kukka, H., Sánchez, I., & Kostakos, V. (2016). "Crowdsourcing Queue Estimations in Situ." *Proceedings of CSCW '16*, ACM. DOI: 10.1145/2818048.2819997
3. Maister, D. H. (1984). "The Psychology of Waiting Lines." Harvard Business School.
4. Bulut, M., et al. "LineKing: Crowdsourced Line Wait-Time Estimation Using Smartphones." *MobiCase*.
5. Norman, D. (2008). "The Psychology of Waiting Lines."

---

## Team

| Name | Role |
|---|---|
| [Your Name] | Developer, Researcher |
| [Teammate 2] | [Role] |
| [Teammate 3] | [Role] |

**Institution:** RV College of Engineering, Bengaluru · **Course:** Design Thinking Lab (DTL), 2nd Year CSE · **Academic year:** 2026–27

---

This project is developed for academic purposes.
