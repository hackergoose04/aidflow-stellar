"""Ingest: parse the request CSV, reject bad rows, store good ones as PENDING_REVIEW,
then run dedup and screening on what was stored."""
from __future__ import annotations

import csv
import io
import json
import sqlite3
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation

from stellar_sdk import StrKey

from .. import config, db, identity
from ..db import Status
from . import dedup, screening

REQUIRED = ["request_ref", "beneficiary_id", "wallet", "amount", "asset", "created_at"]
OPTIONAL = ["batch_id", "payout_slot"]
SEVEN_DP = Decimal("0.0000001")


def normalize_amount(raw: str) -> str:
    """'50' -> '50.0000000' (Horizon's format), so amounts compare as strings."""
    return str(Decimal(raw).quantize(SEVEN_DP))


def parse_time(raw: str) -> str:
    dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def validate(row: dict) -> list[str]:
    errors = []
    for field in REQUIRED:
        if not (row.get(field) or "").strip():
            errors.append(f"missing_{field}")
    if errors:
        return errors
    if not StrKey.is_valid_ed25519_public_key(row["wallet"].strip()):
        errors.append("invalid_wallet")
    try:
        amount = Decimal(row["amount"].strip())
        if amount <= 0:
            errors.append("invalid_amount")
        elif amount != amount.quantize(SEVEN_DP):
            errors.append("too_many_decimals")
    except InvalidOperation:
        errors.append("invalid_amount")
    if row["asset"].strip() != config.ASSET_CODE:
        errors.append("unsupported_asset")
    if row.get("payout_slot", config.DEFAULT_PAYOUT_SLOT) not in config.PAYOUT_SLOTS:
        errors.append("unsupported_payout_slot")
    try:
        parse_time(row["created_at"])
    except ValueError:
        errors.append("invalid_created_at")
    return errors


def ingest_csv(conn: sqlite3.Connection, text: str) -> dict:
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    missing = [c for c in REQUIRED if c not in (reader.fieldnames or [])]
    if missing:
        raise ValueError(f"CSV is missing columns: {missing}")

    upload_batch = "UPLOAD-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    accepted, rejected, seen = [], [], set()
    for line, row in enumerate(reader, start=2):  # line 1 is the header
        ref = (row.get("request_ref") or "").strip()
        existing = db.get(conn, ref) if ref else None
        if ref and (ref in seen or (existing and existing["status"] != Status.INVALID)):
            # Never overwrite: a repeated ref is a re-upload or a copy-paste error.
            rejected.append({"line": line, "request_ref": ref, "reasons": ["duplicate_ref"],
                             "stored_as_invalid": False})
            continue
        if existing:  # an earlier INVALID version of this ref: this upload replaces it
            conn.execute("DELETE FROM requests WHERE request_ref = ?", (ref,))
        batch = (row.get("batch_id") or "").strip() or upload_batch
        slot = (row.get("payout_slot") or "").strip().lower() or config.DEFAULT_PAYOUT_SLOT
        row["payout_slot"] = slot
        ben = identity.pseudonymize(row.get("beneficiary_id") or "")
        errors = validate(row)
        if errors:
            rejected.append({"line": line, "request_ref": ref or None, "reasons": errors,
                             "stored_as_invalid": bool(ref)})
            if ref:  # keep it as INVALID so a reviewer can correct or reject it
                seen.add(ref)
                try:
                    created = parse_time(row.get("created_at") or "")
                except ValueError:
                    created = (row.get("created_at") or "").strip()
                conn.execute(
                    "INSERT INTO requests (request_ref, batch_id, payout_slot, beneficiary_id, wallet,"
                    " amount, asset, created_at, status, flags, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (ref, batch, slot, ben, (row.get("wallet") or "").strip(), (row.get("amount") or "").strip(),
                     (row.get("asset") or "").strip(), created, Status.INVALID,
                     json.dumps([f"invalid:{e}" for e in errors]), db.now()))
            continue
        seen.add(ref)
        conn.execute(
            "INSERT INTO requests (request_ref, batch_id, payout_slot, beneficiary_id, wallet,"
            " amount, asset, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (ref, batch, slot, ben, row["wallet"].strip(), normalize_amount(row["amount"]),
             row["asset"].strip(), parse_time(row["created_at"]), Status.PENDING_REVIEW, db.now()))
        accepted.append(ref)

    for r in rejected:
        # A re-uploaded ref is logged on the existing request as a duplicate, not as a rejection of it.
        kind = ("invalid_at_upload" if r["stored_as_invalid"]
                else "duplicate_upload" if "duplicate_ref" in r["reasons"] else "rejected_at_upload")
        db.log(conn, r["request_ref"], kind, r)
    dedup.flag_duplicates(conn, accepted)
    screening.screen(conn, accepted)
    conn.commit()

    flagged = [ref for ref in accepted if db.get(conn, ref)["flags"]]
    return {"received": len(accepted) + len(rejected), "accepted": len(accepted),
            "flagged": flagged, "rejected": rejected,
            "invalid_stored": sum(r["stored_as_invalid"] for r in rejected)}
