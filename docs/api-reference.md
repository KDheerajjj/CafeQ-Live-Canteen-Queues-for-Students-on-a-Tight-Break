# API reference

Base URL: `http://localhost:8000` (dev) or your Render URL. Interactive docs are generated
automatically at **`/docs`** (Swagger UI) and `/redoc`.

Timestamps are UTC strings `YYYY-MM-DD HH:MM:SS`. Errors return `{"detail": "..."}`.

## Authentication

| Header | Used by | Value |
|---|---|---|
| `X-Vendor-PIN` | vendor status updates, order logging, `/api/admin/verify` | `VENDOR_PIN` from `.env` |
| `X-Admin-Key` | `/api/admin/stats`, `/api/admin/cafe`, `/api/notify/send` | `ADMIN_API_KEY` from `.env` |

Student endpoints need no auth. Secrets are always sent as headers, never in URLs.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | Liveness check |
| GET | `/api/cafes` | — | Active cafes with walk times |
| GET | `/api/status` | — | Computed status of all cafes |
| GET | `/api/status/{cafe_id}` | — | Computed status of one cafe |
| POST | `/api/status` | PIN if `source=vendor` | Vendor (or student) submits a status |
| POST | `/api/report` | — | Student crowd report |
| GET | `/api/report/recent/{cafe_id}?minutes=30` | — | Recent real crowd reports |
| GET | `/api/orders/items` | — | Common items for the vendor dropdown |
| POST | `/api/orders` | PIN | Log one order served |
| GET | `/api/orders/count/{cafe_id}?minutes=15` | — | Orders in window, today, busiest hour |
| GET | `/api/predict/{cafe_id}` | — | Predicted wait (baseline / RF / manual) |
| GET | `/api/predict/worthit` | — | "Is it worth waiting?" |
| GET | `/api/history/heatmap?cafe_id=` | — | 7×12 best-time-to-visit grid |
| GET | `/api/history/{cafe_id}?hours=24` | — | Raw real events |
| GET | `/api/notify/vapid-public-key` | — | Key for `pushManager.subscribe` |
| POST | `/api/subscribe` | — | Register / update a push subscription |
| DELETE | `/api/subscribe` | — | Remove a push subscription |
| POST | `/api/notify/send` | Admin | Run the reminder tick now, or broadcast |
| GET | `/api/admin/verify` | PIN | Vendor login check |
| GET | `/api/admin/stats` | Admin | Data-collection counts (real vs synthetic) |
| POST | `/api/admin/cafe` | Admin | Add or update a cafe |

---

### `GET /api/status`

```json
{
  "generated_at": "2026-11-02 07:00:05",
  "stale_threshold_minutes": 15,
  "refresh_seconds": 30,
  "cafes": [
    {
      "cafe_id": "cafe-a",
      "name": "Cafe A (Main Canteen)",
      "location_description": "Near Main Building, Ground Floor",
      "status": "yellow",              // green | yellow | red | unknown
      "source": "vendor",              // vendor | crowdsource | null
      "confidence": "high",            // high | medium | low | null
      "wait_min_minutes": 5.0,
      "wait_max_minutes": 12.0,        // null for red (12+)
      "wait_estimate": "5–12 min",     // null when unknown
      "wait_typical_minutes": 8.0,
      "last_updated": "2026-11-02 06:56:40",
      "update_age_minutes": 3.4,
      "crowd_report_count": 0
    }
  ]
}
```

### `POST /api/status`

```http
POST /api/status
X-Vendor-PIN: 1234
Content-Type: application/json

{"cafe_id": "cafe-a", "status": "red", "source": "vendor"}
```

`source` is `vendor` (default, PIN required) or `crowdsource` (stored as a crowd report and
subject to the report cooldown). `ml`/`synthetic` cannot be posted. Returns the recomputed
`CafeStatus` (201). Errors: 401 bad PIN, 404 unknown cafe, 422 invalid body, 429 cooldown.

### `POST /api/report`

