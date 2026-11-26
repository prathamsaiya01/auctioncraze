# AuctionCraze ML Architecture (Phase 6A)

## 1. Service Isolation & Hard Guardrails

`services/ml` runs as an independent Python + FastAPI cricket intelligence microservice completely decoupled from live auction bidding (`apps/api`, `apps/web`).

- **`GuardrailPolicy.ALLOW_BIDDING_ADVICE = False`**
- **`GuardrailPolicy.ALLOW_PURCHASE_PRICING_ADVICE = False`**
- **`GuardrailPolicy.REQUIRE_VERIFIED_TRAINING_DATA = True`**
- Downstream capabilities (`PLAYER_RATING`, `TEAM_STRENGTH`, `PLAYING_XI`, `MATCH_PRED`, `POST_MATCH_ANALYSIS`) remain explicitly marked `is_trained=False, is_validated=False` and return **`HTTP 503`** until trained and chronologically validated in Phase 6B+.

---

## 2. Directory Layout

```text
services/ml/
  DATA_AUDIT.md
  FEATURE_DICTIONARY.md
  MODEL_EVALUATION.md
  ML_ARCHITECTURE.md
  app/
    main.py                     # FastAPI endpoints (health, models, eval, audit, predictions)
    schemas/contracts.py        # Pydantic contracts & policy constants
    models/
      artifact_store.py         # joblib + metadata.json versioned storage & validation
      registry.py               # Automatic artifact loader with untrained 503 fallback
      predictor.py              # Cutoff-safe inference + eligibility + interval bounds
    pipelines/
      data_audit.py             # Automated dataset audit & SHA-256 fingerprint
      dataset_loader.py         # Provenance & historical player feature summaries
      feature_engineering.py    # Cutoff-safe rolling/career feature computation
      train_baselines.py        # Chronological train/val/holdout training & comparison
  artifacts/
    BATTING_PERFORMANCE_PRED/1.0.0/{model.joblib, metadata.json}
    BOWLING_PERFORMANCE_PRED/1.0.0/{model.joblib, metadata.json}
  reports/
    data_audit_report.json
    model_evaluation_report.json
  tests/
    test_phase6a.py
```

---

## 3. FastAPI Endpoints

| Method & Path | Status | Description |
| --- | --- | --- |
| `GET /health` | 200 | Service health, trained model keys, and `allow_bidding_advice=false` |
| `GET /v1/models/health` | 200 | Registry readiness summary and dataset fingerprint (`c9af4153629ffb06`) |
| `GET /v1/models` | 200 | Policy config + full registry metadata |
| `GET /v1/models/{model_key}/versions` | 200 | Saved artifact versions & validation flags |
| `GET /v1/models/{model_key}/evaluation` | 200 / 503 | Validation/Holdout metrics, baseline comparison, top features, and limitations (`503` if untrained) |
| `GET /v1/audit/data-quality` | 200 | Live machine-readable dataset integrity audit |
| `GET /v1/datasets/provenance` | 200 | Source manifest and coverage counters |
| `GET /v1/features/player/{cricsheet_id}` | 200 / 404 | Historical player feature summary (optional `cutoff_season`) |
| `POST /v1/predictions/performance` | 200 / 404 / 422 / 503 | Season-level prediction (`runs_per_match` or `wickets_per_match`) strictly from `season < cutoff_season` with `+/- 1 RMSE` prediction interval |
| `POST /v1/ratings/player` & team/match endpoints | 503 | Explicitly disabled pending future phases |

---

## 4. Model Versioning Contract

Every saved version directory contains:
- `model.joblib`: Serialized Scikit-learn estimator/pipeline.
- `metadata.json`: Includes `model_key`, `version`, `algorithm`, `selected_candidate`, `random_seed`, `trained_at_utc`, `dataset_fingerprint`, `train_split`, `validation_split`, `test_split`, `feature_names`, `sample_counts`, `validation_metrics`, `metrics` (Holdout), `baseline_comparisons`, `top_features`, `is_trained`, `is_validated`, and `limitations`.
