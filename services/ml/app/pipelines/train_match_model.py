import csv
import gzip
import json
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    f1_score,
    log_loss,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from app.models.artifact_store import ARTIFACTS_DIR, save_model_artifact
from app.pipelines.analytics_store import ANALYTICS_DIR, load_advanced_stats_index, load_matches_table
from app.pipelines.data_audit import compute_dataset_fingerprint

REPORTS_DIR = Path(__file__).resolve().parents[2] / "reports"
RANDOM_SEED = 42
MEGA_AUCTION_SEASONS = {2011, 2014, 2018, 2022, 2025}

MATCH_FEATURE_NAMES = [
    "elo_diff",
    "nrr_ema_diff",
    "cycle_form_diff",
    "xi_sea_ovr_diff",
    "xi_sea_bat_diff",
    "xi_sea_bowl_diff",
]


def _load_match_lineups() -> Dict[str, Dict[str, List[Tuple[str, int, int, int, int]]]]:
    """match_id -> {team_code: [(cricsheet_id, runs, balls_faced, legal_balls_bowled, wickets)]}."""
    path = ANALYTICS_DIR / "match_appearances.csv.gz"
    out: Dict[str, Dict[str, List[Tuple[str, int, int, int, int]]]] = defaultdict(lambda: defaultdict(list))
    if not path.exists():
        return out
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            out[row["match_id"]][row["team_code"]].append((
                row["cricsheet_id"],
                int(row["runs"] or 0),
                int(row["balls_faced"] or 0),
                int(row["legal_balls_bowled"] or 0),
                int(row["wickets"] or 0),
            ))
    return out


