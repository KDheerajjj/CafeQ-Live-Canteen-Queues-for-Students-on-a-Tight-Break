"""Unit tests for the "Is it worth waiting?" decision rules."""

from backend.database import query
from backend.services import worthit_engine
from backend.services.worthit_engine import build_option, recommend


def cafes_by_id():
    return {c["id"]: c for c in query("SELECT * FROM cafes")}


def waits(mapping):
    return lambda cafe_id: mapping[cafe_id]


# ---- walk times (seed: A-B 3, A-C 5, B-C 4; default origin = main building = Cafe A) ----

def test_walk_to_own_cafe_is_minimum_walk():
    cafes = cafes_by_id()
    assert worthit_engine.walk_minutes("cafe-a", cafes["cafe-a"], cafes) == 1


def test_walk_times_from_seed():
    cafes = cafes_by_id()
    assert worthit_engine.walk_minutes("cafe-a", cafes["cafe-c"], cafes) == 5
    assert worthit_engine.walk_minutes("cafe-b", cafes["cafe-c"], cafes) == 4


def test_unknown_origin_uses_default_walk():
    cafes = cafes_by_id()
    assert worthit_engine.walk_minutes("nowhere", cafes["cafe-b"], cafes) == worthit_engine.UNKNOWN_WALK_MINUTES


# ---- pure decision rule ----

def test_go_when_requested_cafe_fits():
    req = build_option({"id": "x", "name": "X"}, walk=2, predicted_wait=3, eating_buffer=10, available_minutes=20)
    r = recommend(req, [], 20)
    assert r.recommendation == "go"
    assert r.suggested.cafe_id == "x"
    assert req.total_minutes == 15
    assert req.time_left_to_eat == 15  # 20 - walk 2 - wait 3


def test_exact_fit_counts_as_go():
    req = build_option({"id": "x", "name": "X"}, 5, 5, 10, 20)
    assert recommend(req, [], 20).recommendation == "go"


def test_alternative_is_lowest_total_that_fits():
    req = build_option({"id": "a", "name": "A"}, 1, 15, 10, 20)       # 26
    b = build_option({"id": "b", "name": "B"}, 3, 5, 10, 20)          # 18
    c = build_option({"id": "c", "name": "C"}, 5, 1, 10, 20)          # 16
    r = recommend(req, [b, c], 20)
    assert r.recommendation == "alternative"
    assert r.suggested.cafe_id == "c"
    assert [o.cafe_id for o in r.options] == ["c", "b", "a"]


def test_skip_when_nothing_fits():
    req = build_option({"id": "a", "name": "A"}, 1, 30, 10, 15)
    b = build_option({"id": "b", "name": "B"}, 3, 20, 10, 15)
    r = recommend(req, [b], 15)
    assert r.recommendation == "skip"
    assert r.message == "Grab a quick snack instead."
    assert r.suggested is None


# ---- DB-backed evaluate() with injected predictions ----

def test_evaluate_go():
    r = worthit_engine.evaluate("cafe-a", 20, wait_fn=waits({"cafe-a": 3, "cafe-b": 3, "cafe-c": 3}), eating_buffer=10)
    assert r.recommendation == "go"
    assert r.requested.walk_minutes == 1
    assert r.requested.total_minutes == 14


def test_evaluate_suggests_other_cafe():
    r = worthit_engine.evaluate("cafe-a", 20, wait_fn=waits({"cafe-a": 15, "cafe-b": 3, "cafe-c": 12}), eating_buffer=10)
    assert r.recommendation == "alternative"
    assert r.suggested.cafe_id == "cafe-b"           # 3 walk + 3 wait + 10 = 16
    assert r.suggested.total_minutes == 16


def test_evaluate_skip():
    r = worthit_engine.evaluate("cafe-a", 12, wait_fn=waits({"cafe-a": 8, "cafe-b": 8, "cafe-c": 8}), eating_buffer=10)
    assert r.recommendation == "skip"


def test_evaluate_respects_origin():
    r = worthit_engine.evaluate("cafe-c", 30, origin_id="cafe-b",
                                wait_fn=waits({"cafe-a": 1, "cafe-b": 1, "cafe-c": 1}), eating_buffer=10)
    assert r.requested.walk_minutes == 4


def test_evaluate_unknown_cafe_returns_none():
    assert worthit_engine.evaluate("cafe-zzz", 20, wait_fn=lambda _: 1) is None
