"""Dedup: flag probable double requests. It only flags; a human decides.

Exact duplicate request_refs are already rejected at ingest. This catches the softer cases:
  * same beneficiary, same amount, within DUPLICATE_WINDOW_HOURS (new ref, same payout)
  * same beneficiary and payout slot twice in one disbursement batch"""
from __future__ import annotations

from datetime import datetime, timedelta

from .. import config, db
from ..db import INACTIVE


def flag_duplicates(conn: db.Connection, refs: list[str]) -> None:
    window = timedelta(hours=config.DUPLICATE_WINDOW_HOURS)
    for ref in refs:
        row = db.get(conn, ref)
        t = datetime.fromisoformat(row["created_at"])
        others = conn.execute(
            "SELECT request_ref, created_at FROM requests"
            " WHERE beneficiary_id = ? AND amount = ? AND request_ref != ? AND status NOT IN (?, ?)",
            (row["beneficiary_id"], row["amount"], ref, *INACTIVE)).fetchall()
        for other in others:
            t_other = datetime.fromisoformat(other["created_at"])
            # Flag only the later of the pair, so the original stays clean.
            is_later = (t, ref) > (t_other, other["request_ref"])
            if abs(t - t_other) <= window and is_later:
                db.add_flags(conn, ref, [f"possible_duplicate_of:{other['request_ref']}"])

        if config.CHECK_BATCH_PAYOUT_SLOT and row.get("batch_id"):
            same_batch = conn.execute(
                "SELECT request_ref, created_at FROM requests WHERE beneficiary_id = ?"
                " AND batch_id = ? AND payout_slot = ? AND request_ref != ? AND status NOT IN (?, ?)",
                (row["beneficiary_id"], row["batch_id"], row["payout_slot"], ref, *INACTIVE)).fetchall()
            for other in same_batch:
                if (row["created_at"], ref) > (other["created_at"], other["request_ref"]):
                    db.add_flags(conn, ref, [f"same_batch_as:{other['request_ref']}"])
