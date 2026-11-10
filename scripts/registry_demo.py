"""Show, on Testnet, that the on-chain registry stops a second payout to the same person
in the same batch, even when a human approved it by mistake.

Part 1 runs the real backend pipeline on a throwaway database:
  three requests in one batch, two of them for the same beneficiary. The reviewer approves
  all three (missing the "repeat in batch" flag). Paying: the first and third go through;
  the chain refuses to register the second, so it is never paid.
Part 2 sends the same registration twice back to back (as a buggy retry would): the
  contract accepts the first and rejects the second ON CHAIN, visible on stellar.expert.

  python scripts/registry_demo.py
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
from stellar_sdk import TransactionBuilder, scval  # noqa: E402

from backend.app import config, registry, soroban, stellar_client as sc  # noqa: E402
from backend.app.main import app  # noqa: E402


def part1() -> bool:
    config.DB_PATH = Path(tempfile.mkdtemp()) / "registry_demo.db"
    c = TestClient(app)
    t = int(time.time())
    batch = f"DEMO-{t}"
    b1, b2 = config.public("BEN1"), config.public("BEN2")
    csv = ("request_ref,batch_id,beneficiary_id,wallet,amount,asset,created_at\n"
           f"RD-{t}-1,{batch},BEN-ALICE,{b1},10,AIDUSD,2026-11-09T10:00:00Z\n"
           f"RD-{t}-2,{batch},BEN-ALICE,{b1},10,AIDUSD,2026-11-09T11:00:00Z\n"
           f"RD-{t}-3,{batch},BEN-BOB,{b2},12,AIDUSD,2026-11-09T10:30:00Z\n")
    c.post("/requests/upload", files={"file": ("demo.csv", csv)})
    print(f"Part 1: batch {batch}, BEN-ALICE asks twice, BEN-BOB once")
    for i in (1, 2, 3):
        r = c.get(f"/requests/RD-{t}-{i}").json()
        print(f"  RD-…-{i} {r['beneficiary_id']:9s} flags: {r['flags'] or '-'}")
        c.post(f"/requests/RD-{t}-{i}/approve", json={"reviewer": "demo", "note": "approved all (human error)"})
    print("  reviewer approved all three\n\n  paying (each: register on chain -> pay -> mark paid)...")
    for r in c.post("/payouts/run").json():
        line = f"  {r['request_ref'][-1]}: {r['status']:9s}"
        if r.get("tx_hash"):
            line += f" registry={r.get('registry')}  {sc.explorer_link(r['tx_hash'])}"
        if r.get("error"):
            line += f"  {r['error']}"
        print(line)
    rows = {i: c.get(f"/requests/RD-{t}-{i}").json() for i in (1, 2, 3)}
    rec = c.post("/recon/run").json()
    cats = {r["request_ref"][-1]: (r["category"], r["reasons"]) for r in rec["results"]}
    print(f"\n  reconciliation: 1={cats['1']}, 2={cats['2']}, 3={cats['3']}")
    return (rows[1]["status"] == "CONFIRMED" and rows[1]["registry_status"] == "PAID"
            and rows[2]["status"] == "FAILED" and rows[2]["registry_status"] == "BLOCKED"
            and rows[3]["status"] == "CONFIRMED" and cats["1"][0] == "MATCHED" and cats["3"][0] == "MATCHED")


def part2() -> bool:
    print("\nPart 2: the same registration sent twice back to back")
    dist, cid = sc.distribution_keypair(), registry.contract_id()
    key = registry.key_for("BEN-RACE", f"RACE-{int(time.time())}")
    args = [scval.to_bytes(key), scval.to_bytes(sc.memo_hash("RACE-REQ"))]
    account = sc.rpc().load_account(dist.public_key)
    tx1 = sc.rpc().prepare_transaction(
        TransactionBuilder(account, config.NETWORK_PASSPHRASE, base_fee=config.BASE_FEE)
        .append_invoke_contract_function_op(cid, "register", args).set_timeout(60).build())
    t1 = tx1.transaction
    tx2 = (TransactionBuilder(account, config.NETWORK_PASSPHRASE, base_fee=t1.fee)
           .append_invoke_contract_function_op(cid, "register", args, auth=t1.operations[0].auth)
           .set_soroban_data(t1.soroban_data).set_timeout(60).build())
    tx1.sign(dist)
    tx2.sign(dist)
    s1, h1, _ = soroban.send_and_wait(tx1)
    s2, h2, _ = soroban.send_and_wait(tx2)
    print(f"  1st: {s1:8s} {sc.explorer_link(h1)}")
    print(f"  2nd: {s2:8s} {sc.explorer_link(h2)}   (contract: AlreadyRegistered)")
    registry.release(key)  # tidy up the demo key
    return s1 == "SUCCESS" and s2 == "FAILED"


def main() -> None:
    if not registry.enabled():
        raise SystemExit("registry not configured; run scripts/registry_deploy.py first")
    print(f"registry {registry.contract_id()}\n")
    ok1, ok2 = part1(), part2()
    print(f"\nPart 1 {'PASS' if ok1 else 'FAIL'}, Part 2 {'PASS' if ok2 else 'FAIL'}")
    print(f"contract: {registry.explorer_contract()}")
    sys.exit(0 if ok1 and ok2 else 1)


if __name__ == "__main__":
    main()
