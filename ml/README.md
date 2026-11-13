# AidFlow risk model (member C)

Isolation Forest that gives every aid request a 0..1 risk score. The backend uses it in
`backend/app/services/screening.py`: high-risk requests get an `ml_high_risk` flag and
wait for a human reviewer. Nothing is blocked automatically.

See [AidFlow screening and ML](../docs/screening-and-ml.md) for the research timeline,
current screening behavior, and results across the synthetic and public datasets.

## Run the original synthetic benchmark

```bash
python -m ml.generate    # synthetic data -> ml/data/train.csv, test.csv (not committed)
python -m ml.train       # fit model, tune threshold -> ml/models/isoforest.joblib
python -m ml.evaluate    # score unseen test data -> ml/reports/metrics.json
```

## Original benchmark files

| File | What it does |
| --- | --- |
| `generate.py` | Synthetic requests in weekly batches: normal behaviour + 6 labelled anomaly types |
| `features.py` | 10 features per request, computed from the request and its history. Shared by training and the backend, so they can't drift apart |
| `train.py` | Fits the Isolation Forest without labels, then picks the flag threshold with the best F1 on train |
| `score.py` | Loads the model, turns raw scores into a 0..1 risk (percentile vs training data) |
| `evaluate.py` | Precision/recall on the test set, per anomaly type, vs the backend's rules |

## Original benchmark features

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
| **Rules + AI (original demo policy)** | **14%** | **86%** | **100%** | **74%** | **4%** |

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

### Time-of-day feature check on the cached USDC replay

```powershell
python -m ml.real_payment_benchmark ml/data/mainnet_GAUA7XL5.csv --compare-time-of-day
```

The command preserves the observed UTC timestamps and uses the same chronological
USDC holdout for each comparison. Candidate thresholds come from a 10% validation
review budget. The deployed model keeps its original threshold for the comparison.
Read `time_of_day_comparison` in `ml/data/aid_benchmark/real_usdc_shared_features.json`.
The USDC holdout is unlabeled and spans part of a single hour, so the comparison
measures review workload for that slice. An assessment of time of day as a risk
signal needs the program's expected payment schedule and outcomes across hours.

### Fixed program history

To train a fixed-history program bundle, supply one asset and the standard
request columns plus `available_at` (when the data became visible) and `split`
(`train`, `validation`, `test`) in strictly chronological windows. Optional
`normal` and `anomaly` labels are used for holdout reporting only. Other values
remain unlabeled.

```powershell
python -m ml.train --fixed-history ml/data/program_history.csv --program AIDFLOW-DEMO --output ml/data/program.joblib
```

The bundle freezes the training median for `amount_vs_global` and calibrates
the threshold with validation scores. The current live model uses behavior features
only. Amount, amount-derived features, and wall-clock time remain available for
offline comparisons. Amount and request-time window rules are configured in Home.
The live model uses request frequency, gaps between requests, and wallet and
beneficiary history when supported. Personal history requires both an earlier
request timestamp and an earlier availability timestamp. A CSV upload is one
availability window. Older database rows without recorded availability can still
be screened with the original bundle. Fixed-history models exclude those rows
from prior-history features. A correction records the availability of the updated
values and recomputes its score. Previously stored scores and review decisions are
retained. Set `AIDFLOW_MODEL_PATH` to use the new bundle for its configured program
and asset. Instances with only the original amount-and-time model use rules-only
screening until a compatible bundle is configured. Historical metrics remain
available in Evaluation as synthetic benchmark results.

### Calibrated local USDC replay

The [latest replay input ZIP](../data/samples/real_usdc_replay.zip) contains the exact
`real_usdc_clean.csv` used for the 4,492-payment replay. These are public Stellar
Mainnet USDC transfers. The recipient wallet also serves as the beneficiary proxy.
The ZIP contains the CSV only. The source has no verified anomaly labels.

```powershell
Expand-Archive -LiteralPath data/samples/real_usdc_replay.zip -DestinationPath ml/data/aid_benchmark
python -m ml.usdc_replay ml/data/aid_benchmark/real_usdc_clean.csv ml/data/usdc-replay
```

Set `PII_HMAC_SECRET` first and reuse it when serving the resulting `replay.db`.
The command fits on earlier windows, calibrates the review threshold on the
next windows, and checks the later holdout against the actual screening flags.
For the local API, set `AIDFLOW_DB` to the new `replay.db`, `AIDFLOW_MODEL_PATH` to
`isoforest-usdc.joblib`, `ASSET_CODE=USDC`, `AMOUNT_LIMIT=off` and
`CHECK_BATCH_PAYOUT_SLOT=off`. The latter skips checking aid payout slots on
five-minute replay windows. The repeated-amount rule still runs. The output
`summary.json` reports both full-replay workload and the held-out results.
To compare the amount rule on the same replay, set `AMOUNT_LIMIT=500` and run
again with `--apply-amount-limit` and a fresh output directory. The amount rule
adds a review flag independently of the Isolation Forest score.

