"""
"Is it worth waiting?" engine.

A student has N minutes before the next class. Going to a cafe costs:

    total_time = walk_time + predicted_wait + eating_buffer

* walk_time      — minutes on foot from where the student is (default: the
                   main building, i.e. next to Cafe A) to the cafe.
* predicted_wait — from the prediction engine (baseline / RF / live status).
* eating_buffer  — time to actually eat (DEFAULT_EATING_BUFFER_MINUTES).

Decision:
  1. Requested cafe fits (total_time <= available) -> "go", with minutes to spare.
  2. Otherwise look at every other active cafe and pick the lowest total_time.
     If that one fits -> "alternative" (this is the load-balancing part:
     nudging students away from the overloaded counter).
  3. If nothing fits -> "skip": "Grab a quick snack instead."

Walking back to class is folded into the eating buffer on purpose — the walk
data we measured is cafe-to-cafe, and a single buffer keeps the rule easy to
explain on the dashboard.
"""

from __future__ import annotations

import json
from typing import Callable, Optional

from backend.config import settings
from backend.database import query
from backend.models.prediction import WorthItOption, WorthItResult

# Used when no walk time is recorded between two places.
UNKNOWN_WALK_MINUTES = 5.0


def walk_minutes(origin_id: str, target: dict, cafes_by_id: dict[str, dict]) -> float:
    """Minutes to walk from `origin_id` (a cafe id = 'near that cafe') to `target`."""
    if origin_id == target["id"]:
        return float(settings.min_walk_minutes)
    target_walks = json.loads(target.get("walk_times_json") or "{}")
    if origin_id in target_walks:
        return float(target_walks[origin_id])
    # Walk times are usually symmetric, so the reverse direction is a good stand-in.
    origin = cafes_by_id.get(origin_id)
    if origin:
        origin_walks = json.loads(origin.get("walk_times_json") or "{}")
        if target["id"] in origin_walks:
            return float(origin_walks[target["id"]])
    return UNKNOWN_WALK_MINUTES


def build_option(cafe: dict, walk: float, predicted_wait: float, eating_buffer: float,
                 available_minutes: float) -> WorthItOption:
    total = walk + predicted_wait + eating_buffer
    return WorthItOption(
        cafe_id=cafe["id"],
        name=cafe["name"],
        walk_minutes=round(walk, 1),
        predicted_wait_minutes=round(predicted_wait, 1),
        eating_buffer_minutes=round(eating_buffer, 1),
        total_minutes=round(total, 1),
        time_left_to_eat=round(available_minutes - walk - predicted_wait, 1),
    )


def recommend(requested: WorthItOption, others: list[WorthItOption], available_minutes: float) -> WorthItResult:
    """Pure decision rule (unit-tested without a database)."""
    options = sorted([requested, *others], key=lambda o: o.total_minutes)

    if requested.total_minutes <= available_minutes:
        spare = round(available_minutes - requested.total_minutes, 1)
        return WorthItResult(
            recommendation="go",
            message=(
                f"Go to {requested.name}. About {requested.time_left_to_eat:g} min to eat"
                + (f", with {spare:g} min to spare." if spare > 0 else ".")
            ),
            available_minutes=available_minutes,
            requested=requested,
            suggested=requested,
            options=options,
        )

    best = min(others, key=lambda o: o.total_minutes) if others else None
    if best and best.total_minutes <= available_minutes:
        return WorthItResult(
            recommendation="alternative",
            message=(
                f"{requested.name} needs ~{requested.total_minutes:g} min — too long. "
                f"Try {best.name} instead (~{best.total_minutes:g} min total)."
            ),
            available_minutes=available_minutes,
            requested=requested,
            suggested=best,
            options=options,
        )

    return WorthItResult(
        recommendation="skip",
        message="Grab a quick snack instead.",
        available_minutes=available_minutes,
        requested=requested,
        suggested=None,
        options=options,
    )


def evaluate(
    cafe_id: str,
    available_minutes: float,
    origin_id: Optional[str] = None,
    eating_buffer: Optional[float] = None,
    wait_fn: Optional[Callable[[str], float]] = None,
) -> Optional[WorthItResult]:
    """
    DB-backed entry point used by GET /api/predict/worthit.
    `wait_fn(cafe_id) -> minutes` defaults to the prediction engine; tests can inject one.
    Returns None if the requested cafe doesn't exist.
    """
    if wait_fn is None:
        from backend.services.prediction_engine import predict_wait

        def wait_fn(cid: str) -> float:
            p = predict_wait(cid)
            return p.predicted_wait_minutes if p else float("inf")

    cafes = query("SELECT * FROM cafes WHERE is_active ORDER BY id")
    by_id = {c["id"]: c for c in cafes}
    if cafe_id not in by_id:
        return None

    origin = origin_id if origin_id in by_id else settings.default_origin_cafe_id
    buffer = settings.default_eating_buffer_minutes if eating_buffer is None else eating_buffer

    def option(cafe: dict) -> WorthItOption:
        return build_option(cafe, walk_minutes(origin, cafe, by_id), wait_fn(cafe["id"]), buffer, available_minutes)

    requested = option(by_id[cafe_id])
    # Only compute alternatives if needed (spec step 6) — saves predictions on "go".
    if requested.total_minutes <= available_minutes:
        return recommend(requested, [], available_minutes)
    others = [option(c) for c in cafes if c["id"] != cafe_id]
    return recommend(requested, others, available_minutes)
