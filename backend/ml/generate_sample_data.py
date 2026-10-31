"""
SYNTHETIC data generator — for demos and testing ONLY.

    python backend/ml/generate_sample_data.py            # 30 days, replaces old synthetic rows
    python backend/ml/generate_sample_data.py --days 14 --seed 7

What it simulates (an assumption, NOT an observation):
  * 3 cafes, 30 days, opening hours 08:00–20:00 campus time.
  * Peak crowd 12:00–13:00, moderate 11:00–12:00 and 13:00–14:00, low otherwise.
  * More orders are served when it's busy, so orders_last_15min tracks the crowd.
  * Wait time = level for that hour x cafe factor x weekend factor, ±2 min noise.
  * ~900 order_logs rows in total (~300 per cafe — enough to exercise the
    200-row ML threshold).

Safety rules:
  * Every row is written with source='synthetic'. The live status engine,
    vendor stats and order counters ignore synthetic rows completely; history
    and predictions only fall back to them when NO real data exists, and then
    label the output "SYNTHETIC demo data".
  * Re-running deletes previous synthetic rows only. Real rows are never touched.
  * The warning below is printed on every run.
"""

import argparse
import random
import sys
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
# Windows consoles default to cp1252, which can't print the ⚠️ warning.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from backend.config import settings  # noqa: E402
from backend.database import execute, execute_many, init_db, query, seed_cafes, to_db_ts  # noqa: E402

WARNING = "⚠️ This is SYNTHETIC data for demo/testing purposes only. Not real observations."

# Expected orders per hour, and the typical wait (minutes) in that hour.
#   hour -> (expected orders/hour, typical wait)
LOW, MODERATE, PEAK = (0.35, 3.0), (2.25, 8.0), (4.0, 15.0)
HOUR_PROFILE = {h: LOW for h in range(8, 20)}
HOUR_PROFILE.update({11: MODERATE, 12: PEAK, 13: MODERATE})

# Assumed differences between cafes: the main canteen is busiest, the snack
# corner serves fast items. These are invented for the demo.
CAFE_FACTOR = {"cafe-a": 1.2, "cafe-b": 1.0, "cafe-c": 0.7}
WEEKEND_FACTOR = 0.5  # fewer students on campus on Sat/Sun
NOISE_MINUTES = 2.0
ITEMS = ["dosa", "biryani", "fried rice", "parotta", "meals", "juice", "coffee", "sandwich"]


def poisson(rng: random.Random, lam: float) -> int:
    """Knuth's algorithm — fine for the tiny lambdas used here, no numpy needed."""
    import math

    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


def generate(days: int = 30, seed: int = 42, end: date | None = None) -> int:
    rng = random.Random(seed)
    tz = ZoneInfo(settings.timezone)
    cafes = [c["id"] for c in query("SELECT id FROM cafes WHERE is_active ORDER BY id")]
    end = end or (datetime.now(tz).date() - timedelta(days=1))  # up to yesterday
    rows = []

    for offset in range(days):
        day = end - timedelta(days=days - 1 - offset)
        weekend = day.weekday() >= 5
        for cafe_id in cafes:
            cafe_factor = CAFE_FACTOR.get(cafe_id, 1.0)
            for hour, (orders_per_hour, typical_wait) in HOUR_PROFILE.items():
                n_orders = poisson(rng, orders_per_hour * (WEEKEND_FACTOR if weekend else 1.0))
                for _ in range(n_orders):
                    local = datetime.combine(day, time(hour, rng.randrange(60), rng.randrange(60)), tz)
                    wait = typical_wait * cafe_factor * (WEEKEND_FACTOR if weekend else 1.0)
                    wait += rng.uniform(-NOISE_MINUTES, NOISE_MINUTES)
                    rows.append((cafe_id, rng.choice(ITEMS), round(max(wait, 0.5), 1), to_db_ts(local)))

    execute("DELETE FROM order_logs WHERE source = 'synthetic'")
    execute_many(
        "INSERT INTO order_logs (cafe_id, item_name, estimated_prep_minutes, source, timestamp) "
        "VALUES (?, ?, ?, 'synthetic', ?)",
        rows,
    )
    return len(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate clearly-labelled SYNTHETIC demo data.")
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--seed", type=int, default=42, help="same seed = same data (reproducible demos)")
    args = parser.parse_args()

    print(WARNING)
    init_db()
    if not query("SELECT id FROM cafes LIMIT 1"):
        seed_cafes()
    n = generate(args.days, args.seed)
    print(f"Inserted {n} synthetic order_logs rows (source='synthetic') into {settings.database_url}")
    for row in query(
        "SELECT cafe_id, COUNT(*) AS n FROM order_logs WHERE source = 'synthetic' GROUP BY cafe_id ORDER BY cafe_id"
    ):
        print(f"  {row['cafe_id']}: {row['n']} rows")
    print(WARNING)


if __name__ == "__main__":
    main()
