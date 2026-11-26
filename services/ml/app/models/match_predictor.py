from functools import lru_cache
from typing import Any, Dict, List, Optional
import numpy as np

from app.models.artifact_store import ARTIFACTS_DIR, load_model_artifact
from app.pipelines.analytics_store import resolve_player_id
from app.pipelines.train_match_model import (
    MATCH_FEATURE_NAMES,
    SequentialMatchState,
    build_chronological_match_dataset,
)


@lru_cache(maxsize=1)
def _load_match_bundle_and_state() -> tuple[Any, Dict[str, Any], SequentialMatchState]:
    bundle, meta = load_model_artifact("MATCH_PRED", base_dir=ARTIFACTS_DIR)
    if not meta.get("is_validated"):
        raise RuntimeError("MATCH_PRED artifact exists but failed chronological validation.")
    _, current_state = build_chronological_match_dataset()
    return bundle, meta, current_state


def _get_known_venues(state: SequentialMatchState) -> List[str]:
    return sorted({v for v in state.venue_chase_games.keys() if v})


def _get_team_elo_snapshot(state: SequentialMatchState) -> Dict[str, float]:
    return {k: round(v, 1) for k, v in sorted(state.elo.items())}


def predict_match_outcome(
    home_franchise_code: str,
    away_franchise_code: str,
    venue: str,
    home_xi: Optional[List[str]] = None,
    away_xi: Optional[List[str]] = None,
    toss_winner: Optional[str] = None,
    toss_decision: Optional[str] = None,
) -> Dict[str, Any]:
    home = home_franchise_code.strip().upper()
    away = away_franchise_code.strip().upper()
    if home == away:
        raise ValueError("home_franchise_code and away_franchise_code must be distinct franchises.")

    bundle, meta, state = _load_match_bundle_and_state()
    model = bundle["model"]

    resolved_home_xi = [r for p in (home_xi or []) if (r := resolve_player_id(p))]
    resolved_away_xi = [r for p in (away_xi or []) if (r := resolve_player_id(p))]

    feats_fwd = state.extract_features(
        team1=home,
        team2=away,
        season=2027,
        team1_xi=resolved_home_xi,
        team2_xi=resolved_away_xi,
    )
    feats_rev = state.extract_features(
        team1=away,
        team2=home,
        season=2027,
        team1_xi=resolved_away_xi,
        team2_xi=resolved_home_xi,
    )

    X_fwd = np.array([[feats_fwd[k] for k in MATCH_FEATURE_NAMES]], dtype=float)
    X_rev = np.array([[feats_rev[k] for k in MATCH_FEATURE_NAMES]], dtype=float)

    p_fwd = float(model.predict_proba(X_fwd)[0, 1])
    p_rev = float(model.predict_proba(X_rev)[0, 1])
    p_home = max(0.01, min(0.99, 0.5 * (p_fwd + (1.0 - p_rev))))
    p_away = 1.0 - p_home

    home_elo = round(state.elo[home], 1)
    away_elo = round(state.elo[away], 1)
    venue_games = state.venue_chase_games.get(venue, 0)
    venue_chase_wr = (
        round((state.venue_chase_wins.get(venue, 0) / venue_games) * 100.0, 1)
        if venue_games > 0
        else None
    )

    key_factors: List[str] = [
        f"Chronological pre-match Elo: {home} ({home_elo}) vs {away} ({away_elo})."
    ]
    if resolved_home_xi and resolved_away_xi:
        ovr1, bat1, bowl1 = state.compute_xi_strengths(resolved_home_xi, before_season=2027)
        ovr2, bat2, bowl2 = state.compute_xi_strengths(resolved_away_xi, before_season=2027)
        key_factors.append(
            f"Playing XI historical index ({len(resolved_home_xi)} vs {len(resolved_away_xi)}): "
            f"{home} {ovr1:.1f} (Bat {bat1:.1f}, Bowl {bowl1:.1f}) vs "
            f"{away} {ovr2:.1f} (Bat {bat2:.1f}, Bowl {bowl2:.1f})."
        )
    else:
        key_factors.append("Playing XI lineup strength defaulted to neutral (provide 11 players per side to include XI impact).")

    if abs(feats_fwd["cycle_form_diff"]) >= 0.08:
        leader = home if feats_fwd["cycle_form_diff"] > 0 else away
        key_factors.append(f"Recent auction-cycle IPL win rate favors {leader}.")

    if venue_chase_wr is not None:
        key_factors.append(f"Venue context ({venue}): chasing teams won {venue_chase_wr}% across {venue_games} recorded IPL matches.")
    else:
        key_factors.append(f"Venue context ({venue}): no historical IPL match sample recorded (neutral venue context).")

    tw = toss_winner.strip().upper() if toss_winner else None
    td = toss_decision.strip().lower() if toss_decision else None
    if tw in (home, away) and td:
        key_factors.append(f"Recorded toss choice: {tw} opted to {td} (model keeps win probabilities neutral to Cricsheet team order).")

    return {
        "home_franchise_code": home,
        "away_franchise_code": away,
        "venue": venue,
        "model_key": "MATCH_PRED",
        "model_version": meta["version"],
        "selected_candidate": meta.get("selected_candidate"),
        "dataset_fingerprint": meta.get("dataset_fingerprint"),
        "home_win_probability": round(p_home, 4),
        "away_win_probability": round(p_away, 4),
        "calibrated": True,
        "is_prediction": True,
        "key_factors": key_factors,
        "feature_breakdown": feats_fwd,
        "holdout_metrics": meta.get("metrics"),
        "allow_bidding_advice": False,
        "disclaimer": (
            "PROBABILISTIC_MATCH_FORECAST (Trained chronologically 2009-2023 and evaluated on 2024-2026 holdout; "
            "T20 cricket has substantial match-day variance. No bidding advice)."
        ),
    }


def get_match_predictor_metadata() -> Dict[str, Any]:
    _, meta, state = _load_match_bundle_and_state()
    return {
        "model_version": meta["version"],
        "venues": _get_known_venues(state),
        "team_elo": _get_team_elo_snapshot(state),
        "teams": sorted(state.elo.keys()),
    }
