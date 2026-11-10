"""Offline tests: ingest, dedup, screening (rules + ML) and review on the shared sample CSV.
No network needed.  Run from the repo root:  pytest backend/tests"""
from __future__ import annotations

import csv

import pytest
from fastapi.testclient import TestClient

from backend.app import config
from backend.app.main import app

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
