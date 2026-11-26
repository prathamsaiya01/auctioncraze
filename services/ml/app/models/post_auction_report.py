from typing import Any, Dict, List, Optional
from app.models.playing_xi import predict_playing_xi
from app.models.rating_engine import compute_player_rating
from app.models.team_strength import _classify_bowl_arm_style, analyze_team_strength
from app.pipelines.analytics_store import get_player_meta, resolve_player_id
from app.schemas.contracts import SquadPlayerInput

POST_AUCTION_REPORT_VERSION = "1.0.0"
POST_AUCTION_DISCLAIMER = (
    "POST_AUCTION_ANALYTICAL_REPORT (Derived from historical IPL player records, team_strength.py, "
    "rating_engine.py & playing_xi.py; NOT official IPL ratings and NO auction buying/retention recommendations)"
)

SCORE_METHODOLOGY_EXPLANATIONS: Dict[str, str] = {
    "overall_rating": "Role-weighted composite of Batting Strength (36%), Bowling Strength (36%), Pace/Spin Balance (12%), All-Rounder Strength (10%), and Fielding (6%), scaled by Wicketkeeper availability factor. Requires >=5 purchased/retained players and >=2 historically rated players.",
    "batting_strength": "Mean Bayesian-shrunk batting rating of top 7 batting options multiplied by starter coverage min(1.0, count/7). Extra bench batters beyond 7 do not inflate this score.",
    "bowling_strength": "Mean Bayesian-shrunk bowling rating of top 6 bowling options multiplied by 5-bowler coverage min(1.0, count/5). Extra reserve bowlers beyond 6 do not inflate this score.",
    "all_rounder_strength": "Mean all-rounder synergy rating across up to 3 top all-rounders scaled by min(1.0, count/2) so balanced dual-skill depth is captured fairly.",
    "squad_depth": "Reserve quality ratio comparing immediate backup batters (slots 8-9) and backup bowlers (slots 6-7) against starter quality, capped cleanly so larger squad headcount gives zero automatic bonus.",
    "pace_coverage": "Evaluates top pace bowling quality and availability toward a 3-pacer attack cap; extra pace depth beyond 3 options gives no count inflation.",
    "spin_coverage": "Evaluates top spin bowling quality and availability toward a 2-spinner attack cap.",
    "wicketkeeper_coverage": "Checks availability and batting quality of designated wicketkeepers (1 WK = primary coverage, >=2 WKs = full backup coverage, 0 WKs = 0.0 critical gap).",
    "role_balance": "Combines Pace/Spin attack ratio balance (optimal ~60/40 pace/spin) with structural presence of batters, bowlers, all-rounders, wicketkeepers, and left/right batting hand variety.",
    "overseas_composition": "Checks overseas slot usage against room overseas ceiling and Starting XI max-4 overseas rule compliance.",
}


