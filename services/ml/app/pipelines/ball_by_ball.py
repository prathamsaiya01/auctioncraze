#!/usr/bin/env python3
"""
Phase 6B.1 & 6B.2 — Cricsheet Ball-by-Ball Parser & Advanced Cricket Analytics Pipeline.

Parses every match in services/ml/data/raw/ipl_json.zip following Cricsheet 1.0/1.1 rules:
- Distinguishes legal deliveries (wides == 0 and noballs == 0), batter balls faced (wides == 0),
  bowler runs conceded (batter + wides + noballs; excludes byes, legbyes, penalty).
- Excludes runs.non_boundary == true from fours/sixes counts.
- Distinguishes bowler-credited wickets (bowled, caught, caught and bowled, hit wicket, lbw, stumped)
  from team-credited wickets (run out, retired out, obstructing the field) and retired hurt.
- Separates Super Overs from regular match innings cleanly.
- Extracts Impact Player substitutions (reason == 'impact_player') and abandoned / DLS / eliminator results.
- Aggregates career, seasonal, recent-3-season, phase-wise (Powerplay 1-6, Middle 7-15, Death 16+),
  and match situation (Batting First vs Chasing) metrics, keeping unavailable values as null.
"""
import csv
import gzip
import json
import re
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

ML_ROOT = Path(__file__).resolve().parents[2]
RAW_ZIP = ML_ROOT / "data" / "raw" / "ipl_json.zip"
RAW_PEOPLE = ML_ROOT / "data" / "raw" / "people.csv"
PROCESSED_DIR = ML_ROOT / "data" / "processed"
ANALYTICS_DIR = PROCESSED_DIR / "analytics"
ANALYTICS_DIR.mkdir(parents=True, exist_ok=True)

TEAM_CODE_MAP = {
    "Chennai Super Kings": "CSK",
    "Mumbai Indians": "MI",
    "Royal Challengers Bangalore": "RCB",
    "Royal Challengers Bengaluru": "RCB",
    "Kolkata Knight Riders": "KKR",
    "Delhi Capitals": "DC",
    "Delhi Daredevils": "DC",
    "Punjab Kings": "PBKS",
    "Kings XI Punjab": "PBKS",
    "Rajasthan Royals": "RR",
    "Sunrisers Hyderabad": "SRH",
    "Deccan Chargers": "DCH",
    "Gujarat Titans": "GT",
    "Lucknow Super Giants": "LSG",
    "Gujarat Lions": "GL",
    "Pune Warriors": "PWI",
    "Rising Pune Supergiant": "RPS",
    "Rising Pune Supergiants": "RPS",
    "Kochi Tuskers Kerala": "KTK",
}

BOWLER_WICKET_KINDS = {
    "bowled",
    "caught",
    "caught and bowled",
    "hit wicket",
    "lbw",
    "stumped",
}

NON_DISMISSAL_KINDS = {"retired hurt"}


def get_team_code(team_name: Optional[str]) -> Optional[str]:
    if not team_name:
        return None
    if team_name in TEAM_CODE_MAP:
        return TEAM_CODE_MAP[team_name]
    return re.sub(r"[^A-Z]", "", team_name.upper())[:4] or team_name[:4].upper()


def parse_season_year(season_raw: Any, match_date: str) -> int:
    s = str(season_raw or "").strip()
    if s == "2007/08":
        return 2008
    if s == "2009/10":
        return 2010
    if s == "2020/21":
        return 2020
    m = re.match(r"^(\d{4})", s)
    if m:
        return int(m.group(1))
    return int(match_date[:4])


def classify_phase(zero_based_over: int) -> str:
    """
    Cricsheet overs are 0-indexed (`0` = 1st over).
    - Powerplay: overs 1..6 (0..5)
    - Middle:    overs 7..15 (6..14)
    - Death:     overs 16+ (15+)
    """
    over_num = zero_based_over + 1
    if over_num <= 6:
        return "powerplay"
    if over_num <= 15:
        return "middle"
    return "death"


def _empty_bat_bucket() -> Dict[str, int]:
    return {
        "innings": 0,
        "runs": 0,
        "balls_faced": 0,
        "dismissals": 0,
        "fours": 0,
        "sixes": 0,
        "dot_balls": 0,
    }


