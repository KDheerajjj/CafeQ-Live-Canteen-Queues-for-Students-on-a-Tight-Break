"""
Push-notification subscription endpoints.

Privacy: we store only what the browser's PushSubscription gives us (an opaque
endpoint URL + encryption keys) plus the break time the student picked.
No names, emails or roll numbers.
"""

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.config import settings
from backend.database import execute, query_one
from backend.models.subscriber import PushSubscriberCreate, UnsubscribeRequest
from backend.routers.admin import require_admin_key
from backend.services import notification_service

router = APIRouter(prefix="/api", tags=["notify"])


class SendRequest(BaseModel):
    # "reminders" = run the scheduler tick now; "broadcast" = everyone.
    mode: Literal["reminders", "broadcast"] = "reminders"
    title: str = Field("CafeQ — cafe status", max_length=80)
    body: Optional[str] = Field(None, max_length=200)


@router.get("/notify/vapid-public-key")
def vapid_public_key() -> dict:
    """The page needs this to call pushManager.subscribe(). `enabled` = server can send."""
    return {"public_key": settings.vapid_public_key if settings.push_enabled else None,
            "enabled": settings.push_enabled}


@router.post("/subscribe", status_code=201)
def subscribe(sub: PushSubscriberCreate) -> dict:
    if sub.preferred_cafe_id and not query_one(
        "SELECT id FROM cafes WHERE id = ?", (sub.preferred_cafe_id,)
    ):
        raise HTTPException(status_code=404, detail=f"Unknown cafe '{sub.preferred_cafe_id}'")

    # Upsert by endpoint: re-subscribing (e.g. changing break time) updates the row.
    if query_one("SELECT id FROM push_subscribers WHERE endpoint = ?", (sub.endpoint,)):
        execute(
            "UPDATE push_subscribers SET p256dh_key = ?, auth_key = ?, break_time = ?, preferred_cafe_id = ? "
            "WHERE endpoint = ?",
            (sub.keys.p256dh, sub.keys.auth, sub.break_time, sub.preferred_cafe_id, sub.endpoint),
        )
        return {"subscribed": True, "updated": True}
    execute(
        "INSERT INTO push_subscribers (endpoint, p256dh_key, auth_key, break_time, preferred_cafe_id) "
        "VALUES (?, ?, ?, ?, ?)",
        (sub.endpoint, sub.keys.p256dh, sub.keys.auth, sub.break_time, sub.preferred_cafe_id),
    )
    return {"subscribed": True, "updated": False}


@router.delete("/subscribe")
def unsubscribe(req: UnsubscribeRequest) -> dict:
    removed = execute("DELETE FROM push_subscribers WHERE endpoint = ?", (req.endpoint,))
    return {"unsubscribed": removed > 0}


@router.post("/notify/send", dependencies=[Depends(require_admin_key)])
def send(req: SendRequest) -> dict:
    """Internal/cron trigger (admin key). Useful if the in-process scheduler is asleep."""
    if req.mode == "reminders":
        return notification_service.run_reminders_once()
    return notification_service.broadcast(req.title, req.body)
