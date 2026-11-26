#!/usr/bin/env python3
"""
Phase 6A — Data Quality Audit Pipeline for AuctionCraze IPL Datasets.

Audits:
- Player identity consistency & duplicate/alias detection
- Missing biographical attributes (null preservation check)
- Statistical consistency & missing/inapplicable metrics
- Season coverage (including partial/active seasons from Cricsheet raw archive if available)
- Player-season referential integrity & multi-team intra-season switches
- Outliers / edge cases & provenance coverage

Produces machine-readable JSON report at services/ml/reports/data_audit_report.json.
"""
import csv
import hashlib
import json
import re
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

ML_ROOT = Path(__file__).resolve().parents[2]
PROCESSED_DIR = ML_ROOT / "data" / "processed"
RAW_DIR = ML_ROOT / "data" / "raw"
REPORTS_DIR = ML_ROOT / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)


def compute_dataset_fingerprint() -> str:
    """Deterministic SHA-256 fingerprint across processed players and season CSV files."""
    h = hashlib.sha256()
    for fname in ("ipl_players.csv", "ipl_season_stats.csv"):
        p = PROCESSED_DIR / fname
        if p.exists():
            h.update(fname.encode("utf-8"))
            h.update(p.read_bytes())
    return h.hexdigest()[:16]


def _is_blank(val: Optional[str]) -> bool:
    return val is None or val.strip() == ""


def _to_int(val: Optional[str]) -> Optional[int]:
    if _is_blank(val):
        return None
    return int(val.strip())  # type: ignore[union-attr]


def _to_float(val: Optional[str]) -> Optional[float]:
    if _is_blank(val):
        return None
    return float(val.strip())  # type: ignore[union-attr]


