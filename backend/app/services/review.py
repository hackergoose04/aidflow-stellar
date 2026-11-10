"""Review: a human approves, holds, corrects or declines each request before money moves."""
from __future__ import annotations

import sqlite3

from .. import db, identity
from ..db import Status
from . import dedup, ingest, screening

OPEN = (Status.PENDING_REVIEW, Status.HELD)  # states a reviewer can approve / reject
CORRECTABLE = (*OPEN, Status.INVALID)          # an invalid record can be fixed, or rejected
EDITABLE = ("beneficiary_id", "wallet", "amount", "batch_id", "created_at")


def decide(conn: sqlite3.Connection, ref: str, approve: bool, reviewer: str,
           note: str | None = None) -> dict:
    row = db.get(conn, ref)
    if row is None:
        raise LookupError(ref)
    allowed = OPEN if approve else CORRECTABLE
    if row["status"] not in allowed:
        raise ValueError(f"{ref} is {row['status']}; can't {'approve' if approve else 'reject'} it")
    status = Status.APPROVED if approve else Status.REJECTED
    conn.execute("UPDATE requests SET status = ?, reviewer = ?, note = ?, updated_at = ?"
                 " WHERE request_ref = ?", (status, reviewer, note, db.now(), ref))
    db.log(conn, ref, status.lower(), {"reviewer": reviewer, "note": note})
    conn.commit()
    return db.get(conn, ref)


def hold(conn: sqlite3.Connection, ref: str, reviewer: str, note: str | None = None) -> dict:
    """Park a request for further checks. It stays out of 'approve clean' until decided."""
    row = db.get(conn, ref)
    if row is None:
        raise LookupError(ref)
    if row["status"] != Status.PENDING_REVIEW:
        raise ValueError(f"{ref} is {row['status']}, only PENDING_REVIEW can be put on hold")
    conn.execute("UPDATE requests SET status = ?, reviewer = ?, note = ?, updated_at = ?"
                 " WHERE request_ref = ?", (Status.HELD, reviewer, note, db.now(), ref))
    db.log(conn, ref, "held", {"reviewer": reviewer, "note": note})
    conn.commit()
    return db.get(conn, ref)


def correct(conn: sqlite3.Connection, ref: str, changes: dict, reviewer: str,
            note: str | None = None) -> dict:
    """Fix a request's data (e.g. a mistyped wallet), then screen it again from scratch.

    The old and new values go to the audit trail. The request returns to PENDING_REVIEW,
    so the corrected version still needs an explicit decision."""
    row = db.get(conn, ref)
    if row is None:
        raise LookupError(ref)
    if row["status"] not in CORRECTABLE:
        raise ValueError(f"{ref} is {row['status']}, only PENDING_REVIEW, HELD or INVALID can be corrected")
    changes = {k: str(v).strip() for k, v in changes.items() if k in EDITABLE and v is not None}
    if "beneficiary_id" in changes:  # staff type the real ID; only its token is stored
        changes["beneficiary_id"] = identity.pseudonymize(changes["beneficiary_id"])
    changes = {k: v for k, v in changes.items() if v != (row[k] or "")}
    if not changes:
        raise ValueError("nothing to change")
    merged = {**row, **changes}
    errors = ingest.validate(merged)
    if errors:
        raise ValueError(f"invalid correction: {', '.join(errors)}")
    if "amount" in changes:
        changes["amount"] = ingest.normalize_amount(changes["amount"])
    if "created_at" in changes:
        changes["created_at"] = ingest.parse_time(changes["created_at"])
    # An INVALID record that now passes validation joins the normal flow.
    if row["status"] == Status.INVALID:
        db.log(conn, ref, "validated", {"reviewer": reviewer})

    sets = ", ".join(f"{k} = ?" for k in changes)
    conn.execute(f"UPDATE requests SET {sets}, status = ?, flags = '[]', risk_score = NULL,"
                 " reviewer = ?, note = ?, updated_at = ? WHERE request_ref = ?",
                 (*changes.values(), Status.PENDING_REVIEW, reviewer, note, db.now(), ref))
    db.log(conn, ref, "corrected", {"reviewer": reviewer, "note": note,
                                    "changes": {k: [row[k], v] for k, v in changes.items()}})
    dedup.flag_duplicates(conn, [ref])
    screening.screen(conn, [ref])
    conn.commit()
    return db.get(conn, ref)


def approve_clean(conn: sqlite3.Connection, reviewer: str) -> list[str]:
    """Bulk-approve every pending request that has no flags. Flagged ones stay for a human."""
    refs = [r["request_ref"] for r in conn.execute(
        "SELECT request_ref FROM requests WHERE status = ? AND flags = '[]'",
        (Status.PENDING_REVIEW,))]
    for ref in refs:
        conn.execute("UPDATE requests SET status = ?, reviewer = ?, updated_at = ?"
                     " WHERE request_ref = ?", (Status.APPROVED, reviewer, db.now(), ref))
        db.log(conn, ref, "approved", {"reviewer": reviewer, "bulk": True})
    conn.commit()
    return refs


def retry(conn: sqlite3.Connection, ref: str, reviewer: str) -> dict:
    """Send a FAILED request back to APPROVED. Safe: FAILED means the old tx can never land."""
    row = db.get(conn, ref)
    if row is None:
        raise LookupError(ref)
    if row["status"] != Status.FAILED:
        raise ValueError(f"{ref} is {row['status']}, only FAILED can be retried")
    if row.get("registry_status") == "BLOCKED":
        raise ValueError(f"{ref} was refused by the on-chain registry: this person already has a "
                         f"payout in batch {row['batch_id']}; retrying would be refused again")
    conn.execute("UPDATE requests SET status = ?, tx_hash = NULL, method = NULL, error = NULL,"
                 " submitted_at = NULL, updated_at = ? WHERE request_ref = ?",
                 (Status.APPROVED, db.now(), ref))
    db.log(conn, ref, "retry", {"reviewer": reviewer, "old_tx": row["tx_hash"]})
    conn.commit()
    return db.get(conn, ref)
