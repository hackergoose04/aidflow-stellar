"""Offline tests: ingest, dedup, screening (rules + ML) and review on the shared sample CSV.
No network needed.  Run from the repo root:  pytest backend/tests"""
from __future__ import annotations

import csv
import hmac
import sqlite3
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from stellar_sdk import Account, Keypair, scval

from backend.app import config, registry, stellar_client as sc
from backend.app.main import app
from backend.app.services import screening

SAMPLE = config.ROOT / "data" / "samples" / "requests.csv"
LABELS = config.ROOT / "data" / "samples" / "requests_labels.csv"
REJECTED_AT_INGEST = {"duplicate_ref", "invalid_wallet", "invalid_amount"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setenv("PII_HMAC_SECRET", "test-secret")
    return TestClient(app)


def upload(client, text=None):
    data = text if text is not None else SAMPLE.read_text()
    return client.post("/requests/upload", files={"file": ("r.csv", data, "text/csv")})


def labels() -> list[tuple[str, str]]:
    with LABELS.open() as f:
        return [(r["request_ref"], r["label"]) for r in csv.DictReader(f)]


def test_every_planted_problem_is_caught(client):
    report = upload(client).json()
    rejected = {r["request_ref"]: r["reasons"] for r in report["rejected"]}
    rows = {r["request_ref"]: r for r in client.get("/requests").json()}

    missed = []
    for ref, label in labels():
        if label in REJECTED_AT_INGEST:
            ok = label in rejected.get(ref, [])
            if label != "duplicate_ref":  # bad records are kept as INVALID for correction
                ok = ok and rows[ref]["status"] == "INVALID"
        else:
            ok = bool(rows[ref]["flags"])
        if not ok:
            missed.append((ref, label))
    assert not missed, f"not caught: {missed}"


def test_few_false_alarms_on_normal_rows(client):
    upload(client)
    planted = {ref for ref, _ in labels()}
    normal = [r for r in client.get("/requests").json()
              if r["request_ref"] not in planted and r["status"] != "INVALID"]
    flagged = [r for r in normal if r["flags"]]
    assert len(flagged) / len(normal) < 0.15, [(r["request_ref"], r["flags"]) for r in flagged]


def test_risk_scores_are_set(client):
    upload(client)
    scores = [r["risk_score"] for r in client.get("/requests").json() if r["status"] != "INVALID"]
    assert all(s is not None and 0 <= s <= 1 for s in scores)


def test_reupload_is_rejected_not_overwritten(client):
    first = upload(client).json()
    second = upload(client).json()
    assert second["accepted"] == 0
    assert len(second["rejected"]) == second["received"]
    assert client.get("/summary").json()["by_status"]["PENDING_REVIEW"] == first["accepted"]


def test_missing_column_is_400(client):
    assert upload(client, text="request_ref,amount\nREQ-1,5\n").status_code == 400


def test_review_flow(client):
    upload(client)
    flagged_before = client.get("/summary").json()["pending_flagged"]
    approved = client.post("/review/approve-clean", json={"reviewer": "alice"}).json()["approved"]
    s = client.get("/summary").json()
    assert s["by_status"]["APPROVED"] == approved
    assert s["by_status"]["PENDING_REVIEW"] == flagged_before  # flagged ones wait for a human

    ref = client.get("/requests?flagged=true").json()[0]["request_ref"]
    r = client.post(f"/requests/{ref}/reject", json={"reviewer": "alice", "note": "dup"})
    assert r.json()["status"] == "REJECTED"
    assert client.post(f"/requests/{ref}/approve", json={"reviewer": "bob"}).status_code == 409
    kinds = [e["kind"] for e in client.get(f"/requests/{ref}").json()["events"]]
    assert "rejected" in kinds


def test_hold_then_decide(client):
    upload(client)
    ref = client.get("/requests?flagged=true").json()[0]["request_ref"]
    r = client.post(f"/requests/{ref}/hold", json={"reviewer": "alice", "note": "call beneficiary"})
    assert r.json()["status"] == "HELD"
    # Held requests are not swept up by bulk approval.
    client.post("/review/approve-clean", json={"reviewer": "alice"})
    assert client.get(f"/requests/{ref}").json()["status"] == "HELD"
    assert client.post(f"/requests/{ref}/approve", json={"reviewer": "alice"}).json()["status"] == "APPROVED"


def test_correct_revalidates_and_rescreens(client):
    upload(client)
    row = next(r for r in client.get("/requests").json() if any(f.startswith("ml_high_risk") or f.startswith("amount_above") for f in r["flags"]))
    ref = row["request_ref"]
    bad = client.post(f"/requests/{ref}/correct", json={"reviewer": "alice", "wallet": "GNOPE"})
    assert bad.status_code == 409 and "invalid_wallet" in bad.json()["detail"]
    fixed = client.post(f"/requests/{ref}/correct", json={"reviewer": "alice", "amount": "50", "note": "typo"}).json()
    assert fixed["amount"] == "50.0000000" and fixed["status"] == "PENDING_REVIEW"
    events = client.get(f"/requests/{ref}").json()["events"]
    assert any(e["kind"] == "corrected" and row["amount"] in e["detail"] for e in events)


def test_same_batch_rule_and_default_batch(client):
    w = "GD7VYKVYMV4MVDXDO3KAQQXFSVFLA35RTCZXX3R5WOZHI27AOQIPEANY"
    csv_text = ("request_ref,batch_id,beneficiary_id,wallet,amount,asset,created_at\n"
                f"B-1,BATCH-X,BEN-1,{w},50,AIDUSD,2026-11-01T10:00:00Z\n"
                f"B-2,BATCH-X,BEN-1,{w},40,AIDUSD,2026-11-03T10:00:00Z\n"
                f"B-3,,BEN-2,{w},40,AIDUSD,2026-11-03T10:00:00Z\n")
    upload(client, text=csv_text)
    assert "same_batch_as:B-1" in client.get("/requests/B-2").json()["flags"]
    assert not any(f.startswith("same_batch") for f in client.get("/requests/B-1").json()["flags"])
    # No batch_id given: the upload becomes its own batch.
    assert client.get("/requests/B-3").json()["batch_id"].startswith("UPLOAD-")


def test_approved_slots_pay_separately_but_cannot_pay_twice(client, monkeypatch):
    monkeypatch.setattr(config, "PAYOUT_SLOTS", {"base", "medical_supplement"})
    monkeypatch.setattr(screening.ml, "score_frame", lambda _: None)
    monkeypatch.setenv("DISTRIBUTION_SECRET", Keypair.random().secret)
    monkeypatch.setenv("ISSUER_PUBLIC", Keypair.random().public_key)
    monkeypatch.setenv("REGISTRY_CONTRACT_ID", "test-registry")
    monkeypatch.setenv("REGISTRY_SECRET", "test-registry-secret")
    wallet = Keypair.random().public_key
    csv_text = (
        "request_ref,batch_id,payout_slot,beneficiary_id,wallet,amount,asset,created_at\n"
        f"R-1,BATCH-X,,BEN-1,{wallet},50,AIDUSD,2026-11-01T10:00:00Z\n"
        f"R-2,BATCH-X,medical_supplement,BEN-1,{wallet},20,AIDUSD,2026-11-01T11:00:00Z\n"
        f"R-3,BATCH-X, Medical_Supplement ,BEN-1,{wallet},20,AIDUSD,2026-11-01T12:00:00Z\n"
    )
    assert upload(client, csv_text).json()["accepted"] == 3
    assert client.get("/requests/R-1").json()["payout_slot"] == "base"
    assert client.get("/requests/R-2").json()["flags"] == ["additional_payout:medical_supplement"]
    assert "same_batch_as:R-2" in client.get("/requests/R-3").json()["flags"]
    assert client.post("/review/approve-clean", json={"reviewer": "alice"}).json()["request_refs"] == ["R-1"]
    for ref in ("R-2", "R-3"):
        assert client.post(f"/requests/{ref}/approve", json={"reviewer": "alice"}).status_code == 200

    # Replace network I/O while exercising the real registry client and payout executor.
    entries, payments = {}, []

    def call(function, raw_key, raw_value):
        key, value = scval.from_bytes(raw_key), scval.from_bytes(raw_value)
        if function == "register":
            assert key not in entries
            entries[key] = {"request_hash": value, "status": "Reserved"}
        else:
            assert function == "mark_paid"
            entries[key].update(status="Paid", tx_hash=value.hex())
        return "a" * 64

    def submit(tx):
        payments.append(tx.hash_hex())
        return "CONFIRMED", None

    monkeypatch.setattr(registry, "get", entries.get)
    monkeypatch.setattr(registry, "_call", call)
    monkeypatch.setattr(sc, "has_trustline", lambda *_: True)
    monkeypatch.setattr(sc, "horizon", lambda: SimpleNamespace(
        load_account=lambda key: Account(key, len(payments))))
    monkeypatch.setattr(sc, "submit", submit)
    result = client.post("/payouts/run").json()
    assert {r["request_ref"]: r["status"] for r in result} == {
        "R-1": "CONFIRMED", "R-2": "CONFIRMED", "R-3": "FAILED",
    }
    assert len(entries) == len(payments) == 2
    base, supplement, repeated = (client.get(f"/requests/{ref}").json()
                                  for ref in ("R-1", "R-2", "R-3"))
    assert base["registry_key"] != supplement["registry_key"] == repeated["registry_key"]
    assert repeated["registry_status"] == "BLOCKED" and repeated["tx_hash"] is None


def test_payout_slot_migration_preserves_old_registry_key(client, monkeypatch):
    monkeypatch.setenv("PROGRAM_ID", "PROGRAM")
    monkeypatch.setenv("REGISTRY_SECRET", "secret")
    wallet = Keypair.random().public_key
    upload(client, "request_ref,batch_id,beneficiary_id,wallet,amount,asset,created_at\n"
                   f"OLD,BATCH-X,BEN-1,{wallet},50,AIDUSD,2026-11-01T10:00:00Z\n")
    beneficiary = client.get("/requests/OLD").json()["beneficiary_id"]
    legacy_key = hmac.digest(b"secret", f"PROGRAM|BATCH-X|{beneficiary}".encode(), "sha256")
    with sqlite3.connect(config.DB_PATH) as conn:
        conn.execute("UPDATE requests SET registry_key = ?, registry_status = 'PAID' WHERE request_ref = 'OLD'",
                     (legacy_key.hex(),))
        conn.execute("ALTER TABLE requests DROP COLUMN payout_slot")
    row = client.get("/requests/OLD").json()
    assert row["registry_status"] == "PAID" and row["registry_key"] == legacy_key.hex()
    assert row["payout_slot"] == "base"
    assert registry.key_for(beneficiary, "BATCH-X", row["payout_slot"]) == legacy_key


def test_unknown_slots_are_rejected_and_extra_slots_require_registry(client, monkeypatch):
    monkeypatch.setattr(config, "PAYOUT_SLOTS", {"base", "medical_supplement"})
    wallet = Keypair.random().public_key
    report = upload(client, "request_ref,batch_id,payout_slot,beneficiary_id,wallet,amount,asset,created_at\n"
                            f"R-1,BATCH-X,arbitrary,BEN-1,{wallet},20,AIDUSD,2026-11-01T10:00:00Z\n").json()
    assert report["rejected"][0]["reasons"] == ["unsupported_payout_slot"]
    row = client.post("/requests/R-1/correct", json={
        "reviewer": "alice", "payout_slot": "medical_supplement",
    }).json()
    assert row["payout_slot"] == "medical_supplement" and row["status"] == "PENDING_REVIEW"
    assert "additional_payout:medical_supplement" in row["flags"]
    assert client.post("/requests/R-1/approve", json={"reviewer": "alice"}).status_code == 200

    monkeypatch.delenv("REGISTRY_CONTRACT_ID", raising=False)
    monkeypatch.setenv("DISTRIBUTION_SECRET", Keypair.random().secret)
    monkeypatch.setenv("ISSUER_PUBLIC", Keypair.random().public_key)
    monkeypatch.setattr(sc, "horizon", lambda: None)
    result = client.post("/payouts/run").json()
    assert result == [{"request_ref": "R-1", "status": "APPROVED",
                       "error": "On-chain registry must be configured for this payout"}]
    assert client.get("/requests/R-1").json()["tx_hash"] is None


def test_beneficiary_ids_are_never_stored_raw(client):
    w = "GD7VYKVYMV4MVDXDO3KAQQXFSVFLA35RTCZXX3R5WOZHI27AOQIPEANY"
    upload(client, text="request_ref,beneficiary_id,wallet,amount,asset,created_at\n"
                        f"P-1,Maria Lopez 1985,{w},50,AIDUSD,2026-11-01T10:00:00Z\n")
    stored = client.get("/requests/P-1").json()["beneficiary_id"]
    assert stored.startswith("H-") and "Maria" not in stored
    raw = __import__("sqlite3").connect(config.DB_PATH)
    dump = [str(tuple(r)) for t in ("requests", "events") for r in raw.execute(f"SELECT * FROM {t}")]
    assert not any("Maria" in line for line in dump)  # not in any table, not in the audit log
    # Staff who know the real ID can still find the person.
    assert client.get("/beneficiaries/lookup", params={"id": "Maria Lopez 1985"}).json()["token"] == stored


def test_invalid_record_can_be_corrected(client):
    upload(client, text="request_ref,beneficiary_id,wallet,amount,asset,created_at\n"
                        "I-1,BEN-9,GNOPE,50,AIDUSD,2026-11-01T10:00:00Z\n")
    r = client.get("/requests/I-1").json()
    assert r["status"] == "INVALID" and r["flags"] == ["invalid:invalid_wallet"]
    assert client.post("/requests/I-1/approve", json={"reviewer": "a"}).status_code == 409
    fixed = client.post("/requests/I-1/correct", json={
        "reviewer": "a", "wallet": "GD7VYKVYMV4MVDXDO3KAQQXFSVFLA35RTCZXX3R5WOZHI27AOQIPEANY"}).json()
    assert fixed["status"] == "PENDING_REVIEW"
    assert not any(f.startswith("invalid") for f in fixed["flags"])


def test_reupload_replaces_an_invalid_record(client):
    head = "request_ref,beneficiary_id,wallet,amount,asset,created_at\n"
    upload(client, text=head + "I-2,BEN-9,GD7VYKVYMV4MVDXDO3KAQQXFSVFLA35RTCZXX3R5WOZHI27AOQIPEANY,-5,AIDUSD,2026-11-01T10:00:00Z\n")
    assert client.get("/requests/I-2").json()["status"] == "INVALID"
    rep = upload(client, text=head + "I-2,BEN-9,GD7VYKVYMV4MVDXDO3KAQQXFSVFLA35RTCZXX3R5WOZHI27AOQIPEANY,5,AIDUSD,2026-11-01T10:00:00Z\n").json()
    assert rep["accepted"] == 1 and client.get("/requests/I-2").json()["status"] == "PENDING_REVIEW"


def test_public_api_shows_no_personal_data(client):
    upload(client)
    ref = client.get("/requests").json()[0]["request_ref"]
    p = client.get(f"/public/payments/{ref}").json()
    for secret_field in ("beneficiary_id", "wallet", "flags", "risk_score", "reviewer", "note"):
        assert secret_field not in p
    assert p["status"] in ("Under review", "Not paid") and len(p["memo_hash"]) == 64
    batch = client.get(f"/public/batches/{p['batch_id']}").json()
    assert all("wallet" not in x and "beneficiary_id" not in x for x in batch)


def test_decisions_need_a_named_reviewer(client):
    upload(client)
    ref = client.get("/requests?status=PENDING_REVIEW").json()[0]["request_ref"]
    assert client.post(f"/requests/{ref}/approve", json={"reviewer": "  "}).status_code == 422
    assert client.post(f"/requests/{ref}/approve", json={"reviewer": "ana"}).status_code == 200


def test_unchanged_correction_is_refused(client):
    """The form sends "150" for a stored "150.0000000": that is not a change."""
    upload(client)
    row = client.get("/requests?status=PENDING_REVIEW").json()[0]
    body = {"reviewer": "ana", "amount": str(float(row["amount"])), "wallet": row["wallet"], "created_at": row["created_at"]}
    res = client.post(f"/requests/{row['request_ref']}/correct", json=body)
    assert res.status_code == 409 and "nothing to change" in res.json()["detail"]
    assert client.get(f"/requests/{row['request_ref']}").json()["flags"] == row["flags"]  # not re-screened


def test_reupload_logs_duplicate_not_rejection(client):
    upload(client)
    upload(client)
    kinds = [e["kind"] for e in client.get("/requests/REQ-0001").json()["events"]]
    assert "duplicate_upload" in kinds and "rejected_at_upload" not in kinds
