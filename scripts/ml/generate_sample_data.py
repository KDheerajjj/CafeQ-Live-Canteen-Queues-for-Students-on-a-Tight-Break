"""Generate SYNTHETIC feedback rows for demonstrating the ML pipeline.

DEMO ONLY. Every row is marked source="synthetic" and train.py refuses to mix
synthetic rows with real ones or to publish a model trained on them to the app.
These numbers are invented by the process below; they say nothing about the
real cafes and must never be presented as findings.

How the fake data is made (so the demo is transparent):
    true time = queue * service_sec/60 * (1.25 if red)        # a slightly different congestion than the app
                + item prep + lunch-rush slowdown (12:00-14:00: +15%)
                + Monday slowdown (+1 min) + random noise (sd 1.5 min)
That way a model has *something* the formula doesn't capture, which is what the
pipeline's comparison is meant to detect.

Usage:  py -3 scripts/ml/generate_sample_data.py [--rows 400] [--seed 7]
Output: scripts/ml/data/synthetic_feedback.csv
"""

import argparse
import csv
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

CAFES = [  # id, type, serving seconds per person (the same ASSUMED values as seed/cafes.json)
    ("cafe-a", "cafe", 45),
    ("cafe-b", "canteen", 60),
    ("cafe-c", "cafe", 45),
    ("cafe-d", "cafe", 45),
]
COLUMNS = [
    "source", "id", "cafe_id", "cafe_name", "cafe_type", "service_sec_per_person", "item_id", "item_name",
    "item_prep_min", "queue_count_at_report", "est_total_min", "actual_total_min", "started_at", "created_at",
]
IST = timezone(timedelta(hours=5, minutes=30))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rows", type=int, default=400)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rnd = random.Random(args.seed)

    out = Path(__file__).parent / "data" / "synthetic_feedback.csv"
    out.parent.mkdir(parents=True, exist_ok=True)
    start = datetime(2027, 1, 4, tzinfo=IST)  # a Monday; arbitrary demo dates
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS)
        w.writeheader()
        for i in range(args.rows):
            cafe_id, ctype, sec = rnd.choice(CAFES)
            day = rnd.randrange(0, 20)
            if (start + timedelta(days=day)).weekday() >= 5:
                day += 2  # weekdays only
            when = start + timedelta(days=day, hours=rnd.choice([10, 11, 12, 12, 13, 13, 14, 15, 16]), minutes=rnd.randrange(60))
            q = max(0, int(rnd.gauss(5, 3.5)))
            has_item = rnd.random() < 0.7
            prep = rnd.choice([1, 2, 3, 4, 5, 6, 8]) if has_item else None
            red = q > 6
            true = q * sec / 60 * (1.25 if red else 1.0) + (prep if prep is not None else 1)
            if 12 <= when.hour < 14:
                true *= 1.15
            if when.weekday() == 0:
                true += 1
            true += rnd.gauss(0, 1.5)
            actual = max(1, min(120, round(true)))
            w.writerow(
                {
                    "source": "synthetic",
                    "id": f"synthetic-{i}",
                    "cafe_id": cafe_id,
                    "cafe_name": "",
                    "cafe_type": ctype,
                    "service_sec_per_person": sec,
                    "item_id": "",
                    "item_name": "",
                    "item_prep_min": "" if prep is None else prep,
                    "queue_count_at_report": q,
                    "est_total_min": "",
                    "actual_total_min": actual,
                    "started_at": when.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "created_at": (when + timedelta(minutes=20)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                }
            )
    print(f"Wrote {args.rows} SYNTHETIC rows to {out} (source=synthetic, demo only).")


if __name__ == "__main__":
    main()
