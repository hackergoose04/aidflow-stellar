"""Verifier: resolve SUBMITTED / UNKNOWN requests by looking their tx hash up on chain."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

from .. import config, db, stellar_client as sc
from ..db import Status
from .executor import settle_registry


def run(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT request_ref, tx_hash, submitted_at FROM requests"
                        " WHERE status IN (?, ?)", (Status.SUBMITTED, Status.UNKNOWN)).fetchall()
    results = []
    for row in rows:
        ref, tx_hash = row["request_ref"], row["tx_hash"]
        result = sc.verify(tx_hash)
        new_status, error = None, None
        if result == "SUCCESS":
            new_status = Status.CONFIRMED
        elif result == "FAILED":
            new_status, error = Status.FAILED, "failed on chain"
        else:
            # Not found. Once the time bounds have passed it can never land, so a retry is safe.
            expiry = (datetime.fromisoformat(row["submitted_at"])
                      + timedelta(seconds=config.TX_TIMEOUT_SECONDS + 10))
            if datetime.now(timezone.utc) > expiry:
                new_status, error = Status.FAILED, "expired without landing; safe to retry"
        if new_status:
            conn.execute("UPDATE requests SET status = ?, error = ?, updated_at = ?,"
                         " claim_status = CASE WHEN ? = 'CONFIRMED' AND method = 'claimable_balance'"
                         " THEN 'UNCLAIMED' ELSE claim_status END WHERE request_ref = ?",
                         (new_status, error, db.now(), new_status, ref))
            db.log(conn, ref, "verified", {"result": result, "status": new_status})
            conn.commit()
            settle_registry(conn, ref, new_status)  # mark PAID, or release so it can be retried
        results.append({"request_ref": ref, "chain": result, "status": new_status or "unchanged"})
    conn.commit()
    return results
