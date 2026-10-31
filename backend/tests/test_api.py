"""Integration tests: real FastAPI app + temporary SQLite database."""

from datetime import timedelta
from types import SimpleNamespace

import pytest

from backend.database import execute, query, query_one, to_db_ts, utc_now
from backend.services import notification_service, status_engine
from backend.tests.conftest import ADMIN, VENDOR


# ---------- static frontend ----------

def test_frontend_is_served(client):
    assert "Campus Cafe Status" in client.get("/").text
    assert client.get("/vendor.html").status_code == 200
    assert client.get("/manifest.json").json()["short_name"] == "CafeQ"
    assert client.get("/sw.js").status_code == 200


# ---------- status ----------

def test_all_cafes_unknown_without_data(client):
    data = client.get("/api/status").json()
    assert data["stale_threshold_minutes"] == 15
    assert len(data["cafes"]) == 3
    assert {c["status"] for c in data["cafes"]} == {"unknown"}


def test_vendor_update_requires_pin(client):
    r = client.post("/api/status", json={"cafe_id": "cafe-a", "status": "green", "source": "vendor"})
    assert r.status_code == 401
    r = client.post("/api/status", json={"cafe_id": "cafe-a", "status": "green", "source": "vendor"},
                    headers={"X-Vendor-PIN": "0000"})
    assert r.status_code == 401


def test_vendor_update_sets_status(client):
    r = client.post("/api/status", json={"cafe_id": "cafe-a", "status": "red", "source": "vendor"}, headers=VENDOR)
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "red" and body["confidence"] == "high"
    assert client.get("/api/status/cafe-a").json()["wait_estimate"] == "12+ min"


def test_stale_vendor_update_shows_unknown(client):
    old = to_db_ts(utc_now() - timedelta(minutes=16))
    execute("INSERT INTO status_updates (cafe_id, status, source, timestamp) VALUES ('cafe-a', 'green', 'vendor', ?)", (old,))
    assert client.get("/api/status/cafe-a").json()["status"] == "unknown"


def test_unknown_cafe_404(client):
    assert client.get("/api/status/nope").status_code == 404
    assert client.post("/api/report", json={"cafe_id": "nope", "reported_status": "green"}).status_code == 404


def test_ml_source_cannot_be_posted(client):
    r = client.post("/api/status", json={"cafe_id": "cafe-a", "status": "green", "source": "ml"}, headers=VENDOR)
    assert r.status_code == 422


# ---------- crowdsourcing ----------

def test_single_report_is_low_confidence(client):
    r = client.post("/api/report", json={"cafe_id": "cafe-b", "reported_status": "yellow"})
    assert r.status_code == 201
    assert r.json()["status"] == "yellow"
    assert r.json()["confidence"] == "low"


def test_report_cooldown_blocks_spam(client):
    payload = {"cafe_id": "cafe-b", "reported_status": "red"}
    assert client.post("/api/report", json=payload).status_code == 201
    assert client.post("/api/report", json=payload).status_code == 429
    # A different cafe is fine.
    assert client.post("/api/report", json={"cafe_id": "cafe-c", "reported_status": "red"}).status_code == 201


def test_reports_from_different_students_reach_consensus(client):
    for ip in ("10.0.0.1", "10.0.0.2"):
        client.post("/api/report", json={"cafe_id": "cafe-c", "reported_status": "red"},
                    headers={"X-Forwarded-For": ip})
    s = client.get("/api/status/cafe-c").json()
    assert s["status"] == "red" and s["confidence"] == "medium" and s["crowd_report_count"] == 2
    assert len(client.get("/api/report/recent/cafe-c").json()) == 2


def test_student_post_to_status_is_stored_as_crowd_report(client):
    r = client.post("/api/status", json={"cafe_id": "cafe-a", "status": "green", "source": "crowdsource"})
    assert r.status_code == 201
    assert query_one("SELECT COUNT(*) AS n FROM crowd_reports")["n"] == 1
    assert query_one("SELECT COUNT(*) AS n FROM status_updates")["n"] == 0


# ---------- orders ----------

