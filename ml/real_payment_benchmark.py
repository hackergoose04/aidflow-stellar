"""Fit AidFlow's existing Isolation Forest on a cached, public Stellar payment CSV.

Run: python -m ml.real_payment_benchmark ml/data/mainnet_GAUA7XL5.csv
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

from .aid_benchmark import (
    OUTPUT, REVIEW_BUDGET, compare, features_by_upload, make_aid_requests,
)
from .features import FEATURES, build_features
from .generate import generate
from . import score

# Mainnet exposes one wallet per payment, without a separate beneficiary identifier.
PAYMENT_FEATURES = [name for name in FEATURES if name not in {"wallet_ben_count", "ben_wallet_count"}]


def chronological_split(windows):
    if len(windows) < 50:
        raise ValueError("Need at least 50 valid USDC payments")
    cut_train = windows.iat[int(len(windows) * 0.6)]
    cut_val = windows.iat[int(len(windows) * 0.8)]
    train = windows < cut_train
    validation = windows.between(cut_train, cut_val, inclusive="left")
    test = windows >= cut_val
    if not train.any() or not validation.any() or not test.any():
        raise ValueError("The payments do not span enough replay windows for a chronological split")
    return train, validation, test


def holdout_flags(train, validation, holdout, columns):
    model = IsolationForest(n_estimators=300, max_samples=256, contamination="auto", random_state=0)
    model.fit(train[columns])
    validation_scores = -model.score_samples(validation[columns])
    cutoff = float(np.sort(validation_scores)[::-1][int(len(validation_scores) * REVIEW_BUDGET)])
    return -model.score_samples(holdout[columns]) > cutoff


def compare_time_of_day(features, train, validation, test):
    """Ablate the clock features with the same holdout and validation workload."""
    synthetic_train, synthetic_validation, synthetic_test = [generate(800, seed) for seed in (1, 3, 2)]
    aid_train, aid_validation, aid_test = map(build_features, (synthetic_train, synthetic_validation, synthetic_test))
    anomaly = synthetic_test["label"].ne("normal").to_numpy()
    night = synthetic_test["label"].eq("night_new_ben").to_numpy()
    usdc_test = features.loc[test]
    result = {
        "validation_review_budget": REVIEW_BUDGET,
        "usdc_holdout_rows": len(usdc_test),
        "synthetic_holdout_anomalies": int(anomaly.sum()),
        "synthetic_holdout_night_cases": int(night.sum()),
        "variants": {},
    }
    shipped = score.load()
    if shipped is not None:
        shipped_threshold = score.threshold()
        shipped_risk = score.risk_from_scores(shipped, score.anomaly_scores(shipped, usdc_test))
        result["shipped_model_threshold"] = shipped_threshold
        result["shipped_model_usdc_flags"] = int((shipped_risk.round(3) >= shipped_threshold).sum())
    for include_time in (True, False):
        columns = FEATURES if include_time else [f for f in FEATURES if f not in {"hour_sin", "hour_cos"}]
        payment_columns = [f for f in columns if f in PAYMENT_FEATURES]
        aid_flags = holdout_flags(aid_train, aid_validation, aid_test, columns)
        result["variants"]["with_time_of_day" if include_time else "without_time_of_day"] = {
            "synthetic_trained_usdc_flags": int(holdout_flags(aid_train, aid_validation, usdc_test, columns).sum()),
            "usdc_trained_usdc_flags": int(holdout_flags(
                features.loc[train], features.loc[validation], usdc_test, payment_columns,
            ).sum()),
            "synthetic_holdout_anomalies_found": int((aid_flags & anomaly).sum()),
            "synthetic_holdout_night_cases_found": int((aid_flags & night).sum()),
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path)
    parser.add_argument("--compare-time-of-day", action="store_true", help="Compare clock features on the same USDC holdout")
    args = parser.parse_args()

    raw = pd.read_csv(args.csv, dtype={"request_ref": "string"})
    raw["amount"] = pd.to_numeric(raw["amount"], errors="coerce")
    raw["created_at"] = pd.to_datetime(raw["created_at"], utc=True, format="mixed", errors="coerce")
    valid = raw.dropna(subset=["request_ref", "wallet", "created_at", "amount"])
    clean = valid[(valid["asset"] == "USDC") & np.isfinite(valid["amount"]) & (valid["amount"] > 0)]
    clean = clean.drop_duplicates("request_ref").sort_values(["created_at", "request_ref"]).reset_index(drop=True)
    clean["beneficiary_id"] = clean["wallet"]  # A proxy for repeat payments to the same address.
    clean["upload_id"] = clean["created_at"].dt.floor("5min").dt.strftime("%Y-%m-%dT%H:%M")
    clean["batch_id"] = clean["upload_id"]  # Replay window, not an NGO payment batch.
    train, validation, test = chronological_split(clean["upload_id"])

    all_features = features_by_upload(clean, "upload_id")
    features = all_features[PAYMENT_FEATURES]
    test_flags = holdout_flags(features.loc[train], features.loc[validation], features.loc[test], PAYMENT_FEATURES)

    aid = make_aid_requests()
    aid_features = features_by_upload(aid, "upload_id")[PAYMENT_FEATURES]
    aid_train = aid_features.loc[aid["split"] == "train"]
    n = min(len(aid_train), int(train.sum()))
    report = {
        "source_csv": args.csv.name,
        "features": PAYMENT_FEATURES,
        "downloaded_usdc_rows": len(raw),
        "clean_rows": len(clean),
        "recipient_wallets": int(clean["wallet"].nunique()),
        "from_utc": clean["created_at"].iloc[0].isoformat(),
        "to_utc": clean["created_at"].iloc[-1].isoformat(),
        "real_split_rows": {"train": int(train.sum()), "validation": int(validation.sum()), "test": int(test.sum())},
        "real_test_flags_without_labels": int(test_flags.sum()),
        "real_test_flag_rate_without_labels": round(float(test_flags.mean()), 4),
        "training_rows_per_model_on_simulated_aid_test": n,
        "real_training_on_simulated_aid_test": compare(
            aid_features, aid, features.loc[train].sample(n, random_state=27),
        ),
        "simulated_training_on_simulated_aid_test": compare(
            aid_features, aid, aid_train.sample(n, random_state=27),
        ),
    }
    if args.compare_time_of_day:
        report["time_of_day_comparison"] = compare_time_of_day(all_features, train, validation, test)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    clean.to_csv(OUTPUT / "real_usdc_clean.csv", index=False)
    (OUTPUT / "real_usdc_shared_features.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
