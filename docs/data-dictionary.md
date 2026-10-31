# Data dictionary

All timestamps are stored in **UTC** as `YYYY-MM-DD HH:MM:SS`. Hour/day features are derived in
campus time (`TIMEZONE`, default Asia/Kolkata). No personal data (names, roll numbers, emails,
photos, locations) is stored anywhere.

## `cafes`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Slug, e.g. `cafe-a` |
| `name` | TEXT | Display name, e.g. "Cafe A (Main Canteen)" |
| `location_description` | TEXT | Human-readable location |
| `walk_times_json` | TEXT (JSON) | Minutes on foot from this cafe to others: `{"cafe-b": 3}` (manually measured) |
| `is_active` | BOOLEAN | Inactive cafes disappear from all endpoints |
| `created_at` | TIMESTAMP | |

## `status_updates`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `cafe_id` | TEXT FK | |
| `status` | TEXT | `green` / `yellow` / `red` |
| `source` | TEXT | `vendor` (live, trusted), `crowdsource` (legacy), `ml`, `synthetic` (demo only) |
| `reporter_id` | TEXT | Optional anonymous device id; never a name |
| `timestamp` | TIMESTAMP | |

## `crowd_reports`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `cafe_id` | TEXT FK | |
| `reported_status` | TEXT | `green` / `yellow` / `red` |
| `source` | TEXT | `real` or `synthetic` *(project extension)* |
| `timestamp` | TIMESTAMP | |

## `order_logs`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `cafe_id` | TEXT FK | |
| `item_name` | TEXT | Optional, lower-case (`dosa`, `coffee`, …) |
| `estimated_prep_minutes` | REAL | Minutes from order to serving. **ML target ("wait").** Optional |
| `source` | TEXT | `real` or `synthetic` *(project extension)* |
| `timestamp` | TIMESTAMP | When the order was served |

## `push_subscribers`

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `endpoint` | TEXT UNIQUE | Push-service URL from the browser (FCM URL on Chrome) |
| `p256dh_key`, `auth_key` | TEXT | Encryption keys from the browser |
| `break_time` | TEXT | Campus-local `HH:MM`; reminder fires 10 min before |
| `preferred_cafe_id` | TEXT FK | Listed first in the notification |
| `created_at` | TIMESTAMP | |

## `predictions`

Audit log of what the system predicted (at most one row per cafe per 5 minutes), so predictions can
later be compared with what actually happened.

| Column | Type | Notes |
|---|---|---|
| `cafe_id` | TEXT FK | |
| `predicted_wait_minutes` | REAL | |
| `model_type` | TEXT | `baseline` / `rf` / `manual` |
| `confidence` | TEXT | `low` / `medium` / `high` |
| `timestamp` | TIMESTAMP | |

## Derived values

| Name | Definition |
|---|---|
| Status level → wait range | green 0–5 min, yellow 5–12 min, red 12+ min |
| Typical wait per level | green 3, yellow 8, red 15 min (notifications, heatmap) |
| Stale | Vendor update > 15 min old, crowd report > 10 min old |
| `orders_last_15min` | Orders by the same cafe (same source) in the 15 min before an order / before now |
| `minute_bin` | 0 if minute < 30 else 30 |
| `slot` | Half-hour slot of the day, `hour*2 + minute_bin/30` (0–47) |
| `day_of_week` | Monday = 0 … Sunday = 6 |

## Extensions to the original schema

The spec's schema is used as-is with one deliberate addition: a `source` marker on
`order_logs` and `crowd_reports`, and `synthetic` as an allowed `status_updates.source`. This is
what lets the project guarantee that synthetic demo data is never confused with real
observations. `database.py` adds the columns automatically to databases created from the
original schema.
