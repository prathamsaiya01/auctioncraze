import hmac
import os
from pathlib import Path
from typing import Literal, Optional
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query

from app.models.match_predictor import get_match_predictor_metadata, predict_match_outcome
from app.models.playing_xi import predict_playing_xi
from app.models.predictor import predict_performance
from app.models.rating_engine import compute_player_rating, get_rating_leaderboard
from app.models.registry import ModelRegistry
from app.models.team_strength import analyze_team_strength
from app.pipelines.analytics_store import (
    get_player_advanced_stats,
    get_player_meta,
    resolve_player_id,
)
from app.pipelines.data_audit import compute_dataset_fingerprint, run_data_audit
from app.pipelines.dataset_loader import (
    load_player_feature_vectors,
    load_provenance_manifest,
)
from app.schemas.contracts import (
    DatasetProvenanceResponse,
    GuardrailPolicy,
    MLModelKey,
    MatchPredictionRequest,
    MatchPredictionResponse,
    PerformancePredictionRequest,
    PerformancePredictionResponse,
    PlayerFeatureVector,
    PlayerRatingRequest,
    PlayerRatingResponse,
    PlayingXIRequest,
    PlayingXIResponse,
    PostMatchAnalysisRequest,
    TeamStrengthRequest,
    TeamStrengthResponse,
)

# Load root .env when started standalone without inheriting parent env
_ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"
if _ROOT_ENV.exists():
    for _line in _ROOT_ENV.read_text(encoding="utf-8").splitlines():
        _stripped = _line.strip()
        if _stripped and not _stripped.startswith("#") and "=" in _stripped:
            _k, _v = _stripped.split("=", 1)
            _k = _k.strip()
            _v = _v.strip().strip('"').strip("'")
            if _k == "INTERNAL_ML_SERVICE_KEY" and _k not in os.environ:
                os.environ[_k] = _v


def require_internal_key(
    x_internal_key: Optional[str] = Header(default=None, alias="X-Internal-Service-Key")
) -> None:
    expected = os.environ.get("INTERNAL_ML_SERVICE_KEY", "").strip()
    if len(expected) < 32:
        raise HTTPException(
            status_code=503,
            detail="Internal ML service authentication secret is not configured (failing closed).",
        )
    if not x_internal_key or not hmac.compare_digest(x_internal_key, expected):
        raise HTTPException(
            status_code=401,
            detail="Unauthorized: valid X-Internal-Service-Key header is required.",
        )


app = FastAPI(
    title="AuctionCraze Internal ML Intelligence Service",
    version="0.2.0",
    description="Internal cricket intelligence service. Not directly public.",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

registry = ModelRegistry()


def _require_trained(key: MLModelKey) -> None:
    meta = registry.get(key)
    if not meta.is_trained or not meta.is_validated:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Model '{key.value}' is unavailable or not yet trained/validated (version: {meta.version}). "
                "Synthetic or unvalidated predictions are disabled."
            ),
        )


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "auctioncraze-ml",
        "allow_bidding_advice": GuardrailPolicy.ALLOW_BIDDING_ADVICE,
    }


v1 = APIRouter(prefix="/v1", dependencies=[Depends(require_internal_key)])


@v1.get("/models/health")
def models_health():
    models = registry.list_models()
    return {
        "status": "ok",
        "dataset_fingerprint": compute_dataset_fingerprint(),
        "allow_bidding_advice": GuardrailPolicy.ALLOW_BIDDING_ADVICE,
        "trained_count": sum(1 for v in models.values() if v.is_trained and v.is_validated),
        "untrained_count": sum(1 for v in models.values() if not (v.is_trained and v.is_validated)),
        "models": {
            k.value: {
                "version": v.version,
                "is_trained": v.is_trained,
                "is_validated": v.is_validated,
                "algorithm": v.algorithm,
            }
            for k, v in models.items()
        },
    }


