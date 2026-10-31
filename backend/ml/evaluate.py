"""
Leave-one-day-out cross-validation: baseline vs RandomForest.

    python backend/ml/evaluate.py                 # real data (falls back to synthetic per cafe)
    python backend/ml/evaluate.py --synthetic     # force synthetic data
    python backend/ml/evaluate.py --cafe cafe-a

Why leave-one-day-out? In real use the model always predicts a day it hasn't
seen. A random train/test split would put orders from the same lunch rush on
both sides and make the RF look far better than it is.

The baseline MAE is ALWAYS printed next to the RF MAE (project rule): an ML
number without its baseline says nothing about whether ML helped.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
# Windows consoles default to cp1252, which can't print the ⚠️ warning.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from backend.config import settings  # noqa: E402
from backend.database import init_db, query  # noqa: E402
from backend.services.prediction_engine import leave_one_day_out, load_observations, observations_for  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Leave-one-day-out CV: baseline vs RandomForest")
    parser.add_argument("--cafe", help="evaluate a single cafe id")
    parser.add_argument("--synthetic", action="store_true", help="use synthetic rows only")
    args = parser.parse_args()

    init_db()
    cafes = [args.cafe] if args.cafe else [c["id"] for c in query("SELECT id FROM cafes WHERE is_active ORDER BY id")]
    for cafe_id in cafes:
        if args.synthetic:
            df, label = load_observations(cafe_id, "synthetic"), "synthetic"
        else:
            df, label = observations_for(cafe_id)

        header = f"[{cafe_id}] {len(df)} rows, data={label}"
        if label == "synthetic":
            header += "  ⚠️ SYNTHETIC — not real observations"
        print(header)

        if df.empty or df["date"].nunique() < 2:
            print("  Not enough data (need at least 2 days).\n")
            continue
        if len(df) < settings.min_rows_for_ml:
            print(f"  Note: below the {settings.min_rows_for_ml}-row threshold; the live system uses baseline only.")

        r = leave_one_day_out(df)
        print(f"  Baseline MAE: {r['baseline_mae']:.1f} min | RF MAE: {r['rf_mae']:.1f} min   ({r['n_days']} folds)")
        if r["rf_mae"] >= r["baseline_mae"]:
            print("  WARNING: RF does not beat the baseline -> the system falls back to the baseline.")
        else:
            gain = (1 - r["rf_mae"] / r["baseline_mae"]) * 100
            print(f"  RF improves on baseline by {gain:.0f}%.")
        print()


if __name__ == "__main__":
    main()
