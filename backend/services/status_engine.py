"""
Status engine — turns raw vendor taps and student crowd reports into ONE
trustworthy traffic-light status per cafe.

Trust hierarchy (project rules, applied in order):
  1. A vendor update in the last 15 min wins. The vendor can see the queue,
     so a single tap outweighs any number of student reports.
  2. Otherwise, 2+ crowd reports in the last 10 min -> take the most common
     status (the mode). Crowd reports expire faster than vendor taps because
     each one is a single student's glance.
  3. Otherwise, exactly 1 crowd report in the last 10 min -> use it, but flag
     confidence "low" so the UI can say so.
  4. Otherwise -> "unknown" (grey) with no wait estimate.

The most important property: data older than the stale threshold is NEVER
shown. A stale green is actively harmful — students walk over expecting no
queue — so "we don't know" is always preferred to an old answer.
"""

from collections import Counter
from datetime import datetime
from typing import Iterable, Optional

from backend.config import settings
from backend.database import minutes_ago, parse_ts, query, query_one, utc_now
from backend.models.status_update import CafeStatus

# Rough Phase-1 wait ranges per level (minutes). Phase 3's prediction engine
# replaces these with learned numbers; until then they set expectations.
#   level   -> (min, max, label, typical value used in notifications)
WAIT_RANGES = {
    "green": (0.0, 5.0, "0–5 min", 3.0),
    "yellow": (5.0, 12.0, "5–12 min", 8.0),
    "red": (12.0, None, "12+ min", 15.0),
}

# When reports are evenly split, assume the WORSE level. Under-promising
# (expecting a queue that isn't there) costs a student nothing; over-promising
# costs them their break.
SEVERITY = {"green": 0, "yellow": 1, "red": 2}


def short_name(full_name: str) -> str:
    """'Cafe A (Main Canteen)' -> 'Cafe A' for compact notification text."""
    return full_name.split(" (")[0].strip()


def _mode_status(statuses: list[str]) -> str:
    counts = Counter(statuses)
    top = max(counts.values())
    tied = [s for s, c in counts.items() if c == top]
    return max(tied, key=lambda s: SEVERITY[s])


def compute_status(
    cafe: dict,
    vendor_updates: Iterable[dict],
    crowd_reports: Iterable[dict],
    now: Optional[datetime] = None,
) -> CafeStatus:
    """
    Pure function (no DB access) so the business rules can be unit-tested.

    vendor_updates: dicts with `status` and `timestamp`.
    crowd_reports:  dicts with `status` and `timestamp`.
    Rows outside the time windows are ignored here even if the caller passed
    them, so the stale rule holds regardless of how the data was fetched.
    """
    now = now or utc_now()
    stale_limit = settings.stale_threshold_minutes
    crowd_limit = settings.crowd_window_minutes

    def age_min(row: dict) -> float:
        return (now - parse_ts(row["timestamp"])).total_seconds() / 60.0

    fresh_vendor = sorted(
        (u for u in vendor_updates if 0 <= age_min(u) <= stale_limit),
        key=age_min,
    )
    fresh_crowd = sorted(
        (r for r in crowd_reports if 0 <= age_min(r) <= crowd_limit),
        key=age_min,
    )

    result = CafeStatus(
        cafe_id=cafe["id"],
        name=cafe["name"],
        location_description=cafe.get("location_description"),
        status="unknown",
        crowd_report_count=len(fresh_crowd),
    )

    # Rule 1: latest vendor tap within the stale threshold.
    if fresh_vendor:
        latest = fresh_vendor[0]
        status, source, confidence, anchor = latest["status"], "vendor", "high", latest
    # Rule 2: consensus of 2+ fresh crowd reports.
    elif len(fresh_crowd) >= 2:
        status = _mode_status([r["status"] for r in fresh_crowd])
        source, confidence, anchor = "crowdsource", "medium", fresh_crowd[0]
    # Rule 3: a single crowd report — usable, but flagged.
    elif len(fresh_crowd) == 1:
        status, source, confidence, anchor = fresh_crowd[0]["status"], "crowdsource", "low", fresh_crowd[0]
    # Rule 4: nothing fresh -> unknown, no wait estimate.
    else:
        return result

    low, high, label, typical = WAIT_RANGES[status]
    result.status = status
    result.source = source
    result.confidence = confidence
    result.wait_min_minutes = low
    result.wait_max_minutes = high
    result.wait_estimate = label
    result.wait_typical_minutes = typical
    result.last_updated = str(anchor["timestamp"])
    result.update_age_minutes = round(age_min(anchor), 1)
    return result


def _fetch_inputs(cafe_id: str, now: datetime) -> tuple[list[dict], list[dict]]:
    """Loads only the rows that can matter: the last `stale_threshold` minutes."""
    since = minutes_ago(settings.stale_threshold_minutes, now)
    vendor = query(
        "SELECT status, timestamp FROM status_updates "
        "WHERE cafe_id = ? AND source = 'vendor' AND timestamp >= ? ORDER BY timestamp DESC",
        (cafe_id, since),
    )
    # Student reports arrive via /api/report (crowd_reports table). Rows that a
    # client posted to /api/status with source="crowdsource" are stored there
    # too; any legacy crowdsource rows in status_updates are merged for safety.
    # Synthetic demo rows are excluded so they can never drive the LIVE status.
    crowd = query(
        "SELECT reported_status AS status, timestamp FROM crowd_reports "
        "WHERE cafe_id = ? AND source = 'real' AND timestamp >= ? ",
        (cafe_id, since),
    ) + query(
        "SELECT status, timestamp FROM status_updates "
        "WHERE cafe_id = ? AND source = 'crowdsource' AND timestamp >= ?",
        (cafe_id, since),
    )
    return vendor, crowd


def get_cafe_status(cafe_id: str, now: Optional[datetime] = None) -> Optional[CafeStatus]:
    cafe = query_one(
        "SELECT id, name, location_description FROM cafes WHERE id = ? AND is_active",
        (cafe_id,),
    )
    if not cafe:
        return None
    now = now or utc_now()
    vendor, crowd = _fetch_inputs(cafe_id, now)
    return compute_status(cafe, vendor, crowd, now)


def get_all_statuses(now: Optional[datetime] = None) -> list[CafeStatus]:
    now = now or utc_now()
    cafes = query(
        "SELECT id, name, location_description FROM cafes WHERE is_active ORDER BY id"
    )
    results = []
    for cafe in cafes:
        vendor, crowd = _fetch_inputs(cafe["id"], now)
        results.append(compute_status(cafe, vendor, crowd, now))
    return results
