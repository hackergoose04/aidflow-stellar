"""Monthly payment features for the Auxílio Emergencial offline benchmark."""
from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np
import pandas as pd


FEATURES = [
    "log_amount",
    "log_amount_ratio_cohort",
    "log_amount_ratio_beneficiary",
    "prior_beneficiary_months",
    "missing_beneficiary_history",
]
HISTORICAL_AMOUNT_SURPRISAL = "historical_amount_surprisal"
_MIN_AMOUNT_GROUP_SIZE = 20


def valid_installments(values: pd.Series) -> pd.Series:
    """Normalize positive integer installment numbers and leave invalid values missing."""
    if pd.api.types.is_bool_dtype(values.dtype):
        return pd.Series(np.nan, index=values.index)
    if not pd.api.types.is_numeric_dtype(values.dtype):
        values = values.astype("string")
    numeric = pd.to_numeric(values, errors="coerce")
    return numeric.where(numeric.gt(0) & numeric.mod(1).eq(0))


def _historical_amount_surprisal(ordered: pd.DataFrame) -> np.ndarray:
    """Score each amount using cumulative counts from earlier months only."""
    scores = np.zeros(len(ordered))
    installment_history: dict[tuple[str, int], Counter[float]] = defaultdict(Counter)
    cohort_history: dict[str, Counter[float]] = defaultdict(Counter)
    global_history: Counter[float] = Counter()
    for _, current in ordered.groupby("month", sort=False):
        groups = current.groupby(["cohort", "installment", "amount"], sort=False, observed=True, dropna=False)
        counts = groups.size()
        if global_history:
            group_scores = []
            for cohort, installment, amount in counts.index:
                history = installment_history.get((cohort, installment)) if pd.notna(installment) else None
                if history is None or history.total() < _MIN_AMOUNT_GROUP_SIZE:
                    history = cohort_history.get(cohort)
                if history is None or history.total() < _MIN_AMOUNT_GROUP_SIZE:
                    history = global_history

                # Include one additional bucket for amounts absent from the history.
                probability = (history[amount] + 1) / (history.total() + len(history) + 1)
                group_scores.append(-np.log(probability))

            # ngroup follows the same group order as size, without a MultiIndex per row.
            scores[current.index] = np.asarray(group_scores)[groups.ngroup().to_numpy()]

        # Update only after scoring every payment in this month.
        for (cohort, installment, amount), count in counts.items():
            if pd.notna(installment):
                installment_history[cohort, installment][amount] += count
            cohort_history[cohort][amount] += count
            global_history[amount] += count

    return scores


def build_features(payments: pd.DataFrame, *, include_amount_frequency: bool = False) -> pd.DataFrame:
    """Score each payment against history from strictly earlier YYYYMM months.

    The caller supplies positive amounts and stable beneficiary and cohort keys.
    The optional installment is used when valid. Output rows retain the input
    order and index. The first month has neutral amount deviations, so use it as
    history before training.
    `same_month_repeat` is a batch-level rule and is separate from FEATURES.
    The optional amount frequency feature is the negative log of the smoothed
    amount probability within the historical cohort and installment. Sparse
    groups fall back to cohort or global history. The first month receives 0.
    """
    rows = payments[["beneficiary_id", "month", "cohort", "amount"]].reset_index(drop=True)
    rows["amount"] = pd.to_numeric(rows["amount"])
    rows["month"] = pd.to_numeric(rows["month"])
    if (
        rows.isna().any().any()
        or not np.isfinite(rows["amount"]).all()
        or not rows["amount"].gt(0).all()
        or not rows["month"].between(100001, 999912).all()
        or not rows["month"].mod(1).eq(0).all()
        or not rows["month"].mod(100).between(1, 12).all()
    ):
        raise ValueError("Expected complete payment keys, YYYYMM months and finite positive amounts.")

    if "installment" in payments:
        rows["installment"] = valid_installments(payments["installment"]).reset_index(drop=True)
    else:
        rows["installment"] = np.nan
    log_amount = np.log(rows["amount"])
    features = pd.DataFrame(
        {
            "log_amount": log_amount,
            "log_amount_ratio_cohort": 0.0,
            "log_amount_ratio_beneficiary": 0.0,
            "prior_beneficiary_months": 0,
            "missing_beneficiary_history": 1,
            "same_month_repeat": rows["installment"].notna()
            & rows.duplicated(["beneficiary_id", "month", "installment"], keep=False),
        }
    )

    ordered = rows.sort_values("month", kind="stable")
    history_rows = 0
    for _, current in ordered.groupby("month", sort=False):
        history = ordered.iloc[:history_rows]
        history_rows += len(current)
        if history.empty:
            continue

        cohort_medians = history.groupby("cohort", observed=True)["amount"].median()
        cohort_reference = current["cohort"].map(cohort_medians).astype(float).fillna(history["amount"].median())

        beneficiary_history = history.groupby("beneficiary_id", observed=True)
        beneficiary_medians = beneficiary_history["amount"].median()
        beneficiary_reference = current["beneficiary_id"].map(beneficiary_medians).astype(float)
        months_by_beneficiary = beneficiary_history["month"].nunique()
        prior_months = current["beneficiary_id"].map(months_by_beneficiary).astype(float).fillna(0).astype(int)

        index = current.index
        features.loc[index, "log_amount_ratio_cohort"] = log_amount.loc[index] - np.log(cohort_reference)
        features.loc[index, "log_amount_ratio_beneficiary"] = (
            log_amount.loc[index] - np.log(beneficiary_reference.fillna(cohort_reference))
        )
        features.loc[index, "prior_beneficiary_months"] = prior_months
        features.loc[index, "missing_beneficiary_history"] = beneficiary_reference.isna().astype(int)

    if include_amount_frequency:
        features[HISTORICAL_AMOUNT_SURPRISAL] = _historical_amount_surprisal(ordered)

    features.index = payments.index
    return features
