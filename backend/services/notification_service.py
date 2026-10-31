"""
Push notification service — "your break starts in 10 minutes, here's where to eat".

Delivery path: standard Web Push (RFC 8030) signed with our VAPID keys, sent
with pywebpush. On Android Chrome the subscription endpoint is an FCM URL
(fcm.googleapis.com/...), so Firebase Cloud Messaging carries the message —
no Firebase SDK is needed in the page or on the server.

Scheduler: a background task wakes at the start of every minute, finds
subscribers whose break_time is REMINDER_LEAD_MINUTES from now (campus time),
and sends each one a one-line summary of every cafe:

    Cafe A 🟢 Free | Cafe B 🟡 ~8 min | Cafe C 🔴 Busy

Expired subscriptions (push service answers 404/410) are deleted, so the table
cleans itself as students uninstall or clear site data.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from backend.config import settings
from backend.database import execute, query, utc_now
from backend.models.status_update import CafeStatus
from backend.services import status_engine

logger = logging.getLogger("cafeq.notify")

EMOJI = {"green": "🟢", "yellow": "🟡", "red": "🔴", "unknown": "⚪"}

# (endpoint, break_time, utc date) of reminders already delivered by this process.
_sent_today: set[tuple[str, str, str]] = set()


def describe(status: CafeStatus) -> str:
    """One cafe's slice of the notification text."""
    name = status_engine.short_name(status.name)
    if status.status == "green":
        label = "Free"
    elif status.status == "yellow":
        label = f"~{status.wait_typical_minutes:g} min"
    elif status.status == "red":
        label = "Busy"
    else:
        label = "Unknown"
    return f"{name} {EMOJI[status.status]} {label}"


def compose_body(statuses: list[CafeStatus], preferred_cafe_id: Optional[str] = None) -> str:
    # The student's favourite cafe goes first — it's the one they'll read.
    ordered = sorted(statuses, key=lambda s: (s.cafe_id != preferred_cafe_id, s.cafe_id))
    return " | ".join(describe(s) for s in ordered)


def due_break_time(now_utc: Optional[datetime] = None) -> str:
    """'HH:MM' (campus time) of breaks that start REMINDER_LEAD_MINUTES from now."""
    now_utc = now_utc or utc_now()
    local = now_utc.replace(tzinfo=ZoneInfo("UTC")).astimezone(ZoneInfo(settings.timezone))
    return (local + timedelta(minutes=settings.reminder_lead_minutes)).strftime("%H:%M")


def send_push(subscriber: dict, payload: dict) -> bool:
    """
    Sends one push. Returns True on success. Deletes the subscriber if the push
    service says the subscription is gone (HTTP 404/410).
    """
    if not settings.push_enabled:
        logger.warning("VAPID keys not configured — skipping push to subscriber %s", subscriber.get("id"))
        return False
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        logger.error("pywebpush is not installed; run `pip install pywebpush`")
        return False

    try:
        webpush(
            subscription_info={
                "endpoint": subscriber["endpoint"],
                "keys": {"p256dh": subscriber["p256dh_key"], "auth": subscriber["auth_key"]},
            },
            data=json.dumps(payload),
            vapid_private_key=settings.vapid_private_key,
            vapid_claims={"sub": settings.vapid_email},
            ttl=300,  # a reminder that arrives after the break started is useless
        )
        return True
    except WebPushException as exc:
        code = getattr(exc.response, "status_code", None)
        if code in (404, 410):
            logger.info("Subscription expired (%s) — removing subscriber %s", code, subscriber.get("id"))
            execute("DELETE FROM push_subscribers WHERE endpoint = ?", (subscriber["endpoint"],))
        else:
            logger.warning("Push failed for subscriber %s: %s", subscriber.get("id"), exc)
        return False
    except Exception:
        logger.exception("Unexpected push error for subscriber %s", subscriber.get("id"))
        return False


def build_payload(body: str, title: str = "Break in 10 min — cafe status") -> dict:
    return {"title": title, "body": body, "icon": "/assets/icon-192.png", "url": "/"}


def run_reminders_once(now_utc: Optional[datetime] = None) -> dict:
    """One scheduler tick. Returns counts (handy for the /api/notify/send endpoint and tests)."""
    now_utc = now_utc or utc_now()
    target = due_break_time(now_utc)
    subscribers = query("SELECT * FROM push_subscribers WHERE break_time = ?", (target,))
    # Forget yesterday's deliveries so the set can't grow without bound.
    stale = {k for k in _sent_today if k[2] != now_utc.strftime("%Y-%m-%d")}
    _sent_today.difference_update(stale)
    if not subscribers:
        return {"break_time": target, "matched": 0, "sent": 0}

    # Status is computed ONCE per tick and shared by every subscriber.
    statuses = status_engine.get_all_statuses(now_utc)
    title = f"Break in {settings.reminder_lead_minutes} min — cafe status"
    today = now_utc.strftime("%Y-%m-%d")
    sent = 0
    for sub in subscribers:
        # The in-process loop and an external cron hitting /api/notify/send can
        # both fire in the same minute; remember who got today's reminder.
        key = (sub["endpoint"], target, today)
        if key in _sent_today:
            continue
        body = compose_body(statuses, sub.get("preferred_cafe_id"))
        if send_push(sub, build_payload(body, title)):
            sent += 1
            _sent_today.add(key)
    logger.info("Reminders for %s: %d matched, %d sent", target, len(subscribers), sent)
    return {"break_time": target, "matched": len(subscribers), "sent": sent}


def broadcast(title: str, body: Optional[str] = None) -> dict:
    """Sends to every subscriber (manual/admin use). Default body = live status summary."""
    subscribers = query("SELECT * FROM push_subscribers")
    statuses = status_engine.get_all_statuses() if body is None else []
    sent = 0
    for sub in subscribers:
        text = body if body is not None else compose_body(statuses, sub.get("preferred_cafe_id"))
        sent += send_push(sub, build_payload(text, title))
    return {"matched": len(subscribers), "sent": sent}


async def reminder_loop() -> None:
    """Runs forever inside the FastAPI process, ticking at each minute boundary."""
    logger.info("Reminder scheduler started (lead time %d min)", settings.reminder_lead_minutes)
    while True:
        now = datetime.now()
        await asyncio.sleep(60 - now.second - now.microsecond / 1_000_000 + 0.5)
        try:
            # DB + HTTP calls are blocking; keep them off the event loop.
            await asyncio.to_thread(run_reminders_once)
        except Exception:
            logger.exception("Reminder tick failed")
