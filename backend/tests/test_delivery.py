"""Delivery metrics: timing from the event log, and the last-mile (unclaimed) list."""
from datetime import datetime, timedelta, timezone

from backend.app import config, db
from backend.app.services import delivery

T0 = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)


def _conn(tmp_path):
    config.DB_PATH = tmp_path / "d.db"
    return db.connect()


def _add(conn, ref, method, status, claim=None, claimed_at=None, submitted=T0):
    conn.execute(
        "INSERT INTO requests (request_ref, beneficiary_id, wallet, amount, asset, created_at, status, method,"
        " submitted_at, claim_status, claimed_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (ref, "H-x", "G" * 56, "10.0000000", "AIDUSD", T0.isoformat(), status, method,
         submitted.isoformat(), claim, claimed_at, T0.isoformat()))


def _event(conn, ref, kind, at):
    conn.execute("INSERT INTO events (request_ref, kind, detail, at) VALUES (?,?,?,?)", (ref, kind, None, at.isoformat()))


def test_timing_counts_claim_as_money_in_hand(tmp_path):
    conn = _conn(tmp_path)
    _add(conn, "P", "payment", "CONFIRMED")
    _add(conn, "C", "claimable_balance", "CLAIMED", "CLAIMED", (T0 + timedelta(minutes=10)).isoformat())
    _add(conn, "W", "claimable_balance", "CONFIRMED", "UNCLAIMED")
    for ref in "PCW":
        _event(conn, ref, "approved", T0)
        _event(conn, ref, "submitted", T0 + timedelta(seconds=55))
        _event(conn, ref, "confirmed", T0 + timedelta(seconds=60))
    t = delivery.timing(conn)
    assert t["approved_to_chain"] == {"n": 3, "median_s": 60, "max_s": 60}
    assert t["submitted_to_chain"]["median_s"] == 5
    assert t["approved_to_hand"]["n"] == 2 and t["approved_to_hand"]["max_s"] == 600  # payment 60 s, claim 10 min
    assert t["not_in_hand_yet"] == 1


def test_unclaimed_flags_overdue_oldest_first(tmp_path):
    conn = _conn(tmp_path)
    _add(conn, "OLD", "claimable_balance", "CONFIRMED", "UNCLAIMED", submitted=T0)
    _add(conn, "NEW", "claimable_balance", "CONFIRMED", "UNCLAIMED", submitted=T0 + timedelta(hours=70))
    _add(conn, "DONE", "claimable_balance", "CLAIMED", "CLAIMED", submitted=T0)
    rows = delivery.unclaimed(conn, now=T0 + timedelta(hours=80))
    assert [r["request_ref"] for r in rows] == ["OLD", "NEW"]
    assert [r["overdue"] for r in rows] == [True, False]  # 80 h and 10 h against a 72 h alert
