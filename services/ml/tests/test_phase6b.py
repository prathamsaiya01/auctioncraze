import math
import os
from fastapi.testclient import TestClient

from app.main import app, registry
from app.models.match_predictor import predict_match_outcome
from app.models.playing_xi import RULE_VERSION, predict_playing_xi
from app.models.rating_engine import compute_player_rating, get_rating_leaderboard
from app.models.team_strength import analyze_team_strength
from app.pipelines.analytics_store import (
    get_player_advanced_stats,
    load_players_index,
    resolve_player_id,
)
from app.pipelines.ball_by_ball import BOWLER_WICKET_KINDS, NON_DISMISSAL_KINDS, run_ball_by_ball_pipeline
from app.pipelines.train_match_model import build_chronological_match_dataset
from app.schemas.contracts import SquadPlayerInput

os.environ.setdefault("INTERNAL_ML_SERVICE_KEY", "test_internal_ml_secret_key_for_pytest_suite_64_chars_long")
client = TestClient(app, headers={"X-Internal-Service-Key": os.environ["INTERNAL_ML_SERVICE_KEY"]})
raw_client = TestClient(app)


def test_ball_by_ball_reconciliation_and_null_preservation():
    report = run_ball_by_ball_pipeline(write_outputs=False)
    assert report["duplicateMatchIds"] == []
    assert report["reconciliationPassed"] is True
    assert report["reconciliationMismatches"] == []
    assert report["parsingStats"]["unique_matches"] == 1243
    assert report["parsingStats"]["impact_player_substitutions"] >= 500
    assert "caught" in BOWLER_WICKET_KINDS
    assert "run out" not in BOWLER_WICKET_KINDS
    assert "retired hurt" in NON_DISMISSAL_KINDS

    # Pure batter without bowling deliveries retains None (not 0) for bowling rates
    msd_id = resolve_player_id("MS Dhoni")
    assert msd_id is not None
    msd_career = get_player_advanced_stats(msd_id)["CAREER"]
    assert msd_career["batting_innings"] > 200
    assert msd_career["bowling_innings"] == 0
    assert msd_career["economy"] is None
    assert msd_career["bowling_average"] is None

    # Powerplay + Middle + Death runs partition career runs for batter
    vk_id = resolve_player_id("Virat Kohli")
    vk_career = get_player_advanced_stats(vk_id)["CAREER"]
    phase_sum = (vk_career["bat_pp_runs"] or 0) + (vk_career["bat_mid_runs"] or 0) + (vk_career["bat_death_runs"] or 0)
    assert phase_sum == vk_career["runs"]
    sit_sum = (vk_career["bat_first_runs"] or 0) + (vk_career["bat_chase_runs"] or 0)
    assert sit_sum == vk_career["runs"]


def test_player_ratings_explainability_and_shrinkage():
    vk = compute_player_rating("Virat Kohli", scope="CAREER")
    assert vk is not None
    assert vk["allow_bidding_advice"] is False
    assert "not an official IPL rating" in vk["disclaimer"]
    assert vk["batting_rating"] is not None and vk["batting_rating"] > 65.0
    assert vk["overall_rating"] is not None and vk["overall_rating"] > 65.0

    jb = compute_player_rating("Jasprit Bumrah", scope="CAREER")
    assert jb is not None
    assert jb["bowling_rating"] is not None and jb["bowling_rating"] > 62.0

    # Find a player with < 5 matches to verify small-sample rejection returns None (no fake inflation)
    players, _ = load_players_index()
    tiny_id = None
    for cid in players:
        st = get_player_advanced_stats(cid).get("CAREER")
        if st and st["matches"] < 5:
            tiny_id = cid
            break
    if tiny_id:
        tiny_r = compute_player_rating(tiny_id, scope="CAREER")
        assert tiny_r is not None
        assert tiny_r["insufficient_sample"] is True
        assert tiny_r["overall_rating"] is None

    board = get_rating_leaderboard(sort_by="batting_rating", limit=10)
    assert len(board) == 10
    assert board[0]["batting_rating"] >= board[-1]["batting_rating"]


