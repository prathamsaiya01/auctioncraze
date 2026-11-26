import fs from 'node:fs';
import path from 'node:path';
import {
  BattingStyle,
  BowlingStyle,
  CricketRole,
  Prisma,
  PrismaClient
} from '@prisma/client';

const prisma = new PrismaClient();

// AuctionCraze baseline catalog game-tier defaults for marquee icons (not real-world salary claims)
const BASELINE_STAR_BASE_PRICES: Record<string, number> = {
  'virat-kohli': 200,
  'rohit-sharma': 200,
  'suryakumar-yadav': 200,
  'david-warner': 200,
  'jasprit-bumrah': 200,
  'rashid-khan': 200,
  'pat-cummins': 200,
  'yuzvendra-chahal': 200,
  'hardik-pandya': 200,
  'ravindra-jadeja': 200,
  'andre-russell': 200,
  'sunil-narine': 200,
  'ben-stokes': 200,
  'ms-dhoni': 200,
  'jos-buttler': 200,
  'nicholas-pooran': 200,
  'kl-rahul': 200,
  'sanju-samson': 200,
  'rishabh-pant': 200,
  'shubman-gill': 200,
  'shreyas-iyer': 200,
  'kagiso-rabada': 200,
  'trent-boult': 200,
  'ravichandran-ashwin': 200
};

const NAME_ALIASES: Record<string, string> = {
  nicolaspooran: 'nicholaspooran'
};

function normalizeNameKey(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return NAME_ALIASES[cleaned] || cleaned;
}

function parseCsvRows(csvText: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    const next = csvText[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && next === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r];
    if (vals.length === 1 && vals[0].trim() === '') continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (vals[c] ?? '').trim();
    }
    out.push(obj);
  }
  return out;
}

function toNullableInt(val: string | undefined): number | null {
  if (!val) return null;
  const n = Number(val);
  return Number.isInteger(n) ? n : null;
}

function toNullableDecimal(val: string | undefined): Prisma.Decimal | null {
  if (!val) return null;
  const n = Number(val);
  return Number.isFinite(n) ? new Prisma.Decimal(n.toFixed(2)) : null;
}

function resolveRole(val: string | undefined): CricketRole {
  if (val && Object.values(CricketRole).includes(val as CricketRole)) {
    return val as CricketRole;
  }
  return CricketRole.ALL_ROUNDER;
}

function resolveSecondaryRole(val: string | undefined): CricketRole | null {
  if (val && Object.values(CricketRole).includes(val as CricketRole)) {
    return val as CricketRole;
  }
  return null;
}

function resolveBatting(val: string | undefined): BattingStyle | null {
  if (val && Object.values(BattingStyle).includes(val as BattingStyle)) {
    return val as BattingStyle;
  }
  return null;
}

