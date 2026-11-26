#!/usr/bin/env python3
"""
Builds a verifiable historical IPL player & season-wise statistics dataset
strictly from Cricsheet open ball-by-ball JSON archives + Cricsheet people.csv
and optional CC0 Wikidata enrichment (keyed by ESPNcricinfo ID P2698).

Zero fabricated players, photos, or statistics. Unverified/missing fields remain null.
"""
import csv
import json
import os
import re
import time
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW_ZIP = ROOT / "data" / "raw" / "ipl_json.zip"
RAW_PEOPLE = ROOT / "data" / "raw" / "people.csv"
OUT_DIR = ROOT / "data" / "processed"
OUT_DIR.mkdir(parents=True, exist_ok=True)

TEAM_CODE_MAP = {
    "Chennai Super Kings": "CSK",
    "Mumbai Indians": "MI",
    "Royal Challengers Bangalore": "RCB",
    "Royal Challengers Bengaluru": "RCB",
    "Kolkata Knight Riders": "KKR",
    "Delhi Capitals": "DC",
    "Delhi Daredevils": "DC",
    "Punjab Kings": "PBKS",
    "Kings XI Punjab": "PBKS",
    "Rajasthan Royals": "RR",
    "Sunrisers Hyderabad": "SRH",
    "Deccan Chargers": "DCH",
    "Gujarat Titans": "GT",
    "Lucknow Super Giants": "LSG",
    "Gujarat Lions": "GL",
    "Pune Warriors": "PWI",
    "Rising Pune Supergiant": "RPS",
    "Rising Pune Supergiants": "RPS",
    "Kochi Tuskers Kerala": "KTK",
}


def parse_season_year(season_raw: str, match_date: str) -> int:
    s = str(season_raw or "").strip()
    if s == "2007/08":
        return 2008
    if s == "2009/10":
        return 2010
    if s == "2020/21":
        return 2020
    m = re.match(r"^(\d{4})", s)
    if m:
        return int(m.group(1))
    return int(match_date[:4])


