# AidFlow backend

FastAPI app. Stores requests in SQLite (`data/aidflow.db`), pays on Stellar **Testnet**.

## Run

From the repo root, after `scripts/testnet_setup.py` has written `.env`:

```bash
pip install -r requirements.txt
uvicorn backend.app.main:app --reload
```

Open http://127.0.0.1:8000/docs to try every endpoint in the browser.

Tests (offline, no network): `pytest backend/tests`

## Pipeline

```
upload CSV ──► ingest ──► dedup ──► screening ──► review ──► executor ──► verifier ──► recon
              reject bad   flag      flag rules    human      pay on       resolve       compare DB
              rows         doubles   + ML score    yes/no     Stellar      unclear txs   vs chain
```

Matches the design doc's payment state machine (its VALIDATED / FLAGGED / CLEARED are
`PENDING_REVIEW` with or without flags).

| Status | Meaning | Next |
| --- | --- | --- |
| `INVALID` | Failed validation at upload; kept so it can be fixed | correct / reject (or re-upload the ref) |
| `PENDING_REVIEW` | Ingested; may carry flags | approve / hold / correct / reject |
| `HELD` | Parked by a reviewer for further checks | approve / correct / reject |
| `APPROVED` | Reviewer said yes | `POST /payouts/run` |
| `REJECTED` | Reviewer said no | end |
| `SUBMITTED` | Tx hash saved, sent to Stellar | resolves to one of the below |
| `CONFIRMED` | On chain, successful | claimable balances: `POST /payouts/claims` |
| `CLAIMED` | The beneficiary picked up their claimable balance | end |
| `FAILED` | Rejected, or expired without landing | `POST /requests/{ref}/retry` |
| `UNKNOWN` | Submit outcome unclear | `POST /payouts/verify` |

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/summary` | Counts by status and reconciliation result, batches, risk histogram |
| GET | `/delivery` | Approval → on chain → money in hand (median times), and payouts still unclaimed (last mile) |
| GET | `/delivery/cost` | Network fees actually charged per payout, incl. registry calls, as a share of the amount |
| GET | `/ml/metrics` · `/eval/recon` | Screening evaluation · reconciliation accuracy |
| POST | `/requests/upload` | Upload a CSV (format: `data/samples/README.md`) |
| GET | `/requests?status=&flagged=&batch=&recon_status=` | List requests |
| GET | `/requests/{ref}` | One request plus its audit trail |
| POST | `/requests/{ref}/approve` · `/hold` · `/reject` · `/retry` | Body: `{"reviewer": "...", "note": "..."}` |
| POST | `/requests/{ref}/correct` | Fix `beneficiary_id` (real ID, hashed) / `wallet` / `amount` / `batch_id` / `created_at`; re-validated, re-screened, logged |
| GET | `/beneficiaries/lookup?id=` | Real beneficiary ID → its token (computed, not stored) |
| POST | `/payouts/claims` | Which claimable balances were picked up (→ `CLAIMED`) or returned to the NGO |
| GET | `/public/summary` · `/public/batches/{id}` · `/public/payments/{ref}` | Donor view: amounts, outcomes, transactions. No personal data |
| GET | `/public/claimable?wallet=G…` | Payouts waiting for that wallet to claim (reference, batch, amount, balance id). For the claim page |
| POST | `/review/approve-clean` | Approve every pending request with no flags |
| POST | `/payouts/run?limit=20` | Pay approved requests |
| POST | `/payouts/verify` | Look up SUBMITTED / UNKNOWN txs by hash |
| POST | `/recon/run` | Reconcile every request with the chain (results also stored per request) |

## Design notes

- **No raw identity data.** The beneficiary ID is replaced at upload by
  `H-` + HMAC-SHA256(`PII_HMAC_SECRET`, id)[:16]. The same person keeps the same token, so dedup,
  screening and ML still work. Keep `PII_HMAC_SECRET` safe and stable.
- **Delivery method is automatic.** Wallet exists and trusts AIDUSD → Payment.
  Otherwise → Claimable Balance (beneficiary can claim for 30 days, then the NGO can reclaim).
- **On-chain registry (Plan B).** With the registry enabled, each payout reserves a key for
  its program, batch, beneficiary and payout slot. CSVs without a slot use `base`. Additional
  slots configured in `PAYOUT_SLOTS` require individual review and the registry. See `contracts/README.md`.
- **No double payout.** The tx hash is committed as `SUBMITTED` before the tx is sent, and only
  rows still `APPROVED` can be claimed by the executor. An unclear submit is looked up by hash,
  never resent. A `FAILED` row can be retried because its tx's 30-second time bounds have passed.
- **Recon** links chain and DB through the memo (`SHA-256(request_ref)`) and compares transaction,
  amount, wallet, **asset** and status. Each request gets one of the design doc's four results:
  `MATCHED`, `PENDING_VERIFICATION`, `MISMATCH` (with reasons: amount / wallet / asset / tx hash
  differs, missing on chain, paid N times, paid although rejected or failed) or `NOT_EXECUTED`.
  Payouts on chain with no matching request are listed as `unrecorded_on_chain`.
  Accuracy on a synthetic ledger with injected discrepancies: `python scripts/recon_eval.py`.
- **ML risk score**: `services/screening.py::ml_score` scores new requests with the model in
  `ml/` (history = all stored requests), stores `risk_score` and adds `ml_high_risk` above the
  tuned threshold. If no model file exists, screening falls back to rules only. See `ml/README.md`.
- **Rules**: amount above limit, shared wallet, wallet changed, possible duplicate, repeated
  payout slot in a batch, and additional payout needing review.
- **Review** follows the design doc: approve, hold for further review, correct, or reject. A
  correction is re-validated and re-screened, and its old/new values go to the audit trail.
- Settings (`AMOUNT_LIMIT`, `DUPLICATE_WINDOW_HOURS`, `RECLAIM_AFTER_SECONDS`, `AIDFLOW_DB`)
  can be overridden in `.env`.

## Testnet demo with real payouts

The sample CSV's wallets don't exist on chain (they'd all become claimable balances).
For a visible demo, upload a CSV whose wallets are your `BEN1_PUBLIC` / `BEN2_PUBLIC`
from `.env`. Those get plain Payments, and any new address gets a Claimable Balance.
