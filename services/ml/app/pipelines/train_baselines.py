#!/usr/bin/env python3
"""
Phase 6A — Reproducible Chronological Training & Evaluation Pipeline.

Trains & evaluates baseline cricket performance prediction models cleanly:
- Batting Performance (`runs_per_match`, target model key: BATTING_PERFORMANCE_PRED)
- Bowling Performance (`wickets_per_match`, target model key: BOWLING_PERFORMANCE_PRED)

Strict chronological splits:
- Train:      2009..2021 (features computed from 2008..<T)
- Validation: 2022..2023 (hyperparameter & model selection)
- Holdout:    2024..2026 (final unbiased evaluation on refitted 2009..2023 model)

NEVER produces auction bidding/buying advice.
"""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, r2_score, root_mean_squared_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from app.models.artifact_store import save_model_artifact
from app.pipelines.data_audit import compute_dataset_fingerprint
from app.pipelines.feature_engineering import (
    BATTING_FEATURE_NAMES,
    BOWLING_FEATURE_NAMES,
    build_supervised_dataset,
)

RANDOM_SEED = 42
MODEL_VERSION = "1.0.0"
REPORTS_DIR = Path(__file__).resolve().parents[2] / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)


def evaluate_predictions(y_true: np.ndarray, y_pred: np.ndarray) -> Dict[str, float]:
    clipped = np.clip(y_pred, 0.0, None)
    mae = float(mean_absolute_error(y_true, clipped))
    rmse = float(root_mean_squared_error(y_true, clipped))
    r2 = float(r2_score(y_true, clipped)) if len(y_true) > 1 else 0.0
    residual_std = float(np.std(y_true - clipped, ddof=1)) if len(y_true) > 1 else rmse
    return {
        "mae": round(mae, 4),
        "rmse": round(rmse, 4),
        "r2": round(r2, 4),
        "residual_std": round(residual_std, 4),
        "samples": int(len(y_true)),
    }


def _build_candidates(task: str) -> List[Tuple[str, str, Callable[[], Any]]]:
    if task == "batting":
        return [
            (
                "Ridge(alpha=10.0)",
                "Ridge Regression",
                lambda: Pipeline([
                    ("imputer", SimpleImputer(strategy="median", add_indicator=True)),
                    ("scaler", StandardScaler()),
                    ("model", Ridge(alpha=10.0, random_state=RANDOM_SEED)),
                ]),
            ),
            (
                "Ridge(alpha=50.0)",
                "Ridge Regression",
                lambda: Pipeline([
                    ("imputer", SimpleImputer(strategy="median", add_indicator=True)),
                    ("scaler", StandardScaler()),
                    ("model", Ridge(alpha=50.0, random_state=RANDOM_SEED)),
                ]),
            ),
            (
                "Ridge(alpha=150.0)",
                "Ridge Regression",
                lambda: Pipeline([
                    ("imputer", SimpleImputer(strategy="median", add_indicator=True)),
                    ("scaler", StandardScaler()),
                    ("model", Ridge(alpha=150.0, random_state=RANDOM_SEED)),
                ]),
            ),
            (
                "RandomForest(depth=4,min_leaf=15)",
                "Random Forest Regressor",
                lambda: Pipeline([
                    ("imputer", SimpleImputer(strategy="median", add_indicator=True)),
                    (
                        "model",
                        RandomForestRegressor(
                            n_estimators=200,
                            max_depth=4,
                            min_samples_leaf=15,
                            random_state=RANDOM_SEED,
                            n_jobs=1,
                        ),
                    ),
                ]),
            ),
            (
                "RandomForest(depth=6,min_leaf=10)",
                "Random Forest Regressor",
                lambda: Pipeline([
                    ("imputer", SimpleImputer(strategy="median", add_indicator=True)),
                    (
                        "model",
                        RandomForestRegressor(
                            n_estimators=200,
                            max_depth=6,
                            min_samples_leaf=10,
                            random_state=RANDOM_SEED,
                            n_jobs=1,
                        ),
                    ),
                ]),
            ),
            (
                "HistGBR(depth=3,min_leaf=20)",
                "Histogram Gradient Boosting",
                lambda: HistGradientBoostingRegressor(
                    max_depth=3,
                    min_samples_leaf=20,
                    learning_rate=0.05,
                    max_iter=80,
                    l2_regularization=1.0,
                    random_state=RANDOM_SEED,
                ),
            ),
        ]

    # Bowling candidates
    return [
        (
            "Ridge(alpha=10.0)",
            "Ridge Regression",
            lambda: Pipeline([
                ("imputer", SimpleImputer(strategy="median", add_indicator=True)),
                ("scaler", StandardScaler()),
                ("model", Ridge(alpha=10.0, random_state=RANDOM_SEED)),
            ]),
        ),
        (
            "Ridge(alpha=50.0)",
            "Ridge Regression",
            lambda: Pipeline([
                ("imputer", SimpleImputer(strategy="median", add_indicator=True)),
                ("scaler", StandardScaler()),
                ("model", Ridge(alpha=50.0, random_state=RANDOM_SEED)),
            ]),
        ),
        (
            "Ridge(alpha=150.0)",
            "Ridge Regression",
            lambda: Pipeline([
                ("imputer", SimpleImputer(strategy="median", add_indicator=True)),
                ("scaler", StandardScaler()),
                ("model", Ridge(alpha=150.0, random_state=RANDOM_SEED)),
            ]),
        ),
        (
            "RandomForest(depth=4,min_leaf=15)",
            "Random Forest Regressor",
            lambda: Pipeline([
                ("imputer", SimpleImputer(strategy="median", add_indicator=True)),
                (
                    "model",
                    RandomForestRegressor(
                        n_estimators=200,
                        max_depth=4,
                        min_samples_leaf=15,
                        random_state=RANDOM_SEED,
                        n_jobs=1,
                    ),
                ),
            ]),
        ),
        (
            "HistGBR(depth=3,min_leaf=20)",
            "Histogram Gradient Boosting",
            lambda: HistGradientBoostingRegressor(
                max_depth=3,
                min_samples_leaf=20,
                learning_rate=0.05,
                max_iter=80,
                l2_regularization=1.0,
                random_state=RANDOM_SEED,
            ),
        ),
    ]


