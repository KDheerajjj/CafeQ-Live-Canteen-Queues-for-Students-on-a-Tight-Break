import json
from typing import Optional

from pydantic import BaseModel, Field


class CafeCreate(BaseModel):
    """Payload for adding/updating a cafe via POST /api/admin/cafe."""

    # Slug-style ids ("cafe-d") keep URLs readable and stable.
    id: str = Field(..., pattern=r"^[a-z0-9-]{2,40}$", examples=["cafe-d"])
    name: str = Field(..., min_length=2, max_length=80)
    location_description: Optional[str] = Field(None, max_length=200)
    # Minutes on foot from THIS cafe to each other cafe (manually measured).
    walk_times: dict[str, float] = Field(default_factory=dict)
    is_active: bool = True


class Cafe(CafeCreate):
    created_at: Optional[str] = None

    @classmethod
    def from_row(cls, row: dict) -> "Cafe":
        return cls(
            id=row["id"],
            name=row["name"],
            location_description=row.get("location_description"),
            walk_times=json.loads(row.get("walk_times_json") or "{}"),
            is_active=bool(row.get("is_active", True)),
            created_at=str(row["created_at"]) if row.get("created_at") else None,
        )