class SequentialMatchState:
    """Strictly causal state maintained match-by-match in chronological order."""

    def __init__(self) -> None:
        self.elo: Dict[str, float] = defaultdict(lambda: 1500.0)
        self.nrr_ema: Dict[str, float] = defaultdict(float)
        self.cycle_results: Dict[str, deque] = defaultdict(lambda: deque(maxlen=14))
        self.last_season_seen: Dict[str, int] = {}
        self.venue_chase_wins: Dict[str, int] = defaultdict(int)
        self.venue_chase_games: Dict[str, int] = defaultdict(int)

        self._adv_stats = load_advanced_stats_index()
        self._player_season_cache: Dict[Tuple[str, int], Tuple[float, float, float]] = {}

    def apply_season_reversion(self, season: int, teams: List[str]) -> None:
        for t in teams:
            prev = self.last_season_seen.get(t)
            if prev is not None and season > prev:
                rev = 0.65 if season in MEGA_AUCTION_SEASONS else 0.30
                self.elo[t] = ((1.0 - rev) * self.elo[t]) + (rev * 1500.0)
                self.nrr_ema[t] = (1.0 - rev) * self.nrr_ema[t]
                if season in MEGA_AUCTION_SEASONS:
                    self.cycle_results[t].clear()
            self.last_season_seen[t] = season

    def _prior_season_player_score(self, pid: str, before_season: int) -> Tuple[float, float, float]:
        key = (pid, before_season)
        if key in self._player_season_cache:
            return self._player_season_cache[key]

        p_scopes = self._adv_stats.get(pid, {})
        runs = balls = dism = lballs = rconc = wkts = inns_bat = 0
        for sc, r in p_scopes.items():
            if not sc.startswith("SEASON_"):
                continue
            yr = int(sc.split("_")[1])
            if yr >= before_season:
                continue
            if r.get("runs") is not None:
                runs += r["runs"]
                balls += r["balls_faced"] or 0
                dism += r["dismissals"] or 0
                inns_bat += r["batting_innings"] or 0
            if r.get("legal_balls_bowled") is not None:
                lballs += r["legal_balls_bowled"]
                rconc += r["runs_conceded"] or 0
                wkts += r["wickets"] or 0

        bat_w = inns_bat / (inns_bat + 20.0)
        if inns_bat > 0 and balls > 0:
            avg = runs / max(dism, 1)
            sr = (runs * 100.0) / balls
            raw_bat = max(20.0, min(95.0, 50.0 + ((avg - 22.0) * 0.8) + ((sr - 125.0) * 0.4)))
        else:
            raw_bat = 50.0
        bat_r = (bat_w * raw_bat) + ((1.0 - bat_w) * 50.0)

        overs = lballs / 6.0
        bowl_w = overs / (overs + 45.0)
        if overs >= 4.0 and lballs > 0:
            econ = (rconc * 6.0) / lballs
            bsr = lballs / max(wkts, 0.5)
            raw_bowl = max(20.0, min(95.0, 52.0 + ((8.0 - econ) * 7.5) + ((21.0 - bsr) * 0.7)))
        else:
            raw_bowl = 48.0
        bowl_r = (bowl_w * raw_bowl) + ((1.0 - bowl_w) * 49.0)

        ovr_r = max(bat_r, bowl_r) + (0.15 * min(bat_r, bowl_r))
        res = (bat_r, bowl_r, ovr_r)
        self._player_season_cache[key] = res
        return res

    def compute_xi_strengths(self, player_ids: List[str], before_season: int = 2027) -> Tuple[float, float, float]:
        if not player_ids:
            return 50.0, 50.0, 50.0
        vals = [self._prior_season_player_score(pid, before_season) for pid in player_ids[:11]]
        bats = sorted((v[0] for v in vals), reverse=True)[:7]
        bowls = sorted((v[1] for v in vals), reverse=True)[:5]
        ovrs = sorted((v[2] for v in vals), reverse=True)[:11]
        return (
            sum(ovrs) / len(ovrs),
            sum(bats) / len(bats),
            sum(bowls) / len(bowls),
        )

    def extract_features(
        self,
        team1: str,
        team2: str,
        season: int,
        team1_xi: List[str],
        team2_xi: List[str],
    ) -> Dict[str, float]:
        elo_diff = (self.elo[team1] - self.elo[team2]) / 100.0
        r1 = list(self.cycle_results[team1])
        r2 = list(self.cycle_results[team2])
        f_1 = (sum(r1) + 2.0) / (len(r1) + 4.0)
        f_2 = (sum(r2) + 2.0) / (len(r2) + 4.0)

        ovr1, bat1, bowl1 = self.compute_xi_strengths(team1_xi, before_season=season)
        ovr2, bat2, bowl2 = self.compute_xi_strengths(team2_xi, before_season=season)

        return {
            "elo_diff": round(elo_diff, 5),
            "nrr_ema_diff": round(self.nrr_ema[team1] - self.nrr_ema[team2], 5),
            "cycle_form_diff": round(f_1 - f_2, 5),
            "xi_sea_ovr_diff": round(ovr1 - ovr2, 5),
            "xi_sea_bat_diff": round(bat1 - bat2, 5),
            "xi_sea_bowl_diff": round(bowl1 - bowl2, 5),
        }

    def update_after_match(self, match: Dict[str, Any]) -> None:
        t1 = match["team1_code"]
        t2 = match["team2_code"]
        winner = match["winner_code"]
        venue = match["venue"]

        if match["is_completed"] and winner in (t1, t2):
            e1, e2 = self.elo[t1], self.elo[t2]
            exp1 = 1.0 / (1.0 + (10.0 ** (-(e1 - e2) / 400.0)))
            actual1 = 1.0 if winner == t1 else 0.0
            delta = 20.0 * (actual1 - exp1)
            self.elo[t1] = e1 + delta
            self.elo[t2] = e2 - delta

            if match.get("win_by_runs"):
                margin = min(3.0, float(match["win_by_runs"]) / 25.0)
            elif match.get("win_by_wickets"):
                margin = min(3.0, float(match["win_by_wickets"]) / 3.5)
            else:
                margin = 0.25
            signed_margin = margin if winner == t1 else -margin
            self.nrr_ema[t1] = (0.84 * self.nrr_ema[t1]) + (0.16 * signed_margin)
            self.nrr_ema[t2] = (0.84 * self.nrr_ema[t2]) - (0.16 * signed_margin)

            self.cycle_results[t1].append(1 if winner == t1 else 0)
            self.cycle_results[t2].append(1 if winner == t2 else 0)

            tw = match["toss_winner_code"]
            td = (match["toss_decision"] or "").lower()
            if tw in (t1, t2) and td in ("bat", "field"):
                bat_first = tw if td == "bat" else (t2 if tw == t1 else t1)
                chasing_team = t2 if bat_first == t1 else t1
                self.venue_chase_games[venue] += 1
                if winner == chasing_team:
                    self.venue_chase_wins[venue] += 1


