"""Evaluate the model on unseen data (ml/data/test.csv) and compare it with the backend's
simple rules. Writes ml/reports/metrics.json and prints a summary.

  python -m ml.evaluate
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, precision_score, recall_score, roc_auc_score

from .features import build_features
from .score import anomaly_scores, load, risk_from_scores, threshold

ROOT = Path(__file__).resolve().parent
TEST = ROOT / "data" / "test.csv"
REPORT = ROOT / "reports" / "metrics.json"
AMOUNT_LIMIT = 500  # same as backend config.AMOUNT_LIMIT


def rule_flags(X: pd.DataFrame, df: pd.DataFrame) -> np.ndarray:
    """What the backend's rules would flag, for comparison: amount limit, shared wallet
    (both rows), dedup (only the LATER of two same-amount requests within 24 h), and
    wallet change (a later request into a different wallet than an earlier one), and
    same batch (a later request by someone already in that disbursement batch)."""
    t = pd.to_datetime(df["created_at"], utc=True, format="ISO8601")
    later_dup = np.zeros(len(df), dtype=bool)
    for idx in df.groupby("beneficiary_id").indices.values():
        idx = idx[np.argsort(t.iloc[idx].to_numpy())]
        for k in range(1, len(idx)):
            i = idx[k]
            earlier = idx[:k]
            close = (t.iloc[i] - t.iloc[earlier]).dt.total_seconds().to_numpy() <= 24 * 3600
            later_dup[i] = bool((close & (df["amount"].iloc[earlier].to_numpy() == df["amount"].iloc[i])).any())
            later_dup[i] |= bool((df["wallet"].iloc[earlier] != df["wallet"].iloc[i]).any())
            if "batch_id" in df:
                later_dup[i] |= bool((df["batch_id"].iloc[earlier] == df["batch_id"].iloc[i]).any())
    return (df["amount"] > AMOUNT_LIMIT).to_numpy() | (X["wallet_ben_count"] > 1).to_numpy() | later_dup


def summarise(y: np.ndarray, pred: np.ndarray, labels: pd.Series) -> dict:
    per_type = {t: float(pred[(labels == t).to_numpy()].mean())
                for t in sorted(labels.unique()) if t != "normal"}
    return {"precision": round(float(precision_score(y, pred, zero_division=0)), 3),
            "recall": round(float(recall_score(y, pred)), 3),
            "flagged": int(pred.sum()),
            "false_alarms": int((pred & ~y).sum()),
            "false_positive_rate": round(float((pred & ~y).sum() / (~y).sum()), 3),
            # Review workload: share of all requests a person must look at (all-manual = 1.0).
            "review_share": round(float(pred.mean()), 3),
            "workload_reduction": round(float(1 - pred.mean()), 3),
            "recall_by_type": {k: round(v, 3) for k, v in per_type.items()}}


def main() -> None:
    bundle = load()
    if bundle is None:
        raise SystemExit("no model: run python -m ml.train first")
    df = pd.read_csv(TEST)
    y = (df["label"] != "normal").to_numpy()
    X = build_features(df)
    risk = risk_from_scores(bundle, anomaly_scores(bundle, X))

    cut = threshold()
    ml_pred = risk >= cut
    rules_pred = rule_flags(X, df)
    report = {
        "test_rows": len(df), "anomalies": int(y.sum()), "threshold": cut,
        "roc_auc": round(float(roc_auc_score(y, risk)), 3),
        "average_precision": round(float(average_precision_score(y, risk)), 3),
        "ml": summarise(y, ml_pred, df["label"]),
        "rules": summarise(y, rules_pred, df["label"]),
        "rules_or_ml": summarise(y, ml_pred | rules_pred, df["label"]),
        # Baseline from the design doc: every request reviewed by a person.
        "manual_all": summarise(y, np.ones(len(y), dtype=bool), df["label"]),
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2))

    print(f"test set: {report['test_rows']} rows, {report['anomalies']} anomalies")
    print(f"ROC AUC {report['roc_auc']}   average precision {report['average_precision']}"
          f"   (threshold risk >= {cut})\n")
    types = list(report["ml"]["recall_by_type"])
    print(f"{'':12s}{'precision':>10s}{'recall':>8s}{'false+':>8s}{'review':>8s}  " + "".join(f"{t[:14]:>15s}" for t in types))
    for name in ["manual_all", "rules", "ml", "rules_or_ml"]:
        r = report[name]
        print(f"{name:12s}{r['precision']:>10.2f}{r['recall']:>8.2f}{r['false_alarms']:>8d}{r['review_share']:>8.0%}  "
              + "".join(f"{r['recall_by_type'][t]:>15.2f}" for t in types))
    print(f"\nwritten to {REPORT.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
