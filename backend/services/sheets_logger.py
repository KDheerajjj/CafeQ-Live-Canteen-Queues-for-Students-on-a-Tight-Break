"""
(Optional) Google Sheets logger — Phase 1 fallback / backup.

Why: during the first field days the team wants every vendor tap and crowd
report mirrored somewhere they can eyeball live and that survives Render's
ephemeral disk. A Google Sheet behind an Apps Script "web app" is free and needs
no Google API credentials on the server.

Setup (see docs/deployment-guide.md):
  1. In a Google Sheet: Extensions -> Apps Script, paste a doPost(e) that
     appends JSON.parse(e.postData.contents) as a row; deploy as a web app.
  2. Put the web-app URL in .env as GOOGLE_SHEETS_WEBHOOK_URL.

Disabled (a no-op) when the variable is unset. Sending happens on a daemon
thread and failures are only logged, so a slow Google endpoint can never
delay a vendor's button tap.
"""

import json
import logging
import os
import threading
import urllib.request

from backend.database import to_db_ts, utc_now

logger = logging.getLogger("cafeq.sheets")


def _webhook_url() -> str:
    return os.getenv("GOOGLE_SHEETS_WEBHOOK_URL", "").strip()


def is_enabled() -> bool:
    return bool(_webhook_url())


def _post(url: str, payload: dict) -> None:
    try:
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=5).close()
    except Exception as exc:  # never let logging break the app
        logger.warning("Sheets log failed: %s", exc)


def log_event(kind: str, **fields) -> None:
    """kind: 'vendor_status' | 'crowd_report' | 'order'. Fields are copied as columns."""
    url = _webhook_url()
    if not url:
        return
    payload = {"kind": kind, "logged_at_utc": to_db_ts(utc_now()), **fields}
    threading.Thread(target=_post, args=(url, payload), daemon=True).start()
