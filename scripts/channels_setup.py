"""Create channel accounts so the backend can send payouts side by side (TESTNET ONLY).

Stellar takes about one transaction per source account per ledger (~5 s), and each payout is
three transactions, so with only DISTRIBUTION the backend pays one request every ~15 s. A
channel account is the source of a transaction and pays its fee; the payment and registry
operations inside stay sourced from DISTRIBUTION. K channels -> K payouts at once.

Channels hold only XLM for fees (Friendbot), no trustline, no AIDUSD. Keys go to .env as
CHANNEL_SECRETS (comma-separated); set the same value on the deployed API to use them there.

Usage:
  python scripts/channels_setup.py            # 10 channels, keeping any already in .env
  python scripts/channels_setup.py --count 20
"""
from __future__ import annotations

import argparse

from stellar_sdk import Keypair

import stellar_common as sc


def write_channels(secrets: list[str]) -> None:
    """Set CHANNEL_SECRETS in .env, keeping every other line as it is."""
    lines = sc.ENV_PATH.read_text().splitlines() if sc.ENV_PATH.exists() else []
    lines = [line for line in lines if not line.startswith("CHANNEL_SECRETS=")]
    lines.append(f"CHANNEL_SECRETS={','.join(secrets)}")
    sc.ENV_PATH.write_text("\n".join(lines) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--count", type=int, default=10, help="number of channel accounts (default 10)")
    count = parser.parse_args().count

    existing = [s.strip() for s in sc.os.getenv("CHANNEL_SECRETS", "").split(",") if s.strip()]
    keys = [Keypair.from_secret(s) for s in existing[:count]]
    keys += [Keypair.random() for _ in range(count - len(keys))]

    print(f"Funding {count} channel accounts with Friendbot...")
    for i, kp in enumerate(keys, 1):
        sc.fund_with_friendbot(kp.public_key)  # no-op for accounts that already exist
        print(f"  CH{i:<3d} {kp.public_key}")
    write_channels([kp.secret for kp in keys])
    print(f"\nCHANNEL_SECRETS saved to {sc.ENV_PATH}. Restart the backend; payouts now run {count} at a time.")


if __name__ == "__main__":
    main()
