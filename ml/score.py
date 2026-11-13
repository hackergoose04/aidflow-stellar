"""Load the trained model and turn requests into a 0..1 risk score.

risk = share of training requests that looked *less* anomalous than this one.
So risk 0.97 means "stranger than 97% of what the model has seen"."""
from __future__ import annotations

from functools import lru_cache
import os
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from .features import BEHAVIOR_FEATURES, FEATURES, FIXED_HISTORY_VERSION, build_features, build_fixed_features

MODEL_PATH = Path(__file__).resolve().parent / "models" / "isoforest.joblib"
DEFAULT_THRESHOLD = 0.9  # used only if the model bundle has no tuned threshold
FEATURE_GROUPS = {
    "amount": ("log_amount", "amount_vs_global", "amount_vs_own"),
    "time_of_day": ("hour_sin", "hour_cos"),
    "recent_activity": ("ben_requests_24h", "same_amount_24h", "log_gap_hours"),
    "wallet_history": ("wallet_ben_count", "ben_wallet_count"),
}


@lru_cache(maxsize=1)
def load() -> dict | None:
    override = os.getenv("AIDFLOW_MODEL_PATH")
    path = Path(override) if override else MODEL_PATH
    if not override and not path.exists():
        return None
    bundle = joblib.load(path)
    columns = bundle["features"]
    if not columns or len(set(columns)) != len(columns) or set(columns) - set(FEATURES):
        raise ValueError("model bundle contains unsupported features")
    version = bundle.get("feature_version")
    if version is not None and version != FIXED_HISTORY_VERSION:
        raise ValueError(f"unsupported model feature version: {version}")
    if version == FIXED_HISTORY_VERSION:
        median = bundle["amount_reference_median"]
        if not np.isfinite(median) or median <= 0 or not bundle.get("program") or not bundle.get("asset"):
            raise ValueError("fixed-reference model requires a positive amount median, program and asset")
    return bundle


def threshold() -> float:
    bundle = load()
    return bundle.get("threshold", DEFAULT_THRESHOLD) if bundle else DEFAULT_THRESHOLD


def active_threshold(program: str, asset: str) -> float | None:
    bundle = load()
    if bundle is None or set(bundle["features"]) - set(BEHAVIOR_FEATURES):
        return None
    if bundle.get("feature_version") != FIXED_HISTORY_VERSION or (bundle["program"], bundle["asset"]) != (program, asset):
        return None
    return threshold()


def model_features(bundle: dict, frame: pd.DataFrame) -> pd.DataFrame:
    if bundle.get("feature_version") == FIXED_HISTORY_VERSION:
        return build_fixed_features(frame, bundle["amount_reference_median"])
    return build_features(frame)


def anomaly_scores(bundle: dict, X: pd.DataFrame) -> np.ndarray:
    """Higher = more anomalous (sklearn's score_samples is the opposite)."""
    return -bundle["model"].score_samples(X[bundle["features"]])


def risk_from_scores(bundle: dict, scores: np.ndarray) -> np.ndarray:
    if "validation_scores" in bundle:
        ref = bundle["validation_scores"]
        return np.searchsorted(ref, scores, side="left") / len(ref)
    ref = bundle["train_scores"]  # sorted ascending
    return np.searchsorted(ref, scores, side="right") / len(ref)


def uses_validation_reference() -> bool:
    bundle = load()
    return bundle is not None and "validation_scores" in bundle


def explain_flags(history: pd.DataFrame, positions: list[int]) -> dict[int, list[str]]:
    """Find which groups lower the raw score when set to training medians."""
    bundle = load()
    if bundle is None or "training_feature_medians" not in bundle or not positions:
        return {}
    features = model_features(bundle, history).iloc[positions]
    original = anomaly_scores(bundle, features)
    medians = bundle["training_feature_medians"]
    drops = {}
    for group, columns in FEATURE_GROUPS.items():
        replacements = {column: medians[column] for column in columns if column in bundle["features"] and column in medians}
        if replacements:
            drops[group] = original - anomaly_scores(bundle, features.assign(**replacements))
    return {
        position: [group for group in sorted(drops, key=lambda key: -drops[key][i]) if drops[group][i] > 0.0001][:2]
        for i, position in enumerate(positions)
    }


def score_frame(df: pd.DataFrame) -> np.ndarray | None:
    """Risk for every row of df (rows see each other as history). None if no model."""
    bundle = load()
    if bundle is None or df.empty:
        return None
    return risk_from_scores(bundle, anomaly_scores(bundle, model_features(bundle, df)))
