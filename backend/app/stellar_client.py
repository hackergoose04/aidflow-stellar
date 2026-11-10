"""Thin Stellar layer for the backend. Same choices as the spikes (docs/research-A-stellar.md):
MEMO_HASH = SHA-256(request_ref), submit via Horizon, verify via RPC with Horizon fallback."""
from __future__ import annotations

import hashlib
import time

from stellar_sdk import Account, Asset, Claimant, ClaimPredicate, Keypair, Server, SorobanServer
from stellar_sdk import TransactionBuilder
from stellar_sdk.exceptions import BadRequestError, BaseHorizonError, ConnectionError, NotFoundError
from stellar_sdk.soroban_rpc import GetTransactionStatus

from . import config


def horizon() -> Server:
    return Server(config.HORIZON_URL)


def rpc() -> SorobanServer:
    return SorobanServer(config.RPC_URL)


def distribution_keypair() -> Keypair:
    return Keypair.from_secret(config.secret("DISTRIBUTION"))


def aid_asset() -> Asset:
    return Asset(config.ASSET_CODE, config.public("ISSUER"))


def memo_hash(request_ref: str) -> bytes:
    return hashlib.sha256(request_ref.encode("utf-8")).digest()


def has_trustline(wallet: str, asset: Asset) -> bool:
    """True if the wallet exists and already trusts the asset (so a plain Payment works)."""
    try:
        balances = horizon().accounts().account_id(wallet).call()["balances"]
    except NotFoundError:
        return False  # account not created yet: only a Claimable Balance can reach it
    return any(b.get("asset_code") == asset.code and b.get("asset_issuer") == asset.issuer
               for b in balances)


def build_payout(source: Account, signer: Keypair, method: str, wallet: str, asset: Asset,
                 amount: str, request_ref: str):
    builder = TransactionBuilder(source, config.NETWORK_PASSPHRASE, base_fee=config.BASE_FEE)
    if method == "payment":
        builder.append_payment_op(destination=wallet, asset=asset, amount=amount)
    else:
        window = ClaimPredicate.predicate_before_relative_time(config.RECLAIM_AFTER_SECONDS)
        builder.append_create_claimable_balance_op(asset=asset, amount=amount, claimants=[
            Claimant(destination=wallet, predicate=window),
            Claimant(destination=signer.public_key, predicate=ClaimPredicate.predicate_not(window)),
        ])
    tx = builder.add_hash_memo(memo_hash(request_ref)).set_timeout(config.TX_TIMEOUT_SECONDS).build()
    tx.sign(signer)
    return tx


def submit(tx) -> tuple[str, str | None]:
    """Submit once. Returns (CONFIRMED | FAILED | UNKNOWN, error). Never resubmits."""
    try:
        resp = horizon().submit_transaction(tx)
        return ("CONFIRMED", None) if resp.get("successful") else ("FAILED", "unsuccessful")
    except BadRequestError as exc:
        codes = (exc.extras or {}).get("result_codes")
        return "FAILED", str(codes)
    except (ConnectionError, BaseHorizonError) as exc:
        # Timeout / 5xx: the tx may still land. Look it up by hash instead of resending.
        result = verify(tx.hash_hex(), wait_seconds=config.TX_TIMEOUT_SECONDS + 10)
        status = {"SUCCESS": "CONFIRMED", "FAILED": "FAILED"}.get(result, "UNKNOWN")
        return status, f"submit unclear ({type(exc).__name__}), verified: {result}"


def verify(tx_hash: str, wait_seconds: int = 0) -> str:
    """SUCCESS / FAILED / NOT_FOUND via RPC, falling back to Horizon (RPC keeps ~7 days)."""
    deadline = time.time() + wait_seconds
    while True:
        try:
            status = rpc().get_transaction(tx_hash).status
            if status != GetTransactionStatus.NOT_FOUND:
                return status.value
        except Exception:
            pass
        if time.time() >= deadline:
            return _verify_via_horizon(tx_hash)
        time.sleep(2)


def _verify_via_horizon(tx_hash: str) -> str:
    try:
        tx = horizon().transactions().transaction(tx_hash).call()
        return "SUCCESS" if tx.get("successful") else "FAILED"
    except NotFoundError:
        return "NOT_FOUND"


def explorer_link(tx_hash: str) -> str:
    return f"https://stellar.expert/explorer/testnet/tx/{tx_hash}"
