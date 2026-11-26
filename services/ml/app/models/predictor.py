"""
Runtime inference service for validated Phase 6A cricket performance prediction models.
Enforces cutoff-safe features, historical coverage minimums, and non-bidding guardrails.
"""
import re
from pathlib import Path
from typing import Literal, Optional

import pandas as pd
from fastapi import HTTPException

from app.models.artifact_store import ARTIFACTS_DIR, load_model_artifact
from app.pipelines.feature_engineering import (
    BATTING_FEATURE_NAMES,
    BOWLING_FEATURE_NAMES,
    compute_cutoff_player_features,
    load_raw_tables,
)
from app.schemas.contracts import (
    MLModelKey,
    PerformancePredictionResponse,
    PredictionInterval,
)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def predict_performance(
    player_id: str,
    target: Literal["runs_per_match", "wickets_per_match"],
    cutoff_season: int,
    artifacts_dir: Path = ARTIFACTS_DIR,
) -> PerformancePredictionResponse:
    model_key = (
        MLModelKey.BATTING_PERFORMANCE_PRED
        if target == "runs_per_match"
        else MLModelKey.BOWLING_PERFORMANCE_PRED
    )

    try:
        model_obj, meta = load_model_artifact(model_key.value, base_dir=artifacts_dir)
    except FileNotFoundError:
        raise HTTPException(
            status_code=503,
            detail=f"Model '{model_key.value}' is unavailable or not trained yet.",
        )

    if not meta.get("is_trained") or not meta.get("is_validated"):
        raise HTTPException(
            status_code=503,
            detail=f"Model '{model_key.value}' has not passed chronological validation.",
        )

    players_by_id, seasons_by_player = load_raw_tables()
    q = player_id.strip()
    q_norm = _norm(q)

    matched_pid: Optional[str] = None
    if q in players_by_id:
        matched_pid = q
    else:
        for pid, pmeta in players_by_id.items():
            if pmeta.get("external_key") == q or _norm(pmeta["full_name"]) == q_norm:
                matched_pid = pid
                break

    if not matched_pid:
        raise HTTPException(status_code=404, detail=f"Player '{player_id}' not found in verified IPL registry.")

    pmeta = players_by_id[matched_pid]
    season_rows = seasons_by_player.get(matched_pid, [])
    feats = compute_cutoff_player_features(season_rows, pmeta, cutoff_season=cutoff_season)
    if feats is None or feats["prior_matches"] < 3:
        raise HTTPException(
            status_code=422,
            detail=f"Insufficient pre-{cutoff_season} IPL history for '{pmeta['full_name']}' (need >= 3 prior matches). Synthetic predictions are disabled.",
        )

    if target == "runs_per_match" and feats["prior_bat_innings"] < 2:
        raise HTTPException(
            status_code=422,
            detail=f"Insufficient pre-{cutoff_season} batting innings (< 2) for '{pmeta['full_name']}' to estimate runs_per_match.",
        )
    if target == "wickets_per_match" and feats["prior_bowl_innings"] < 2:
        raise HTTPException(
            status_code=422,
            detail=f"Insufficient pre-{cutoff_season} bowling innings (< 2) for '{pmeta['full_name']}' to estimate wickets_per_match.",
        )

    feature_names = BATTING_FEATURE_NAMES if target == "runs_per_match" else BOWLING_FEATURE_NAMES
    X_row = pd.DataFrame([{k: feats[k] for k in feature_names}])
    raw_pred = float(model_obj.predict(X_row)[0])
    pred_val = round(max(0.0, raw_pred), 3)

    holdout_metrics = meta.get("metrics") or {}
    rmse = float(holdout_metrics.get("rmse") or 0.0)
    mae = float(holdout_metrics.get("mae") or 0.0)
    lower = round(max(0.0, pred_val - rmse), 3)
    upper = round(pred_val + rmse, 3)

    return PerformancePredictionResponse(
        player_id=matched_pid,
        player_name=pmeta["full_name"],
        target=target,
        predicted_value=pred_val,
        unit="runs/match" if target == "runs_per_match" else "wickets/match",
        model_key=model_key,
        model_version=meta["version"],
        algorithm=meta["algorithm"],
        dataset_fingerprint=meta["dataset_fingerprint"],
        cutoff_season=cutoff_season,
        prior_seasons_used=int(feats["prior_seasons_count"]),
        prior_matches_used=int(feats["prior_matches"]),
        prediction_interval=PredictionInterval(
            lower_bound=lower,
            upper_bound=upper,
            basis=f"+/-1 Holdout RMSE ({rmse:.3f}); Holdout MAE={mae:.3f}",
        ),
        uncertainty_note=(
            f"Evaluated on 2024-2026 chronological holdout (RMSE={rmse:.3f}, MAE={mae:.3f}, "
            f"R2={holdout_metrics.get('r2', 0.0):.3f}). Cricket season averages carry natural playing-role variance."
        ),
        allow_bidding_advice=False,
    )