function resolveBowling(val: string | undefined): BowlingStyle | null {
  if (val && Object.values(BowlingStyle).includes(val as BowlingStyle)) {
    return val as BowlingStyle;
  }
  return null;
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const playersCsvPath = path.join(repoRoot, 'services', 'ml', 'data', 'processed', 'ipl_players.csv');
  const seasonsCsvPath = path.join(repoRoot, 'services', 'ml', 'data', 'processed', 'ipl_season_stats.csv');

  if (!fs.existsSync(playersCsvPath) || !fs.existsSync(seasonsCsvPath)) {
    throw new Error(`Missing processed IPL CSV datasets at ${playersCsvPath}`);
  }

  console.log('Loading processed Cricsheet + Wikidata + Wikipedia IPL catalog...');
  const playerRows = parseCsvRows(fs.readFileSync(playersCsvPath, 'utf-8'));
  const seasonRows = parseCsvRows(fs.readFileSync(seasonsCsvPath, 'utf-8'));

  // Build lookup of existing players so baseline seeded records merge cleanly without duplication
  const existing = await prisma.masterPlayer.findMany({
    select: { id: true, externalKey: true, cricsheetId: true, fullName: true, basePriceLakhs: true }
  });
  const byCricsheet = new Map(existing.filter((p) => p.cricsheetId).map((p) => [p.cricsheetId!, p]));
  const byExternalKey = new Map(existing.filter((p) => p.externalKey).map((p) => [p.externalKey!, p]));
  const byNormName = new Map(existing.map((p) => [normalizeNameKey(p.fullName), p]));

  const cricsheetToPlayerId = new Map<string, string>();
  let insertedPlayers = 0;
  let updatedPlayers = 0;

  for (const row of playerRows) {
    const cricsheetId = row.cricsheetId;
    const fullName = row.fullName;
    if (!cricsheetId || !fullName) continue;

    const normName = normalizeNameKey(fullName);
    const simpleSlug = fullName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const matched =
      byCricsheet.get(cricsheetId) ||
      byExternalKey.get(row.externalKey) ||
      byExternalKey.get(simpleSlug) ||
      byNormName.get(normName);

    const nationality = row.nationality || null;
    const isOverseas =
      row.isOverseas === 'true'
        ? true
        : row.isOverseas === 'false'
        ? false
        : nationality
        ? nationality.toLowerCase() !== 'india'
        : false;
    const dob = row.dateOfBirth ? new Date(`${row.dateOfBirth}T00:00:00Z`) : null;
    const validDob = dob && !Number.isNaN(dob.getTime()) ? dob : null;
    const teamHistory = row.teamHistory
      ? row.teamHistory.split('|').map((t) => t.trim()).filter(Boolean)
      : [];

    const starPrice = BASELINE_STAR_BASE_PRICES[simpleSlug] || BASELINE_STAR_BASE_PRICES[matched?.externalKey || ''];
    const basePriceLakhs = starPrice ?? matched?.basePriceLakhs ?? 50;

    const payload = {
      cricsheetId,
      cricinfoId: row.cricinfoId || null,
      fullName,
      nationality,
      isOverseas,
      dateOfBirth: validDob,
      age: toNullableInt(row.age),
      playingRole: resolveRole(row.playingRole),
      secondaryRole: resolveSecondaryRole(row.secondaryRole),
      battingStyle: resolveBatting(row.battingStyle),
      bowlingStyle: resolveBowling(row.bowlingStyle),
      basePriceLakhs,
      imageUrl: row.imageUrl || null,
      teamHistoryJson: teamHistory,
      iplDebutYear: toNullableInt(row.iplDebutYear),
      iplLastYear: toNullableInt(row.iplLastYear),
      provenanceSource: row.provenanceSource || 'cricsheet',
      seasonCoverage: row.seasonCoverage || null
    };

    if (matched) {
      const updated = await prisma.masterPlayer.update({
        where: { id: matched.id },
        data: payload,
        select: { id: true }
      });
      cricsheetToPlayerId.set(cricsheetId, updated.id);
      updatedPlayers++;
    } else {
      const created = await prisma.masterPlayer.create({
        data: {
          externalKey: row.externalKey || `${simpleSlug}-${cricsheetId}`,
          ...payload
        },
        select: { id: true }
      });
      cricsheetToPlayerId.set(cricsheetId, created.id);
      insertedPlayers++;
    }
  }

  console.log(`Players synced: ${insertedPlayers} inserted, ${updatedPlayers} updated.`);

  // Clear existing Cricsheet stats before fast batch recreate inside transaction to ensure zero stale duplicates
  const batchStats: Prisma.PlayerSeasonStatCreateManyInput[] = [];
  for (const s of seasonRows) {
    const playerId = cricsheetToPlayerId.get(s.cricsheetId);
    const season = toNullableInt(s.season);
    if (!playerId || !season) continue;

    batchStats.push({
      playerId,
      season,
      teamCode: s.teamCode || null,
      matches: toNullableInt(s.matches),
      innings: toNullableInt(s.innings),
      battingInnings: toNullableInt(s.battingInnings),
      bowlingInnings: toNullableInt(s.bowlingInnings),
      runs: toNullableInt(s.runs),
      ballsFaced: toNullableInt(s.ballsFaced),
      notOuts: toNullableInt(s.notOuts),
      highestScore: toNullableInt(s.highestScore),
      highestScoreText: s.highestScoreText || null,
      battingAverage: toNullableDecimal(s.battingAverage),
      strikeRate: toNullableDecimal(s.strikeRate),
      fifties: toNullableInt(s.fifties),
      hundreds: toNullableInt(s.hundreds),
      wickets: toNullableInt(s.wickets),
      ballsBowled: toNullableInt(s.ballsBowled),
      runsConceded: toNullableInt(s.runsConceded),
      bowlingAverage: toNullableDecimal(s.bowlingAverage),
      economy: toNullableDecimal(s.economy),
      bowlingStrikeRate: toNullableDecimal(s.bowlingStrikeRate),
      bestBowling: s.bestBowling || null,
      catches: toNullableInt(s.catches),
      stumpings: toNullableInt(s.stumpings),
      provenanceSource: s.provenanceSource || 'cricsheet'
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.playerSeasonStat.deleteMany({
      where: { playerId: { in: Array.from(cricsheetToPlayerId.values()) } }
    });
    for (let i = 0; i < batchStats.length; i += 500) {
      await tx.playerSeasonStat.createMany({
        data: batchStats.slice(i, i + 500),
        skipDuplicates: true
      });
    }
    const existingImport = await tx.playerImportBatch.findFirst({
      where: { sourceName: 'cricsheet+wikidata+wikipedia', status: 'COMMITTED' }
    });
    if (!existingImport) {
      await tx.playerImportBatch.create({
        data: {
          sourceName: 'cricsheet+wikidata+wikipedia',
          fileName: 'ipl_players.csv + ipl_season_stats.csv',
          importMode: 'PLAYERS',
          status: 'COMMITTED',
          totalRows: playerRows.length + seasonRows.length,
          insertedCount: insertedPlayers,
          updatedCount: updatedPlayers,
          skippedCount: 0,
          errorCount: 0,
          provenanceNotes:
            'Cricsheet IPL ball-by-ball archive (1,243 matches, 2008-2026) + Wikidata CC0 + Wikimedia Action API Infobox cricketer metadata.'
        }
      });
    }
  });

  console.log(`Synced ${batchStats.length} verifiable IPL player-season stat records.`);
}

main()
  .catch((err) => {
    console.error('Seed error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
