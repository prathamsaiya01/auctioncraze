from typing import Any, Dict, List, Literal, Optional
from app.pipelines.analytics_store import (
    get_player_advanced_stats,
    get_player_meta,
    load_players_index,
    resolve_player_id,
)

RATING_MODEL_VERSION = "1.0.0"
RATING_DISCLOSURE = (
    "HISTORICAL_STATISTICAL_RATING (Bayesian shrinkage over verified IPL ball-by-ball records; "
    "not an official IPL rating, not a forward ML forecast, and not bidding advice)"
)

MIN_BAT_INNINGS = 5
MIN_BOWL_INNINGS = 5
MIN_BOWL_LEGAL_BALLS = 60
MIN_MATCHES = 5
MIN_PHASE_BALLS = 24


def _clip(v: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, v))


def _shrink(raw: float, sample_n: float, prior_k: float, prior_mean: float = 50.0) -> float:
    w = sample_n / (sample_n + prior_k)
    return round(_clip((w * raw) + ((1.0 - w) * prior_mean), 0.0, 99.0), 2)


def _compute_batting_components(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    inns = row.get("batting_innings") or 0
    balls = row.get("balls_faced") or 0
    runs = row.get("runs") or 0
    if inns < MIN_BAT_INNINGS or balls < 30:
        return None

    avg = row.get("batting_average")
    eff_avg = avg if avg is not None else (runs / max(inns, 1))
    sr = row.get("strike_rate") or 0.0
    bpct = row.get("boundary_pct") or 0.0
    rpi = runs / inns

    avg_comp = _clip(52.0 + ((eff_avg - 21.0) / 10.0) * 16.0, 20.0, 99.0)
    sr_comp = _clip(52.0 + ((sr - 122.0) / 16.0) * 16.0, 20.0, 99.0)
    boundary_comp = _clip(52.0 + ((bpct - 52.0) / 12.0) * 14.0, 20.0, 97.0)
    volume_comp = _clip(42.0 + rpi * 1.65, 25.0, 98.0)

    raw = (0.30 * avg_comp) + (0.34 * sr_comp) + (0.14 * boundary_comp) + (0.22 * volume_comp)
    rating = _shrink(raw, float(inns), prior_k=28.0, prior_mean=52.0)
    return {
        "rating": rating,
        "raw_score": round(raw, 2),
        "shrinkage_weight": round(inns / (inns + 28.0), 3),
        "sample_innings": inns,
        "components": {
            "average_index": round(avg_comp, 2),
            "strike_rate_index": round(sr_comp, 2),
            "boundary_index": round(boundary_comp, 2),
            "volume_index": round(volume_comp, 2),
        },
    }


def _compute_bowling_components(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    inns = row.get("bowling_innings") or 0
    balls = row.get("legal_balls_bowled") or 0
    wickets = row.get("wickets") or 0
    if inns < MIN_BOWL_INNINGS or balls < MIN_BOWL_LEGAL_BALLS:
        return None

    econ = row.get("economy") or 8.5
    b_sr = row.get("bowling_strike_rate") or 36.0
    dot_pct = row.get("bowl_dot_ball_pct") or 30.0
    wpm = wickets / max(inns, 1)

    econ_comp = _clip(56.0 + ((8.15 - econ) / 0.85) * 18.0, 20.0, 99.0)
    sr_comp = _clip(56.0 + ((21.5 - b_sr) / 4.2) * 16.0, 20.0, 99.0)
    wpm_comp = _clip(45.0 + wpm * 31.0, 20.0, 99.0)
    dot_comp = _clip(54.0 + ((dot_pct - 35.0) / 6.5) * 16.0, 20.0, 98.0)

    raw = (0.32 * econ_comp) + (0.28 * sr_comp) + (0.24 * wpm_comp) + (0.16 * dot_comp)
    overs = balls / 6.0
    rating = _shrink(raw, overs, prior_k=85.0, prior_mean=52.0)
    return {
        "rating": rating,
        "raw_score": round(raw, 2),
        "shrinkage_weight": round(overs / (overs + 85.0), 3),
        "sample_overs": round(overs, 1),
        "components": {
            "economy_index": round(econ_comp, 2),
            "strike_rate_index": round(sr_comp, 2),
            "wickets_per_innings_index": round(wpm_comp, 2),
            "dot_ball_index": round(dot_comp, 2),
        },
    }


def _compute_fielding_components(row: Dict[str, Any], is_wk: bool) -> Optional[Dict[str, Any]]:
    matches = row.get("matches") or 0
    if matches < MIN_MATCHES:
        return None
    dismissals = (row.get("catches") or 0) + (row.get("stumpings") or 0) + (row.get("run_outs") or 0)
    rate = dismissals / matches
    base = 46.0 if not is_wk else 44.0
    scale = 42.0 if not is_wk else 36.0
    raw = _clip(base + rate * scale, 35.0, 96.0)
    rating = _shrink(raw, float(matches), prior_k=15.0, prior_mean=48.0)
    return {
        "rating": rating,
        "fielding_dismissals_per_match": round(rate, 3),
        "catches": row.get("catches") or 0,
        "stumpings": row.get("stumpings") or 0,
        "run_outs": row.get("run_outs") or 0,
    }


def _phase_ratings(row: Dict[str, Any]) -> Dict[str, Optional[float]]:
    out: Dict[str, Optional[float]] = {
        "bat_powerplay": None,
        "bat_middle": None,
        "bat_death": None,
        "bowl_powerplay": None,
        "bowl_middle": None,
        "bowl_death": None,
    }
    for key, col in (
        ("bat_powerplay", "bat_pp"),
        ("bat_middle", "bat_mid"),
        ("bat_death", "bat_death"),
    ):
        balls = row.get(f"{col}_balls") or 0
        sr = row.get(f"{col}_sr")
        if balls >= MIN_PHASE_BALLS and sr is not None:
            raw = _clip(50.0 + ((sr - 128.0) / 22.0) * 18.0, 15.0, 98.0)
            out[key] = _shrink(raw, float(balls), prior_k=60.0)

    for key, col in (
        ("bowl_powerplay", "bowl_pp"),
        ("bowl_middle", "bowl_mid"),
        ("bowl_death", "bowl_death"),
    ):
        balls = row.get(f"{col}_balls") or 0
        econ = row.get(f"{col}_econ")
        if balls >= MIN_PHASE_BALLS and econ is not None:
            raw = _clip(52.0 + ((8.0 - econ) / 1.3) * 18.0, 15.0, 98.0)
            out[key] = _shrink(raw, float(balls), prior_k=60.0)
    return out


def compute_player_rating(
    player_id: str,
    scope: Literal["CAREER", "RECENT_3_SEASONS"] = "CAREER",
) -> Optional[Dict[str, Any]]:
    cid = resolve_player_id(player_id)
    if not cid:
        return None
    meta = get_player_meta(cid)
    scopes = get_player_advanced_stats(cid)
    row = scopes.get(scope) or scopes.get("CAREER")
    actual_scope = scope if scope in scopes else ("CAREER" if "CAREER" in scopes else None)
    if not meta or not row or not actual_scope:
        return None

    role = meta.get("playing_role", "BATSMAN")
    is_wk = role == "WICKET_KEEPER"

    bat_res = _compute_batting_components(row)
    bowl_res = _compute_bowling_components(row)
    field_res = _compute_fielding_components(row, is_wk=is_wk)

    bat_r = bat_res["rating"] if bat_res else None
    bowl_r = bowl_res["rating"] if bowl_res else None
    field_r = field_res["rating"] if field_res else None

    all_rounder_r: Optional[float] = None
    if bat_r is not None and bowl_r is not None:
        harmonic = (2.0 * bat_r * bowl_r) / max(bat_r + bowl_r, 1e-6)
        arithmetic = (bat_r + bowl_r) / 2.0
        synergy = 4.0 if (bat_r >= 58.0 and bowl_r >= 58.0) else 0.0
        all_rounder_r = round(_clip((0.70 * harmonic) + (0.30 * arithmetic) + synergy, 0.0, 99.0), 2)

    matches = row.get("matches") or 0
    overall_r: Optional[float] = None
    insufficient = matches < MIN_MATCHES or (bat_r is None and bowl_r is None)

    if not insufficient:
        f_val = field_r if field_r is not None else 50.0
        if role == "WICKET_KEEPER":
            primary = bat_r if bat_r is not None else 50.0
            overall_r = round(_clip(0.78 * primary + 0.22 * f_val, 0.0, 99.0), 2)
        elif role == "ALL_ROUNDER":
            if bat_r is not None and bowl_r is not None and all_rounder_r is not None:
                balanced = 0.40 * bat_r + 0.40 * bowl_r + 0.12 * all_rounder_r + 0.08 * f_val
                dominant = 0.85 * max(bat_r, bowl_r) + 0.10 * f_val + max(0.0, (min(bat_r, bowl_r) - 45.0) * 0.18)
                overall_r = round(_clip(max(balanced, dominant), 0.0, 99.0), 2)
            else:
                primary = bat_r if bat_r is not None else (bowl_r or 50.0)
                overall_r = round(_clip(0.82 * primary + 0.18 * f_val, 0.0, 99.0), 2)
        elif role == "BOWLER":
            if bowl_r is not None:
                bat_bonus = ((bat_r - 45.0) * 0.10) if bat_r is not None else 0.0
                overall_r = round(_clip(0.88 * bowl_r + 0.12 * f_val + bat_bonus, 0.0, 99.0), 2)
            elif bat_r is not None:
                overall_r = round(_clip(0.85 * bat_r + 0.15 * f_val, 0.0, 99.0), 2)
        else:
            # BATSMAN
            if bat_r is not None:
                bowl_bonus = ((bowl_r - 45.0) * 0.08) if bowl_r is not None else 0.0
                overall_r = round(_clip(0.88 * bat_r + 0.12 * f_val + bowl_bonus, 0.0, 99.0), 2)
            elif bowl_r is not None:
                overall_r = round(_clip(0.85 * bowl_r + 0.15 * f_val, 0.0, 99.0), 2)

    return {
        "player_id": cid,
        "external_key": meta["external_key"],
        "full_name": meta["full_name"],
        "playing_role": role,
        "is_overseas": meta["is_overseas"],
        "nationality": meta["nationality"],
        "scope_requested": scope,
        "scope_used": actual_scope,
        "model_version": RATING_MODEL_VERSION,
        "rating_type": "HISTORICAL_STATISTICAL_RATING",
        "disclaimer": RATING_DISCLOSURE,
        "allow_bidding_advice": False,
        "insufficient_sample": insufficient,
        "sample_matches": matches,
        "overall_rating": overall_r,
        "batting_rating": bat_r,
        "bowling_rating": bowl_r,
        "all_rounder_rating": all_rounder_r,
        "fielding_rating": field_r,
        "phase_ratings": _phase_ratings(row),
        "components": {
            "batting": bat_res,
            "bowling": bowl_res,
            "fielding": field_res,
        },
    }


def get_rating_leaderboard(
    role: Optional[str] = None,
    scope: Literal["CAREER", "RECENT_3_SEASONS"] = "CAREER",
    sort_by: Literal["overall_rating", "batting_rating", "bowling_rating", "all_rounder_rating", "fielding_rating"] = "overall_rating",
    min_matches: int = 10,
    limit: int = 25,
) -> List[Dict[str, Any]]:
    players, _ = load_players_index()
    entries: List[Dict[str, Any]] = []
    for cid, meta in players.items():
        if role and role != "ALL" and meta.get("playing_role") != role:
            continue
        rated = compute_player_rating(cid, scope=scope)
        if not rated or rated["insufficient_sample"]:
            continue
        if rated["sample_matches"] < min_matches:
            continue
        metric = rated.get(sort_by)
        if metric is None:
            continue
        entries.append({
            "player_id": rated["player_id"],
            "external_key": rated["external_key"],
            "full_name": rated["full_name"],
            "playing_role": rated["playing_role"],
            "is_overseas": rated["is_overseas"],
            "nationality": rated["nationality"],
            "scope_used": rated["scope_used"],
            "sample_matches": rated["sample_matches"],
            "overall_rating": rated["overall_rating"],
            "batting_rating": rated["batting_rating"],
            "bowling_rating": rated["bowling_rating"],
            "all_rounder_rating": rated["all_rounder_rating"],
            "fielding_rating": rated["fielding_rating"],
        })

    entries.sort(key=lambda x: (-(x.get(sort_by) or 0.0), -x["sample_matches"], x["full_name"]))
    return entries[:limit]
