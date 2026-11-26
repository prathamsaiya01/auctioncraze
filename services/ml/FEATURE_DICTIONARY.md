# AuctionCraze ML Feature Dictionary (Phase 6A)

All features are computed inside `services/ml/app/pipelines/feature_engineering.py` using **`compute_cutoff_player_features(season_rows, player_meta, cutoff_season=T)`**.

## Leakage Prevention Rules

1. **Strict Temporal Cutoff**: For predicting target season `T`, ONLY season records with `season < T` are read.
2. **No Career-Summary Leakage**: Static career attributes aggregated across 2008–2026 (`playingRole`, `teamHistory`, `iplLastYear`, full career averages) are **excluded**; role tendencies (`prior_batting_innings_rate`, `prior_bowling_innings_rate`, `is_prior_wicketkeeper`) are computed dynamically from `season < T`.
3. **No Target-Season Participation Metadata**: Neither `target_matches` nor target-season franchise assignment enters the feature matrix.
4. **Explicit Missingness**: Undefined ratios (`0` dismissals, `0` balls faced, `0` wickets, `< 2` prior active seasons for std/trend, missing DOB) remain `np.nan` and are paired with binary missing-value indicators in linear/forest pipelines or handled natively by tree learners.

---

## Target Definitions

| Model Key | Target Column | Definition & Eligibility |
| --- | --- | --- |
| `BATTING_PERFORMANCE_PRED` | `runs_per_match` | `runs / matches` in season `T`. Eligible when `matches >= 3`, `runs IS NOT NULL`, `battingInnings >= 1`, pre-cutoff `prior_matches >= 3`, and `prior_bat_innings >= 2`. |
| `BOWLING_PERFORMANCE_PRED` | `wickets_per_match` | `wickets / matches` in season `T`. Eligible when `matches >= 3`, `wickets IS NOT NULL`, `bowlingInnings >= 1`, pre-cutoff `prior_matches >= 3`, and `prior_bowl_innings >= 2`. |

---

## Engineered Features (Pre-Cutoff `season < T`)

| Feature Name | Models | Formula / Calculation | Missing Handling |
| --- | --- | --- | --- |
| `prior_seasons_count` | Both | Count of distinct IPL seasons played strictly before `T` | Guaranteed `>= 1` for eligible rows |
| `prior_matches` | Both | `sum(matches)` across seasons `< T` | Guaranteed `>= 3` |
| `prior_bat_innings` | Batting | `sum(batting_innings)` across batting seasons `< T` | Guaranteed `>= 2` |
| `prior_batting_innings_rate` | Batting | `prior_bat_innings / prior_matches` | Continuous `[0, 1]` |
| `prior_runs_per_match` | Batting | `sum(runs) / prior_matches` (`season < T`) | `NaN` if no batting rows `< T` |
| `prior_batting_avg` | Batting | `sum(runs) / (prior_bat_innings - sum(not_outs))` | `NaN` when `dismissals == 0` |
| `prior_strike_rate` | Batting | `(sum(runs) * 100) / sum(balls_faced)` | `NaN` when `balls_faced == 0` |
| `prior_50_plus_rate` | Batting | `sum(fifties + hundreds) / prior_bat_innings` | `NaN` if `prior_bat_innings == 0` |
| `recent_1y_runs_per_match` | Batting | `runs / matches` in most recent batting season `< T` | `NaN` if no prior batting season |
| `recent_2y_runs_per_match` | Batting | Pooled `runs / matches` across up to 2 recent batting seasons `< T` | `NaN` if no prior batting season |
| `recent_3y_runs_per_match` | Batting | Pooled `runs / matches` across up to 3 recent batting seasons `< T` | `NaN` if no prior batting season |
| `batting_consistency_std` | Batting | Sample std (`ddof=1`) of per-season `runs / matches` across `< T` | `NaN` if `< 2` prior batting seasons |
| `batting_trend_delta` | Batting | `recent_1y_runs_per_match - prior_runs_per_match` | `NaN` if `< 2` prior batting seasons |
| `prior_bowl_innings` | Bowling | `sum(bowling_innings)` across bowling seasons `< T` | Guaranteed `>= 2` |
| `prior_bowling_innings_rate` | Bowling | `prior_bowl_innings / prior_matches` | Continuous `[0, 1]` |
| `prior_wickets_per_match` | Bowling | `sum(wickets) / prior_matches` (`season < T`) | `NaN` if no bowling rows `< T` |
| `prior_bowling_avg` | Bowling | `sum(runs_conceded) / sum(wickets)` | `NaN` when `wickets == 0` |
| `prior_economy` | Bowling | `(sum(runs_conceded) * 6) / sum(balls_bowled)` | `NaN` when `balls_bowled == 0` |
| `prior_bowling_sr` | Bowling | `sum(balls_bowled) / sum(wickets)` | `NaN` when `wickets == 0` |
| `recent_1y_wickets_per_match` | Bowling | `wickets / matches` in most recent bowling season `< T` | `NaN` if no prior bowling season |
| `recent_2y_wickets_per_match` | Bowling | Pooled `wickets / matches` across up to 2 recent bowling seasons `< T` | `NaN` if no prior bowling season |
| `recent_3y_wickets_per_match` | Bowling | Pooled `wickets / matches` across up to 3 recent bowling seasons `< T` | `NaN` if no prior bowling season |
| `bowling_consistency_std` | Bowling | Sample std (`ddof=1`) of per-season `wickets / matches` across `< T` | `NaN` if `< 2` prior bowling seasons |
| `bowling_trend_delta` | Bowling | `recent_1y_wickets_per_match - prior_wickets_per_match` | `NaN` if `< 2` prior bowling seasons |
| `prior_catches_per_match` | Both | `sum(catches) / prior_matches` | Continuous `>= 0` |
| `is_prior_wicketkeeper` | Batting | `1.0` if `sum(stumpings) > 0` before `T`, else `0.0` | Binary `{0, 1}` |
| `seasons_since_last_played` | Both | `T - max(season < T)` | Integer `>= 1` |
| `age_at_season` | Both | `T - birth_year` from verified `dateOfBirth` | `NaN` if `dateOfBirth` unavailable |
| `is_overseas_num` | Both | `1.0` overseas, `0.0` domestic India (verified nationality) | `NaN` if nationality unavailable |
