from typing import Dict
from app.schemas.contracts import MLModelKey, ModelVersionMetadata


class ModelRegistry:
    """
    Tracks versioned trained model artifacts.
    Un-trained models explicitly report is_trained=False so no fake scores are ever returned.
    """

    def __init__(self) -> None:
        self._models: Dict[MLModelKey, ModelVersionMetadata] = {
            MLModelKey.PLAYER_RATING: ModelVersionMetadata(
                model_key=MLModelKey.PLAYER_RATING,
                version="0.0.0-untrained",
                algorithm="LightGBM",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
            ),
            MLModelKey.PERFORMANCE_PRED: ModelVersionMetadata(
                model_key=MLModelKey.PERFORMANCE_PRED,
                version="0.0.0-untrained",
                algorithm="XGBoost",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
            ),
            MLModelKey.TEAM_STRENGTH: ModelVersionMetadata(
                model_key=MLModelKey.TEAM_STRENGTH,
                version="0.0.0-untrained",
                algorithm="Scikit-learn GradientBoosting",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
            ),
            MLModelKey.PLAYING_XI: ModelVersionMetadata(
                model_key=MLModelKey.PLAYING_XI,
                version="0.0.0-untrained",
                algorithm="Constraint Optimization + LightGBM",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
            ),
            MLModelKey.MATCH_PRED: ModelVersionMetadata(
                model_key=MLModelKey.MATCH_PRED,
                version="0.0.0-untrained",
                algorithm="Calibrated XGBoost",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
            ),
            MLModelKey.POST_MATCH_ANALYSIS: ModelVersionMetadata(
                model_key=MLModelKey.POST_MATCH_ANALYSIS,
                version="0.0.0-untrained",
                algorithm="Win-Probability Attribution + Phase Impact",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
            ),
        }

    def list_models(self) -> Dict[MLModelKey, ModelVersionMetadata]:
        return self._models

    def get(self, key: MLModelKey) -> ModelVersionMetadata:
        return self._models[key]
