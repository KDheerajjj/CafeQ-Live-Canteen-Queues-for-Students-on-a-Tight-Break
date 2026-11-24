"""Train (or decline to train) the CafeQ time-at-cafe model. OFFLINE ONLY.

Policy (the app never claims a model it doesn't have):
  1. Baseline = the formula the app already ships (see cafeq_ml.baseline).
  2. Only REAL feedback counts (rows with source="real", exported from /admin.html).
     Synthetic rows can only be used with --demo, never mixed with real ones, and a
     demo model is never written into public/.
  3. Need >= --min-rows usable rows (default 150) spread over >= 3 days.
  4. Leave-one-day-out cross-validation: for each day, train on the other days and
     predict that day. Report the MAE of the formula AND of the random forest.
  5. Publish public/model.json only if the forest's MAE beats the formula's.
     Otherwise any existing public/model.json is left untouched, and the app keeps
     using the formula. A report is always written to scripts/ml/out/report.json.

Usage:
  py -3 scripts/ml/train.py --data cafeq-feedback.csv            # real data from /admin.html
  py -3 scripts/ml/train.py --data scripts/ml/data/synthetic_feedback.csv --demo
  Options --green-max/--yellow-max/--prep-buffer/--congestion must match the live
  admin settings if they were changed (defaults = config.js defaults).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from cafeq_ml import FEATURES, FormulaSettings, baseline, load_rows, matrix

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = Path(__file__).parent / "out"
PUBLIC_MODEL = ROOT / "public" / "model.json"


def mae(pairs) -> float:
    pairs = list(pairs)
    return sum(abs(a - b) for a, b in pairs) / len(pairs)


def make_forest():
    from sklearn.ensemble import RandomForestRegressor

    # Small on purpose: the whole forest ships to phones as JSON.
    return RandomForestRegressor(n_estimators=30, max_depth=6, min_samples_leaf=5, random_state=42)


def export_forest(rf) -> list[dict]:
    """sklearn trees -> the compact arrays public/js/model.js walks."""
    trees = []
    for est in rf.estimators_:
        t = est.tree_
        trees.append(
            {
                "left": t.children_left.tolist(),  # -1 marks a leaf
                "right": t.children_right.tolist(),
                "feature": [int(f) if f >= 0 else -1 for f in t.feature.tolist()],
                "threshold": [round(float(x), 4) for x in t.threshold.tolist()],
                "value": [round(float(v), 3) for v in t.value[:, 0, 0].tolist()],
            }
        )
    return trees


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="feedback CSV (admin export, or the synthetic demo file)")
    ap.add_argument("--demo", action="store_true", help="synthetic data: write scripts/ml/out/model.demo.json, never public/")
    ap.add_argument("--min-rows", type=int, default=150)
    ap.add_argument("--green-max", type=int, default=2)
    ap.add_argument("--yellow-max", type=int, default=6)
    ap.add_argument("--prep-buffer", type=float, default=1.0)
    ap.add_argument("--congestion", type=float, default=1.2)
    args = ap.parse_args()

    s = FormulaSettings(args.green_max, args.yellow_max, args.prep_buffer, args.congestion)
    rows, notes = load_rows(args.data, s)
    sources = {r["source"] for r in rows}
    report: dict = {
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "data": str(args.data),
        "mode": "demo (synthetic)" if args.demo else "real",
        "n_rows": len(rows),
        "notes": notes,
        "formula_settings": s.__dict__,
    }

    # --- data provenance guards ---
    if args.demo and sources - {"synthetic"}:
        sys.exit("Refusing: --demo data must be ALL synthetic (never mix real and synthetic rows).")
    if not args.demo and sources - {"real"}:
        sys.exit(f"Refusing: found sources {sorted(sources)}; real training uses only source=real rows from /admin.html.")

    days = sorted({r["day"] for r in rows})
    report["n_days"] = len(days)
    report["mae_baseline_all"] = round(mae((baseline(r, s), r["y"]) for r in rows), 3) if rows else None

    decision = None
    if len(rows) < args.min_rows:
        decision = f"Not enough labelled rows ({len(rows)} < {args.min_rows}). Keep using the formula; collect more feedback."
    elif len(days) < 3:
        decision = f"Need feedback from at least 3 different days for leave-one-day-out CV (have {len(days)})."

    if decision is None:
        # --- leave-one-day-out cross-validation ---
        pred_pairs_model, pred_pairs_base, per_day = [], [], []
        for day in days:
            train = [r for r in rows if r["day"] != day]
            test = [r for r in rows if r["day"] == day]
            rf = make_forest().fit(matrix(train), [r["y"] for r in train])
            preds = rf.predict(matrix(test))
            m_pairs = list(zip(preds, (r["y"] for r in test)))
            b_pairs = [(baseline(r, s), r["y"]) for r in test]
            pred_pairs_model += m_pairs
            pred_pairs_base += b_pairs
            per_day.append({"day": day, "n": len(test), "mae_model": round(mae(m_pairs), 3), "mae_baseline": round(mae(b_pairs), 3)})
        report["cv"] = "leave-one-day-out"
        report["mae_model"] = round(float(mae(pred_pairs_model)), 4)
        report["mae_baseline"] = round(float(mae(pred_pairs_base)), 4)
        report["per_day"] = per_day
        wins = report["mae_model"] < report["mae_baseline"]
        decision = (
            f"Random forest beats the formula (MAE {report['mae_model']} vs {report['mae_baseline']} min)."
            if wins
            else f"Random forest did NOT beat the formula (MAE {report['mae_model']} vs {report['mae_baseline']} min). Keep the formula."
        )

        if wins:
            rf = make_forest().fit(matrix(rows), [r["y"] for r in rows])
            model = {
                "type": "random_forest",
                "use_model": True,
                "features": FEATURES,
                "target": "actual_total_min",
                "mae_model": report["mae_model"],
                "mae_baseline": report["mae_baseline"],
                "cv": "leave-one-day-out",
                "n_rows": len(rows),
                "n_days": len(days),
                "trained_at": report["trained_at"],
                "synthetic": bool(args.demo),
                "trees": export_forest(rf),
            }
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            target = OUT_DIR / "model.demo.json" if args.demo else PUBLIC_MODEL
            target.write_text(json.dumps(model, separators=(",", ":")), encoding="utf-8")
            report["published"] = str(target.relative_to(ROOT))
            # A few predictions so the JS implementation can be checked against sklearn.
            report["parity_samples"] = [
                {"features": {f: rows[i][f] for f in FEATURES}, "sklearn": round(float(p), 4)}
                for i, p in zip(range(5), rf.predict(matrix(rows[:5])))
            ]

    report["decision"] = decision
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"Rows: {len(rows)} over {len(days)} days ({report['mode']}).")
    if report.get("mae_baseline") is not None:
        print(f"MAE  formula (baseline): {report['mae_baseline']} min   random forest: {report['mae_model']} min   [leave-one-day-out]")
    elif report["mae_baseline_all"] is not None:
        print(f"MAE  formula on all rows: {report['mae_baseline_all']} min")
    print(decision)
    if report.get("published"):
        print(f"Wrote {report['published']}" + ("  (DEMO: not used by the app)" if args.demo else "  -> deploy to let the app use it"))
    print(f"Report: {(OUT_DIR / 'report.json').relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
