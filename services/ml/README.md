# AuctionCraze ML Intelligence Service

Independent Python + FastAPI cricket analytics & prediction service.

## Scope & Strict Guardrails
- **Model 1**: Player Performance Rating (historical, recent form, phase-wise stats, consistency)
- **Model 2**: Player Performance Prediction (expected runs/wickets/impact using contextual features)
- **Model 3**: Team Strength Evaluation (post-auction squad depth, pace/spin balance, overseas mix)
- **Model 4**: Playing XI + Impact Player Predictor (post-auction optimal combinations + captain/vice-captain)
- **Model 5**: Match Outcome Prediction & Post-Match Analysis (calibrated win probabilities)

### Explicit Prohibited Features
This service **MUST NEVER** provide:
- Auction buying recommendations
- Bidding advice or max-bid targets
- Player purchase suggestions or spending advice

## Quality Standards
- Chronological train/test splits only (zero future leakage)
- Verified historical IPL datasets only (no fabricated scores or metrics)
- Versioned model artifacts via `MLModelRegistry`
