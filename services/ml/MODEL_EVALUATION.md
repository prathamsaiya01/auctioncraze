# AuctionCraze Chronological Model Evaluation Report (Phase 6A)

- **Training Pipeline**: `services/ml/app/pipelines/train_baselines.py`
- **Random Seed**: `42`
- **Dataset Fingerprint**: `c9af4153629ffb06`
- **Machine-Readable Report**: `services/ml/reports/model_evaluation_report.json`

---

## 1. Chronological Split Methodology

No random k-fold or random train/test splitting is used:

1. **Train Split (`2009`–`2021`)**: Features computed strictly from `2008` through `T - 1`.
2. **Validation Split (`2022`–`2023`)**: Used exclusively to compare candidate algorithms and hyperparameters (selecting lowest Validation RMSE).
3. **Final Chronological Holdout (`2024`–`2026`)**: The single winning model architecture per task is refitted on `2009`–`2023` and evaluated once on unseen seasons `2024`–`2026`.

---

## 2. Batting Performance Prediction (`BATTING_PERFORMANCE_PRED` v1.0.0)

- **Target**: `runs_per_match` (expected runs scored per match played in target season).
- **Sample Counts**: `1,890` total eligible (`1,295` Train `2009–2021`, `232` Validation `2022–2023`, `1,527` Refit `2009–2023`, `363` Holdout `2024–2026`).

### Validation Model Selection (`2022–2023`, n = 232)

| Candidate | Validation MAE | Validation RMSE | Validation R² |
| --- | ---: | ---: | ---: |
| **Ridge(alpha=10.0)** *(Selected)* | **5.5175** | **7.7069** | **0.6336** |
| Ridge(alpha=50.0) | 5.5076 | 7.7120 | 0.6331 |
| Ridge(alpha=150.0) | 5.5237 | 7.7444 | 0.6300 |
| HistGBR(depth=3, min_leaf=20) | 5.5614 | 7.7853 | 0.6261 |
| RandomForest(depth=4, min_leaf=15) | 5.5528 | 7.7933 | 0.6254 |
| RandomForest(depth=6, min_leaf=10) | 5.5431 | 7.8339 | 0.6214 |

> **Selection Insight**: Regularized linear shrinkage (`Ridge(alpha=10.0)`) outperformed non-linear tree ensembles on Validation RMSE, confirming that linear shrinkage avoids overfitting moderate sample sizes.

### Final Holdout Comparison (`2024–2026`, n = 363)

| Model / Baseline | Holdout MAE | Holdout RMSE | Holdout R² |
| --- | ---: | ---: | ---: |
| **Ridge(alpha=10.0)** *(ML)* | 5.2986 | **7.4039** | **0.6834** |
| Historical Career Avg Baseline | **5.2126** | 7.6512 | 0.6619 |
| Recent 3-Season Avg Baseline | 5.3474 | 7.7650 | 0.6518 |
| Global Mean Baseline | 11.1593 | 13.2493 | -0.0139 |

- **Top Weighted Features**: `prior_batting_innings_rate` (+2.501), `recent_3y_runs_per_match` (+2.311), `recent_1y_runs_per_match` (+1.889), `prior_runs_per_match` (+1.880), `recent_2y_runs_per_match` (+1.580).
- **Empirical Residual Spread (`Holdout`)**: `residual_std = 7.3976` runs/match.

---

## 3. Bowling Performance Prediction (`BOWLING_PERFORMANCE_PRED` v1.0.0)

- **Target**: `wickets_per_match` (expected wickets per match played in target season).
- **Sample Counts**: `1,298` total eligible (`882` Train `2009–2021`, `157` Validation `2022–2023`, `1,039` Refit `2009–2023`, `259` Holdout `2024–2026`).

### Validation Model Selection (`2022–2023`, n = 157)

| Candidate | Validation MAE | Validation RMSE | Validation R² |
| --- | ---: | ---: | ---: |
| **RandomForest(depth=4, min_leaf=15)** *(Selected)* | **0.2994** | **0.3796** | **0.3993** |
| HistGBR(depth=3, min_leaf=20) | 0.3027 | 0.3827 | 0.3895 |
| Ridge(alpha=10.0) | 0.3025 | 0.3832 | 0.3879 |
| Ridge(alpha=50.0) | 0.3072 | 0.3855 | 0.3805 |
| Ridge(alpha=150.0) | 0.3127 | 0.3891 | 0.3689 |

### Final Holdout Comparison (`2024–2026`, n = 259)

| Model / Baseline | Holdout MAE | Holdout RMSE | Holdout R² |
| --- | ---: | ---: | ---: |
| **RandomForest(depth=4, min_leaf=15)** *(ML)* | **0.3008** | **0.3989** | **0.3890** |
| Historical Career Avg Baseline | 0.3333 | 0.4451 | 0.2392 |
| Recent 3-Season Avg Baseline | 0.3482 | 0.4657 | 0.1672 |
| Global Mean Baseline | 0.4328 | 0.5118 | -0.0058 |

- **Top Feature Importances**: `prior_bowling_innings_rate` (0.7765), `recent_3y_wickets_per_match` (0.0831), `recent_1y_wickets_per_match` (0.0214), `recent_2y_wickets_per_match` (0.0203), `prior_wickets_per_match` (0.0202).
- **Why RandomForest improves markedly over bowling average baselines**: Tree splits capture the non-linear role threshold separating full-quota 4-over bowlers (`prior_bowling_innings_rate` near `1.0`) from occasional part-time bowlers.

---

## 4. Honest Limitations & Calibration Caveats

1. **Higher stochasticity in wickets (`R² = 0.389`) vs runs (`R² = 0.683`)**: T20 wickets are rare discrete events (`0`–`4` per match) heavily influenced by bowling phase (powerplay vs death), pitch conditions, and Impact Player tactical substitutions introduced in IPL 2023+.
2. **Season-level granularity**: Phase 6A models forecast player-level season output (`runs/match`, `wickets/match`) without yet conditioning on team batting slot, venue characteristics, or opponent strength.
3. **Cold-start boundary**: Debutants or players with `< 3` prior matches or `< 2` prior discipline innings are rejected (`HTTP 422`) rather than receiving guessed predictions.

---

## 5. Reproducibility

```bash
cd services/ml
python -m app.pipelines.train_baselines
python -m pytest -v tests/test_phase6a.py
```
