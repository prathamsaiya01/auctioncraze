import os
from fastapi.testclient import TestClient

from app.main import app
from app.models.post_auction_report import build_post_auction_franchise_report
from app.pipelines.analytics_store import get_player_advanced_stats, load_players_index, resolve_player_id
from app.schemas.contracts import SquadPlayerInput

os.environ.setdefault("INTERNAL_ML_SERVICE_KEY", "test_internal_ml_secret_key_for_pytest_suite_64_chars_long")
client = TestClient(app, headers={"X-Internal-Service-Key": os.environ["INTERNAL_ML_SERVICE_KEY"]})


def _make_squad(names_with_roles):
    out = []
    for nm, role, is_os in names_with_roles:
        cid = resolve_player_id(nm)
        assert cid is not None, f"Missing player {nm}"
        out.append(SquadPlayerInput(player_id=cid, playing_role=role, is_overseas=is_os))
    return out


def test_post_auction_report_sufficiency_explanations_and_bench_cap():
    # 1. Empty squad -> NO_PLAYERS, overall_rating is None
    empty_rep = build_post_auction_franchise_report("r1", "CSK", [], min_squad_size=15)
    assert empty_rep["sufficiency_status"] == "NO_PLAYERS"
    assert empty_rep["has_sufficient_data"] is False
    assert empty_rep["team_ratings"]["overall_rating"] is None
    assert empty_rep["playing_xi_prediction"]["available"] is False

    # 2. Tiny 3-player squad -> INSUFFICIENT_DATA, no forced overall rating
    tiny = _make_squad([
        ("Virat Kohli", "BATSMAN", False),
        ("Jasprit Bumrah", "BOWLER", False),
        ("MS Dhoni", "WICKET_KEEPER", False),
    ])
    tiny_rep = build_post_auction_franchise_report("r1", "RCB", tiny, min_squad_size=15)
    assert tiny_rep["sufficiency_status"] == "INSUFFICIENT_DATA"
    assert tiny_rep["has_sufficient_data"] is False
    assert tiny_rep["team_ratings"]["overall_rating"] is None

    # 3. Realistic 15-player squad vs 20-player bloated squad with weaker extra bench players
    core_15 = _make_squad([
        ("Virat Kohli", "BATSMAN", False),
        ("Rohit Sharma", "BATSMAN", False),
        ("Suryakumar Yadav", "BATSMAN", False),
        ("Shubman Gill", "BATSMAN", False),
        ("MS Dhoni", "WICKET_KEEPER", False),
        ("Rishabh Pant", "WICKET_KEEPER", False),
        ("Ravindra Jadeja", "ALL_ROUNDER", False),
        ("Hardik Pandya", "ALL_ROUNDER", False),
        ("Axar Patel", "ALL_ROUNDER", False),
        ("Jasprit Bumrah", "BOWLER", False),
        ("Mohammed Siraj", "BOWLER", False),
        ("Yuzvendra Chahal", "BOWLER", False),
        ("Andre Russell", "ALL_ROUNDER", True),
        ("Rashid Khan", "BOWLER", True),
        ("Trent Boult", "BOWLER", True),
    ])
    # Adding 5 extra small-sample bench players must NOT inflate ANY team strength or overall score!
    players_idx, _ = load_players_index()
    bench_ids = []
    for cid, meta in players_idx.items():
        st = get_player_advanced_stats(cid).get("CAREER")
        if st and st["matches"] < 5 and meta["playing_role"] == "BATSMAN" and not meta["is_overseas"]:
            bench_ids.append(SquadPlayerInput(player_id=cid, playing_role="BATSMAN", is_overseas=False))
            if len(bench_ids) == 5:
                break
    assert len(bench_ids) == 5

    rep_15 = build_post_auction_franchise_report("r1", "MI", core_15, min_squad_size=15)
    rep_20 = build_post_auction_franchise_report("r1", "MI", core_15 + bench_ids, min_squad_size=15)

    assert rep_15["sufficiency_status"] == "SUFFICIENT"
    assert rep_15["has_sufficient_data"] is True
    assert rep_15["is_official_rating"] is False
    assert rep_15["allow_bidding_advice"] is False
    assert rep_15["playing_xi_prediction"]["available"] is True
    assert len(rep_15["playing_xi_prediction"]["playing_xi"]) == 11
    assert rep_15["playing_xi_prediction"]["overseas_count_in_xi"] <= 4
    assert len(rep_15["best_batters"]) >= 1
    assert len(rep_15["best_bowlers"]) >= 1
    assert len(rep_15["best_all_rounders"]) >= 1
    assert "batting_strength" in rep_15["score_explanations"]

    assert rep_20["squad_size"] == 20
    assert rep_20["team_ratings"] == rep_15["team_ratings"]


def test_post_auction_fastapi_endpoint_and_incomplete_squad():
    incomplete_11 = _make_squad([
        ("Virat Kohli", "BATSMAN", False),
        ("Rohit Sharma", "BATSMAN", False),
        ("Shubman Gill", "BATSMAN", False),
        ("MS Dhoni", "WICKET_KEEPER", False),
        ("Ravindra Jadeja", "ALL_ROUNDER", False),
        ("Hardik Pandya", "ALL_ROUNDER", False),
        ("Jasprit Bumrah", "BOWLER", False),
        ("Mohammed Siraj", "BOWLER", False),
        ("Kuldeep Yadav", "BOWLER", False),
        ("Jos Buttler", "WICKET_KEEPER", True),
        ("Rashid Khan", "BOWLER", True),
    ])

    res = client.post(
        "/v1/analysis/post-auction-franchise",
        json={
            "room_id": "room-6c",
            "franchise_code": "CSK",
            "squad": [s.model_dump() for s in incomplete_11],
            "min_squad_size": 15,
            "max_squad_size": 25,
            "max_overseas_in_squad": 8,
        },
    )
    assert res.status_code == 200
    body = res.json()
    assert body["sufficiency_status"] == "INCOMPLETE_SQUAD"
    assert any("Incomplete squad" in w for w in body["sample_size_warnings"])
    assert body["allow_bidding_advice"] is False
    assert body["playing_xi_prediction"]["is_prediction"] is True
