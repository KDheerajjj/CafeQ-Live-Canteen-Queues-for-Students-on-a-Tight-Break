"""
Creates the database schema and loads the campus cafes from backend/seed/cafes.json.

Usage (from the project root):
    python scripts/seed_db.py

Running it again is safe: tables are created only if missing and cafes are upserted.
"""

import sys
from pathlib import Path

# Allow `python scripts/seed_db.py` without installing the project as a package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.config import settings  # noqa: E402
from backend.database import init_db, query, seed_cafes  # noqa: E402


def main() -> None:
    init_db()
    count = seed_cafes()
    print(f"Database ready at: {settings.database_url}")
    print(f"Seeded {count} cafes:")
    for cafe in query("SELECT id, name, location_description FROM cafes ORDER BY id"):
        print(f"  - {cafe['id']}: {cafe['name']} ({cafe['location_description']})")


if __name__ == "__main__":
    main()
