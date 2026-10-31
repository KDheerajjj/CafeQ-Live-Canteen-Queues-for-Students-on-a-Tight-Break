"""
Test setup: every test run uses a throwaway SQLite file and known secrets.

Environment variables must be set BEFORE any backend module is imported,
because backend.config reads them at import time.
"""

import os
import tempfile
from pathlib import Path

_tmp = Path(tempfile.mkdtemp(prefix="cafeq-test-"))
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp / 'test.db'}"
os.environ["VENDOR_PIN"] = "4321"
os.environ["ADMIN_API_KEY"] = "test-admin-key"
os.environ["ENABLE_SCHEDULER"] = "0"
os.environ["VAPID_PUBLIC_KEY"] = ""
os.environ["VAPID_PRIVATE_KEY"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.database import execute, init_db, seed_cafes  # noqa: E402
from backend.main import app  # noqa: E402
from backend.routers.crowdsource import reset_cooldowns  # noqa: E402
from backend.services import prediction_engine  # noqa: E402

VENDOR = {"X-Vendor-PIN": "4321"}
ADMIN = {"X-Admin-Key": "test-admin-key"}


@pytest.fixture(autouse=True)
def clean_db(monkeypatch):
    """Fresh tables + the 3 seed cafes for every test; no trained model on disk."""
    init_db()
    for table in ("status_updates", "crowd_reports", "order_logs", "push_subscribers", "predictions", "cafes"):
        execute(f"DELETE FROM {table}")
    seed_cafes()
    reset_cooldowns()
    # Never let a developer's locally trained model leak into test results.
    monkeypatch.setattr(prediction_engine, "MODEL_PATH", _tmp / "no-model.joblib")
    prediction_engine._bundle_cache.clear()
    yield


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
