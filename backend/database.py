"""
Database access: connection handling, schema creation and light migrations.

Design notes
------------
* Plain SQL through the standard-library sqlite3 driver — no ORM — so the
  schema in this file is exactly the schema documented in docs/data-dictionary.md.
* A fresh connection per call keeps things thread-safe under FastAPI's worker
  threads; SQLite opens in microseconds, so this costs nothing at campus scale.
* All timestamps are stored as UTC strings "YYYY-MM-DD HH:MM:SS" (the same
  format SQLite's CURRENT_TIMESTAMP produces). That format sorts and compares
  correctly as text, so "last 15 minutes" is a simple string comparison.
* Production (Supabase PostgreSQL): when DATABASE_URL starts with postgres://
  the same SQL runs through psycopg with "?" placeholders rewritten to "%s".
  This path is a thin adapter and has NOT been exercised by the test suite.
"""

import logging
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Iterator, Optional

from backend.config import settings

logger = logging.getLogger("cafeq.database")

TS_FORMAT = "%Y-%m-%d %H:%M:%S"

# Schema from the project spec, with ONE deliberate extension: a `source`
# marker so SYNTHETIC demo rows can never be mistaken for real observations.
#   * status_updates.source also accepts 'synthetic'
#   * order_logs / crowd_reports get source IN ('real', 'synthetic')
SCHEMA = """
CREATE TABLE IF NOT EXISTS cafes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location_description TEXT,
    walk_times_json TEXT,
    is_active BOOLEAN DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS status_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id TEXT NOT NULL REFERENCES cafes(id),
    status TEXT NOT NULL CHECK(status IN ('green', 'yellow', 'red')),
    source TEXT NOT NULL CHECK(source IN ('vendor', 'crowdsource', 'ml', 'synthetic')),
    reporter_id TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id TEXT NOT NULL REFERENCES cafes(id),
    item_name TEXT,
    estimated_prep_minutes REAL,
    source TEXT NOT NULL DEFAULT 'real' CHECK(source IN ('real', 'synthetic')),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crowd_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id TEXT NOT NULL REFERENCES cafes(id),
    reported_status TEXT NOT NULL CHECK(reported_status IN ('green', 'yellow', 'red')),
    source TEXT NOT NULL DEFAULT 'real' CHECK(source IN ('real', 'synthetic')),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh_key TEXT NOT NULL,
    auth_key TEXT NOT NULL,
    break_time TEXT,
    preferred_cafe_id TEXT REFERENCES cafes(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id TEXT NOT NULL REFERENCES cafes(id),
    predicted_wait_minutes REAL NOT NULL,
    model_type TEXT NOT NULL CHECK(model_type IN ('baseline', 'rf', 'manual')),
    confidence TEXT CHECK(confidence IN ('low', 'medium', 'high')),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_status_updates_cafe_time ON status_updates(cafe_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_order_logs_cafe_time ON order_logs(cafe_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_crowd_reports_cafe_time ON crowd_reports(cafe_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_push_subscribers_break ON push_subscribers(break_time);
"""

# Migrations for databases created from the original (un-extended) schema.
# Each entry: (table, column, ALTER statement). Applied only if the column is missing.
COLUMN_MIGRATIONS = [
    (
        "order_logs",
        "source",
        "ALTER TABLE order_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'real'",
    ),
    (
        "crowd_reports",
        "source",
        "ALTER TABLE crowd_reports ADD COLUMN source TEXT NOT NULL DEFAULT 'real'",
    ),
]


# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

def utc_now() -> datetime:
    """Naive UTC 'now' — matches what we store."""
    return datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)


def to_db_ts(dt: datetime) -> str:
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt.strftime(TS_FORMAT)


