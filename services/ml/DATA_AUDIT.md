# AuctionCraze IPL Data Quality Audit Report

- **Dataset Fingerprint**: `c9af4153629ffb06`
- **Audit Script**: `services/ml/app/pipelines/data_audit.py`
- **Machine-Readable Artifact**: `services/ml/reports/data_audit_report.json`
- **Coverage Window**: 19 IPL Seasons (`2008`–`2026`), `1,243` Cricsheet matches, `809` unique IPL players, `3,354` player-season records.

---

## 1. Identity & Referential Integrity

| Audit Check | Observed Result | Notes |
| --- | --- | --- |
| Players with `cricsheetId` | `809 / 809` (`100%`) | Zero duplicate `cricsheetId` values |
| Duplicate `externalKey` | `0` | Unique constraint verified |
| Duplicate `cricinfoId` | `0` | Verified against Cricsheet `people.csv` |
| Same-name homonyms | `1` pair (`Harmeet Singh`) | Two genuine distinct cricketers (`2a72fd4f` India vs `0bf15e52` United States); keyed cleanly via `cricsheetId` |
| Unexpanded initial names | `27` | Includes recognized initialisms (`MS Dhoni`, `KL Rahul`) and 27 Cricsheet-only entries without Wikipedia sitelinks |
| Orphan player-season rows | `0` | Every season record maps to an active `MasterPlayer` |
| Duplicate `(cricsheetId, season)` rows | `0` | Exact season granularity |
| `iplDebutYear` / `iplLastYear` mismatches | `0` | Verified against min/max active season per player |
| Numeric / domain violations | `0` | No negative counts, `innings <= matches`, `highestScore <= runs`, `notOuts <= battingInnings` |

---

## 2. Provenance Breakdown

| Provenance Source | Players | Share |
| --- | ---: | ---: |
| `cricsheet+wikidata+wikipedia` | 778 | 96.17% |
| `cricsheet` | 27 | 3.34% |
| `cricsheet+wikidata` | 4 | 0.49% |

---

## 3. Missing Biographical Information (Preserved as `null`)

| Field | Missing Count | Missing Rate |
| --- | ---: | ---: |
| `cricinfoId` | 0 | 0.00% |
| `dateOfBirth` / `age` | 33 | 4.08% |
| `battingStyle` | 39 | 4.82% |
| `nationality` | 54 | 6.67% |
| `bowlingStyle` | 69 | 8.53% |
| `imageUrl` | 440 | 54.39% |
| `secondaryRole` | 678 | 83.81% |

---

## 4. Missing & Inapplicable Season Statistics (Zero-Imputation Prevented)

Unrecorded or mathematically undefined metrics are strictly stored as `null`/`NaN` rather than fabricated `0.0`:

- `nullRuns_didNotBat`: `397` player-seasons (player named in Playing XI / bowled/fielded only)
- `nullBattingAverage_zeroDismissals`: `694` player-seasons (includes players not dismissed across the season)
- `nullStrikeRate_zeroBallsFaced`: `397` player-seasons
- `nullWickets_didNotBowl`, `nullEconomy_zeroLegalBalls`, `nullBestBowling_didNotBowl`: `1,154` player-seasons
- `nullBowlingAverage_zeroWickets`, `nullBowlingStrikeRate_zeroWickets`: `1,542` player-seasons
- **Small-sample statistical outliers flagged (informational)**: `17` records with `<= 6` balls faced (`strikeRate >= 350`) or `<= 6` balls bowled (`economy >= 24.0`, max `36.0` from a 1-ball 6-run spell). Modeling datasets enforce minimum match and prior innings thresholds to avoid fitting small-sample noise.

---

## 5. Season Coverage Summary (2008–2026)

- **Matches recorded per season**: `57`–`76` (`2008`: 58, `2009`: 57, `2010`: 60, `2011`: 73, `2012`: 74, `2013`: 76, `2014`: 60, `2015`: 59, `2016`: 60, `2017`: 59, `2018`–`2021`: 60, `2022`–`2023`: 74, `2024`: 71 [3 washed-out no-ball matches omitted from ball-by-ball archive], `2025`: 74, `2026`: 74).
- **Multi-team intra-season switches**: `0` rows containing `|` inside a single season.

---

## 6. Reproducibility

```bash
cd services/ml
python -m app.pipelines.data_audit
```
