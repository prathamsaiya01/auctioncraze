"""
Leakage-safe, cutoff-aware IPL feature engineering module.

Strict rule: For any prediction concerning target season T, features are computed
exclusively from seasons strictly earlier than T (season < T), using only fields
verified in processed datasets and preserving unavailable statistics as NaN.
"""
import csv
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "processed"

BATTING_FEATURE_NAMES: List[str] = [
    "prior_seasons_count",
    "prior_matches",
    "prior_bat_innings",
    "prior_batting_innings_rate",
    "prior_runs_per_match",
    "prior_batting_avg",
    "prior_strike_rate",
    "prior_50_plus_rate",
    "recent_1y_runs_per_match",
    "recent_2y_runs_per_match",
    "recent_3y_runs_per_match",
    "batting_consistency_std",
    "batting_trend_delta",
    "prior_catches_per_match",
    "is_prior_wicketkeeper",
    "seasons_since_last_played",
    "age_at_season",
    "is_overseas_num",
]

BOWLING_FEATURE_NAMES: List[str] = [
    "prior_seasons_count",
    "prior_matches",
    "prior_bowl_innings",
    "prior_bowling_innings_rate",
    "prior_wickets_per_match",
    "prior_bowling_avg",
    "prior_economy",
    "prior_bowling_sr",
    "recent_1y_wickets_per_match",
    "recent_2y_wickets_per_match",
    "recent_3y_wickets_per_match",
    "bowling_consistency_std",
    "bowling_trend_delta",
    "prior_catches_per_match",
    "seasons_since_last_played",
    "age_at_season",
    "is_overseas_num",
]


@dataclass(frozen=True)
class ChronologicalSplit:
    train_df: pd.DataFrame
    test_df: pd.DataFrame


def chronological_split(
    df: pd.DataFrame,
    date_col: str,
    cutoff_iso: str,
) -> ChronologicalSplit:
    """
    Splits cricket match/ball-by-ball records strictly by timestamp to prevent future data leakage.
    """
    ordered = df.sort_values(date_col).copy()
    cutoff = pd.Timestamp(cutoff_iso)
    train_df = ordered[pd.to_datetime(ordered[date_col]) < cutoff]
    test_df = ordered[pd.to_datetime(ordered[date_col]) >= cutoff]
    return ChronologicalSplit(train_df=train_df, test_df=test_df)


def compute_phase_label(over_number: int) -> str:
    """Maps 1-based T20 over number to powerplay, middle, or death phase."""
    if over_number <= 6:
        return "powerplay"
    if over_number <= 15:
        return "middle"
    return "death"


def _to_int(val: Any) -> Optional[int]:
    if val is None or val == "" or (isinstance(val, float) and math.isnan(val)):
        return None
    return int(val)


