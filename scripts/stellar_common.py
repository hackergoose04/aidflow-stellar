"""Shared helpers for AidFlow Testnet spikes (member A).

Everything here talks to Stellar TESTNET only. Never point it at mainnet.
"""
from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from stellar_sdk import Asset, Keypair, Network, Server, SorobanServer
from stellar_sdk.soroban_rpc import GetTransactionStatus

ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = ROOT / ".env"
load_dotenv(ENV_PATH)

HORIZON_URL = os.getenv("HORIZON_URL", "https://horizon-testnet.stellar.org")
RPC_URL = os.getenv("RPC_URL", "https://soroban-testnet.stellar.org")
FRIENDBOT_URL = os.getenv("FRIENDBOT_URL", "https://friendbot.stellar.org")
NETWORK_PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE
ASSET_CODE = os.getenv("ASSET_CODE", "AIDUSD")
BASE_FEE = 100  # stroops; Testnet fees are tiny
TX_TIMEOUT_SECONDS = 30  # time bounds: tx is invalid after this


def horizon() -> Server:
    return Server(HORIZON_URL)


def rpc() -> SorobanServer:
    return SorobanServer(RPC_URL)


def keypair(name: str) -> Keypair:
    """Load a keypair from .env, e.g. keypair('DISTRIBUTION')."""
    secret = os.getenv(f"{name}_SECRET")
    if not secret:
        raise SystemExit(f"{name}_SECRET missing in .env. Run scripts/testnet_setup.py first.")
    return Keypair.from_secret(secret)


def aid_asset() -> Asset:
    return Asset(ASSET_CODE, keypair("ISSUER").public_key)


def fund_with_friendbot(public_key: str) -> None:
    r = requests.get(FRIENDBOT_URL, params={"addr": public_key}, timeout=30)
    if r.status_code != 200 and "createAccountAlreadyExist" not in r.text:
        raise RuntimeError(f"Friendbot failed for {public_key}: {r.status_code} {r.text[:200]}")


def memo_hash_for(request_ref: str) -> bytes:
    """MEMO_HASH = SHA-256(request_ref). 32 bytes, reveals no internal ID or identity."""
    return hashlib.sha256(request_ref.encode("utf-8")).digest()


def verify_transaction(tx_hash: str, wait_seconds: int = 0) -> str:
    """Return SUCCESS / FAILED / NOT_FOUND for a tx hash via Stellar RPC.

    RPC only keeps ~7 days of history (configurable per provider). For older
    transactions we fall back to Horizon, which keeps a persistent record.
    """
    deadline = time.time() + wait_seconds
    while True:
        try:
            resp = rpc().get_transaction(tx_hash)
            status = resp.status
            if status != GetTransactionStatus.NOT_FOUND or time.time() >= deadline:
                return status.value
        except Exception as exc:  # RPC unreachable -> try Horizon
            print(f"  RPC lookup failed ({exc}); falling back to Horizon")
            return _verify_via_horizon(tx_hash)
        time.sleep(2)


def _verify_via_horizon(tx_hash: str) -> str:
    try:
        tx = horizon().transactions().transaction(tx_hash).call()
        return "SUCCESS" if tx.get("successful") else "FAILED"
    except Exception:
        return "NOT_FOUND"


def explorer_link(tx_hash: str) -> str:
    return f"https://stellar.expert/explorer/testnet/tx/{tx_hash}"
