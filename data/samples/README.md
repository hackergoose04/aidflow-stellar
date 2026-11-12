# Sample data

Agreed request format. Everyone (backend, ML, frontend) builds against this.
Regenerate with `python scripts/make_sample_csv.py`.

## `requests.csv`: one row per aid payout request

| Field | Type | Meaning | Example |
| --- | --- | --- | --- |
| `request_ref` | string, unique | Internal request ID. On chain only its SHA-256 appears (memo). | `REQ-0001` |
| `batch_id` | string, optional | Disbursement batch. If omitted, the upload gets its own batch. Reuse the batch ID for the same program batch. | `BATCH-01` |
| `payout_slot` | string, optional | Authorized payout within the batch. Defaults to `base`. Configure extra slot IDs with `PAYOUT_SLOTS`; each extra payout needs individual review and the on-chain registry. Reuse the slot on reupload and retry. | `medical_supplement` |
| `beneficiary_id` | string | Internal beneficiary ID. Never sent on chain. | `BEN-017` |
| `wallet` | Stellar public key | Where the money goes (`G...`, 56 chars) | `GDD4...LSJN` |
| `amount` | decimal > 0 | Amount in `asset` | `50` |
| `asset` | string | Asset code | `AIDUSD` |
| `created_at` | ISO 8601 UTC | When the request was made | `2026-11-01T09:30:00+00:00` |

Extra columns are allowed and ignored by the backend, so ML can add features
(region, channel, ...) without breaking ingest.

## `requests_labels.csv`: ground truth for planted problems

Built with the same generator as the ML training data (`ml/generate.py`).
Rows not listed are normal. Labels:

| Label | What it is | Caught by |
| --- | --- | --- |
| `duplicate_ref` | Same `request_ref` twice | ingest (reject) |
| `invalid_wallet` | Not a valid Stellar address | ingest (reject) |
| `invalid_amount` | Amount ≤ 0 | ingest (reject) |
| `duplicate_payout` | Same person and amount within hours, new ref | dedup rules |
| `amount_outlier` | 8-40x the person's usual amount | amount rule / ML |
| `shared_wallet` | A new beneficiary ID using someone else's wallet | shared-wallet rule |
| `wallet_switch` | Existing person suddenly uses a new wallet | wallet-changed rule |
| `burst` | One person files 4-6 requests within 12 hours | same-batch rule / ML |
| `night_new_ben` | New person, new wallet, 01:00-04:00, high amount | ML |