def load_raw_tables(data_dir: Path = DATA_DIR) -> tuple[Dict[str, Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
    players_path = data_dir / "ipl_players.csv"
    seasons_path = data_dir / "ipl_season_stats.csv"
    if not players_path.exists() or not seasons_path.exists():
        raise FileNotFoundError(f"Processed CSV datasets not found in {data_dir}")

    players_by_id: Dict[str, Dict[str, Any]] = {}
    with open(players_path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            pid = row["cricsheetId"]
            dob = row.get("dateOfBirth") or ""
            dob_year = int(dob[:4]) if len(dob) >= 4 and dob[:4].isdigit() else None
            nat = row.get("nationality") or ""
            is_os_raw = (row.get("isOverseas") or "").lower()
            is_overseas_num = np.nan
            if nat:
                if is_os_raw == "true":
                    is_overseas_num = 1.0
                elif is_os_raw == "false":
                    is_overseas_num = 0.0
                else:
                    is_overseas_num = 0.0 if nat.lower() == "india" else 1.0

            players_by_id[pid] = {
                "cricsheet_id": pid,
                "external_key": row.get("externalKey") or None,
                "full_name": row["fullName"],
                "dob_year": dob_year,
                "is_overseas_num": is_overseas_num,
            }

    seasons_by_player: Dict[str, List[Dict[str, Any]]] = {pid: [] for pid in players_by_id}
    with open(seasons_path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            pid = row["cricsheetId"]
            season = _to_int(row.get("season"))
            if pid not in seasons_by_player or season is None:
                continue
            seasons_by_player[pid].append({
                "season": season,
                "matches": _to_int(row.get("matches")) or 0,
                "batting_innings": _to_int(row.get("battingInnings")) or 0,
                "bowling_innings": _to_int(row.get("bowlingInnings")) or 0,
                "runs": _to_int(row.get("runs")),
                "balls_faced": _to_int(row.get("ballsFaced")),
                "not_outs": _to_int(row.get("notOuts")),
                "fifties": _to_int(row.get("fifties")),
                "hundreds": _to_int(row.get("hundreds")),
                "wickets": _to_int(row.get("wickets")),
                "balls_bowled": _to_int(row.get("ballsBowled")),
                "runs_conceded": _to_int(row.get("runsConceded")),
                "catches": _to_int(row.get("catches")) or 0,
                "stumpings": _to_int(row.get("stumpings")) or 0,
            })

    for pid in seasons_by_player:
        seasons_by_player[pid].sort(key=lambda r: r["season"])

    return players_by_id, seasons_by_player


def compute_cutoff_player_features(
    season_rows: List[Dict[str, Any]],
    player_meta: Dict[str, Any],
    cutoff_season: int,
) -> Optional[Dict[str, Any]]:
    """
    Computes strictly leakage-safe player features from seasons < cutoff_season.
    Returns None if the player has no recorded seasons before cutoff_season.
    """
    prior = sorted([r for r in season_rows if r["season"] < cutoff_season], key=lambda r: r["season"])
    if not prior:
        return None

    prior_matches = sum(r["matches"] for r in prior)
    if prior_matches <= 0:
        return None

    prior_seasons_count = len(prior)
    seasons_since_last = cutoff_season - max(r["season"] for r in prior)
    prior_catches = sum(r["catches"] for r in prior)
    prior_stumpings = sum(r["stumpings"] for r in prior)

    # Batting aggregates strictly < cutoff_season
    bat_rows = [r for r in prior if r["runs"] is not None and r["matches"] > 0]
    prior_bat_innings = sum(r["batting_innings"] for r in bat_rows)
    prior_bat_inn_rate = prior_bat_innings / prior_matches

    if bat_rows:
        tot_runs = sum(r["runs"] for r in bat_rows)
        tot_bf = sum((r["balls_faced"] or 0) for r in bat_rows)
        tot_no = sum((r["not_outs"] or 0) for r in bat_rows)
        tot_50s = sum((r["fifties"] or 0) for r in bat_rows)
        tot_100s = sum((r["hundreds"] or 0) for r in bat_rows)
        dismissals = max(0, prior_bat_innings - tot_no)

        prior_rpm = tot_runs / prior_matches
        prior_bat_avg = (tot_runs / dismissals) if dismissals > 0 else np.nan
        prior_sr = ((tot_runs * 100.0) / tot_bf) if tot_bf > 0 else np.nan
        prior_50_plus_rate = ((tot_50s + tot_100s) / prior_bat_innings) if prior_bat_innings > 0 else np.nan

        last1 = bat_rows[-1]
        rec_1y_rpm = last1["runs"] / last1["matches"]

        last2 = bat_rows[-2:]
        m2 = sum(r["matches"] for r in last2)
        rec_2y_rpm = (sum(r["runs"] for r in last2) / m2) if m2 > 0 else np.nan

        last3 = bat_rows[-3:]
        m3 = sum(r["matches"] for r in last3)
        rec_3y_rpm = (sum(r["runs"] for r in last3) / m3) if m3 > 0 else np.nan

        if len(bat_rows) >= 2:
            per_season_rpm = [r["runs"] / r["matches"] for r in bat_rows]
            bat_std = float(np.std(per_season_rpm, ddof=1))
            bat_delta = rec_1y_rpm - prior_rpm
        else:
            bat_std = np.nan
            bat_delta = np.nan
    else:
        prior_rpm = np.nan
        prior_bat_avg = np.nan
        prior_sr = np.nan
        prior_50_plus_rate = np.nan
        rec_1y_rpm = np.nan
        rec_2y_rpm = np.nan
        rec_3y_rpm = np.nan
        bat_std = np.nan
        bat_delta = np.nan

    # Bowling aggregates strictly < cutoff_season
    bowl_rows = [r for r in prior if r["wickets"] is not None and r["bowling_innings"] > 0 and r["matches"] > 0]
    prior_bowl_innings = sum(r["bowling_innings"] for r in bowl_rows)
    prior_bowl_inn_rate = prior_bowl_innings / prior_matches

    if bowl_rows:
        tot_wkts = sum(r["wickets"] for r in bowl_rows)
        tot_bb = sum((r["balls_bowled"] or 0) for r in bowl_rows)
        tot_rc = sum((r["runs_conceded"] or 0) for r in bowl_rows)

        prior_wpm = tot_wkts / prior_matches
        prior_bowl_avg = (tot_rc / tot_wkts) if tot_wkts > 0 else np.nan
        prior_econ = ((tot_rc * 6.0) / tot_bb) if tot_bb > 0 else np.nan
        prior_bowl_sr = (tot_bb / tot_wkts) if tot_wkts > 0 else np.nan

        w_last1 = bowl_rows[-1]
        rec_1y_wpm = w_last1["wickets"] / w_last1["matches"]

        w_last2 = bowl_rows[-2:]
        wm2 = sum(r["matches"] for r in w_last2)
        rec_2y_wpm = (sum(r["wickets"] for r in w_last2) / wm2) if wm2 > 0 else np.nan

        w_last3 = bowl_rows[-3:]
        wm3 = sum(r["matches"] for r in w_last3)
        rec_3y_wpm = (sum(r["wickets"] for r in w_last3) / wm3) if wm3 > 0 else np.nan

        if len(bowl_rows) >= 2:
            per_season_wpm = [r["wickets"] / r["matches"] for r in bowl_rows]
            bowl_std = float(np.std(per_season_wpm, ddof=1))
            bowl_delta = rec_1y_wpm - prior_wpm
        else:
            bowl_std = np.nan
            bowl_delta = np.nan
    else:
        prior_wpm = np.nan
        prior_bowl_avg = np.nan
        prior_econ = np.nan
        prior_bowl_sr = np.nan
        rec_1y_wpm = np.nan
        rec_2y_wpm = np.nan
        rec_3y_wpm = np.nan
        bowl_std = np.nan
        bowl_delta = np.nan

    dob_year = player_meta.get("dob_year")
    age_at_season = float(cutoff_season - dob_year) if dob_year else np.nan

    return {
        "prior_seasons_count": float(prior_seasons_count),
        "prior_matches": float(prior_matches),
        "prior_bat_innings": float(prior_bat_innings),
        "prior_batting_innings_rate": float(prior_bat_inn_rate),
        "prior_runs_per_match": float(prior_rpm) if not np.isnan(prior_rpm) else np.nan,
        "prior_batting_avg": float(prior_bat_avg) if not np.isnan(prior_bat_avg) else np.nan,
        "prior_strike_rate": float(prior_sr) if not np.isnan(prior_sr) else np.nan,
        "prior_50_plus_rate": float(prior_50_plus_rate) if not np.isnan(prior_50_plus_rate) else np.nan,
        "recent_1y_runs_per_match": float(rec_1y_rpm) if not np.isnan(rec_1y_rpm) else np.nan,
        "recent_2y_runs_per_match": float(rec_2y_rpm) if not np.isnan(rec_2y_rpm) else np.nan,
        "recent_3y_runs_per_match": float(rec_3y_rpm) if not np.isnan(rec_3y_rpm) else np.nan,
        "batting_consistency_std": float(bat_std) if not np.isnan(bat_std) else np.nan,
        "batting_trend_delta": float(bat_delta) if not np.isnan(bat_delta) else np.nan,
        "prior_bowl_innings": float(prior_bowl_innings),
        "prior_bowling_innings_rate": float(prior_bowl_inn_rate),
        "prior_wickets_per_match": float(prior_wpm) if not np.isnan(prior_wpm) else np.nan,
        "prior_bowling_avg": float(prior_bowl_avg) if not np.isnan(prior_bowl_avg) else np.nan,
        "prior_economy": float(prior_econ) if not np.isnan(prior_econ) else np.nan,
        "prior_bowling_sr": float(prior_bowl_sr) if not np.isnan(prior_bowl_sr) else np.nan,
        "recent_1y_wickets_per_match": float(rec_1y_wpm) if not np.isnan(rec_1y_wpm) else np.nan,
        "recent_2y_wickets_per_match": float(rec_2y_wpm) if not np.isnan(rec_2y_wpm) else np.nan,
        "recent_3y_wickets_per_match": float(rec_3y_wpm) if not np.isnan(rec_3y_wpm) else np.nan,
        "bowling_consistency_std": float(bowl_std) if not np.isnan(bowl_std) else np.nan,
        "bowling_trend_delta": float(bowl_delta) if not np.isnan(bowl_delta) else np.nan,
        "prior_catches_per_match": float(prior_catches / prior_matches),
        "is_prior_wicketkeeper": 1.0 if prior_stumpings > 0 else 0.0,
        "seasons_since_last_played": float(seasons_since_last),
        "age_at_season": age_at_season,
        "is_overseas_num": player_meta.get("is_overseas_num", np.nan),
    }


def build_supervised_dataset(
    task: Literal["batting", "bowling"],
    min_target_matches: int = 3,
    min_prior_matches: int = 3,
    data_dir: Path = DATA_DIR,
) -> pd.DataFrame:
    """
    Constructs a chronological player-season supervised DataFrame for season-level
    batting (`runs_per_match`) or bowling (`wickets_per_match`) performance prediction.
    """
    players_by_id, seasons_by_player = load_raw_tables(data_dir)
    records: List[Dict[str, Any]] = []

    for pid, meta in players_by_id.items():
        season_rows = seasons_by_player.get(pid, [])
        for row in season_rows:
            target_season = row["season"]
            target_matches = row["matches"]
            if target_matches < min_target_matches:
                continue

            if task == "batting":
                if row["runs"] is None or row["batting_innings"] < 1:
                    continue
                target_val = row["runs"] / target_matches
            else:
                if row["wickets"] is None or row["bowling_innings"] < 1:
                    continue
                target_val = row["wickets"] / target_matches

            feats = compute_cutoff_player_features(season_rows, meta, cutoff_season=target_season)
            if feats is None or feats["prior_matches"] < min_prior_matches:
                continue

            if task == "batting" and feats["prior_bat_innings"] < 2:
                continue
            if task == "bowling" and feats["prior_bowl_innings"] < 2:
                continue

            records.append({
                "cricsheet_id": pid,
                "full_name": meta["full_name"],
                "target_season": target_season,
                "target_matches": target_matches,
                "target": float(target_val),
                **feats,
            })

    df = pd.DataFrame(records)
    if not df.empty:
        df = df.sort_values(["target_season", "cricsheet_id"]).reset_index(drop=True)
    return df
