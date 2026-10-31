"""
Admin + access-control helpers.

Access control is intentionally minimal for a DTL demo (no JWT, no OAuth, no
user accounts):
  * Vendors share one PIN (VENDOR_PIN), sent in the X-Vendor-PIN header.
    It is compared in plain text — acceptable for a demo, NOT for production.
  * Admin endpoints need X-Admin-Key == ADMIN_API_KEY.
"""

import hmac
import json
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException

from backend.config import settings
from backend.database import execute, minutes_ago, query, query_one
from backend.models.cafe import Cafe, CafeCreate

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Reusable dependencies (imported by other routers)
# ---------------------------------------------------------------------------

def _same(a: str, b: str) -> bool:
    # Constant-time compare: cheap to do and avoids leaking the PIN via timing.
    return hmac.compare_digest(a.encode(), b.encode())


def require_vendor_pin(x_vendor_pin: Optional[str] = Header(None)) -> None:
    if not x_vendor_pin or not _same(x_vendor_pin, settings.vendor_pin):
        raise HTTPException(status_code=401, detail="Invalid or missing vendor PIN")


def require_admin_key(x_admin_key: Optional[str] = Header(None)) -> None:
    # An unset or placeholder key disables admin endpoints entirely rather
    # than leaving them open.
    configured = settings.admin_api_key
    if not configured or configured.startswith("your-"):
        raise HTTPException(status_code=503, detail="ADMIN_API_KEY is not configured")
    if not x_admin_key or not _same(x_admin_key, configured):
        raise HTTPException(status_code=401, detail="Invalid or missing admin key")


def ensure_active_cafe(cafe_id: str) -> dict:
    cafe = query_one("SELECT * FROM cafes WHERE id = ? AND is_active", (cafe_id,))
    if not cafe:
        raise HTTPException(status_code=404, detail=f"Unknown cafe '{cafe_id}'")
    return cafe


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/verify")
def verify_pin(x_vendor_pin: Optional[str] = Header(None)) -> dict:
    """Vendor login check. The PIN travels in a header (never the URL) so it
    doesn't end up in server logs or browser history."""
    require_vendor_pin(x_vendor_pin)
    cafes = query("SELECT id, name FROM cafes WHERE is_active ORDER BY id")
    return {"valid": True, "cafes": cafes}


@router.get("/stats", dependencies=[Depends(require_admin_key)])
def stats() -> dict:
    """Usage numbers for the DTL report: how much real data have we collected?"""
    day_ago = minutes_ago(24 * 60)

    def count(sql: str, params: tuple = ()) -> int:
        row = query_one(sql, params)
        return int(row["n"]) if row else 0

    return {
        "cafes": count("SELECT COUNT(*) AS n FROM cafes WHERE is_active"),
        "push_subscribers": count("SELECT COUNT(*) AS n FROM push_subscribers"),
        # Real vs synthetic are always reported separately — never summed.
        "real": {
            "vendor_updates": count("SELECT COUNT(*) AS n FROM status_updates WHERE source = 'vendor'"),
            "crowd_reports": count("SELECT COUNT(*) AS n FROM crowd_reports WHERE source = 'real'"),
            "orders": count("SELECT COUNT(*) AS n FROM order_logs WHERE source = 'real'"),
            "vendor_updates_24h": count(
                "SELECT COUNT(*) AS n FROM status_updates WHERE source = 'vendor' AND timestamp >= ?",
                (day_ago,),
            ),
            "crowd_reports_24h": count(
                "SELECT COUNT(*) AS n FROM crowd_reports WHERE source = 'real' AND timestamp >= ?",
                (day_ago,),
            ),
            "orders_24h": count(
                "SELECT COUNT(*) AS n FROM order_logs WHERE source = 'real' AND timestamp >= ?",
                (day_ago,),
            ),
        },
        "synthetic": {
            "status_updates": count("SELECT COUNT(*) AS n FROM status_updates WHERE source = 'synthetic'"),
            "crowd_reports": count("SELECT COUNT(*) AS n FROM crowd_reports WHERE source = 'synthetic'"),
            "orders": count("SELECT COUNT(*) AS n FROM order_logs WHERE source = 'synthetic'"),
        },
        "predictions_logged": count("SELECT COUNT(*) AS n FROM predictions"),
    }


@router.post("/cafe", dependencies=[Depends(require_admin_key)], response_model=Cafe)
def upsert_cafe(cafe: CafeCreate) -> Cafe:
    """Add a new cafe or update an existing one (campus has 3–5 cafes)."""
    walk_json = json.dumps(cafe.walk_times)
    if query_one("SELECT id FROM cafes WHERE id = ?", (cafe.id,)):
        execute(
            "UPDATE cafes SET name = ?, location_description = ?, walk_times_json = ?, is_active = ? "
            "WHERE id = ?",
            (cafe.name, cafe.location_description, walk_json, cafe.is_active, cafe.id),
        )
    else:
        execute(
            "INSERT INTO cafes (id, name, location_description, walk_times_json, is_active) "
            "VALUES (?, ?, ?, ?, ?)",
            (cafe.id, cafe.name, cafe.location_description, walk_json, cafe.is_active),
        )
    return Cafe.from_row(query_one("SELECT * FROM cafes WHERE id = ?", (cafe.id,)))
