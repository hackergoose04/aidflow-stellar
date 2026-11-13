"""Screening: rules + ML risk score (ml/, Isolation Forest).

Rules add human-readable flags. The model sets risk_score (0..1) and adds an
`ml_high_risk` flag above its tuned threshold. Nothing is blocked here; flagged
requests wait for a human in review."""
from __future__ import annotations

import json

import pandas as pd

from ml import score as ml

from .. import config, db, registry
from .screening_policy import ScreeningPolicy


def screen(conn: db.Connection, refs: list[str]) -> None:
    for ref in refs:
        row = db.get(conn, ref)
        flags = []
        if row["payout_slot"] != config.DEFAULT_PAYOUT_SLOT:
            flags.append(f"additional_payout:{row['payout_slot']}")
        policy = (ScreeningPolicy.model_validate_json(row["screening_policy"]) if row["screening_policy"]
                  else ScreeningPolicy(max_amount=config.AMOUNT_LIMIT))
        flags += policy.flags(row)
        installment = row["installment"]
        expected = config.BATCH_INSTALLMENT_SCHEDULE.get(row["batch_id"])
        if installment is not None and expected is not None and installment < expected:
            flags.append(f"earlier_installment:{installment}/{expected}")
        month = row["benefit_month"]
        expected_month = config.BATCH_BENEFIT_MONTH_SCHEDULE.get(row["batch_id"])
        if month is not None and expected_month is not None and month < expected_month:
            flags.append(f"earlier_benefit_month:{month}/{expected_month}")
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
    """Score new or corrected requests with the configured program model."""
    if not refs:
        return
    cut = ml.active_threshold(registry.program(), config.ASSET_CODE)
    if cut is None:
        return
    columns = ["request_ref", "beneficiary_id", "wallet", "amount", "asset", "created_at", "available_at"]
    rows = conn.execute(f"SELECT {', '.join(columns)} FROM requests"
                        " WHERE status NOT IN ('REJECTED', 'INVALID') AND asset = ?", (config.ASSET_CODE,)).fetchall()
    history = pd.DataFrame([[r[c] for c in columns] for r in rows], columns=columns)
    risk = ml.score_frame(history)
    if risk is None:
        return  # no trained model yet: rules only
    positions = {ref: i for i, ref in enumerate(history["request_ref"])}
    use_validation_reference = ml.uses_validation_reference()
    flagged_positions = []
    for ref in refs:
        pos = positions[ref]
        percentile = float(risk[pos])
        rounded = round(percentile, 3)
        score = percentile if use_validation_reference else rounded
        conn.execute("UPDATE requests SET risk_score = ? WHERE request_ref = ?", (score, ref))
        if score >= cut:
            db.add_flags(conn, ref, [f"ml_high_risk:{rounded}"])
            flagged_positions.append(pos)
    for position, signals in ml.explain_flags(history, flagged_positions).items():
        conn.execute("UPDATE requests SET risk_signals = ? WHERE request_ref = ?",
                     (json.dumps(signals), history.iloc[position]["request_ref"]))
