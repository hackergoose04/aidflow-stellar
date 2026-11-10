"""Donor view API: public, read-only, no personal data.

Exposed: request ref, batch, amount, asset, a plain-language status, the Stellar transaction,
the memo hash and the on-chain registry status. Never exposed: beneficiary, wallet, flags,
risk score, reviewer, notes. (A transaction link does show the receiving wallet, because the
chain is public; it carries no name or ID.)

Donors don't have to trust these numbers: the donor page recomputes SHA-256(ref) in the
browser and reads the transaction straight from Stellar to check memo, amount and success.
"""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from . import config, db, registry, stellar_client as sc

router = APIRouter(prefix="/public", tags=["public (donor view)"])

PUBLIC_STATUS = {
    "CLAIMED": "Received", "CONFIRMED": "Paid",
    "APPROVED": "In progress", "SUBMITTED": "In progress", "UNKNOWN": "In progress",
    "PENDING_REVIEW": "Under review", "HELD": "Under review",
    "REJECTED": "Not paid", "FAILED": "Not paid", "INVALID": "Not paid",
}


def _conn():
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


def _payment(row: dict) -> dict:
    paid = row["status"] in ("CONFIRMED", "CLAIMED")
    return {
        "request_ref": row["request_ref"], "batch_id": row["batch_id"],
        "amount": row["amount"], "asset": row["asset"],
        "status": PUBLIC_STATUS.get(row["status"], "In progress"),
        "method": row["method"] if paid else None,
        "claim_status": row["claim_status"], "claimed_at": row["claimed_at"],
        "paid_at": row["submitted_at"] if paid else None,
        "tx_hash": row["tx_hash"] if paid else None,
        "explorer": sc.explorer_link(row["tx_hash"]) if paid and row["tx_hash"] else None,
        "memo_hash": sc.memo_hash(row["request_ref"]).hex(),
        "registry_status": row["registry_status"],
        "reconciliation": row["recon_status"],
    }


@router.get("/summary")
def summary(conn: sqlite3.Connection = Depends(_conn)) -> dict:
    batches = [dict(r) for r in conn.execute("""
        SELECT batch_id,
               SUM(CASE WHEN status NOT IN ('INVALID') THEN 1 ELSE 0 END) AS requests,
               SUM(CASE WHEN status IN ('CONFIRMED','CLAIMED') THEN 1 ELSE 0 END) AS paid,
               SUM(CASE WHEN status = 'CLAIMED' OR (status = 'CONFIRMED' AND method = 'payment') THEN 1 ELSE 0 END) AS received,
               SUM(CASE WHEN status IN ('APPROVED','SUBMITTED','UNKNOWN') THEN 1 ELSE 0 END) AS in_progress,
               ROUND(SUM(CASE WHEN status IN ('CONFIRMED','CLAIMED') THEN CAST(amount AS REAL) ELSE 0 END), 2) AS amount_paid,
               SUM(CASE WHEN status IN ('CONFIRMED','CLAIMED') AND recon_status = 'MATCHED' THEN 1 ELSE 0 END) AS reconciled,
               MAX(asset) AS asset
        FROM requests GROUP BY batch_id ORDER BY batch_id""")]
    totals = {k: sum(b[k] or 0 for b in batches) for k in ("requests", "paid", "received", "in_progress", "reconciled")}
    totals["amount_paid"] = round(sum(b["amount_paid"] or 0 for b in batches), 2)
    dist = config.public("DISTRIBUTION")
    return {
        "program": registry.program(), "network": "Stellar Testnet", "asset": config.ASSET_CODE,
        "totals": totals, "batches": batches,
        "ngo_account": dist, "ngo_explorer": f"https://stellar.expert/explorer/testnet/account/{dist}",
        "asset_issuer": config.public("ISSUER"),
        "registry_contract": registry.contract_id(), "registry_explorer": registry.explorer_contract(),
        "horizon_url": config.HORIZON_URL,
    }


@router.get("/batches/{batch_id}")
def batch(batch_id: str, conn: sqlite3.Connection = Depends(_conn)) -> list[dict]:
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM requests WHERE batch_id = ? AND status != 'INVALID' ORDER BY request_ref",
        (batch_id,))]
    if not rows:
        raise HTTPException(404, f"no batch {batch_id}")
    return [_payment(r) for r in rows]


@router.get("/payments/{ref}")
def payment(ref: str, conn: sqlite3.Connection = Depends(_conn)) -> dict:
    row = db.get(conn, ref)
    if row is None:
        raise HTTPException(404, f"no payment {ref}")
    return _payment(row)
