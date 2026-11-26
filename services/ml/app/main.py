from fastapi import FastAPI, HTTPException
from app.models.registry import ModelRegistry
from app.pipelines.dataset_loader import (
    load_player_feature_vectors,
    load_provenance_manifest,
)
from app.schemas.contracts import (
    DatasetProvenanceResponse,
    GuardrailPolicy,
    MLModelKey,
    MatchPredictionRequest,
    PlayerFeatureVector,
    PlayerRatingRequest,
    PlayingXIRequest,
    PostMatchAnalysisRequest,
    TeamStrengthRequest,
)

app = FastAPI(
    title="AuctionCraze ML Intelligence Service",
    version="0.1.0",
    description=(
        "Cricket performance ratings, post-auction squad strength, Playing XI + Impact Player "
        "and match prediction service. Never provides auction bidding or buying advice."
    ),
)

registry = ModelRegistry()


def _require_trained(key: MLModelKey) -> None:
    meta = registry.get(key)
    if not meta.is_trained:
        raise HTTPException(
            status_code=503,
            detail=(
                f"Model '{key.value}' is not trained yet (version: {meta.version}). "
                "Real historical IPL data training runs in Phase 10; synthetic scores are disabled."
            ),
        )


@app.get("/health")
def health():
    return {
        "status": "healthy",
        "service": "auctioncraze-ml",
        "models": {k.value: v.model_dump() for k, v in registry.list_models().items()},
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
