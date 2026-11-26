from fastapi import FastAPI, HTTPException
from app.models.predictor import predict_performance
from app.models.registry import ModelRegistry
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
    PerformancePredictionRequest,
    PerformancePredictionResponse,
    PlayerFeatureVector,
    PlayerRatingRequest,
    PlayingXIRequest,
    PostMatchAnalysisRequest,
    TeamStrengthRequest,
)

app = FastAPI(
    title="AuctionCraze ML Intelligence Service",
    version="0.2.0",
    description=(
        "Cricket performance ratings, chronological performance baselines, team strength, Playing XI + Impact Player "
        "and match prediction service. Strictly separated from auction bidding (no buying recommendations)."
    ),
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
    trained_keys = [k.value for k, v in registry.list_models().items() if v.is_trained]
    return {
        "status": "healthy",
        "service": "auctioncraze-ml",
        "allow_bidding_advice": GuardrailPolicy.ALLOW_BIDDING_ADVICE,
        "trained_models": trained_keys,
        "models": {k.value: v.model_dump() for k, v in registry.list_models().items()},
    }


@app.get("/v1/models/health")
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


@app.get("/v1/models")
def list_models():
    return {
        "policy": {
            "allow_bidding_advice": GuardrailPolicy.ALLOW_BIDDING_ADVICE,
            "allow_purchase_pricing_advice": GuardrailPolicy.ALLOW_PURCHASE_PRICING_ADVICE,
            "require_verified_training_data": GuardrailPolicy.REQUIRE_VERIFIED_TRAINING_DATA,
        },
        "models": [v.model_dump() for v in registry.list_models().values()],
    }


@app.get("/v1/models/{model_key}/versions")
def get_model_versions(model_key: MLModelKey):
    versions = registry.list_versions(model_key)
    meta = registry.get(model_key)
    return {
        "model_key": model_key.value,
        "active_version": meta.version,
        "is_trained": meta.is_trained,
        "versions": versions,
    }


@app.get("/v1/models/{model_key}/evaluation")
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


@app.get("/v1/audit/data-quality")
def get_data_quality_audit():
    return run_data_audit(write_report=False)


@app.get("/v1/datasets/provenance", response_model=DatasetProvenanceResponse)
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


@app.get("/v1/features/player/{cricsheet_id}", response_model=PlayerFeatureVector)
def get_player_features(cricsheet_id: str, cutoff_season: int | None = None):
    features = load_player_feature_vectors(cutoff_season=cutoff_season)
    if cricsheet_id not in features:
        raise HTTPException(status_code=404, detail=f"No historical IPL features found for '{cricsheet_id}'")
    return PlayerFeatureVector(**features[cricsheet_id])


@app.post("/v1/predictions/performance", response_model=PerformancePredictionResponse)
def predict_player_performance(req: PerformancePredictionRequest):
    return predict_performance(
        player_id=req.player_id,
        target=req.target,
        cutoff_season=req.cutoff_season,
    )


@app.post("/v1/ratings/player")
def player_rating(req: PlayerRatingRequest):
    _require_trained(MLModelKey.PLAYER_RATING)


@app.post("/v1/analysis/team-strength")
def team_strength(req: TeamStrengthRequest):
    _require_trained(MLModelKey.TEAM_STRENGTH)


@app.post("/v1/predictions/playing-xi")
def playing_xi(req: PlayingXIRequest):
    _require_trained(MLModelKey.PLAYING_XI)


@app.post("/v1/predictions/match")
def match_prediction(req: MatchPredictionRequest):
    _require_trained(MLModelKey.MATCH_PRED)


@app.post("/v1/analysis/post-match")
def post_match_analysis(req: PostMatchAnalysisRequest):
    _require_trained(MLModelKey.POST_MATCH_ANALYSIS)
