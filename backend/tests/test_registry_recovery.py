"""Recovery after interruptions: local registry state resynced, and no second payout when the
database forgot an in-flight one. Registry and chain calls are stubbed; nothing touches the network."""
from datetime import datetime, timezone

from backend.app import config, db, stellar_client as sc
from backend.app.services import executor

T0 = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc).isoformat()
KEY = "ab" * 32


def _conn(tmp_path):
    config.DB_PATH = tmp_path / "r.db"
    return db.connect()


def _add(conn, ref, status, registry_status, tx="deadbeef"):
    conn.execute(
        "INSERT INTO requests (request_ref, batch_id, beneficiary_id, wallet, amount, asset, created_at, status,"
        " registry_key, registry_status, tx_hash, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (ref, "B1", "H-x", "G" * 56, "10.0000000", "AIDUSD", T0, status, KEY, registry_status, tx, T0))
    conn.commit()


def test_repair_syncs_paid_entry_from_chain(tmp_path, monkeypatch):
    conn = _conn(tmp_path)
    _add(conn, "R1", "CONFIRMED", "RESERVED")
    monkeypatch.setattr(executor.registry, "get",
                        lambda key: {"request_hash": sc.memo_hash("R1"), "status": "Paid", "tx_hash": "deadbeef"})
    assert executor.repair_registry(conn) == ["R1"]
    assert db.get(conn, "R1")["registry_status"] == "PAID"
    kinds = [r[0] for r in conn.execute("SELECT kind FROM events WHERE request_ref = 'R1'")]
    assert "registry_paid" in kinds


def test_repair_marks_paid_when_mark_never_ran(tmp_path, monkeypatch):
    conn = _conn(tmp_path)
    _add(conn, "R2", "CONFIRMED", "RESERVED")
    monkeypatch.setattr(executor.registry, "get",
                        lambda key: {"request_hash": sc.memo_hash("R2"), "status": "Reserved", "tx_hash": None})
    monkeypatch.setattr(executor.registry, "mark_paid", lambda key, tx: "regtx")
    executor.repair_registry(conn)
    assert db.get(conn, "R2")["registry_status"] == "PAID"


def test_reserve_refuses_to_pay_again_when_chain_has_the_payout(tmp_path, monkeypatch):
    """Registry says 'already reserved by you', local row says APPROVED (DB was reset mid-flight)."""
    conn = _conn(tmp_path)
    _add(conn, "R3", "APPROVED", None, tx=None)
    monkeypatch.setattr(executor.registry, "key_for", lambda ben, batch: bytes.fromhex(KEY))
    monkeypatch.setattr(executor.registry, "reserve", lambda key, ref: ("RESERVED", None))
    monkeypatch.setattr(executor, "_paid_on_chain_already", lambda ref: "feedface")
    stop = executor._reserve(conn, db.get(conn, "R3"))
    assert stop and stop["status"] == "SUBMITTED" and stop["tx_hash"] == "feedface"
    assert db.get(conn, "R3")["status"] == "SUBMITTED"


def test_reserve_proceeds_when_nothing_is_on_chain(tmp_path, monkeypatch):
    conn = _conn(tmp_path)
    _add(conn, "R4", "APPROVED", None, tx=None)
    monkeypatch.setattr(executor.registry, "key_for", lambda ben, batch: bytes.fromhex(KEY))
    monkeypatch.setattr(executor.registry, "reserve", lambda key, ref: ("RESERVED", None))
    monkeypatch.setattr(executor, "_paid_on_chain_already", lambda ref: None)
    assert executor._reserve(conn, db.get(conn, "R4")) is None
    assert db.get(conn, "R4")["registry_status"] == "RESERVED"
