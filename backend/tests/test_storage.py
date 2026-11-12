"""Queries whose SQL differs most between SQLite and Postgres, and payouts run by several workers
at once. Run on both:  pytest backend/tests  and  TEST_DATABASE_URL=... pytest backend/tests"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from stellar_sdk import Account, Keypair

from backend.app import db, stellar_client as sc
from backend.app.main import app
from backend.app.services import executor, verifier

T0 = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc).isoformat()


def _add(conn, ref, status, amount="10.0000000", method=None, tx=None, batch="B1"):
    conn.execute(
        "INSERT INTO requests (request_ref, batch_id, beneficiary_id, wallet, amount, asset, created_at, status,"
        " method, tx_hash, submitted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (ref, batch, f"H-{ref}", Keypair.random().public_key, amount, "AIDUSD", T0, status, method, tx, T0, T0))


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("DISTRIBUTION_SECRET", (dist := Keypair.random()).secret)
    monkeypatch.setenv("DISTRIBUTION_PUBLIC", dist.public_key)
    monkeypatch.setenv("ISSUER_PUBLIC", Keypair.random().public_key)
    monkeypatch.delenv("REGISTRY_CONTRACT_ID", raising=False)


def test_amount_totals_are_exact_and_numeric(env):
    conn = db.connect()
    _add(conn, "A", "CONFIRMED", "10.1000000", method="payment")
    _add(conn, "B", "CLAIMED", "20.2000000", method="claimable_balance")
    _add(conn, "C", "PENDING_REVIEW", "5.0000000")
    conn.commit()
    conn.close()
    client = TestClient(app)

    batch = client.get("/summary").json()["batches"][0]
    assert batch == {"batch_id": "B1", "requests": 3, "confirmed": 2, "flagged": 0, "amount": 35.3}
    public = client.get("/public/summary").json()
    assert public["totals"]["amount_paid"] == 30.3
    assert public["batches"][0]["paid"] == 2 and public["batches"][0]["received"] == 2


def test_verifier_opens_the_claim_step_only_for_claimable_balances(env, monkeypatch):
    conn = db.connect()
    _add(conn, "P", "SUBMITTED", method="payment", tx="aa" * 32)
    _add(conn, "C", "SUBMITTED", method="claimable_balance", tx="bb" * 32)
    conn.commit()
    monkeypatch.setattr(sc, "verify", lambda tx_hash, wait_seconds=0: "SUCCESS")

    verifier.run(conn)
    assert db.get(conn, "P")["status"] == db.get(conn, "C")["status"] == "CONFIRMED"
    assert db.get(conn, "P")["claim_status"] is None
    assert db.get(conn, "C")["claim_status"] == "UNCLAIMED"
    conn.close()


def test_parallel_payout_runs_pay_each_request_once(env, monkeypatch):
    """Several instances pressing "pay" at the same moment: every request is sent exactly once."""
    conn = db.connect()
    refs = [f"R{i}" for i in range(6)]
    for ref in refs:
        _add(conn, ref, "APPROVED")
    conn.commit()
    conn.close()

    sent, lock = [], threading.Lock()
    build = sc.build_payout

    def slow_build(*args):
        time.sleep(0.05)  # widen the window in which two workers hold the same request
        return build(*args)

    def submit(tx):
        with lock:
            sent.append(tx.hash_hex())
        return "CONFIRMED", None

    monkeypatch.setattr(sc, "has_trustline", lambda *_: True)
    monkeypatch.setattr(sc, "horizon", lambda: SimpleNamespace(load_account=lambda key: Account(key, 0)))
    monkeypatch.setattr(sc, "build_payout", slow_build)
    monkeypatch.setattr(sc, "submit", submit)

    errors = []

    def worker():
        c = db.connect()
        try:
            executor.run(c)
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)
        finally:
            c.close()

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert len(sent) == len(refs)
    conn = db.connect()
    assert all(db.get(conn, ref)["status"] == "CONFIRMED" for ref in refs)
    submitted = conn.execute("SELECT COUNT(*) FROM events WHERE kind = 'submitted'").fetchone()[0]
    assert submitted == len(refs)
    conn.close()
