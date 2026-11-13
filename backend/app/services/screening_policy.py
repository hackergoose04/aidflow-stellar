"""Explicit amount and local payment-time rules for uploads and pending review."""
from datetime import datetime, time, timedelta
from decimal import Decimal
import json
import os
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .. import config, db, registry


class PaymentWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: time
    end: time
    timezone: str = Field(min_length=1, max_length=80)
    weekdays_only: bool = False

    @model_validator(mode="after")
    def validate_window(self):
        if any(t.tzinfo is not None or t.second or t.microsecond for t in (self.start, self.end)):
            raise ValueError("Use local HH:MM times without a UTC offset")
        if self.start == self.end:
            raise ValueError("Start and end must differ. Turn off the time rule to allow all hours.")
        try:
            ZoneInfo(self.timezone)
        except (ValueError, ZoneInfoNotFoundError) as exc:
            raise ValueError("Enter an IANA timezone such as America/Toronto") from exc
        return self

    def outside(self, timestamp: str) -> bool:
        local = datetime.fromisoformat(timestamp).astimezone(ZoneInfo(self.timezone))
        clock = local.time().replace(second=0, microsecond=0)
        day = local.date()
        if self.start < self.end:
            in_window = self.start <= clock <= self.end
        else:
            in_window = clock >= self.start or clock <= self.end
            if clock <= self.end:
                day -= timedelta(days=1)
        return not in_window or (self.weekdays_only and day.weekday() >= 5)


class ScreeningPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    min_amount: Decimal | None = Field(default=None, ge=0, max_digits=25, decimal_places=7)
    max_amount: Decimal | None = Field(default=None, gt=0, max_digits=25, decimal_places=7)
    payment_window: PaymentWindow | None = None

    @model_validator(mode="after")
    def validate_range(self):
        if self.min_amount is not None and self.max_amount is not None and self.min_amount > self.max_amount:
            raise ValueError("Minimum amount cannot exceed maximum amount")
        return self

    def flags(self, row: dict) -> list[str]:
        flags = []
        amount = Decimal(row["amount"])
        if self.min_amount is not None and amount < self.min_amount:
            flags.append(f"amount_below_minimum:{self.min_amount:f}")
        if self.max_amount is not None and amount > self.max_amount:
            flags.append(f"amount_above_limit:{self.max_amount:f}")
        if self.payment_window and self.payment_window.outside(row["created_at"]):
            window = self.payment_window
            days = "Mon–Fri" if window.weekdays_only else "daily"
            flags.append(f"outside_payment_window:{window.start:%H:%M}–{window.end:%H:%M} {window.timezone} ({days})")
        return flags


POLICY_FLAGS = {"amount_below_minimum", "amount_above_limit", "outside_payment_window"}


def editing_enabled() -> bool:
    return os.getenv("SCREENING_POLICY_EDITING", "off").lower() == "on"


def current(conn: db.Connection) -> ScreeningPolicy:
    row = conn.execute("SELECT settings FROM screening_policies WHERE program = ? AND asset = ?",
                       (registry.program(), config.ASSET_CODE)).fetchone()
    return ScreeningPolicy.model_validate_json(row["settings"]) if row else ScreeningPolicy(max_amount=config.AMOUNT_LIMIT)


def pending_changes(conn: db.Connection, policy: ScreeningPolicy):
    rows = conn.execute("SELECT request_ref, amount, created_at, flags, screening_policy, updated_at"
                        " FROM requests WHERE status = ? AND asset = ?",
                        (db.Status.PENDING_REVIEW, config.ASSET_CODE)).fetchall()
    counts = {"pending": len(rows), "flagged": 0, "newly_flagged": 0, "cleared": 0,
              "amount_flags": 0, "time_flags": 0}
    changes = []
    for raw in rows:
        row = db.to_dict(raw)
        rules = policy.flags(row)
        flags = [flag for flag in row["flags"] if flag.partition(":")[0] not in POLICY_FLAGS] + rules
        counts["flagged"] += bool(flags)
        counts["newly_flagged"] += bool(flags) and not row["flags"]
        counts["cleared"] += bool(row["flags"]) and not flags
        counts["amount_flags"] += any(flag.startswith("amount_") for flag in rules)
        counts["time_flags"] += any(flag.startswith("outside_payment_window:") for flag in rules)
        changes.append((row, flags))
    return counts, changes


def save(conn: db.Connection, policy: ScreeningPolicy, reviewer: str, apply_pending: bool) -> dict | None:
    settings = policy.model_dump_json()
    conn.execute("INSERT INTO screening_policies (program, asset, settings) VALUES (?, ?, ?)"
                 " ON CONFLICT (program, asset) DO UPDATE SET settings = excluded.settings",
                 (registry.program(), config.ASSET_CODE, settings))
    counts = None
    if apply_pending:
        counts, changes = pending_changes(conn, policy)
        now = db.now()
        for row, flags in changes:
            if row["screening_policy"] == settings and row["flags"] == flags:
                continue
            updated = conn.execute("UPDATE requests SET flags = ?, screening_policy = ?, updated_at = ?"
                                   " WHERE request_ref = ? AND status = ? AND updated_at = ?",
                                   (json.dumps(flags), settings, now, row["request_ref"], db.Status.PENDING_REVIEW,
                                    row["updated_at"]))
            if updated.rowcount != 1:
                raise ValueError("The review queue changed. Refresh the preview and try again.")
    db.log(conn, None, "screening_policy_changed", {"reviewer": reviewer, "program": registry.program(),
           "asset": config.ASSET_CODE, "policy": policy.model_dump(mode="json"), "pending": counts})
    conn.commit()
    return counts
