"""Write data/samples/demo_live.csv: a small batch for a live demo with real Testnet payouts.

Unlike requests.csv (random wallets that don't exist on chain), these wallets are your own
Testnet accounts from .env, so payments land and show up on stellar.expert:
  * BEN1, BEN2 have an AIDUSD trustline  -> plain Payment
  * a brand-new address                  -> Claimable Balance
  * BEN-ALICE asks twice in the batch     -> flagged; if approved anyway, the on-chain
                                             registry refuses the second payout

  python scripts/make_demo_csv.py
"""
from __future__ import annotations

import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from stellar_sdk import Keypair  # noqa: E402

from backend.app import config  # noqa: E402

OUT = ROOT / "data" / "samples" / "demo_live.csv"


def main() -> None:
    t = int(time.time())
    batch = f"LIVE-{datetime.now(timezone.utc):%Y%m%d-%H%M}"
    now = datetime.now(timezone.utc).replace(microsecond=0)
    b1, b2, new = config.public("BEN1"), config.public("BEN2"), Keypair.random().public_key
    rows = [
        (f"LIVE-{t}-1", "BEN-ALICE", b1, "20", now),
        (f"LIVE-{t}-2", "BEN-BOB", b2, "35", now + timedelta(minutes=3)),
        (f"LIVE-{t}-3", "BEN-CAROL", new, "15", now + timedelta(minutes=6)),
        (f"LIVE-{t}-4", "BEN-ALICE", b1, "20", now + timedelta(minutes=9)),  # same person again
    ]
    lines = ["request_ref,batch_id,beneficiary_id,wallet,amount,asset,created_at"]
    lines += [f"{r},{batch},{b},{w},{a},AIDUSD,{c.isoformat()}" for r, b, w, a, c in rows]
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: batch {batch}, 4 requests (BEN-ALICE twice)")


if __name__ == "__main__":
    main()