```json
{"cafe_id": "cafe-b", "reported_status": "yellow"}
```

Returns the recomputed `CafeStatus` (201). One report per cafe per client every 120 s (429 otherwise).

### `POST /api/orders`

```json
{"cafe_id": "cafe-a", "item_name": "dosa", "estimated_prep_minutes": 6.5}
```

Both `item_name` and `estimated_prep_minutes` are optional. If an item from the common list is
given without a time, its typical prep time is recorded.

### `GET /api/orders/count/{cafe_id}?minutes=15`

```json
{"cafe_id": "cafe-a", "window_minutes": 15, "count": 7, "orders_today": 87,
 "busiest_hour_today": 12, "busiest_hour_orders": 31}
```

Real orders only; "today" is the campus-local (IST) day.

### `GET /api/predict/{cafe_id}`

```json
{
  "cafe_id": "cafe-a",
  "predicted_wait_minutes": 12.0,
  "model_type": "rf",
  "confidence": "medium",
  "explanation": "RandomForest trained on 312 rows (SYNTHETIC demo data); CV MAE 1.0 min vs baseline 1.2 min; adjusted to match live status 'red'",
  "live_status": "red",
  "timestamp": "2026-11-02 07:00:05"
}
```

### `GET /api/predict/worthit`

| Query | Required | Notes |
|---|---|---|
| `cafe_id` | yes | |
| `available_minutes` | yes | 0 < x ≤ 240 |
| `from_cafe_id` | no | Where the student is; default = main building (next to `cafe-a`) |
| `eating_buffer` | no | Overrides `DEFAULT_EATING_BUFFER_MINUTES` |

```json
{
  "recommendation": "alternative",          // go | alternative | skip
  "message": "Cafe A (Main Canteen) needs ~23 min — too long. Try Cafe C (Snack Corner) instead (~17.2 min total).",
  "available_minutes": 20,
  "requested": {"cafe_id": "cafe-a", "name": "...", "walk_minutes": 1, "predicted_wait_minutes": 12,
                "eating_buffer_minutes": 10, "total_minutes": 23, "time_left_to_eat": 7},
  "suggested": {"cafe_id": "cafe-c", "...": "..."},
  "options": ["... all cafes, cheapest first ..."]
}
```

### `GET /api/history/heatmap?cafe_id=cafe-a`

```json
{
  "cafe_id": "cafe-a",
  "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  "hours": [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
  "grid": [[{"avg_wait": 3.1, "level": "green", "samples": 4}, "... 12 per row ..."], "... 7 rows ..."],
  "best_slot": {"day": "Tue", "hour": 9, "avg_wait": 2.4},
  "filled_cells": 61,
  "total_samples": 312,
  "data_source": "synthetic",              // real | synthetic | none
  "note": "SYNTHETIC demo data — not real observations"
}
```

`best_slot` is `null` until at least 10 cells have data, and only cells with 3+ samples qualify.

### `POST /api/subscribe`

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/…",
  "keys": {"p256dh": "…", "auth": "…"},
  "break_time": "12:30",
  "preferred_cafe_id": "cafe-b"
}
```

Upserts by `endpoint`. `break_time` is campus-local `HH:MM`. `DELETE /api/subscribe` takes `{"endpoint": "…"}`.

### `POST /api/notify/send` (admin)

```json
{"mode": "reminders"}                                   // run the 10-min-before-break tick now
{"mode": "broadcast", "title": "CafeQ", "body": "..."}  // everyone; body defaults to live status
```

### `GET /api/admin/stats` (admin)

Counts of real vendor updates, crowd reports and orders (all-time and last 24 h), synthetic rows
(reported separately, never summed with real), subscribers and logged predictions.

### `POST /api/admin/cafe` (admin)

```json
{"id": "cafe-d", "name": "Cafe D (Juice Bar)", "location_description": "Near Block 4",
 "walk_times": {"cafe-a": 6, "cafe-b": 4}, "is_active": true}
```