def build_chronological_match_dataset(
    cutoff_date: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], SequentialMatchState]:
    matches = load_matches_table()
    lineups = _load_match_lineups()
    state = SequentialMatchState()
    dataset: List[Dict[str, Any]] = []

    for m in matches:
        if cutoff_date and m["match_date"] >= cutoff_date:
            break
        t1, t2 = m["team1_code"], m["team2_code"]
        state.apply_season_reversion(m["season"], [t1, t2])
        m_lineup = lineups.get(m["match_id"], {})

        if m["is_completed"] and m["winner_code"] in (t1, t2):
            feats = state.extract_features(
                team1=t1,
                team2=t2,
                season=m["season"],
                team1_xi=[r[0] for r in m_lineup.get(t1, [])],
                team2_xi=[r[0] for r in m_lineup.get(t2, [])],
            )
            dataset.append({
                "match_id": m["match_id"],
                "match_date": m["match_date"],
                "season": m["season"],
                "team1_code": t1,
                "team2_code": t2,
                "label": 1 if m["winner_code"] == t1 else 0,
                "features": feats,
            })

        state.update_after_match(m)

    return dataset, state


def _compute_ece(y_true: np.ndarray, probs: np.ndarray, n_bins: int = 10) -> float:
    bins = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    n = len(y_true)
    if n == 0:
        return 0.0
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        if i == n_bins - 1:
            mask = (probs >= lo) & (probs <= hi)
        else:
            mask = (probs >= lo) & (probs < hi)
        cnt = int(mask.sum())
        if cnt == 0:
            continue
        ece += (cnt / n) * abs(float(y_true[mask].mean()) - float(probs[mask].mean()))
    return round(float(ece), 4)


def _classification_metrics(y_true: np.ndarray, probs: np.ndarray) -> Dict[str, float]:
    preds = (probs >= 0.5).astype(int)
    return {
        "accuracy": round(float(accuracy_score(y_true, preds)), 4),
        "precision": round(float(precision_score(y_true, preds, zero_division=0)), 4),
        "recall": round(float(recall_score(y_true, preds, zero_division=0)), 4),
        "f1": round(float(f1_score(y_true, preds, zero_division=0)), 4),
        "roc_auc": round(float(roc_auc_score(y_true, probs)), 4),
        "log_loss": round(float(log_loss(y_true, probs)), 4),
        "brier_score": round(float(brier_score_loss(y_true, probs)), 4),
        "ece": _compute_ece(y_true, probs),
    }


