# AidFlow screening and ML

## Where we ended up

AidFlow keeps **Isolation Forest** for behavior ranking and uses separate rules for program policy. The biggest measured gain on public aid data came from checking the actual installment against an approved schedule. At the same Top 1% review budget, it increased coverage from **25 of 55 to 47 of 55 published returns** across two October 2021 slices. The current USDC replay verifies screening workload on real payments. Its accuracy on real anomalies remains unknown because the replay has no verified outcomes.

## Research and tuning history

### 1. Establish the synthetic baselines

- The original demo used generated aid requests with six planted anomaly types. Its **Rules + Isolation Forest** benchmark found **180 of 180** planted anomalies and flagged **243 of 1,797** requests for review. Precision was **74.1%**. The dashboard's **Simulated demo results** still shows this historical benchmark. [Original metrics](../ml/reports/metrics.json)
- The **Shared AidFlow benchmark** was a separate synthetic stress test generated in this project. It included authorized top-ups, authorized wallet reuse or changes, and scheduled installments alongside 92 planted anomalies in 1,218 test requests. In the early application run recorded in the workspace's `AidFlow Screening Change Plan.md`, 365 were flagged, 70 of the 92 planted cases were caught, and 295 flags were on synthetic normal cases. All 22 missed cases were `incorrect_amount`. A request amount and history can indicate that an amount is unusual. Verifying that it is incorrect requires the authorized amount and any approved adjustment for that beneficiary, period and payout slot. [Shared benchmark generator](../ml/aid_benchmark.py)
- We first varied the training data while keeping Isolation Forest and the same Shared AidFlow test. In one comparison at 121 reviews, old and revised synthetic training caught **27 and 29 of 92**. In a separate common-feature comparison at the same 121 reviews, a real USDC-trained model caught **54 of 92**, and a synthetic-trained model caught **46 of 92**. The USDC-trained model caught **0 of 20** planted `unapproved_wallet_reuse` cases. The source represents recipients by wallet, so it cannot teach the model who is authorized to share one. These results describe the synthetic test.

### 2. Match each dataset to a question

| Dataset | Observed features and outcomes | What we measured |
| --- | --- | --- |
| **Stellar Mainnet USDC** | Real public transfers with recipient wallet, amount and timestamp. Wallet serves as a recipient proxy. Beneficiary IDs, eligibility, authorized schedules and anomaly labels are unavailable. | Chronological replay, threshold calibration and Review workload. The current sample spans about 28 minutes and has limited coverage for time-of-day behavior. |
| **Auxílio Emergencial** | Public monthly assistance records with amount, cohort, actual installment and administrative `Returned` or `Held` where reported. Many records lack a stable beneficiary key. Individual authorization details and status timestamps are unavailable. | Retrospective published-return recall at a fixed review budget. `Unknown` stays unlabeled. The administrative status is kept out of the model features. |
| **Auxílio Brasil and Novo Bolsa Família** | Real monthly assistance exports with amounts, entitlement and payroll months. These files lack transaction-level wallet history, exact timestamps and confirmed anomaly outcomes. The two exports use different mappings for their source month columns. | Fit separate amount models on genuine amounts. Test original holdouts for flag volume and run explicit injected challenges for detection. Check month-field coverage independently. |
| **PaySim** | Simulated mobile-money transfers based on operator logs, with synthetic account-takeover labels. | External model comparison on a different payment pattern. The [ML README](../ml/README.md) records the results and input restrictions. |

Each source was used for its own experiment. When a model was trained on real data and evaluated on a common synthetic test, the real source and the synthetic outcome labels were recorded separately. We kept genuine amounts in the real holdouts and identified modifications in injected challenges. At a budget of 410 reviews per challenge, the amount model caught **96 of 100** injected amount errors on Auxílio Brasil and **29 of 100** on Novo Bolsa Família. Different source amount distributions can make the same injection rare in one program and close to familiar amounts in another. That result depends on both the data distribution and the injection design.

In a separate transfer test, each program's amount model trained on 7,000 real rows and ran on the same synthetic AidFlow test after median-based amount alignment. At 121 reviews, the Auxílio Brasil and Novo Bolsa Família models found **12** and **6** planted cases respectively. Prioritizing the beneficiary-period duplicate rule before the model increased those counts to **46** and **40**. Each found the same 38 planted duplicate installments. This isolates the value of a program-period rule on this test, while incorrect-amount and wallet authorization checks still depend on their own evidence.

