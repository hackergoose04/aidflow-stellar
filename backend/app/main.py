"""AidFlow API.  Run from the repo root:  uvicorn backend.app.main:app --reload
Interactive docs: http://127.0.0.1:8000/docs

Pipeline: upload CSV -> dedup + screening flags -> human review -> pay -> verify -> reconcile."""
from __future__ import annotations

import json
import logging
import os
from collections.abc import Iterator

from fastapi import Depends, FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, StringConstraints
from typing import Annotated

from . import config, db, identity, public, registry, stellar_client as sc
from .db import Status
from .services import claims, delivery, executor, ingest, recon, review, verifier

app = FastAPI(title="AidFlow", description="Aid payout monitoring and reconciliation on Stellar Testnet")


# Registered before CORS so it sits inside it: an unexpected error becomes a JSON 500 that still
# carries CORS headers, so the browser shows the message instead of "can't reach the backend".
@app.middleware("http")
async def json_errors(request, call_next):
    try:
        return await call_next(request)
    except Exception as exc:  # noqa: BLE001
        logging.getLogger("aidflow").exception("unhandled error on %s", request.url.path)
        return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"[:300]})


app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(","),
    # Deployed: also the frontend's preview URLs, e.g. https://aidflow-web-.*\.vercel\.app
    allow_origin_regex=os.getenv("CORS_ORIGIN_REGEX") or None,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(public.router)


def get_conn() -> Iterator[db.Connection]:
    conn = db.connect()
    try:
        yield conn
    finally:
        conn.close()


# A decision always names the person who made it: the audit trail is only worth something then.
Reviewer = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class Decision(BaseModel):
    reviewer: Reviewer
    note: str | None = None


class Correction(BaseModel):
    reviewer: Reviewer
    note: str | None = None
    beneficiary_id: str | None = None  # real ID; stored only as its HMAC token
    wallet: str | None = None
    amount: str | None = None
    batch_id: str | None = None
    payout_slot: str | None = None
    created_at: str | None = None


@app.get("/health")
def health() -> dict:
    return {"ok": True, "network": "testnet"}


@app.get("/summary")
def summary(conn: db.Connection = Depends(get_conn)) -> dict:
    counts = {s.value: 0 for s in Status}
    for r in conn.execute("SELECT status, COUNT(*) AS n FROM requests GROUP BY status"):
        counts[r["status"]] = r["n"]
    flagged = conn.execute("SELECT COUNT(*) FROM requests WHERE status = ? AND flags != '[]'",
                           (Status.PENDING_REVIEW,)).fetchone()[0]
    recon_counts = {c: 0 for c in recon.CATEGORIES}
    for r in conn.execute("SELECT recon_status, COUNT(*) AS n FROM requests"
                          " WHERE recon_status IS NOT NULL GROUP BY recon_status"):
        recon_counts[r["recon_status"]] = r["n"]
    last_recon = conn.execute("SELECT MAX(recon_at) FROM requests").fetchone()[0]
    batches = [dict(r) for r in conn.execute(
        "SELECT batch_id, COUNT(*) AS requests,"
        " SUM(CASE WHEN status IN ('CONFIRMED', 'CLAIMED') THEN 1 ELSE 0 END) AS confirmed,"
        " SUM(CASE WHEN flags != '[]' THEN 1 ELSE 0 END) AS flagged,"
        " CAST(ROUND(SUM(CAST(amount AS NUMERIC)), 2) AS DOUBLE PRECISION) AS amount"
        " FROM requests GROUP BY batch_id ORDER BY batch_id")]
    risk = [r[0] for r in conn.execute("SELECT risk_score FROM requests WHERE risk_score IS NOT NULL")]
    hist = [0] * 10
    for x in risk:
        hist[min(9, int(x * 10))] += 1
    reg = {"enabled": registry.enabled(), "contract": registry.contract_id(),
           "explorer": registry.explorer_contract(), "program": registry.program()}
    for r in conn.execute("SELECT registry_status, COUNT(*) AS n FROM requests"
                          " WHERE registry_status IS NOT NULL GROUP BY registry_status"):
        reg[r["registry_status"]] = r["n"]
    return {"by_status": counts, "pending_flagged": flagged, "recon": recon_counts, "registry": reg,
            "last_recon": last_recon, "batches": batches, "risk_histogram": hist,
            "payout_lanes": max(1, len(sc.channel_keypairs()))}


@app.get("/delivery")
def delivery_metrics(conn: db.Connection = Depends(get_conn)) -> dict:
    """Decision -> money in hand, and payouts still waiting for the beneficiary (last mile)."""
    return {"timing": delivery.timing(conn), "unclaimed": delivery.unclaimed(conn),
            "arrival": delivery.arrival(conn), "alert_hours": config.CLAIM_ALERT_HOURS}


@app.get("/delivery/cost")
def delivery_cost(conn: db.Connection = Depends(get_conn)) -> dict:
    """Network fees actually charged per payout (reads Horizon, so kept off /summary)."""
    return delivery.cost(conn)


