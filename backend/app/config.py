"""Settings. Everything comes from the repo-root .env (written by scripts/testnet_setup.py)."""
from __future__ import annotations

import os
from decimal import Decimal
from pathlib import Path

from dotenv import load_dotenv
from stellar_sdk import Network

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

# Stellar: TESTNET ONLY. The passphrase is hard-coded so a mainnet URL can't sneak in.
HORIZON_URL = os.getenv("HORIZON_URL", "https://horizon-testnet.stellar.org")
RPC_URL = os.getenv("RPC_URL", "https://soroban-testnet.stellar.org")
NETWORK_PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE
ASSET_CODE = os.getenv("ASSET_CODE", "AIDUSD")
BASE_FEE = 100                 # stroops per operation
TX_TIMEOUT_SECONDS = 30        # tx time bounds; after this an unsent tx can never land
RECLAIM_AFTER_SECONDS = int(os.getenv("RECLAIM_AFTER_SECONDS", 30 * 24 * 3600))

# Storage
DB_PATH = Path(os.getenv("AIDFLOW_DB", ROOT / "data" / "aidflow.db"))

# Screening rules
AMOUNT_LIMIT = Decimal(os.getenv("AMOUNT_LIMIT", "500"))
DUPLICATE_WINDOW_HOURS = int(os.getenv("DUPLICATE_WINDOW_HOURS", "24"))


def secret(name: str) -> str:
    value = os.getenv(f"{name}_SECRET")
    if not value:
        raise RuntimeError(f"{name}_SECRET missing in .env. Run scripts/testnet_setup.py first.")
    return value


def public(name: str) -> str:
    value = os.getenv(f"{name}_PUBLIC")
    if not value:
        raise RuntimeError(f"{name}_PUBLIC missing in .env. Run scripts/testnet_setup.py first.")
    return value
