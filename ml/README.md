# AidFlow risk model (member C)

Isolation Forest that gives every aid request a 0..1 risk score. The backend uses it in
`backend/app/services/screening.py`: high-risk requests get an `ml_high_risk` flag and
wait for a human reviewer. Nothing is blocked automatically.

## Run

```bash
python -m ml.generate    # synthetic data -> ml/data/train.csv, test.csv (not committed)
python -m ml.train       # fit model, tune threshold -> ml/models/isoforest.joblib
python -m ml.evaluate    # score unseen test data -> ml/reports/metrics.json
```

## Files

| File | What it does |
| --- | --- |
| `generate.py` | Synthetic requests in weekly batches: normal behaviour + 6 labelled anomaly types |
| `features.py` | 10 features per request, computed from the request and its history. Shared by training and the backend, so they can't drift apart |
| `train.py` | Fits the Isolation Forest without labels, then picks the flag threshold with the best F1 on train |
| `score.py` | Loads the model, turns raw scores into a 0..1 risk (percentile vs training data) |
| `evaluate.py` | Precision/recall on the test set, per anomaly type, vs the backend's rules |

## Features

| Feature | Catches |
| --- | --- |
| `log_amount`, `amount_vs_global`, `amount_vs_own` | unusual amounts, for everyone and for this person |
| `hour_sin`, `hour_cos` | requests at odd hours |
| `ben_requests_24h`, `same_amount_24h`, `log_gap_hours` | bursts and double requests |
| `wallet_ben_count`, `ben_wallet_count` | shared wallets and wallet switches |

## Results on simulated data (test set: 1,797 requests, 180 injected anomalies, never seen in training)

ROC AUC **0.99**. The research question from the design doc: *can ML-assisted screening reduce manual
review while still catching irregular payments?* Compared with the doc's baseline (a person
reviews everything):

| Approach | Sent to review | Workload saved | Anomalies caught | Precision | False positive rate |
| --- | --- | --- | --- | --- | --- |
| All manual review (baseline) | 100% | 0% | 100% | 10% | 100% |
| Rule-based | 11% | 89% | 81% | 76% | 3% |
| AI model only | 11% | 89% | 87% | 79% | 3% |
| **Rules + AI (what the backend does)** | **14%** | **86%** | **100%** | **74%** | **4%** |

Anomalies caught, by type:

| Type | Rules | AI | Rules + AI |
| --- | --- | --- | --- |
| amount_outlier | 89% | 100% | 100% |
| burst | 84% | 100% | 100% |
| duplicate_payout | 100% | 78% | 100% |
| night_new_ben | 0% | 100% | 100% |
| shared_wallet | 100% | 67% | 100% |
| wallet_switch | 100% | 28% | 100% |

Rules are precise on patterns we can name (duplicates, two requests in one batch, shared or
changed wallets). The model catches what rules don't describe (odd-hour new accounts). On this
simulated data, together they catch every injected anomaly while a person reviews 14% of requests.
**Simulated data: this shows the workflow works, not real-world accuracy.** Layers 1 and 2 below
test against real-world-style and real data.

The rules (backend `dedup.py` + `screening.py`): amount above limit, possible duplicate (same
person and amount within 24 h), same person twice in one batch, shared wallet, wallet changed.

## Layer 1: labelled fraud from PaySim (`python -m ml.paysim`)

