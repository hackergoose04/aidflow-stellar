# AidFlow

AI-assisted payment monitoring and reconciliation on Stellar (Testnet only).

## Repo layout

| Folder | Owner | Contents |
| --- | --- | --- |
| `backend/` | A | FastAPI app; `app/services/` = ingest, dedup, screening, review, executor, verifier, recon |
| `ml/` | C | Synthetic data, Isolation Forest, evaluation |
| `frontend/` | D | Next.js dashboard: overview, review, requests, payouts, reconciliation |
| `contracts/` | B | Soroban payout registry (Plan B): one payout per approved slot, hashes only |
| `scripts/` | A | Testnet setup and research spikes |
| `data/samples/` | C | Sample CSVs everyone builds against |
| `docs/` | all | Research notes |

## Member A spike: run it

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

python scripts/spike_payment.py --dry-run   # offline sanity check, no network
python scripts/testnet_setup.py              # create + fund accounts, issue AIDUSD, write .env
python scripts/spike_payment.py              # Payment to BEN1 + Claimable Balance to BEN3
python scripts/spike_payment.py --claim      # also: BEN3 adds trustline and claims
python scripts/spike_reclaim.py              # edge cases: op_no_trust, reclaim after 60 s window
```

Open the printed `stellar.expert` links to see each transaction and its memo.

## Backend

```bash
uvicorn backend.app.main:app --reload   # then open http://127.0.0.1:8000/docs
pytest backend/tests                    # offline tests
```

Details: [backend/README.md](backend/README.md). Request CSV format: [data/samples/README.md](data/samples/README.md).

## Frontend

```bash
cd frontend && npm install && npm run dev   # http://localhost:3000, needs the backend on :8000
```

Details: [frontend/README.md](frontend/README.md).

## On-chain registry (Plan B)

```bash
cd contracts/aid_registry && cargo test && cargo build --target wasm32v1-none --release && cd ../..
python scripts/registry_deploy.py   # deploy once; backend then registers every payout
python scripts/registry_demo.py     # duplicate approved by mistake -> refused on chain
python scripts/make_demo_csv.py     # data/samples/demo_live.csv: small batch paying your own Testnet accounts
```

Details: [contracts/README.md](contracts/README.md).

## Demo helpers

```bash
python scripts/reset_demo.py        # back up the database, start fresh with the sample batch
python scripts/make_demo_csv.py     # small live batch paying your own Testnet accounts
python scripts/beneficiary_claim.py # after paying demo_live.csv: BEN-CAROL claims her money -> CLAIMED
python scripts/make_demo_csv.py --carol G...  # BEN-CAROL = your own wallet: claim it on /claim with Freighter
python scripts/claim_demo.py        # self-contained CLAIMED demo on a throwaway database
```

`.env` holds two HMAC secrets: `REGISTRY_SECRET` (on-chain registry keys) and `PII_HMAC_SECRET`
(beneficiary IDs in the database). Keep both, and never commit `.env`.

## ML

```bash
python -m ml.generate && python -m ml.train && python -m ml.evaluate
```

Details and results: [ml/README.md](ml/README.md).
If Testnet is reset, run `python scripts/testnet_setup.py --reset`.

Findings: [docs/research-A-stellar.md](docs/research-A-stellar.md).