@v1.get("/models")
def list_models():
    sanitized = []
    for v in registry.list_models().values():
        d = v.model_dump()
        d.pop("artifact_path", None)
        sanitized.append(d)
    return {
        "policy": {
            "allow_bidding_advice": GuardrailPolicy.ALLOW_BIDDING_ADVICE,
            "allow_purchase_pricing_advice": GuardrailPolicy.ALLOW_PURCHASE_PRICING_ADVICE,
            "require_verified_training_data": GuardrailPolicy.REQUIRE_VERIFIED_TRAINING_DATA,
        },
        "models": sanitized,
    }


@v1.get("/models/{model_key}/versions")
def get_model_versions(model_key: MLModelKey):
    versions = [
        {k: v for k, v in ver.items() if k != "artifact_path"}
        for ver in registry.list_versions(model_key)
    ]
    meta = registry.get(model_key)
    return {
        "model_key": model_key.value,
        "active_version": meta.version,
        "is_trained": meta.is_trained,
        "versions": versions,
    }


@v1.get("/models/{model_key}/evaluation")
def get_model_evaluation(model_key: MLModelKey):
    versions = registry.list_versions(model_key)
    if not versions:
        meta = registry.get(model_key)
        raise HTTPException(
            status_code=503,
            detail=f"No evaluation metrics available: model '{model_key.value}' is untrained (version: {meta.version}).",
        )
    latest = versions[0]
    return {
        "model_key": model_key.value,
        "version": latest["version"],
        "selected_candidate": latest.get("selected_candidate"),
        "algorithm": latest["algorithm"],
        "dataset_fingerprint": latest.get("dataset_fingerprint"),
        "train_split": latest.get("train_split"),
        "validation_split": latest.get("validation_split"),
        "test_split": latest.get("test_split"),
        "sample_counts": latest.get("sample_counts"),
        "validation_metrics": latest.get("validation_metrics"),
        "holdout_metrics": latest.get("metrics"),
        "baseline_comparisons": latest.get("baseline_comparisons"),
        "top_features": latest.get("top_features"),
        "limitations": latest.get("limitations"),
        "is_validated": latest.get("is_validated"),
    }


@v1.get("/audit/data-quality")
def get_data_quality_audit():
    return run_data_audit(write_report=False)


@v1.get("/datasets/provenance", response_model=DatasetProvenanceResponse)
def get_dataset_provenance():
    manifest = load_provenance_manifest()
    counts = manifest["counts"]
    return DatasetProvenanceResponse(
        total_players=counts["totalPlayers"],
        total_player_seasons=counts["totalPlayerSeasons"],
        seasons_covered=counts["seasonsCovered"],
        with_verified_nationality=counts["withVerifiedNationality"],
        with_verified_photo_url=counts["withVerifiedPhotoUrl"],
        with_verified_dob=counts["withVerifiedDob"],
        sources=manifest["sources"],
        bidding_advice_enabled=False,
    )


@v1.get("/features/player/{cricsheet_id}", response_model=PlayerFeatureVector)
def get_player_features(cricsheet_id: str, cutoff_season: int | None = None):
    features = load_player_feature_vectors(cutoff_season=cutoff_season)
    if cricsheet_id not in features:
        raise HTTPException(status_code=404, detail=f"No historical IPL features found for '{cricsheet_id}'")
    return PlayerFeatureVector(**features[cricsheet_id])


@v1.post("/predictions/performance", response_model=PerformancePredictionResponse)
def predict_player_performance(req: PerformancePredictionRequest):
    return predict_performance(
        player_id=req.player_id,
        target=req.target,
        cutoff_season=req.cutoff_season,
    )


