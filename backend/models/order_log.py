from typing import Optional

from pydantic import BaseModel, Field


class OrderLogCreate(BaseModel):
    """
    POST /api/orders body — the vendor taps "ORDER SERVED" once per order.

    Order throughput is the strongest real-time signal of how busy a counter is
    (it feeds the `orders_last_15min` ML feature), so the payload is kept tiny
    to make logging a single tap during rush hour.
    """

    cafe_id: str
    item_name: Optional[str] = Field(None, max_length=60)
    # How long this order took from placing to serving, if the vendor knows it.
    # This becomes the ML target ("wait time"), so it is optional but valuable.
    estimated_prep_minutes: Optional[float] = Field(None, ge=0, le=120)


class OrderLog(OrderLogCreate):
    id: int
    timestamp: str


class OrderCount(BaseModel):
    cafe_id: str
    window_minutes: Optional[int] = None
    count: int
    orders_today: int
    busiest_hour_today: Optional[int] = None
    busiest_hour_orders: int = 0