[PaySim](https://www.kaggle.com/datasets/ealaxi/paysim1): mobile-money transactions simulated
from a real African operator's logs, with fraud labels. Download the zip from Kaggle and
unzip the CSV into `ml/data/paysim/`.

Setup: only TRANSFER rows (532,909, of which 4,097 fraud), mapped recipient → beneficiary/wallet.
The sender's balances are **not** used, because AidFlow never sees them (they would make PaySim
fraud trivial: 96% of frauds empty the victim's account). The model is fitted without labels on
hours 1-400 and tested on hours 401+ (51,469 transfers, 1,868 fraud).

| Method | ROC AUC | Fraud caught reviewing top 1% / 5% / 10% |
| --- | --- | --- |
| Random review (baseline) | 0.51 | 1% / 5% / 11% |
| Model as shipped (synthetic-trained) | 0.61 | 2% / 12% / 19% |
| **Model refit on own history** | **0.79** | **9% / 27% / 49%** |
| Rules (amount > p99, repeat amount) | — | flags 0.1%, catches 0% |

Findings:
1. **Refit on its own history, the model is about 4.5x better than random review**: reviewing
   the top 10% finds about half of the fraud. Useful, but far from the 99% on our own synthetic data.
2. **The synthetic-trained model barely transfers** (AUC 0.61). Same lesson as layer 2.
3. **Our aid rules catch none of this fraud.** PaySim fraud is account takeover (drain and cash
   out). That is a different threat from aid fraud (duplicates, shared wallets), so the rules
   aren't built for it.
4. **The signal comes from two features**: `log_gap_hours` (first-time or rarely-used recipient,
   AUC 0.79 alone) and time of day (`hour_sin`, 0.74: fraud happens at night, normal transfers
   don't). Amount carries almost nothing (0.54). The gap feature alone has the same AUC as the
   model but ranks much worse at the top (21% vs 49% caught at a 10% budget), so the model
   does add value where reviewers look.

### Should we switch models? (same features, same split)

| Model | Needs labels | ROC AUC | Fraud caught at top 1% / 5% / 10% |
| --- | --- | --- | --- |
| **Isolation Forest (current)** | no | 0.79 | 9% / 27% / 49% |
| Local Outlier Factor | no | 0.64 | 14% / 30% / 36% |
| Gap feature alone, no model | no | 0.79 | 4% / 11% / 21% |
| Gradient boosting | **yes** | 0.86 | 18% / 44% / 56% |

Keep Isolation Forest. It is the best of the label-free options, and a new deployment has no
labels. A supervised model is better, but by less than you'd expect (+7 points at a 10% budget),
and it needs labelled history: the reviewers' approve/decline decisions could become that over
time. The ceiling is the features, not the algorithm.

## Layer 2: real Stellar mainnet payouts (`python -m ml.mainnet <account>`)

Reads a public payout account's outgoing USDC payments from mainnet Horizon (read-only,
no labels) and measures how much would be sent to review. Tested on `GAUA7XL5…PNJU`, an
unlabelled 9-signer account that made 19,223 USDC payouts to 4,372 recipients in ~8 hours
(2026-11-09). It looks like an exchange or payment provider, not an aid program.

Five recipients took 55% of the payouts (one took 8,942), which looks like omnibus or exchange
accounts. Excluding the recipients paid more than 50 times (`--max-per-recipient 50`) leaves
8,334 person-like payouts. Share of those that would go to human review:

| Screening | Flagged |
| --- | --- |
| Rules only | 8.5% |
| Model as shipped (trained on synthetic data) | **72.7%** |
| Model refit on this account's own history | 11.9% |
| Rules + refit model | 13.8% |

Findings:
1. **The synthetic-trained model does not transfer.** Real amounts and rhythms differ, so it
   flags nearly three quarters of real payouts. Isolation Forest needs no labels, so a deployment must
   fit it on the organisation's own payout history first.
2. **Refit on real history, ~14% would go to a person**, against 4.5% on synthetic data.
   Real behaviour is more varied. The threshold would need tuning with the reviewers.
3. **The top-flagged payouts make sense**: recipients who normally get ~$20-30 suddenly
   receiving $1,000-2,800 (50-130x their own usual amount).
4. **The duplicate rule depends on the program.** It fires on 46% of the raw data
   (repeat payments to omnibus accounts) but on 4% of the person-like payouts. A program
   with daily stipends would need it tuned.

Limits: one account, 8 hours, not an aid program, no ground truth. Shared-wallet and
wallet-change rules can't be tested because on chain the beneficiary *is* the wallet.

## Caveats

- The data is synthetic. The numbers show the pipeline works, not real-world accuracy.
- Retrain after changing `features.py` (the backend refuses a model trained on other features).
