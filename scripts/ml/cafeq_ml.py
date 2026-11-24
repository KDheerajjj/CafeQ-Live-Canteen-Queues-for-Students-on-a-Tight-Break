"""Shared helpers for the CafeQ ML pipeline (offline only; never runs in the web app).

The prediction target is `actual_total_min`: minutes from joining a cafe's line
to having the food, as reported by students in the app's one-tap feedback.

Features (must match public/js/model.js encodeFeatures and estimateFor):
    queue_count            median queue length shown when the student chose to go
    hour                   hour of day in IST (0-23)
    day_of_week            Monday = 0 ... Sunday = 6
    item_prep_min          the picked item's prep time (else the generic prep buffer)
    is_canteen             1 for the canteen, 0 for cafes
    service_sec_per_person the cafe's serving-speed setting

Baseline = the formula the app ships (public/js/status-engine.js estimateFor):
    queue_wait = queue_count * service_sec_per_person / 60  (* congestion when red)
    estimate   = queue_wait + item_prep_min
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

FEATURES = ["queue_count", "hour", "day_of_week", "item_prep_min", "is_canteen", "service_sec_per_person"]
IST = timezone(timedelta(hours=5, minutes=30))  # India has no daylight saving, so a fixed offset is exact


@dataclass(frozen=True)
class FormulaSettings:
    """Mirrors DEFAULT_SETTINGS in public/js/config.js. Pass the live admin values
    on the command line if they were changed (see train.py --help)."""

    green_max: int = 2
    yellow_max: int = 6
    prep_buffer_min: float = 1.0
    congestion_factor: float = 1.2


def parse_time(value: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(IST)
    except ValueError:
        return None


def _num(value: str) -> float | None:
    try:
        return float(value) if value not in ("", None) else None
    except ValueError:
        return None


def load_rows(path: str, s: FormulaSettings) -> tuple[list[dict], list[str]]:
    """Read the admin's feedback CSV (or the synthetic one). Returns (rows, notes).
    Rows without the inputs the formula needs are dropped and counted in notes."""
    rows, notes, dropped = [], [], 0
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            q = _num(r.get("queue_count_at_report", ""))
            y = _num(r.get("actual_total_min", ""))
            sec = _num(r.get("service_sec_per_person", ""))
            when = parse_time(r.get("started_at", "")) or parse_time(r.get("created_at", ""))
            if q is None or y is None or sec is None or when is None or r.get("cafe_type") not in ("cafe", "canteen"):
                dropped += 1
                continue
            prep = _num(r.get("item_prep_min", ""))
            rows.append(
                {
                    "source": r.get("source", ""),
                    "queue_count": q,
                    "hour": when.hour,
                    "day_of_week": when.weekday(),
                    "item_prep_min": prep if prep is not None else s.prep_buffer_min,
                    "is_canteen": 1 if r["cafe_type"] == "canteen" else 0,
                    "service_sec_per_person": sec,
                    "day": when.date().isoformat(),
                    "y": y,
                }
            )
    if dropped:
        notes.append(f"{dropped} rows dropped (missing queue count, answer, cafe type/speed or time).")
    return rows, notes


def baseline(row: dict, s: FormulaSettings) -> float:
    """The app's formula, row by row (same as estimateFor's "formula" branch)."""
    q = row["queue_count"]
    red = q > s.yellow_max
    wait = q * row["service_sec_per_person"] / 60 * (s.congestion_factor if red else 1.0)
    return wait + row["item_prep_min"]


def matrix(rows: list[dict]) -> list[list[float]]:
    return [[float(r[f]) for f in FEATURES] for r in rows]