def test_orders_need_pin_and_are_counted(client):
    assert client.post("/api/orders", json={"cafe_id": "cafe-a"}).status_code == 401
    for item in ("dosa", "coffee", None):
        assert client.post("/api/orders", json={"cafe_id": "cafe-a", "item_name": item}, headers=VENDOR).status_code == 201
    c = client.get("/api/orders/count/cafe-a").json()
    assert c["count"] == 3 and c["orders_today"] == 3
    assert c["busiest_hour_orders"] == 3
    # Picking an item fills in its typical prep time.
    assert query_one("SELECT estimated_prep_minutes AS p FROM order_logs WHERE item_name = 'dosa'")["p"] == 6


def test_synthetic_orders_excluded_from_counts(client):
    execute("INSERT INTO order_logs (cafe_id, source, timestamp) VALUES ('cafe-a', 'synthetic', ?)", (to_db_ts(utc_now()),))
    assert client.get("/api/orders/count/cafe-a").json()["count"] == 0


# ---------- predictions ----------

def test_prediction_without_history_uses_live_status(client):
    client.post("/api/status", json={"cafe_id": "cafe-a", "status": "yellow", "source": "vendor"}, headers=VENDOR)
    p = client.get("/api/predict/cafe-a").json()
    assert p["model_type"] == "manual"
    assert p["predicted_wait_minutes"] == status_engine.WAIT_RANGES["yellow"][3]
    assert query_one("SELECT COUNT(*) AS n FROM predictions")["n"] == 1


def test_prediction_labels_synthetic_baseline(client):
    from backend.ml.generate_sample_data import generate

    generate(days=7, seed=1)
    p = client.get("/api/predict/cafe-b").json()
    assert p["model_type"] == "baseline"
    assert "SYNTHETIC" in p["explanation"]


def test_prediction_clamped_to_live_red(client):
    # Quiet history, but the vendor says RED right now -> never predict < 12 min.
    now = utc_now()
    rows = [("cafe-a", 1.0, to_db_ts(now - timedelta(days=d))) for d in range(1, 8)]
    for r in rows:
        execute("INSERT INTO order_logs (cafe_id, estimated_prep_minutes, source, timestamp) VALUES (?, ?, 'real', ?)", r)
    client.post("/api/status", json={"cafe_id": "cafe-a", "status": "red", "source": "vendor"}, headers=VENDOR)
    p = client.get("/api/predict/cafe-a").json()
    assert p["predicted_wait_minutes"] >= 12


def test_worthit_endpoint(client):
    client.post("/api/status", json={"cafe_id": "cafe-a", "status": "green", "source": "vendor"}, headers=VENDOR)
    r = client.get("/api/predict/worthit", params={"cafe_id": "cafe-a", "available_minutes": 30})
    assert r.status_code == 200
    assert r.json()["recommendation"] == "go"
    r = client.get("/api/predict/worthit", params={"cafe_id": "cafe-a", "available_minutes": 5})
    assert r.json()["recommendation"] == "skip"
    assert client.get("/api/predict/worthit", params={"cafe_id": "cafe-a", "available_minutes": 0}).status_code == 422


# ---------- history ----------

def test_heatmap_shape_and_labels(client):
    h = client.get("/api/history/heatmap", params={"cafe_id": "cafe-a"}).json()
    assert h["data_source"] == "none"
    assert len(h["grid"]) == 7 and all(len(row) == 12 for row in h["grid"])

    from backend.ml.generate_sample_data import generate

    generate(days=14, seed=3)
    h = client.get("/api/history/heatmap", params={"cafe_id": "cafe-a"}).json()
    assert h["data_source"] == "synthetic" and "SYNTHETIC" in h["note"]
    assert h["best_slot"] is not None


def test_cafe_history_lists_real_events(client):
    client.post("/api/status", json={"cafe_id": "cafe-a", "status": "green", "source": "vendor"}, headers=VENDOR)
    client.post("/api/report", json={"cafe_id": "cafe-a", "reported_status": "yellow"})
    h = client.get("/api/history/cafe-a").json()
    assert {e["source"] for e in h["status_events"]} == {"vendor", "crowdsource"}


# ---------- notifications ----------

SUB = {"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": {"p256dh": "k1", "auth": "k2"},
       "break_time": "12:30", "preferred_cafe_id": "cafe-b"}


