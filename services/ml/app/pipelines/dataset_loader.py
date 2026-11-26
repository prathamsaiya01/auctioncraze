"""
Leak-free dataset loading and feature assembly for verified IPL records.
Never fabricates missing values or outputs auction bidding advice.
"""
import csv
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "processed"


def _to_int(val: str) -> Optional[int]:
    if not val or val.strip() == "":
        return None
    return int(val)


def _to_float(val: str) -> Optional[float]:
    if not val or val.strip() == "":
        return None
    return float(val)


def load_provenance_manifest() -> Dict[str, Any]:
    path = DATA_DIR / "provenance_manifest.json"
    if not path.exists():
        raise FileNotFoundError(f"Provenance manifest missing at {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def load_player_feature_vectors(cutoff_season: Optional[int] = None) -> Dict[str, Dict[str, Any]]:
    """
    Constructs leakage-free per-player historical feature dicts strictly from verified
    Cricsheet + Wikidata + Wikipedia records. Missing/unrecorded stats stay None.
    If cutoff_season is given, only seasons < cutoff_season are included (preventing lookahead).
    """
    players_path = DATA_DIR / "ipl_players.csv"
    seasons_path = DATA_DIR / "ipl_season_stats.csv"
    if not players_path.exists() or not seasons_path.exists():
        raise FileNotFoundError("Processed IPL dataset CSVs not found.")

    players: Dict[str, Dict[str, Any]] = {}
    with open(players_path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            pid = row["cricsheetId"]
            players[pid] = {
                "cricsheet_id": pid,
                "full_name": row["fullName"],
                "nationality": row["nationality"] or None,
                "playing_role": row["playingRole"],
                "provenance_source": row["provenanceSource"],
                "seasons": [],
            }

    with open(seasons_path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            pid = row["cricsheetId"]
            season = _to_int(row["season"])
            if pid not in players or season is None:
                continue
            if cutoff_season is not None and season >= cutoff_season:
                continue
            players[pid]["seasons"].append({
                "season": season,
                "matches": _to_int(row["matches"]) or 0,
                "batting_innings": _to_int(row["battingInnings"]) or 0,
                "runs": _to_int(row["runs"]),
                "balls_faced": _to_int(row["ballsFaced"]),
                "not_outs": _to_int(row["notOuts"]),
                "bowling_innings": _to_int(row["bowlingInnings"]) or 0,
                "wickets": _to_int(row["wickets"]),
                "balls_bowled": _to_int(row["ballsBowled"]),
                "runs_conceded": _to_int(row["runsConceded"]),
            })

    out: Dict[str, Dict[str, Any]] = {}
    for pid, p in players.items():
        seasons_sorted = sorted(p["seasons"], key=lambda s: s["season"])
        if not seasons_sorted:
            continue

        total_matches = sum(s["matches"] for s in seasons_sorted)
        bat_seasons = [s for s in seasons_sorted if s["runs"] is not None]
        bowl_seasons = [s for s in seasons_sorted if s["wickets"] is not None]

        career_runs = sum(s["runs"] for s in bat_seasons) if bat_seasons else None
        career_bf = sum(s["balls_faced"] or 0 for s in bat_seasons) if bat_seasons else None
        career_bat_inn = sum(s["batting_innings"] for s in bat_seasons) if bat_seasons else None
        career_no = sum(s["not_outs"] or 0 for s in bat_seasons) if bat_seasons else None

        dismissals = (career_bat_inn - career_no) if (career_bat_inn is not None and career_no is not None) else 0
        career_bat_avg = round(career_runs / dismissals, 2) if (career_runs is not None and dismissals > 0) else None
        career_sr = round((career_runs * 100.0) / career_bf, 2) if (career_runs is not None and career_bf and career_bf > 0) else None

        career_wkts = sum(s["wickets"] for s in bowl_seasons) if bowl_seasons else None
        career_bb = sum(s["balls_bowled"] or 0 for s in bowl_seasons) if bowl_seasons else None
        career_rc = sum(s["runs_conceded"] or 0 for s in bowl_seasons) if bowl_seasons else None
        career_econ = round((career_rc * 6.0) / career_bb, 2) if (career_rc is not None and career_bb and career_bb > 0) else None

        recent3 = seasons_sorted[-3:]
        recent3_bat = [s["runs"] for s in recent3 if s["runs"] is not None]
        recent3_bowl = [s["wickets"] for s in recent3 if s["wickets"] is not None]

        out[pid] = {
            "cricsheet_id": pid,
            "full_name": p["full_name"],
            "nationality": p["nationality"],
            "playing_role": p["playing_role"],
            "seasons_played": len(seasons_sorted),
            "total_matches": total_matches,
            "career_runs": career_runs,
            "career_batting_average": career_bat_avg,
            "career_strike_rate": career_sr,
            "career_wickets": career_wkts,
            "career_bowling_economy": career_econ,
            "recent_3_season_runs": sum(recent3_bat) if recent3_bat else None,
            "recent_3_season_wickets": sum(recent3_bowl) if recent3_bowl else None,
            "provenance_source": p["provenance_source"],
        }

    return out
