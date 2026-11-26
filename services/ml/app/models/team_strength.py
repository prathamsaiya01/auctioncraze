from typing import Any, Dict, List
from app.models.rating_engine import compute_player_rating
from app.pipelines.analytics_store import get_player_meta, resolve_player_id
from app.schemas.contracts import SquadPlayerInput

TEAM_STRENGTH_VERSION = "1.0.0"
TEAM_STRENGTH_DISCLAIMER = (
    "SQUAD_COMPOSITION_ANALYTICS (Historical player performance profiles & structural squad audit only; "
    "no auction bidding, valuation, or purchasing advice)"
)


def _classify_bowl_arm_style(bowling_style: str | None) -> str:
    if not bowling_style:
        return "UNKNOWN"
    s = bowling_style.upper()
    if "SPIN" in s or "ORTHODOX" in s or "CHINAMAN" in s or "LEG" in s or "OFF" in s:
        return "SPIN"
    if "FAST" in s or "MEDIUM" in s or "SEAM" in s or "PACE" in s:
        return "PACE"
    return "UNKNOWN"


def analyze_team_strength(
    room_id: str,
    franchise_code: str,
    squad: List[SquadPlayerInput],
    max_overseas_in_squad: int = 8,
) -> Dict[str, Any]:
    resolved_players: List[Dict[str, Any]] = []
    seen_ids = set()

    role_counts = {
        "BATSMAN": 0,
        "BOWLER": 0,
        "ALL_ROUNDER": 0,
        "WICKET_KEEPER": 0,
    }
    pace_count = 0
    spin_count = 0
    overseas_count = 0
    lhb_count = 0
    rhb_count = 0

    bat_scores: List[float] = []
    bowl_scores: List[float] = []
    ar_scores: List[float] = []
    field_scores: List[float] = []
    overall_scores: List[float] = []
    death_bat_capable = 0
    death_bowl_capable = 0
    pp_bowl_capable = 0

    for item in squad:
        cid = resolve_player_id(item.player_id) or item.player_id
        if cid in seen_ids:
            continue
        seen_ids.add(cid)

        meta = get_player_meta(cid)
        rating = compute_player_rating(cid, scope="CAREER")

        role = (meta.get("playing_role") if meta else None) or item.playing_role or "BATSMAN"
        role = role.upper()
        if role not in role_counts:
            role = "BATSMAN"
        role_counts[role] += 1

        is_os = bool(item.is_overseas or (meta and meta.get("is_overseas")))
        if is_os:
            overseas_count += 1

        b_style = meta.get("bowling_style") if meta else None
        bowl_cat = _classify_bowl_arm_style(b_style)
        is_bowler_type = role in ("BOWLER", "ALL_ROUNDER") or (rating and rating.get("bowling_rating") is not None)
        if is_bowler_type:
            if bowl_cat == "PACE":
                pace_count += 1
            elif bowl_cat == "SPIN":
                spin_count += 1

        bat_hand = (meta.get("batting_style") if meta else "") or ""
        if "LEFT" in bat_hand.upper():
            lhb_count += 1
        elif "RIGHT" in bat_hand.upper():
            rhb_count += 1

        if rating:
            bat_r = rating.get("batting_rating")
            bowl_r = rating.get("bowling_rating")
            ar_r = rating.get("all_rounder_rating")
            fld_r = rating.get("fielding_rating")
            ovr_r = rating.get("overall_rating")
            phases = rating.get("phase_ratings") or {}

            if bat_r is not None:
                bat_scores.append(bat_r)
            elif role in ("BATSMAN", "WICKET_KEEPER", "ALL_ROUNDER"):
                bat_scores.append(48.0)

            if bowl_r is not None:
                bowl_scores.append(bowl_r)
            elif role in ("BOWLER", "ALL_ROUNDER"):
                bowl_scores.append(48.0)

            if ar_r is not None and role == "ALL_ROUNDER":
                ar_scores.append(ar_r)
            elif role == "ALL_ROUNDER" and ovr_r is not None:
                ar_scores.append(round(ovr_r * 0.85, 2))

            if fld_r is not None:
                field_scores.append(fld_r)
            if ovr_r is not None:
                overall_scores.append(ovr_r)

            if (phases.get("bat_death") or 0.0) >= 54.0:
                death_bat_capable += 1
            if (phases.get("bowl_death") or 0.0) >= 54.0:
                death_bowl_capable += 1
            if (phases.get("bowl_powerplay") or 0.0) >= 54.0:
                pp_bowl_capable += 1

        resolved_players.append({
            "player_id": cid,
            "full_name": meta["full_name"] if meta else item.player_id,
            "playing_role": role,
            "is_overseas": is_os,
            "bowling_category": bowl_cat,
            "overall_rating": rating.get("overall_rating") if rating else None,
        })

    squad_size = len(resolved_players)
    if squad_size == 0:
        return {
            "room_id": room_id,
            "franchise_code": franchise_code,
            "model_version": TEAM_STRENGTH_VERSION,
            "squad_size": 0,
            "overall_strength": 0.0,
            "batting_depth": 0.0,
            "bowling_depth": 0.0,
            "pace_spin_balance": 0.0,
            "all_rounder_index": 0.0,
            "fielding_index": 0.0,
            "overseas_count": 0,
            "overseas_compliance": True,
            "wicket_keeper_count": 0,
            "composition": {
                **role_counts,
                "pace_bowlers": 0,
                "spin_bowlers": 0,
                "left_hand_batters": 0,
                "right_hand_batters": 0,
                "death_bat_options": 0,
                "death_bowl_options": 0,
                "powerplay_bowl_options": 0,
            },
            "strengths": [],
            "gaps": ["No squad players recorded yet."],
            "allow_bidding_advice": False,
            "disclaimer": TEAM_STRENGTH_DISCLAIMER,
        }

    # Batting depth considers quality of top 7 batters + volume up to 7 frontline batters
    top_bat = sorted(bat_scores, reverse=True)[:7]
    bat_avg_q = sum(top_bat) / len(top_bat) if top_bat else 45.0
    bat_cov = min(1.0, len(top_bat) / 7.0)
    batting_depth = round(min(99.0, bat_avg_q * (0.55 + 0.45 * bat_cov)), 2)

    # Bowling depth considers quality of top 5-6 bowlers + coverage toward 5 specialist/AR bowling options
    top_bowl = sorted(bowl_scores, reverse=True)[:6]
    bowl_avg_q = sum(top_bowl) / len(top_bowl) if top_bowl else 45.0
    bowl_cov = min(1.0, len(top_bowl) / 5.0)
    bowling_depth = round(min(99.0, bowl_avg_q * (0.50 + 0.50 * bowl_cov)), 2)

    # Pace-Spin Balance (optimal around 60% pace / 40% spin with >=2 of each)
    total_classed = pace_count + spin_count
    if total_classed == 0:
        pace_spin_balance = 0.0
    else:
        pace_share = pace_count / total_classed
        spin_share = spin_count / total_classed
        dist_from_ideal = abs(pace_share - 0.60)
        coverage_bonus = min(1.0, min(pace_count, 3) / 3.0 * 0.6 + min(spin_count, 2) / 2.0 * 0.4)
        pace_spin_balance = round(max(10.0, min(98.0, (92.0 - dist_from_ideal * 95.0) * (0.55 + 0.45 * coverage_bonus))), 2)

    # All-rounder index combines quality + depth (target >= 2 quality ARs)
    if ar_scores:
        ar_top = sorted(ar_scores, reverse=True)[:3]
        ar_cov = min(1.0, len(ar_top) / 2.0)
        all_rounder_index = round(min(99.0, (sum(ar_top) / len(ar_top)) * (0.65 + 0.35 * ar_cov)), 2)
    else:
        all_rounder_index = 25.0

    fielding_index = round(sum(field_scores) / len(field_scores), 2) if field_scores else 50.0
    wk_count = role_counts["WICKET_KEEPER"]
    wk_factor = 1.0 if wk_count >= 2 else (0.94 if wk_count == 1 else 0.80)

    raw_ovr = (
        0.36 * batting_depth
        + 0.36 * bowling_depth
        + 0.12 * pace_spin_balance
        + 0.10 * all_rounder_index
        + 0.06 * fielding_index
    ) * wk_factor
    overall_strength = round(min(99.0, max(0.0, raw_ovr)), 2)
    overseas_compliance = overseas_count <= max_overseas_in_squad

    strengths: List[str] = []
    gaps: List[str] = []

    if batting_depth >= 65.0 and len(top_bat) >= 6:
        strengths.append(f"Deep top-7 batting unit ({len(top_bat)} viable batters averaging {bat_avg_q:.1f} rating).")
    if bowling_depth >= 62.0 and len(top_bowl) >= 5:
        strengths.append(f"Well-covered bowling attack ({len(top_bowl)} options, {pace_count} pace / {spin_count} spin).")
    if role_counts["ALL_ROUNDER"] >= 3 and all_rounder_index >= 58.0:
        strengths.append(f"Strong multi-dimensional balance with {role_counts['ALL_ROUNDER']} all-rounders.")
    if lhb_count >= 2 and rhb_count >= 3:
        strengths.append(f"Good left-right batting hand variety ({lhb_count} LHB, {rhb_count} RHB).")
    if wk_count >= 2:
        strengths.append(f"Secure wicket-keeping depth ({wk_count} wicket-keepers).")
    if death_bowl_capable >= 2:
        strengths.append(f"Established death-overs bowling experience ({death_bowl_capable} qualified options).")

    if squad_size < 11:
        gaps.append(f"Squad currently has {squad_size} players (minimum 11 required for a full Playing XI).")
    if not overseas_compliance:
        gaps.append(f"Overseas limit exceeded ({overseas_count}/{max_overseas_in_squad}).")
    if wk_count == 0:
        gaps.append("No designated wicket-keeper currently in squad.")
    elif wk_count == 1:
        gaps.append("Single wicket-keeper in squad leaves no backup option.")
    if len(top_bowl) < 5:
        gaps.append(f"Fewer than 5 established bowling options ({len(top_bowl)} identified).")
    if spin_count < 2:
        gaps.append(f"Limited frontline spin depth ({spin_count} spin option(s) identified).")
    if pace_count < 3:
        gaps.append(f"Limited frontline pace depth ({pace_count} pace option(s) identified).")
    if lhb_count == 0 and squad_size >= 6:
        gaps.append("All right-handed batting lineup lacks left-handed matchup variation.")

    return {
        "room_id": room_id,
        "franchise_code": franchise_code,
        "model_version": TEAM_STRENGTH_VERSION,
        "squad_size": squad_size,
        "overall_strength": overall_strength,
        "batting_depth": batting_depth,
        "bowling_depth": bowling_depth,
        "pace_spin_balance": pace_spin_balance,
        "all_rounder_index": all_rounder_index,
        "fielding_index": fielding_index,
        "overseas_count": overseas_count,
        "overseas_compliance": overseas_compliance,
        "wicket_keeper_count": wk_count,
        "composition": {
            **role_counts,
            "pace_bowlers": pace_count,
            "spin_bowlers": spin_count,
            "left_hand_batters": lhb_count,
            "right_hand_batters": rhb_count,
            "death_bat_options": death_bat_capable,
            "death_bowl_options": death_bowl_capable,
            "powerplay_bowl_options": pp_bowl_capable,
        },
        "strengths": strengths,
        "gaps": gaps,
        "allow_bidding_advice": False,
        "disclaimer": TEAM_STRENGTH_DISCLAIMER,
    }
