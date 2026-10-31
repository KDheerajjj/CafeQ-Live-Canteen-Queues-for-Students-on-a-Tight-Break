"""Unit tests for the status trust rules (backend/services/status_engine.py)."""

from datetime import datetime, timedelta

from backend.database import execute, to_db_ts, utc_now
from backend.services import status_engine
from backend.services.status_engine import compute_status

NOW = datetime(2026, 11, 2, 7, 0, 0)  # naive UTC (12:30 IST)
CAFE = {"id": "cafe-a", "name": "Cafe A (Main Canteen)", "location_description": "x"}


def row(status, minutes_old):
    return {"status": status, "timestamp": to_db_ts(NOW - timedelta(minutes=minutes_old))}


def test_no_data_is_unknown_with_no_wait():
    s = compute_status(CAFE, [], [], NOW)
    assert s.status == "unknown"
    assert s.wait_estimate is None and s.wait_min_minutes is None
    assert s.confidence is None


def test_fresh_vendor_update_wins_with_high_confidence():
    s = compute_status(CAFE, [row("red", 5)], [row("green", 1), row("green", 2)], NOW)
    assert s.status == "red"
    assert s.source == "vendor"
    assert s.confidence == "high"


def test_latest_vendor_update_is_used():
    s = compute_status(CAFE, [row("red", 12), row("green", 2)], [], NOW)
    assert s.status == "green"
    assert s.update_age_minutes == 2.0


def test_vendor_update_older_than_15_min_is_ignored():
    # The core safety rule: a stale green must never be shown.
    s = compute_status(CAFE, [row("green", 16)], [], NOW)
    assert s.status == "unknown"


def test_stale_vendor_falls_through_to_crowd_reports():
    s = compute_status(CAFE, [row("green", 20)], [row("red", 3), row("red", 4)], NOW)
    assert s.status == "red"
    assert s.source == "crowdsource"


def test_two_crowd_reports_take_the_mode():
    s = compute_status(CAFE, [], [row("yellow", 1), row("yellow", 3), row("green", 2)], NOW)
    assert s.status == "yellow"
    assert s.confidence == "medium"
    assert s.crowd_report_count == 3


def test_crowd_tie_resolves_to_more_severe_status():
    s = compute_status(CAFE, [], [row("green", 1), row("red", 2)], NOW)
    assert s.status == "red"


def test_single_crowd_report_is_low_confidence():
    s = compute_status(CAFE, [], [row("green", 4)], NOW)
    assert s.status == "green"
    assert s.confidence == "low"


def test_crowd_reports_older_than_10_min_are_ignored():
    s = compute_status(CAFE, [], [row("red", 11), row("red", 12)], NOW)
    assert s.status == "unknown"


def test_wait_mapping():
    expected = {"green": ("0–5 min", 0, 5), "yellow": ("5–12 min", 5, 12), "red": ("12+ min", 12, None)}
    for level, (label, low, high) in expected.items():
        s = compute_status(CAFE, [row(level, 1)], [], NOW)
        assert s.wait_estimate == label
        assert s.wait_min_minutes == low
        assert s.wait_max_minutes == high


def test_short_name():
    assert status_engine.short_name("Cafe B (Block 2 Canteen)") == "Cafe B"


def test_synthetic_rows_never_drive_live_status():
    now = utc_now()
    ts = to_db_ts(now - timedelta(minutes=1))
    execute("INSERT INTO status_updates (cafe_id, status, source, timestamp) VALUES ('cafe-a', 'green', 'synthetic', ?)", (ts,))
    execute("INSERT INTO crowd_reports (cafe_id, reported_status, source, timestamp) VALUES ('cafe-a', 'green', 'synthetic', ?)", (ts,))
    assert status_engine.get_cafe_status("cafe-a", now).status == "unknown"


def test_db_backed_status_uses_vendor_row():
    now = utc_now()
    execute(
        "INSERT INTO status_updates (cafe_id, status, source, timestamp) VALUES ('cafe-b', 'yellow', 'vendor', ?)",
        (to_db_ts(now - timedelta(minutes=3)),),
    )
    statuses = {s.cafe_id: s for s in status_engine.get_all_statuses(now)}
    assert statuses["cafe-b"].status == "yellow"
    assert statuses["cafe-a"].status == "unknown"
