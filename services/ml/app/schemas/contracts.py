from enum import Enum
from typing import Dict, List, Optional
from pydantic import BaseModel, Field


class MLModelKey(str, Enum):
    PLAYER_RATING = "PLAYER_RATING"
    PERFORMANCE_PRED = "PERFORMANCE_PRED"
    TEAM_STRENGTH = "TEAM_STRENGTH"
    PLAYING_XI = "PLAYING_XI"
    MATCH_PRED = "MATCH_PRED"


class ModelVersionMetadata(BaseModel):
    model_key: MLModelKey
    version: str
    algorithm: str
    train_split: str
    test_split: str
    metrics: Dict[str, float] = Field(default_factory=dict)
    is_trained: bool = False
    artifact_path: Optional[str] = None


class PlayerRatingRequest(BaseModel):
    player_id: str
    season_context: Optional[int] = None


class PlayerRatingResponse(BaseModel):
    player_id: str
    model_version: str
    overall_rating: float
    batting_index: float
    bowling_index: float
    fielding_index: float
    phase_ratings: Dict[str, float]


class SquadPlayerInput(BaseModel):
    player_id: str
    playing_role: str
    is_overseas: bool


class TeamStrengthRequest(BaseModel):
    room_id: str
    franchise_code: str
    squad: List[SquadPlayerInput]


class TeamStrengthResponse(BaseModel):
    franchise_code: str
    model_version: str
    overall_strength: float
    batting_depth: float
    bowling_depth: float
    pace_spin_balance: float
    all_rounder_index: float
    overseas_compliance: bool


class PlayingXIRequest(BaseModel):
    room_id: str
    franchise_code: str
    squad: List[SquadPlayerInput]
    venue: Optional[str] = None
    pitch_type: Optional[str] = None


class PlayingXIResponse(BaseModel):
    franchise_code: str
    model_version: str
    playing_xi: List[str]
    impact_player: str
    captain_candidate: str
    vice_captain_candidate: str
    explanation: List[str]


class MatchPredictionRequest(BaseModel):
    home_franchise_code: str
    away_franchise_code: str
    home_xi: List[str]
    away_xi: List[str]
    venue: str
    toss_winner: Optional[str] = None
    toss_decision: Optional[str] = None


class MatchPredictionResponse(BaseModel):
    model_version: str
    home_win_probability: float
    away_win_probability: float
    calibrated: bool
    key_factors: List[str]