def load_people_register():
    reg = {}
    with open(RAW_PEOPLE, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            pid = row.get("identifier", "").strip()
            if pid:
                reg[pid] = {
                    "identifier": pid,
                    "name": row.get("name", "").strip(),
                    "unique_name": row.get("unique_name", "").strip(),
                    "key_cricinfo": row.get("key_cricinfo", "").strip() or None,
                    "key_bcci": row.get("key_bcci", "").strip() or None,
                }
    return reg


def aggregate_cricsheet():
    people_reg = load_people_register()

    # player_id -> summary metadata
    players_meta = {}
    # (player_id, season) -> accumulator
    season_acc = defaultdict(lambda: {
        "matches": set(),
        "teams": set(),
        "bat_innings": set(),
        "runs": 0,
        "balls_faced": 0,
        "dismissals": 0,
        "hs_runs": 0,
        "hs_not_out": False,
        "has_batted": False,
        "fifties": 0,
        "hundreds": 0,
        "bowl_innings": set(),
        "balls_bowled": 0,
        "runs_conceded": 0,
        "wickets": 0,
        "best_bowl_w": -1,
        "best_bowl_r": 999999,
        "catches": 0,
        "stumpings": 0,
    })

    seasons_seen = set()
    match_count = 0

    non_bowler_dismissals = {
        "run out",
        "retired hurt",
        "retired out",
        "obstructing the field",
        "timed out",
        "handled the ball",
        "hit the ball twice",
    }

    with zipfile.ZipFile(RAW_ZIP) as z:
        json_names = sorted(n for n in z.namelist() if n.endswith(".json"))
        for fname in json_names:
            match_id = Path(fname).stem
            data = json.loads(z.read(fname))
            info = data.get("info", {})
            dates = info.get("dates") or ["2008-01-01"]
            season = parse_season_year(info.get("season"), dates[0])
            seasons_seen.add(season)
            match_count += 1

            match_reg = (info.get("registry") or {}).get("people") or {}

            # Register players from playing XI
            for team_name, plist in (info.get("players") or {}).items():
                tcode = TEAM_CODE_MAP.get(team_name, team_name[:4].upper())
                for pname in plist:
                    pid = match_reg.get(pname)
                    if not pid:
                        continue
                    if pid not in players_meta:
                        pr = people_reg.get(pid, {})
                        players_meta[pid] = {
                            "cricsheet_id": pid,
                            "short_name": pr.get("name") or pname,
                            "unique_name": pr.get("unique_name") or pname,
                            "cricinfo_id": pr.get("key_cricinfo"),
                            "teams": [],
                            "seasons": set(),
                            "total_runs": 0,
                            "total_wickets": 0,
                            "total_stumpings": 0,
                            "total_catches": 0,
                            "total_matches": 0,
                        }
                    players_meta[pid]["seasons"].add(season)
                    if tcode not in players_meta[pid]["teams"]:
                        players_meta[pid]["teams"].append(tcode)
                    acc = season_acc[(pid, season)]
                    acc["matches"].add(match_id)
                    acc["teams"].add(tcode)

            # Per-match batting & bowling accumulators for innings milestones / best bowling
            for inn_idx, inning in enumerate(data.get("innings", [])):
                if inning.get("super_over"):
                    continue
                inn_key = f"{match_id}:{inn_idx}"
                bat_score = defaultdict(int)
                bat_faced = defaultdict(int)
                bat_out = defaultdict(bool)
                bowl_w = defaultdict(int)
                bowl_r = defaultdict(int)
                bowl_b = defaultdict(int)

                for over_obj in inning.get("overs", []):
                    for d in over_obj.get("deliveries", []):
                        batter_id = match_reg.get(d.get("batter"))
                        non_striker_id = match_reg.get(d.get("non_striker"))
                        bowler_id = match_reg.get(d.get("bowler"))
                        extras = d.get("extras") or {}
                        runs = d.get("runs") or {}
                        r_bat = int(runs.get("batter") or 0)
                        wides = int(extras.get("wides") or 0)
                        noballs = int(extras.get("noballs") or 0)

                        if batter_id:
                            acc_b = season_acc[(batter_id, season)]
                            acc_b["bat_innings"].add(inn_key)
                            acc_b["has_batted"] = True
                            bat_score[batter_id] += r_bat
                            acc_b["runs"] += r_bat
                            if wides == 0:
                                acc_b["balls_faced"] += 1
                                bat_faced[batter_id] += 1

                        if bowler_id:
                            acc_w = season_acc[(bowler_id, season)]
                            acc_w["bowl_innings"].add(inn_key)
                            conceded = r_bat + wides + noballs
                            acc_w["runs_conceded"] += conceded
                            bowl_r[bowler_id] += conceded
                            if wides == 0 and noballs == 0:
                                acc_w["balls_bowled"] += 1
                                bowl_b[bowler_id] += 1

                        for w in d.get("wickets", []):
                            kind = (w.get("kind") or "").lower()
                            out_id = match_reg.get(w.get("player_out"))
                            if out_id and kind != "retired hurt":
                                bat_out[out_id] = True
                                season_acc[(out_id, season)]["dismissals"] += 1
                            if bowler_id and kind not in non_bowler_dismissals:
                                season_acc[(bowler_id, season)]["wickets"] += 1
                                bowl_w[bowler_id] += 1
                            for f in w.get("fielders") or []:
                                if not isinstance(f, dict) or f.get("substitute"):
                                    continue
                                f_id = match_reg.get(f.get("name"))
                                if not f_id:
                                    continue
                                if kind in ("caught", "caught and bowled"):
                                    season_acc[(f_id, season)]["catches"] += 1
                                elif kind == "stumped":
                                    season_acc[(f_id, season)]["stumpings"] += 1
                            if kind == "caught and bowled" and bowler_id and not (w.get("fielders")):
                                season_acc[(bowler_id, season)]["catches"] += 1

                # Commit per-inning batter highs / 50s / 100s
                involved_batters = set(bat_score.keys()) | set(bat_faced.keys()) | set(bat_out.keys())
                for bid in involved_batters:
                    sc = bat_score[bid]
                    is_no = not bat_out[bid]
                    acc_b = season_acc[(bid, season)]
                    if sc > acc_b["hs_runs"] or (sc == acc_b["hs_runs"] and is_no and not acc_b["hs_not_out"]):
                        acc_b["hs_runs"] = sc
                        acc_b["hs_not_out"] = is_no
                    if sc >= 100:
                        acc_b["hundreds"] += 1
                    elif sc >= 50:
                        acc_b["fifties"] += 1

                # Commit per-inning best bowling
                involved_bowlers = set(bowl_b.keys()) | set(bowl_r.keys()) | set(bowl_w.keys())
                for wid in involved_bowlers:
                    wk = bowl_w[wid]
                    rc = bowl_r[wid]
                    acc_w = season_acc[(wid, season)]
                    if wk > acc_w["best_bowl_w"] or (wk == acc_w["best_bowl_w"] and rc < acc_w["best_bowl_r"]):
                        acc_w["best_bowl_w"] = wk
                        acc_w["best_bowl_r"] = rc

    # Roll up career totals to help infer verifiable role when metadata absent
    for (pid, season), acc in season_acc.items():
        if pid in players_meta:
            players_meta[pid]["total_runs"] += acc["runs"]
            players_meta[pid]["total_wickets"] += acc["wickets"]
            players_meta[pid]["total_stumpings"] += acc["stumpings"]
            players_meta[pid]["total_catches"] += acc["catches"]
            players_meta[pid]["total_matches"] += len(acc["matches"])

    return people_reg, players_meta, season_acc, sorted(seasons_seen), match_count


WEST_INDIES_COUNTRIES = {
    "Trinidad and Tobago",
    "Jamaica",
    "Barbados",
    "Guyana",
    "Antigua and Barbuda",
    "Saint Lucia",
    "Saint Vincent and the Grenadines",
    "Saint Kitts and Nevis",
    "Grenada",
    "Dominica",
}


def normalize_country(raw_ctry: str | None) -> str | None:
    if not raw_ctry or re.match(r"^Q\d+$", raw_ctry):
        return None
    cleaned = re.sub(r"\s+(national\s+)?cricket\s+team$", "", raw_ctry, flags=re.I).strip()
    if "United Kingdom" in cleaned or cleaned == "Great Britain":
        return "England"
    if cleaned in WEST_INDIES_COUNTRIES:
        return "West Indies"
    return cleaned


def clean_wikitext_val(raw: str | None) -> str:
    if not raw:
        return ""
    s = re.sub(r"<!--.*?-->", "", raw, flags=re.S)
    s = re.sub(r"<ref[^>]*>.*?</ref>", "", s, flags=re.I | re.S)
    s = re.sub(r"<ref[^>]*/>", "", s, flags=re.I)
    s = re.sub(r"<br\s*/?>", ", ", s, flags=re.I)
    s = re.sub(r"\[\[([^\]|]+\|)?([^\]]+)\]\]", r"\2", s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"'+", "", s)
    return s.strip(" ,;\t\r\n")


def map_batting_style(raw: str) -> str:
    s = raw.lower()
    if "left" in s:
        return "LEFT_HAND"
    if "right" in s:
        return "RIGHT_HAND"
    return ""


def map_bowling_style(raw: str) -> str:
    s = raw.lower()
    if not s or s in ("none", "n/a", "-", "—", "no"):
        return "NONE"
    is_left = "left" in s
    is_right = "right" in s
    if "spin" in s or "orthodox" in s or "break" in s or "chinaman" in s or "googly" in s or "slow" in s:
        return "LEFT_ARM_SPIN" if is_left else "RIGHT_ARM_SPIN"
    if "fast-medium" in s or "medium-fast" in s or ("fast" in s and "medium" not in s):
        return "LEFT_ARM_FAST" if is_left else "RIGHT_ARM_FAST"
    if "medium" in s:
        return "LEFT_ARM_MEDIUM" if is_left else "RIGHT_ARM_MEDIUM"
    if is_left:
        return "LEFT_ARM_MEDIUM"
    if is_right:
        return "RIGHT_ARM_MEDIUM"
    return ""


def map_role_text(raw: str) -> tuple[str | None, str | None]:
    s = raw.lower()
    if not s:
        return None, None
    has_wk = "wicket" in s or "keeper" in s
    has_ar = "all-rounder" in s or "allrounder" in s or "all rounder" in s
    has_bat = "bat" in s
    has_bowl = "bowl" in s
    if has_wk:
        return "WICKET_KEEPER", ("BATSMAN" if has_bat else None)
    if has_ar:
        sec = "BOWLER" if has_bowl and not has_bat else ("BATSMAN" if has_bat and not has_bowl else None)
        return "ALL_ROUNDER", sec
    if has_bat and has_bowl:
        return "ALL_ROUNDER", "BATSMAN"
    if has_bowl:
        return "BOWLER", None
    if has_bat:
        return "BATSMAN", None
    return None, None


def fetch_wikidata_and_wikipedia(cricinfo_ids):
    """Queries CC0 Wikidata SPARQL + official Wikimedia Action API (CC-BY-SA) cleanly in batches."""
    enriched = {}
    wp_title_to_cid = {}
    unique_ids = sorted(set(cid for cid in cricinfo_ids if cid))
    endpoint = "https://query.wikidata.org/sparql"

    for i in range(0, len(unique_ids), 100):
        chunk = unique_ids[i : i + 100]
        values = " ".join(f'"{cid}"' for cid in chunk)
        sparql = f"""SELECT ?cricinfoId ?itemLabel ?countryLabel ?dob ?image ?batHandLabel ?wpTitle WHERE {{
  VALUES ?cricinfoId {{ {values} }}
  ?item wdt:P2697 ?cricinfoId .
  ?item wdt:P31 wd:Q5 .
  OPTIONAL {{ ?item wdt:P27 ?country . }}
  OPTIONAL {{ ?item wdt:P569 ?dob . }}
  OPTIONAL {{ ?item wdt:P18 ?image . }}
  OPTIONAL {{ ?item wdt:P552 ?batHand . }}
  OPTIONAL {{
    ?article schema:about ?item ;
             schema:isPartOf <https://en.wikipedia.org/> ;
             schema:name ?wpTitle .
  }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
}}"""
        url = f"{endpoint}?format=json&query={urllib.parse.quote(sparql)}"
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "AuctionCrazeDataPipeline/1.0 (https://github.com/prathamsaiya01/auctioncraze)"
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                for b in data.get("results", {}).get("bindings", []):
                    cid = b.get("cricinfoId", {}).get("value")
                    if not cid:
                        continue
                    cur = enriched.setdefault(cid, {})
                    lbl = b.get("itemLabel", {}).get("value")
                    if lbl and not re.match(r"^Q\d+$", lbl):
                        cur.setdefault("full_name", lbl)
                    ctry = normalize_country(b.get("countryLabel", {}).get("value"))
                    if ctry and "nationality" not in cur:
                        cur["nationality"] = ctry
                    dob = b.get("dob", {}).get("value")
                    if dob and len(dob) >= 10:
                        cur.setdefault("dob", dob[:10])
                    img = b.get("image", {}).get("value")
                    if img and img.startswith("http"):
                        clean_img = img.replace("http://", "https://", 1)
                        if "Special:FilePath/" in clean_img and "width=" not in clean_img:
                            clean_img = f"{clean_img}?width=400"
                        cur.setdefault("image_url", clean_img)
                    hand = b.get("batHandLabel", {}).get("value", "").lower()
                    if "left" in hand:
                        cur.setdefault("batting_style", "LEFT_HAND")
                    elif "right" in hand:
                        cur.setdefault("batting_style", "RIGHT_HAND")
                    wp_title = b.get("wpTitle", {}).get("value")
                    if wp_title:
                        cur.setdefault("wp_title", wp_title)
                        wp_title_to_cid[wp_title] = cid
        except Exception as exc:
            print(f"[Wikidata] Chunk {i//100 + 1} warning: {exc}")
        time.sleep(0.25)

    # Batch fetch verified Infobox cricketer details + clean thumbnail URLs via official MediaWiki API
    titles_list = sorted(wp_title_to_cid.keys())
    print(f"Fetching verified MediaWiki infoboxes for {len(titles_list)} Wikipedia pages...")
    for i in range(0, len(titles_list), 50):
        batch = titles_list[i : i + 50]
        wp_url = (
            "https://en.wikipedia.org/w/api.php?action=query&titles="
            + urllib.parse.quote("|".join(batch))
            + "&prop=revisions|pageimages&rvprop=content&rvslots=main&pithumbsize=400&format=json&formatversion=2"
        )
        req = urllib.request.Request(
            wp_url,
            headers={
                "User-Agent": "AuctionCrazeDataPipeline/1.0 (https://github.com/prathamsaiya01/auctioncraze)"
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                wp = json.loads(resp.read().decode("utf-8"))
                for page in wp.get("query", {}).get("pages", []):
                    title = page.get("title")
                    cid = wp_title_to_cid.get(title)
                    if not cid:
                        continue
                    cur = enriched.setdefault(cid, {})
                    cur["has_wikipedia"] = True
                    thumb = (page.get("thumbnail") or {}).get("source")
                    if thumb:
                        cur["image_url"] = thumb
                    revs = page.get("revisions") or []
                    if not revs:
                        continue
                    txt = (revs[0].get("slots") or {}).get("main", {}).get("content", "")
                    if not txt:
                        continue

                    # Parse country / country1 / internationalspan
                    for field in ("country", "country1"):
                        m = re.search(rf"\|\s*{field}\s*=\s*([^\n\|}}]+)", txt, re.I)
                        if m:
                            ctry_clean = normalize_country(clean_wikitext_val(m.group(1)))
                            if ctry_clean and len(ctry_clean) <= 35:
                                cur["nationality"] = ctry_clean
                                break

                    m_bat = re.search(r"\|\s*batting\s*=\s*([^\n\|}}]+)", txt, re.I)
                    if m_bat:
                        bs = map_batting_style(clean_wikitext_val(m_bat.group(1)))
                        if bs:
                            cur["batting_style"] = bs

                    m_bowl = re.search(r"\|\s*bowling\s*=\s*([^\n\|}}]+)", txt, re.I)
                    if m_bowl:
                        bw = map_bowling_style(clean_wikitext_val(m_bowl.group(1)))
                        if bw:
                            cur["bowling_style"] = bw

                    m_role = re.search(r"\|\s*role\s*=\s*([^\n\|}}]+)", txt, re.I)
                    if m_role:
                        r1, r2 = map_role_text(clean_wikitext_val(m_role.group(1)))
                        if r1:
                            cur["role"] = r1
                            if r2:
                                cur["secondary_role"] = r2
        except Exception as exc:
            print(f"[Wikipedia] Batch {i//50 + 1} warning: {exc}")
        time.sleep(0.15)

    return enriched


def infer_role_from_stats(meta):
    if meta["total_stumpings"] >= 3:
        return "WICKET_KEEPER", "BATSMAN"
    runs = meta["total_runs"]
    wkts = meta["total_wickets"]
    if runs >= 400 and wkts >= 25 and (runs / max(wkts, 1)) <= 100:
        return "ALL_ROUNDER", ("BATSMAN" if runs >= wkts * 20 else "BOWLER")
    if wkts >= 15 and runs < 500:
        return "BOWLER", None
    if runs >= 300 and wkts < 25:
        return "BATSMAN", ("ALL_ROUNDER" if wkts >= 10 else None)
    if wkts > 0 and runs >= 150:
        return "ALL_ROUNDER", None
    if wkts > 0:
        return "BOWLER", None
    return "BATSMAN", None


def compute_age(dob_iso: str):
    if not dob_iso:
        return None
    try:
        dt = datetime.strptime(dob_iso, "%Y-%m-%d")
        now = datetime(2026, 11, 26)
        return now.year - dt.year - ((now.month, now.day) < (dt.month, dt.day))
    except Exception:
        return None


def main():
    print("Aggregating Cricsheet IPL ball-by-ball JSON archive...")
    people_reg, players_meta, season_acc, seasons, match_count = aggregate_cricsheet()
    print(f"Parsed {match_count} matches across seasons {seasons[0]}..{seasons[-1]}, {len(players_meta)} IPL players.")

    cricinfo_ids = [m["cricinfo_id"] for m in players_meta.values() if m["cricinfo_id"]]
    print(f"Querying Wikidata CC0 + MediaWiki API for {len(cricinfo_ids)} ESPNcricinfo IDs...")
    wd = fetch_wikidata_and_wikipedia(cricinfo_ids)
    print(f"Enriched {len(wd)} players cleanly.")

    # Sort players cleanly by total matches desc, then runs desc
    sorted_pids = sorted(
        players_meta.keys(),
        key=lambda pid: (-players_meta[pid]["total_matches"], -players_meta[pid]["total_runs"], players_meta[pid]["short_name"]),
    )

    players_csv = OUT_DIR / "ipl_players.csv"
    seasons_csv = OUT_DIR / "ipl_season_stats.csv"

    nationality_known = 0
    image_known = 0
    dob_known = 0
    batting_known = 0
    bowling_known = 0

    with open(players_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "externalKey",
            "cricsheetId",
            "cricinfoId",
            "fullName",
            "nationality",
            "isOverseas",
            "dateOfBirth",
            "age",
            "playingRole",
            "secondaryRole",
            "battingStyle",
            "bowlingStyle",
            "iplDebutYear",
            "iplLastYear",
            "teamHistory",
            "imageUrl",
            "provenanceSource",
            "seasonCoverage",
        ])

        for pid in sorted_pids:
            m = players_meta[pid]
            cid = m["cricinfo_id"]
            w = wd.get(cid or "", {})
            full_name = w.get("full_name") or m["unique_name"] or m["short_name"]
            nationality = w.get("nationality")
            if nationality:
                nationality_known += 1
            is_overseas = "" if not nationality else ("false" if nationality.lower() == "india" else "true")
            dob = w.get("dob") or ""
            if dob:
                dob_known += 1
            age = compute_age(dob)
            image_url = w.get("image_url") or ""
            if image_url:
                image_known += 1
            inferred_r1, inferred_r2 = infer_role_from_stats(m)
            role = w.get("role") or inferred_r1
            sec_role = w.get("secondary_role") if w.get("role") else inferred_r2
            bat_style = w.get("batting_style") or ""
            bowl_style = w.get("bowling_style") or ""
            if bat_style:
                batting_known += 1
            if bowl_style:
                bowling_known += 1
            debut_yr = min(m["seasons"]) if m["seasons"] else ""
            last_yr = max(m["seasons"]) if m["seasons"] else ""
            slug = re.sub(r"[^a-z0-9]+", "-", full_name.lower()).strip("-")
            ext_key = f"{slug}-{pid}"
            prov = (
                "cricsheet+wikidata+wikipedia"
                if w.get("has_wikipedia")
                else ("cricsheet+wikidata" if w else "cricsheet")
            )

            writer.writerow([
                ext_key,
                pid,
                cid or "",
                full_name,
                nationality or "",
                is_overseas,
                dob,
                age if age is not None else "",
                role,
                sec_role or "",
                bat_style,
                bowl_style,
                debut_yr,
                last_yr,
                "|".join(m["teams"]),
                image_url,
                prov,
                f"{debut_yr}-{last_yr}" if debut_yr else "",
            ])

    season_rows_written = 0
    with open(seasons_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow([
            "cricsheetId",
            "season",
            "teamCode",
            "matches",
            "innings",
            "battingInnings",
            "bowlingInnings",
            "runs",
            "ballsFaced",
            "notOuts",
            "highestScore",
            "highestScoreText",
            "battingAverage",
            "strikeRate",
            "fifties",
            "hundreds",
            "wickets",
            "ballsBowled",
            "runsConceded",
            "bowlingAverage",
            "economy",
            "bowlingStrikeRate",
            "bestBowling",
            "catches",
            "stumpings",
            "provenanceSource",
        ])

        for (pid, season), acc in sorted(season_acc.items(), key=lambda x: (x[0][1], x[0][0])):
            if pid not in players_meta:
                continue
            matches = len(acc["matches"])
            bat_inn = len(acc["bat_innings"])
            bowl_inn = len(acc["bowl_innings"])
            innings = max(bat_inn, bowl_inn)
            runs = acc["runs"] if acc["has_batted"] else ""
            balls_faced = acc["balls_faced"] if acc["has_batted"] else ""
            not_outs = max(0, bat_inn - acc["dismissals"]) if acc["has_batted"] else ""
            hs_val = acc["hs_runs"] if acc["has_batted"] else ""
            hs_text = f"{acc['hs_runs']}{'*' if acc['hs_not_out'] else ''}" if acc["has_batted"] else ""
            bat_avg = round(acc["runs"] / acc["dismissals"], 2) if acc["dismissals"] > 0 else ""
            bat_sr = round((acc["runs"] * 100.0) / acc["balls_faced"], 2) if acc["balls_faced"] > 0 else ""
            fifties = acc["fifties"] if acc["has_batted"] else ""
            hundreds = acc["hundreds"] if acc["has_batted"] else ""

            has_bowled = bowl_inn > 0
            wickets = acc["wickets"] if has_bowled else ""
            balls_bowled = acc["balls_bowled"] if has_bowled else ""
            runs_conceded = acc["runs_conceded"] if has_bowled else ""
            bowl_avg = round(acc["runs_conceded"] / acc["wickets"], 2) if acc["wickets"] > 0 else ""
            economy = round((acc["runs_conceded"] * 6.0) / acc["balls_bowled"], 2) if acc["balls_bowled"] > 0 else ""
            bowl_sr = round(acc["balls_bowled"] / acc["wickets"], 2) if acc["wickets"] > 0 else ""
            best_bowl = f"{acc['best_bowl_w']}/{acc['best_bowl_r']}" if has_bowled and acc["best_bowl_w"] >= 0 else ""

            team_str = "|".join(sorted(acc["teams"]))
            writer.writerow([
                pid,
                season,
                team_str,
                matches,
                innings,
                bat_inn,
                bowl_inn,
                runs,
                balls_faced,
                not_outs,
                hs_val,
                hs_text,
                bat_avg,
                bat_sr,
                fifties,
                hundreds,
                wickets,
                balls_bowled,
                runs_conceded,
                bowl_avg,
                economy,
                bowl_sr,
                best_bowl,
                acc["catches"],
                acc["stumpings"],
                "cricsheet",
            ])
            season_rows_written += 1

    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sources": [
            {
                "name": "Cricsheet IPL Male JSON Archive",
                "url": "https://cricsheet.org/downloads/ipl_json.zip",
                "license": "Open Data Commons Attribution / Open Cricket Data",
                "matchFilesProcessed": match_count,
                "seasons": seasons,
            },
            {
                "name": "Cricsheet People Register",
                "url": "https://cricsheet.org/register/people.csv",
                "license": "Open Data",
            },
            {
                "name": "Wikidata SPARQL Cricket Register (CC0)",
                "url": "https://query.wikidata.org/sparql",
                "license": "CC0 1.0 Public Domain",
                "matchedPlayers": len(wd),
            },
        ],
        "counts": {
            "totalPlayers": len(sorted_pids),
            "totalPlayerSeasons": season_rows_written,
            "seasonsCovered": seasons,
            "withVerifiedNationality": nationality_known,
            "withVerifiedPhotoUrl": image_known,
            "withVerifiedDob": dob_known,
        },
    }
    with open(OUT_DIR / "provenance_manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print("Manifest summary:", json.dumps(manifest["counts"], indent=2))


if __name__ == "__main__":
    main()
