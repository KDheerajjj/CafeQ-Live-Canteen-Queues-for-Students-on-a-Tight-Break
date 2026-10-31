"""
Application settings, loaded from the project's .env file.

Every tunable business rule (stale threshold, eating buffer, reminder lead
time, ...) lives here so the DTL team can adjust behaviour after field testing
without touching the logic itself.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

# Project root = the folder that contains backend/, frontend/, data/ ...
PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = PROJECT_ROOT / "backend"
FRONTEND_DIR = PROJECT_ROOT / "frontend"
DATA_DIR = PROJECT_ROOT / "data"
ML_DIR = BACKEND_DIR / "ml"

# .env is optional: defaults below are safe for local development.
# Existing environment variables win, so tests and Render can override values.
load_dotenv(PROJECT_ROOT / ".env", override=False)


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def _resolve_database_url(raw: str) -> str:
    """
    Relative SQLite paths ("sqlite:///./data/cafeq.db") are resolved against the
    project root, not the shell's current directory, so `uvicorn`, the scripts and
    the tests all hit the same file no matter where they are launched from.
    """
    prefix = "sqlite:///"
    if raw.startswith(prefix):
        path = Path(raw[len(prefix):])
        if not path.is_absolute():
            path = (PROJECT_ROOT / path).resolve()
        return prefix + str(path)
    return raw


@dataclass
class Settings:
    database_url: str = field(
        default_factory=lambda: _resolve_database_url(
            os.getenv("DATABASE_URL", "sqlite:///./data/cafeq.db")
        )
    )

    # Demo-grade access control: a shared vendor PIN and an admin API key.
    # Deliberately simple (no JWT/OAuth/user accounts) — see project constraints.
    vendor_pin: str = field(default_factory=lambda: os.getenv("VENDOR_PIN", "1234"))
    admin_api_key: str = field(default_factory=lambda: os.getenv("ADMIN_API_KEY", ""))

    # Push notifications. Chrome's Web Push endpoints are served by FCM, so the
    # VAPID key pair is what actually authenticates us. FCM_SERVER_KEY is kept
    # only for the legacy FCM HTTP API and is optional.
    fcm_server_key: str = field(default_factory=lambda: os.getenv("FCM_SERVER_KEY", ""))
    vapid_public_key: str = field(default_factory=lambda: os.getenv("VAPID_PUBLIC_KEY", ""))
    vapid_private_key: str = field(default_factory=lambda: os.getenv("VAPID_PRIVATE_KEY", ""))
    vapid_email: str = field(
        default_factory=lambda: os.getenv("VAPID_EMAIL", "mailto:admin@example.com")
    )

    # A vendor update older than this is no longer trusted -> "Unknown".
    # Showing a stale green is worse than showing nothing (students walk over
    # expecting no queue), so this rule is enforced in the backend AND the UI.
    stale_threshold_minutes: int = field(
        default_factory=lambda: _int("STALE_THRESHOLD_MINUTES", 15)
    )
    # Crowd reports are noisier than vendor taps, so they expire sooner.
    crowd_window_minutes: int = field(default_factory=lambda: _int("CROWD_WINDOW_MINUTES", 10))

    status_refresh_seconds: int = field(
        default_factory=lambda: _int("STATUS_REFRESH_SECONDS", 30)
    )
    # Push reminders go out this many minutes before a subscriber's break.
    reminder_lead_minutes: int = field(default_factory=lambda: _int("REMINDER_LEAD_MINUTES", 10))
    # Time a student needs to actually eat once the food arrives.
    default_eating_buffer_minutes: int = field(
        default_factory=lambda: _int("DEFAULT_EATING_BUFFER_MINUTES", 10)
    )

    # All "hour of day" / "day of week" logic is campus-local time (IST).
    # Timestamps are STORED in UTC and converted only when bucketing.
    timezone: str = field(default_factory=lambda: os.getenv("TIMEZONE", "Asia/Kolkata"))

    # "Assume the student is at the main building" — Cafe A sits next to it, so
    # walk times from the main building are taken from Cafe A's walk_times.
    default_origin_cafe_id: str = field(
        default_factory=lambda: os.getenv("DEFAULT_ORIGIN_CAFE_ID", "cafe-a")
    )
    # Walking to the cafe you're standing next to still takes a minute.
    min_walk_minutes: int = field(default_factory=lambda: _int("MIN_WALK_MINUTES", 1))

    # Below this many rows per cafe a RandomForest would just memorise noise,
    # so the prediction engine sticks to the baseline lookup table.
    min_rows_for_ml: int = field(default_factory=lambda: _int("MIN_ROWS_FOR_ML", 200))

    # Anti-spam for anonymous crowd reports: one report per cafe per client
    # within this many seconds.
    report_cooldown_seconds: int = field(
        default_factory=lambda: _int("REPORT_COOLDOWN_SECONDS", 120)
    )

    # Turn off the once-a-minute reminder loop (used by the tests).
    enable_scheduler: bool = field(
        default_factory=lambda: os.getenv("ENABLE_SCHEDULER", "1") not in ("0", "false", "False")
    )

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite:///")

    @property
    def sqlite_path(self) -> Path:
        return Path(self.database_url[len("sqlite:///"):])

    @property
    def push_enabled(self) -> bool:
        return bool(self.vapid_public_key and self.vapid_private_key) and not (
            self.vapid_public_key.startswith("your-")
        )


settings = Settings()