def _build_realistic_squad() -> list[SquadPlayerInput]:
    names = [
        ("Virat Kohli", "BATSMAN", False),
        ("Rohit Sharma", "BATSMAN", False),
        ("MS Dhoni", "WICKET_KEEPER", False),
        ("Rishabh Pant", "WICKET_KEEPER", False),
        ("Ravindra Jadeja", "ALL_ROUNDER", False),
        ("Hardik Pandya", "ALL_ROUNDER", False),
        ("Jasprit Bumrah", "BOWLER", False),
        ("Mohammed Siraj", "BOWLER", False),
        ("Yuzvendra Chahal", "BOWLER", False),
        ("Kuldeep Yadav", "BOWLER", False),
        ("Andre Russell", "ALL_ROUNDER", True),
        ("Sunil Narine", "ALL_ROUNDER", True),
        ("Rashid Khan", "BOWLER", True),
        ("Jos Buttler", "WICKET_KEEPER", True),
        ("Trent Boult", "BOWLER", True),
    ]
    out = []
    for nm, role, os_flag in names:
        cid = resolve_player_id(nm)
        assert cid is not None, f"Missing {nm}"
        out.append(SquadPlayerInput(player_id=cid, playing_role=role, is_overseas=os_flag))
    return out


def test_team_strength_and_playing_xi_ipl_rules():
    squad = _build_realistic_squad()
    ts = analyze_team_strength("room-test", "MI", squad)
    assert ts["allow_bidding_advice"] is False
    assert ts["squad_size"] == 15
    assert ts["overseas_compliance"] is True
    assert ts["overall_strength"] > 50.0
    assert ts["wicket_keeper_count"] >= 2

    xi = predict_playing_xi("room-test", "MI", squad, pitch_type="BALANCED")
    assert xi["is_prediction"] is True
    assert xi["rule_version"] == RULE_VERSION
    assert xi["allow_bidding_advice"] is False
    assert len(xi["playing_xi"]) == 11
    assert xi["overseas_count_in_xi"] <= 4
    assert xi["impact_player"] is not None
    assert xi["impact_player"] not in xi["playing_xi"]

    # If XI has all 4 overseas slots used, Impact Player MUST be domestic
    if xi["overseas_count_in_xi"] == 4:
        assert xi["impact_player_details"]["is_overseas"] is False

    # Squad < 11 cannot form a Playing XI -> ValueError / 422
    try:
        predict_playing_xi("room-test", "MI", squad[:8])
        assert False, "Expected ValueError for squad < 11"
    except ValueError:
        pass


def test_chronological_match_model_leakage_safety_and_symmetry():
    rows_full, _ = build_chronological_match_dataset()
    # Leakage cutoff invariance check: matches truncated before 2024 match_date produce bit-for-bit identical rows
    target_row = next(r for r in rows_full if r["season"] == 2024)
    rows_cut, _ = build_chronological_match_dataset(cutoff_date="2024-06-01")
    match_cut = next(r for r in rows_cut if r["match_id"] == target_row["match_id"])
    assert match_cut["features"] == target_row["features"]

    # Symmetry check: swapping home <-> away flips probabilities identically
    p1 = predict_match_outcome("CSK", "MI", venue="Wankhede Stadium")
    p2 = predict_match_outcome("MI", "CSK", venue="Wankhede Stadium")
    assert p1["calibrated"] is True
    assert p1["allow_bidding_advice"] is False
    assert abs((p1["home_win_probability"] + p1["away_win_probability"]) - 1.0) < 1e-3
    assert abs(p1["home_win_probability"] - p2["away_win_probability"]) < 1e-4