def parse_ts(value: Any) -> Optional[datetime]:
    """Accepts SQLite strings or Postgres datetimes; returns naive UTC."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value
    text = str(value).replace("T", " ").split(".")[0]
    return datetime.strptime(text[:19], TS_FORMAT)


def minutes_ago(minutes: float, now: Optional[datetime] = None) -> str:
    """DB timestamp string for `now - minutes`, used for time-window filters."""
    return to_db_ts((now or utc_now()) - timedelta(minutes=minutes))


# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------

def _is_postgres() -> bool:
    return settings.database_url.startswith(("postgres://", "postgresql://"))


@contextmanager
def get_connection() -> Iterator[Any]:
    """Yields a connection that commits on success and rolls back on error."""
    if _is_postgres():
        import psycopg  # optional dependency, only needed in production
        from psycopg.rows import dict_row

        conn = psycopg.connect(settings.database_url, row_factory=dict_row)
    else:
        path = settings.sqlite_path
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _adapt(sql: str) -> str:
    return sql.replace("?", "%s") if _is_postgres() else sql


def query(sql: str, params: Iterable[Any] = ()) -> list[dict]:
    with get_connection() as conn:
        cur = conn.execute(_adapt(sql), tuple(params))
        return [dict(row) for row in cur.fetchall()]


def query_one(sql: str, params: Iterable[Any] = ()) -> Optional[dict]:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: Iterable[Any] = ()) -> int:
    """Runs a write statement. Returns the new row id for INSERTs, else rowcount."""
    with get_connection() as conn:
        is_insert = sql.lstrip().upper().startswith("INSERT")
        # Postgres has no lastrowid; every table except `cafes` (text PK) has a
        # numeric id we can RETURN instead.
        if _is_postgres() and is_insert and "INTO cafes" not in sql:
            cur = conn.execute(_adapt(sql) + " RETURNING id", tuple(params))
            row = cur.fetchone()
            return row["id"] if row else 0
        cur = conn.execute(_adapt(sql), tuple(params))
        return cur.lastrowid if is_insert else cur.rowcount


def execute_many(sql: str, rows: Iterable[Iterable[Any]]) -> None:
    with get_connection() as conn:
        if _is_postgres():
            with conn.cursor() as cur:
                cur.executemany(_adapt(sql), [tuple(r) for r in rows])
        else:
            conn.executemany(sql, [tuple(r) for r in rows])


# ---------------------------------------------------------------------------
# Schema setup
# ---------------------------------------------------------------------------

def _postgres_schema() -> str:
    return (
        SCHEMA.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
        .replace("BOOLEAN DEFAULT 1", "BOOLEAN DEFAULT TRUE")
    )


def _existing_columns(conn: Any, table: str) -> set[str]:
    if _is_postgres():
        cur = conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = %s",
            (table,),
        )
        return {r["column_name"] for r in cur.fetchall()}
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def init_db() -> None:
    """Creates all tables/indexes (idempotent) and applies pending migrations."""
    with get_connection() as conn:
        if _is_postgres():
            for statement in _postgres_schema().split(";"):
                if statement.strip():
                    conn.execute(statement)
        else:
            conn.executescript(SCHEMA)

        for table, column, alter_sql in COLUMN_MIGRATIONS:
            if column not in _existing_columns(conn, table):
                logger.info("Migrating: adding %s.%s", table, column)
                conn.execute(alter_sql)


def seed_cafes(seed_path: Optional[str] = None) -> int:
    """
    Upserts cafes from backend/seed/cafes.json. Safe to run repeatedly: existing
    cafes get their name/location/walk times refreshed, nothing is deleted.
    Returns the number of cafes in the seed file.
    """
    import json
    from pathlib import Path

    from backend.config import BACKEND_DIR

    path = Path(seed_path) if seed_path else BACKEND_DIR / "seed" / "cafes.json"
    cafes = json.loads(path.read_text(encoding="utf-8"))
    for cafe in cafes:
        params = (
            cafe["id"],
            cafe["name"],
            cafe.get("location_description"),
            json.dumps(cafe.get("walk_times", {})),
        )
        existing = query_one("SELECT id FROM cafes WHERE id = ?", (cafe["id"],))
        if existing:
            execute(
                "UPDATE cafes SET name = ?, location_description = ?, walk_times_json = ? WHERE id = ?",
                (params[1], params[2], params[3], params[0]),
            )
        else:
            execute(
                "INSERT INTO cafes (id, name, location_description, walk_times_json) VALUES (?, ?, ?, ?)",
                params,
            )
    return len(cafes)
