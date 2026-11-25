from fastapi import FastAPI, HTTPException
from app.models.registry import ModelRegistry
from app.schemas.contracts import (
    MLModelKey,
    MatchPredictionRequest,
    PlayerRatingRequest,
    PlayingXIRequest,
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
    return {"models": [v.model_dump() for v in registry.list_models().values()]}


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
