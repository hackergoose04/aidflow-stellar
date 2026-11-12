"""Screening: rules + ML risk score (ml/, Isolation Forest).

Rules add human-readable flags. The model sets risk_score (0..1) and adds an
`ml_high_risk` flag above its tuned threshold. Nothing is blocked here; flagged
requests wait for a human in review."""
from __future__ import annotations

from decimal import Decimal

import pandas as pd

from ml import score as ml

from .. import config, db


def screen(conn: db.Connection, refs: list[str]) -> None:
    for ref in refs:
        row = db.get(conn, ref)
        flags = []
        if row["payout_slot"] != config.DEFAULT_PAYOUT_SLOT:
            flags.append(f"additional_payout:{row['payout_slot']}")
        if Decimal(row["amount"]) > config.AMOUNT_LIMIT:
            flags.append(f"amount_above_limit:{config.AMOUNT_LIMIT}")
        sharing = conn.execute(
            "SELECT DISTINCT beneficiary_id FROM requests WHERE wallet = ? AND beneficiary_id != ?"
            " AND status != 'INVALID'", (row["wallet"], row["beneficiary_id"])).fetchall()
        flags += [f"shared_wallet_with:{s['beneficiary_id']}" for s in sharing]
        earlier_wallet = conn.execute(
            "SELECT 1 FROM requests WHERE beneficiary_id = ? AND wallet != ? AND created_at < ?"
            " AND status != 'INVALID' LIMIT 1", (row["beneficiary_id"], row["wallet"], row["created_at"])).fetchone()
        if earlier_wallet:
            flags.append("wallet_changed")
        db.add_flags(conn, ref, flags)
    ml_score(conn, refs)


def ml_score(conn: db.Connection, refs: list[str]) -> None:
    """Score `refs` with the model, using every stored request as history."""
    if not refs:
        return
    columns = ["request_ref", "beneficiary_id", "wallet", "amount", "asset", "created_at"]
    rows = conn.execute(f"SELECT {', '.join(columns)} FROM requests"
                        " WHERE status NOT IN ('REJECTED', 'INVALID')").fetchall()
    history = pd.DataFrame([[r[c] for c in columns] for r in rows], columns=columns)
    risk = ml.score_frame(history)
    if risk is None:
        return  # no trained model yet: rules only
    by_ref = dict(zip(history["request_ref"], risk))
    cut = ml.threshold()
    for ref in refs:
        r = round(float(by_ref[ref]), 3)
        conn.execute("UPDATE requests SET risk_score = ? WHERE request_ref = ?", (r, ref))
        if r >= cut:
            db.add_flags(conn, ref, [f"ml_high_risk:{r}"])
