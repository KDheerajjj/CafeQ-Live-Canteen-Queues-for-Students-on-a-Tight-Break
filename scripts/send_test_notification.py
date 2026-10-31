"""
Push-notification test helper.

    # 1. Generate a VAPID key pair to paste into .env (one-time setup)
    python scripts/send_test_notification.py --gen-keys

    # 2. After subscribing from the dashboard, send a test push to everyone
    python scripts/send_test_notification.py

    # Custom text
    python scripts/send_test_notification.py --title "Hello" --body "Testing CafeQ push"

    # Run the "break in 10 min" reminder tick right now (only matches subscribers
    # whose break_time is exactly REMINDER_LEAD_MINUTES from now)
    python scripts/send_test_notification.py --reminders
"""

import argparse
import base64
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.config import settings  # noqa: E402
from backend.database import init_db, query_one  # noqa: E402


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def generate_keys() -> None:
    """Creates an EC P-256 key pair in the format the browser and pywebpush expect."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    private_key = ec.generate_private_key(ec.SECP256R1())
    private_raw = private_key.private_numbers().private_value.to_bytes(32, "big")
    public_raw = private_key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    print("Add these to your .env (keep the private key secret):\n")
    print(f"VAPID_PUBLIC_KEY={b64url(public_raw)}")
    print(f"VAPID_PRIVATE_KEY={b64url(private_raw)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--gen-keys", action="store_true", help="print a new VAPID key pair and exit")
    parser.add_argument("--reminders", action="store_true", help="run one reminder-scheduler tick")
    parser.add_argument("--title", default="CafeQ test notification")
    parser.add_argument("--body", default=None, help="default: live status summary of all cafes")
    args = parser.parse_args()

    if args.gen_keys:
        generate_keys()
        return

    if not settings.push_enabled:
        sys.exit("VAPID keys are not configured. Run with --gen-keys and add them to .env first.")

    init_db()
    from backend.services import notification_service

    count = query_one("SELECT COUNT(*) AS n FROM push_subscribers")["n"]
    if not count:
        sys.exit("No subscribers yet. Open the dashboard in Chrome, tap Enable, then rerun.")

    result = (
        notification_service.run_reminders_once()
        if args.reminders
        else notification_service.broadcast(args.title, args.body)
    )
    print(result)


if __name__ == "__main__":
    main()