def test_phase6b_fastapi_endpoints_and_untrained_guardrails():
    registry.reload()
    vk_id = resolve_player_id("Virat Kohli")

    # 1. Advanced analytics endpoint
    r_adv = client.get(f"/v1/analytics/players/{vk_id}?scope=CAREER")
    assert r_adv.status_code == 200
    assert r_adv.json()["allow_bidding_advice"] is False
    assert r_adv.json()["stats"]["runs"] > 7000

    # 2. Rating & leaderboard endpoints
    r_lb = client.get("/v1/ratings/leaderboard?sort_by=overall_rating&limit=10")
    assert r_lb.status_code == 200
    assert len(r_lb.json()["players"]) == 10

    r_rat = client.post("/v1/ratings/player", json={"player_id": vk_id, "scope": "CAREER"})
    assert r_rat.status_code == 200
    assert r_rat.json()["batting_rating"] > 65.0

    # 3. Team strength & Playing XI endpoints
    squad_payload = [s.model_dump() for s in _build_realistic_squad()]
    r_ts = client.post("/v1/analysis/team-strength", json={"room_id": "r1", "franchise_code": "RCB", "squad": squad_payload})
    assert r_ts.status_code == 200
    assert r_ts.json()["allow_bidding_advice"] is False

    r_xi = client.post("/v1/predictions/playing-xi", json={"room_id": "r1", "franchise_code": "RCB", "squad": squad_payload})
    assert r_xi.status_code == 200
    assert len(r_xi.json()["playing_xi"]) == 11

    r_xi_bad = client.post("/v1/predictions/playing-xi", json={"room_id": "r1", "franchise_code": "RCB", "squad": squad_payload[:5]})
    assert r_xi_bad.status_code == 422

    # 4. Match predictor & metadata & evaluation endpoints
    r_meta = client.get("/v1/predictions/match/metadata")
    assert r_meta.status_code == 200
    assert "CSK" in r_meta.json()["teams"]

    r_mp = client.post("/v1/predictions/match", json={
        "home_franchise_code": "CSK",
        "away_franchise_code": "MI",
        "venue": "MA Chidambaram Stadium, Chepauk",
        "home_xi": [s["player_id"] for s in squad_payload[:11]],
        "away_xi": [s["player_id"] for s in squad_payload[4:]],
    })
    assert r_mp.status_code == 200
    assert r_mp.json()["allow_bidding_advice"] is False

    r_ev = client.get("/v1/models/MATCH_PRED/evaluation")
    assert r_ev.status_code == 200
    assert r_ev.json()["is_validated"] is True

    # 5. Untrained model must STILL return 503
    r_pm = client.post("/v1/analysis/post-match", json={
        "match_id": "m1", "home_franchise_code": "CSK", "away_franchise_code": "MI",
        "winner_franchise_code": "CSK", "innings_scores": {"CSK": 180, "MI": 170}
    })
    assert r_pm.status_code == 503


def test_ml_internal_auth_and_fail_closed(monkeypatch):
    # Public /health is scrubbed of model paths & metrics
    h = raw_client.get("/health")
    assert h.status_code == 200
    assert h.json() == {"status": "healthy", "service": "auctioncraze-ml", "allow_bidding_advice": False}

    # Protected /v1 routes reject missing or wrong internal key
    assert raw_client.get("/v1/models/health").status_code == 401
    assert raw_client.get("/v1/ratings/leaderboard", headers={"X-Internal-Service-Key": "wrong"}).status_code == 401
    assert raw_client.post("/v1/predictions/match", json={
        "home_franchise_code": "CSK", "away_franchise_code": "MI", "venue": "Wankhede Stadium"
    }).status_code == 401

    # Missing configured internal secret fails closed with 503
    monkeypatch.delenv("INTERNAL_ML_SERVICE_KEY", raising=False)
    r_fail = raw_client.get("/v1/ratings/leaderboard", headers={"X-Internal-Service-Key": "anything"})
    assert r_fail.status_code == 503
