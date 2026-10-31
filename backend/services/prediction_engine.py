"""
Prediction engine — "how long will I wait at cafe X right now?"

Two models, always in this order (project rule: baseline before ML):

1. BASELINE: the historical average wait for (cafe, day_of_week, 30-min slot).
   A lookup table — no ML. Every ML result is judged against it.
2. RANDOM FOREST: trained only when a cafe has 200+ observations, on the
   features hour, minute_bin (0/30), day_of_week, orders_last_15min.
   It is used ONLY if its leave-one-day-out MAE beats the baseline's MAE;
   otherwise a warning is logged and the baseline is used.

Where does "wait time" come from?
   order_logs.estimated_prep_minutes — the minutes between ordering and being
   served, logged by the vendor. With only a semester of data the target is
   small and noisy; the README documents this limitation honestly.

Real vs synthetic data:
   Real rows are always preferred. A cafe with NO real observations falls back
   to synthetic demo rows, and every explanation string then says
   "SYNTHETIC demo data" so a demo can never pass synthetic numbers off as real.

Live correction:
   If the live status (vendor tap / crowd consensus) is known, the predicted
   number is clamped into that level's range — e.g. a vendor just tapped RED,
   so we never predict "3 min" for that cafe even if Tuesdays are usually quiet.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from backend.config import ML_DIR, settings
from backend.database import execute, minutes_ago, query, query_one, to_db_ts, utc_now
from backend.models.prediction import Prediction
from backend.services import status_engine

logger = logging.getLogger("cafeq.prediction")

MODEL_PATH = ML_DIR / "model.joblib"
FEATURES = ["hour", "minute_bin", "day_of_week", "orders_last_15min"]
# Used when there is no data of any kind for a cafe: assume "moderate" so the
# "worth it?" engine stays cautious rather than optimistic.
NO_DATA_DEFAULT_WAIT = status_engine.WAIT_RANGES["yellow"][3]
# Don't write a predictions row more often than this per cafe (audit log, not a firehose).
PREDICTION_LOG_INTERVAL_MINUTES = 5


# ---------------------------------------------------------------------------
# Data loading & feature engineering
# ---------------------------------------------------------------------------

def load_observations(cafe_id: Optional[str] = None, source: str = "real") -> pd.DataFrame:
    """
    Wait-time observations as a DataFrame with campus-local time features.
    Columns: cafe_id, ts_local, date, hour, minute_bin, slot, day_of_week,
             orders_last_15min, wait, source.
    """
    sql = (
        "SELECT cafe_id, timestamp, estimated_prep_minutes AS wait, source FROM order_logs "
        "WHERE source = ?"
    )
    params: list = [source]
    if cafe_id:
        sql += " AND cafe_id = ?"
        params.append(cafe_id)
    rows = query(sql, params)
    if not rows:
        return pd.DataFrame(columns=["cafe_id", "ts_local", "date", "hour", "minute_bin",
                                     "slot", "day_of_week", "orders_last_15min", "wait", "source"])

    df = pd.DataFrame(rows)
    df["ts_local"] = (
        pd.to_datetime(df["timestamp"].astype(str)).dt.tz_localize("UTC").dt.tz_convert(settings.timezone)
    )
    df = df.sort_values(["cafe_id", "ts_local"]).reset_index(drop=True)
    df["orders_last_15min"] = _rolling_order_counts(df)

    # Only rows with a measured wait are training targets; the rest still
    # counted toward orders_last_15min above.
    df = df[df["wait"].notna()].copy()
    df["wait"] = df["wait"].astype(float)
    df["date"] = df["ts_local"].dt.date
    df["hour"] = df["ts_local"].dt.hour
    df["minute_bin"] = np.where(df["ts_local"].dt.minute < 30, 0, 30)
    df["slot"] = df["hour"] * 2 + (df["minute_bin"] // 30)  # 0..47 half-hour slots
    df["day_of_week"] = df["ts_local"].dt.dayofweek  # Monday = 0
    return df.drop(columns=["timestamp"])


def _rolling_order_counts(df: pd.DataFrame) -> pd.Series:
    """For each order: how many orders the same cafe served in the previous 15 min."""
    counts = pd.Series(0, index=df.index, dtype=int)
    for _, group in df.groupby("cafe_id"):
        times = group["ts_local"].values
        # searchsorted on a sorted array: index of the first order >= t - 15min.
        starts = np.searchsorted(times, times - np.timedelta64(15, "m"), side="left")
        counts.loc[group.index] = np.arange(len(times)) - starts
    return counts


def observations_for(cafe_id: Optional[str]) -> tuple[pd.DataFrame, str]:
    """Real data if any exists, else synthetic. Returns (df, data_label)."""
    real = load_observations(cafe_id, "real")
    if len(real):
        return real, "real"
    synthetic = load_observations(cafe_id, "synthetic")
    if len(synthetic):
        return synthetic, "synthetic"
    return real, "none"


# ---------------------------------------------------------------------------
# Baseline model (lookup table)
# ---------------------------------------------------------------------------

class BaselineModel:
    """Mean wait per (day_of_week, slot), backing off to per-slot, then overall."""

    def fit(self, df: pd.DataFrame) -> "BaselineModel":
        self.by_day_slot = df.groupby(["day_of_week", "slot"])["wait"].agg(["mean", "count"])
        self.by_slot = df.groupby("slot")["wait"].mean()
        self.overall = float(df["wait"].mean()) if len(df) else NO_DATA_DEFAULT_WAIT
        return self

    def predict_one(self, day_of_week: int, slot: int) -> tuple[float, int]:
        """Returns (prediction, number of samples behind it)."""
        key = (day_of_week, slot)
        if key in self.by_day_slot.index:
            row = self.by_day_slot.loc[key]
            return float(row["mean"]), int(row["count"])
        if slot in self.by_slot.index:
            return float(self.by_slot.loc[slot]), 0
        return self.overall, 0

    def predict(self, df: pd.DataFrame) -> np.ndarray:
        return np.array([self.predict_one(d, s)[0] for d, s in zip(df["day_of_week"], df["slot"])])


def make_random_forest():
    from sklearn.ensemble import RandomForestRegressor

    # Small, shallow-ish forest: with a few hundred rows, deeper trees only
    # memorise noise. Fixed random_state keeps results reproducible for the report.
    return RandomForestRegressor(n_estimators=100, max_depth=8, min_samples_leaf=3, random_state=42, n_jobs=1)


def leave_one_day_out(df: pd.DataFrame) -> dict:
    """
    Leave-one-day-out cross-validation: train on every other day, test on the
    held-out day. This mimics real use (predicting a day the model hasn't seen)
    and stops same-day leakage, which a random split would allow.
    Returns {"baseline_mae", "rf_mae", "n_rows", "n_days"}.
    """
    days = sorted(df["date"].unique())
    base_errors, rf_errors = [], []
    for day in days:
        train, test = df[df["date"] != day], df[df["date"] == day]
        if train.empty or test.empty:
            continue
        base = BaselineModel().fit(train)
        base_errors.extend(np.abs(base.predict(test) - test["wait"].values))
        rf = make_random_forest().fit(train[FEATURES], train["wait"])
        rf_errors.extend(np.abs(rf.predict(test[FEATURES]) - test["wait"].values))
    return {
        "baseline_mae": float(np.mean(base_errors)) if base_errors else None,
        "rf_mae": float(np.mean(rf_errors)) if rf_errors else None,
        "n_rows": int(len(df)),
        "n_days": int(len(days)),
    }


# ---------------------------------------------------------------------------
# Training (called by backend/ml/train.py)
# ---------------------------------------------------------------------------

def train_all(model_path: Path = MODEL_PATH) -> dict:
    """
    Trains one model per cafe and saves a bundle to ml/model.joblib.
    Bundle: {cafe_id: {"model_type", "rf", "baseline_mae", "rf_mae", "n_rows", "data", ...}}
    """
    import joblib

    bundle: dict = {"trained_at": to_db_ts(utc_now()), "cafes": {}}
    for cafe in query("SELECT id FROM cafes WHERE is_active ORDER BY id"):
        cafe_id = cafe["id"]
        df, label = observations_for(cafe_id)
        entry = {"data": label, "n_rows": int(len(df)), "model_type": "baseline", "rf": None,
                 "baseline_mae": None, "rf_mae": None, "reason": ""}

        if len(df) < settings.min_rows_for_ml:
            entry["reason"] = (
                f"only {len(df)} rows (< {settings.min_rows_for_ml}); RandomForest not trained, baseline only"
            )
            logger.info("%s: %s", cafe_id, entry["reason"])
        else:
            cv = leave_one_day_out(df)
            entry.update(baseline_mae=cv["baseline_mae"], rf_mae=cv["rf_mae"])
            if cv["rf_mae"] is not None and cv["baseline_mae"] is not None and cv["rf_mae"] < cv["baseline_mae"]:
                entry["model_type"] = "rf"
                entry["rf"] = make_random_forest().fit(df[FEATURES], df["wait"])
                entry["reason"] = "RF beat baseline in leave-one-day-out CV"
            else:
                entry["reason"] = "RF did NOT beat baseline; falling back to baseline"
                logger.warning(
                    "%s: RF MAE %.2f >= baseline MAE %.2f — falling back to baseline",
                    cafe_id, cv["rf_mae"] or -1, cv["baseline_mae"] or -1,
                )
        bundle["cafes"][cafe_id] = entry

    model_path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, model_path)
    # Human-readable sidecar for the report (no model objects inside).
    meta = {k: {kk: vv for kk, vv in v.items() if kk != "rf"} for k, v in bundle["cafes"].items()}
    (model_path.parent / "model_meta.json").write_text(
        json.dumps({"trained_at": bundle["trained_at"], "cafes": meta}, indent=2), encoding="utf-8"
    )
    _bundle_cache.clear()
    return bundle


# ---------------------------------------------------------------------------
# Runtime prediction
# ---------------------------------------------------------------------------

_bundle_cache: dict = {}
_bundle_lock = threading.Lock()


def _load_bundle() -> Optional[dict]:
    """Loads model.joblib once, reloading automatically after re-training."""
    if not MODEL_PATH.exists():
        return None
    mtime = MODEL_PATH.stat().st_mtime
    with _bundle_lock:
        if _bundle_cache.get("mtime") != mtime:
            import joblib

            try:
                _bundle_cache.update(mtime=mtime, bundle=joblib.load(MODEL_PATH))
            except Exception:  # corrupted / incompatible file -> behave as untrained
                logger.exception("Could not load %s; using baseline only", MODEL_PATH)
                _bundle_cache.update(mtime=mtime, bundle=None)
        return _bundle_cache.get("bundle")


def _orders_last_15(cafe_id: str) -> int:
    row = query_one(
        "SELECT COUNT(*) AS n FROM order_logs WHERE cafe_id = ? AND source = 'real' AND timestamp >= ?",
        (cafe_id, minutes_ago(15)),
    )
    return int(row["n"]) if row else 0


def _clamp_to_live(value: float, live_status: str) -> tuple[float, bool]:
    low, high, _, _ = status_engine.WAIT_RANGES[live_status]
    clamped = max(value, low)
    if high is not None:
        clamped = min(clamped, high)
    return clamped, abs(clamped - value) > 1e-9


def predict_wait(cafe_id: str, at_utc: Optional[datetime] = None, log: bool = True) -> Optional[Prediction]:
    now = at_utc or utc_now()
    live = status_engine.get_cafe_status(cafe_id, now)
    if live is None:
        return None

    local = now.replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo(settings.timezone))
    dow, hour = local.weekday(), local.hour
    minute_bin = 0 if local.minute < 30 else 30
    slot = hour * 2 + minute_bin // 30

    df, data_label = observations_for(cafe_id)
    data_note = " (SYNTHETIC demo data)" if data_label == "synthetic" else ""
    bundle = _load_bundle()
    entry = (bundle or {}).get("cafes", {}).get(cafe_id)

    if entry and entry.get("model_type") == "rf" and entry.get("rf") is not None:
        features = pd.DataFrame([[hour, minute_bin, dow, _orders_last_15(cafe_id)]], columns=FEATURES)
        value = float(entry["rf"].predict(features)[0])
        model_type, confidence = "rf", "medium"
        explanation = (
            f"RandomForest trained on {entry['n_rows']} rows{' (SYNTHETIC demo data)' if entry['data'] == 'synthetic' else ''}; "
            f"CV MAE {entry['rf_mae']:.1f} min vs baseline {entry['baseline_mae']:.1f} min"
        )
    elif len(df):
        value, samples = BaselineModel().fit(df).predict_one(dow, slot)
        model_type = "baseline"
        confidence = "medium" if samples >= 5 else "low"
        explanation = (
            f"Historical average for this weekday & half-hour ({samples} samples){data_note}"
            if samples else f"Historical average (no samples for this exact slot){data_note}"
        )
    elif live.status != "unknown":
        value = live.wait_typical_minutes
        model_type, confidence = "manual", live.confidence or "low"
        explanation = f"No history yet — typical wait for live status '{live.status}'"
    else:
        value = NO_DATA_DEFAULT_WAIT
        model_type, confidence = "manual", "low"
        explanation = "No history and no live status — assuming a moderate wait"

    if live.status != "unknown" and model_type != "manual":
        value, changed = _clamp_to_live(value, live.status)
        if changed:
            explanation += f"; adjusted to match live status '{live.status}'"

    prediction = Prediction(
        cafe_id=cafe_id,
        predicted_wait_minutes=round(max(value, 0.0), 1),
        model_type=model_type,
        confidence=confidence,
        explanation=explanation,
        live_status=live.status,
        timestamp=to_db_ts(now),
    )
    if log:
        _log_prediction(prediction, now)
    return prediction


def _log_prediction(p: Prediction, now: datetime) -> None:
    recent = query_one(
        "SELECT id FROM predictions WHERE cafe_id = ? AND timestamp >= ? LIMIT 1",
        (p.cafe_id, minutes_ago(PREDICTION_LOG_INTERVAL_MINUTES, now)),
    )
    if not recent:
        execute(
            "INSERT INTO predictions (cafe_id, predicted_wait_minutes, model_type, confidence, timestamp) "
            "VALUES (?, ?, ?, ?, ?)",
            (p.cafe_id, p.predicted_wait_minutes, p.model_type, p.confidence, p.timestamp),
        )
