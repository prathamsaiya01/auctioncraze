import csv
import gzip
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROCESSED_DIR = Path(__file__).resolve().parents[2] / "data" / "processed"
ANALYTICS_DIR = PROCESSED_DIR / "analytics"


def _to_int(val: Any) -> Optional[int]:
    if val is None or val == "":
        return None
    return int(float(val))


def _to_float(val: Any) -> Optional[float]:
    if val is None or val == "":
        return None
    return float(val)


def _to_bool(val: Any) -> Optional[bool]:
    if val is None or val == "":
        return None
    s = str(val).strip().lower()
    if s in ("true", "1", "yes"):
        return True
    if s in ("false", "0", "no"):
        return False
    return None


@lru_cache(maxsize=1)
def load_players_index() -> Tuple[Dict[str, Dict[str, Any]], Dict[str, str]]:
    """Returns (players_by_cricsheet_id, alias_to_cricsheet_id)."""
    players: Dict[str, Dict[str, Any]] = {}
    aliases: Dict[str, str] = {}
    path = PROCESSED_DIR / "ipl_players.csv"
    if not path.exists():
        return players, aliases

    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cid = row["cricsheetId"].strip()
            meta = {
                "cricsheet_id": cid,
                "external_key": row.get("externalKey", "").strip(),
                "full_name": row.get("fullName", "").strip(),
                "nationality": row.get("nationality") or None,
                "is_overseas": bool(_to_bool(row.get("isOverseas"))),
                "playing_role": row.get("playingRole") or "BATSMAN",
                "secondary_role": row.get("secondaryRole") or None,
                "batting_style": row.get("battingStyle") or None,
                "bowling_style": row.get("bowlingStyle") or None,
                "ipl_debut_year": _to_int(row.get("iplDebutYear")),
                "ipl_last_year": _to_int(row.get("iplLastYear")),
                "team_history": [t for t in (row.get("teamHistory") or "").split("|") if t],
                "image_url": row.get("imageUrl") or None,
                "provenance_source": row.get("provenanceSource") or "cricsheet",
            }
            players[cid] = meta
            aliases[cid.lower()] = cid
            if meta["external_key"]:
                aliases[meta["external_key"].lower()] = cid
            if meta["full_name"]:
                aliases[meta["full_name"].lower()] = cid
    return players, aliases


def resolve_player_id(identifier: str) -> Optional[str]:
    if not identifier:
        return None
    _, aliases = load_players_index()
    return aliases.get(identifier.strip().lower())


def get_player_meta(cricsheet_id: str) -> Optional[Dict[str, Any]]:
    players, _ = load_players_index()
    return players.get(cricsheet_id)


INT_STAT_COLS = {
    "matches", "batting_innings", "runs", "balls_faced", "dismissals", "fours", "sixes",
    "boundary_runs", "bowling_innings", "legal_balls_bowled", "runs_conceded", "wickets",
    "wides", "noballs", "catches", "stumpings", "run_outs",
    "bat_pp_runs", "bat_pp_balls", "bat_mid_runs", "bat_mid_balls", "bat_death_runs", "bat_death_balls",
    "bat_first_runs", "bat_first_balls", "bat_chase_runs", "bat_chase_balls",
    "bowl_pp_balls", "bowl_pp_runs", "bowl_pp_wickets", "bowl_mid_balls", "bowl_mid_runs",
    "bowl_mid_wickets", "bowl_death_balls", "bowl_death_runs", "bowl_death_wickets",
    "bowl_first_balls", "bowl_first_runs", "bowl_first_wickets", "bowl_chase_balls",
    "bowl_chase_runs", "bowl_chase_wickets",
}


@lru_cache(maxsize=1)
def load_advanced_stats_index() -> Dict[str, Dict[str, Dict[str, Any]]]:
    """Returns {cricsheet_id: {scope: parsed_row}}."""
    path = ANALYTICS_DIR / "player_advanced_stats.csv"
    out: Dict[str, Dict[str, Dict[str, Any]]] = defaultdict(dict)
    if not path.exists():
        return out

    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cid = row["cricsheet_id"]
            scope = row["scope"]
            parsed: Dict[str, Any] = {"cricsheet_id": cid, "scope": scope}
            for k, v in row.items():
                if k in ("cricsheet_id", "scope"):
                    continue
                if k in INT_STAT_COLS:
                    parsed[k] = _to_int(v)
                else:
                    parsed[k] = _to_float(v)
            out[cid][scope] = parsed
    return out


def get_player_advanced_stats(cricsheet_id: str) -> Dict[str, Dict[str, Any]]:
    return load_advanced_stats_index().get(cricsheet_id, {})


@lru_cache(maxsize=1)
def load_player_appearance_profiles() -> Dict[str, Dict[str, Any]]:
    """Summarizes typical batting position & Impact Player usage from match_appearances.csv.gz."""
    path = ANALYTICS_DIR / "match_appearances.csv.gz"
    acc: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
        "appearances": 0,
        "bat_orders": [],
        "recent_bat_orders": [],
        "impact_in_count": 0,
        "impact_out_count": 0,
    })
    if not path.exists():
        return {}

    with gzip.open(path, "rt", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cid = row["cricsheet_id"]
            season = int(row["season"])
            rec = acc[cid]
            rec["appearances"] += 1
            if row["batting_order"]:
                pos = int(row["batting_order"])
                rec["bat_orders"].append(pos)
                if season >= 2023:
                    rec["recent_bat_orders"].append(pos)
            if row["is_impact_in"].lower() == "true":
                rec["impact_in_count"] += 1
            if row["is_impact_out"].lower() == "true":
                rec["impact_out_count"] += 1

    profiles: Dict[str, Dict[str, Any]] = {}
    for cid, rec in acc.items():
        orders = rec["recent_bat_orders"] or rec["bat_orders"]
        avg_pos = round(sum(orders) / len(orders), 2) if orders else None
        apps = rec["appearances"]
        profiles[cid] = {
            "appearances": apps,
            "avg_batting_order": avg_pos,
            "impact_in_count": rec["impact_in_count"],
            "impact_out_count": rec["impact_out_count"],
            "impact_in_rate": round(rec["impact_in_count"] / apps, 4) if apps else 0.0,
        }
    return profiles


@lru_cache(maxsize=1)
def load_matches_table() -> List[Dict[str, Any]]:
    path = ANALYTICS_DIR / "matches.csv"
    if not path.exists():
        return []
    rows: List[Dict[str, Any]] = []
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            rows.append({
                "match_id": r["match_id"],
                "match_date": r["match_date"],
                "season": int(r["season"]),
                "team1_code": r["team1_code"],
                "team2_code": r["team2_code"],
                "team1_name": r["team1_name"],
                "team2_name": r["team2_name"],
                "venue": r["venue"],
                "city": r["city"] or None,
                "toss_winner_code": r["toss_winner_code"] or None,
                "toss_decision": r["toss_decision"] or None,
                "winner_code": r["winner_code"] or None,
                "result_type": r["result_type"],
                "method": r["method"] or None,
                "win_by_runs": _to_int(r["win_by_runs"]),
                "win_by_wickets": _to_int(r["win_by_wickets"]),
                "player_of_match_id": r["player_of_match_id"] or None,
                "is_completed": _to_bool(r["is_completed"]) or False,
            })
    rows.sort(key=lambda x: (x["match_date"], x["match_id"]))
    return rows
