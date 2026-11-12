"""Play the beneficiary: BEN-CAROL (from make_demo_csv.py) claims her claimable balances.

She adds the AIDUSD trustline (if missing) and claims everything waiting for her, in one
transaction. Then click "Verify & check claims" in the app: the request turns CLAIMED.

  python scripts/beneficiary_claim.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from stellar_sdk import Keypair, TransactionBuilder  # noqa: E402

from backend.app import config, stellar_client as sc  # noqa: E402


def main() -> None:
    carol = Keypair.from_secret(config.secret("DEMO_CAROL"))
    asset = sc.aid_asset()
    server = sc.horizon()
    waiting = server.claimable_balances().for_claimant(carol.public_key).call()["_embedded"]["records"]
    waiting = [b for b in waiting if b["asset"] == f"{asset.code}:{asset.issuer}"]
    if not waiting:
        raise SystemExit("nothing waiting for BEN-CAROL: pay the demo batch first")

    builder = TransactionBuilder(server.load_account(carol.public_key), config.NETWORK_PASSPHRASE,
                                 base_fee=config.BASE_FEE)
    if not sc.has_trustline(carol.public_key, asset):
        builder.append_change_trust_op(asset=asset)  # required, else op_no_trust
    for b in waiting:
        builder.append_claim_claimable_balance_op(balance_id=b["id"])
    tx = builder.set_timeout(30).build()
    tx.sign(carol)
    server.submit_transaction(tx)
    total = sum(float(b["amount"]) for b in waiting)
    print(f"BEN-CAROL claimed {len(waiting)} balance(s), {total:g} {asset.code}: {sc.explorer_link(tx.hash_hex())}")
    print("Now click 'Verify & check claims' on the Payouts page: the request becomes CLAIMED.")


if __name__ == "__main__":
    main()
