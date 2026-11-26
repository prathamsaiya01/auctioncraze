import math
import tempfile
from pathlib import Path
import numpy as np
from fastapi.testclient import TestClient

from app.main import app
from app.models.artifact_store import ARTIFACTS_DIR, load_model_artifact
from app.pipelines.data_audit import compute_dataset_fingerprint, run_data_audit
from app.pipelines.feature_engineering import (
    BATTING_FEATURE_NAMES,
    BOWLING_FEATURE_NAMES,
    build_supervised_dataset,
    compute_cutoff_player_features,
    load_raw_tables,
)
from app.pipelines.train_baselines import run_all_training

client = TestClient(app)


def test_data_audit_integrity_and_null_preservation():
    report = run_data_audit(write_report=False)
    assert report["summary"]["totalPlayers"] >= 800
    assert report["summary"]["totalPlayerSeasons"] >= 3000
    assert report["summary"]["allPlayersHaveCricsheetId"] is True
    assert report["summary"]["integrityPassed"] is True
    assert report["statisticsIntegrity"]["consistencyViolations"] == []
    assert report["statisticsIntegrity"]["orphanSeasonRows"] == 0
    assert report["statisticsIntegrity"]["preservedNullCounts"]["nullBattingAverage_zeroDismissals"] > 0
    assert report["statisticsIntegrity"]["preservedNullCounts"]["nullEconomy_zeroLegalBalls"] > 0


def test_cutoff_zero_leakage_invariance():
    players_by_id, seasons_by_player = load_raw_tables()
    vk_id = next(pid for pid, m in players_by_id.items() if m["full_name"] == "Virat Kohli")
    vk_meta = players_by_id[vk_id]
    vk_seasons = seasons_by_player[vk_id]

    cutoff = 2022
    feats_full = compute_cutoff_player_features(vk_seasons, vk_meta, cutoff_season=cutoff)
    # Truncate dataset strictly to < cutoff AND verify bit-for-bit identical feature vector
    truncated_seasons = [s for s in vk_seasons if s["season"] < cutoff]
    feats_trunc = compute_cutoff_player_features(truncated_seasons, vk_meta, cutoff_season=cutoff)

    assert feats_full is not None and feats_trunc is not None
    assert feats_full.keys() == feats_trunc.keys()
    for k in feats_full:
        v1, v2 = feats_full[k], feats_trunc[k]
        if isinstance(v1, float) and math.isnan(v1):
            assert isinstance(v2, float) and math.isnan(v2), f"NaN mismatch on {k}"
        else:
            assert v1 == v2, f"Leakage detected on feature '{k}': {v1} != {v2}"

    # Verify target-season stats never appear in training features
    df_bat = build_supervised_dataset("batting")
    vk_2022 = df_bat[(df_bat["cricsheet_id"] == vk_id) & (df_bat["target_season"] == 2022)].iloc[0]
    assert int(vk_2022["prior_seasons_count"]) == len(truncated_seasons)
    assert float(vk_2022["prior_matches"]) == float(sum(s["matches"] for s in truncated_seasons))


def test_missing_value_preservation_in_features():
    fake_meta = {"cricsheet_id": "x1", "full_name": "Debutant", "dob_year": None, "is_overseas_num": np.nan}
    # Player batted 2 matches without getting dismissed and never bowled
    seasons = [{
        "season": 2023,
        "matches": 2,
        "batting_innings": 2,
        "bowling_innings": 0,
        "runs": 20,
        "balls_faced": 15,
        "not_outs": 2,
        "fifties": 0,
        "hundreds": 0,
        "wickets": None,
        "balls_bowled": None,
        "runs_conceded": None,
        "catches": 1,
        "stumpings": 0,
    }]
    feats = compute_cutoff_player_features(seasons, fake_meta, cutoff_season=2024)
    assert feats is not None
    assert math.isnan(feats["prior_batting_avg"]), "Zero dismissals must keep batting_avg as NaN, not 0"
    assert math.isnan(feats["prior_wickets_per_match"]), "Never bowled must stay NaN"
    assert math.isnan(feats["prior_economy"]), "Zero balls bowled must stay NaN"
    assert math.isnan(feats["age_at_season"]), "Missing DOB must stay NaN"
    assert math.isnan(feats["is_overseas_num"]), "Missing nationality must stay NaN"
    assert feats["prior_strike_rate"] == (20 * 100.0) / 15


