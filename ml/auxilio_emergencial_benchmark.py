"""Fit and evaluate Isolation Forest on public monthly Auxílio Emergencial records."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

from .auxilio_emergencial_features import HISTORICAL_AMOUNT_SURPRISAL, build_features, valid_installments
from .prepare_auxilio_emergencial import SOURCE_URL


ML_DIR = Path(__file__).resolve().parent
DATA_DIR = ML_DIR / "data" / "auxilio_emergencial"
REPORT_PATH = ML_DIR / "reports" / "auxilio_emergencial_benchmark.json"
FREQUENCY_REPORT_PATH = ML_DIR / "reports" / "auxilio_emergencial_amount_frequency.json"
SCHEDULE_REPORT_PATH = ML_DIR / "reports" / "auxilio_emergencial_installment_schedule.json"
REVIEW_BUDGET = 0.10
DEFAULT_BENCHMARK_REVIEW_BUDGET = 0.01
# Cumulative installment numbers for the verified April–October 2021 phase.
OFFICIAL_INSTALLMENTS = dict(zip(range(202104, 202111), range(10, 17)))
OFFICIAL_ARCHIVE = re.compile(r"\d{6}_AuxilioEmergencial\.zip(?:\.part)?", re.IGNORECASE)
OFFICIAL_CSV = re.compile(r"\d{6}_AuxilioEmergencial\.csv(?:\.gz)?", re.IGNORECASE)
MODEL_PARAMS = {"n_estimators": 300, "max_samples": 256, "contamination": "auto", "random_state": 0}
STATUSES = ("returned", "held", "unknown")
WEIGHTS = (0.0, 0.25, 0.5, 0.75, 1.0)
AMOUNT_FEATURES = ["log_amount", "log_amount_ratio_cohort"]
HISTORY_FEATURES = [*AMOUNT_FEATURES, "log_amount_ratio_beneficiary"]
HISTORY_GROUPS = ("with_history", "without_history")


def resolve_installment_schedule(preparation: dict, overrides: dict[int, int] | None = None) -> dict[int, int]:
    """Return the calendar for a recognized official export or explicitly supplied periods."""
    sources = preparation.get("sources") or [
        {"file": name} for name in preparation.get("source_archives", [])
    ]
    official = preparation.get("source_url") == SOURCE_URL and bool(sources) and all(
        source.get("official_layout") is not False and (
            OFFICIAL_ARCHIVE.fullmatch(source.get("file") or "")
            or (source.get("official_layout") is True and OFFICIAL_CSV.fullmatch(source.get("file") or ""))
        )
        for source in sources
    )
    return {**(OFFICIAL_INSTALLMENTS if official else {}), **(overrides or {})}


def load_installment_schedule(data_dir: Path) -> dict[int, int]:
    """Load a dataset-specific calendar supplied by its payment administrator."""
    path = data_dir / "installment_schedule.json"
    if not path.is_file():
        return {}

    def read_entries(entries: list[tuple[str, object]]) -> dict[int, int]:
        schedule = {}
        for month, installment in entries:
            if type(installment) is not int:
                raise ValueError(f"{path.name} requires integer installments")
            try:
                period, number = parse_scheduled_installment(f"{month}={installment}")
            except argparse.ArgumentTypeError as exc:
                raise ValueError(f"{path.name}: {exc}") from exc
            if period in schedule:
                raise ValueError(f"{path.name} lists {period} more than once")
            schedule[period] = number
        return schedule

    schedule = json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=read_entries)
    if not isinstance(schedule, dict):
        raise ValueError(f"{path.name} requires a JSON object mapping YYYYMM to installment")
    return schedule


def load_data(data_dir: Path) -> tuple[pd.DataFrame, pd.Series]:
    payments = pd.read_csv(
        data_dir / "payments.csv",
        dtype={"record_id": str, "beneficiary_id": "category", "cohort": "category"},
    )
    outcomes = pd.read_csv(data_dir / "outcomes.csv", dtype={"record_id": str, "status": "category"})
    if payments["record_id"].isna().any() or not payments["record_id"].is_unique:
        raise ValueError("Prepared payments must contain unique, nonempty record_id values")
    if not outcomes["status"].isin(STATUSES).all():
        raise ValueError(f"Unexpected administrative status. Expected one of {STATUSES}")
    if payments["record_id"].equals(outcomes["record_id"]):
        return payments, outcomes["status"]
    if (
        len(payments) != len(outcomes)
        or not outcomes["record_id"].is_unique
        or not outcomes["record_id"].isin(payments["record_id"]).all()
    ):
        raise ValueError("Prepared payments and outcomes must have matching unique record_id values")
    status = payments["record_id"].map(outcomes.set_index("record_id")["status"])
    return payments, status


def monthly_ranking_inputs(
    payments: pd.DataFrame, features: pd.DataFrame, scores: np.ndarray, status: pd.Series,
    *, scheduled_installments: dict[int, int] | None = None,
) -> list[tuple[int, pd.DataFrame]]:
    rows = payments[["month", "record_id"]].copy()
    rows["status"] = status
    rows["duplicate"] = features["same_month_repeat"]
    rows["has_history"] = features["missing_beneficiary_history"].eq(0)
    rows["deviation"] = features[["log_amount_ratio_cohort", "log_amount_ratio_beneficiary"]].abs().max(axis=1)
    rows["ml_score"] = scores
    if HISTORICAL_AMOUNT_SURPRISAL in features:
        rows[HISTORICAL_AMOUNT_SURPRISAL] = features[HISTORICAL_AMOUNT_SURPRISAL]
    if scheduled_installments is not None:
        expected = valid_installments(payments["month"].map(scheduled_installments))
        actual = (
            valid_installments(payments["installment"]) if "installment" in payments
            else pd.Series(np.nan, index=payments.index)
        )
        rows["has_installment"] = actual.notna()
        rows["has_schedule"] = expected.notna()
        rows["earlier_installment"] = actual.lt(expected).fillna(False).astype(bool)
    rows["tie_break"] = pd.util.hash_pandas_object(rows["record_id"], index=False)
    months = []
    for month, batch in rows.groupby("month", sort=True):
        batch = batch.copy()
        history_groups = batch.groupby("has_history")
        batch["rules_rank"] = history_groups["deviation"].rank(method="average", pct=True)
        batch["ml_rank"] = history_groups["ml_score"].rank(method="average", pct=True)
        if HISTORICAL_AMOUNT_SURPRISAL in batch:
            batch["frequency_rank"] = history_groups[HISTORICAL_AMOUNT_SURPRISAL].rank(method="average", pct=True)
        if scheduled_installments is not None:
            # Within the same repeat priority, rank earlier installments first.
            batch["installment_schedule_rank"] = batch["rules_rank"] + batch["earlier_installment"]
        months.append((int(month), batch))
    return months


def top_rows(
    batch: pd.DataFrame, weight: float, use_duplicate_rule: bool, score_column: str = "ml_rank",
    *, review_budget: float | None = None,
) -> pd.DataFrame:
    priority = (1 - weight) * batch["rules_rank"] + weight * batch[score_column]
    ranking = batch.assign(priority=priority)
    columns = ["priority", "tie_break"]
    ascending = [False, True]
    if use_duplicate_rule:
        columns.insert(0, "duplicate")
        ascending.insert(0, False)
    budget = int(len(batch) * (REVIEW_BUDGET if review_budget is None else review_budget))
    with_history = ranking["has_history"]
    history_budget = round(budget * with_history.mean())
    return pd.concat([
        ranking.loc[with_history].sort_values(columns, ascending=ascending).head(history_budget),
        ranking.loc[~with_history].sort_values(columns, ascending=ascending).head(budget - history_budget),
    ])


def known_hits(rows: pd.DataFrame) -> int:
    return int(rows["status"].isin(("returned", "held")).sum())


def score_distinct_features(model: IsolationForest, features: pd.DataFrame) -> np.ndarray:
    # Monthly installment data has many identical feature vectors.
    distinct, positions = np.unique(features.to_numpy(), axis=0, return_inverse=True)
    scores = -model.score_samples(pd.DataFrame(distinct, columns=features.columns))
    return scores[positions]


def fit_history_models(train: pd.DataFrame, *, include_amount_frequency: bool = False) -> dict:
    extra = [HISTORICAL_AMOUNT_SURPRISAL] if include_amount_frequency else []
    amount_features = AMOUNT_FEATURES + extra
    history_features = HISTORY_FEATURES + extra
    amount_model = IsolationForest(**MODEL_PARAMS).fit(train[amount_features])
    with_history = train.loc[train["missing_beneficiary_history"].eq(0), history_features]
    history_model = IsolationForest(**MODEL_PARAMS).fit(with_history) if len(with_history) else None
    return {
        "amount_model": amount_model, "history_model": history_model,
        "amount_features": amount_features, "history_features": history_features,
    }


def score_history_models(models: dict, features: pd.DataFrame) -> np.ndarray:
    has_history = features["missing_beneficiary_history"].eq(0).to_numpy()
    history_model = models["history_model"]
    amount_features = models.get("amount_features", AMOUNT_FEATURES)
    history_features = models.get("history_features", HISTORY_FEATURES)
    if history_model is None:
        return score_distinct_features(models["amount_model"], features[amount_features])
    scores = np.empty(len(features))
    if has_history.any():
        scores[has_history] = score_distinct_features(history_model, features.loc[has_history, history_features])
    if not has_history.all():
        scores[~has_history] = score_distinct_features(models["amount_model"], features.loc[~has_history, amount_features])
    return scores


def choose_weight(
    months: list[tuple[int, pd.DataFrame]], *, review_budget: float | None = None,
) -> tuple[float, dict[str, int], bool]:
    if not any(known_hits(batch) for _, batch in months):
        return 0.5, {str(weight): 0 for weight in WEIGHTS}, False
    validation_hits = {
        weight: sum(known_hits(top_rows(batch, weight, True, review_budget=review_budget)) for _, batch in months)
        for weight in WEIGHTS
    }
    # Prefer the simplest rule ranking when several blends find the same number of statuses.
    weight = max(WEIGHTS, key=lambda value: (validation_hits[value], -value))
    return weight, {str(key): value for key, value in validation_hits.items()}, True


def status_counts(rows: pd.DataFrame) -> dict[str, int]:
    counts = rows["status"].value_counts()
    return {name: int(counts.get(name, 0)) for name in STATUSES}


def history_counts(rows: pd.DataFrame) -> dict[str, int]:
    with_history = int(rows["has_history"].sum())
    return dict(zip(HISTORY_GROUPS, (with_history, len(rows) - with_history)))


def installment_check_counts(rows: pd.DataFrame) -> dict[str, int]:
    return {
        "checked": int((rows["has_installment"] & rows["has_schedule"]).sum()),
        "earlier_installment": int(rows["earlier_installment"].sum()),
        "skipped_missing_actual_installment": int((~rows["has_installment"]).sum()),
        "skipped_missing_schedule": int((rows["has_installment"] & ~rows["has_schedule"]).sum()),
    }


def evaluate_months(
    months: list[tuple[int, pd.DataFrame]], weight: float,
    *, include_amount_frequency: bool = False, include_installment_schedule: bool = False,
    review_budget: float | None = None,
) -> dict:
    settings = {"rules_only": (0.0, True), "ml_only": (1.0, False), "rules_plus_ml": (weight, True)}
    if include_amount_frequency:
        settings["frequency_only"] = (1.0, False, "frequency_rank")
    if include_installment_schedule:
        settings["rules_with_installment_schedule"] = (1.0, True, "installment_schedule_rank")
    evaluations = []
    for month, batch in months:
        selections = {name: top_rows(batch, *params, review_budget=review_budget) for name, params in settings.items()}
        rules = selections["rules_only"]
        combined = selections["rules_plus_ml"]
        evaluations.append({
            "month": month,
            "rows": len(batch),
            "review_budget_rows": len(rules),
            "same_month_repeat_rows": int(batch["duplicate"].sum()),
            "statuses": status_counts(batch),
            "history": history_counts(batch),
            "rankings": {
                name: {
                    "reviewed": len(picked),
                    "statuses": status_counts(picked),
                    "history": history_counts(picked),
                }
                for name, picked in selections.items()
            },
            "added_by_combined": status_counts(combined.loc[~combined.index.isin(rules.index)]),
            "displaced_by_combined": status_counts(rules.loc[~rules.index.isin(combined.index)]),
            **({"installment_check": installment_check_counts(batch)} if "has_schedule" in batch else {}),
        })

    rows = sum(month["rows"] for month in evaluations)
    totals = {status: sum(month["statuses"][status] for month in evaluations) for status in STATUSES}
    rankings = {}
    for name in settings:
        hits = {
            status: sum(month["rankings"][name]["statuses"][status] for month in evaluations)
            for status in STATUSES
        }
        rankings[name] = {
            "reviewed": sum(hits.values()),
            "statuses": hits,
            "history": {
                group: sum(month["rankings"][name]["history"][group] for month in evaluations)
                for group in HISTORY_GROUPS
            },
            "published_status_coverage": {
                status: round(hits[status] / totals[status], 6) if totals[status] else None
                for status in ("returned", "held")
            },
        }
    return {
        "rows": rows,
        "statuses": totals,
        "history": {group: sum(month["history"][group] for month in evaluations) for group in HISTORY_GROUPS},
        "rankings": rankings,
        "added_by_combined": {
            status: sum(month["added_by_combined"][status] for month in evaluations) for status in STATUSES
        },
        "displaced_by_combined": {
            status: sum(month["displaced_by_combined"][status] for month in evaluations) for status in STATUSES
        },
        "by_month": evaluations,
    }


def run_benchmark(
    data_dir: Path, validation_start: int, test_start: int, report_path: Path | None,
    *, include_amount_frequency: bool = False, scheduled_installments: dict[int, int] | None = None,
    review_budget: float | None = None,
) -> dict:
    payments, status = load_data(data_dir)
    preparation = json.loads((data_dir / "preparation.json").read_text(encoding="utf-8"))
    supplied_schedule = {**load_installment_schedule(data_dir), **(scheduled_installments or {})}
    schedule = resolve_installment_schedule(preparation, supplied_schedule)
    months = payments["month"]
    if validation_start >= test_start or not {validation_start, test_start} <= set(months):
        raise ValueError("Specify available, ordered validation and test start months")
    burn_in = int(months.min())
    train = months.gt(burn_in) & months.lt(validation_start)
    validation = months.ge(validation_start) & months.lt(test_start)
    test = months.ge(test_start)
    if not train.any() or not validation.any() or not test.any():
        raise ValueError("Need a burn-in month and separate training, validation and test months")
    test_schedule = {int(month): schedule[month] for month in months[test].unique() if month in schedule}
    if review_budget is None:
        review_budget = DEFAULT_BENCHMARK_REVIEW_BUDGET
    if not 0 < review_budget <= 1:
        raise ValueError("Review budget must be in (0, 1]")
    features = build_features(payments, include_amount_frequency=include_amount_frequency)
    models = fit_history_models(features.loc[train], include_amount_frequency=include_amount_frequency)
    validation_months = monthly_ranking_inputs(
        payments.loc[validation], features.loc[validation],
        score_history_models(models, features.loc[validation]), status.loc[validation],
    )
    weight, validation_hits, calibrated = choose_weight(validation_months, review_budget=review_budget)
    del validation_months
    test_months = monthly_ranking_inputs(
        payments.loc[test], features.loc[test],
        score_history_models(models, features.loc[test]), status.loc[test],
        scheduled_installments=test_schedule,
    )
    include_schedule = any((batch["has_installment"] & batch["has_schedule"]).any() for _, batch in test_months)
    report = {
        "evaluation": "retrospective ranking of published administrative statuses",
        "limitations": [
            "Published installment month does not establish when a row or status became visible.",
            "Returned and held are administrative observations. Unknown is not a verified negative.",
            "Amounts and repeated installment groups are as represented in the public export.",
        ],
        "preparation": preparation,
        "split": {
            "burn_in_month": burn_in,
            **{
                name: {"months": sorted(int(value) for value in months[mask].unique()), "rows": int(mask.sum())}
                for name, mask in (("train", train), ("validation", validation), ("test", test))
            },
        },
        "model": {
            "algorithm": "Isolation Forest",
            "parameters": MODEL_PARAMS,
            "amount_features": models["amount_features"],
            "history_features": models["history_features"] if models["history_model"] is not None else None,
            "training_reference": "All training rows for the amount model, rows with prior history for the history model.",
        },
        "rules": "Prioritize repeated beneficiary/installment groups, then amount deviation, within each review group.",
        "review_budget": review_budget,
        "review_allocation": "Per month, split the review budget proportionally by availability of beneficiary history.",
        "calibration": {
            "ml_weight_in_combined_ranking": weight,
            "validation_hits_by_weight": validation_hits,
            "weight_calibrated_with_published_statuses": calibrated,
            "tie_break": "deterministic hash of prepared record_id; keep the preparation key to reproduce ties",
        },
        "test": evaluate_months(
            test_months, weight, include_amount_frequency=include_amount_frequency,
            include_installment_schedule=include_schedule, review_budget=review_budget,
        ),
    }
    if test_schedule:
        report["scheduled_installments"] = test_schedule
        report["limitations"].append(
            "Earlier installments can be authorized retroactive payments. The archive does not show "
            "the return reason or when the installment metadata first became available."
        )
    model_name = "isoforest_auxilio_emergencial_history_aware.joblib"
    if include_amount_frequency:
        model_name = "isoforest_auxilio_emergencial_amount_frequency.joblib"
        report["model"]["historical_amount_frequency"] = (
            "Negative log of smoothed exact-amount frequency in earlier months, "
            "using cohort and installment with broader fallbacks."
        )
        if 202110 in report["split"]["test"]["months"]:
            report["limitations"].append("October 2021 was inspected before adding this feature.")
    if report_path is None:
        if test_schedule and not include_amount_frequency:
            report_path = SCHEDULE_REPORT_PATH
        else:
            report_path = FREQUENCY_REPORT_PATH if include_amount_frequency else REPORT_PATH
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    joblib.dump(
        {
            **models,
            "review_budget": review_budget,
            "ml_weight": weight,
        },
        data_dir / model_name,
    )
    return report


def parse_scheduled_installment(value: str) -> tuple[int, int]:
    try:
        month_text, installment_text = value.split("=", 1)
        month, installment = int(month_text), int(installment_text)
        if 100001 <= month <= 999912 and 1 <= month % 100 <= 12 and installment >= 1:
            return month, installment
    except ValueError:
        pass
    raise argparse.ArgumentTypeError("Expected YYYYMM=INSTALLMENT with a positive installment")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR)
    parser.add_argument("--validation-start", type=int, required=True, metavar="YYYYMM")
    parser.add_argument("--test-start", type=int, required=True, metavar="YYYYMM")
    parser.add_argument("--amount-frequency", action="store_true", help="Add historical amount frequency and its standalone baseline")
    parser.add_argument(
        "--scheduled-installment", type=parse_scheduled_installment, action="append",
        metavar="YYYYMM=INSTALLMENT", help="Add review priority using the published schedule for each test month",
    )
    parser.add_argument("--report", type=Path)
    parser.add_argument("--review-budget", type=float, help="Fraction to review (default: 0.01)")
    args = parser.parse_args()
    scheduled_installments = dict(args.scheduled_installment or [])
    if len(scheduled_installments) != len(args.scheduled_installment or []):
        parser.error("Specify each scheduled month once")
    report = run_benchmark(
        args.data_dir, args.validation_start, args.test_start, args.report,
        include_amount_frequency=args.amount_frequency, scheduled_installments=scheduled_installments,
        review_budget=args.review_budget,
    )
    test_checks = {month["month"]: month["installment_check"] for month in report["test"]["by_month"]}
    print(json.dumps({
        "split": report["split"], "review_budget": report["review_budget"],
        "scheduled_installments": report.get("scheduled_installments", {}),
        "installment_checks_by_month": test_checks, "test": report["test"]["rankings"],
    }, indent=2))


if __name__ == "__main__":
    main()
