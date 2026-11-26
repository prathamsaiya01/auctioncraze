from typing import Any, Dict, List, Optional
from app.models.rating_engine import compute_player_rating
from app.models.team_strength import _classify_bowl_arm_style
from app.pipelines.analytics_store import (
    get_player_meta,
    load_player_appearance_profiles,
    resolve_player_id,
)
from app.schemas.contracts import SquadPlayerInput

PLAYING_XI_VERSION = "1.0.0"
RULE_VERSION = "IPL_2023_IMPACT_PLAYER_RULES_V1"
PLAYING_XI_DISCLAIMER = (
    "PLAYING_XI_PREDICTION (IPL Playing XI + Impact Player simulation based on historical profiles; "
    "not an official franchise lineup and not bidding advice)"
)


def _batting_order_rank(p: Dict[str, Any]) -> float:
    if p["avg_batting_order"] is not None:
        return p["avg_batting_order"]
    role = p["playing_role"]
    if role == "BATSMAN":
        return 3.5
    if role == "WICKET_KEEPER":
        return 4.5
    if role == "ALL_ROUNDER":
        return 6.5
    return 9.5


def predict_playing_xi(
    room_id: str,
    franchise_code: str,
    squad: List[SquadPlayerInput],
    venue: Optional[str] = None,
    pitch_type: Optional[str] = None,
) -> Dict[str, Any]:
    app_profiles = load_player_appearance_profiles()
    pitch_norm = (pitch_type or "BALANCED").upper()

    candidates: List[Dict[str, Any]] = []
    seen = set()

    for item in squad:
        cid = resolve_player_id(item.player_id) or item.player_id
        if cid in seen:
            continue
        seen.add(cid)

        meta = get_player_meta(cid)
        rating = compute_player_rating(cid, scope="CAREER")
        app = app_profiles.get(cid, {})

        role = ((meta.get("playing_role") if meta else None) or item.playing_role or "BATSMAN").upper()
        if role not in ("BATSMAN", "BOWLER", "ALL_ROUNDER", "WICKET_KEEPER"):
            role = "BATSMAN"

        is_os = bool(item.is_overseas or (meta and meta.get("is_overseas")))
        bowl_cat = _classify_bowl_arm_style(meta.get("bowling_style") if meta else None)

        ovr = (rating.get("overall_rating") if rating else None) or 48.0
        bat_r = (rating.get("batting_rating") if rating else None) or 45.0
        bowl_r = (rating.get("bowling_rating") if rating else None)
        matches = (rating.get("sample_matches") if rating else 0) or 0

        is_bowler_opt = role in ("BOWLER", "ALL_ROUNDER") or (bowl_r is not None and bowl_r >= 52.0)

        # Apply subtle venue/pitch-type heuristic weighting (never inventing player stats)
        adj_score = float(ovr)
        if pitch_norm == "SPIN" and is_bowler_opt and bowl_cat == "SPIN":
            adj_score += 4.0
        elif pitch_norm == "PACE" and is_bowler_opt and bowl_cat == "PACE":
            adj_score += 4.0
        elif pitch_norm == "BATTING" and role in ("BATSMAN", "WICKET_KEEPER"):
            adj_score += 2.5

        candidates.append({
            "player_id": cid,
            "full_name": meta["full_name"] if meta else item.player_id,
            "playing_role": role,
            "is_overseas": is_os,
            "bowling_category": bowl_cat,
            "is_bowling_option": is_bowler_opt,
            "overall_rating": round(ovr, 2),
            "batting_rating": round(bat_r, 2) if rating and rating.get("batting_rating") is not None else None,
            "bowling_rating": round(bowl_r, 2) if bowl_r is not None else None,
            "selection_score": round(adj_score, 2),
            "sample_matches": matches,
            "avg_batting_order": app.get("avg_batting_order"),
            "impact_in_rate": app.get("impact_in_rate", 0.0),
        })

    if len(candidates) < 11:
        raise ValueError(
            f"Cannot select a Playing XI: squad for '{franchise_code}' has {len(candidates)} players (minimum 11 required)."
        )

    domestic_candidates = [c for c in candidates if not c["is_overseas"]]
    if len(domestic_candidates) < 7:
        raise ValueError(
            f"Cannot form a legal IPL Playing XI for '{franchise_code}': only {len(domestic_candidates)} domestic players "
            f"(minimum 7 domestic players required for max-4 overseas rule)."
        )

    # Greedy-exact role & constraint-guided XI assembly:
    # Step 1: Rank all candidates descending by selection_score
    ranked = sorted(candidates, key=lambda x: (-x["selection_score"], -x["sample_matches"], x["full_name"]))
    selected_ids = set()
    xi: List[Dict[str, Any]] = []

    def _can_add(p: Dict[str, Any]) -> bool:
        if p["player_id"] in selected_ids or len(xi) >= 11:
            return False
        current_os = sum(1 for x in xi if x["is_overseas"])
        if p["is_overseas"] and current_os >= 4:
            return False
        remaining_slots = 11 - len(xi) - 1
        # Ensure we don't accidentally violate domestic floor if somehow remaining domestic pool is tight
        return True

    def _add(p: Dict[str, Any]) -> bool:
        if not _can_add(p):
            return False
        xi.append(p)
        selected_ids.add(p["player_id"])
        return True

    # Mandatory Slot 1: Best Wicket-Keeper (if any in squad)
    wks = [c for c in ranked if c["playing_role"] == "WICKET_KEEPER"]
    if wks:
        _add(wks[0])

    # Mandatory Slots: At least 5 capable bowling options (preserving <= 4 overseas limit)
    bowl_opts = [c for c in ranked if c["is_bowling_option"] and c["player_id"] not in selected_ids]
    # Prefer top bowling options, ensuring >= 1 spinner and >= 2 pacers where available
    spinners = [b for b in bowl_opts if b["bowling_category"] == "SPIN"]
    pacers = [b for b in bowl_opts if b["bowling_category"] == "PACE"]
    if spinners:
        _add(spinners[0])
    for p in pacers[:2]:
        _add(p)

    # Reach at least 5 bowling options if feasible without violating <=4 OS
    for b in bowl_opts:
        if sum(1 for x in xi if x["is_bowling_option"]) >= 5:
            break
        _add(b)

    # Core Frontline Batters / Top All-Rounders to fill at least 6 batting-capable slots before tail
    bat_cores = [
        c for c in ranked
        if c["playing_role"] in ("BATSMAN", "WICKET_KEEPER", "ALL_ROUNDER")
        and c["player_id"] not in selected_ids
    ]
    for b in bat_cores:
        if len(xi) >= 9:
            break
        _add(b)

    # Fill remaining XI slots up to 11 with highest-rated legal candidates
    for c in ranked:
        if len(xi) >= 11:
            break
        _add(c)

    # Order Playing XI chronologically by typical T20 batting position
    xi_ordered = sorted(xi, key=lambda p: (_batting_order_rank(p), -p["selection_score"], p["full_name"]))

    # Impact Player selection (12th man from bench respecting IPL 4-OS limit across match)
    bench = [c for c in ranked if c["player_id"] not in selected_ids]
    xi_os_count = sum(1 for x in xi_ordered if x["is_overseas"])

    eligible_impact = [
        b for b in bench
        if (not b["is_overseas"]) or (xi_os_count < 4)
    ]

    impact_player: Optional[Dict[str, Any]] = None
    if eligible_impact:
        # Score impact sub candidates by selection_score + genuine historical Impact sub specialty
        impact_scored = sorted(
            eligible_impact,
            key=lambda b: (
                -(b["selection_score"] + (b["impact_in_rate"] * 12.0)),
                -b["sample_matches"],
                b["full_name"],
            ),
        )
        impact_player = impact_scored[0]

    # Captain & Vice-Captain from experience + overall rating
    captains = sorted(
        xi_ordered,
        key=lambda p: (
            -(p["overall_rating"] + min(12.0, p["sample_matches"] / 15.0) + (3.0 if not p["is_overseas"] else 0.0)),
            -p["sample_matches"],
        ),
    )
    captain = captains[0]
    vice_captain = captains[1]

    bowl_count_xi = sum(1 for x in xi_ordered if x["is_bowling_option"])
    wk_count_xi = sum(1 for x in xi_ordered if x["playing_role"] == "WICKET_KEEPER")
    explanation = [
        f"Selected {len(xi_ordered)} players respecting IPL max-4 overseas rule ({xi_os_count}/4 overseas in XI).",
        f"XI balance: {wk_count_xi} wicket-keeper(s), {bowl_count_xi} bowling options.",
    ]
    if impact_player:
        sub_rule = (
            "domestic-only Impact Player enforced because XI already uses all 4 overseas slots"
            if xi_os_count == 4
            else f"XI uses {xi_os_count}/4 overseas slots so bench overseas/domestic options were eligible"
        )
        explanation.append(
            f"Predicted Impact Player: {impact_player['full_name']} ({impact_player['playing_role']}) — {sub_rule}."
        )
    elif len(bench) == 0:
        explanation.append("No Impact Player predicted because squad size is exactly 11.")
    else:
        explanation.append(
            "No eligible Impact Player available on bench because XI already fields 4 overseas players and remaining bench has no domestic options."
        )

    if pitch_type or venue:
        explanation.append(f"Context applied: venue={venue or 'Neutral'}, pitch_type={pitch_norm}.")

    return {
        "room_id": room_id,
        "franchise_code": franchise_code,
        "model_version": PLAYING_XI_VERSION,
        "rule_version": RULE_VERSION,
        "is_prediction": True,
        "prediction_label": "Predicted Playing XI + Impact Player (simulation)",
        "overseas_count_in_xi": xi_os_count,
        "playing_xi": [p["player_id"] for p in xi_ordered],
        "playing_xi_details": [
            {
                "slot": idx + 1,
                "player_id": p["player_id"],
                "full_name": p["full_name"],
                "playing_role": p["playing_role"],
                "is_overseas": p["is_overseas"],
                "bowling_category": p["bowling_category"],
                "overall_rating": p["overall_rating"],
            }
            for idx, p in enumerate(xi_ordered)
        ],
        "impact_player": impact_player["player_id"] if impact_player else None,
        "impact_player_details": (
            {
                "player_id": impact_player["player_id"],
                "full_name": impact_player["full_name"],
                "playing_role": impact_player["playing_role"],
                "is_overseas": impact_player["is_overseas"],
                "overall_rating": impact_player["overall_rating"],
                "historical_impact_sub_rate": impact_player["impact_in_rate"],
            }
            if impact_player
            else None
        ),
        "captain_candidate": captain["player_id"],
        "captain_name": captain["full_name"],
        "vice_captain_candidate": vice_captain["player_id"],
        "vice_captain_name": vice_captain["full_name"],
        "explanation": explanation,
        "allow_bidding_advice": False,
        "disclaimer": PLAYING_XI_DISCLAIMER,
    }