def test_reproducible_training_and_artifact_loading():
    r1 = run_all_training(save_artifacts=False)
    r2 = run_all_training(save_artifacts=False)
    for k in ("BATTING_PERFORMANCE_PRED", "BOWLING_PERFORMANCE_PRED"):
        assert r1["models"][k]["metrics"] == r2["models"][k]["metrics"]
        assert r1["models"][k]["validation_metrics"] == r2["models"][k]["validation_metrics"]

        model_obj, meta = load_model_artifact(k, base_dir=ARTIFACTS_DIR)
        assert meta["is_validated"] is True
        assert meta["dataset_fingerprint"] == compute_dataset_fingerprint()
        expected_cols = BATTING_FEATURE_NAMES if "BATTING" in k else BOWLING_FEATURE_NAMES
        assert meta["feature_names"] == expected_cols
        assert hasattr(model_obj, "predict")

    # Missing artifact raises cleanly
    with tempfile.TemporaryDirectory() as tmp:
        try:
            load_model_artifact("BATTING_PERFORMANCE_PRED", base_dir=Path(tmp))
            assert False, "Expected FileNotFoundError"
        except FileNotFoundError:
            pass


def test_fastapi_endpoints_predictions_and_guardrails():
    # 1. Health & policy endpoints
    h = client.get("/health")
    assert h.status_code == 200
    assert h.json()["allow_bidding_advice"] is False

    mh = client.get("/v1/models/health")
    assert mh.status_code == 200
    mh_data = mh.json()
    assert mh_data["allow_bidding_advice"] is False
    assert mh_data["trained_count"] == 2
    assert mh_data["models"]["BATTING_PERFORMANCE_PRED"]["is_validated"] is True
    assert mh_data["models"]["BOWLING_PERFORMANCE_PRED"]["is_validated"] is True

    # 2. Versions & Evaluation endpoints
    ev_bat = client.get("/v1/models/BATTING_PERFORMANCE_PRED/evaluation")
    assert ev_bat.status_code == 200
    assert ev_bat.json()["holdout_metrics"]["r2"] > 0.5
    assert "historical_career_avg_baseline" in ev_bat.json()["baseline_comparisons"]

    ev_untrained = client.get("/v1/models/MATCH_PRED/evaluation")
    assert ev_untrained.status_code == 503

    # 3. Data quality audit & dataset provenance
    aq = client.get("/v1/audit/data-quality")
    assert aq.status_code == 200
    assert aq.json()["summary"]["integrityPassed"] is True

    prov = client.get("/v1/datasets/provenance")
    assert prov.status_code == 200
    assert prov.json()["bidding_advice_enabled"] is False

    # 4. Real predictions (Virat Kohli batting, Jasprit Bumrah bowling) with cutoff & confidence intervals
    pred_bat_2027 = client.post(
        "/v1/predictions/performance",
        json={"player_id": "Virat Kohli", "target": "runs_per_match", "cutoff_season": 2027},
    )
    assert pred_bat_2027.status_code == 200
    pb = pred_bat_2027.json()
    assert pb["player_name"] == "Virat Kohli"
    assert pb["allow_bidding_advice"] is False
    assert pb["predicted_value"] > 20.0
    assert pb["prediction_interval"]["lower_bound"] <= pb["predicted_value"] <= pb["prediction_interval"]["upper_bound"]

    # Cutoff enforcement: pre-2016 Virat matches < pre-2027 Virat matches
    pred_bat_2016 = client.post(
        "/v1/predictions/performance",
        json={"player_id": "Virat Kohli", "target": "runs_per_match", "cutoff_season": 2016},
    )
    assert pred_bat_2016.status_code == 200
    assert pred_bat_2016.json()["prior_matches_used"] < pb["prior_matches_used"]

    pred_bowl = client.post(
        "/v1/predictions/performance",
        json={"player_id": "Jasprit Bumrah", "target": "wickets_per_match", "cutoff_season": 2027},
    )
    assert pred_bowl.status_code == 200
    assert pred_bowl.json()["predicted_value"] > 0.8

    # 5. Insufficient historical coverage rejected with 422 rather than fabricated
    # Shikhar Dhawan bowled 0 IPL overs after 2008 / fewer than 2 bowling innings? Or check any pure WK like Nicholas Pooran
    insufficient_bowl = client.post(
        "/v1/predictions/performance",
        json={"player_id": "Nicolas Pooran", "target": "wickets_per_match", "cutoff_season": 2027},
    )
    assert insufficient_bowl.status_code == 422

    # 6. Unavailable downstream models strictly return 503
    assert client.post("/v1/ratings/player", json={"player_id": "ba607b88"}).status_code == 503
    assert client.post("/v1/predictions/match", json={
        "home_franchise_code": "CSK", "away_franchise_code": "MI",
        "home_xi": [], "away_xi": [], "venue": "Chepauk"
    }).status_code == 503
    assert client.post("/v1/analysis/post-match", json={
        "match_id": "m1", "home_franchise_code": "CSK", "away_franchise_code": "MI",
        "winner_franchise_code": "CSK", "innings_scores": {"CSK": 180, "MI": 170}
    }).status_code == 503
