from typing import Literal, Optional

from pydantic import BaseModel


class Prediction(BaseModel):
    """Output of GET /api/predict/{cafe_id}."""

    cafe_id: str
    predicted_wait_minutes: float
    # baseline = historical average lookup; rf = RandomForest; manual = derived
    # from the live traffic-light status because no history exists yet.
    model_type: Literal["baseline", "rf", "manual"]
    confidence: Literal["low", "medium", "high"]
    # Human-readable explanation of how the number was produced (shown on hover
    # / in the API) — important for an honest academic demo.
    explanation: str
    live_status: Optional[str] = None
    timestamp: str


class WorthItOption(BaseModel):
    cafe_id: str
    name: str
    walk_minutes: float
    predicted_wait_minutes: float
    eating_buffer_minutes: float
    total_minutes: float
    time_left_to_eat: float


class WorthItResult(BaseModel):
    """Output of GET /api/predict/worthit."""

    recommendation: Literal["go", "alternative", "skip"]
    message: str
    available_minutes: float
    requested: WorthItOption
    # The cafe the student should actually go to (same as requested for "go").
    suggested: Optional[WorthItOption] = None
    options: list[WorthItOption] = []
