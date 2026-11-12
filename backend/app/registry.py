"""On-chain payout registry (contracts/aid_registry), Plan B: hashes only, no money.

    request_hash = SHA-256(request_ref)   (also the payment's memo)

One key = one payout slot per beneficiary per program and batch. The contract enforces
uniqueness of the key. The base slot retains the original key format.
The HMAC secret stays in .env, so the chain shows no beneficiary IDs and nobody can test
guesses against it.

Flow around each payout (see services/executor.py):
    reserve()  before paying   -> RESERVED, or BLOCKED if another request holds the key
    settle()   after the result: CONFIRMED -> mark_paid -> PAID; FAILED -> release -> RELEASED
Registering and paying are separate transactions (a Soroban call can't share a transaction
with a classic payment), so a crash in between leaves the key RESERVED for this request.
The next run sees its own request hash there and continues instead of blocking.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os

from stellar_sdk import scval

from . import config, soroban, stellar_client as sc

ALREADY_REGISTERED, NOT_FOUND, ALREADY_PAID = 1, 2, 3


def contract_id() -> str | None:
    return os.getenv("REGISTRY_CONTRACT_ID") or None


def enabled() -> bool:
    return bool(contract_id() and os.getenv("REGISTRY_SECRET"))


def program() -> str:
    return os.getenv("PROGRAM_ID", "AIDFLOW-DEMO")


def key_for(beneficiary_id: str, batch_id: str | None,
            payout_slot: str = config.DEFAULT_PAYOUT_SLOT) -> bytes:
    secret = os.environ["REGISTRY_SECRET"].encode()
    if payout_slot == config.DEFAULT_PAYOUT_SLOT:
        # Old records and on-chain reservations already use this byte format.
        msg = f"{program()}|{batch_id or ''}|{beneficiary_id}".encode()
    else:
        fields = json.dumps([program(), batch_id or "", beneficiary_id, payout_slot],
                            separators=(",", ":"))
        msg = f"aidflow:payout-slot:v1:{fields}".encode()
    return hmac.new(secret, msg, hashlib.sha256).digest()


def get(key: bytes) -> dict | None:
    """The entry for a key, or None. status is 'Reserved' or 'Paid'."""
    raw = soroban.read(contract_id(), "get", [scval.to_bytes(key)])
    if raw is None:
        return None
    status = raw["status"]
    return {"request_hash": raw["request_hash"], "status": status[0] if isinstance(status, list) else status,
            "tx_hash": raw["tx_hash"].hex() if raw["tx_hash"] else None, "ledger": raw["ledger"]}


def _call(function: str, *args) -> str:
    status, tx_hash, _ = soroban.submit(
        sc.distribution_keypair(),
        lambda b: b.append_invoke_contract_function_op(contract_id(), function, list(args)))
    if status != "SUCCESS":
        raise soroban.ContractError(None, f"{function} {status}: {sc.explorer_link(tx_hash)}")
    return tx_hash


def reserve(key: bytes, request_ref: str) -> tuple[str, str | None]:
    """Reserve the key for this request before paying.

    Returns (outcome, detail):
      RESERVED      key is now held by this request (tx hash in detail, or None if it already was)
      BLOCKED       another request already holds this payout slot (its status in detail)
      ALREADY_PAID  this very request is already PAID in the registry (payment tx hash in detail)
    """
    mine = sc.memo_hash(request_ref)
    entry = get(key)
    if entry is None:
        try:
            return "RESERVED", _call("register", scval.to_bytes(key), scval.to_bytes(mine))
        except soroban.ContractError as exc:
            if exc.code != ALREADY_REGISTERED:
                raise
            entry = get(key)  # lost a race: look at who holds it
    if entry["request_hash"] != mine:
        return "BLOCKED", entry["status"]
    if entry["status"] == "Paid":
        return "ALREADY_PAID", entry["tx_hash"]
    return "RESERVED", None


def mark_paid(key: bytes, payment_tx_hash: str) -> str:
    return _call("mark_paid", scval.to_bytes(key), scval.to_bytes(bytes.fromhex(payment_tx_hash)))


def release(key: bytes) -> str:
    return _call("release", scval.to_bytes(key))


def explorer_contract() -> str | None:
    cid = contract_id()
    return f"https://stellar.expert/explorer/testnet/contract/{cid}" if cid else None
