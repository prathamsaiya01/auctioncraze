# AuctionCraze Phase 6B — Advanced Cricket Intelligence

**Project Isolation:** Exclusively built in `D:\AUCTIONCRAZE`. `ALLOW_BIDDING_ADVICE=False` enforced across all pipelines, registries, API proxies, and UI components.

---

## 1. Ball-by-Ball Analytics Pipeline (`app/pipelines/ball_by_ball.py`)
Parsed all **1,243** verified IPL matches (**295,557** deliveries, **2,480** regular innings) from `ipl_json.zip` + `people.csv`:
- **Legal vs Extra Rules:**
  - `legal_deliveries` (`284,465`): excludes wides (`9,871`) and no-balls (`1,221`).
  - Batting balls faced (`is_batter_ball`): excludes wides (`wides == 0`), includes no-balls.
  - Bowler conceded runs: `batter + wides + noballs` (excludes byes `743`, legbyes `4,398`, and penalty runs `2`).
  - Boundary classification checks `runs.non_boundary == true` (`29` excluded).
  - Wicket separation: bowler-credited (`bowled`, `caught`, `caught and bowled`, `hit wicket`, `lbw`, `stumped`; `13,460`) separated from non-bowler (`run out`, `retired out`, `obstructing the field`; `1,214`) and non-dismissals (`retired hurt`).
  - Super Over innings (`34`) excluded from career totals while tie/eliminator match results (`16`) remain preserved.
  - Impact Player substitutions extracted cleanly (`556` substitutions).
- **Reconciliation:** `reconciliationPassed: true` (`0` run/wicket mismatches across all `3,354` Phase 5 season records, with 3 documented non-striker diamond ducks accounted for).
- **Generated Datasets (`data/processed/analytics/`):**
  - `matches.csv` (1,243 matches)
  - `match_appearances.csv.gz` (27,909 appearance records)
  - `player_advanced_stats.csv` (4,972 scoped rows: `CAREER`, `RECENT_3_SEASONS`, `SEASON_YYYY` across Powerplay 1–6, Middle 7–15, Death 16+, and Batting First vs Chasing splits; inapplicable metrics preserved as `None`/empty).

---

## 2. Historical Player Ratings (`app/models/rating_engine.py`)
- Clearly labeled `HISTORICAL_STATISTICAL_RATING (not official IPL rating, not a forward ML forecast)`.
- Computes `batting_rating`, `bowling_rating`, `all_rounder_rating`, `fielding_rating`, and `overall_rating` (0–100) using Bayesian sample-size shrinkage (`prior_k = 28` innings batting, `prior_k = 85` overs bowling, `prior_k = 15` matches fielding).
- Insufficient samples (`< 5` matches / `< 5` skill innings / `< 60` legal balls) cleanly return `insufficient_sample: true` and `null` skill scores rather than synthetic inflation.

---

## 3. Squad Team Strength & Playing XI (`app/models/team_strength.py`, `app/models/playing_xi.py`)
- **Team Strength Engine:** Evaluates batting depth, bowling depth, pace/spin balance, all-rounder index, fielding index, wicket-keeper coverage, overseas compliance, and structural gaps (no player-buying or price recommendations).
- **Playing XI Predictor (`IPL_2023_IMPACT_PLAYER_RULES_V1`):** Predicts an ordered 11-player XI (`<= 4` overseas players, wicket-keeper & 5-bowling-option balance, captain & vice-captain candidates) plus a 12th Impact Player (strictly enforcing domestic Impact Player whenever XI already contains 4 overseas players). Rejects infeasible squads (`< 11` players or `< 7` domestic players) with HTTP `422`.

---

## 4. Chronological Match Outcome Classifier (`app/pipelines/train_match_model.py`, `app/models/match_predictor.py`)
- **Zero-Leakage Sequential Features (`MATCH_FEATURE_NAMES`):**
  `elo_diff`, `nrr_ema_diff`, `cycle_form_diff` (all strictly pre-match before match date, with Mega Auction mean reversion on `{2011, 2014, 2018, 2022, 2025}`), and `xi_sea_ovr_diff`, `xi_sea_bat_diff`, `xi_sea_bowl_diff` (strictly prior IPL seasons `< match.season`).
- **Anti-Symmetric Unbiased Prediction:** Swapping Team A and Team B flips probabilities symmetrically (`P(A, B) + P(B, A) = 1.0`).
- **Chronological Splits:**
  - Warmup: `2008` (`58` matches)
  - Train: `2009–2021` (`814` matches)
  - Validation: `2022–2023` (`147` matches) -> Selected `calibrated_random_forest` (`ROC-AUC: 0.5766`, `Accuracy: 56.46%`, `Log Loss: 0.6896`, `Brier: 0.2482`)
  - Refit `2009–2023` and Evaluated on Unseen Holdout `2024–2026` (`215` matches):
    - **Accuracy:** `53.95%` (vs Coin-Flip `45.12%`, Elo-Only `53.02%`)
    - **ROC-AUC:** `0.5508` (vs Coin-Flip `0.5000`, Elo-Only `0.5085`)
    - **Log Loss:** `0.6899` (vs Coin-Flip `0.6931`, Elo-Only `0.7014`)
    - **Brier Score:** `0.2484` (vs Coin-Flip `0.2500`, Elo-Only `0.2540`)
    - **ECE:** `0.0466` (vs Elo-Only `0.0823`)
- **Governance:** Trained & validated models (`MATCH_PRED`, `BATTING_PERFORMANCE_PRED`, `BOWLING_PERFORMANCE_PRED`, plus verified statistical/optimization modules `PLAYER_RATING`, `TEAM_STRENGTH`, `PLAYING_XI`) are active; untrained `POST_MATCH_ANALYSIS` continues to return HTTP `503`.