### 3. Compare models and tune one variable at a time

- **Isolation Forest vs ECOD.** On the same Shared AidFlow test, same features and 121 review slots, model-only Isolation Forest found **31 of 92** planted cases and ECOD found **29 of 92**. ECOD had higher overall average precision (**0.298 vs 0.267**), while Isolation Forest found more cases at the chosen workload. [ECOD paper](https://arxiv.org/abs/2201.00382)
- **Supervised and PU options.** The PaySim comparison included supervised Gradient Boosting and Local Outlier Factor. At Top 10%, they caught 56% and 36% respectively, versus 49% for Isolation Forest. At Top 1%, Local Outlier Factor caught 14% versus 9% for Isolation Forest. XGBoost was considered as a supervised option. Positive–Unlabeled Learning was considered for datasets with a few known positives, where the meaning of a positive and how it gets labeled must be established first. The published `Returned` cases do not establish confirmed fraud. XGBoost and PU Learning remain research options for AidFlow. [PaySim report](../ml/reports/paysim.json) · [Positive–Unlabeled Learning paper](https://cseweb.ucsd.edu/~elkan/posonly.pdf)
- **Hyperparameters.** On the same two Auxílio Emergencial slices at Top 1%, the 300-tree, 256-sample baseline found **10/33 and 11/22** returns. Using 512 samples per tree or `max_features=0.67` preserved those counts. The 600-tree and 128-sample variants each found zero on those slices. Score ties and small changes near the Top 1% boundary changed which records were selected. These results describe the tested rankings on those slices. The live model keeps 300 trees, 256 samples per tree, `contamination="auto"` and seed 0. `contamination` controls the estimator's own decision offset. AidFlow uses a separate percentile cutoff for flags.
- **Historical amount frequency.** We tested how often an exact amount appeared in earlier months for the same cohort and installment. At a 10% review budget, adding this feature reduced the model's published returns found from **10 to 1** on the October prefix and **12 to 0** on its continuation. The feature remains offline.
- **Review budget.** Moving from Top 1% to Top 5% in the two Auxílio Emergencial slices expanded the review list without finding additional published returns in either the existing rules or the baseline Isolation Forest. We kept **Top 1%** for the Brazil comparison. The **10% validation review budget** used for the operational USDC cutoff is a separate calibration setting. It is neither a cap on each upload nor a claim about the anomaly rate.

### 4. Inspect misses and add a signal with independent evidence

The original Top 1% rules missed **30** published returns across the two October slices. **22** of the misses were CadÚnico R$300 records in installments **6–9**. The expected installment was **16**. Ranking earlier installments higher within the existing rules groups increased the counts at the same review capacity.

| October 2021 slice | Reviewed | Published returns | Existing rules found | Rules with installment cue found |
| --- | ---: | ---: | ---: | ---: |
| Original prefix | 16,964 | 33 | 14 | 28 |
| Continuation | 21,694 | 22 | 11 | 19 |
| **Total** | **38,658** | **55** | **25** | **47** |

The increase was **22 additional published returns** at the same workload, or **45.5% to 85.5% published-return recall** on eligible records. The remaining eight were installment 16 records. Separately, in an unused raw tail of the same archive, the cue routed **3,988 of 1,055,139** records, including **1,309 of 1,312** published returns. All 1,312 lacked a stable beneficiary key. That raw-record check has a different denominator and cannot establish unique-beneficiary coverage. An earlier installment can be authorized backpay. [Aggregate schedule checks](../ml/reports/real_payment_checks.json) · [Schedule reconstruction and source notes](../ml/README.md#automatic-installment-schedule-check)

For the live rule, **actual installment** comes from the source record or an approved payment list. **Expected installment** comes from the program's approved batch schedule. A month-to-installment lookup can be built from an approved anchor and a verified schedule, including any skipped months or resets. If a required value is missing, ordinary screening continues. **Benefit month** follows the same pattern with an actual entitlement month and an approved expected month. A timestamp or upload batch by itself cannot establish either actual value. In the public month comparison, **59,409 of 19,224,784** Novo Bolsa Família records had an earlier entitlement month. **0 of 20,984,227** Auxílio Brasil records did. Those exports establish field coverage and rule volume. Outcomes would be needed to measure the effect on detection. [CSV fields and configuration](../data/samples/README.md)

### 5. Fix transfer and calibration in the live flow

The old synthetic model flagged **1,052 of 1,343** requests on the later USDC holdout. In a controlled ablation, removing `time_of_day` from a synthetic-trained model reduced flags from **538 to 406**. Removing it from the USDC-trained model increased flags from **132 to 145**. Since all of these real requests came from a short UTC window and lacked outcomes, the experiments measured sensitivity and workload. A UTC hour alone could not establish unusual payment behavior.

The old feature builder recalculated the global amount median over the scoring frame. The first fix froze that reference in the model bundle and used earlier request and availability timestamps for history. The final live design removed amount, amount-derived features and wall-clock time from ML scoring. This moved program-specific amount and time decisions into explicit **Screening settings**. The old amount-median reference is still available for offline comparisons. In a separate earlier replay, enabling the 500 USDC rule increased distinct flags from **307 to 608** while ML stayed at **267**. The amount rule routes requests to review for a decision. It does not cap a Stellar transfer.

The current 4,492-row USDC replay uses **2,470 training / 679 validation / 1,343 holdout** records in chronological order. With amount and time rules off, **329** requests have flags, including **232 ML flags**, **181 possible duplicates**, and **84** with both. In the final holdout, **125 of 1,343** have ML flags and **157 of 1,343** have any flag. The active cutoff is **0.901325**, set from the validation reference with a 10% review budget. The Review interface explains the triggered rules and shows available ML feature-group sensitivity.

| Cutoff used for the current replay preview | Pending ML flags | Pending flagged for Review |
| --- | ---: | ---: |
| 0.85 | 364 | 423 |
| 0.901325, active | 232 | 329 |
| 0.95 | 131 | 262 |

The preview uses saved scores to estimate workload and keeps the live queue intact. A cutoff change only changes ML flag eligibility. Amount, time, duplicate and schedule rules retain their own criteria. Compare candidates using independent outcomes at the same workload before updating the calibrated cutoff.

## Upload and Review

Home → **New batch** uploads a CSV of payment requests for screening. **Screening settings** shows the policy for the current program and asset. Set an inclusive minimum and/or maximum amount. A blank field leaves that bound open. The optional payment window checks the CSV `created_at` in the selected IANA timezone. It supports overnight windows and an optional Monday–Friday restriction. The original timestamp is preserved.

**Preview impact** optionally estimates the effect on pending requests. **Save settings** applies to future uploads. Selecting **Also apply to pending requests** also updates the amount and time flags on the pending queue. Requests keep a policy snapshot for later corrections. Enter your name in **Reviewing as** inside the dialog to record it in the audit log. Editing is enabled on the trusted local preview. A deployment needs operator access controls before enabling it.

| Signal | What sends a request to Review |
| --- | --- |
| Amount outside range | Below the configured minimum or above the maximum. Review shows the actual amount, asset and bound. |
| Outside payment window | The request timestamp is outside the configured local window. |
| Duplicate or wallet rule | Repeated payout slot in a real batch, same beneficiary and amount within the configured duplicate window, shared wallet, or wallet change. An exact duplicate request ID is handled at upload. |
| Earlier installment or benefit month | The provided period is earlier than the approved batch schedule. Review can check for authorized backpay. |
| ML score | The current compatible model's score crosses its validation threshold. If model reference statistics are available, Review shows the feature groups that lowered the score most in sensitivity checks. |

Each rule contributes its own flag. A request inside the amount and time ranges can still have other flags. Approval and payment remain separate steps.

## Model and what affects detection

- The live Isolation Forest uses **300 trees**, **`max_samples=256`**, **`contamination="auto"`** and **`random_state=0`**. It uses recent request counts, gaps between requests, and wallet/beneficiary history where those identities are available.
- Absolute amount, amount ratios, same-amount frequency and wall-clock time are excluded from live ML inputs. The same-amount duplicate rule still runs separately. The USDC replay uses only request counts and gaps because its recipient wallet doubles as the beneficiary proxy.
- Features use earlier request timestamps and earlier availability windows. An upload is one availability window. Later records and records from the same upload do not contribute to that request's ML history. The previous fixed median is retained for comparable offline experiments and no longer affects the live score.
- The validation reference maps raw scores to a percentile and sets the cutoff from the review budget. A percentile expresses the position against reference scores. It does not provide a fraud probability. Rule flags can make the total review volume exceed the ML budget.
- Model coverage depends on the available history, the program and asset, and the data used to calibrate the cutoff. A compatible bundle is selected by `AIDFLOW_MODEL_PATH`. Without one the API uses rules-only screening. The saved demo scorecard is a synthetic benchmark of the original model and policy.

## Home charts

**Requests by status** is a donut because each request has exactly one status. **Review reasons** counts distinct requests per reason. One request may appear in multiple bars. Its denominator is the distinct requests in Review, including flagged pending requests, held requests and invalid records. **Batches** groups all uploads by `batch_id`, including requests awaiting review or payment. **AI risk distribution** colors a request red if it reached the ML cutoff when it was scored and gray if it fell below. A bin can contain both colors. Rules can send a gray request to Review. Older scores may display rounded values, so the chart uses each request's saved ML flag.

**Simulated demo results** offers Table and Chart views of the saved screening benchmark. Its **Reconciliation accuracy** measures how often the reconciliation engine assigned the expected status when comparing simulated AidFlow records with ledger entries.

**Preview cutoff** estimates how a candidate ML cutoff changes the pending ML flags and the distinct requests flagged by ML or rules. The estimate uses saved scores and leaves the live cutoff and Review queue untouched. Use validation outcomes before changing the calibrated cutoff. Lower cutoffs can increase review workload and false positives. Higher cutoffs can miss anomalies.

## Verify and optimize

1. Replay each candidate with the same chronological holdout and a locked policy. Report ML, rule-only and overlapping flags. Compare the number of true issues found at the same review workload when review outcomes exist.
2. Collect reviewer outcomes for flagged requests and a sample of unflagged requests. Use a broader historical period for calibration and check drift before updating the model or threshold. Keep the threshold fixed across ordinary uploads.
3. Compare each remaining feature group on its own. Measure which types of labeled issues it finds beyond duplicate and wallet rules. Keep historical amount frequency and alternative tree/sample settings in offline experiments.
4. For authorized exceptions, compare against an approved program schedule or payment authorization when that data exists. Preserve an explicit reason and the reviewer decision for evaluation.

For a new program, start with the fields available at review time and a chronological split. Use earlier records for training, a later validation set for calibration, and a final untouched holdout. A 70/20/10 split can work when each window has adequate history and outcomes. Report missed outcomes, actual review counts, rule/ML overlap and records excluded for missing identifiers. The next evidence needed for real-world accuracy is program-authorized payment and wallet records, plus reviewer outcomes on flagged and sampled unflagged requests.

## Reproduction and evidence

- The [ML README](../ml/README.md) lists the training and replay commands, inputs, holdout definitions and official data sources. The [USDC replay ZIP](../data/samples/real_usdc_replay.zip) contains the exact CSV used in the current replay. The [backend README](../backend/README.md) and [CSV format](../data/samples/README.md) describe the operational settings. The original synthetic dashboard uses [screening metrics](../ml/reports/metrics.json) and a separate [reconciliation fixture](../ml/reports/recon_eval.json), which correctly categorized 2,000 of 2,000 simulated records and found 20 of 20 seeded unrecorded payouts.
- Workspace-only aggregate reports are in the sibling `aidflow-stellar/ml/data/` directory. Use `aid_benchmark/comparison.json`, `ecod_comparison.json`, `real_usdc_shared_features.json` and `usdc_time_of_day_diagnostics.json` for model and feature comparisons. Use `official_cash_assistance/cash_assistance_test_results.json` for the injected amount challenge and `shared_aidflow_test_results.json` for the shared holdout. Use `auxilio_emergencial/forest_parameter_comparison.json`, `forest_parameter_diagnostics.json`, `review_budget_comparison.json` and `returned_miss_analysis.json` for tuning and miss analysis. Use `usdc-replay-explained/summary.json`, `usdc-replay-explained-amount500/summary.json` and `usdc-policy-behavior/summary.json` for replay results.
- The screening PR branch based on `main` passed **44 backend tests**. The browser check on the local replay verified the cutoff preview warning and the current-versus-preview counts.