@v1.get("/analytics/players/{player_id}")
def get_player_analytics(player_id: str, scope: str = Query(default="CAREER")):
    cid = resolve_player_id(player_id)
    if not cid:
        raise HTTPException(status_code=404, detail=f"Player '{player_id}' not found in verified IPL dataset.")
    meta = get_player_meta(cid)
    scopes = get_player_advanced_stats(cid)
    if not meta or not scopes:
        raise HTTPException(status_code=404, detail=f"No ball-by-ball analytics available for '{player_id}'.")

    chosen_scope = scope.upper()
    row = scopes.get(chosen_scope) or scopes.get("CAREER")
    actual_scope = chosen_scope if chosen_scope in scopes else ("CAREER" if "CAREER" in scopes else next(iter(scopes.keys())))
    if not row:
        raise HTTPException(status_code=404, detail=f"Requested scope '{scope}' unavailable for '{player_id}'.")

    available_scopes = sorted(
        list(scopes.keys()),
        key=lambda s: (0 if s == "CAREER" else (1 if s == "RECENT_3_SEASONS" else 2), s),
    )
    return {
        "player": meta,
        "scope_requested": chosen_scope,
        "scope_used": actual_scope,
        "available_scopes": available_scopes,
        "stats": row,
        "allow_bidding_advice": False,
    }


@v1.get("/ratings/leaderboard")
def ratings_leaderboard(
    role: Optional[str] = Query(default=None),
    scope: Literal["CAREER", "RECENT_3_SEASONS"] = Query(default="CAREER"),
    sort_by: Literal[
        "overall_rating",
        "batting_rating",
        "bowling_rating",
        "all_rounder_rating",
        "fielding_rating",
    ] = Query(default="overall_rating"),
    min_matches: int = Query(default=10, ge=1, le=200),
    limit: int = Query(default=25, ge=1, le=100),
):
    _require_trained(MLModelKey.PLAYER_RATING)
    return {
        "scope": scope,
        "role": role or "ALL",
        "sort_by": sort_by,
        "allow_bidding_advice": False,
        "disclaimer": "HISTORICAL_STATISTICAL_RATING (not official IPL rating, not a forward ML forecast)",
        "players": get_rating_leaderboard(
            role=role,
            scope=scope,
            sort_by=sort_by,
            min_matches=min_matches,
            limit=limit,
        ),
    }


@v1.post("/ratings/player", response_model=PlayerRatingResponse)
def player_rating(req: PlayerRatingRequest):
    _require_trained(MLModelKey.PLAYER_RATING)
    res = compute_player_rating(req.player_id, scope=req.scope)
    if not res:
        raise HTTPException(status_code=404, detail=f"No historical rating data found for '{req.player_id}'.")
    return PlayerRatingResponse(**res)


@v1.post("/analysis/team-strength", response_model=TeamStrengthResponse)
def team_strength(req: TeamStrengthRequest):
    _require_trained(MLModelKey.TEAM_STRENGTH)
    res = analyze_team_strength(
        room_id=req.room_id,
        franchise_code=req.franchise_code,
        squad=req.squad,
        max_overseas_in_squad=req.max_overseas_in_squad,
    )
    return TeamStrengthResponse(**res)


@v1.post("/predictions/playing-xi", response_model=PlayingXIResponse)
def playing_xi(req: PlayingXIRequest):
    _require_trained(MLModelKey.PLAYING_XI)
    try:
        res = predict_playing_xi(
            room_id=req.room_id,
            franchise_code=req.franchise_code,
            squad=req.squad,
            venue=req.venue,
            pitch_type=req.pitch_type,
        )
        return PlayingXIResponse(**res)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@v1.get("/predictions/match/metadata")
def match_prediction_metadata():
    _require_trained(MLModelKey.MATCH_PRED)
    return get_match_predictor_metadata()


@v1.post("/predictions/match", response_model=MatchPredictionResponse)
def match_prediction(req: MatchPredictionRequest):
    _require_trained(MLModelKey.MATCH_PRED)
    try:
        res = predict_match_outcome(
            home_franchise_code=req.home_franchise_code,
            away_franchise_code=req.away_franchise_code,
            venue=req.venue,
            home_xi=req.home_xi,
            away_xi=req.away_xi,
            toss_winner=req.toss_winner,
            toss_decision=req.toss_decision,
        )
        return MatchPredictionResponse(**res)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@v1.post("/analysis/post-match")
def post_match_analysis(req: PostMatchAnalysisRequest):
    _require_trained(MLModelKey.POST_MATCH_ANALYSIS)


app.include_router(v1)
