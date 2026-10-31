"""
History endpoints — past data, and the "best time to visit" heatmap.

The heatmap answers a planning question ("when is Cafe B usually quiet?"),
which helps spread demand across the day — the load-balancing half of the
project. It shows a 7 x 12 grid: Monday–Sunday x hourly slots 8am–8pm.

Each cell = average wait in that (weekday, hour), combining:
  * measured waits from order_logs.estimated_prep_minutes, and
  * traffic-light statuses (vendor taps + crowd reports) mapped to their
    typical wait (green 3, yellow 8, red 15 min).
Real data is used whenever any exists; otherwise synthetic demo data is used
and the response says so in `data_source` so the UI can label it.
"""

from collections import defaultdict
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Query

from backend.config import settings
from backend.database import minutes_ago, parse_ts, query
from backend.routers.admin import ensure_active_cafe
from backend.services.status_engine import WAIT_RANGES

router = APIRouter(prefix="/api/history", tags=["history"])

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
HOURS = list(range(8, 20))  # 12 hourly slots: 8:00 ... 19:00 (ends 20:00)
TYPICAL_WAIT = {level: spec[3] for level, spec in WAIT_RANGES.items()}
MIN_CELLS_FOR_BEST_SLOT = 10  # of 84
MIN_SAMPLES_FOR_BEST_CELL = 3


def level_for_wait(wait: Optional[float]) -> Optional[str]:
    """Same thresholds as the live status: <5 green, 5–12 yellow, 12+ red."""
    if wait is None:
        return None
    if wait < WAIT_RANGES["green"][1]:
        return "green"
    if wait < WAIT_RANGES["yellow"][1]:
        return "yellow"
    return "red"


def _observations(cafe_id: Optional[str], synthetic: bool) -> list[tuple[str, float]]:
    """(utc timestamp, wait minutes) pairs from all three data sources."""
    cafe_filter = " AND cafe_id = ?" if cafe_id else ""
    params = (cafe_id,) if cafe_id else ()
    order_src = "'synthetic'" if synthetic else "'real'"
    status_src = "('synthetic')" if synthetic else "('vendor', 'crowdsource')"

    obs: list[tuple[str, float]] = []
    for r in query(
        f"SELECT timestamp, estimated_prep_minutes AS w FROM order_logs "
        f"WHERE source = {order_src} AND estimated_prep_minutes IS NOT NULL{cafe_filter}",
        params,
    ):
        obs.append((r["timestamp"], float(r["w"])))
    for r in query(
        f"SELECT timestamp, status FROM status_updates WHERE source IN {status_src}{cafe_filter}", params
    ):
        obs.append((r["timestamp"], TYPICAL_WAIT[r["status"]]))
    for r in query(
        f"SELECT timestamp, reported_status AS status FROM crowd_reports WHERE source = {order_src}{cafe_filter}",
        params,
    ):
        obs.append((r["timestamp"], TYPICAL_WAIT[r["status"]]))
    return obs


@router.get("/heatmap")
def heatmap(cafe_id: Optional[str] = Query(None, description="Omit for all cafes combined")) -> dict:
    if cafe_id:
        ensure_active_cafe(cafe_id)

    obs, data_source = _observations(cafe_id, synthetic=False), "real"
    if not obs:
        obs, data_source = _observations(cafe_id, synthetic=True), "synthetic"
    if not obs:
        data_source = "none"

    tz = ZoneInfo(settings.timezone)
    sums: dict[tuple[int, int], list[float]] = defaultdict(list)
    for ts, wait in obs:
        local = parse_ts(ts).replace(tzinfo=ZoneInfo("UTC")).astimezone(tz)
        if local.hour in HOURS:
            sums[(local.weekday(), local.hour)].append(wait)

    grid = []
    best = None
    filled_cells = sum(1 for values in sums.values() if values)
    for d in range(7):
        row = []
        for h in HOURS:
            values = sums.get((d, h))
            avg = round(sum(values) / len(values), 1) if values else None
            row.append({"avg_wait": avg, "level": level_for_wait(avg), "samples": len(values or [])})
            # A cell backed by one lucky reading isn't a "usual" time.
            enough = values is not None and len(values) >= MIN_SAMPLES_FOR_BEST_CELL
            if enough and (best is None or avg < best["avg_wait"]):
                best = {"day": DAYS[d], "hour": h, "avg_wait": avg}
        grid.append(row)

    # "Usually quietest" from one or two readings would be a guess dressed up
    # as a pattern, so only claim a best slot once a reasonable share of the
    # grid has data.
    if filled_cells < MIN_CELLS_FOR_BEST_SLOT:
        best = None

    return {
        "cafe_id": cafe_id,
        "days": DAYS,
        "hours": HOURS,
        "grid": grid,
        "best_slot": best,
        "filled_cells": filled_cells,
        "total_samples": sum(len(v) for v in sums.values()),
        "data_source": data_source,
        "note": "SYNTHETIC demo data — not real observations" if data_source == "synthetic" else None,
    }


@router.get("/{cafe_id}")
def cafe_history(cafe_id: str, hours: int = Query(24, ge=1, le=24 * 30)) -> dict:
    """Raw real events for one cafe in the last `hours` (synthetic rows excluded)."""
    ensure_active_cafe(cafe_id)
    since = minutes_ago(hours * 60)
    statuses = query(
        "SELECT status, source, timestamp FROM status_updates "
        "WHERE cafe_id = ? AND source IN ('vendor', 'crowdsource') AND timestamp >= ? ORDER BY timestamp DESC",
        (cafe_id, since),
    )
    reports = query(
        "SELECT reported_status AS status, 'crowdsource' AS source, timestamp FROM crowd_reports "
        "WHERE cafe_id = ? AND source = 'real' AND timestamp >= ? ORDER BY timestamp DESC",
        (cafe_id, since),
    )
    orders = query(
        "SELECT item_name, estimated_prep_minutes, timestamp FROM order_logs "
        "WHERE cafe_id = ? AND source = 'real' AND timestamp >= ? ORDER BY timestamp DESC",
        (cafe_id, since),
    )
    events = sorted(statuses + reports, key=lambda e: str(e["timestamp"]), reverse=True)
    return {
        "cafe_id": cafe_id,
        "hours": hours,
        "status_events": [{**e, "timestamp": str(e["timestamp"])} for e in events],
        "orders": [{**o, "timestamp": str(o["timestamp"])} for o in orders],
    }
