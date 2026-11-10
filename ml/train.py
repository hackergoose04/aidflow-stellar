"""Train the Isolation Forest on ml/data/train.csv and save ml/models/isoforest.joblib.

Isolation Forest is unsupervised: it is fitted without the labels. It learns what "usual"
requests look like and scores how easy a request is to isolate from the rest.
The labels are used only afterwards, to pick the flag threshold (best F1 on train).

  python -m ml.generate && python -m ml.train && python -m ml.evaluate
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
import sklearn
from sklearn.ensemble import IsolationForest
from sklearn.metrics import f1_score

from .features import FEATURES, build_features
from .score import MODEL_PATH, anomaly_scores, risk_from_scores

DATA = MODEL_PATH.parents[1] / "data" / "train.csv"


def main() -> None:
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
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(bundle, MODEL_PATH)
    print(f"trained on {len(df)} rows -> {MODEL_PATH.name}; "
          f"threshold risk >= {bundle['threshold']} (train F1 {max(f1):.2f})")
    print(json.dumps(bundle["meta"]))


if __name__ == "__main__":
    main()
