"""Compare training data for AidFlow's Isolation Forest without replacing the live model.

Run from the repository root: python -m ml.aid_benchmark
Outputs go to ml/data/aid_benchmark/.
"""
from __future__ import annotations

import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.metrics import average_precision_score
from stellar_sdk import Keypair

from .evaluate import summarise
from .features import FEATURES, build_features
from .generate import generate

OUTPUT = Path(__file__).resolve().parent / "data" / "aid_benchmark"
REQUEST_COLUMNS = ["request_ref", "batch_id", "beneficiary_id", "wallet", "amount", "asset", "created_at"]
REVIEW_BUDGET = 0.10


def make_aid_requests() -> pd.DataFrame:
    """Generate a fictional household programme informed by public aid reports."""
    rng = random.Random(27)
    rows = []

    def new_wallet() -> str:
        return Keypair.from_raw_ed25519_seed(rng.randbytes(32)).public_key

    wallets = [new_wallet() for _ in range(320)]
    household_sizes = rng.choices([1, 2, 3, 4, 5], [20, 30, 25, 18, 7], k=len(wallets))
    shared_wallet = new_wallet()

    def add(household, wallet, amount, when, period, wave, scenario, needs_review=False):
        rows.append({
            "request_ref": f"AID-{len(rows) + 1:05d}",
            "batch_id": f"MONTH-{period:02d}",
            "beneficiary_id": f"HH-{household:04d}",
            "wallet": wallet,
            "amount": amount,
            "asset": "AIDUSD",
            "created_at": when.isoformat(),
            "upload_id": f"MONTH-{period:02d}-W{wave}",
            "split": "train" if period <= 5 else "validation" if period <= 8 else "test",
            "scenario": scenario,
            "label": scenario if needs_review else "normal",
        })

    for period in range(1, 13):
        month = datetime(2026, period, 1, tzinfo=timezone.utc)
        active = range(260) if period <= 8 else range(len(wallets))
        for household in active:
            if rng.random() < 0.07:
                continue  # Not every household appears in every month.
            wave = household % 4
            when = month + timedelta(days=wave * 6 + rng.randrange(3), hours=rng.randint(8, 19),
                                     minutes=rng.randrange(60))
            # The unit amount, weights, channels and error rates are simulation assumptions.
            amount = 85 * household_sizes[household]
            event = rng.random()
            wallet = wallets[household]
            if event < 0.025:
                wallets[household] = new_wallet()
                add(household, wallets[household], amount, when, period, wave, "approved_wallet_change")
            elif event < 0.05:
                add(household, shared_wallet, amount, when, period, wave, "authorized_shared_wallet")
            elif event < 0.075:
                add(household, wallet, amount + 85, when, period, wave, "approved_top_up")
            elif event < 0.10:
                wrong_amount = amount + (85 if period >= 9 else 170)
                add(household, wallet, wrong_amount, when, period, wave, "incorrect_amount", True)
            elif event < 0.125:
                other = (household + rng.randrange(1, len(active))) % len(active)
                add(household, wallets[other], amount, when, period, wave, "unapproved_wallet_reuse", True)
            else:
                add(household, wallet, amount, when, period, wave, "scheduled_installment")
                if event < 0.16:
                    delay = timedelta(hours=rng.randint(1, 60) if period >= 9 else rng.randint(1, 18))
                    add(household, wallet, amount, when + delay, period, wave, "duplicate_installment", True)
    return pd.DataFrame(rows)


def features_by_upload(requests: pd.DataFrame, upload_column: str) -> pd.DataFrame:
    """Use only the current upload and previous uploads when calculating each row."""
    history = requests.iloc[:0][REQUEST_COLUMNS]
    features = []
    for _, upload in requests.groupby(upload_column, sort=True):
        history = pd.concat([history, upload[REQUEST_COLUMNS]])
        features.append(build_features(history).loc[upload.index])
    return pd.concat(features).loc[requests.index, FEATURES]


def top_budget(scores: np.ndarray) -> np.ndarray:
    flags = np.zeros(len(scores), dtype=bool)
    count = int(len(scores) * REVIEW_BUDGET)
    flags[np.argsort(-scores, kind="stable")[:count]] = True
    return flags


def compare(features: pd.DataFrame, requests: pd.DataFrame, train: pd.DataFrame) -> dict:
    model = IsolationForest(n_estimators=300, max_samples=256, contamination="auto", random_state=0).fit(train)
    val = requests[requests["split"] == "validation"]
    test = requests[requests["split"] == "test"]
    val_scores = -model.score_samples(features.loc[val.index])
    scores = -model.score_samples(features.loc[test.index])
    # In a tie at the validation boundary, exclude the tied score to stay within capacity.
    cutoff = float(np.sort(val_scores)[::-1][int(len(val_scores) * REVIEW_BUDGET)])
    labels = test["label"]
    y = (labels != "normal").to_numpy()
    fixed_budget = top_budget(scores)
    return {
        "average_precision": round(float(average_precision_score(y, scores)), 4),
        "validation_cutoff_raw_score": cutoff,
        "validation_flagged": int((val_scores > cutoff).sum()),
        "locked_cutoff": summarise(y, scores > cutoff, labels),
        "fixed_test_budget": summarise(y, fixed_budget, labels),
        "caught_at_fixed_budget": int((fixed_budget & y).sum()),
        "legitimate_flags_at_fixed_budget": {
            str(scenario): int(fixed_budget[positions].sum())
            for scenario, positions in test.groupby("scenario").indices.items()
            if not y[positions].any()
        },
    }


def main() -> None:
    requests = make_aid_requests()
    original = generate(800, seed=1)
    old_features = features_by_upload(original, "batch_id")
    new_features = features_by_upload(requests, "upload_id")
    aid_training = new_features.loc[requests["split"] == "train"]
    n_train = min(len(old_features), len(aid_training))
    report = {
        "dataset": "Synthetic household cash assistance benchmark; no real beneficiary or chain records",
        "review_budget": REVIEW_BUDGET,
        "training_rows_per_model": n_train,
        "training_sampling_seed": 27,
        "split_rows": requests["split"].value_counts().to_dict(),
        "split_anomalies": requests.loc[requests["label"] != "normal", "split"].value_counts().to_dict(),
        "old_training_data": compare(new_features, requests, old_features.sample(n_train, random_state=27)),
        "new_training_data": compare(new_features, requests, aid_training.sample(n_train, random_state=27)),
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for split, rows in requests.groupby("split"):
        rows[REQUEST_COLUMNS].to_csv(OUTPUT / f"{split}_requests.csv", index=False)
    requests[["request_ref", "split", "upload_id", "scenario", "label"]].to_csv(OUTPUT / "labels.csv", index=False)
    (OUTPUT / "comparison.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
