"""
Crowdsourced reports — students tap Green/Yellow/Red for a cafe they can see.

The Oulu study (Goncalves et al., CSCW '16) reached ~2 min MAE with only ~7% of
customers contributing, so even a handful of honest reports is useful. The
status engine handles trust (mode of 2+ reports; a single report = "low"
confidence); this router only stores reports and blocks obvious spam.
"""

import time
from threading import Lock

from fastapi import APIRouter, HTTPException, Query, Request

from backend.config import settings
from backend.database import execute, minutes_ago, query, to_db_ts, utc_now
from backend.models.status_update import CafeStatus, CrowdReport, CrowdReportCreate
from backend.routers.admin import ensure_active_cafe
from backend.services import sheets_logger, status_engine

router = APIRouter(prefix="/api/report", tags=["crowdsource"])

# In-memory cooldown: (client ip, cafe_id) -> last report time.
# Reports are anonymous (no accounts), so this is a speed bump, not security:
# it stops one person tapping "red" ten times to fake a consensus. It resets on
# restart, which is fine for a single free-tier instance.
_last_report: dict[tuple[str, str], float] = {}
_lock = Lock()


def check_report_cooldown(request: Request, cafe_id: str) -> None:
    # On Render every request arrives via a proxy, so the real client is the
    # first X-Forwarded-For entry; otherwise all students would share one cooldown.
    forwarded = request.headers.get("x-forwarded-for", "")
    client = forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")
    key = (client, cafe_id)
    now = time.monotonic()
    with _lock:
        last = _last_report.get(key)
        if last is not None and now - last < settings.report_cooldown_seconds:
            wait = int(settings.report_cooldown_seconds - (now - last))
            raise HTTPException(
                status_code=429,
                detail=f"Thanks! You already reported this cafe. Try again in {wait}s.",
            )
        _last_report[key] = now
        # Keep the dict from growing forever on a long-running instance.
        if len(_last_report) > 5000:
            cutoff = now - settings.report_cooldown_seconds
            for k in [k for k, t in _last_report.items() if t < cutoff]:
                del _last_report[k]


def reset_cooldowns() -> None:
    """Used by tests."""
    with _lock:
        _last_report.clear()


@router.post("", response_model=CafeStatus, status_code=201)
def submit_report(report: CrowdReportCreate, request: Request) -> CafeStatus:
    """Stores a crowd report and returns the cafe's recomputed status."""
    ensure_active_cafe(report.cafe_id)
    check_report_cooldown(request, report.cafe_id)
    execute(
        "INSERT INTO crowd_reports (cafe_id, reported_status, source, timestamp) VALUES (?, ?, 'real', ?)",
        (report.cafe_id, report.reported_status, to_db_ts(utc_now())),
    )
    sheets_logger.log_event("crowd_report", cafe_id=report.cafe_id, status=report.reported_status)
    return status_engine.get_cafe_status(report.cafe_id)


@router.get("/recent/{cafe_id}", response_model=list[CrowdReport])
def recent_reports(
    cafe_id: str, minutes: int = Query(30, ge=1, le=24 * 60)
) -> list[CrowdReport]:
    """Real (non-synthetic) reports for a cafe in the last `minutes`."""
    ensure_active_cafe(cafe_id)
    rows = query(
        "SELECT id, cafe_id, reported_status, timestamp FROM crowd_reports "
        "WHERE cafe_id = ? AND source = 'real' AND timestamp >= ? ORDER BY timestamp DESC",
        (cafe_id, minutes_ago(minutes)),
    )
    return [CrowdReport(**{**r, "timestamp": str(r["timestamp"])}) for r in rows]
