"""Settings. Everything comes from the repo-root .env (written by scripts/testnet_setup.py)."""
from __future__ import annotations

import json
import os
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path

from dotenv import load_dotenv
from stellar_sdk import Network

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

# Stellar: TESTNET ONLY. The passphrase is hard-coded so a mainnet URL can't sneak in.
HORIZON_URL = os.getenv("HORIZON_URL", "https://horizon-testnet.stellar.org")
RPC_URL = os.getenv("RPC_URL", "https://soroban-testnet.stellar.org")
NETWORK_PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE
ASSET_CODE = os.getenv("ASSET_CODE", "AIDUSD")
DEFAULT_PAYOUT_SLOT = "base"
PAYOUT_SLOTS = frozenset({DEFAULT_PAYOUT_SLOT} | {
    slot.strip().lower() for slot in os.getenv("PAYOUT_SLOTS", "").split(",") if slot.strip()
})
BASE_FEE = 100                 # stroops per operation
TX_TIMEOUT_SECONDS = 30        # tx time bounds; after this an unsent tx can never land
RECLAIM_AFTER_SECONDS = int(os.getenv("RECLAIM_AFTER_SECONDS", 30 * 24 * 3600))

# Last mile: a claimable balance still unclaimed after this long is flagged for follow-up.
CLAIM_ALERT_HOURS = float(os.getenv("CLAIM_ALERT_HOURS", "72"))
# Only used to express network fees in dollars; an assumption, not a live price.
XLM_USD = float(os.getenv("XLM_USD", "0.30"))
COST_BENCHMARK = 0.064   # World Bank global average remittance cost
COST_TARGET = 0.03       # UN SDG 10.c target

# Storage: Postgres when DATABASE_URL is set (deployments), else a local SQLite file.
DATABASE_URL = os.getenv("DATABASE_URL") or None
DB_PATH = Path(os.getenv("AIDFLOW_DB", ROOT / "data" / "aidflow.db"))

# Screening rules
DUPLICATE_WINDOW_HOURS = int(os.getenv("DUPLICATE_WINDOW_HOURS", "24"))
CHECK_BATCH_PAYOUT_SLOT = os.getenv("CHECK_BATCH_PAYOUT_SLOT", "on").strip().lower() != "off"


def load_amount_limit() -> Decimal | None:
    raw = os.getenv("AMOUNT_LIMIT", "500").strip()
    if raw.lower() == "off":
        return None
    error = "AMOUNT_LIMIT must be a finite positive amount or 'off'"
    try:
        amount = Decimal(raw)
    except InvalidOperation as exc:
        raise ValueError(error) from exc
    if not amount.is_finite() or amount <= 0:
        raise ValueError(error)
    return amount


AMOUNT_LIMIT = load_amount_limit()


def parse_installment(raw: str | None) -> int | None:
    value = (raw or "").strip().lstrip("0")
    if not (value.isascii() and value.isdecimal() and len(value) <= 16):
        return None
    number = int(value)
    return number if number <= 2**53 - 1 else None  # exact round trip through the frontend


def _load_batch_installment_schedule() -> dict[str, int]:
    raw = os.getenv("BATCH_INSTALLMENT_SCHEDULE", "").strip()
    error = "BATCH_INSTALLMENT_SCHEDULE must be a JSON object mapping batch IDs to positive integers"
    try:
        schedule = json.loads(raw) if raw else {}
    except ValueError as exc:
        raise ValueError(error) from exc
    if not isinstance(schedule, dict) or any(
        not batch or batch != batch.strip() or type(number) is not int or parse_installment(str(number)) is None
        for batch, number in schedule.items()
    ):
        raise ValueError(error)
    return schedule


BATCH_INSTALLMENT_SCHEDULE = _load_batch_installment_schedule()


def parse_benefit_month(raw: str | None) -> str | None:
    value = (raw or "").strip()
    if re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", value) and not value.startswith("0000"):
        return value
    return None


def _load_batch_benefit_month_schedule() -> dict[str, str]:
    raw = os.getenv("BATCH_BENEFIT_MONTH_SCHEDULE", "").strip()
    error = "BATCH_BENEFIT_MONTH_SCHEDULE must be a JSON object mapping batch IDs to YYYY-MM strings"
    try:
        schedule = json.loads(raw) if raw else {}
    except ValueError as exc:
        raise ValueError(error) from exc
    if not isinstance(schedule, dict) or any(
        not batch or batch != batch.strip() or not isinstance(month, str) or parse_benefit_month(month) != month
        for batch, month in schedule.items()
    ):
        raise ValueError(error)
    return schedule


BATCH_BENEFIT_MONTH_SCHEDULE = _load_batch_benefit_month_schedule()


def secret(name: str) -> str:
    value = os.getenv(f"{name}_SECRET")
    if not value:
        raise RuntimeError(f"{name}_SECRET missing in .env. Run scripts/testnet_setup.py first.")
    return value


def public(name: str) -> str:
    value = os.getenv(f"{name}_PUBLIC")
    if not value:
        raise RuntimeError(f"{name}_PUBLIC missing in .env. Run scripts/testnet_setup.py first.")
    return value
