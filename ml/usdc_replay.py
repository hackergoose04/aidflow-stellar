"""Prepare an isolated AidFlow queue using a calibrated USDC Isolation Forest.

Run with a clean USDC CSV from ml.real_payment_benchmark and a new output directory:
python -m ml.usdc_replay ml/data/aid_benchmark/real_usdc_clean.csv ml/data/usdc-calibrated-replay
"""
from __future__ import annotations

import argparse
import json
import os
from collections import Counter
from contextlib import closing
from pathlib import Path

import joblib
import pandas as pd

from backend.app import config, db
from backend.app.services.ingest import ingest_csv
from .aid_benchmark import REQUEST_COLUMNS, REVIEW_BUDGET
from .features import BEHAVIOR_FEATURES, FIXED_HISTORY_VERSION
from .real_payment_benchmark import PAYMENT_FEATURES, chronological_split
from .score import anomaly_scores, load, risk_from_scores
from .train import fit_fixed_model


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("csv", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--program", default="Stellar Mainnet USDC calibrated replay")
    parser.add_argument("--apply-amount-limit", action="store_true", help="Use AMOUNT_LIMIT for the replay")
    args = parser.parse_args()
    if not os.getenv("PII_HMAC_SECRET"):
        parser.error("Set PII_HMAC_SECRET and reuse it when serving the replay database")

    payments = pd.read_csv(args.csv, dtype={"request_ref": str, "amount": str})
    if payments.empty or set(payments["asset"]) != {"USDC"}:
        parser.error("Use the prepared USDC CSV")
    payments = payments.sort_values(["created_at", "request_ref"]).reset_index(drop=True)
    train, validation, test = chronological_split(payments["upload_id"])
    payments["available_at"] = pd.to_datetime(payments["upload_id"], utc=True)
    columns = [name for name in BEHAVIOR_FEATURES if name in PAYMENT_FEATURES]
    bundle, features = fit_fixed_model(payments, train, validation, program=args.program,
                                       columns=columns, review_budget=REVIEW_BUDGET)
    holdout_risk = risk_from_scores(bundle, anomaly_scores(bundle, features.loc[test]))

    output = args.output_dir.resolve()
    output.mkdir(parents=True)
    model_path = output / "isoforest-usdc.joblib"
    joblib.dump(bundle, model_path)
    os.environ["AIDFLOW_MODEL_PATH"] = str(model_path)
    os.environ["PROGRAM_ID"] = args.program
    load.cache_clear()
    config.ASSET_CODE = "USDC"
    if not args.apply_amount_limit:
        config.AMOUNT_LIMIT = None
    config.CHECK_BATCH_PAYOUT_SLOT = False
    config.BATCH_INSTALLMENT_SCHEDULE = {}
    config.BATCH_BENEFIT_MONTH_SCHEDULE = {}
    config.DB_PATH = output / "replay.db"
    config.DATABASE_URL = None

    with closing(db.connect()) as conn:
        for _, window in payments.groupby("upload_id", sort=True):
            result = ingest_csv(conn, window[REQUEST_COLUMNS].to_csv(index=False))
            if result["accepted"] != len(window) or result["rejected"]:
                raise ValueError("USDC replay rejected rows from the prepared input")
        rows = {row["request_ref"]: db.to_dict(row) for row in conn.execute("SELECT * FROM requests")}

    holdout = [rows[ref] for ref in payments.loc[test, "request_ref"]]
    flagged = [any(flag.startswith("ml_high_risk:") for flag in row["flags"]) for row in holdout]
    if flagged != (holdout_risk >= bundle["threshold"]).tolist():
        raise ValueError("Operational screening and offline holdout scores disagree")
    holdout_ml = sum(flagged)
    flags = Counter(flag for row in rows.values() for flag in {f.partition(":")[0] for f in row["flags"]})
    report = {
        "rows": len(rows), "training_rows": int(train.sum()), "validation_rows": int(validation.sum()),
        "holdout_rows": len(holdout), "threshold": bundle["threshold"], "validation_review_budget": REVIEW_BUDGET,
        "feature_version": FIXED_HISTORY_VERSION, "ml_features": bundle["features"],
        "all_flags_by_type": dict(flags), "all_flagged": sum(bool(row["flags"]) for row in rows.values()),
        "holdout_ml_flagged": holdout_ml, "holdout_any_flag": sum(bool(row["flags"]) for row in holdout),
        "ml_sensitivity_by_group": dict(Counter(signal for row in rows.values() for signal in row["risk_signals"] or [])),
    }
    content = json.dumps(report, indent=2) + "\n"
    (output / "summary.json").write_text(content, encoding="utf-8")
    print(content)


if __name__ == "__main__":
    main()