def _empty_bowl_bucket() -> Dict[str, int]:
    return {
        "innings": 0,
        "legal_balls": 0,
        "runs_conceded": 0,
        "wickets": 0,
        "dot_balls": 0,
        "fours_conceded": 0,
        "sixes_conceded": 0,
        "wides": 0,
        "noballs": 0,
    }


def _make_scope_acc() -> Dict[str, Any]:
    return {
        "matches": set(),
        "batting_innings": set(),
        "bowling_innings": set(),
        "bat_overall": _empty_bat_bucket(),
        "bat_powerplay": _empty_bat_bucket(),
        "bat_middle": _empty_bat_bucket(),
        "bat_death": _empty_bat_bucket(),
        "bat_first": _empty_bat_bucket(),
        "bat_chasing": _empty_bat_bucket(),
        "bowl_overall": _empty_bowl_bucket(),
        "bowl_powerplay": _empty_bowl_bucket(),
        "bowl_middle": _empty_bowl_bucket(),
        "bowl_death": _empty_bowl_bucket(),
        "bowl_first": _empty_bowl_bucket(),
        "bowl_chasing": _empty_bowl_bucket(),
        "catches": 0,
        "stumpings": 0,
        "run_outs": 0,
    }


def _fmt_rate(num: int, den: int, scale: float = 1.0) -> Optional[float]:
    if den <= 0:
        return None
    return round((num * scale) / den, 2)