def _augment_symmetric(X: np.ndarray, y: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    return np.vstack([X, -X]), np.concatenate([y, 1 - y])


def train_and_evaluate_match_model(save_artifacts: bool = True) -> Dict[str, Any]:
    rows, _ = build_chronological_match_dataset()
    train_rows = [r for r in rows if 2009 <= r["season"] <= 2021]
    val_rows = [r for r in rows if 2022 <= r["season"] <= 2023]
    holdout_rows = [r for r in rows if r["season"] >= 2024]

    def _xy(subset: List[Dict[str, Any]]) -> Tuple[np.ndarray, np.ndarray]:
        X = np.array([[r["features"][k] for k in MATCH_FEATURE_NAMES] for r in subset], dtype=float)
        y = np.array([r["label"] for r in subset], dtype=int)
        return X, y

    X_train, y_train = _xy(train_rows)
    X_val, y_val = _xy(val_rows)
    X_hold, y_hold = _xy(holdout_rows)
    X_train_sym, y_train_sym = _augment_symmetric(X_train, y_train)

    candidates = {
        "logistic_l2_symmetric": lambda: Pipeline([
            ("scaler", StandardScaler(with_mean=False)),
            ("clf", LogisticRegression(C=0.02, fit_intercept=False, random_state=RANDOM_SEED, max_iter=1000)),
        ]),
        "calibrated_gbdt": lambda: CalibratedClassifierCV(
            estimator=GradientBoostingClassifier(
                n_estimators=60,
                max_depth=2,
                learning_rate=0.03,
                subsample=0.75,
                random_state=RANDOM_SEED,
            ),
            method="sigmoid",
            cv=5,
        ),
        "calibrated_random_forest": lambda: CalibratedClassifierCV(
            estimator=RandomForestClassifier(
                n_estimators=150,
                max_depth=3,
                min_samples_leaf=20,
                random_state=RANDOM_SEED,
            ),
            method="sigmoid",
            cv=5,
        ),
    }

    val_results: Dict[str, Dict[str, float]] = {}
    for name, builder in candidates.items():
        m = builder()
        m.fit(X_train_sym, y_train_sym)
        probs = m.predict_proba(X_val)[:, 1]
        val_results[name] = _classification_metrics(y_val, probs)

    best_name = min(val_results.keys(), key=lambda k: val_results[k]["log_loss"])

    X_tv = np.vstack([X_train, X_val])
    y_tv = np.concatenate([y_train, y_val])
    X_tv_sym, y_tv_sym = _augment_symmetric(X_tv, y_tv)

    final_model = candidates[best_name]()
    final_model.fit(X_tv_sym, y_tv_sym)
    holdout_probs = final_model.predict_proba(X_hold)[:, 1]
    holdout_metrics = _classification_metrics(y_hold, holdout_probs)

    coin_probs = np.full_like(holdout_probs, 0.5)
    elo_only_probs = 1.0 / (1.0 + np.power(10.0, -(X_hold[:, 0] * 100.0) / 400.0))
    baselines = {
        "coin_flip_0.5_baseline": _classification_metrics(y_hold, coin_probs),
        "elo_rating_only_baseline": _classification_metrics(y_hold, elo_only_probs),
    }

    is_validated = (
        holdout_metrics["log_loss"] < baselines["coin_flip_0.5_baseline"]["log_loss"]
        and holdout_metrics["log_loss"] < baselines["elo_rating_only_baseline"]["log_loss"]
        and holdout_metrics["roc_auc"] > 0.52
    )

    top_features: List[Dict[str, Any]] = []
    if best_name == "logistic_l2_symmetric":
        coefs = final_model.named_steps["clf"].coef_[0]
        top_features = sorted(
            [
                {"feature": fn, "weight": round(float(c), 4), "abs_importance": round(abs(float(c)), 4)}
                for fn, c in zip(MATCH_FEATURE_NAMES, coefs)
            ],
            key=lambda d: -d["abs_importance"],
        )

    fingerprint = compute_dataset_fingerprint()
    meta = {
        "model_key": "MATCH_PRED",
        "version": "1.0.0",
        "selected_candidate": best_name,
        "algorithm": f"Match Outcome Classifier ({best_name})",
        "train_split": "2009-2021 (with 2008 causal warmup)",
        "validation_split": "2022-2023",
        "test_split": "2024-2026 chronological holdout",
        "target_name": "team1_win",
        "target_definition": "Binary match outcome (1 if team1 won completed IPL match, 0 if team2 won; NR excluded)",
        "random_seed": RANDOM_SEED,
        "dataset_fingerprint": fingerprint,
        "trained_at_utc": datetime.now(timezone.utc).isoformat(),
        "feature_names": MATCH_FEATURE_NAMES,
        "sample_counts": {
            "warmup_2008": sum(1 for r in rows if r["season"] == 2008),
            "train_2009_2021": len(train_rows),
            "validation_2022_2023": len(val_rows),
            "holdout_2024_2026": len(holdout_rows),
        },
        "validation_candidates": val_results,
        "validation_metrics": val_results[best_name],
        "metrics": holdout_metrics,
        "baseline_comparisons": baselines,
        "top_features": top_features,
        "limitations": [
            "T20 cricket has substantial intrinsic variance (dew, toss luck, sudden batting collapses, impact subs); honest pre-match accuracy typically falls in the 54%-62% range.",
            "Mega Auctions (2011, 2014, 2018, 2022, 2025) reset team continuity; causal Playing XI ratings capture squad turnover more reliably than historical franchise logos.",
            "Strictly separated from auction bidding (ALLOW_BIDDING_ADVICE=False).",
        ],
        "is_trained": True,
        "is_validated": bool(is_validated),
        "allow_bidding_advice": False,
    }

    if save_artifacts and is_validated:
        bundle = {
            "model": final_model,
            "feature_names": MATCH_FEATURE_NAMES,
            "trained_through_match_date": rows[-1]["match_date"] if rows else None,
        }
        artifact_path = save_model_artifact("MATCH_PRED", "1.0.0", bundle, meta, base_dir=ARTIFACTS_DIR)
        meta["artifact_path"] = str(artifact_path)

    report = {
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "datasetFingerprint": fingerprint,
        "allowBiddingAdvice": False,
        "model": meta,
    }
    if save_artifacts:
        REPORTS_DIR.mkdir(parents=True, exist_ok=True)
        (REPORTS_DIR / "match_evaluation_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    return report


if __name__ == "__main__":
    out = train_and_evaluate_match_model(save_artifacts=True)
    print(json.dumps(out, indent=2))
