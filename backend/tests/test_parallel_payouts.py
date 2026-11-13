"""Parallel payouts over channel accounts (CHANNEL_SECRETS). Chain and registry calls are
stubbed; nothing touches the network."""
from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from stellar_sdk import Account, Keypair, StrKey, TransactionBuilder, scval

from backend.app import config, db, registry, soroban, stellar_client as sc
from backend.app.services import executor

T0 = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc).isoformat()
DIST = Keypair.random()
CHANNELS = [Keypair.random() for _ in range(3)]


@pytest.fixture(autouse=True)
def stellar(monkeypatch):
    monkeypatch.setenv("DISTRIBUTION_SECRET", DIST.secret)
    monkeypatch.setenv("ISSUER_PUBLIC", Keypair.random().public_key)
    monkeypatch.setenv("CHANNEL_SECRETS", ",".join(k.secret for k in CHANNELS))
    monkeypatch.delenv("REGISTRY_CONTRACT_ID", raising=False)
    monkeypatch.setattr(sc, "has_trustline", lambda *_: True)
    monkeypatch.setattr(sc, "horizon", lambda: SimpleNamespace(load_account=lambda key: Account(key, 1)))


def _approve(conn, refs: list[str], beneficiary=None) -> list[str]:
    for i, ref in enumerate(refs):
        conn.execute(
            "INSERT INTO requests (request_ref, batch_id, beneficiary_id, wallet, amount, asset, created_at,"
            " status, payout_slot, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (ref, "B1", beneficiary or f"H-{ref}", Keypair.random().public_key, "10.0000000", "AIDUSD",
             f"{T0[:-6]}.{i:06d}+00:00", "APPROVED", "base", T0))
    conn.commit()
    return refs


def _signed_by(tx, *keys: Keypair) -> bool:
    hints = {s.signature_hint for s in tx.signatures}
    return hints == {k.signature_hint() for k in keys} and all(
        any(_verifies(k, tx.hash(), s.signature) for s in tx.signatures) for k in keys)


def _verifies(kp: Keypair, data: bytes, sig: bytes) -> bool:
    try:
        kp.verify(data, sig)
        return True
    except Exception:
        return False


def test_channels_pay_side_by_side_and_each_request_once(monkeypatch):
    conn = db.connect()
    refs = _approve(conn, [f"P-{i}" for i in range(6)])
    lock, sent = threading.Lock(), []
    active = peak = 0

    def submit(tx):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            sent.append(tx)
        time.sleep(0.2)  # stands in for the ~5 s ledger wait
        with lock:
            active -= 1
        return "CONFIRMED", None

    monkeypatch.setattr(sc, "submit", submit)
    started = time.monotonic()
    result = executor.run(conn, limit=10)
    elapsed = time.monotonic() - started

    assert [r["request_ref"] for r in result] == refs  # oldest first, as before
    assert {r["status"] for r in result} == {"CONFIRMED"}
    assert len(sent) == 6 and peak >= 2 and elapsed < 6 * 0.2
    for tx in sent:
        inner = tx.transaction
        channel = next(c for c in CHANNELS if c.public_key == inner.source.account_id)
        assert inner.operations[0].source.account_id == DIST.public_key  # the money is DISTRIBUTION's
        assert _signed_by(tx, DIST, channel)
    assert {db.get(conn, r)["status"] for r in refs} == {"CONFIRMED"}


def test_without_channels_the_transaction_is_unchanged(monkeypatch):
    monkeypatch.delenv("CHANNEL_SECRETS")
    conn = db.connect()
    _approve(conn, ["S-1", "S-2"])
    sent = []
    monkeypatch.setattr(sc, "submit", lambda tx: (sent.append(tx), ("CONFIRMED", None))[1])
    assert [r["status"] for r in executor.run(conn)] == ["CONFIRMED", "CONFIRMED"]
    for tx in sent:
        assert tx.transaction.source.account_id == DIST.public_key
        assert tx.transaction.operations[0].source is None
        assert _signed_by(tx, DIST)


def test_one_worker_failing_does_not_stop_the_others(monkeypatch):
    conn = db.connect()
    _approve(conn, ["E-1", "E-2", "E-3"])

    def has_trustline(wallet, asset):
        if wallet == db.get(conn, "E-2")["wallet"]:
            raise ConnectionError("horizon down")
        return True

    monkeypatch.setattr(sc, "has_trustline", has_trustline)
    monkeypatch.setattr(sc, "submit", lambda tx: ("CONFIRMED", None))
    result = {r["request_ref"]: r for r in executor.run(conn)}
    assert result["E-1"]["status"] == result["E-3"]["status"] == "CONFIRMED"
    assert result["E-2"]["status"] == "APPROVED" and "horizon down" in result["E-2"]["error"]
    assert db.get(conn, "E-2")["tx_hash"] is None  # nothing was sent for it


def test_registry_race_in_parallel_pays_the_slot_once(monkeypatch):
    """Two requests for the same payout slot, two channels: both registers pass simulation at the
    same moment, the chain accepts one. The other must end BLOCKED, never paid."""
    monkeypatch.setenv("REGISTRY_CONTRACT_ID", StrKey.encode_contract(os.urandom(32)))
    monkeypatch.setenv("REGISTRY_SECRET", "test-registry-secret")
    conn = db.connect()
    _approve(conn, ["D-1", "D-2"], beneficiary="H-same")

    lock, entries, calls, payments = threading.Lock(), {}, [], []
    both_simulated = threading.Barrier(2, timeout=5)

    def prepare(signer_public, build):
        builder = TransactionBuilder(Account(signer_public, 1), config.NETWORK_PASSPHRASE)
        build(builder)
        tx = builder.set_timeout(30).build()
        if _function(tx) == "register":
            both_simulated.wait()
        return tx

    def send_and_wait(tx, timeout=60):
        name, args = _function(tx), _args(tx)
        with lock:
            calls.append(tx)
            key = args[0]
            if name == "register":
                if key in entries:
                    return "FAILED", tx.hash_hex(), None  # Error(Contract, #1) on chain
                entries[key] = {"request_hash": args[1], "status": "Reserved", "tx_hash": None}
            elif name == "mark_paid":
                entries[key].update(status="Paid", tx_hash=args[1].hex())
        return "SUCCESS", tx.hash_hex(), None

    monkeypatch.setattr(soroban, "prepare", prepare)
    monkeypatch.setattr(soroban, "send_and_wait", send_and_wait)
    monkeypatch.setattr(registry, "get", lambda key: (lambda e: dict(e) if e else None)(entries.get(key)))
    monkeypatch.setattr(sc, "submit", lambda tx: (payments.append(tx), ("CONFIRMED", None))[1])

    result = {r["request_ref"]: r for r in executor.run(conn)}
    assert sorted(r["status"] for r in result.values()) == ["CONFIRMED", "FAILED"]
    loser = next(r for r in result.values() if r["status"] == "FAILED")
    assert db.get(conn, loser["request_ref"])["registry_status"] == "BLOCKED"
    assert len(payments) == 1
    for tx in calls:  # Soroban calls ride on a channel too, invoked by the admin (DISTRIBUTION)
        inner = tx.transaction
        channel = next(c for c in CHANNELS if c.public_key == inner.source.account_id)
        assert inner.operations[0].source.account_id == DIST.public_key
        assert _signed_by(tx, DIST, channel)


def _function(tx) -> str:
    return tx.transaction.operations[0].host_function.invoke_contract.function_name.sc_symbol.decode()


def _args(tx) -> list[bytes]:
    return [scval.from_bytes(a) for a in tx.transaction.operations[0].host_function.invoke_contract.args]
