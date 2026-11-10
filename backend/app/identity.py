"""Pseudonymous beneficiary IDs: the database never stores the raw ID (design doc: "no raw
identity data, HMAC key in env vars").

    token = "H-" + HMAC-SHA256(PII_HMAC_SECRET, raw_id)[:16 hex]

The same person always gets the same token, so dedup, screening and the ML history still
work. Staff who know a real ID can find that person's requests through /beneficiaries/lookup,
which computes the token server-side; the raw ID is never written anywhere.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re

TOKEN = re.compile(r"H-[0-9a-f]{16}")


def _secret() -> bytes:
    value = os.getenv("PII_HMAC_SECRET")
    if not value:
        raise RuntimeError("PII_HMAC_SECRET missing in .env (see README: generate one and keep it)")
    return value.encode()


def is_token(value: str) -> bool:
    return bool(TOKEN.fullmatch(value))


def pseudonymize(raw_id: str) -> str:
    """Raw beneficiary ID -> stable token. A value that already is a token is returned as is."""
    raw_id = raw_id.strip()
    if not raw_id or is_token(raw_id):
        return raw_id
    return "H-" + hmac.new(_secret(), raw_id.encode("utf-8"), hashlib.sha256).hexdigest()[:16]