def _overs_float(legal_balls: int) -> Optional[float]:
    if legal_balls <= 0:
        return None
    return round((legal_balls // 6) + (legal_balls % 6) / 10.0, 1)


def _flatten_scope_row(cricsheet_id: str, scope: str, acc: Dict[str, Any]) -> Dict[str, Any]:
    bo = acc["bat_overall"]
    bp = acc["bat_powerplay"]
    bm = acc["bat_middle"]
    bd = acc["bat_death"]
    b1 = acc["bat_first"]
    b2 = acc["bat_chasing"]

    wo = acc["bowl_overall"]
    wp = acc["bowl_powerplay"]
    wm = acc["bowl_middle"]
    wd = acc["bowl_death"]
    w1 = acc["bowl_first"]
    w2 = acc["bowl_chasing"]

    bat_inn_cnt = len(acc["batting_innings"])
    bowl_inn_cnt = len(acc["bowling_innings"])
    has_bat = bo["balls_faced"] > 0 or bo["runs"] > 0 or bo["dismissals"] > 0 or bat_inn_cnt > 0
    has_bowl = wo["legal_balls"] > 0 or wo["runs_conceded"] > 0 or bowl_inn_cnt > 0

    boundary_runs = (bo["fours"] * 4) + (bo["sixes"] * 6)
    bowled_boundary_runs = (wo["fours_conceded"] * 4) + (wo["sixes_conceded"] * 6)

    def _bat_fields(prefix: str, b: Dict[str, int]) -> Dict[str, Any]:
        present = b["balls_faced"] > 0 or b["runs"] > 0 or b["dismissals"] > 0
        return {
            f"{prefix}_runs": b["runs"] if present else None,
            f"{prefix}_balls": b["balls_faced"] if present else None,
            f"{prefix}_sr": _fmt_rate(b["runs"], b["balls_faced"], 100.0),
            f"{prefix}_avg": _fmt_rate(b["runs"], b["dismissals"], 1.0),
            f"{prefix}_dot_pct": _fmt_rate(b["dot_balls"], b["balls_faced"], 100.0),
            f"{prefix}_boundary_pct": _fmt_rate((b["fours"] * 4) + (b["sixes"] * 6), b["runs"], 100.0),
        }

    def _bowl_fields(prefix: str, w: Dict[str, int]) -> Dict[str, Any]:
        present = w["legal_balls"] > 0 or w["runs_conceded"] > 0
        return {
            f"{prefix}_balls": w["legal_balls"] if present else None,
            f"{prefix}_runs": w["runs_conceded"] if present else None,
            f"{prefix}_wickets": w["wickets"] if present else None,
            f"{prefix}_econ": _fmt_rate(w["runs_conceded"], w["legal_balls"], 6.0),
            f"{prefix}_sr": _fmt_rate(w["legal_balls"], w["wickets"], 1.0),
            f"{prefix}_dot_pct": _fmt_rate(w["dot_balls"], w["legal_balls"], 100.0),
        }

    row: Dict[str, Any] = {
        "cricsheet_id": cricsheet_id,
        "scope": scope,
        "matches": len(acc["matches"]),
        "batting_innings": bat_inn_cnt,
        "runs": bo["runs"] if has_bat else None,
        "balls_faced": bo["balls_faced"] if has_bat else None,
        "dismissals": bo["dismissals"] if has_bat else None,
        "batting_average": _fmt_rate(bo["runs"], bo["dismissals"], 1.0),
        "strike_rate": _fmt_rate(bo["runs"], bo["balls_faced"], 100.0),
        "dismissal_rate": _fmt_rate(bo["dismissals"], bo["balls_faced"], 100.0),
        "fours": bo["fours"] if has_bat else None,
        "sixes": bo["sixes"] if has_bat else None,
        "boundary_runs": boundary_runs if has_bat else None,
        "boundary_pct": _fmt_rate(boundary_runs, bo["runs"], 100.0),
        "dot_ball_pct": _fmt_rate(bo["dot_balls"], bo["balls_faced"], 100.0),
        "bowling_innings": bowl_inn_cnt,
        "legal_balls_bowled": wo["legal_balls"] if has_bowl else None,
        "overs_bowled": _overs_float(wo["legal_balls"]),
        "runs_conceded": wo["runs_conceded"] if has_bowl else None,
        "wickets": wo["wickets"] if has_bowl else None,
        "economy": _fmt_rate(wo["runs_conceded"], wo["legal_balls"], 6.0),
        "bowling_average": _fmt_rate(wo["runs_conceded"], wo["wickets"], 1.0),
        "bowling_strike_rate": _fmt_rate(wo["legal_balls"], wo["wickets"], 1.0),
        "bowl_dot_ball_pct": _fmt_rate(wo["dot_balls"], wo["legal_balls"], 100.0),
        "boundary_conceded_pct": _fmt_rate(bowled_boundary_runs, wo["runs_conceded"], 100.0),
        "wicket_frequency_pct": _fmt_rate(wo["wickets"], wo["legal_balls"], 100.0),
        "wides": wo["wides"] if has_bowl else None,
        "noballs": wo["noballs"] if has_bowl else None,
        "catches": acc["catches"],
        "stumpings": acc["stumpings"],
        "run_outs": acc["run_outs"],
    }
    row.update(_bat_fields("bat_pp", bp))
    row.update(_bat_fields("bat_mid", bm))
    row.update(_bat_fields("bat_death", bd))
    row.update(_bat_fields("bat_first", b1))
    row.update(_bat_fields("bat_chase", b2))
    row.update(_bowl_fields("bowl_pp", wp))
    row.update(_bowl_fields("bowl_mid", wm))
    row.update(_bowl_fields("bowl_death", wd))
    row.update(_bowl_fields("bowl_first", w1))
    row.update(_bowl_fields("bowl_chase", w2))
    return row


def run_ball_by_ball_pipeline(
    zip_path: Path = RAW_ZIP,
    write_outputs: bool = True,
) -> Dict[str, Any]:
    if not zip_path.exists():
        raise FileNotFoundError(f"Cricsheet IPL archive missing at {zip_path}")

    seen_match_ids: Set[str] = set()
    duplicate_matches: List[str] = []

    match_rows: List[Dict[str, Any]] = []
    appearance_rows: List[Dict[str, Any]] = []

    # (cricsheet_id, scope) -> accumulator
    player_scopes: Dict[Tuple[str, str], Dict[str, Any]] = defaultdict(_make_scope_acc)
    player_seasons_seen: Dict[str, Set[int]] = defaultdict(set)

    stats_totals = {
        "total_match_files": 0,
        "unique_matches": 0,
        "regular_innings_parsed": 0,
        "super_over_innings_excluded_from_career": 0,
        "deliveries_parsed": 0,
        "legal_deliveries": 0,
        "wides_deliveries": 0,
        "noballs_deliveries": 0,
        "byes_deliveries": 0,
        "legbyes_deliveries": 0,
        "penalty_deliveries": 0,
        "non_boundary_excluded": 0,
        "bowler_wickets": 0,
        "non_bowler_wickets": 0,
        "impact_player_substitutions": 0,
        "no_result_matches": 0,
        "tie_eliminator_matches": 0,
        "dls_or_shortened_matches": 0,
    }

    with zipfile.ZipFile(zip_path) as z:
        names = sorted(n for n in z.namelist() if n.endswith(".json"))
        for fname in names:
            stats_totals["total_match_files"] += 1
            match_id = Path(fname).stem
            if match_id in seen_match_ids:
                duplicate_matches.append(match_id)
                continue
            seen_match_ids.add(match_id)
            stats_totals["unique_matches"] += 1

            data = json.loads(z.read(fname))
            info = data.get("info", {})
            dates = info.get("dates") or ["2008-01-01"]
            match_date = dates[0]
            season = parse_season_year(info.get("season"), match_date)
            teams = info.get("teams") or []
            team1_name = teams[0] if len(teams) > 0 else ""
            team2_name = teams[1] if len(teams) > 1 else ""
            team1_code = get_team_code(team1_name) or ""
            team2_code = get_team_code(team2_name) or ""

            toss = info.get("toss") or {}
            toss_winner_code = get_team_code(toss.get("winner"))
            toss_decision = toss.get("decision")

            outcome = info.get("outcome") or {}
            result_raw = outcome.get("result")
            method = outcome.get("method")
            if method:
                stats_totals["dls_or_shortened_matches"] += 1

            if outcome.get("winner"):
                winner_code = get_team_code(outcome.get("winner"))
                result_type = "normal"
            elif outcome.get("eliminator"):
                winner_code = get_team_code(outcome.get("eliminator"))
                result_type = "tie_eliminator"
                stats_totals["tie_eliminator_matches"] += 1
            else:
                winner_code = None
                result_type = result_raw or "no_result"
                stats_totals["no_result_matches"] += 1

            by = outcome.get("by") or {}
            win_by_runs = by.get("runs")
            win_by_wickets = by.get("wickets")

            reg = (info.get("registry") or {}).get("people") or {}
            pom_names = info.get("player_of_match") or []
            pom_id = reg.get(pom_names[0]) if pom_names and pom_names[0] in reg else None

            match_rows.append({
                "match_id": match_id,
                "match_date": match_date,
                "season": season,
                "team1_code": team1_code,
                "team2_code": team2_code,
                "team1_name": team1_name,
                "team2_name": team2_name,
                "venue": info.get("venue") or "",
                "city": info.get("city") or "",
                "toss_winner_code": toss_winner_code or "",
                "toss_decision": toss_decision or "",
                "winner_code": winner_code or "",
                "result_type": result_type,
                "method": method or "",
                "win_by_runs": win_by_runs if win_by_runs is not None else "",
                "win_by_wickets": win_by_wickets if win_by_wickets is not None else "",
                "player_of_match_id": pom_id or "",
                "is_completed": "true" if winner_code else "false",
                "provenance_source": "cricsheet",
            })

            # Track match-level player appearances
            app_tracker: Dict[str, Dict[str, Any]] = {}
            for tname, plist in (info.get("players") or {}).items():
                tcode = get_team_code(tname) or ""
                for pname in plist:
                    pid = reg.get(pname)
                    if not pid:
                        continue
                    player_seasons_seen[pid].add(season)
                    app_tracker[pid] = {
                        "match_id": match_id,
                        "season": season,
                        "team_code": tcode,
                        "cricsheet_id": pid,
                        "batting_order": None,
                        "runs": 0,
                        "balls_faced": 0,
                        "legal_balls_bowled": 0,
                        "wickets": 0,
                        "is_impact_in": False,
                        "is_impact_out": False,
                    }
                    for sc in ("CAREER", f"SEASON_{season}"):
                        player_scopes[(pid, sc)]["matches"].add(match_id)

            # Parse innings & deliveries cleanly
            regular_inn_counter = 0
            for inn_idx, inning in enumerate(data.get("innings", [])):
                if inning.get("super_over"):
                    stats_totals["super_over_innings_excluded_from_career"] += 1
                    continue

                regular_inn_counter += 1
                stats_totals["regular_innings_parsed"] += 1
                inn_key = f"{match_id}:{inn_idx}"
                is_chasing = regular_inn_counter == 2
                situation_bat_key = "bat_chasing" if is_chasing else "bat_first"
                situation_bowl_key = "bowl_chasing" if is_chasing else "bowl_first"

                bat_order_seen: List[str] = []

                for over_obj in inning.get("overs", []):
                    over_idx = int(over_obj.get("over", 0))
                    phase = classify_phase(over_idx)
                    bat_phase_key = f"bat_{phase}"
                    bowl_phase_key = f"bowl_{phase}"

                    for dl in over_obj.get("deliveries", []):
                        stats_totals["deliveries_parsed"] += 1

                        # Check Impact Player replacements
                        repl = dl.get("replacements") or {}
                        for m_rep in repl.get("match") or []:
                            if m_rep.get("reason") == "impact_player":
                                stats_totals["impact_player_substitutions"] += 1
                                in_id = reg.get(m_rep.get("in"))
                                out_id = reg.get(m_rep.get("out"))
                                if in_id and in_id in app_tracker:
                                    app_tracker[in_id]["is_impact_in"] = True
                                if out_id and out_id in app_tracker:
                                    app_tracker[out_id]["is_impact_out"] = True

                        batter_id = reg.get(dl.get("batter"))
                        non_striker_id = reg.get(dl.get("non_striker"))
                        bowler_id = reg.get(dl.get("bowler"))
                        extras = dl.get("extras") or {}
                        runs = dl.get("runs") or {}

                        wides = int(extras.get("wides") or 0)
                        noballs = int(extras.get("noballs") or 0)
                        byes = int(extras.get("byes") or 0)
                        legbyes = int(extras.get("legbyes") or 0)
                        penalty = int(extras.get("penalty") or 0)

                        if wides > 0:
                            stats_totals["wides_deliveries"] += 1
                        if noballs > 0:
                            stats_totals["noballs_deliveries"] += 1
                        if byes > 0:
                            stats_totals["byes_deliveries"] += 1
                        if legbyes > 0:
                            stats_totals["legbyes_deliveries"] += 1
                        if penalty > 0:
                            stats_totals["penalty_deliveries"] += 1

                        is_legal = (wides == 0) and (noballs == 0)
                        if is_legal:
                            stats_totals["legal_deliveries"] += 1

                        is_batter_ball = wides == 0
                        r_bat = int(runs.get("batter") or 0)
                        r_total = int(runs.get("total") or 0)
                        is_non_boundary = bool(runs.get("non_boundary"))
                        if is_non_boundary:
                            stats_totals["non_boundary_excluded"] += 1

                        is_four = (r_bat == 4) and (not is_non_boundary)
                        is_six = (r_bat == 6) and (not is_non_boundary)
                        is_bat_dot = is_batter_ball and (r_bat == 0)

                        bowler_conceded = r_bat + wides + noballs
                        is_bowl_dot = is_legal and (r_total == 0)

                        for bid in (batter_id, non_striker_id):
                            if bid and bid not in bat_order_seen:
                                bat_order_seen.append(bid)
                                if bid in app_tracker and app_tracker[bid]["batting_order"] is None:
                                    app_tracker[bid]["batting_order"] = len(bat_order_seen)

                        if batter_id:
                            if batter_id in app_tracker:
                                app_tracker[batter_id]["runs"] += r_bat
                                if is_batter_ball:
                                    app_tracker[batter_id]["balls_faced"] += 1
                            for sc in ("CAREER", f"SEASON_{season}"):
                                acc = player_scopes[(batter_id, sc)]
                                acc["batting_innings"].add(inn_key)
                                for bkey in ("bat_overall", bat_phase_key, situation_bat_key):
                                    b = acc[bkey]
                                    b["runs"] += r_bat
                                    if is_batter_ball:
                                        b["balls_faced"] += 1
                                    if is_four:
                                        b["fours"] += 1
                                    if is_six:
                                        b["sixes"] += 1
                                    if is_bat_dot:
                                        b["dot_balls"] += 1

                        if bowler_id:
                            if bowler_id in app_tracker and is_legal:
                                app_tracker[bowler_id]["legal_balls_bowled"] += 1
                            for sc in ("CAREER", f"SEASON_{season}"):
                                acc = player_scopes[(bowler_id, sc)]
                                acc["bowling_innings"].add(inn_key)
                                for wkey in ("bowl_overall", bowl_phase_key, situation_bowl_key):
                                    w = acc[wkey]
                                    w["runs_conceded"] += bowler_conceded
                                    if is_legal:
                                        w["legal_balls"] += 1
                                    if is_bowl_dot:
                                        w["dot_balls"] += 1
                                    if is_four:
                                        w["fours_conceded"] += 1
                                    if is_six:
                                        w["sixes_conceded"] += 1
                                    if wides > 0:
                                        w["wides"] += 1
                                    if noballs > 0:
                                        w["noballs"] += 1

                        # Wickets & fielding credits
                        for wkt in dl.get("wickets") or []:
                            kind = (wkt.get("kind") or "").lower()
                            out_id = reg.get(wkt.get("player_out"))

                            if out_id and kind not in NON_DISMISSAL_KINDS:
                                for sc in ("CAREER", f"SEASON_{season}"):
                                    acc = player_scopes[(out_id, sc)]
                                    acc["batting_innings"].add(inn_key)
                                    acc["bat_overall"]["dismissals"] += 1
                                    acc[bat_phase_key]["dismissals"] += 1
                                    acc[situation_bat_key]["dismissals"] += 1

                            if bowler_id:
                                if kind in BOWLER_WICKET_KINDS:
                                    stats_totals["bowler_wickets"] += 1
                                    if bowler_id in app_tracker:
                                        app_tracker[bowler_id]["wickets"] += 1
                                    for sc in ("CAREER", f"SEASON_{season}"):
                                        acc = player_scopes[(bowler_id, sc)]
                                        acc["bowl_overall"]["wickets"] += 1
                                        acc[bowl_phase_key]["wickets"] += 1
                                        acc[situation_bowl_key]["wickets"] += 1
                                else:
                                    stats_totals["non_bowler_wickets"] += 1

                            for fld in wkt.get("fielders") or []:
                                if not isinstance(fld, dict) or fld.get("substitute"):
                                    continue
                                f_id = reg.get(fld.get("name"))
                                if not f_id:
                                    continue
                                for sc in ("CAREER", f"SEASON_{season}"):
                                    acc = player_scopes[(f_id, sc)]
                                    if kind in ("caught", "caught and bowled"):
                                        acc["catches"] += 1
                                    elif kind == "stumped":
                                        acc["stumpings"] += 1
                                    elif kind == "run out":
                                        acc["run_outs"] += 1

                            if kind == "caught and bowled" and bowler_id and not (wkt.get("fielders")):
                                for sc in ("CAREER", f"SEASON_{season}"):
                                    player_scopes[(bowler_id, sc)]["catches"] += 1

            for app in app_tracker.values():
                appearance_rows.append(app)

    # Also compute RECENT_3_SEASONS (up to last 3 active IPL seasons for each player)
    for pid, seasons_set in player_seasons_seen.items():
        recent3 = sorted(seasons_set)[-3:]
        rec_acc = _make_scope_acc()
        for yr in recent3:
            src = player_scopes.get((pid, f"SEASON_{yr}"))
            if not src:
                continue
            rec_acc["matches"].update(src["matches"])
            rec_acc["batting_innings"].update(src["batting_innings"])
            rec_acc["bowling_innings"].update(src["bowling_innings"])
            rec_acc["catches"] += src["catches"]
            rec_acc["stumpings"] += src["stumpings"]
            rec_acc["run_outs"] += src["run_outs"]
            for bk in ("bat_overall", "bat_powerplay", "bat_middle", "bat_death", "bat_first", "bat_chasing"):
                for k, v in src[bk].items():
                    rec_acc[bk][k] += v
            for wk in ("bowl_overall", "bowl_powerplay", "bowl_middle", "bowl_death", "bowl_first", "bowl_chasing"):
                for k, v in src[wk].items():
                    rec_acc[wk][k] += v
        player_scopes[(pid, "RECENT_3_SEASONS")] = rec_acc

    # Flatten advanced stats rows
    adv_rows: List[Dict[str, Any]] = []
    for (pid, scope), acc in sorted(player_scopes.items(), key=lambda x: (x[0][0], x[0][1])):
        adv_rows.append(_flatten_scope_row(pid, scope, acc))

    # Reconcile against Phase 5 ipl_season_stats.csv (0 discrepancy guarantee!)
    reconciliation_mismatches: List[Dict[str, Any]] = []
    diamond_duck_notes: List[Dict[str, Any]] = []
    season_csv_path = PROCESSED_DIR / "ipl_season_stats.csv"
    if season_csv_path.exists():
        season_lookup = {
            (r["cricsheet_id"], r["scope"]): r
            for r in adv_rows
            if r["scope"].startswith("SEASON_")
        }
        with open(season_csv_path, encoding="utf-8") as f:
            for srow in csv.DictReader(f):
                pid = srow["cricsheetId"]
                yr = srow["season"]
                adv = season_lookup.get((pid, f"SEASON_{yr}"))
                if not adv:
                    reconciliation_mismatches.append({"cricsheetId": pid, "season": yr, "issue": "Missing in ball-by-ball aggregate"})
                    continue
                csv_runs = int(srow["runs"]) if srow["runs"] else None
                csv_wkts = int(srow["wickets"]) if srow["wickets"] else None
                is_diamond_duck = (
                    csv_runs is None
                    and adv["runs"] == 0
                    and adv["balls_faced"] == 0
                    and (adv["dismissals"] or 0) > 0
                )
                if is_diamond_duck and csv_wkts == adv["wickets"]:
                    diamond_duck_notes.append({
                        "cricsheetId": pid,
                        "season": yr,
                        "note": "Non-striker dismissed facing 0 balls (0 runs, 1 dismissal counted accurately in ball-by-ball analytics)",
                    })
                    continue
                if csv_runs != adv["runs"] or csv_wkts != adv["wickets"]:
                    reconciliation_mismatches.append({
                        "cricsheetId": pid,
                        "season": yr,
                        "csvRuns": csv_runs,
                        "bbbRuns": adv["runs"],
                        "csvWkts": csv_wkts,
                        "bbbWkts": adv["wickets"],
                    })

    summary = {
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "provenance": "Cricsheet IPL Male JSON Archive (ipl_json.zip) + People Register (people.csv)",
        "parsingStats": stats_totals,
        "duplicateMatchIds": duplicate_matches,
        "totalAppearances": len(appearance_rows),
        "totalAdvancedStatRows": len(adv_rows),
        "reconciliationPassed": len(reconciliation_mismatches) == 0 and len(duplicate_matches) == 0,
        "reconciliationMismatches": reconciliation_mismatches[:20],
        "diamondDuckReconciliationNotes": diamond_duck_notes,
    }

    if write_outputs:
        # Write matches.csv
        if match_rows:
            with open(ANALYTICS_DIR / "matches.csv", "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=list(match_rows[0].keys()))
                w.writeheader()
                w.writerows(match_rows)

        # Write compact match_appearances.csv.gz
        if appearance_rows:
            with gzip.open(ANALYTICS_DIR / "match_appearances.csv.gz", "wt", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=list(appearance_rows[0].keys()))
                w.writeheader()
                w.writerows(appearance_rows)

        # Write player_advanced_stats.csv
        if adv_rows:
            with open(ANALYTICS_DIR / "player_advanced_stats.csv", "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=list(adv_rows[0].keys()))
                w.writeheader()
                w.writerows(adv_rows)

        (ANALYTICS_DIR / "reconciliation_report.json").write_text(
            json.dumps(summary, indent=2), encoding="utf-8"
        )

    return summary


if __name__ == "__main__":
    res = run_ball_by_ball_pipeline(write_outputs=True)
    print(json.dumps(res, indent=2))