def train_and_evaluate_task(
    task: str,
    model_key: str,
    feature_names: List[str],
    target_name: str,
    target_definition: str,
    dataset_fingerprint: str,
    save_artifacts: bool = True,
) -> Dict[str, Any]:
    df = build_supervised_dataset(task)  # type: ignore[arg-type]
    train_df = df[df["target_season"] <= 2021].copy()
    val_df = df[(df["target_season"] >= 2022) & (df["target_season"] <= 2023)].copy()
    train_val_df = df[df["target_season"] <= 2023].copy()
    holdout_df = df[df["target_season"] >= 2024].copy()

    X_train, y_train = train_df[feature_names], train_df["target"].to_numpy()
    X_val, y_val = val_df[feature_names], val_df["target"].to_numpy()
    X_tv, y_tv = train_val_df[feature_names], train_val_df["target"].to_numpy()
    X_hold, y_hold = holdout_df[feature_names], holdout_df["target"].to_numpy()

    career_col = "prior_runs_per_match" if task == "batting" else "prior_wickets_per_match"
    recent_col = "recent_3y_runs_per_match" if task == "batting" else "recent_3y_wickets_per_match"

    # Non-ML Baselines on Validation & Holdout
    mean_pred_val = np.full_like(y_val, float(np.mean(y_train)))
    mean_pred_hold = np.full_like(y_hold, float(np.mean(y_tv)))

    career_val = val_df[career_col].fillna(float(np.mean(y_train))).to_numpy()
    career_hold = holdout_df[career_col].fillna(float(np.mean(y_tv))).to_numpy()

    recent_val = val_df[recent_col].fillna(val_df[career_col]).fillna(float(np.mean(y_train))).to_numpy()
    recent_hold = holdout_df[recent_col].fillna(holdout_df[career_col]).fillna(float(np.mean(y_tv))).to_numpy()

    baseline_results = {
        "global_mean_baseline": {
            "validation_2022_2023": evaluate_predictions(y_val, mean_pred_val),
            "holdout_2024_2026": evaluate_predictions(y_hold, mean_pred_hold),
        },
        "historical_career_avg_baseline": {
            "validation_2022_2023": evaluate_predictions(y_val, career_val),
            "holdout_2024_2026": evaluate_predictions(y_hold, career_hold),
        },
        "recent_3y_avg_baseline": {
            "validation_2022_2023": evaluate_predictions(y_val, recent_val),
            "holdout_2024_2026": evaluate_predictions(y_hold, recent_hold),
        },
    }

    # Evaluate ML candidates strictly on Train -> Validation (2022..2023)
    candidate_scores: List[Dict[str, Any]] = []
    best_entry = None
    for cand_name, algo_label, builder in _build_candidates(task):
        est = builder()
        est.fit(X_train, y_train)
        pred_val = est.predict(X_val)
        metrics_val = evaluate_predictions(y_val, pred_val)
        entry = {
            "candidate": cand_name,
            "algorithm": algo_label,
            "validation_2022_2023": metrics_val,
            "builder": builder,
        }
        candidate_scores.append({
            "candidate": cand_name,
            "algorithm": algo_label,
            "validation_2022_2023": metrics_val,
        })
        if best_entry is None or metrics_val["rmse"] < best_entry["validation_2022_2023"]["rmse"]:
            best_entry = entry

    assert best_entry is not None
    # Refit ONLY the selected candidate cleanly on Train + Validation (2009..2023) -> Evaluate ONCE on Holdout (2024..2026)
    final_model = best_entry["builder"]()
    final_model.fit(X_tv, y_tv)
    holdout_preds = final_model.predict(X_hold)
    holdout_metrics = evaluate_predictions(y_hold, holdout_preds)

    # Calibration sanity: does selected ML model outperform Global Mean Baseline on Holdout?
    beats_mean_baseline = holdout_metrics["rmse"] < baseline_results["global_mean_baseline"]["holdout_2024_2026"]["rmse"]

    # Extract readable top features cleanly when Ridge or RandomForest
    top_features: List[Dict[str, Any]] = []
    try:
        inner = final_model.named_steps["model"] if isinstance(final_model, Pipeline) else final_model
        if hasattr(inner, "coef_"):
            coefs = inner.coef_[: len(feature_names)]
            top_features = sorted(
                [{"feature": f, "weight": round(float(w), 4)} for f, w in zip(feature_names, coefs)],
                key=lambda x: abs(x["weight"]),
                reverse=True,
            )[:8]
        elif hasattr(inner, "feature_importances_"):
            imps = inner.feature_importances_[: len(feature_names)]
            top_features = sorted(
                [{"feature": f, "importance": round(float(w), 4)} for f, w in zip(feature_names, imps)],
                key=lambda x: x["importance"],
                reverse=True,
            )[:8]
    except Exception:
        top_features = []

    metadata: Dict[str, Any] = {
        "model_key": model_key,
        "version": MODEL_VERSION,
        "selected_candidate": best_entry["candidate"],
        "algorithm": best_entry["algorithm"],
        "target_name": target_name,
        "target_definition": target_definition,
        "random_seed": RANDOM_SEED,
        "trained_at_utc": datetime.now(timezone.utc).isoformat(),
        "dataset_fingerprint": dataset_fingerprint,
        "train_split": "2009-2021 (refit 2009-2023 for final holdout)",
        "validation_split": "2022-2023",
        "test_split": "2024-2026",
        "sample_counts": {
            "total_eligible": int(len(df)),
            "train_2009_2021": int(len(train_df)),
            "validation_2022_2023": int(len(val_df)),
            "train_plus_val_2009_2023": int(len(train_val_df)),
            "holdout_2024_2026": int(len(holdout_df)),
        },
        "feature_names": feature_names,
        "metrics": holdout_metrics,
        "validation_metrics": best_entry["validation_2022_2023"],
        "baseline_comparisons": baseline_results,
        "candidate_comparisons_validation": candidate_scores,
        "top_features": top_features,
        "beats_mean_baseline": beats_mean_baseline,
        "is_trained": True,
        "is_validated": bool(beats_mean_baseline),
        "limitations": [
            "Player-season T20 IPL performance has inherent match-by-match and batting-order variance.",
            "Match-level opposition, venue pitch, toss, and impact-sub role shifts are not yet included in Phase 6A season aggregates.",
            "Players with fewer than 2 prior innings in the target discipline before cutoff are ineligible (returned as 422 rather than fabricated).",
        ],
    }

    if save_artifacts:
        save_model_artifact(model_key, MODEL_VERSION, final_model, metadata)

    return metadata