def test_subscribe_upsert_and_unsubscribe(client):
    assert client.post("/api/subscribe", json=SUB).json()["updated"] is False
    assert client.post("/api/subscribe", json={**SUB, "break_time": "13:00"}).json()["updated"] is True
    assert query("SELECT break_time FROM push_subscribers") == [{"break_time": "13:00"}]
    assert client.request("DELETE", "/api/subscribe", json={"endpoint": SUB["endpoint"]}).json()["unsubscribed"] is True


def test_subscribe_rejects_bad_break_time(client):
    assert client.post("/api/subscribe", json={**SUB, "break_time": "25:99"}).status_code == 422


def test_vapid_key_endpoint_reports_disabled(client):
    assert client.get("/api/notify/vapid-public-key").json() == {"public_key": None, "enabled": False}


def test_notification_body_format():
    statuses = [
        status_engine.CafeStatus(cafe_id="cafe-a", name="Cafe A (Main Canteen)", status="green"),
        status_engine.CafeStatus(cafe_id="cafe-b", name="Cafe B (Block 2 Canteen)", status="yellow", wait_typical_minutes=8),
        status_engine.CafeStatus(cafe_id="cafe-c", name="Cafe C (Snack Corner)", status="red"),
    ]
    assert notification_service.compose_body(statuses) == "Cafe A 🟢 Free | Cafe B 🟡 ~8 min | Cafe C 🔴 Busy"
    assert notification_service.compose_body(statuses, "cafe-c").startswith("Cafe C")


def test_reminder_tick_matches_break_time_and_deletes_expired(client, monkeypatch):
    from datetime import datetime

    client.post("/api/subscribe", json=SUB)  # break 12:30 IST
    tick = datetime(2026, 11, 2, 6, 50)       # 12:20 IST = 10 min before
    assert notification_service.due_break_time(tick) == "12:30"

    sent = []

    def fake_send(sub, payload):
        sent.append(payload)
        # Simulate the push service reporting an expired subscription.
        execute("DELETE FROM push_subscribers WHERE endpoint = ?", (sub["endpoint"],))
        return False

    monkeypatch.setattr(notification_service, "send_push", fake_send)
    result = notification_service.run_reminders_once(tick)
    assert result["matched"] == 1
    assert "Cafe B" in sent[0]["body"].split(" | ")[0]  # preferred cafe first
    assert notification_service.run_reminders_once(datetime(2026, 11, 2, 6, 51))["matched"] == 0


def test_send_push_deletes_subscriber_on_410(client, monkeypatch):
    pytest.importorskip("pywebpush")
    import pywebpush

    client.post("/api/subscribe", json=SUB)
    monkeypatch.setattr(notification_service.settings, "vapid_public_key", "pub")
    monkeypatch.setattr(notification_service.settings, "vapid_private_key", "priv")

    def gone(**kwargs):
        raise pywebpush.WebPushException("gone", response=SimpleNamespace(status_code=410))

    monkeypatch.setattr(pywebpush, "webpush", gone)
    sub = query_one("SELECT * FROM push_subscribers")
    assert notification_service.send_push(sub, {"title": "t", "body": "b"}) is False
    assert query_one("SELECT COUNT(*) AS n FROM push_subscribers")["n"] == 0


# ---------- admin ----------

def test_verify_pin(client):
    assert client.get("/api/admin/verify", headers={"X-Vendor-PIN": "nope"}).status_code == 401
    r = client.get("/api/admin/verify", headers=VENDOR)
    assert r.json()["valid"] is True and len(r.json()["cafes"]) == 3


def test_admin_stats_and_cafe_upsert(client):
    assert client.get("/api/admin/stats").status_code == 401
    stats = client.get("/api/admin/stats", headers=ADMIN).json()
    assert stats["cafes"] == 3 and "synthetic" in stats

    new = {"id": "cafe-d", "name": "Cafe D (Juice Bar)", "walk_times": {"cafe-a": 6}}
    assert client.post("/api/admin/cafe", json=new, headers=ADMIN).json()["walk_times"] == {"cafe-a": 6}
    assert len(client.get("/api/status").json()["cafes"]) == 4
