"""Show the CONFIRMED -> CLAIMED step on Testnet.

A brand-new beneficiary account (no AIDUSD trustline) is paid through the real backend, so
the money goes out as a claimable balance (CONFIRMED, claim_status UNCLAIMED). The
beneficiary then adds the trustline and claims it, and /payouts/claims sees that the money
reached them: CLAIMED.

  python scripts/claim_demo.py
"""
from __future__ import annotations

import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
from stellar_sdk import Keypair, TransactionBuilder  # noqa: E402

from backend.app import config, stellar_client as sc  # noqa: E402
from backend.app.main import app  # noqa: E402


def main() -> None:
    config.DB_PATH = Path(tempfile.mkdtemp()) / "claim_demo.db"
    c = TestClient(app)
    ben = Keypair.random()
    import requests
    requests.get("https://friendbot.stellar.org", params={"addr": ben.public_key}, timeout=30)
    t = int(time.time())
    ref = f"CLAIM-{t}"
    now = datetime.now(timezone.utc).isoformat()
    c.post("/requests/upload", files={"file": ("c.csv",
        "request_ref,batch_id,beneficiary_id,wallet,amount,asset,created_at\n"
        f"{ref},CLAIM-{t},BEN-DANA,{ben.public_key},8,AIDUSD,{now}\n")})
    c.post(f"/requests/{ref}/approve", json={"reviewer": "demo"})
    paid = c.post("/payouts/run").json()[0]
    print(f"1. paid as {paid['method']}: {paid['status']}  {paid.get('explorer')}")
    print(f"   claim status: {c.get(f'/requests/{ref}').json()['claim_status']}")

    print(f"2. checking claims before the beneficiary acts: {c.post('/payouts/claims').json()}")

    asset = sc.aid_asset()
    server = sc.horizon()
    balance_id = c.get(f"/requests/{ref}").json()["balance_id"]
    tx = (TransactionBuilder(server.load_account(ben.public_key), config.NETWORK_PASSPHRASE,
                             base_fee=config.BASE_FEE)
          .append_change_trust_op(asset=asset)
          .append_claim_claimable_balance_op(balance_id=balance_id)
          .set_timeout(30).build())
    tx.sign(ben)
    server.submit_transaction(tx)
    print(f"3. beneficiary added the trustline and claimed: {sc.explorer_link(tx.hash_hex())}")

    for _ in range(10):
        res = c.post("/payouts/claims").json()
        if res and res[0]["claim_status"] == "CLAIMED":
            break
        time.sleep(2)
    row = c.get(f"/requests/{ref}").json()
    print(f"4. after checking claims: status {row['status']}, claim {row['claim_status']} at {row['claimed_at']}")
    ok = row["status"] == "CLAIMED"
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
