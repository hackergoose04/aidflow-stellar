"""Member A research spike: the two delivery methods + verification by hash.

  Step 1  Payment to BEN1 (has a trustline), memo = SHA-256(request_ref)
  Step 2  Claimable Balance to BEN3 (no trustline). BEN3 can claim within
          RECLAIM_AFTER seconds; after that, DISTRIBUTION can take it back.
  Step 3  (--claim) BEN3 adds a trustline and claims the balance.

Safety pattern used for every payout (from the design doc):
  build + sign -> RECORD the tx hash -> submit -> on timeout mark UNKNOWN
  and verify by hash. Never resubmit while the tx could still land.

Usage:
  python scripts/spike_payment.py              # steps 1-2 on Testnet
  python scripts/spike_payment.py --claim      # also step 3
  python scripts/spike_payment.py --dry-run    # build/sign offline, no network
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime, timezone

from stellar_sdk import Account, Asset, Claimant, ClaimPredicate, Keypair, TransactionBuilder
from stellar_sdk.exceptions import BadRequestError, BaseHorizonError, ConnectionError

import stellar_common as sc

RECLAIM_AFTER = 30 * 24 * 3600  # 30 days; shorten to e.g. 120 to test reclaim
LEDGER_FILE = sc.ROOT / "data" / "spike_ledger.jsonl"


# ---------- transaction builders (pure: no network) ----------

def build_payment(source: Account, signer: Keypair, dest: str, asset: Asset,
                  amount: str, request_ref: str):
    tx = (
        TransactionBuilder(source, sc.NETWORK_PASSPHRASE, base_fee=sc.BASE_FEE)
        .append_payment_op(destination=dest, asset=asset, amount=amount)
        .add_hash_memo(sc.memo_hash_for(request_ref))
        .set_timeout(sc.TX_TIMEOUT_SECONDS)
        .build()
    )
    tx.sign(signer)
    return tx


def build_claimable_balance(source: Account, signer: Keypair, beneficiary: str,
                            asset: Asset, amount: str, request_ref: str):
    window = ClaimPredicate.predicate_before_relative_time(RECLAIM_AFTER)
    claimants = [
        Claimant(destination=beneficiary, predicate=window),  # claim within window
        Claimant(destination=signer.public_key,                # reclaim after window
                 predicate=ClaimPredicate.predicate_not(window)),
    ]
    tx = (
        TransactionBuilder(source, sc.NETWORK_PASSPHRASE, base_fee=sc.BASE_FEE)
        .append_create_claimable_balance_op(asset=asset, amount=amount, claimants=claimants)
        .add_hash_memo(sc.memo_hash_for(request_ref))
        .set_timeout(sc.TX_TIMEOUT_SECONDS)
        .build()
    )
    tx.sign(signer)
    return tx


# ---------- submit with the "record first" safety pattern ----------

def record(event: dict) -> None:
    LEDGER_FILE.parent.mkdir(parents=True, exist_ok=True)
    event["at"] = datetime.now(timezone.utc).isoformat()
    with LEDGER_FILE.open("a") as f:
        f.write(json.dumps(event) + "\n")


def submit_safely(tx, request_ref: str, op_type: str) -> tuple[str, str]:
    tx_hash = tx.hash_hex()
    record({"request_ref": request_ref, "op_type": op_type, "tx_hash": tx_hash,
            "status": "SUBMITTED"})  # hash is stored BEFORE we submit
    try:
        resp = sc.horizon().submit_transaction(tx)
        status = "CONFIRMED" if resp.get("successful") else "FAILED"
    except BadRequestError as exc:
        codes = exc.extras.get("result_codes") if exc.extras else None
        print(f"  rejected: {codes}")
        status = "FAILED"
    except (ConnectionError, BaseHorizonError) as exc:
        # Timeout / 504: the tx may still land. Do NOT resubmit; verify by hash.
        print(f"  submit unclear ({type(exc).__name__}); verifying by hash...")
        result = sc.verify_transaction(tx_hash, wait_seconds=sc.TX_TIMEOUT_SECONDS + 10)
        status = {"SUCCESS": "CONFIRMED", "FAILED": "FAILED"}.get(result, "UNKNOWN")
    record({"request_ref": request_ref, "tx_hash": tx_hash, "status": status})
    return tx_hash, status


# ---------- steps ----------

def step_payment(dist: Keypair, asset: Asset) -> None:
    print("\nStep 1: Payment 50 AIDUSD -> BEN1")
    ref = f"REQ-PAY-{int(time.time())}"
    tx = build_payment(sc.horizon().load_account(dist.public_key), dist,
                       sc.keypair("BEN1").public_key, asset, "50", ref)
    tx_hash, status = submit_safely(tx, ref, "payment")
    rpc_status = sc.verify_transaction(tx_hash, wait_seconds=10)
    print(f"  request_ref={ref}\n  submit={status}  rpc getTransaction={rpc_status}")
    print(f"  memo (hex) = {sc.memo_hash_for(ref).hex()}")
    print(f"  {sc.explorer_link(tx_hash)}")


def step_claimable(dist: Keypair, asset: Asset) -> None:
    print("\nStep 2: Claimable Balance 40 AIDUSD -> BEN3 (no trustline)")
    ben3 = sc.keypair("BEN3").public_key
    ref = f"REQ-CB-{int(time.time())}"
    tx = build_claimable_balance(sc.horizon().load_account(dist.public_key), dist,
                                 ben3, asset, "40", ref)
    tx_hash, status = submit_safely(tx, ref, "claimable_balance")
    print(f"  request_ref={ref}  status={status}")
    balances = sc.horizon().claimable_balances().for_claimant(ben3).call()["_embedded"]["records"]
    for b in balances:
        print(f"  balance_id={b['id']}  amount={b['amount']}  asset={b['asset']}")
    print(f"  {sc.explorer_link(tx_hash)}")


def step_claim(asset: Asset) -> None:
    print("\nStep 3: BEN3 adds a trustline, then claims")
    ben3 = sc.keypair("BEN3")
    server = sc.horizon()
    records = server.claimable_balances().for_claimant(ben3.public_key).call()["_embedded"]["records"]
    if not records:
        print("  nothing to claim")
        return
    builder = TransactionBuilder(server.load_account(ben3.public_key), sc.NETWORK_PASSPHRASE,
                                 base_fee=sc.BASE_FEE)
    builder.append_change_trust_op(asset=asset)  # required, else op_no_trust
    for b in records:
        builder.append_claim_claimable_balance_op(balance_id=b["id"])
    tx = builder.set_timeout(sc.TX_TIMEOUT_SECONDS).build()
    tx.sign(ben3)
    server.submit_transaction(tx)
    print(f"  claimed {len(records)} balance(s): {sc.explorer_link(tx.hash_hex())}")


def dry_run() -> None:
    """Build and sign both tx types offline with throwaway keys."""
    print("Dry run (offline): building and signing transactions only")
    issuer, dist, ben = Keypair.random(), Keypair.random(), Keypair.random()
    asset = Asset(sc.ASSET_CODE, issuer.public_key)
    acct = Account(dist.public_key, sequence=1)
    p = build_payment(acct, dist, ben.public_key, asset, "50", "REQ-001")
    c = build_claimable_balance(Account(dist.public_key, sequence=2), dist,
                                ben.public_key, asset, "40", "REQ-002")
    for name, tx in [("payment", p), ("claimable_balance", c)]:
        env = tx.to_xdr()
        t = tx.transaction
        print(f"  {name}: hash={tx.hash_hex()[:16]}... ops={len(t.operations)} "
              f"memo={type(t.memo).__name__} max_time={t.preconditions.time_bounds.max_time} "
              f"sigs={len(tx.signatures)} xdr_len={len(env)}")
    preds = [cl.predicate.claim_predicate_type.name for cl in c.transaction.operations[0].claimants]
    print(f"  claimant predicates: {preds}")
    print("Dry run OK")


def main() -> None:
    if "--dry-run" in sys.argv:
        dry_run()
        return
    dist, asset = sc.keypair("DISTRIBUTION"), sc.aid_asset()
    step_payment(dist, asset)
    step_claimable(dist, asset)
    if "--claim" in sys.argv:
        step_claim(asset)
    print(f"\nLocal ledger: {LEDGER_FILE}")


if __name__ == "__main__":
    main()
