"""
Trains the wait-time models and saves them to backend/ml/model.joblib.

    python backend/ml/train.py

Per cafe:
  1. Load observations (real data; synthetic only if the cafe has no real data).
  2. < 200 rows  -> baseline only (RandomForest would overfit).
  3. >= 200 rows -> leave-one-day-out CV of baseline vs RandomForest.
     RF is kept only if its MAE is lower; otherwise a warning is logged and the
     cafe falls back to the baseline.
  4. Save the bundle + a readable model_meta.json next to it.

The running API reloads model.joblib automatically when the file changes.
"""

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
# Windows consoles default to cp1252, which can't print the ⚠️ warning.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from backend.database import init_db  # noqa: E402
from backend.services.prediction_engine import MODEL_PATH, train_all  # noqa: E402


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    init_db()
    bundle = train_all()

    print(f"\nSaved {MODEL_PATH}")
    print(f"{'cafe':<8} {'data':<10} {'rows':>5} {'baseline MAE':>13} {'RF MAE':>8}  model")
    for cafe_id, e in bundle["cafes"].items():
        base = f"{e['baseline_mae']:.2f}" if e["baseline_mae"] is not None else "—"
        rf = f"{e['rf_mae']:.2f}" if e["rf_mae"] is not None else "—"
        print(f"{cafe_id:<8} {e['data']:<10} {e['n_rows']:>5} {base:>13} {rf:>8}  {e['model_type']}  ({e['reason']})")
        if e["data"] == "synthetic":
            print("         ⚠️ trained on SYNTHETIC demo data — not evidence about real cafes")


if __name__ == "__main__":
    main()
