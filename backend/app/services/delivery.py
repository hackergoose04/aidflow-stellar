"""Delivery metrics: how fast money reaches people, what it costs, and who hasn't received it.

The Problem Space asks to shorten "decided to pay" -> "money in hand" and to treat arrival as
the start, not the end. Three numbers answer that from data we already keep:
  * timing     approved -> confirmed on chain -> in the beneficiary's hands (events table)
  * cost       network fees actually charged per payout, incl. the registry calls (Horizon)
  * last mile  claimable balances nobody has picked up yet, oldest first
"""
from __future__ import annotations

import json
import statistics
from datetime import datetime, timedelta

from .. import config, db, stellar_client as sc
from ..db import Status

STROOPS = 10_000_000


def _ts(iso: str | None) -> datetime | None:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")) if iso else None


def _first_event(conn: db.Connection, ref: str, kind: str, last: bool = False) -> str | None:
    order = "DESC" if last else "ASC"
    row = conn.execute(f"SELECT at FROM events WHERE request_ref = ? AND kind = ? ORDER BY id {order} LIMIT 1",
                       (ref, kind)).fetchone()
    return row[0] if row else None


def _stats(seconds: list[float]) -> dict:
    if not seconds:
        return {"n": 0, "median_s": None, "max_s": None}
    return {"n": len(seconds), "median_s": statistics.median(seconds), "max_s": max(seconds)}


def timing(conn: db.Connection) -> dict:
    """Approval -> on chain, approval -> in the beneficiary's hands, and submit -> on chain.

    "In hand" is the confirmation for a direct payment (it lands in the wallet), and the claim
    for a claimable balance. Balances not yet claimed are counted as still waiting."""
    to_chain, to_hand, settle = [], [], []
    legs = {"approve_to_send": [], "send_to_chain": [], "chain_to_hand": []}
    waiting = 0
    rows = conn.execute("SELECT request_ref, method, status, claimed_at FROM requests WHERE status IN (?, ?)",
                        (Status.CONFIRMED, Status.CLAIMED)).fetchall()  # fetchall: no cursor left open
    for r in rows:
        approved = _ts(_first_event(conn, r["request_ref"], "approved", last=True))
        confirmed = _ts(_first_event(conn, r["request_ref"], "confirmed"))
        if not approved or not confirmed:
            continue
        to_chain.append((confirmed - approved).total_seconds())
        submitted = _ts(_first_event(conn, r["request_ref"], "submitted", last=True))
        if submitted:
            settle.append((confirmed - submitted).total_seconds())
        # Legs are measured on the payouts that reached the person, so they break down the headline.
        in_hand_at = confirmed if r["method"] == "payment" else _ts(r["claimed_at"])  # payment: in wallet on confirm
        if in_hand_at is None:
            waiting += 1
            continue
        to_hand.append((in_hand_at - approved).total_seconds())
        if submitted:
            legs["approve_to_send"].append((submitted - approved).total_seconds())
            legs["send_to_chain"].append((confirmed - submitted).total_seconds())
            legs["chain_to_hand"].append((in_hand_at - confirmed).total_seconds())
    return {"approved_to_chain": _stats(to_chain), "approved_to_hand": _stats(to_hand),
            "submitted_to_chain": _stats(settle), "not_in_hand_yet": waiting,
            # median seconds per leg of the journey; the figure on the overview is built from these
            "legs": {k: (statistics.median(v) if v else None) for k, v in legs.items()}}


def arrival(conn: db.Connection, now: datetime | None = None) -> dict:
    """Where every paid-out amount is right now: in the beneficiary's hands, still waiting to be
    claimed (and for how long), or returned to the NGO after the claim window."""
    in_hand = conn.execute("SELECT COUNT(*) FROM requests WHERE status = ? OR (status = ? AND method = 'payment')",
                           (Status.CLAIMED, Status.CONFIRMED)).fetchone()[0]
    returned = conn.execute("SELECT COUNT(*) FROM requests WHERE claim_status = 'RECLAIMED'").fetchone()[0]
    pending = unclaimed(conn, now)
    overdue = sum(1 for u in pending if u["overdue"])
    return {"in_hand": in_hand, "waiting": len(pending) - overdue, "overdue": overdue, "returned": returned}


