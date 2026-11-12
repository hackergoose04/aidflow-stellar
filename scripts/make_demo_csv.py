"""Write data/samples/demo_live.csv: a small batch for a live demo with real Testnet payouts.

Unlike requests.csv (random wallets that don't exist on chain), every wallet here is a real,
funded Testnet account, so every link opens on stellar.expert:
  * BEN-ALICE -> BEN1, BEN-BOB -> BEN2: have an AIDUSD trustline  -> plain Payment
  * BEN-CAROL -> a fresh account, funded but WITHOUT the trustline -> Claimable Balance
    (its keys are saved to .env as DEMO_CAROL_*, so `scripts/beneficiary_claim.py` can
    claim it live and the request turns CLAIMED)
  * BEN-ALICE asks twice in the batch -> flagged; if approved anyway, the on-chain
    registry refuses the second payout

  python scripts/make_demo_csv.py                 # BEN-CAROL = a fresh account whose keys we keep
  python scripts/make_demo_csv.py --carol G...    # BEN-CAROL = your own wallet (e.g. Freighter on
                                                  # Testnet), so you claim it yourself on /claim
"""
from __future__ import annotations

import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from stellar_sdk import Keypair  # noqa: E402

from backend.app import config  # noqa: E402

OUT = ROOT / "data" / "samples" / "demo_live.csv"


def set_env(key: str, value: str) -> None:
    path = config.ROOT / ".env"
    lines = [ln for ln in path.read_text().splitlines() if not ln.startswith(f"{key}=")]
    lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n")
    os.environ[key] = value


def fresh_carol() -> str:
    """A new Testnet account with XLM but no AIDUSD trustline; keys kept in .env."""
    kp = Keypair.random()
    r = requests.get("https://friendbot.stellar.org", params={"addr": kp.public_key}, timeout=30)
    r.raise_for_status()
    set_env("DEMO_CAROL_PUBLIC", kp.public_key)
    set_env("DEMO_CAROL_SECRET", kp.secret)
    return kp.public_key


def main() -> None:
    t = int(time.time())
    batch = f"LIVE-{datetime.now(timezone.utc):%Y%m%d-%H%M}"
    now = datetime.now(timezone.utc).replace(microsecond=0)
    own = sys.argv[sys.argv.index("--carol") + 1] if "--carol" in sys.argv else None
    b1, b2, carol = config.public("BEN1"), config.public("BEN2"), own or fresh_carol()
    rows = [
        (f"LIVE-{t}-1", "BEN-ALICE", b1, "20", now),
        (f"LIVE-{t}-2", "BEN-BOB", b2, "35", now + timedelta(minutes=3)),
        (f"LIVE-{t}-3", "BEN-CAROL", carol, "15", now + timedelta(minutes=6)),
        (f"LIVE-{t}-4", "BEN-ALICE", b1, "20", now + timedelta(minutes=9)),  # same person again
    ]
    lines = ["request_ref,batch_id,beneficiary_id,wallet,amount,asset,created_at"]
    lines += [f"{r},{batch},{b},{w},{a},AIDUSD,{c.isoformat()}" for r, b, w, a, c in rows]
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)}: batch {batch}, 4 requests (BEN-ALICE twice)")
    if own:
        print(f"BEN-CAROL is your wallet {carol}: after paying, open http://localhost:3000/claim and claim it there")
    else:
        print(f"BEN-CAROL is a new funded account without a trustline: "
              f"https://stellar.expert/explorer/testnet/account/{carol}")
        print("after paying, let her claim:  python scripts/beneficiary_claim.py")


if __name__ == "__main__":
    main()