@app.get("/wallet")
def wallet() -> dict:
    """Distribution account balances, for the dashboard."""
    try:
        dist = config.public("DISTRIBUTION")
        balances = sc.horizon().accounts().account_id(dist).call()["balances"]
    except Exception as exc:  # no .env yet, or Horizon unreachable
        raise HTTPException(503, f"wallet unavailable: {exc}")
    out = {b.get("asset_code", "XLM"): b["balance"] for b in balances}
    return {"account": dist, "balances": out,
            "explorer": f"https://stellar.expert/explorer/testnet/account/{dist}"}


@app.get("/ml/metrics")
def ml_metrics() -> dict:
    path = config.ROOT / "ml" / "reports" / "metrics.json"
    if not path.exists():
        raise HTTPException(404, "no metrics yet: run python -m ml.evaluate")
    return json.loads(path.read_text())


@app.get("/beneficiaries/lookup")
def lookup_beneficiary(id: str) -> dict:
    """Real beneficiary ID -> the pseudonymous token the database uses. Nothing is stored."""
    try:
        return {"token": identity.pseudonymize(id)}
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))


@app.get("/eval/recon")
def recon_eval() -> dict:
    path = config.ROOT / "ml" / "reports" / "recon_eval.json"
    if not path.exists():
        raise HTTPException(404, "no recon evaluation yet: run python scripts/recon_eval.py")
    return json.loads(path.read_text())


@app.post("/requests/upload")
async def upload(file: UploadFile, conn: db.Connection = Depends(get_conn)) -> dict:
    text = (await file.read()).decode("utf-8")
    try:
        return ingest.ingest_csv(conn, text)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@app.get("/requests")
def list_requests(status: Status | None = None, flagged: bool | None = None,
                  batch: str | None = None, recon_status: str | None = None,
                  conn: db.Connection = Depends(get_conn)) -> list[dict]:
    sql, args = "SELECT * FROM requests WHERE 1=1", []
    if status:
        sql += " AND status = ?"
        args.append(status)
    if batch:
        sql += " AND batch_id = ?"
        args.append(batch)
    if recon_status:
        sql += " AND recon_status = ?"
        args.append(recon_status)
    if flagged is not None:
        sql += " AND flags != '[]'" if flagged else " AND flags = '[]'"
    return [db.to_dict(r) for r in conn.execute(sql + " ORDER BY created_at", args)]


@app.get("/requests/{ref}")
def get_request(ref: str, conn: db.Connection = Depends(get_conn)) -> dict:
    row = db.get(conn, ref)
    if row is None:
        raise HTTPException(404, f"{ref} not found")
    row["events"] = [dict(e) for e in conn.execute(
        "SELECT kind, detail, at FROM events WHERE request_ref = ? ORDER BY id", (ref,))]
    return row


def _decide(conn, ref, approve, body: Decision):
    try:
        return review.decide(conn, ref, approve, body.reviewer, body.note)
    except LookupError:
        raise HTTPException(404, f"{ref} not found")
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@app.post("/requests/{ref}/approve")
def approve(ref: str, body: Decision, conn: db.Connection = Depends(get_conn)) -> dict:
    return _decide(conn, ref, True, body)


@app.post("/requests/{ref}/reject")
def reject(ref: str, body: Decision, conn: db.Connection = Depends(get_conn)) -> dict:
    return _decide(conn, ref, False, body)


@app.post("/requests/{ref}/hold")
def hold(ref: str, body: Decision, conn: db.Connection = Depends(get_conn)) -> dict:
    return _guard(lambda: review.hold(conn, ref, body.reviewer, body.note), ref)


@app.post("/requests/{ref}/correct")
def correct(ref: str, body: Correction, conn: db.Connection = Depends(get_conn)) -> dict:
    changes = body.model_dump(exclude={"reviewer", "note"}, exclude_none=True)
    return _guard(lambda: review.correct(conn, ref, changes, body.reviewer, body.note), ref)


def _guard(fn, ref):
    try:
        return fn()
    except LookupError:
        raise HTTPException(404, f"{ref} not found")
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@app.post("/requests/{ref}/retry")
def retry(ref: str, body: Decision, conn: db.Connection = Depends(get_conn)) -> dict:
    try:
        return review.retry(conn, ref, body.reviewer)
    except LookupError:
        raise HTTPException(404, f"{ref} not found")
    except ValueError as exc:
        raise HTTPException(409, str(exc))


@app.post("/review/approve-clean")
def approve_clean(body: Decision, conn: db.Connection = Depends(get_conn)) -> dict:
    refs = review.approve_clean(conn, body.reviewer)
    return {"approved": len(refs), "request_refs": refs}


@app.post("/payouts/run")
def run_payouts(limit: int = 20, batch: str | None = None, conn: db.Connection = Depends(get_conn)) -> list[dict]:
    """Pay approved requests, oldest first. `batch` pays one disbursement batch only."""
    return executor.run(conn, limit, batch)


@app.post("/payouts/verify")
def verify_payouts(conn: db.Connection = Depends(get_conn)) -> list[dict]:
    return verifier.run(conn)


@app.post("/payouts/claims")
def check_claims(conn: db.Connection = Depends(get_conn)) -> list[dict]:
    """Have beneficiaries picked up their claimable balances?"""
    return claims.check(conn)


@app.post("/recon/run")
def run_recon(conn: db.Connection = Depends(get_conn)) -> dict:
    return recon.run(conn)
