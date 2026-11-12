"""SQLite storage: one row per request, plus an append-only audit log."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from enum import StrEnum

from . import config


class Status(StrEnum):
    """Payment state machine (design doc). VALIDATED requests are PENDING_REVIEW; the design's
    FLAGGED / CLEARED are PENDING_REVIEW with or without flags."""
    INVALID = "INVALID"                # failed validation at upload; can be corrected or rejected
    PENDING_REVIEW = "PENDING_REVIEW"  # passed ingest; flags (if any) shown to reviewer
    HELD = "HELD"                      # reviewer parked it for further checks
    APPROVED = "APPROVED"              # reviewer said yes; executor picks it up
    REJECTED = "REJECTED"              # reviewer said no; never paid
    SUBMITTED = "SUBMITTED"            # tx hash recorded, sent to Stellar
    CONFIRMED = "CONFIRMED"            # on chain, successful
    CLAIMED = "CLAIMED"                # claimable balance picked up by the beneficiary
    FAILED = "FAILED"                  # rejected, or expired without landing (safe to retry)
    UNKNOWN = "UNKNOWN"                # submit outcome unclear; verifier will resolve


# Requests that take no further part in dedup / screening / ML history.
INACTIVE = (Status.REJECTED, Status.INVALID)
# Requests whose money reached the chain.
PAID = (Status.CONFIRMED, Status.CLAIMED)


PAYOUT_SLOT_COLUMN = f"TEXT NOT NULL DEFAULT '{config.DEFAULT_PAYOUT_SLOT}'"

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS requests (
    request_ref    TEXT PRIMARY KEY,
    batch_id       TEXT,
    payout_slot    {PAYOUT_SLOT_COLUMN},
    beneficiary_id TEXT NOT NULL,
    wallet         TEXT NOT NULL,
    amount         TEXT NOT NULL,      -- 7-decimal string, same format as Horizon
    asset          TEXT NOT NULL,
    created_at     TEXT NOT NULL,      -- ISO 8601 UTC
    status         TEXT NOT NULL,
    flags          TEXT NOT NULL DEFAULT '[]',  -- JSON list of reasons for the reviewer
    risk_score     REAL,               -- from the ML model, when available
    method         TEXT,               -- payment | claimable_balance
    tx_hash        TEXT,
    submitted_at   TEXT,
    reviewer       TEXT,
    note           TEXT,
    error          TEXT,
    recon_status   TEXT,               -- MATCHED | PENDING_VERIFICATION | MISMATCH | NOT_EXECUTED
    recon_reasons  TEXT,               -- JSON list
    recon_at       TEXT,
    registry_key   TEXT,               -- hex HMAC key in the on-chain registry (Plan B)
    registry_status TEXT,              -- RESERVED | PAID | RELEASED | BLOCKED
    balance_id     TEXT,               -- claimable balance id, when paid that way
    claim_status   TEXT,               -- UNCLAIMED | CLAIMED | RECLAIMED (claimable balances)
    claimed_at     TEXT,
    updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_ben ON requests(beneficiary_id);
CREATE INDEX IF NOT EXISTS idx_requests_wallet ON requests(wallet);
CREATE INDEX IF NOT EXISTS idx_requests_batch ON requests(batch_id);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    request_ref TEXT,
    kind        TEXT NOT NULL,
    detail      TEXT,
    at          TEXT NOT NULL
);
"""


# Columns added after the first release: added to existing databases on connect.
MIGRATIONS = {"batch_id": "TEXT", "payout_slot": PAYOUT_SLOT_COLUMN,
              "recon_status": "TEXT", "recon_reasons": "TEXT", "recon_at": "TEXT",
              "registry_key": "TEXT", "registry_status": "TEXT",
              "balance_id": "TEXT", "claim_status": "TEXT", "claimed_at": "TEXT"}
# Status values renamed to match the design doc's state machine.
RENAMED = {"ON_HOLD": "HELD", "DECLINED": "REJECTED"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(requests)")}
    if existing:
        if MIGRATIONS.keys() - existing:
            # A second request may be migrating the database at the same time.
            conn.execute("BEGIN IMMEDIATE")
            existing = {r["name"] for r in conn.execute("PRAGMA table_info(requests)")}
            for col, typ in MIGRATIONS.items():
                if col not in existing:
                    conn.execute(f"ALTER TABLE requests ADD COLUMN {col} {typ}")
        for old, new in RENAMED.items():
            conn.execute("UPDATE requests SET status = ? WHERE status = ?", (new, old))
        conn.commit()
    conn.executescript(SCHEMA)
    return conn


def to_dict(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    if "flags" in d:
        d["flags"] = json.loads(d["flags"])
    if d.get("recon_reasons"):
        d["recon_reasons"] = json.loads(d["recon_reasons"])
    return d


def get(conn: sqlite3.Connection, ref: str) -> dict | None:
    return to_dict(conn.execute("SELECT * FROM requests WHERE request_ref = ?", (ref,)).fetchone())


def add_flags(conn: sqlite3.Connection, ref: str, new: list[str]) -> None:
    if not new:
        return
    current = get(conn, ref)["flags"]
    merged = current + [f for f in new if f not in current]
    conn.execute("UPDATE requests SET flags = ?, updated_at = ? WHERE request_ref = ?",
                 (json.dumps(merged), now(), ref))


def log(conn: sqlite3.Connection, ref: str | None, kind: str, detail: dict | str | None = None) -> None:
    if isinstance(detail, dict):
        detail = json.dumps(detail)
    conn.execute("INSERT INTO events (request_ref, kind, detail, at) VALUES (?, ?, ?, ?)",
                 (ref, kind, detail, now()))