def build_post_auction_franchise_report(
    room_id: str,
    franchise_code: str,
    squad: List[SquadPlayerInput],
    min_squad_size: int = 15,
    max_squad_size: int = 25,
    max_overseas_in_squad: int = 8,
) -> Dict[str, Any]:
    ts = analyze_team_strength(
        room_id=room_id,
        franchise_code=franchise_code,
        squad=squad,
        max_overseas_in_squad=max_overseas_in_squad,
    )

    rated_players: List[Dict[str, Any]] = []
    seen = set()
    pace_ratings: List[float] = []
    spin_ratings: List[float] = []
    bat_ratings_all: List[float] = []
    bowl_ratings_all: List[float] = []
    wk_bat_ratings: List[float] = []
    insufficient_sample_names: List[str] = []

    for item in squad:
        cid = resolve_player_id(item.player_id) or item.player_id
        if cid in seen:
            continue
        seen.add(cid)

        meta = get_player_meta(cid)
        rat = compute_player_rating(cid, scope="CAREER")
        role = ((meta.get("playing_role") if meta else None) or item.playing_role or "BATSMAN").upper()
        full_name = meta["full_name"] if meta else item.player_id
        is_os = bool(item.is_overseas or (meta and meta.get("is_overseas")))
        bowl_cat = _classify_bowl_arm_style(meta.get("bowling_style") if meta else None)

        ovr = rat.get("overall_rating") if rat else None
        bat_r = rat.get("batting_rating") if rat else None
        bowl_r = rat.get("bowling_rating") if rat else None
        ar_r = rat.get("all_rounder_rating") if rat else None
        fld_r = rat.get("fielding_rating") if rat else None
        matches = (rat.get("sample_matches") if rat else 0) or 0
        insuff = bool(not rat or rat.get("insufficient_sample"))

        if insuff:
            insufficient_sample_names.append(full_name)

        if bat_r is not None:
            bat_ratings_all.append(bat_r)
        if bowl_r is not None:
            bowl_ratings_all.append(bowl_r)
        if role == "WICKET_KEEPER":
            wk_bat_ratings.append(bat_r if bat_r is not None else 48.0)

        is_bowler_type = role in ("BOWLER", "ALL_ROUNDER") or (bowl_r is not None)
        if is_bowler_type:
            b_val = bowl_r if bowl_r is not None else 48.0
            if bowl_cat == "PACE":
                pace_ratings.append(b_val)
            elif bowl_cat == "SPIN":
                spin_ratings.append(b_val)

        rated_players.append({
            "player_id": cid,
            "full_name": full_name,
            "playing_role": role,
            "is_overseas": is_os,
            "bowling_category": bowl_cat,
            "sample_matches": matches,
            "insufficient_sample": insuff,
            "overall_rating": ovr,
            "batting_rating": bat_r,
            "bowling_rating": bowl_r,
            "all_rounder_rating": ar_r,
            "fielding_rating": fld_r,
        })

    squad_size = len(rated_players)
    rated_valid_count = sum(1 for p in rated_players if not p["insufficient_sample"])
    comp = ts["composition"]
    os_count = ts["overseas_count"]
    dom_count = max(0, squad_size - os_count)

    # Sufficiency & confidence assessment (no forced ratings for < 5 players)
    warnings: List[str] = []
    if squad_size == 0:
        sufficiency_status = "NO_PLAYERS"
        has_sufficient_data = False
        warnings.append("No players purchased or retained by this franchise.")
    elif squad_size < 5 or rated_valid_count < 2:
        sufficiency_status = "INSUFFICIENT_DATA"
        has_sufficient_data = False
        warnings.append(
            f"Only {squad_size} player(s) ({rated_valid_count} historically rated); minimum 5 players and 2 rated profiles required for comparative team rating."
        )
    elif squad_size < min_squad_size:
        sufficiency_status = "INCOMPLETE_SQUAD"
        has_sufficient_data = True
        warnings.append(
            f"Incomplete squad ({squad_size}/{min_squad_size} minimum slots): scores reflect actual purchased/retained players only."
        )
    else:
        sufficiency_status = "SUFFICIENT"
        has_sufficient_data = True

    if insufficient_sample_names:
        warnings.append(
            f"{len(insufficient_sample_names)} squad player(s) have <5 verified IPL matches and retain null statistical ratings ({', '.join(insufficient_sample_names[:4])}{'...' if len(insufficient_sample_names) > 4 else ''})."
        )

    rated_ratio = (rated_valid_count / squad_size) if squad_size > 0 else 0.0
    if squad_size == 0 or rated_valid_count < 2:
        data_confidence = "LOW"
    elif rated_ratio >= 0.75 and squad_size >= 11:
        data_confidence = "HIGH"
    elif rated_ratio >= 0.45 and squad_size >= 5:
        data_confidence = "MEDIUM"
    else:
        data_confidence = "LOW"

    # Capped starter/backup role metrics (never reward bench size above core rotation)
    top_pace = sorted(pace_ratings, reverse=True)[:3]
    pace_coverage = (
        round(min(99.0, (sum(top_pace) / len(top_pace)) * (0.45 + 0.55 * min(1.0, len(top_pace) / 3.0))), 2)
        if top_pace
        else 0.0
    )

    top_spin = sorted(spin_ratings, reverse=True)[:2]
    spin_coverage = (
        round(min(99.0, (sum(top_spin) / len(top_spin)) * (0.45 + 0.55 * min(1.0, len(top_spin) / 2.0))), 2)
        if top_spin
        else 0.0
    )

    wk_cnt = len(wk_bat_ratings)
    if wk_cnt == 0:
        wk_coverage = 0.0
    elif wk_cnt == 1:
        wk_coverage = round(min(92.0, 0.75 * max(wk_bat_ratings) + 22.0), 2)
    else:
        top2_wk = sorted(wk_bat_ratings, reverse=True)[:2]
        wk_coverage = round(min(99.0, 0.75 * (sum(top2_wk) / 2.0) + 28.0), 2)

    # Squad depth: measures immediate reserve core (batters #8-9, bowlers #6-7) rather than raw count
    bat_sorted = sorted(bat_ratings_all, reverse=True)
    bowl_sorted = sorted(bowl_ratings_all, reverse=True)
    backup_bat = bat_sorted[7:9]
    backup_bowl = bowl_sorted[5:7]
    backup_scores = backup_bat + backup_bowl
    if squad_size < 5:
        squad_depth = 0.0
    elif not backup_scores:
        # 5-11 players: starter core exists without reserves
        squad_depth = round(min(65.0, (ts["batting_depth"] + ts["bowling_depth"]) * 0.42), 2)
    else:
        backup_cov = min(1.0, len(backup_scores) / 3.0)
        squad_depth = round(min(99.0, (sum(backup_scores) / len(backup_scores)) * (0.60 + 0.40 * backup_cov)), 2)

    # Role balance: pace/spin balance + core roles coverage
    core_checks = sum([
        1 if comp.get("BATSMAN", 0) >= 3 else 0,
        1 if comp.get("BOWLER", 0) >= 3 else 0,
        1 if comp.get("ALL_ROUNDER", 0) >= 2 else 0,
        1 if wk_cnt >= 1 else 0,
        1 if comp.get("pace_bowlers", 0) >= 2 else 0,
        1 if comp.get("spin_bowlers", 0) >= 1 else 0,
        1 if comp.get("left_hand_batters", 0) >= 1 else 0,
    ])
    structural_score = (core_checks / 7.0) * 100.0
    role_balance = round(0.45 * ts["pace_spin_balance"] + 0.55 * structural_score, 2) if squad_size > 0 else 0.0

    # Best-rated role leaders
    best_batters = sorted(
        [p for p in rated_players if p["batting_rating"] is not None],
        key=lambda x: (-x["batting_rating"], -x["sample_matches"], x["full_name"]),
    )[:3]
    best_bowlers = sorted(
        [p for p in rated_players if p["bowling_rating"] is not None],
        key=lambda x: (-x["bowling_rating"], -x["sample_matches"], x["full_name"]),
    )[:3]
    best_all_rounders = sorted(
        [
            p for p in rated_players
            if p["all_rounder_rating"] is not None or (p["playing_role"] == "ALL_ROUNDER" and p["overall_rating"] is not None)
        ],
        key=lambda x: (-(x["all_rounder_rating"] or x["overall_rating"] or 0.0), -x["sample_matches"], x["full_name"]),
    )[:3]

    # Playing XI + Impact Player Prediction (clearly labelled prediction)
    try:
        xi_res = predict_playing_xi(
            room_id=room_id,
            franchise_code=franchise_code,
            squad=squad,
        )
        playing_xi_section: Dict[str, Any] = {
            "available": True,
            **xi_res,
        }
    except ValueError as exc:
        playing_xi_section = {
            "available": False,
            "is_prediction": True,
            "prediction_label": "Predicted Playing XI + Impact Player (unavailable — incomplete roster)",
            "reason": str(exc),
            "playing_xi": [],
            "playing_xi_details": [],
            "impact_player": None,
            "impact_player_details": None,
            "allow_bidding_advice": False,
        }

    overall_rating: Optional[float] = ts["overall_strength"] if has_sufficient_data else None

    return {
        "room_id": room_id,
        "franchise_code": franchise_code,
        "model_version": POST_AUCTION_REPORT_VERSION,
        "is_official_rating": False,
        "allow_bidding_advice": False,
        "disclaimer": POST_AUCTION_DISCLAIMER,
        "sufficiency_status": sufficiency_status,
        "has_sufficient_data": has_sufficient_data,
        "data_confidence": data_confidence,
        "sample_size_warnings": warnings,
        "squad_size": squad_size,
        "min_squad_size": min_squad_size,
        "max_squad_size": max_squad_size,
        "rated_players_count": rated_valid_count,
        "team_ratings": {
            "overall_rating": overall_rating,
            "batting_strength": ts["batting_depth"] if squad_size > 0 else 0.0,
            "bowling_strength": ts["bowling_depth"] if squad_size > 0 else 0.0,
            "all_rounder_strength": ts["all_rounder_index"] if squad_size > 0 else 0.0,
            "squad_depth": squad_depth,
            "pace_coverage": pace_coverage,
            "spin_coverage": spin_coverage,
            "wicketkeeper_coverage": wk_coverage,
            "role_balance": role_balance,
            "fielding_index": ts["fielding_index"] if squad_size > 0 else 0.0,
            "pace_spin_balance": ts["pace_spin_balance"] if squad_size > 0 else 0.0,
        },
        "overseas_composition": {
            "overseas_count": os_count,
            "domestic_count": dom_count,
            "max_overseas": max_overseas_in_squad,
            "compliant": ts["overseas_compliance"],
            "overseas_share_pct": round((os_count / squad_size) * 100.0, 1) if squad_size > 0 else 0.0,
        },
        "composition": comp,
        "score_explanations": SCORE_METHODOLOGY_EXPLANATIONS,
        "best_batters": best_batters,
        "best_bowlers": best_bowlers,
        "best_all_rounders": best_all_rounders,
        "strengths": ts["strengths"],
        "weaknesses": ts["gaps"],
        "playing_xi_prediction": playing_xi_section,
    }
