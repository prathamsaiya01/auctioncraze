from pathlib import Path
from typing import Any, Dict, List
from app.models.artifact_store import ARTIFACTS_DIR, list_model_versions, load_model_artifact
from app.schemas.contracts import MLModelKey, ModelVersionMetadata


class ModelRegistry:
    """
    Tracks versioned trained model artifacts on disk alongside explicit placeholders
    for un-trained downstream models so no fake predictions are ever returned.
    """

    def __init__(self, artifacts_dir: Path = ARTIFACTS_DIR) -> None:
        self._artifacts_dir = artifacts_dir
        self._models: Dict[MLModelKey, ModelVersionMetadata] = {}
        self.reload()

    def reload(self) -> None:
        defaults: Dict[MLModelKey, ModelVersionMetadata] = {
            MLModelKey.BATTING_PERFORMANCE_PRED: ModelVersionMetadata(
                model_key=MLModelKey.BATTING_PERFORMANCE_PRED,
                version="0.0.0-untrained",
                algorithm="Ridge Regression",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
                is_validated=False,
            ),
            MLModelKey.BOWLING_PERFORMANCE_PRED: ModelVersionMetadata(
                model_key=MLModelKey.BOWLING_PERFORMANCE_PRED,
                version="0.0.0-untrained",
                algorithm="Random Forest Regressor",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
                is_validated=False,
            ),
            MLModelKey.PLAYER_RATING: ModelVersionMetadata(
                model_key=MLModelKey.PLAYER_RATING,
                version="0.0.0-untrained",
                algorithm="LightGBM",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
                is_validated=False,
            ),
            MLModelKey.PERFORMANCE_PRED: ModelVersionMetadata(
                model_key=MLModelKey.PERFORMANCE_PRED,
                version="0.0.0-untrained",
                algorithm="Split into BATTING_PERFORMANCE_PRED & BOWLING_PERFORMANCE_PRED",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
                is_validated=False,
            ),
            MLModelKey.TEAM_STRENGTH: ModelVersionMetadata(
                model_key=MLModelKey.TEAM_STRENGTH,
                version="0.0.0-untrained",
                algorithm="Scikit-learn GradientBoosting",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
                is_validated=False,
            ),
            MLModelKey.PLAYING_XI: ModelVersionMetadata(
                model_key=MLModelKey.PLAYING_XI,
                version="0.0.0-untrained",
                algorithm="Constraint Optimization + LightGBM",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
                is_validated=False,
            ),
            MLModelKey.MATCH_PRED: ModelVersionMetadata(
                model_key=MLModelKey.MATCH_PRED,
                version="0.0.0-untrained",
                algorithm="Calibrated XGBoost",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
                is_validated=False,
            ),
            MLModelKey.POST_MATCH_ANALYSIS: ModelVersionMetadata(
                model_key=MLModelKey.POST_MATCH_ANALYSIS,
                version="0.0.0-untrained",
                algorithm="Win-Probability Attribution + Phase Impact",
                train_split="pending-historical-ipl-data",
                test_split="pending-chronological-holdout",
                is_trained=False,
                is_validated=False,
            ),
        }

        for key in (MLModelKey.BATTING_PERFORMANCE_PRED, MLModelKey.BOWLING_PERFORMANCE_PRED):
            try:
                _, raw_meta = load_model_artifact(key.value, base_dir=self._artifacts_dir)
                defaults[key] = ModelVersionMetadata(
                    model_key=key,
                    version=raw_meta["version"],
                    algorithm=raw_meta["algorithm"],
                    train_split=raw_meta["train_split"],
                    validation_split=raw_meta.get("validation_split"),
                    test_split=raw_meta["test_split"],
                    target_name=raw_meta.get("target_name"),
                    target_definition=raw_meta.get("target_definition"),
                    random_seed=raw_meta.get("random_seed"),
                    dataset_fingerprint=raw_meta.get("dataset_fingerprint"),
                    trained_at_utc=raw_meta.get("trained_at_utc"),
                    feature_names=raw_meta.get("feature_names", []),
                    sample_counts=raw_meta.get("sample_counts", {}),
                    metrics={
                        k: float(v)
                        for k, v in (raw_meta.get("metrics") or {}).items()
                        if isinstance(v, (int, float))
                    },
                    validation_metrics={
                        k: float(v)
                        for k, v in (raw_meta.get("validation_metrics") or {}).items()
                        if isinstance(v, (int, float))
                    },
                    is_trained=bool(raw_meta.get("is_trained", True)),
                    is_validated=bool(raw_meta.get("is_validated", False)),
                    artifact_path=raw_meta.get("artifact_path"),
                )
            except FileNotFoundError:
                continue

        self._models = defaults

    def list_models(self) -> Dict[MLModelKey, ModelVersionMetadata]:
        return self._models

    def get(self, key: MLModelKey) -> ModelVersionMetadata:
        return self._models[key]

    def list_versions(self, key: MLModelKey) -> List[Dict[str, Any]]:
        return list_model_versions(key.value, base_dir=self._artifacts_dir)
