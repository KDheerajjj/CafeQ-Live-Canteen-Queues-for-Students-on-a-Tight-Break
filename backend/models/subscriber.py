from typing import Optional

from pydantic import BaseModel, Field


class PushKeys(BaseModel):
    p256dh: str
    auth: str


class PushSubscriberCreate(BaseModel):
    """
    POST /api/subscribe body. `endpoint` and `keys` come straight from the
    browser's PushSubscription.toJSON(); no personal data is collected.
    """

    endpoint: str = Field(..., max_length=1000)
    keys: PushKeys
    # Local campus time (IST) the student's break starts, "HH:MM", e.g. "12:30".
    # The reminder fires REMINDER_LEAD_MINUTES before this.
    break_time: Optional[str] = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    preferred_cafe_id: Optional[str] = None


class UnsubscribeRequest(BaseModel):
    endpoint: str


class PushSubscriber(BaseModel):
    id: int
    endpoint: str
    p256dh_key: str
    auth_key: str
    break_time: Optional[str] = None
    preferred_cafe_id: Optional[str] = None
    created_at: Optional[str] = None