The replay bundle stores feature medians from its training window. For each ML
flag, AidFlow tests the score after replacing one feature group at a time with
those medians. Review shows up to two groups with the largest score drops. These
are sensitivity checks for the stored model and do not establish a payment error.

## Public Auxílio Emergencial benchmark

This offline benchmark fits Isolation Forest on monthly records from Brazil's
[Auxílio Emergencial public export](https://portaldatransparencia.gov.br/download-de-dados/auxilio-emergencial).
Use complete monthly exports from a comparable policy period, with at least four months
for history, training, validation and testing. The
[data dictionary](https://portaldatransparencia.gov.br/dicionario-de-dados/auxilio-emergencial)
describes installment month, beneficiary identifiers, amount, cohort and administrative status.

For example, with July through October 2021 exports in `ml/data/auxilio_emergencial/raw/`:

```powershell
$files = Get-ChildItem ml/data/auxilio_emergencial/raw -Filter '*.zip'
python -m ml.prepare_auxilio_emergencial $files.FullName --sample-rate 0.01
python -m ml.auxilio_emergencial_benchmark --validation-start 202109 --test-start 202110
```

The preparation command samples stable beneficiary histories, writes pseudonymized inputs
and stores outcomes in a separate file. The first month supplies history. Months before the
validation boundary fit the two Isolation Forests. The amount model uses amount and
prior cohort amounts. The history model also uses deviation from the beneficiary's
earlier payments. Availability of beneficiary history routes each record to a model.
Validation sets the ranking weight, and the remaining months supply the holdout. Amount
references use strictly earlier installment months. Repeated installments in the same
month are candidates for the rules baseline.

The [JSON report](reports/auxilio_emergencial_benchmark.json), generated by the benchmark,
compares rules only, Isolation Forest only and the combined ranking at a 10% review
budget per holdout month for the earlier runs below. The benchmark now defaults to
Top 1%. Pass `--review-budget 0.10` to reproduce a 10% comparison. Records with
and without beneficiary history each receive a
share of the budget proportional to their volume. Scores are ranked within each group,
and the report shows the number of reviews and observed outcomes. Blank or
unrecognized statuses count as unknown. Check status counts before and after filtering for
a stable beneficiary identifier and a positive amount. Coverage applies to eligible rows
in the evaluated sample. The export supports retrospective ranking because the field
dictionary gives no status timestamp.

In the archived-prefix pilot, the October 2021 holdout had 1,696,427 eligible rows
and 33 published returns. At 169,642 reviews, rules found 14 returns and Isolation
Forest found 10. The combined ranking also found 14 because September validation
selected an ML weight of zero. Of the 8,668 October returns in the source prefix,
8,635 lacked a stable beneficiary identifier and were excluded. The local run report is
`ml/data/auxilio_emergencial/official_prefix_pilot/benchmark_history_aware.json`.
The earlier Isolation Forest also found 10 returns at the same review budget on this
holdout. The history-aware ranking changes how review slots are distributed.

To refresh the aggregate report from the prepared pilot:

```powershell
python -m ml.auxilio_emergencial_benchmark --data-dir ml/data/auxilio_emergencial/official_prefix_pilot --validation-start 202109 --test-start 202110 --review-budget 0.10
```

The payout queue loads the operational model from `ml/models/isoforest.joblib`.

Use `--amount-frequency` to add historical exact-amount frequency to both Isolation
Forests and compare the feature on its own with the same 10% review budget. The
feature uses add-one smoothing over earlier months within the same cohort and
installment. Groups with fewer than 20 prior payments fall back to cohort history,
then global history.

```powershell
python -m ml.auxilio_emergencial_benchmark --data-dir ml/data/auxilio_emergencial/official_prefix_pilot --validation-start 202109 --test-start 202110 --review-budget 0.10 --amount-frequency --report ml/data/auxilio_emergencial/official_prefix_pilot/benchmark_amount_frequency.json
```

The October prefix was inspected while developing this feature, so its comparison
is exploratory. At 169,642 reviews, the existing Isolation Forest found 10 of 33
published returns, rules found 14, and both the frequency ranking and the Isolation
Forest with frequency found 1. The experiment saves
`isoforest_auxilio_emergencial_amount_frequency.joblib` beside the prepared data.

On the previously unused continuation of the same October archive, 2,169,424
eligible rows included 22 published returns. At 216,942 reviews, rules and the
existing Isolation Forest each found 12 returns. The frequency ranking and the
Isolation Forest with frequency both found zero. This comparison used the models
already fitted on August data. See the local aggregate at
`ml/data/auxilio_emergencial/official_october_continuation_full/benchmark_amount_frequency_holdout.json`.

### Automatic installment schedule check

The benchmark compares the actual installment from the payment record with the
expected installment from the program calendar. It prioritizes earlier installments
within each repeat-priority group. Recognized official Auxílio Emergencial exports
use the verified April–October 2021 calendar automatically. April starts at
cumulative installment 10 and the program advances by one each month, so October
is `10 + 6 = 16`. The [TCU audit](https://portal.tcu.gov.br/data/files/05/E0/04/FC/B9D038102DFE0FF7F18818A8/062_acordao_tcu_3142_2021.pdf)
identifies installments 10 and 13 as the start of the 2021 phase and July,
respectively. The [official October announcement](https://www.gov.br/mds/pt-br/noticias-e-conteudos/desenvolvimento-social/noticias-desenvolvimento-social/governo-federal-inicia-transferencia-da-setima-parcela-do-auxilio-emergencial-2021/)
describes the seventh installment of the 2021 phase. The archive uses cumulative
numbers, so both payment and calendar fields must use that numbering.

```powershell
python -m ml.auxilio_emergencial_benchmark --data-dir ml/data/auxilio_emergencial/official_prefix_pilot --validation-start 202109 --test-start 202110
```

For a prepared dataset from one program, place an approved reference-month
calendar in `installment_schedule.json` beside `payments.csv`. Supply actual
installments from the export or join them from an approved payment list by a
stable payment reference. The benchmark reads the calendar on every run.

```json
{"202109": 15, "202110": 16}
```

An explicit calendar also covers programs with skipped months, resets or
exceptions. An anchor month, its installment number and a confirmed uninterrupted
monthly schedule are sufficient to construct the same lookup table. If a program
uses multiple calendars, prepare each program or cohort with its own calendar.
Use the reference period specified by the program. A payment date, amount or
upload batch alone cannot establish the actual installment or expected schedule.

The report counts checked rows, earlier installments, missing actual
installments, and missing schedule entries by month. Data cleaning retains rows
with a missing or invalid installment for ordinary scoring. The schedule check
skips those rows and rows outside the supplied calendar. `--scheduled-installment
YYYYMM=INSTALLMENT` can also supply or override a specific reference month.

At a 1% review budget, the schedule ranking found 28 of 33 published returns in
the original October slice and 19 of 22 in the continuation, versus 14 and 11 for
the existing rules. The 22 additional returns were CadÚnico R$300 records in
installments 6–9. The remaining eight were installment 16 records. An unused raw
tail of the same archive gave a separate cue check. Earlier installments routed
3,988 of 1,055,139 source records, including 1,309 of 1,312 published returns.
All 1,312 lacked a stable beneficiary key. This last comparison is at the raw
record level. See
`ml/data/auxilio_emergencial/returned_miss_analysis.json` and
`ml/data/auxilio_emergencial/official_october_range_290045952/prior_installment_raw_tail.json`.

The export records administrative outcomes and omits individual return reasons
and authorization dates. Earlier installments can be authorized retroactive
payments. Pre-payment use requires an installment number and an authorized
schedule available at review time.

Keep the source archives, preparation key, row-level outputs and
`isoforest_auxilio_emergencial_history_aware.joblib` in the ignored local data directory.

## Benefit-month coverage on public cash assistance exports

Prepare the local Auxílio Brasil and Novo Bolsa Família samples with the
program-specific column mapping:

```powershell
python -m ml.prepare_cash_assistance 202302_AuxilioBrasil
python -m ml.prepare_cash_assistance 202606_NovoBolsaFamilia
```

In the prepared samples, `reference_month` is the actual benefit entitlement
month and `payroll_month` is the actual payroll month. The source columns are
reversed between programs. [Auxílio Brasil data dictionary](https://portaldatransparencia.gov.br/dicionario-de-dados/auxilio-brasil)
· [Novo Bolsa Família data dictionary](https://portaldatransparencia.gov.br/dicionario-de-dados/novo-bolsa-familia)

The comparison against the historical payroll month measures how often the two
published fields differ. Both local exports had valid month pairs on every row.

| Export | Source rows | Entitlement earlier | Same month | Entitlement later |
| --- | ---: | ---: | ---: | ---: |
| Auxílio Brasil, 2023-02 | 20,984,227 | 0 | 20,967,825 | 16,402 |
| Novo Bolsa Família, 2026-06 | 19,224,784 | 59,409 | 19,165,375 | 0 |

To screen a live request, convert the source entitlement month from `YYYYMM`
to `YYYY-MM` in `benefit_month` and configure the independently approved batch
schedule. See the [request CSV format](../data/samples/README.md).

To compare recall at the same Top 1% review budget, freeze the candidate rows
and score baseline versus baseline plus the earlier-month cue. Join later review
outcomes by request ID. The two public exports contain no such outcomes. In
Auxílio Emergencial, deriving the entitlement month from the installment using
the same calendar reproduces the installment cue and gives no independent test
of the month cue. [Auxílio Emergencial data dictionary](https://portaldatransparencia.gov.br/dicionario-de-dados/auxilio-emergencial)

## Caveats

- The original AidFlow demo uses synthetic data and measures behavior on injected cases.
- Retrain and recalibrate when the feature list or feature semantics change. The live backend requires a compatible program and asset bundle.
