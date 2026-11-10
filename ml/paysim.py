"""Layer-1 test: labelled fraud from PaySim (Kaggle "Synthetic Financial Datasets For
Fraud Detection", simulated from a real African mobile-money operator's logs).

Put the CSV in ml/data/paysim/ (see README), then:

  python -m ml.paysim

What is mapped, and what is deliberately not:
  * Only TRANSFER rows: money sent to a recipient account, the closest thing to a payout.
  * beneficiary_id = wallet = nameDest, amount = amount, created_at = step hours from a start.
  * The sender's balances (which give PaySim fraud away: 96% of frauds empty the victim's
    account) are NOT used. AidFlow never sees them, so using them would flatter the result.

Honest split: the model is fitted label-free on hours 1-400 and evaluated on hours 401+.
Results are reported at review budgets: "if reviewers can look at X% of payouts, which
share of the fraud is in that X%?"
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest
from sklearn.metrics import average_precision_score, roc_auc_score

from .features import FEATURES, build_features
from .score import anomaly_scores, load

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "data" / "paysim" / "PS_20174392719_1491204439457_log.csv"
REPORT = ROOT / "reports" / "paysim.json"
SPLIT_STEP = 400
BUDGETS = [0.01, 0.05, 0.10]
START = datetime(2026, 1, 1, tzinfo=timezone.utc)


def load_transfers() -> pd.DataFrame:
    df = pd.read_csv(SRC, usecols=["step", "type", "amount", "nameDest", "isFraud"])
    df = df[df["type"] == "TRANSFER"].reset_index(drop=True)
    return pd.DataFrame({
        "request_ref": [f"PS-{i}" for i in range(len(df))],
        "beneficiary_id": df["nameDest"], "wallet": df["nameDest"],
        "amount": df["amount"], "asset": "PAYSIM",
        "created_at": [(START + timedelta(hours=int(s))).isoformat() for s in df["step"]],
        "step": df["step"], "fraud": df["isFraud"].astype(bool),
    })


def at_budget(y: np.ndarray, score: np.ndarray, budget: float) -> dict:
    """Review the top `budget` share by score: what share of fraud is caught, and how pure?"""
    k = max(1, int(len(score) * budget))
    top = np.argsort(-score)[:k]
    caught = y[top].sum()
    return {"review_share": budget, "fraud_caught": round(float(caught / y.sum()), 3),
            "precision": round(float(caught / k), 3)}


def evaluate(name: str, y: np.ndarray, score: np.ndarray) -> dict:
    return {"method": name, "roc_auc": round(float(roc_auc_score(y, score)), 3),
            "average_precision": round(float(average_precision_score(y, score)), 4),
            "at_budget": [at_budget(y, score, b) for b in BUDGETS]}


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"missing {SRC}; download PaySim from Kaggle (see ml/README.md)")
    df = load_transfers()
    print(f"{len(df)} transfers, {df['fraud'].sum()} fraud ({df['fraud'].mean():.2%}); building features…")
    X = build_features(df)  # each row sees the whole history of its recipient
    train, test = (df["step"] <= SPLIT_STEP).to_numpy(), (df["step"] > SPLIT_STEP).to_numpy()
    y = df["fraud"].to_numpy()[test]
    Xte = X[test]

    results = []
    # 1. Random review: the baseline any method has to beat.
    results.append(evaluate("random review", y, np.random.default_rng(0).random(len(y))))
    # 2. Our shipped model, trained on our synthetic aid data.
    results.append(evaluate("model as shipped (synthetic-trained)", y, anomaly_scores(load(), Xte)))
    # 3. Same algorithm, fitted label-free on PaySim's own earlier history (as a deployment would).
    own = IsolationForest(n_estimators=300, max_samples=256, random_state=0).fit(X[train])
    results.append(evaluate("model refit on own history", y, -own.score_samples(Xte)))
    # 4. Rules, adapted: amount above the training 99th percentile, or a same-amount repeat.
    p99 = df.loc[train, "amount"].quantile(0.99)
    rules = ((df["amount"] > p99).to_numpy() | (X["same_amount_24h"] > 0).to_numpy())[test]
    rule_flag_rate = float(rules.mean())
    rule_hits = y[rules].sum()

    single = {f: round(float(max(roc_auc_score(y, Xte[f]), 1 - roc_auc_score(y, Xte[f]))), 3)
              for f in FEATURES if Xte[f].nunique() > 1}

    report = {
        "transfers": len(df), "fraud": int(df["fraud"].sum()),
        "train_rows": int(train.sum()), "test_rows": int(test.sum()), "test_fraud": int(y.sum()),
        "results": results,
        "rules": {"flag_rate": round(rule_flag_rate, 4),
                  "fraud_caught": round(float(rule_hits / y.sum()), 3),
                  "precision": round(float(rule_hits / max(1, rules.sum())), 3)},
        "single_feature_auc": dict(sorted(single.items(), key=lambda kv: -kv[1])),
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2))

    print(f"test: {report['test_rows']} transfers, {report['test_fraud']} fraud\n")
    print(f"{'method':40s}{'ROC AUC':>9s}   fraud caught when reviewing top 1% / 5% / 10%")
    for r in results:
        b = r["at_budget"]
        print(f"{r['method']:40s}{r['roc_auc']:>9.3f}   "
              + " / ".join(f"{x['fraud_caught']:.0%} (prec {x['precision']:.1%})" for x in b))
    ru = report["rules"]
    print(f"{'rules (amount > p99, repeat amount)':40s}{'':>9s}   flags {ru['flag_rate']:.1%}, "
          f"catches {ru['fraud_caught']:.0%} (prec {ru['precision']:.1%})")
    print("\nwhich features carry signal (AUC of each alone; 0.5 = none):")
    for f, a in report["single_feature_auc"].items():
        print(f"  {f:20s} {a:.3f}")
    print(f"\nwritten to {REPORT.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    main()
