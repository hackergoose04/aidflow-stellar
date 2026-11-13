# AidFlow

**Cash aid that can't be paid twice, can't get lost, and can be checked by anyone.**
Screened by AI, decided by people, enforced on Stellar.

Live demo: **https://aidflow-web.vercel.app** · Stellar **Testnet only**: every amount is a test asset (AIDUSD), no real money moves.

---

## The problem

When an NGO sends cash aid to thousands of people, three things keep going wrong:

1. **The same person gets paid twice.** A beneficiary appears twice in a list, two staff members approve the same request, or a payout is retried after a timeout that actually went through. Spreadsheets don't stop any of this.
2. **Money is sent but never reaches the person.** A transfer "succeeds" but sits in an account the beneficiary can't open, and nobody notices until the money is gone or forgotten.
3. **Donors can't check anything.** They get a PDF report and have to take the NGO's word for where the money went.

Manual review of every request doesn't scale, and fully automatic payment is too risky for money meant for people in need.

## How AidFlow solves it

| Problem | What AidFlow does |
| --- | --- |
| Paying twice | Rules and an AI anomaly model flag suspicious requests; a **person approves every payout**; and an **on-chain registry (Soroban smart contract)** refuses a second payment to the same person in the same batch, even if a reviewer approves the duplicate by mistake |
| Money not reaching people | If a wallet can't receive the asset yet, the payout waits on Stellar as a **claimable balance**. The beneficiary claims it with their own key on the Claim page. Unclaimed money returns to the NGO after 30 days instead of disappearing |
| Donors can't verify | **Reconciliation** compares every record against the chain, and the **donor report** links every payment to its Stellar transaction |

```
upload CSV ─► screen (rules + AI) ─► human review ─► register on chain ─► pay on Stellar ─► claim ─► reconcile
               flag duplicates,        approve /       one payout per        payment or         beneficiary   database
               odd amounts, etc.       hold / reject   person per batch      claimable balance  uses own key  vs chain
```

---

## Using the app

The top bar has the operator pages (**Home, Review, Requests, Payments, Reconciliation, Evaluation**) plus two public pages: **Donor view** and **Claim page**. Enter your name in the *Reviewing as* field at the top right before approving anything; every decision is logged with it.

