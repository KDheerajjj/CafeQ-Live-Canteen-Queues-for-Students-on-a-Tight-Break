"""
Prediction endpoints.

NOTE: /api/predict/worthit is declared BEFORE /api/predict/{cafe_id};
otherwise FastAPI would treat "worthit" as a cafe id.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from backend.models.prediction import Prediction, WorthItResult
from backend.services import prediction_engine, worthit_engine

router = APIRouter(prefix="/api/predict", tags=["predict"])


@router.get("/worthit", response_model=WorthItResult)
def worth_it(
    cafe_id: str,
    available_minutes: float = Query(..., gt=0, le=240, description="Minutes until the next class"),
    from_cafe_id: Optional[str] = Query(
        None, description="Where the student is now (a cafe id). Default: main building."
    ),
    eating_buffer: Optional[float] = Query(None, ge=0, le=60),
) -> WorthItResult:
    result = worthit_engine.evaluate(cafe_id, available_minutes, from_cafe_id, eating_buffer)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Unknown cafe '{cafe_id}'")
    return result


@router.get("/{cafe_id}", response_model=Prediction)
def predict(cafe_id: str) -> Prediction:
    prediction = prediction_engine.predict_wait(cafe_id)
    if prediction is None:
        raise HTTPException(status_code=404, detail=f"Unknown cafe '{cafe_id}'")
    return prediction
