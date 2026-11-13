"""Executor: pay APPROVED requests on Stellar, using the safe-submit pattern.

For each request:
  1. (registry on) reserve key = HMAC(program | batch | beneficiary) in the on-chain registry.
     If another request already holds it, the chain refuses and nothing is paid.
  2. build + sign -> store the tx hash as SUBMITTED (committed) -> submit once.
  3. (registry on) CONFIRMED -> mark the key PAID; FAILED -> release it so a retry can reserve it.
The status update in step 2 is conditional on status = APPROVED, so two workers can't pay
the same row.

Each payout is three transactions, each waiting for a ledger (~5 s): about 15 s. Stellar takes
roughly one transaction per source account per ledger, so with one account payouts can only go
one after another. With channel accounts (CHANNEL_SECRETS) each worker thread owns a channel as
its transaction source and K payouts run side by side; the operations stay sourced from
DISTRIBUTION, so the money, the memo and the registry auth are the same either way."""
from __future__ import annotations

import queue
import threading
from concurrent.futures import ThreadPoolExecutor

from .. import config, db, registry, soroban, stellar_client as sc
from ..db import Status


def repair_registry(conn: db.Connection) -> list[str]:
    """Bring local registry state back in line with the chain after an interruption.

    If the backend stops between a confirmed payment and the mark_paid write, the chain can say
    Paid while the database still says RESERVED. Sync it, or mark it paid if that never ran."""
    fixed = []
    rows = conn.execute("SELECT request_ref FROM requests WHERE status IN (?, ?) AND registry_status = 'RESERVED'"
                        " AND registry_key IS NOT NULL", (Status.CONFIRMED, Status.CLAIMED)).fetchall()
    for r in rows:
        ref = r["request_ref"]
        row = db.get(conn, ref)
        try:
            entry = registry.get(bytes.fromhex(row["registry_key"]))
        except Exception:
            continue  # registry unreachable: try next time
        if entry and entry["status"] == "Paid" and entry["request_hash"] == sc.memo_hash(ref):
            conn.execute("UPDATE requests SET registry_status = 'PAID', updated_at = ? WHERE request_ref = ?",
                         (db.now(), ref))
            db.log(conn, ref, "registry_paid", {"tx_hash": None, "synced_from_chain": True})
        else:
            settle_registry(conn, ref, Status.CONFIRMED)
        conn.commit()
        fixed.append(ref)
    return fixed


def _paid_on_chain_already(ref: str) -> str | None:
    """Tx hash of a successful payout carrying this request's memo, if the chain has one."""
    from .recon import fetch_chain_payouts  # local import: recon imports nothing from here
    memo = sc.memo_hash(ref).hex()
    for op in fetch_chain_payouts(sc.distribution_keypair().public_key):
        if op["memo_hex"] == memo:
            return op["tx_hash"]
    return None


def settle_registry(conn: db.Connection, ref: str, status: str) -> None:
    """After a payment's outcome is known, record it in the on-chain registry."""
    row = db.get(conn, ref)
    if not row.get("registry_key") or row.get("registry_status") != "RESERVED":
        return
    key = bytes.fromhex(row["registry_key"])
    try:
        if status == Status.CONFIRMED:
            h = registry.mark_paid(key, row["tx_hash"])
            new = "PAID"
        elif status == Status.FAILED:
            h = registry.release(key)
            new = "RELEASED"
        else:
            return  # UNKNOWN / SUBMITTED: keep the reservation until the outcome is known
    except soroban.ContractError as exc:
        db.log(conn, ref, "registry_error", {"step": "settle", "error": str(exc)[:300]})
        return
    conn.execute("UPDATE requests SET registry_status = ?, updated_at = ? WHERE request_ref = ?",
                 (new, db.now(), ref))
    db.log(conn, ref, f"registry_{new.lower()}", {"tx_hash": h})


def _reserve(conn: db.Connection, row: dict) -> dict | None:
    """Reserve the registry key. Returns a result dict if the request must NOT be paid now."""
    ref = row["request_ref"]
    key = (bytes.fromhex(row["registry_key"]) if row["registry_key"]
           else registry.key_for(row["beneficiary_id"], row["batch_id"], row["payout_slot"]))
    conn.execute("UPDATE requests SET registry_key = ? WHERE request_ref = ?", (key.hex(), ref))
    conn.commit()  # don't hold a write lock (SQLite: the whole file) through the network call
    try:
        outcome, detail = registry.reserve(key, ref)
    except Exception as exc:  # RPC down, etc.: don't pay without the guard; try again later
        db.log(conn, ref, "registry_error", {"step": "reserve", "error": str(exc)[:300]})
        conn.commit()
        return {"request_ref": ref, "status": "APPROVED", "error": f"registry unavailable: {exc}"[:200]}

    if outcome == "BLOCKED":
        error = (f"on-chain registry refused: payout slot {row['payout_slot']} for "
                 f"{row['beneficiary_id']} in batch {row['batch_id']} is {detail.lower()}")
        conn.execute("UPDATE requests SET status = ?, registry_status = 'BLOCKED', error = ?,"
                     " updated_at = ? WHERE request_ref = ?", (Status.FAILED, error, db.now(), ref))
        db.log(conn, ref, "registry_blocked", {"held_by_status": detail, "payout_slot": row["payout_slot"]})
        conn.commit()
        return {"request_ref": ref, "status": "FAILED", "error": error}
    if outcome == "ALREADY_PAID":
        # The registry says this very request was paid: look the payment up, don't pay again.
        conn.execute("UPDATE requests SET status = ?, tx_hash = ?, submitted_at = ?, registry_status = 'PAID',"
                     " error = ?, updated_at = ? WHERE request_ref = ?",
                     (Status.SUBMITTED, detail, db.now(), "registry shows this request paid; verifying",
                      db.now(), ref))
        db.log(conn, ref, "registry_already_paid", {"tx_hash": detail})
        conn.commit()
        return {"request_ref": ref, "status": "SUBMITTED", "error": "already paid per registry; run Verify",
                "tx_hash": detail}

    conn.execute("UPDATE requests SET registry_status = 'RESERVED' WHERE request_ref = ?", (ref,))
    if detail:
        db.log(conn, ref, "registry_reserved", {"tx_hash": detail})
    conn.commit()
    if not detail and (tx := _paid_on_chain_already(ref)):
        # The registry already held our reservation, yet locally this row is APPROVED: the database
        # lost the earlier submit (e.g. a reset mid-flight). The chain remembers; don't pay twice.
        conn.execute("UPDATE requests SET status = ?, tx_hash = ?, submitted_at = ?, error = ?, updated_at = ?"
                     " WHERE request_ref = ?", (Status.SUBMITTED, tx, db.now(),
                                                "earlier payout found on chain; verifying", db.now(), ref))
        db.log(conn, ref, "found_on_chain", {"tx_hash": tx})
        conn.commit()
        return {"request_ref": ref, "status": "SUBMITTED", "error": "earlier payout found on chain; run Verify",
                "tx_hash": tx}
    return None


