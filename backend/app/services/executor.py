"""Executor: pay APPROVED requests on Stellar, using the safe-submit pattern.

For each request:
  1. (registry on) reserve key = HMAC(program | batch | beneficiary) in the on-chain registry.
     If another request already holds it, the chain refuses and nothing is paid.
  2. build + sign -> store the tx hash as SUBMITTED (committed) -> submit once.
  3. (registry on) CONFIRMED -> mark the key PAID; FAILED -> release it so a retry can reserve it.
The status update in step 2 is conditional on status = APPROVED, so two workers can't pay
the same row."""
from __future__ import annotations

import sqlite3

from .. import db, registry, soroban, stellar_client as sc
from ..db import Status


def settle_registry(conn: sqlite3.Connection, ref: str, status: str) -> None:
    """After a payment's outcome is known, record it in the on-chain registry."""
    row = db.get(conn, ref)
    if not row.get("registry_key") or row.get("registry_status") != "RESERVED":
        return
    key = bytes.fromhex(row["registry_key"])
    try:
        if status == Status.CONFIRMED:
            h = registry.mark_paid(key, row["tx_hash"])
            new = "PAID"
        elif status == Status.FAILED:
            h = registry.release(key)
            new = "RELEASED"
        else:
            return  # UNKNOWN / SUBMITTED: keep the reservation until the outcome is known
    except soroban.ContractError as exc:
        db.log(conn, ref, "registry_error", {"step": "settle", "error": str(exc)[:300]})
        return
    conn.execute("UPDATE requests SET registry_status = ?, updated_at = ? WHERE request_ref = ?",
                 (new, db.now(), ref))
    db.log(conn, ref, f"registry_{new.lower()}", {"tx_hash": h})


def _reserve(conn: sqlite3.Connection, row: dict) -> dict | None:
    """Reserve the registry key. Returns a result dict if the request must NOT be paid now."""
    ref = row["request_ref"]
    key = registry.key_for(row["beneficiary_id"], row["batch_id"])
    conn.execute("UPDATE requests SET registry_key = ? WHERE request_ref = ?", (key.hex(), ref))
    try:
        outcome, detail = registry.reserve(key, ref)
    except Exception as exc:  # RPC down, etc.: don't pay without the guard; try again later
        db.log(conn, ref, "registry_error", {"step": "reserve", "error": str(exc)[:300]})
        conn.commit()
        return {"request_ref": ref, "status": "APPROVED", "error": f"registry unavailable: {exc}"[:200]}

    if outcome == "BLOCKED":
        error = (f"on-chain registry refused: {row['beneficiary_id']} already has a payout "
                 f"({detail.lower()}) in batch {row['batch_id']}")
        conn.execute("UPDATE requests SET status = ?, registry_status = 'BLOCKED', error = ?,"
                     " updated_at = ? WHERE request_ref = ?", (Status.FAILED, error, db.now(), ref))
        db.log(conn, ref, "registry_blocked", {"held_by_status": detail})
        conn.commit()
        return {"request_ref": ref, "status": "FAILED", "error": error}
    if outcome == "ALREADY_PAID":
        # The registry says this very request was paid: look the payment up, don't pay again.
        conn.execute("UPDATE requests SET status = ?, tx_hash = ?, submitted_at = ?, registry_status = 'PAID',"
                     " error = ?, updated_at = ? WHERE request_ref = ?",
                     (Status.SUBMITTED, detail, db.now(), "registry shows this request paid; verifying",
                      db.now(), ref))
        db.log(conn, ref, "registry_already_paid", {"tx_hash": detail})
        conn.commit()
        return {"request_ref": ref, "status": "SUBMITTED", "error": "already paid per registry; run Verify",
                "tx_hash": detail}

    conn.execute("UPDATE requests SET registry_status = 'RESERVED' WHERE request_ref = ?", (ref,))
    if detail:
        db.log(conn, ref, "registry_reserved", {"tx_hash": detail})
    conn.commit()
    return None


def run(conn: sqlite3.Connection, limit: int = 20) -> list[dict]:
    dist, asset = sc.distribution_keypair(), sc.aid_asset()
    server = sc.horizon()
    use_registry = registry.enabled()
    refs = [r["request_ref"] for r in conn.execute(
        "SELECT request_ref FROM requests WHERE status = ? ORDER BY created_at LIMIT ?",
        (Status.APPROVED, limit))]

    results = []
    for ref in refs:
        row = db.get(conn, ref)
        if use_registry:
            stop = _reserve(conn, row)
            if stop:
                results.append(stop)
                continue

        method = "payment" if sc.has_trustline(row["wallet"], asset) else "claimable_balance"
        source = server.load_account(dist.public_key)  # fresh sequence number per tx
        tx = sc.build_payout(source, dist, method, row["wallet"], asset, row["amount"], ref)
        tx_hash = tx.hash_hex()

        claimed = conn.execute(
            "UPDATE requests SET status = ?, method = ?, tx_hash = ?, submitted_at = ?, updated_at = ?"
            " WHERE request_ref = ? AND status = ?",
            (Status.SUBMITTED, method, tx_hash, db.now(), db.now(), ref, Status.APPROVED)).rowcount
        if claimed != 1:
            continue  # someone else picked it up
        db.log(conn, ref, "submitted", {"tx_hash": tx_hash, "method": method})
        conn.commit()  # the hash is on disk BEFORE the network sees the tx

        status, error = sc.submit(tx)
        claim = "UNCLAIMED" if status == Status.CONFIRMED and method == "claimable_balance" else None
        conn.execute("UPDATE requests SET status = ?, error = ?, claim_status = ?, updated_at = ?"
                     " WHERE request_ref = ?", (status, error, claim, db.now(), ref))
        db.log(conn, ref, status.lower(), {"tx_hash": tx_hash, "error": error})
        conn.commit()
        if use_registry:
            settle_registry(conn, ref, status)
            conn.commit()
        results.append({"request_ref": ref, "method": method, "status": status, "error": error,
                        "tx_hash": tx_hash, "explorer": sc.explorer_link(tx_hash),
                        "registry": db.get(conn, ref).get("registry_status")})
    return results
