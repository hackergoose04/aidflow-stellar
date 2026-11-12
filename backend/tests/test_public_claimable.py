"""/public/claimable: only this wallet's unclaimed claimable balances, with no personal data."""
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from backend.app import config
from backend.app.main import app

T0 = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc).isoformat()
W1, W2 = "G" + "A" * 55, "G" + "B" * 55


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "t.db")
    return TestClient(app)


def _seed():
    from backend.app import db
    conn = db.connect()
    rows = [  # ref, wallet, status, method, claim_status, balance_id
        ("R1", W1, "CONFIRMED", "claimable_balance", "UNCLAIMED", "00ab"),
        ("R2", W1, "CLAIMED", "claimable_balance", "CLAIMED", "00cd"),      # already claimed
        ("R3", W1, "CONFIRMED", "payment", None, None),                    # direct payment
        ("R4", W2, "CONFIRMED", "claimable_balance", "UNCLAIMED", "00ef"),  # someone else's
    ]
    for ref, w, st, m, cs, bid in rows:
        conn.execute(
            "INSERT INTO requests (request_ref, batch_id, beneficiary_id, wallet, amount, asset, created_at, status,"
            " method, claim_status, balance_id, tx_hash, submitted_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (ref, "B1", "H-secret", w, "15.0000000", "AIDUSD", T0, st, m, cs, bid, "ab" * 32, T0, T0))
    conn.commit()
    conn.close()


def test_only_this_wallets_unclaimed_balances(client):
    _seed()
    out = client.get(f"/public/claimable?wallet={W1}").json()
    assert [o["request_ref"] for o in out] == ["R1"]
    assert out[0]["balance_id"] == "00ab" and out[0]["amount"] == "15.0000000"
    assert "beneficiary_id" not in out[0] and "wallet" not in out[0]
    assert client.get(f"/public/claimable?wallet={'G' + 'C' * 55}").json() == []