def _normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def run_data_audit(write_report: bool = True) -> Dict[str, Any]:
    players_path = PROCESSED_DIR / "ipl_players.csv"
    seasons_path = PROCESSED_DIR / "ipl_season_stats.csv"
    manifest_path = PROCESSED_DIR / "provenance_manifest.json"

    if not players_path.exists() or not seasons_path.exists():
        raise FileNotFoundError("Processed IPL CSV files not found in services/ml/data/processed/")

    with open(players_path, encoding="utf-8") as f:
        players = list(csv.DictReader(f))
    with open(seasons_path, encoding="utf-8") as f:
        season_stats = list(csv.DictReader(f))

    manifest = (
        json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest_path.exists()
        else {}
    )

    # 1. Identity & Duplicate Audit
    cricsheet_counts = Counter(p["cricsheetId"] for p in players if not _is_blank(p.get("cricsheetId")))
    ext_key_counts = Counter(p["externalKey"] for p in players if not _is_blank(p.get("externalKey")))
    cricinfo_counts = Counter(p["cricinfoId"] for p in players if not _is_blank(p.get("cricinfoId")))
    norm_name_groups: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for p in players:
        norm_name_groups[_normalize_name(p["fullName"])].append(p)

    duplicate_cricsheet_ids = [k for k, v in cricsheet_counts.items() if v > 1]
    duplicate_external_keys = [k for k, v in ext_key_counts.items() if v > 1]
    duplicate_cricinfo_ids = [
        {"cricinfoId": k, "players": [p["fullName"] for p in players if p.get("cricinfoId") == k]}
        for k, v in cricinfo_counts.items()
        if v > 1
    ]
    duplicate_norm_names = [
        {
            "normalizedName": norm,
            "entries": [
                {"cricsheetId": p["cricsheetId"], "fullName": p["fullName"], "nationality": p["nationality"] or None}
                for p in grp
            ],
        }
        for norm, grp in norm_name_groups.items()
        if len(grp) > 1
    ]
    unexpanded_initials = [
        p["fullName"]
        for p in players
        if re.match(r"^[A-Z]{1,3}\s+[A-Za-z-]+$", p["fullName"].strip())
    ]

    # 2. Missing Biographical Metadata
    total_players = len(players)
    missing_bio = {
        "missingNationality": sum(1 for p in players if _is_blank(p.get("nationality"))),
        "missingDateOfBirth": sum(1 for p in players if _is_blank(p.get("dateOfBirth"))),
        "missingAge": sum(1 for p in players if _is_blank(p.get("age"))),
        "missingBattingStyle": sum(1 for p in players if _is_blank(p.get("battingStyle"))),
        "missingBowlingStyle": sum(1 for p in players if _is_blank(p.get("bowlingStyle"))),
        "missingSecondaryRole": sum(1 for p in players if _is_blank(p.get("secondaryRole"))),
        "missingImageUrl": sum(1 for p in players if _is_blank(p.get("imageUrl"))),
        "missingCricinfoId": sum(1 for p in players if _is_blank(p.get("cricinfoId"))),
    }

    provenance_breakdown = Counter(p.get("provenanceSource") or "unknown" for p in players)
    role_breakdown = Counter(p.get("playingRole") or "unknown" for p in players)

    # 3. Statistical Integrity & Null Preservation Audit
    player_ids_set = set(cricsheet_counts.keys())
    pair_counts = Counter((s["cricsheetId"], s["season"]) for s in season_stats)
    duplicate_player_seasons = [f"{k[0]}:{k[1]}" for k, v in pair_counts.items() if v > 1]
    orphan_season_rows = [s for s in season_stats if s["cricsheetId"] not in player_ids_set]

    stat_null_counts = {
        "nullRuns_didNotBat": 0,
        "nullBattingAverage_zeroDismissals": 0,
        "nullStrikeRate_zeroBallsFaced": 0,
        "nullWickets_didNotBowl": 0,
        "nullBowlingAverage_zeroWickets": 0,
        "nullEconomy_zeroLegalBalls": 0,
        "nullBowlingStrikeRate_zeroWickets": 0,
        "nullBestBowling_didNotBowl": 0,
    }

    consistency_violations: List[Dict[str, Any]] = []
    suspicious_outliers: List[Dict[str, Any]] = []
    multi_team_season_rows = 0

    seasons_per_player: Dict[str, List[int]] = defaultdict(list)
    season_summary: Dict[int, Dict[str, int]] = defaultdict(
        lambda: {"players": 0, "totalRuns": 0, "totalWickets": 0}
    )

    for idx, s in enumerate(season_stats):
        pid = s["cricsheetId"]
        season = _to_int(s.get("season"))
        if season is not None:
            seasons_per_player[pid].append(season)
            season_summary[season]["players"] += 1

        if s.get("teamCode") and "|" in s["teamCode"]:
            multi_team_season_rows += 1

        matches = _to_int(s.get("matches")) or 0
        bat_inn = _to_int(s.get("battingInnings")) or 0
        bowl_inn = _to_int(s.get("bowlingInnings")) or 0
        runs = _to_int(s.get("runs"))
        balls_faced = _to_int(s.get("ballsFaced"))
        not_outs = _to_int(s.get("notOuts"))
        hs = _to_int(s.get("highestScore"))
        bat_avg = _to_float(s.get("battingAverage"))
        sr = _to_float(s.get("strikeRate"))
        fifties = _to_int(s.get("fifties"))
        hundreds = _to_int(s.get("hundreds"))

        wickets = _to_int(s.get("wickets"))
        balls_bowled = _to_int(s.get("ballsBowled"))
        runs_conceded = _to_int(s.get("runsConceded"))
        bowl_avg = _to_float(s.get("bowlingAverage"))
        econ = _to_float(s.get("economy"))
        bowl_sr = _to_float(s.get("bowlingStrikeRate"))
        best_bowl = s.get("bestBowling") or ""
        catches = _to_int(s.get("catches")) or 0
        stumpings = _to_int(s.get("stumpings")) or 0

        if season is not None:
            if runs is not None:
                season_summary[season]["totalRuns"] += runs
            if wickets is not None:
                season_summary[season]["totalWickets"] += wickets

        if runs is None:
            stat_null_counts["nullRuns_didNotBat"] += 1
        if bat_avg is None:
            stat_null_counts["nullBattingAverage_zeroDismissals"] += 1
        if sr is None:
            stat_null_counts["nullStrikeRate_zeroBallsFaced"] += 1
        if wickets is None:
            stat_null_counts["nullWickets_didNotBowl"] += 1
        if bowl_avg is None:
            stat_null_counts["nullBowlingAverage_zeroWickets"] += 1
        if econ is None:
            stat_null_counts["nullEconomy_zeroLegalBalls"] += 1
        if bowl_sr is None:
            stat_null_counts["nullBowlingStrikeRate_zeroWickets"] += 1
        if _is_blank(best_bowl):
            stat_null_counts["nullBestBowling_didNotBowl"] += 1

        # Negative or logical violations
        numeric_fields = [
            matches, bat_inn, bowl_inn, runs, balls_faced, not_outs, hs,
            fifties, hundreds, wickets, balls_bowled, runs_conceded, catches, stumpings
        ]
        if any(v is not None and v < 0 for v in numeric_fields):
            consistency_violations.append({"row": idx + 2, "cricsheetId": pid, "issue": "Negative numeric value"})
        if bat_inn > matches or bowl_inn > matches:
            consistency_violations.append({"row": idx + 2, "cricsheetId": pid, "season": season, "issue": "Innings exceed matches"})
        if runs is not None and hs is not None and hs > runs:
            consistency_violations.append({"row": idx + 2, "cricsheetId": pid, "season": season, "issue": "Highest score exceeds total runs"})
        if not_outs is not None and not_outs > bat_inn:
            consistency_violations.append({"row": idx + 2, "cricsheetId": pid, "season": season, "issue": "Not outs exceed batting innings"})

        # Verify zero-dismissal average isn't invented as 0.0
        if bat_inn > 0 and not_outs is not None and (bat_inn - not_outs) == 0 and bat_avg is not None:
            consistency_violations.append({"row": idx + 2, "cricsheetId": pid, "season": season, "issue": "Batting avg populated despite 0 dismissals"})
        if wickets == 0 and (bowl_avg is not None or bowl_sr is not None):
            consistency_violations.append({"row": idx + 2, "cricsheetId": pid, "season": season, "issue": "Bowling avg/SR populated despite 0 wickets"})

        # Suspicious small-sample / outlier flags (informational, NOT errors)
        if sr is not None and sr >= 350.0 and (balls_faced or 0) <= 6:
            suspicious_outliers.append({
                "kind": "TINY_SAMPLE_STRIKE_RATE",
                "cricsheetId": pid,
                "season": season,
                "runs": runs,
                "ballsFaced": balls_faced,
                "strikeRate": sr,
            })
        if econ is not None and econ >= 24.0 and (balls_bowled or 0) <= 6:
            suspicious_outliers.append({
                "kind": "TINY_SAMPLE_ECONOMY",
                "cricsheetId": pid,
                "season": season,
                "ballsBowled": balls_bowled,
                "runsConceded": runs_conceded,
                "economy": econ,
            })

    # Verify debut/last year accuracy against season_stats
    debut_last_mismatches = []
    for p in players:
        pid = p["cricsheetId"]
        played_seasons = seasons_per_player.get(pid, [])
        if not played_seasons:
            debut_last_mismatches.append({"cricsheetId": pid, "issue": "Player has zero season rows"})
            continue
        d_yr = _to_int(p.get("iplDebutYear"))
        l_yr = _to_int(p.get("iplLastYear"))
        if d_yr != min(played_seasons) or l_yr != max(played_seasons):
            debut_last_mismatches.append({
                "cricsheetId": pid,
                "recordedDebut": d_yr,
                "actualMin": min(played_seasons),
                "recordedLast": l_yr,
                "actualMax": max(played_seasons),
            })

    # Raw archive match count breakdown per season (if available locally)
    matches_per_season: Dict[int, int] = defaultdict(int)
    raw_zip = RAW_DIR / "ipl_json.zip"
    if raw_zip.exists():
        with zipfile.ZipFile(raw_zip) as z:
            for fname in z.namelist():
                if not fname.endswith(".json"):
                    continue
                d = json.loads(z.read(fname))
                info = d.get("info", {})
                s_raw = str(info.get("season") or "")
                dates = info.get("dates") or ["2008-01-01"]
                if s_raw == "2007/08":
                    yr = 2008
                elif s_raw == "2009/10":
                    yr = 2010
                elif s_raw == "2020/21":
                    yr = 2020
                else:
                    m = re.match(r"^(\d{4})", s_raw)
                    yr = int(m.group(1)) if m else int(dates[0][:4])
                matches_per_season[yr] += 1

    season_coverage_table = []
    for yr in sorted(season_summary.keys()):
        season_coverage_table.append({
            "season": yr,
            "matchesRecorded": matches_per_season.get(yr) if matches_per_season else None,
            "activePlayers": season_summary[yr]["players"],
            "totalRuns": season_summary[yr]["totalRuns"],
            "totalWickets": season_summary[yr]["totalWickets"],
        })

    report = {
        "auditedAtUtc": datetime.now(timezone.utc).isoformat(),
        "datasetFingerprint": compute_dataset_fingerprint(),
        "summary": {
            "totalPlayers": total_players,
            "totalPlayerSeasons": len(season_stats),
            "distinctSeasons": len(season_coverage_table),
            "seasonRange": (
                f"{season_coverage_table[0]['season']}-{season_coverage_table[-1]['season']}"
                if season_coverage_table
                else None
            ),
            "totalRawMatchesProcessed": sum(matches_per_season.values()) if matches_per_season else manifest.get("sources", [{}])[0].get("matchFilesProcessed"),
            "allPlayersHaveCricsheetId": len(cricsheet_counts) == total_players and len(duplicate_cricsheet_ids) == 0,
            "integrityPassed": (
                len(duplicate_cricsheet_ids) == 0
                and len(duplicate_external_keys) == 0
                and len(duplicate_player_seasons) == 0
                and len(orphan_season_rows) == 0
                and len(consistency_violations) == 0
                and len(debut_last_mismatches) == 0
            ),
        },
        "identityAudit": {
            "duplicateCricsheetIds": duplicate_cricsheet_ids,
            "duplicateExternalKeys": duplicate_external_keys,
            "duplicateCricinfoIdsCount": len(duplicate_cricinfo_ids),
            "duplicateCricinfoIds": duplicate_cricinfo_ids[:20],
            "duplicateNormalizedNamesCount": len(duplicate_norm_names),
            "duplicateNormalizedNames": duplicate_norm_names[:20],
            "unexpandedInitialNamesCount": len(unexpanded_initials),
            "unexpandedInitialNamesSample": unexpanded_initials[:15],
        },
        "biographicalCompleteness": {
            "totalPlayers": total_players,
            "missingCounts": missing_bio,
            "missingRatesPct": {
                k: round((v * 100.0) / total_players, 2) if total_players else 0.0
                for k, v in missing_bio.items()
            },
            "provenanceSources": dict(provenance_breakdown),
            "roleDistribution": dict(role_breakdown),
        },
        "statisticsIntegrity": {
            "duplicatePlayerSeasons": duplicate_player_seasons,
            "orphanSeasonRows": len(orphan_season_rows),
            "debutLastMismatches": debut_last_mismatches,
            "consistencyViolations": consistency_violations,
            "multiTeamIntraSeasonRows": multi_team_season_rows,
            "preservedNullCounts": stat_null_counts,
            "smallSampleOutlierCount": len(suspicious_outliers),
            "smallSampleOutliersSample": suspicious_outliers[:15],
        },
        "seasonCoverage": season_coverage_table,
    }

    if write_report:
        out_path = REPORTS_DIR / "data_audit_report.json"
        out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    return report


if __name__ == "__main__":
    rep = run_data_audit(write_report=True)
    print(json.dumps({
        "datasetFingerprint": rep["datasetFingerprint"],
        "summary": rep["summary"],
        "identityAuditCounts": {
            "dupCricsheet": len(rep["identityAudit"]["duplicateCricsheetIds"]),
            "dupCricinfo": rep["identityAudit"]["duplicateCricinfoIdsCount"],
            "dupNormNames": rep["identityAudit"]["duplicateNormalizedNamesCount"],
            "unexpandedInitials": rep["identityAudit"]["unexpandedInitialNamesCount"],
        },
        "missingRatesPct": rep["biographicalCompleteness"]["missingRatesPct"],
        "provenanceSources": rep["biographicalCompleteness"]["provenanceSources"],
        "integrityViolations": len(rep["statisticsIntegrity"]["consistencyViolations"]),
        "outliers": rep["statisticsIntegrity"]["smallSampleOutlierCount"],
        "last3Seasons": rep["seasonCoverage"][-3:],
    }, indent=2))
