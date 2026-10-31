"""
Live status endpoints — what the student dashboard polls every 30 seconds.
"""

from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request

from backend.config import settings
from backend.database import execute, query, to_db_ts, utc_now
from backend.models.cafe import Cafe
from backend.models.status_update import CafeStatus, StatusUpdateCreate
from backend.routers.admin import ensure_active_cafe, require_vendor_pin
from backend.routers.crowdsource import check_report_cooldown
from backend.services import sheets_logger, status_engine

router = APIRouter(prefix="/api", tags=["status"])


@router.get("/cafes", response_model=list[Cafe])
def list_cafes() -> list[Cafe]:
    """Active cafes with walk times (used by dropdowns in both dashboards)."""
    rows = query("SELECT * FROM cafes WHERE is_active ORDER BY id")
    return [Cafe.from_row(r) for r in rows]


@router.get("/status")
def all_statuses() -> dict:
    """
    Current computed status for every active cafe, plus the timing rules the
    frontend needs so it can apply the same stale threshold client-side.
    """
    return {
        "generated_at": to_db_ts(utc_now()),
        "stale_threshold_minutes": settings.stale_threshold_minutes,
        "refresh_seconds": settings.status_refresh_seconds,
        "cafes": [s.model_dump() for s in status_engine.get_all_statuses()],
    }


@router.get("/status/{cafe_id}", response_model=CafeStatus)
def cafe_status(cafe_id: str) -> CafeStatus:
    status = status_engine.get_cafe_status(cafe_id)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Unknown cafe '{cafe_id}'")
    return status


@router.post("/status", response_model=CafeStatus, status_code=201)
def submit_status(
    update: StatusUpdateCreate,
    request: Request,
    x_vendor_pin: Optional[str] = Header(None),
) -> CafeStatus:
    """
    A vendor (PIN required) or a student submits a status.

    Vendor taps go to status_updates and immediately become the live status.
    Student submissions are treated exactly like /api/report crowd reports so
    there is ONE crowd pipeline with ONE anti-spam rule.
    """
    ensure_active_cafe(update.cafe_id)

    if update.source == "vendor":
        # Without this check anyone could impersonate the most-trusted source.
        require_vendor_pin(x_vendor_pin)
        execute(
            "INSERT INTO status_updates (cafe_id, status, source, reporter_id, timestamp) "
            "VALUES (?, ?, 'vendor', ?, ?)",
            (update.cafe_id, update.status, update.reporter_id, to_db_ts(utc_now())),
        )
        sheets_logger.log_event("vendor_status", cafe_id=update.cafe_id, status=update.status)
    else:
        check_report_cooldown(request, update.cafe_id)
        execute(
            "INSERT INTO crowd_reports (cafe_id, reported_status, source, timestamp) "
            "VALUES (?, ?, 'real', ?)",
            (update.cafe_id, update.status, to_db_ts(utc_now())),
        )
        sheets_logger.log_event("crowd_report", cafe_id=update.cafe_id, status=update.status)

    return status_engine.get_cafe_status(update.cafe_id)