def unclaimed(conn: db.Connection, now: datetime | None = None) -> list[dict]:
    """Claimable balances still waiting for the beneficiary, oldest first."""
    now = now or datetime.now().astimezone()
    out = []
    rows = conn.execute("SELECT request_ref, batch_id, amount, asset, submitted_at FROM requests"
                        " WHERE claim_status = 'UNCLAIMED' AND status = ? ORDER BY submitted_at",
                        (Status.CONFIRMED,)).fetchall()
    for r in rows:
        sent = _ts(r["submitted_at"])
        if not sent:
            continue
        hours = (now - sent).total_seconds() / 3600
        out.append({
            "request_ref": r["request_ref"], "batch_id": r["batch_id"], "amount": r["amount"], "asset": r["asset"],
            "sent_at": r["submitted_at"], "waiting_hours": round(hours, 1),
            "overdue": hours >= config.CLAIM_ALERT_HOURS,
            "reclaim_from": (sent + timedelta(seconds=config.RECLAIM_AFTER_SECONDS)).isoformat(),
        })
    return out


_fee_cache: dict[str, int] = {}


def _fee_stroops(tx_hash: str) -> int | None:
    """Fee actually charged for a transaction (fixed once on chain, so cached)."""
    if tx_hash not in _fee_cache:
        try:
            _fee_cache[tx_hash] = int(sc.horizon().transactions().transaction(tx_hash).call()["fee_charged"])
        except Exception:
            return None
    return _fee_cache[tx_hash]


FEE_SAMPLE = 25  # most recent payouts used for the fee average (each is up to 3 Horizon lookups)


def cost(conn: db.Connection) -> dict:
    """Average network cost per delivered payout: the payment plus its two registry calls.

    All database reads happen first, so no cursor stays open while Horizon is queried."""
    rows = conn.execute("SELECT request_ref, tx_hash, amount FROM requests WHERE status IN (?, ?) AND tx_hash IS NOT NULL"
                        " ORDER BY submitted_at DESC LIMIT ?", (Status.CONFIRMED, Status.CLAIMED, FEE_SAMPLE)).fetchall()
    registry_hashes = {}
    for r in rows:
        registry_hashes[r["request_ref"]] = [
            json.loads(e["detail"] or "{}").get("tx_hash") for e in conn.execute(
                "SELECT detail FROM events WHERE request_ref = ? AND kind IN ('registry_reserved', 'registry_paid')",
                (r["request_ref"],)).fetchall()]
    per_payout, amounts = [], []
    payment_fees, registry_fees = [], []
    for r in rows:
        pay = _fee_stroops(r["tx_hash"])
        if pay is None:
            continue
        reg = sum((_fee_stroops(h) or 0) for h in registry_hashes[r["request_ref"]] if h)
        payment_fees.append(pay)
        registry_fees.append(reg)
        per_payout.append(pay + reg)
        amounts.append(float(r["amount"]))
    if not per_payout:
        return {"payouts": 0}
    avg_xlm = statistics.mean(per_payout) / STROOPS
    avg_usd = avg_xlm * config.XLM_USD
    share = sum(per_payout) / STROOPS * config.XLM_USD / sum(amounts)  # fees / money delivered (AIDUSD = 1 USD)
    return {
        "payouts": len(per_payout),
        "avg_fee_xlm": avg_xlm,
        "avg_payment_fee_xlm": statistics.mean(payment_fees) / STROOPS,
        "avg_registry_fee_xlm": statistics.mean(registry_fees) / STROOPS,
        "avg_fee_usd": avg_usd,
        "cost_share": share,
        "xlm_usd": config.XLM_USD,
        "benchmark": config.COST_BENCHMARK,
        "target": config.COST_TARGET,
    }
