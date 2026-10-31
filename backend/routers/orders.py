"""
Order logging — the vendor taps "ORDER SERVED ✓" each time food goes out.

Why log orders at all? Throughput is an objective, effortless signal: a vendor
who is too busy to tap a status button can still tap "served". The count of
orders in the last 15 minutes is the key real-time feature for the ML model.
"""

from collections import Counter
from datetime import datetime
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query

from backend.config import settings
from backend.database import execute, minutes_ago, parse_ts, query, query_one, to_db_ts, utc_now
from backend.models.order_log import OrderCount, OrderLog, OrderLogCreate
from backend.routers.admin import ensure_active_cafe, require_vendor_pin
from backend.services import sheets_logger

router = APIRouter(prefix="/api/orders", tags=["orders"])

# Common items shown in the vendor's optional dropdown. Typical prep times are
# placeholders the team should replace with timings observed at each counter.
COMMON_ITEMS = {
    "dosa": 6,
    "biryani": 4,
    "fried rice": 7,
    "parotta": 6,
    "meals": 3,
    "juice": 3,
    "coffee": 2,
    "sandwich": 4,
    "tea": 2,
    "noodles": 7,
}


def local_day_start_utc(now_utc: Optional[datetime] = None) -> datetime:
    """Midnight *campus time* expressed in UTC — "today" means the IST day."""
    tz = ZoneInfo(settings.timezone)
    now_utc = now_utc or utc_now()
    local = now_utc.replace(tzinfo=ZoneInfo("UTC")).astimezone(tz)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)


def count_orders(cafe_id: str, window_minutes: int) -> int:
    row = query_one(
        "SELECT COUNT(*) AS n FROM order_logs WHERE cafe_id = ? AND source = 'real' AND timestamp >= ?",
        (cafe_id, minutes_ago(window_minutes)),
    )
    return int(row["n"]) if row else 0


@router.get("/items")
def common_items() -> dict:
    return {"items": [{"name": k, "typical_prep_minutes": v} for k, v in COMMON_ITEMS.items()]}


@router.post("", response_model=OrderLog, status_code=201, dependencies=[Depends(require_vendor_pin)])
def log_order(order: OrderLogCreate) -> OrderLog:
    ensure_active_cafe(order.cafe_id)
    item = order.item_name.strip().lower() if order.item_name else None
    # If the vendor picked an item but gave no time, record the typical prep
    # time as a rough estimate (better than nothing for the heatmap).
    prep = order.estimated_prep_minutes
    if prep is None and item in COMMON_ITEMS:
        prep = float(COMMON_ITEMS[item])
    ts = to_db_ts(utc_now())
    new_id = execute(
        "INSERT INTO order_logs (cafe_id, item_name, estimated_prep_minutes, source, timestamp) "
        "VALUES (?, ?, ?, 'real', ?)",
        (order.cafe_id, item, prep, ts),
    )
    sheets_logger.log_event("order", cafe_id=order.cafe_id, item=item, prep_minutes=prep)
    return OrderLog(id=new_id, cafe_id=order.cafe_id, item_name=item, estimated_prep_minutes=prep, timestamp=ts)


@router.get("/count/{cafe_id}", response_model=OrderCount)
def order_count(cafe_id: str, minutes: int = Query(15, ge=1, le=24 * 60)) -> OrderCount:
    """
    Orders in the last `minutes` (default 15, the ML feature window), plus
    today's total and busiest hour for the vendor's daily stats panel.
    Only real orders are counted — synthetic demo rows are excluded.
    """
    ensure_active_cafe(cafe_id)
    tz = ZoneInfo(settings.timezone)
    rows = query(
        "SELECT timestamp FROM order_logs WHERE cafe_id = ? AND source = 'real' AND timestamp >= ?",
        (cafe_id, to_db_ts(local_day_start_utc())),
    )
    hours = Counter(
        parse_ts(r["timestamp"]).replace(tzinfo=ZoneInfo("UTC")).astimezone(tz).hour for r in rows
    )
    busiest = hours.most_common(1)[0] if hours else (None, 0)
    return OrderCount(
        cafe_id=cafe_id,
        window_minutes=minutes,
        count=count_orders(cafe_id, minutes),
        orders_today=len(rows),
        busiest_hour_today=busiest[0],
        busiest_hour_orders=busiest[1],
    )
