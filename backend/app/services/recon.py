"""Reconciliation: compare each intended payment with what the distribution account actually
sent on chain. The link is the memo: MEMO_HASH = SHA-256(request_ref).

For every request, the five pairs from the design doc are compared:

    internal                      chain
    request ID / tx hash     <->  transaction hash
    expected amount          <->  transferred amount
    recipient wallet         <->  destination address
    expected asset           <->  actual asset
    internal status          <->  verified transaction status

and the request lands in exactly one category:

    MATCHED               confirmed, found on chain once, every field agrees
    PENDING_VERIFICATION  submitted, final outcome not established yet
    MISMATCH              something disagrees (reasons list says what)
    NOT_EXECUTED          invalid, held, rejected, not yet paid, or failed, and nothing on chain

Payouts on chain that match no request are listed separately (unrecorded_on_chain).
When the on-chain registry (Plan B) is on, each confirmed payment is also checked against
its registry entry: it must be PAID, for this request, with this transaction.
Uses Horizon (full account history), not RPC (only ~7 days)."""
from __future__ import annotations

import base64
import json
from collections import defaultdict

from .. import config, db, registry, stellar_client as sc
from ..db import Status

MAX_OPS = 2000  # enough for the hackathon; production would keep its own index

MATCHED, PENDING, MISMATCH, NOT_EXECUTED = "MATCHED", "PENDING_VERIFICATION", "MISMATCH", "NOT_EXECUTED"
CATEGORIES = [MATCHED, PENDING, MISMATCH, NOT_EXECUTED]
NOT_SUBMITTED = {Status.INVALID, Status.PENDING_REVIEW, Status.HELD, Status.APPROVED, Status.REJECTED}


def _asset_of(op: dict) -> str:
    if op["type"] == "payment":
        return "native" if op["asset_type"] == "native" else f"{op['asset_code']}:{op['asset_issuer']}"
    return op["asset"]  # create_claimable_balance: "CODE:ISSUER" or "native"


def fetch_chain_payouts(dist: str) -> list[dict]:
    """Every payment / claimable balance the distribution account created, any asset."""
    out, cursor = [], None
    server = sc.horizon()
    while len(out) < MAX_OPS:
        call = server.operations().for_account(dist).join("transactions").limit(200)
        if cursor:
            call = call.cursor(cursor)
        records = call.call()["_embedded"]["records"]
        if not records:
            break
        for op in records:
            cursor = op["paging_token"]
            if not op.get("transaction_successful", True):
                continue
            if op["type"] == "payment" and op["from"] == dist:
                to = op["to"]
            elif op["type"] == "create_claimable_balance" and op["source_account"] == dist:
                to = op["claimants"][0]["destination"]
            else:
                continue
            tx = op["transaction"]
            memo_hex = base64.b64decode(tx["memo"]).hex() if tx.get("memo_type") == "hash" else None
            out.append({"tx_hash": op["transaction_hash"], "type": op["type"], "to": to,
                        "amount": op["amount"], "asset": _asset_of(op), "memo_hex": memo_hex})
    return out


def classify(rows: list[dict], chain: list[dict], issuer: str,
             registry_entries: dict[str, dict | None] | None = None) -> dict:
    """Pure function: no network, no database. Used by run() and by the accuracy tests.

    registry_entries maps request_ref -> its on-chain registry entry (None if absent), for
    the requests that went through the registry."""
    by_memo = {sc.memo_hash(r["request_ref"]).hex(): r["request_ref"] for r in rows}
    ops_for: dict[str, list[dict]] = defaultdict(list)
    unrecorded = []
    for op in chain:
        ref = by_memo.get(op["memo_hex"])
        (ops_for[ref].append(op) if ref else unrecorded.append(op))

    results = []
    for row in rows:
        ref, status, ops = row["request_ref"], row["status"], ops_for.get(row["request_ref"], [])
        reasons: list[str] = []
        op = next((o for o in ops if o["tx_hash"] == row.get("tx_hash")), ops[0] if ops else None)

        if status in NOT_SUBMITTED:
            category = MISMATCH if ops else NOT_EXECUTED
            reasons = ["on_chain_but_never_submitted"] if ops else [status.lower()]
        elif status == Status.FAILED:
            category = MISMATCH if ops else NOT_EXECUTED
            reasons = ["on_chain_but_marked_failed"] if ops else ["failed"]
        elif status in (Status.SUBMITTED, Status.UNKNOWN):
            category = PENDING
            reasons = [status.lower()] + (["found_on_chain_run_verify"] if ops else [])
        else:  # CONFIRMED or CLAIMED: money reached the chain
            if not ops:
                reasons = ["missing_on_chain"]
            else:
                if len(ops) > 1:
                    reasons.append(f"paid_{len(ops)}_times")
                if op["tx_hash"] != row.get("tx_hash"):
                    reasons.append("tx_hash_differs")
                if op["amount"] != row["amount"]:
                    reasons.append("amount_differs")
                if op["to"] != row["wallet"]:
                    reasons.append("wallet_differs")
                if op["asset"] != f"{row['asset']}:{issuer}":
                    reasons.append("asset_differs")
            if registry_entries is not None and ref in registry_entries:
                e = registry_entries[ref]
                if e is None:
                    reasons.append("registry_missing")
                elif e["request_hash"] != sc.memo_hash(ref):
                    reasons.append("registry_held_by_other_request")
                elif e["status"] != "Paid":
                    reasons.append("registry_not_marked_paid")
                elif e["tx_hash"] != row.get("tx_hash"):
                    reasons.append("registry_tx_differs")
            category = MISMATCH if reasons else MATCHED

        results.append({
            "request_ref": ref, "category": category, "reasons": reasons,
            "internal": {k: row.get(k) for k in ("status", "amount", "wallet", "asset", "tx_hash")}
                        | {"asset": f"{row['asset']}:{issuer}"},
            "chain": op, "chain_count": len(ops),
        })

    summary = {c: sum(r["category"] == c for r in results) for c in CATEGORIES}
    summary["UNRECORDED_ON_CHAIN"] = len(unrecorded)
    return {"summary": summary, "results": results, "unrecorded_on_chain": unrecorded}


def run(conn: db.Connection) -> dict:
    rows = [dict(r) for r in conn.execute("SELECT * FROM requests")]
    chain = fetch_chain_payouts(config.public("DISTRIBUTION"))
    entries = None
    if registry.enabled():
        entries = {}
        for r in rows:
            if r["status"] in (Status.CONFIRMED, Status.CLAIMED) and r.get("registry_key"):
                try:
                    entries[r["request_ref"]] = registry.get(bytes.fromhex(r["registry_key"]))
                except Exception:
                    pass  # registry unreachable: skip the check rather than report a false mismatch
    report = classify(rows, chain, config.public("ISSUER"), entries)
    at = db.now()
    for r in report["results"]:
        conn.execute("UPDATE requests SET recon_status = ?, recon_reasons = ?, recon_at = ?"
                     " WHERE request_ref = ?", (r["category"], json.dumps(r["reasons"]), at, r["request_ref"]))
    db.log(conn, None, "recon", report["summary"])
    conn.commit()
    return {"ran_at": at, "chain_ops_checked": len(chain), **report}
