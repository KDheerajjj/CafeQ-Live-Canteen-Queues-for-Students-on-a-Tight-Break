# Deployment guide

## Local development

```bash
python -m venv venv
venv\Scripts\activate            # Windows   (macOS/Linux: source venv/bin/activate)
pip install -r requirements.txt
copy .env.example .env           # macOS/Linux: cp .env.example .env
python scripts/seed_db.py
uvicorn backend.main:app --reload --port 8000
```

* Student dashboard: <http://localhost:8000/>
* Vendor dashboard: <http://localhost:8000/vendor.html> (PIN = `VENDOR_PIN`)
* API docs: <http://localhost:8000/docs>

Optional demo data + model:

```bash
python backend/ml/generate_sample_data.py   # prints the SYNTHETIC warning
python backend/ml/train.py
python backend/ml/evaluate.py
python -m pytest backend/tests -q
```

**Testing on your phone over Wi-Fi:** run `uvicorn backend.main:app --host 0.0.0.0 --port 8000`
and open `http://<laptop-ip>:8000`. The dashboard works, but push notifications need HTTPS, so
test push on `localhost` or on Render.

## Render.com (free tier)

1. Push the repo to GitHub.
2. Render → **New → Web Service** → connect the repo.
3. Settings:

   | Field | Value |
   |---|---|
   | Runtime | Python 3 |
   | Build command | `pip install -r requirements.txt` |
   | Start command | `uvicorn backend.main:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips="*"` |
   | Health check path | `/api/health` |
   | Instance type | Free |

4. **Environment** tab — add every variable from `.env.example` with real values, plus
   `PYTHON_VERSION=3.11.9`. Generate a long random `ADMIN_API_KEY`, and change `VENDOR_PIN` from
   `1234`.
5. Deploy. On first boot the app creates the tables and seeds the cafes automatically.

### Free-tier caveats (be honest about these in the report)

* **Ephemeral disk.** The SQLite file is wiped on every deploy/restart. Fine for a demo; for real
  data collection use Supabase (below) or mirror events to Google Sheets
  (`GOOGLE_SHEETS_WEBHOOK_URL`, see `backend/services/sheets_logger.py`).
* **Sleeping instances.** Free services sleep after ~15 minutes without traffic, which pauses the
  once-a-minute reminder loop. Use a free external cron (e.g. cron-job.org) to call, every minute:

  ```
  POST https://<your-app>.onrender.com/api/notify/send
  Header: X-Admin-Key: <ADMIN_API_KEY>
  Body:   {"mode": "reminders"}
  ```

  This both wakes the instance and runs the reminder tick. If the in-process loop is also awake,
  the service remembers who already got today's reminder, so nobody is notified twice.
* **Cold starts** take ~30–60 s; the first page load after a sleep is slow.

## Supabase PostgreSQL (production database)

1. Create a free project at supabase.com → Project Settings → Database → copy the **connection
   string (URI)**, using the connection pooler if offered.
2. Uncomment `psycopg[binary]` in `requirements.txt`.
3. Set `DATABASE_URL=postgresql://...` in Render's environment.
4. Deploy — `init_db()` creates the tables (`SERIAL` ids, `BOOLEAN TRUE`) on boot.

> ⚠️ The PostgreSQL path is a thin adapter in `backend/database.py` (rewrites `?` placeholders to
> `%s`, uses `RETURNING id`). It has **not** been run by the automated tests, which use SQLite.
> Do a full click-through (vendor tap, report, order, worth-it, heatmap) after switching.

Training on Render: run `python backend/ml/train.py` from Render's **Shell** tab after enough real
data exists. `model.joblib` lives on the ephemeral disk too, so re-run training after each deploy
(or commit a trained model deliberately and remove it from `.gitignore`).

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./data/cafeq.db` | Relative SQLite paths resolve from the project root |
| `VENDOR_PIN` | `1234` | Shared vendor PIN (demo-grade) |
| `ADMIN_API_KEY` | — | Admin endpoints are disabled until set |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL` | — | Web Push identity (see fcm-setup-guide.md) |
| `FCM_SERVER_KEY` | — | Legacy FCM API key; not used by Web Push |
| `STALE_THRESHOLD_MINUTES` | 15 | Vendor updates older than this → Unknown |
| `CROWD_WINDOW_MINUTES` | 10 | Crowd reports older than this are ignored |
| `STATUS_REFRESH_SECONDS` | 30 | Dashboard polling interval |
| `REMINDER_LEAD_MINUTES` | 10 | Push reminder lead time |
| `DEFAULT_EATING_BUFFER_MINUTES` | 10 | Time to eat, used by "Worth it?" |
| `TIMEZONE` | `Asia/Kolkata` | Campus time zone |
| `DEFAULT_ORIGIN_CAFE_ID` | `cafe-a` | "Main building" = next to this cafe |
| `MIN_ROWS_FOR_ML` | 200 | Rows per cafe before RandomForest is tried |
| `REPORT_COOLDOWN_SECONDS` | 120 | Anti-spam window for crowd reports |
| `ENABLE_SCHEDULER` | 1 | 0 disables the in-process reminder loop |
| `GOOGLE_SHEETS_WEBHOOK_URL` | — | Optional Apps Script URL to mirror events |

### Optional Google Sheets mirror

In a Google Sheet: **Extensions → Apps Script**, paste:

```javascript
function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  SpreadsheetApp.getActiveSheet().appendRow([
    data.logged_at_utc, data.kind, data.cafe_id, data.status || "", data.item || "", data.prep_minutes || ""
  ]);
  return ContentService.createTextOutput("ok");
}
```

Deploy → **New deployment → Web app** (execute as you, access: anyone with the link), and put the
URL in `GOOGLE_SHEETS_WEBHOOK_URL`. Every vendor tap, crowd report and order is then appended as a row.
