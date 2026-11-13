"""Train the Isolation Forest on ml/data/train.csv and save ml/models/isoforest.joblib.

Isolation Forest is unsupervised: it is fitted without the labels. It learns what "usual"
requests look like and scores how easy a request is to isolate from the rest.
The labels are used only afterwards, to pick the flag threshold (best F1 on train).

  python -m ml.generate && python -m ml.train && python -m ml.evaluate
"""
from __future__ import annotations

import json
import argparse
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import IsolationForest
from sklearn.metrics import f1_score

from .features import BEHAVIOR_FEATURES, FEATURES, FIXED_HISTORY_VERSION, build_features, build_fixed_features
from .score import MODEL_PATH, anomaly_scores, risk_from_scores

DATA = MODEL_PATH.parents[1] / "data" / "train.csv"


def fit_fixed_model(history: pd.DataFrame, train, validation, *, program: str, columns: list[str],
                    review_budget: float) -> tuple[dict, pd.DataFrame]:
    """Fit and calibrate a single-program model using disjoint historical windows."""
    arrivals = pd.to_datetime(history["available_at"], utc=True, format="ISO8601")
    assets = history["asset"].unique()
    if (len(assets) != 1 or arrivals.isna().any() or not train.any() or not validation.any()
            or arrivals[train].max() >= arrivals[validation].min() or not 0 < review_budget < 1):
        raise ValueError("Provide a single asset and non-overlapping training and validation windows")
    median = float(history.loc[train, "amount"].astype(float).median())
    if not np.isfinite(median) or median <= 0:
        raise ValueError("Training amount median must be positive and finite")
    features = build_fixed_features(history, median)
    training = features.loc[train, columns]
    model = IsolationForest(n_estimators=300, max_samples=256, contamination="auto", random_state=0).fit(training)
    bundle = {
        "model": model, "features": columns, "feature_version": FIXED_HISTORY_VERSION,
        "program": program, "asset": str(assets[0]), "amount_reference_median": median,
        "training_through": arrivals[train].max().isoformat(),
        "training_feature_medians": training.median().to_dict(),
    }
    reference = np.sort(anomaly_scores(bundle, features.loc[validation]))
    bundle["validation_scores"] = reference
    bundle["threshold"] = (len(reference) - int(len(reference) * review_budget)) / len(reference)
    return bundle, features


def main() -> None:
    parser = argparse.ArgumentParser(description="Train an AidFlow Isolation Forest")
    parser.add_argument("--fixed-history", type=Path, help="Program CSV with available_at and a chronological split column")
    parser.add_argument("--program", default="AIDFLOW-DEMO")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--review-budget", type=float, default=0.10)
    args = parser.parse_args()
    if args.fixed_history:
        if args.output is None:
            parser.error("Set --output for a fixed-history model")
        history = pd.read_csv(args.fixed_history, dtype={"request_ref": str})
        train, validation, test = (history["split"].eq(name) for name in ("train", "validation", "test"))
        available = pd.to_datetime(history["available_at"], utc=True, format="ISO8601")
        if not test.any() or not (train | validation | test).all() or available[validation].max() >= available[test].min():
            parser.error("Provide chronological train, validation and test windows")
        bundle, features = fit_fixed_model(history, train, validation, program=args.program,
                                           columns=BEHAVIOR_FEATURES, review_budget=args.review_budget)
        risk = risk_from_scores(bundle, anomaly_scores(bundle, features.loc[test]))
        flags = risk >= bundle["threshold"]
        args.output.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(bundle, args.output)
        report = {"train": int(train.sum()), "validation": int(validation.sum()), "holdout": int(test.sum()),
                  "holdout_flagged": int(flags.sum()), "threshold": bundle["threshold"]}
        if "label" in history:
            labels = history.loc[test, "label"]
            labeled = labels.isin(["normal", "anomaly"]).to_numpy()
            positive = labels.eq("anomaly").to_numpy()
            report.update(holdout_labeled=int(labeled.sum()), holdout_labeled_anomalies=int(positive.sum()),
                          holdout_labeled_anomalies_flagged=int((flags & positive).sum()))
        print(json.dumps(report))
        return
    df = pd.read_csv(DATA)
    X = build_features(df)
    model = IsolationForest(n_estimators=300, max_samples=256, contamination="auto",
                            random_state=0).fit(X)
    bundle = {"model": model, "features": FEATURES}
    bundle["train_scores"] = np.sort(anomaly_scores(bundle, X))

    y = (df["label"] != "normal").to_numpy()
    risk = risk_from_scores(bundle, anomaly_scores(bundle, X))
    candidates = np.round(np.arange(0.70, 0.995, 0.005), 3)
    f1 = [f1_score(y, risk >= c) for c in candidates]
    bundle["threshold"] = float(candidates[int(np.argmax(f1))])
    bundle["meta"] = {"trained_at": datetime.now(timezone.utc).isoformat(), "rows": len(df),
                      "sklearn": sklearn.__version__}
    output = args.output or MODEL_PATH
    output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, output)
    print(f"trained on {len(df)} rows -> {output.name}; "
          f"threshold risk >= {bundle['threshold']} (train F1 {max(f1):.2f})")
    print(json.dumps(bundle["meta"]))


if __name__ == "__main__":
    main()