def run(conn: db.Connection, limit: int = 20, batch: str | None = None) -> list[dict]:
    """Pay up to `limit` APPROVED requests, oldest first; `batch` restricts to one disbursement batch.

    Without channel accounts this pays one request after another on `conn`. With them, one worker
    per channel (each with its own database connection) takes requests from a shared queue."""
    sql, args = "SELECT request_ref FROM requests WHERE status = ?", [Status.APPROVED]
    if batch:
        sql += " AND batch_id = ?"
        args.append(batch)
    refs = [r["request_ref"] for r in conn.execute(sql + " ORDER BY created_at LIMIT ?", (*args, limit)).fetchall()]
    conn.commit()  # end the read transaction before the workers write
    channels = sc.channel_keypairs()[:len(refs)]
    if not channels:
        return [r for ref in refs if (r := _pay_one(conn, ref))]

    todo: queue.Queue[str] = queue.Queue()
    for ref in refs:
        todo.put(ref)
    done: dict[str, dict] = {}
    lock = threading.Lock()

    def worker(channel) -> None:
        wconn = db.connect()
        try:
            with sc.using_channel(channel):
                while True:
                    try:
                        ref = todo.get_nowait()
                    except queue.Empty:
                        return
                    try:
                        result = _pay_one(wconn, ref)
                    except Exception as exc:  # one bad payout must not stop the other workers
                        wconn.rollback()
                        db.log(wconn, ref, "payout_error", {"error": str(exc)[:300]})
                        wconn.commit()
                        result = {"request_ref": ref, "status": db.get(wconn, ref)["status"],
                                  "error": f"{type(exc).__name__}: {exc}"[:200]}
                    if result:
                        with lock:
                            done[ref] = result
        finally:
            wconn.close()

    with ThreadPoolExecutor(max_workers=len(channels)) as pool:
        for f in [pool.submit(worker, ch) for ch in channels]:
            f.result()
    return [done[ref] for ref in refs if ref in done]


def _pay_one(conn: db.Connection, ref: str) -> dict | None:
    """Pay one APPROVED request. None if another worker already took it."""
    dist, asset = sc.distribution_keypair(), sc.aid_asset()
    use_registry = registry.enabled()
    row = db.get(conn, ref)
    if not use_registry and (row["registry_key"] or row["payout_slot"] != config.DEFAULT_PAYOUT_SLOT):
        return {"request_ref": ref, "status": Status.APPROVED,
                "error": "On-chain registry must be configured for this payout"}
    if use_registry:
        stop = _reserve(conn, row)
        if stop:
            return stop

    method = "payment" if sc.has_trustline(row["wallet"], asset) else "claimable_balance"
    source = sc.horizon().load_account((sc.current_channel() or dist).public_key)  # fresh sequence per tx
    tx = sc.build_payout(source, dist, method, row["wallet"], asset, row["amount"], ref)
    tx_hash = tx.hash_hex()

    claimed = conn.execute(
        "UPDATE requests SET status = ?, method = ?, tx_hash = ?, submitted_at = ?, updated_at = ?"
        " WHERE request_ref = ? AND status = ?",
        (Status.SUBMITTED, method, tx_hash, db.now(), db.now(), ref, Status.APPROVED)).rowcount
    if claimed != 1:
        conn.commit()
        return None  # someone else picked it up
    db.log(conn, ref, "submitted", {"tx_hash": tx_hash, "method": method})
    conn.commit()  # the hash is on disk BEFORE the network sees the tx

    status, error = sc.submit(tx)
    claim = "UNCLAIMED" if status == Status.CONFIRMED and method == "claimable_balance" else None
    conn.execute("UPDATE requests SET status = ?, error = ?, claim_status = ?, updated_at = ?"
                 " WHERE request_ref = ?", (status, error, claim, db.now(), ref))
    db.log(conn, ref, status.lower(), {"tx_hash": tx_hash, "error": error})
    conn.commit()
    if use_registry:
        settle_registry(conn, ref, status)
        conn.commit()
    return {"request_ref": ref, "method": method, "status": status, "error": error,
            "tx_hash": tx_hash, "explorer": sc.explorer_link(tx_hash),
            "registry": db.get(conn, ref).get("registry_status")}
