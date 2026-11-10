# Research notes — Member A (Backend + Stellar)

Answers to A's open questions from the architecture doc. Status: answered from official docs;
confirm each by running `scripts/spike_payment.py` on Testnet.

## 1. Memo: HASH or TEXT?

**Decision: `MEMO_HASH` = SHA-256(request_ref).**

- Stellar memo types: TEXT (≤ 28 bytes), ID (64-bit int), HASH (32 bytes), RETURN (32 bytes).
- HASH fits a SHA-256 digest exactly, hides internal IDs, and contains no identity data.
- Reconciliation recomputes SHA-256(request_ref) for each internal row and matches it to the memo.
- TEXT stays an option for debugging (short refs like `REQ-001` fit in 28 bytes).

## 2. Claimable Balance: trustline and reclaim

**The beneficiary must have a trustline before claiming**, otherwise the claim fails with `op_no_trust`.
So the claim flow is: add trustline + claim, in one transaction (see `step_claim`).
Creating the balance does *not* need the beneficiary's trustline — that is why it works for BEN3.

**Reclaim after N days works** with two claimants:

| Claimant | Predicate | Meaning |
| --- | --- | --- |
| Beneficiary | `before_relative_time(N)` | Can claim within N seconds of creation |
| Distribution | `not(before_relative_time(N))` | Can take it back after N seconds |

Other facts:
- Each claimant raises the creator's minimum XLM balance by one base reserve until the balance is claimed.
- The create operation returns a balance ID, needed to claim. The spike looks it up via Horizon `claimable_balances?claimant=`.

## 3. Query API: RPC or Horizon?

- **Stellar RPC is the recommended API.** Horizon is nearing end-of-life: still maintained, no new features.
- **RPC `getTransaction(hash)`** returns `SUCCESS` / `FAILED` / `NOT_FOUND`. It works for classic payments too.
- **RPC only keeps recent history** (about 7 days on the public provider; check `getHealth.oldestLedger`).

**Implications for AidFlow:**
- Verification (flow 5): use RPC `getTransaction`; fall back to Horizon if not found (implemented in `stellar_common.verify_transaction`).
- Reconciliation scan of the distribution account's payments: **use Horizon** `/accounts/{id}/payments` for the hackathon. RPC can't list an account's history beyond its window. A production system would keep its own index.
- Submission: the spike submits via Horizon (synchronous result, simpler). RPC `sendTransaction` is async; switch later if needed.

## 4. Safe submission (no double payout)

Implemented in `submit_safely`:
1. Build and sign → the tx hash is known before submitting.
2. **Write the hash to the ledger first**, status `SUBMITTED`.
3. Submit. Clear success → `CONFIRMED`; clear rejection → `FAILED`.
4. Timeout / connection error → query by hash for up to `timeout + 10s` → `CONFIRMED`, `FAILED`, or `UNKNOWN`.
5. Every tx has 30-second time bounds, so once the window passes an unknown tx can never land — only then is a retry safe.

## Testnet results (2026-11-09)

All verified with `scripts/spike_payment.py --claim` and `scripts/spike_reclaim.py`.

- [x] Both transactions visible on stellar.expert with the expected memo (`memo_type = hash`;
      Horizon shows it base64-encoded, same bytes as the hex the spike prints)
- [x] `getTransaction` returns `SUCCESS` for a classic payment
- [x] Claim without a trustline is rejected with `op_no_trust`; trustline + claim in one tx succeeds
- [x] Reclaim window: DISTRIBUTION's early reclaim is rejected with `op_cannot_claim`;
      after the window (60 s + 10 s margin) the reclaim succeeds
- [x] Safe-submit ledger: every tx is written as `SUBMITTED` before submit, then `CONFIRMED`

**Fees (`fee_charged`)**: 100 stroops (0.00001 XLM) per operation. Payment = 100,
create claimable balance = 100, trustline + claim = 200 (2 ops). Fee = base fee × ops
while the network is not congested.

Example transactions:
[payment](https://stellar.expert/explorer/testnet/tx/c8357d39df4393f35a35a622d90007da83a5494fa8dadd265661ac4b22125f15) ·
[claimable balance](https://stellar.expert/explorer/testnet/tx/56cad20e369eceddc9a65a79f66d0aa08ab999a6650841a3b55f35eca5bc59a7) ·
[trustline + claim](https://stellar.expert/explorer/testnet/tx/5a790513a549b4ebca53f71be8e36a4452af46941dced4c9c054259be8ff9630) ·
[reclaim after window](https://stellar.expert/explorer/testnet/tx/c6cb6b8ac0f26ce2204bd8d5cf2b9f7044c694d071e096871525f44a7b62eb41)

Note for the backend: the balance ID can be read from the create operation's
`claimable_balance_created` effect (see `spike_reclaim.create_balance`), which is more precise
than listing all balances for a claimant.

## Sources

- [Claimable balances (glossary)](https://developers.stellar.org/docs/glossary/claimable-balance)
- [Claimable balances guide](https://developers.stellar.org/docs/build/guides/transactions/claimable-balances)
- [CLI cookbook: create claimable balance](https://developers.stellar.org/docs/tools/cli/cookbook/tx-new-create-claimable-balance)
- [Stellar data APIs: RPC vs Horizon](https://developers.stellar.org/docs/data/apis.md)
- [Memos](https://developers.stellar.org/docs/encyclopedia/memos)
- [Operations and transactions](https://developers.stellar.org/docs/glossary/operations/)
