# AidFlow on-chain payout registry (Plan B)

A Soroban contract that records **hashes only** and never touches money. It guarantees one
payout per beneficiary per program and batch, even if a reviewer approves a duplicate by
mistake or the backend runs twice.

```
key          = HMAC-SHA256(REGISTRY_SECRET, PROGRAM_ID | batch_id | beneficiary_id)
               (PROGRAM_ID namespaces a programme; scripts/reset_demo.py issues a new one per reset)
request_hash = SHA-256(request_ref)          (also the payment's memo)
```

The HMAC secret stays in `.env`, so the chain shows no beneficiary IDs, and nobody can test
guesses of IDs against it. The payment itself stays a normal Stellar Payment or Claimable Balance.

| Function | Who | What |
| --- | --- | --- |
| `register(key, request_hash)` | admin | RESERVED. Refused (`#1 AlreadyRegistered`) if the key exists |
| `mark_paid(key, tx_hash)` | admin | PAID, stores the payment's transaction hash |
| `release(key)` | admin | Frees a RESERVED key after a failed payment. Refused (`#3`) once PAID |
| `get(key)` / `is_registered(key)` | anyone | Read the entry |

Admin = the NGO's distribution account. Entries live about a year; an archived entry
still blocks `register` until restored, so expiry never silently allows a repeat.

## How the backend uses it (`backend/app/registry.py`, `services/executor.py`)

1. `register` before paying. If another request holds the key, the request becomes
   FAILED / registry BLOCKED and nothing is paid.
2. Pay as usual (hash recorded before sending).
3. Confirmed → `mark_paid`. Failed → `release`, so a retry can register again.
   Unclear → stays RESERVED until `/payouts/verify` resolves it.

Registering and paying are separate transactions (a Soroban call can't share a transaction
with a classic payment). If the process stops in between, the key stays RESERVED with this
request's hash, and the next run recognises it as its own and continues.
Reconciliation also checks each confirmed payment's registry entry (PAID, same request, same tx).

## Build, test, deploy

```bash
cd contracts/aid_registry
cargo test                                         # 8 tests
cargo build --target wasm32v1-none --release
cd ../.. && python scripts/registry_deploy.py      # writes REGISTRY_CONTRACT_ID, REGISTRY_SECRET to .env
python scripts/registry_demo.py                    # live demo: duplicate approved by mistake, refused on chain
```

Uses `soroban-sdk` 23 (newer versions require `stellar contract build` from the Stellar CLI).
Testnet contract: `CAQ6EIKCEIKNS4HT6TJL34BXU3NG24R3BMJ7NZB6BGF72ZAVJVKRF6M4`.
