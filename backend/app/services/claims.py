"""Claims: did the beneficiary actually pick up their claimable balance?

A claimable balance is CONFIRMED once created, but the money only reaches the person when
they claim it. This looks each one up on chain:
  still there              -> claim_status UNCLAIMED
  claimed by beneficiary   -> status CLAIMED  (design doc: CONFIRMED -> claim -> CLAIMED)
  claimed by the NGO       -> claim_status RECLAIMED (window expired, money went back)
Direct payments land in the wallet immediately, so they have no claim step."""
from __future__ import annotations


from stellar_sdk.exceptions import NotFoundError

from .. import config, db, stellar_client as sc
from ..db import Status


def balance_id_of(tx_hash: str) -> str | None:
    """The claimable balance created by a payout transaction."""
    server = sc.horizon()
    for op in server.operations().for_transaction(tx_hash).call()["_embedded"]["records"]:
        if op["type"] != "create_claimable_balance":
            continue
        for e in server.effects().for_operation(op["id"]).call()["_embedded"]["records"]:
            if e["type"] == "claimable_balance_created":
                return e["balance_id"]
    return None


def _claimer(balance_id: str) -> tuple[str | None, str | None]:
    """(account that claimed, when), from the balance's operation history."""
    ops = (sc.horizon().operations().for_claimable_balance(balance_id)
           .order(desc=True).limit(20).call()["_embedded"]["records"])
    for op in ops:
        if op["type"] == "claim_claimable_balance" and op.get("transaction_successful", True):
            return op.get("claimant") or op["source_account"], op["created_at"]
    return None, None


def check(conn: db.Connection) -> list[dict]:
    rows = [dict(r) for r in conn.execute(
        "SELECT request_ref, wallet, tx_hash, balance_id FROM requests"
        " WHERE status = ? AND method = 'claimable_balance'", (Status.CONFIRMED,))]
    dist = config.public("DISTRIBUTION")
    results = []
    for row in rows:
        ref, bid = row["request_ref"], row["balance_id"]
        try:
            if not bid:
                bid = balance_id_of(row["tx_hash"])
                conn.execute("UPDATE requests SET balance_id = ? WHERE request_ref = ?", (bid, ref))
            if not bid:
                continue
            try:
                sc.horizon().claimable_balances().claimable_balance(bid).call()
                claim, status, who, at = "UNCLAIMED", Status.CONFIRMED, None, None
            except NotFoundError:  # gone: someone claimed it
                who, at = _claimer(bid)
                if who == row["wallet"]:
                    claim, status = "CLAIMED", Status.CLAIMED
                elif who == dist:
                    claim, status = "RECLAIMED", Status.CONFIRMED
                else:
                    continue  # history not indexed yet; try again next time
        except Exception as exc:  # Horizon hiccup: leave the row as it is
            results.append({"request_ref": ref, "claim_status": None, "error": str(exc)[:200]})
            continue
        conn.execute("UPDATE requests SET status = ?, claim_status = ?, claimed_at = ?, updated_at = ?"
                     " WHERE request_ref = ?", (status, claim, at, db.now(), ref))
        if claim != "UNCLAIMED":
            db.log(conn, ref, claim.lower(), {"balance_id": bid, "by": who, "at": at})
        results.append({"request_ref": ref, "claim_status": claim, "claimed_at": at})
    conn.commit()
    return results
