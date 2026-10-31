from typing import Literal, Optional

from pydantic import BaseModel, Field

# Traffic-light levels a human can submit.
StatusLevel = Literal["green", "yellow", "red"]
# What the dashboard can show: the three levels plus "unknown" (grey) when no
# fresh data exists. "unknown" can never be submitted, only computed.
DisplayStatus = Literal["green", "yellow", "red", "unknown"]


class StatusUpdateCreate(BaseModel):
    """
    POST /api/status body.

    * source="vendor"      -> requires the X-Vendor-PIN header; highest trust.
    * source="crowdsource" -> anonymous student report; stored as a crowd report.
    'ml' and 'synthetic' rows are written only by the system, never via the API.
    """

    cafe_id: str
    status: StatusLevel
    source: Literal["vendor", "crowdsource"] = "vendor"
    # Optional anonymous device id so repeated reports can be spotted. Never a name.
    reporter_id: Optional[str] = Field(None, max_length=64)


class StatusUpdate(BaseModel):
    id: int
    cafe_id: str
    status: StatusLevel
    source: str
    reporter_id: Optional[str] = None
    timestamp: str


class CrowdReportCreate(BaseModel):
    """POST /api/report body — a student's one-tap 'how crowded is it?' report."""

    cafe_id: str
    reported_status: StatusLevel


class CrowdReport(BaseModel):
    id: int
    cafe_id: str
    reported_status: StatusLevel
    timestamp: str


class CafeStatus(BaseModel):
    """The computed, display-ready status of one cafe (output of status_engine)."""

    cafe_id: str
    name: str
    location_description: Optional[str] = None
    status: DisplayStatus
    # Which rule produced the status: vendor tap, crowd consensus, or nothing.
    source: Optional[Literal["vendor", "crowdsource"]] = None
    confidence: Optional[Literal["low", "medium", "high"]] = None
    # Rough Phase-1 mapping (green 0–5, yellow 5–12, red 12+). None when unknown.
    wait_min_minutes: Optional[float] = None
    wait_max_minutes: Optional[float] = None
    wait_estimate: Optional[str] = None
    # Single representative number used in notifications ("~8 min").
    wait_typical_minutes: Optional[float] = None
    last_updated: Optional[str] = None
    update_age_minutes: Optional[float] = None
    crowd_report_count: int = 0