def run_all_training(save_artifacts: bool = True) -> Dict[str, Any]:
    fp = compute_dataset_fingerprint()
    batting_meta = train_and_evaluate_task(
        task="batting",
        model_key="BATTING_PERFORMANCE_PRED",
        feature_names=BATTING_FEATURE_NAMES,
        target_name="runs_per_match",
        target_definition="Expected IPL runs scored per match played in target season (min 3 matches, min 3 prior matches, min 2 prior bat innings).",
        dataset_fingerprint=fp,
        save_artifacts=save_artifacts,
    )
    bowling_meta = train_and_evaluate_task(
        task="bowling",
        model_key="BOWLING_PERFORMANCE_PRED",
        feature_names=BOWLING_FEATURE_NAMES,
        target_name="wickets_per_match",
        target_definition="Expected IPL wickets taken per match played in target season (min 3 matches, min 3 prior matches, min 2 prior bowl innings).",
        dataset_fingerprint=fp,
        save_artifacts=save_artifacts,
    )

    full_report = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "random_seed": RANDOM_SEED,
        "dataset_fingerprint": fp,
        "models": {
            "BATTING_PERFORMANCE_PRED": batting_meta,
            "BOWLING_PERFORMANCE_PRED": bowling_meta,
        },
    }
    if save_artifacts:
        out_path = REPORTS_DIR / "model_evaluation_report.json"
        out_path.write_text(json.dumps(full_report, indent=2), encoding="utf-8")
    return full_report


if __name__ == "__main__":
    rep = run_all_training(save_artifacts=True)
    for k, m in rep["models"].items():
        print(f"=== {k} ({m['selected_candidate']}) ===")
        print("Samples:", m["sample_counts"])
        print("Validation (2022-23):", m["validation_metrics"])
        print("Holdout (2024-26):", m["metrics"])
        print("Holdout Baselines:", {
            bk: bv["holdout_2024_2026"] for bk, bv in m["baseline_comparisons"].items()
        })
        print("Top Features:", m["top_features"][:5])
