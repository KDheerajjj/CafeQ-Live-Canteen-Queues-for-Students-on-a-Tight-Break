"""
CafeQ — FastAPI entry point.

Run from the project root:
    uvicorn backend.main:app --reload --port 8000

One process serves both the JSON API (/api/...) and the static PWA frontend,
which keeps the whole system on a single free Render web service and avoids
CORS issues for the dashboard itself.
"""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import FRONTEND_DIR, settings
from backend.database import init_db, query_one, seed_cafes
from backend.routers import admin, crowdsource, history, notify, orders, predict, status
from backend.services import notification_service

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("cafeq")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Schema is created on every boot (idempotent). Render's free tier has an
    # ephemeral disk, so a fresh container must be usable without a manual
    # seed step: if there are no cafes yet, load them from seed/cafes.json.
    init_db()
    if not query_one("SELECT id FROM cafes LIMIT 1"):
        logger.info("No cafes found — seeding from backend/seed/cafes.json")
        seed_cafes()

    # Once-a-minute "your break starts in 10 min" push reminders.
    reminder_task = None
    if settings.enable_scheduler:
        reminder_task = asyncio.create_task(notification_service.reminder_loop())
    try:
        yield
    finally:
        if reminder_task:
            reminder_task.cancel()
            try:
                await reminder_task
            except asyncio.CancelledError:
                pass


app = FastAPI(
    title="CafeQ — Campus Cafe Wait-Time API",
    description=(
        "Real-time and predicted crowd/wait times across campus cafes. "
        "DTL project, RV College of Engineering."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# The frontend is served from this same origin, so CORS only matters for
# local experiments (e.g. opening the HTML from a different dev port).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Content-Type", "X-Vendor-PIN", "X-Admin-Key"],
)

for module in (status, crowdsource, orders, predict, history, notify, admin):
    app.include_router(module.router)


@app.get("/api/health", tags=["meta"])
def health() -> dict:
    """Used by Render's health check and by uptime pingers."""
    return {"ok": True}


# Mounted LAST so /api/* routes take priority. html=True serves index.html at "/".
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
