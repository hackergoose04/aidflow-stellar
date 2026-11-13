"""Storage: one row per request, plus an append-only audit log.

Postgres when DATABASE_URL is set (deployments: several instances share one database), else a
local SQLite file (DB_PATH) for development and tests. Both are reached through the same small
dialect: `?` placeholders, rows readable by column name or position, explicit commit()."""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Sequence
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Union

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

def _schema(event_id: str, real: str) -> str:
    return f"""
CREATE TABLE IF NOT EXISTS requests (
    request_ref    TEXT PRIMARY KEY,
    batch_id       TEXT,
    payout_slot    {PAYOUT_SLOT_COLUMN},
    installment    BIGINT,
    benefit_month  TEXT,
    beneficiary_id TEXT NOT NULL,
    wallet         TEXT NOT NULL,
    amount         TEXT NOT NULL,      -- 7-decimal string, same format as Horizon
    asset          TEXT NOT NULL,
    created_at     TEXT NOT NULL,      -- ISO 8601 UTC
    available_at   TEXT,               -- when the current request values became visible
    status         TEXT NOT NULL,
    flags          TEXT NOT NULL DEFAULT '[]',  -- JSON list of reasons for the reviewer
    risk_score     {real},             -- from the ML model, when available
    risk_signals   TEXT,               -- JSON list of model sensitivity results
    screening_policy TEXT,             -- JSON policy selected for this request
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
    id          {event_id},
    request_ref TEXT,
    kind        TEXT NOT NULL,
    detail      TEXT,
    at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ref ON events(request_ref);

CREATE TABLE IF NOT EXISTS screening_policies (
    program TEXT NOT NULL,
    asset TEXT NOT NULL,
    settings TEXT NOT NULL,
    PRIMARY KEY (program, asset)
);
"""


SQLITE_SCHEMA = _schema("INTEGER PRIMARY KEY AUTOINCREMENT", "REAL")
POSTGRES_SCHEMA = _schema("BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY", "DOUBLE PRECISION")


# Columns added after the first release: added to existing databases on connect.
MIGRATIONS = {"batch_id": "TEXT", "payout_slot": PAYOUT_SLOT_COLUMN,
              "installment": "BIGINT", "benefit_month": "TEXT", "available_at": "TEXT", "risk_signals": "TEXT",
              "screening_policy": "TEXT",
              "recon_status": "TEXT", "recon_reasons": "TEXT", "recon_at": "TEXT",
              "registry_key": "TEXT", "registry_status": "TEXT",
              "balance_id": "TEXT", "claim_status": "TEXT", "claimed_at": "TEXT"}
# Status values renamed to match the design doc's state machine.
RENAMED = {"ON_HOLD": "HELD", "DECLINED": "REJECTED"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


_migrated: set[str] = set()  # databases whose schema this process has already checked
SCHEMA_LOCK = 0x41494446  # Postgres advisory lock id, held while creating or migrating the schema


class Row(dict):
    """A Postgres result row, readable by column name or position like sqlite3.Row."""

    def __init__(self, names: Sequence[str], values: Sequence[Any]):
        super().__init__(zip(names, values))
        self._values = tuple(values)

    def __getitem__(self, key):
        return self._values[key] if isinstance(key, int) else super().__getitem__(key)


def _row_factory(cursor):
    names = [c.name for c in cursor.description or ()]
    return lambda values: Row(names, values)


class PostgresConnection:
    """A psycopg connection that takes the same SQL as sqlite3: `?` placeholders become `%s`."""

    def __init__(self, url: str):
        import psycopg  # only needed when DATABASE_URL is set

        # prepare_threshold=None: no server-side prepared statements, which connection poolers
        # (Neon's pooled endpoint, PgBouncer) can't carry from one client to the next.
        self._conn = psycopg.connect(url, row_factory=_row_factory, prepare_threshold=None,
                                     connect_timeout=10)

    def execute(self, sql: str, params: Sequence[Any] = ()):
        if not params:
            return self._conn.execute(sql)
        return self._conn.execute(sql.replace("%", "%%").replace("?", "%s"), tuple(params))

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def close(self) -> None:
        self._conn.close()


Connection = Union[sqlite3.Connection, PostgresConnection]


def connect() -> Connection:
    return _connect_postgres(config.DATABASE_URL) if config.DATABASE_URL else _connect_sqlite()


def _connect_postgres(url: str) -> PostgresConnection:
    conn = PostgresConnection(url)
    if url not in _migrated:
        # Several instances can start at once: one creates or migrates the schema, the rest wait.
        conn.execute(f"SELECT pg_advisory_xact_lock({SCHEMA_LOCK})")
        conn.execute(POSTGRES_SCHEMA)
        for col, typ in MIGRATIONS.items():
            conn.execute(f"ALTER TABLE requests ADD COLUMN IF NOT EXISTS {col} {typ}")
        conn.commit()
        _migrated.add(url)
    return conn


def _connect_sqlite() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    # Every request opens its own connection, and the UI fires several at once. WAL lets readers
    # and writers proceed together; the busy timeout covers the brief moments they can't.
    conn = sqlite3.connect(config.DB_PATH, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    # Missing columns are checked on every connection (a cheap read); the status rename and the
    # schema script, which write, run once per process.
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(requests)")}
    if existing and MIGRATIONS.keys() - existing:
        # A second request may be migrating the database at the same time.
        conn.execute("BEGIN IMMEDIATE")
        existing = {r["name"] for r in conn.execute("PRAGMA table_info(requests)")}
        for col, typ in MIGRATIONS.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE requests ADD COLUMN {col} {typ}")
        conn.commit()
    key = str(config.DB_PATH)
    if key not in _migrated:
        if existing:
            for old, new in RENAMED.items():
                conn.execute("UPDATE requests SET status = ? WHERE status = ?", (new, old))
            conn.commit()
        conn.executescript(SQLITE_SCHEMA)
        _migrated.add(key)
    return conn


def to_dict(row) -> dict | None:
    if row is None:
        return None
    d = dict(row)
    if "flags" in d:
        d["flags"] = json.loads(d["flags"])
    if d.get("risk_signals"):
        d["risk_signals"] = json.loads(d["risk_signals"])
    if d.get("recon_reasons"):
        d["recon_reasons"] = json.loads(d["recon_reasons"])
    return d


def get(conn: Connection, ref: str) -> dict | None:
    return to_dict(conn.execute("SELECT * FROM requests WHERE request_ref = ?", (ref,)).fetchone())


def add_flags(conn: Connection, ref: str, new: list[str]) -> None:
    if not new:
        return
    current = get(conn, ref)["flags"]
    merged = current + [f for f in new if f not in current]
    conn.execute("UPDATE requests SET flags = ?, updated_at = ? WHERE request_ref = ?",
                 (json.dumps(merged), now(), ref))


def log(conn: Connection, ref: str | None, kind: str, detail: dict | str | None = None) -> None:
    if isinstance(detail, dict):
        detail = json.dumps(detail)
    conn.execute("INSERT INTO events (request_ref, kind, detail, at) VALUES (?, ?, ?, ?)",
                 (ref, kind, detail, now()))
