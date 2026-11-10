"""Member A spike, part 2: Claimable Balance edge cases on Testnet.

  Test A  Reclaim window. DISTRIBUTION creates a balance for BEN2 with a short
          window, tries to take it back too early (must fail), waits for the
          window to pass, then takes it back (must succeed).
  Test B  Trustline required. A fresh account without an AIDUSD trustline tries
          to claim a balance (must fail with op_no_trust).

Usage:
  python scripts/spike_reclaim.py              # both tests, 60 s window
  python scripts/spike_reclaim.py --window 120
  python scripts/spike_reclaim.py --only-trustline
"""
from __future__ import annotations

import sys
import time

from stellar_sdk import Asset, Keypair, TransactionBuilder
from stellar_sdk.exceptions import BadRequestError

import spike_payment as sp
import stellar_common as sc


def claim_tx(claimer: Keypair, balance_ids: list[str], add_trustline: Asset | None = None):
    builder = TransactionBuilder(sc.horizon().load_account(claimer.public_key),
                                 sc.NETWORK_PASSPHRASE, base_fee=sc.BASE_FEE)
    if add_trustline:
        builder.append_change_trust_op(asset=add_trustline)
    for bid in balance_ids:
        builder.append_claim_claimable_balance_op(balance_id=bid)
    tx = builder.set_timeout(sc.TX_TIMEOUT_SECONDS).build()
    tx.sign(claimer)
    return tx


def try_submit(tx) -> tuple[bool, list[str] | None]:
    """Submit and return (ok, operation result codes on failure)."""
    try:
        sc.horizon().submit_transaction(tx)
        return True, None
    except BadRequestError as exc:
        codes = (exc.extras or {}).get("result_codes", {})
        return False, codes.get("operations") or [codes.get("transaction")]


def create_balance(dist: Keypair, beneficiary: str, asset: Asset, amount: str,
                   window: int, ref: str) -> str:
    sp.RECLAIM_AFTER = window  # build_claimable_balance reads this module global
    tx = sp.build_claimable_balance(sc.horizon().load_account(dist.public_key), dist,
                                    beneficiary, asset, amount, ref)
    tx_hash, status = sp.submit_safely(tx, ref, "claimable_balance")
    if status != "CONFIRMED":
        raise SystemExit(f"  create failed: {status}")
    # The balance id comes from the create operation's result.
    ops = sc.horizon().operations().for_transaction(tx_hash).call()["_embedded"]["records"]
    effects = sc.horizon().effects().for_operation(ops[0]["id"]).call()["_embedded"]["records"]
    balance_id = next(e["balance_id"] for e in effects if e["type"] == "claimable_balance_created")
    print(f"  created {amount} {asset.code}, balance_id={balance_id[:20]}...")
    print(f"  {sc.explorer_link(tx_hash)}")
    return balance_id


def test_reclaim(dist: Keypair, asset: Asset, window: int) -> bool:
    print(f"\nTest A: reclaim window = {window} s (beneficiary BEN2)")
    bid = create_balance(dist, sc.keypair("BEN2").public_key, asset, "10", window,
                         f"REQ-RECLAIM-{int(time.time())}")

    ok, codes = try_submit(claim_tx(dist, [bid]))
    early_ok = not ok and codes == ["op_cannot_claim"]
    print(f"  early reclaim: {'rejected ' + str(codes) if not ok else 'ACCEPTED (unexpected)'}"
          f"  -> {'PASS' if early_ok else 'FAIL'}")

    wait = window + 10  # relative time counts from the ledger that created the balance
    print(f"  waiting {wait} s for the window to pass...")
    time.sleep(wait)

    tx = claim_tx(dist, [bid])
    ok, codes = try_submit(tx)
    print(f"  late reclaim: {'accepted' if ok else 'rejected ' + str(codes)}"
          f"  -> {'PASS' if ok else 'FAIL'}")
    if ok:
        print(f"  {sc.explorer_link(tx.hash_hex())}")
    return early_ok and ok


def test_trustline(dist: Keypair, asset: Asset) -> bool:
    print("\nTest B: claim without a trustline (fresh account)")
    fresh = Keypair.random()
    sc.fund_with_friendbot(fresh.public_key)
    print(f"  fresh account {fresh.public_key}")
    bid = create_balance(dist, fresh.public_key, asset, "5", 30 * 24 * 3600,
                         f"REQ-NOTRUST-{int(time.time())}")

    ok, codes = try_submit(claim_tx(fresh, [bid]))
    no_trust_ok = not ok and codes == ["op_no_trust"]
    print(f"  claim without trustline: {'rejected ' + str(codes) if not ok else 'ACCEPTED'}"
          f"  -> {'PASS' if no_trust_ok else 'FAIL'}")

    tx = claim_tx(fresh, [bid], add_trustline=asset)
    ok, codes = try_submit(tx)
    print(f"  claim with trustline in same tx: {'accepted' if ok else 'rejected ' + str(codes)}"
          f"  -> {'PASS' if ok else 'FAIL'}")
    return no_trust_ok and ok


def main() -> None:
    window = int(sys.argv[sys.argv.index("--window") + 1]) if "--window" in sys.argv else 60
    dist, asset = sc.keypair("DISTRIBUTION"), sc.aid_asset()
    results = {"trustline": test_trustline(dist, asset)}
    if "--only-trustline" not in sys.argv:
        results["reclaim"] = test_reclaim(dist, asset, window)
    print("\nSummary:", ", ".join(f"{k}={'PASS' if v else 'FAIL'}" for k, v in results.items()))
    sys.exit(0 if all(results.values()) else 1)


if __name__ == "__main__":
    main()
