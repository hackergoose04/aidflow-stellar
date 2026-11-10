"""Load the trained model and turn requests into a 0..1 risk score.

risk = share of training requests that looked *less* anomalous than this one.
So risk 0.97 means "stranger than 97% of what the model has seen"."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from .features import FEATURES, build_features

MODEL_PATH = Path(__file__).resolve().parent / "models" / "isoforest.joblib"
DEFAULT_THRESHOLD = 0.9  # used only if the model bundle has no tuned threshold


@lru_cache(maxsize=1)
def load() -> dict | None:
    if not MODEL_PATH.exists():
        return None
    bundle = joblib.load(MODEL_PATH)
    assert bundle["features"] == FEATURES, "model was trained on different features; retrain"
    return bundle


def threshold() -> float:
    bundle = load()
    return bundle.get("threshold", DEFAULT_THRESHOLD) if bundle else DEFAULT_THRESHOLD


def anomaly_scores(bundle: dict, X: pd.DataFrame) -> np.ndarray:
    """Higher = more anomalous (sklearn's score_samples is the opposite)."""
    return -bundle["model"].score_samples(X[FEATURES])


def risk_from_scores(bundle: dict, scores: np.ndarray) -> np.ndarray:
    ref = bundle["train_scores"]  # sorted ascending
    return np.searchsorted(ref, scores, side="right") / len(ref)


def score_frame(df: pd.DataFrame) -> np.ndarray | None:
    """Risk for every row of df (rows see each other as history). None if no model."""
    bundle = load()
    if bundle is None or df.empty:
        return None
    return risk_from_scores(bundle, anomaly_scores(bundle, build_features(df)))