### 1. Home: upload a batch
Click **New batch** and choose a CSV of payout requests. A ready-made one is in [`data/samples/demo_live.csv`](data/samples/demo_live.csv) (4 requests, one person asking twice). Each upload needs fresh request IDs, so generate a new file with `python scripts/make_demo_csv.py` (see [Demo data](#demo-data)).

Home also shows the NGO wallet balance, how much has reached people, how long approval-to-money-in-hand took, and a **Needs your attention** list of things to do next.

### 2. Review: decide
Every request lands here first. Flagged requests show **why** (e.g. *same person twice in one batch*, *wallet changed*) and an **AI risk score**. For each one choose **Approve**, **Hold** (wait for checks) or **Reject**. Requests with no flags can be approved in one click with **Approve all**.

Nothing is paid until a person approves it.

### 3. Payments: pay and verify
Pick the batch in the dropdown, then click **Pay N approved**. Each payout:
- is first **registered on chain**. If the person already has a payout in this batch, the contract refuses and nothing is sent (*Blocked on chain*);
- is sent as a normal **Payment** if the wallet accepts AIDUSD, or as a **Claimable balance** if it doesn't yet (*Waiting for claim*).

**Verify & check claims** looks up payments whose result was unclear and checks which claimable balances have been collected.

### 4. Claim page: the beneficiary collects
The beneficiary opens **/claim**, connects their Stellar wallet (e.g. Freighter, set to Testnet), sees what is waiting for them and claims it, signing with **their own key**. AidFlow never sees it. If their wallet can already receive AIDUSD, the money arrived directly and there is nothing to claim.

### 5. Reconciliation: check against the chain
Compares every database record with what actually happened on Stellar and with the registry: wrong amount, wrong wallet, paid but not recorded, recorded but not on chain, and so on. Anything that doesn't match is listed with the reason.

### 6. Donor view and Evaluation
- **Donor view**: a public summary of what was sent and delivered, where every payment links to its transaction on [stellar.expert](https://stellar.expert/explorer/testnet).
- **Evaluation**: how well the screening works: rules vs AI vs both (see [results](#does-the-ai-help)).

### Suggested 2-minute demo
Upload `demo_live.csv` → Review: Alice is flagged for asking twice; approve both to show the chain stops it → Payments: pick the batch and pay. Alice's second payout is *Blocked on chain* → Claim page: connect the beneficiary wallet and claim → Donor view: click a transaction.

---

## Tech

| Layer | What we used | Why |
| --- | --- | --- |
| Blockchain | **Stellar Testnet**, custom asset **AIDUSD**, Payments + **Claimable Balances** | Fast (seconds) and near-free transfers; claimable balances solve "the wallet isn't ready yet" without the NGO holding anyone's money |
| Smart contract | **Soroban** (Rust) payout registry | One registration per (programme, batch, person). Stores **hashes only**: keys are HMAC-SHA256 with a server-side secret, so no beneficiary ID is visible on chain |
| Backend | **Python, FastAPI**, `stellar-sdk` | Pipeline: ingest → dedup → screening → review → executor → verifier → reconciliation. A payout moves `APPROVED → SUBMITTED` with a conditional update, so two workers can never pay the same request |
| AI | **scikit-learn Isolation Forest**, 10 features (amount vs normal, time of day, request bursts, shared / changed wallets…) | Label-free, so it works for a new programme with no fraud history. It only **flags** for a human, never blocks or pays on its own |
| Database | **Postgres (Neon)** in production, SQLite locally | Same SQL for both |
| Frontend | **Next.js 15, React 19, Tailwind CSS 4**, Stellar Wallets Kit (Freighter etc.) | Operator console, public donor page, and beneficiary claim page |
| Hosting | **Vercel** (frontend and API as two projects) | |

Privacy: beneficiary IDs are stored as HMAC hashes (`H-…`), and the chain only ever sees hashes.

### Does the AI help?
On simulated aid data (1,797 test requests, 180 injected anomalies of 6 types, never seen in training):

| Approach | Sent to a human | Anomalies caught |
| --- | --- | --- |
| A person reviews everything | 100% | 100% |
| Rules only | 11% | 81% |
| AI only | 11% | 87% |
| **Rules + AI (what AidFlow does)** | **14%** | **100%** |

Rules catch what we can name (duplicates, shared wallets); the model catches what we can't (e.g. new accounts at odd hours). This is simulated data, so it shows the workflow, not real-world accuracy. We also tested on the PaySim fraud dataset; details and honest limitations are in [ml/README.md](ml/README.md).

---

## Run it locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python scripts/testnet_setup.py               # create + fund Testnet accounts, issue AIDUSD, write .env

uvicorn backend.app.main:app --reload         # API on http://127.0.0.1:8000 (docs at /docs)
cd frontend && npm install && npm run dev     # app on http://localhost:3000
```

Tests: `pytest backend/tests` (offline). Storage is SQLite unless `DATABASE_URL` (Postgres) is set in `.env`. Never commit `.env`.

On-chain registry (once): `cd contracts/aid_registry && cargo build --target wasm32v1-none --release && cd ../.. && python scripts/registry_deploy.py`

### Demo data
```bash
python scripts/make_demo_csv.py                  # new demo_live.csv with fresh request IDs
python scripts/make_demo_csv.py --carol G...     # pay Carol to your own wallet, then claim on /claim
python scripts/reset_demo.py                     # start from an empty database (asks first on Postgres)
```

To show the claim flow with your own wallet, the wallet must **not** hold AIDUSD yet. If it already does, send the AIDUSD back and remove the asset in Freighter first.

## Repo layout

| Folder | Contents |
| --- | --- |
| `backend/` | FastAPI app and pipeline services ([details](backend/README.md)) |
| `contracts/` | Soroban payout registry ([details](contracts/README.md)) |
| `ml/` | Synthetic data, Isolation Forest, evaluation ([details](ml/README.md)) |
| `frontend/` | Next.js app ([details](frontend/README.md)) |
| `scripts/` | Testnet setup, demo helpers |
| `data/samples/` | Sample CSVs ([format](data/samples/README.md)) |
| `docs/` | Research notes |

## Limits

- **Testnet only.** The network is fixed to Testnet in code; AIDUSD is a test asset.
- The AI model's strongest numbers come from simulated data; on real-world-style fraud it is useful but much weaker (see `ml/README.md`).
- Registering a payout and paying it are two transactions; if the process stops in between, the slot stays *Reserved* until **Verify** resolves it, so it errs on the side of not paying twice.
