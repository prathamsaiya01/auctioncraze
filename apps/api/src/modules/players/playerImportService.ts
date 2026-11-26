import {
  BattingStyle,
  BowlingStyle,
  CricketRole,
  Prisma,
  prisma
} from '@auctioncraze/database';
import {
  CsvImportErrorDto,
  CsvImportPreviewRowDto,
  CsvImportReportDto,
  PlayerImportBatchDto
} from '@auctioncraze/shared';
import { AppError } from '../../middleware/errorHandler';

const NAME_ALIASES: Record<string, string> = {
  nicolaspooran: 'nicholaspooran'
};

export function normalizePlayerIdentityName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return NAME_ALIASES[cleaned] || cleaned;
}

function isBlankOrUnknown(raw: string | undefined): boolean {
  if (raw === undefined || raw === null) return true;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '' || trimmed === 'null' || trimmed === 'na' || trimmed === 'n/a' || trimmed === 'unknown' || trimmed === '-';
}

function parseNullableInt(raw: string | undefined, field: string, rowNum: number, errors: CsvImportErrorDto[], minVal = 0): number | null {
  if (isBlankOrUnknown(raw)) return null;
  const n = Number(raw!.trim());
  if (!Number.isInteger(n) || n < minVal) {
    errors.push({ rowNumber: rowNum, field, message: `Expected integer >= ${minVal}, got '${raw}'` });
    return null;
  }
  return n;
}

function parseNullableDecimal(raw: string | undefined, field: string, rowNum: number, errors: CsvImportErrorDto[]): Prisma.Decimal | null {
  if (isBlankOrUnknown(raw)) return null;
  const n = Number(raw!.trim());
  if (!Number.isFinite(n) || n < 0) {
    errors.push({ rowNumber: rowNum, field, message: `Expected non-negative number, got '${raw}'` });
    return null;
  }
  return new Prisma.Decimal(n.toFixed(2));
}

export function parseCsvRecords(csvText: string): { headers: string[]; rows: Record<string, string>[] } {
  const grid: string[][] = [];
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
      grid.push(row);
      row = [];
      field = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      grid.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (inQuotes) {
    throw new AppError('Malformed CSV: unterminated quoted field.', 400, 'CSV_PARSE_ERROR');
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    grid.push(row);
  }

  if (grid.length < 2) {
    throw new AppError('CSV must contain a header row and at least one data row.', 400, 'CSV_EMPTY');
  }

  const headers = grid[0].map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < grid.length; r++) {
    const vals = grid[r];
    if (vals.length === 1 && vals[0].trim() === '') continue;
    const rec: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      rec[headers[c]] = (vals[c] ?? '').trim();
    }
    rows.push(rec);
  }
  return { headers, rows };
}

interface ParsedInput {
  importMode: 'PLAYERS' | 'SEASONS';
  csvText: string;
  sourceName: string;
  fileName?: string;
  provenanceNotes?: string;
}

export class PlayerImportService {
  private static async buildIdentityLookups() {
    const existing = await prisma.masterPlayer.findMany({
      select: {
        id: true,
        externalKey: true,
        cricsheetId: true,
        cricinfoId: true,
        fullName: true,
        nationality: true,
        basePriceLakhs: true
      }
    });
    const byCricsheet = new Map(existing.filter((p) => p.cricsheetId).map((p) => [p.cricsheetId!, p]));
    const byCricinfo = new Map(existing.filter((p) => p.cricinfoId).map((p) => [p.cricinfoId!, p]));
    const byExtKey = new Map(existing.filter((p) => p.externalKey).map((p) => [p.externalKey!, p]));
    const byNormName = new Map(existing.map((p) => [normalizePlayerIdentityName(p.fullName), p]));
    return { byCricsheet, byCricinfo, byExtKey, byNormName };
  }

  private static matchExistingPlayer(
    row: Record<string, string>,
    lookups: Awaited<ReturnType<typeof PlayerImportService.buildIdentityLookups>>
  ): { playerId: string; matchedBy: 'cricsheetId' | 'cricinfoId' | 'externalKey' | 'fullName' } | null {
    if (row.cricsheetId && lookups.byCricsheet.has(row.cricsheetId)) {
      return { playerId: lookups.byCricsheet.get(row.cricsheetId)!.id, matchedBy: 'cricsheetId' };
    }
    if (row.cricinfoId && lookups.byCricinfo.has(row.cricinfoId)) {
      return { playerId: lookups.byCricinfo.get(row.cricinfoId)!.id, matchedBy: 'cricinfoId' };
    }
    if (row.externalKey && lookups.byExtKey.has(row.externalKey)) {
      return { playerId: lookups.byExtKey.get(row.externalKey)!.id, matchedBy: 'externalKey' };
    }
    if (row.fullName) {
      const norm = normalizePlayerIdentityName(row.fullName);
      if (lookups.byNormName.has(norm)) {
        return { playerId: lookups.byNormName.get(norm)!.id, matchedBy: 'fullName' };
      }
    }
    return null;
  }

  static async previewImport(input: ParsedInput): Promise<CsvImportReportDto> {
    const { headers, rows } = parseCsvRecords(input.csvText);
    const errors: CsvImportErrorDto[] = [];
    const previewRows: CsvImportPreviewRowDto[] = [];
    const lookups = await PlayerImportService.buildIdentityLookups();

    let insertCount = 0;
    let updateCount = 0;
    let duplicateCount = 0;

    if (input.importMode === 'PLAYERS') {
      if (!headers.includes('fullName')) {
        throw new AppError("PLAYERS CSV must include required column 'fullName'.", 400, 'MISSING_COLUMNS');
      }

      const seenIdentity = new Set<string>();
      for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 2;
        const row = rows[i];
        const rowErrCountBefore = errors.length;

        if (isBlankOrUnknown(row.fullName)) {
          errors.push({ rowNumber: rowNum, field: 'fullName', message: 'fullName is required.' });
        }

        if (row.playingRole && !Object.values(CricketRole).includes(row.playingRole as CricketRole)) {
          errors.push({ rowNumber: rowNum, field: 'playingRole', message: `Invalid playingRole '${row.playingRole}'` });
        }
        if (row.secondaryRole && !Object.values(CricketRole).includes(row.secondaryRole as CricketRole)) {
          errors.push({ rowNumber: rowNum, field: 'secondaryRole', message: `Invalid secondaryRole '${row.secondaryRole}'` });
        }
        if (row.battingStyle && !isBlankOrUnknown(row.battingStyle) && !Object.values(BattingStyle).includes(row.battingStyle as BattingStyle)) {
          errors.push({ rowNumber: rowNum, field: 'battingStyle', message: `Invalid battingStyle '${row.battingStyle}'` });
        }
        if (row.bowlingStyle && !isBlankOrUnknown(row.bowlingStyle) && !Object.values(BowlingStyle).includes(row.bowlingStyle as BowlingStyle)) {
          errors.push({ rowNumber: rowNum, field: 'bowlingStyle', message: `Invalid bowlingStyle '${row.bowlingStyle}'` });
        }
        parseNullableInt(row.age, 'age', rowNum, errors, 14);
        parseNullableInt(row.basePriceLakhs, 'basePriceLakhs', rowNum, errors, 5);
        parseNullableInt(row.iplDebutYear, 'iplDebutYear', rowNum, errors, 2008);
        parseNullableInt(row.iplLastYear, 'iplLastYear', rowNum, errors, 2008);

        const identityKey = row.cricsheetId
          ? `cs:${row.cricsheetId}`
          : row.fullName
          ? `nm:${normalizePlayerIdentityName(row.fullName)}`
          : `row:${rowNum}`;

        if (errors.length > rowErrCountBefore) {
          previewRows.push({
            rowNumber: rowNum,
            action: 'ERROR',
            matchedBy: null,
            identityLabel: row.fullName || `Row ${rowNum}`,
            summary: errors[errors.length - 1].message
          });
          continue;
        }

        if (seenIdentity.has(identityKey)) {
          duplicateCount++;
          previewRows.push({
            rowNumber: rowNum,
            action: 'DUPLICATE_IN_CSV',
            matchedBy: null,
            identityLabel: row.fullName,
            summary: `Duplicate player identity '${row.fullName}' detected inside CSV batch.`
          });
          continue;
        }
        seenIdentity.add(identityKey);

        const match = PlayerImportService.matchExistingPlayer(row, lookups);
        if (match) {
          updateCount++;
          previewRows.push({
            rowNumber: rowNum,
            action: 'UPDATE',
            matchedBy: match.matchedBy,
            identityLabel: row.fullName,
            summary: `Matched existing player by ${match.matchedBy}`
          });
        } else {
          insertCount++;
          previewRows.push({
            rowNumber: rowNum,
            action: 'INSERT',
            matchedBy: null,
            identityLabel: row.fullName,
            summary: 'New player identity to insert'
          });
        }
      }
    } else {
      // SEASONS import mode
      if (!headers.includes('season') || (!headers.includes('cricsheetId') && !headers.includes('fullName') && !headers.includes('externalKey'))) {
        throw new AppError(
          "SEASONS CSV must include 'season' and an identifier column ('cricsheetId', 'externalKey', or 'fullName').",
          400,
          'MISSING_COLUMNS'
        );
      }

      const existingStats = await prisma.playerSeasonStat.findMany({
        select: { playerId: true, season: true }
      });
      const existingStatKeys = new Set(existingStats.map((s) => `${s.playerId}:${s.season}`));
      const seenSeasonKeys = new Set<string>();

      for (let i = 0; i < rows.length; i++) {
        const rowNum = i + 2;
        const row = rows[i];
        const before = errors.length;

        const season = parseNullableInt(row.season, 'season', rowNum, errors, 2008);
        parseNullableInt(row.matches, 'matches', rowNum, errors, 0);
        parseNullableInt(row.innings, 'innings', rowNum, errors, 0);
        parseNullableInt(row.battingInnings, 'battingInnings', rowNum, errors, 0);
        parseNullableInt(row.bowlingInnings, 'bowlingInnings', rowNum, errors, 0);
        parseNullableInt(row.runs, 'runs', rowNum, errors, 0);
        parseNullableInt(row.ballsFaced, 'ballsFaced', rowNum, errors, 0);
        parseNullableInt(row.notOuts, 'notOuts', rowNum, errors, 0);
        parseNullableInt(row.highestScore, 'highestScore', rowNum, errors, 0);
        parseNullableDecimal(row.battingAverage, 'battingAverage', rowNum, errors);
        parseNullableDecimal(row.strikeRate, 'strikeRate', rowNum, errors);
        parseNullableInt(row.fifties, 'fifties', rowNum, errors, 0);
        parseNullableInt(row.hundreds, 'hundreds', rowNum, errors, 0);
        parseNullableInt(row.wickets, 'wickets', rowNum, errors, 0);
        parseNullableInt(row.ballsBowled, 'ballsBowled', rowNum, errors, 0);
        parseNullableInt(row.runsConceded, 'runsConceded', rowNum, errors, 0);
        parseNullableDecimal(row.bowlingAverage, 'bowlingAverage', rowNum, errors);
        parseNullableDecimal(row.economy, 'economy', rowNum, errors);
        parseNullableDecimal(row.bowlingStrikeRate, 'bowlingStrikeRate', rowNum, errors);
        parseNullableInt(row.catches, 'catches', rowNum, errors, 0);
        parseNullableInt(row.stumpings, 'stumpings', rowNum, errors, 0);

        const match = PlayerImportService.matchExistingPlayer(row, lookups);
        if (!match) {
          errors.push({
            rowNumber: rowNum,
            field: row.cricsheetId ? 'cricsheetId' : 'fullName',
            message: `Unmatched player '${row.cricsheetId || row.externalKey || row.fullName || 'Unknown'}'`
          });
        }

        if (errors.length > before) {
          previewRows.push({
            rowNumber: rowNum,
            action: 'ERROR',
            matchedBy: match?.matchedBy || null,
            identityLabel: row.fullName || row.cricsheetId || `Row ${rowNum}`,
            season,
            summary: errors[errors.length - 1].message
          });
          continue;
        }

        const dedupKey = `${match!.playerId}:${season}`;
        if (seenSeasonKeys.has(dedupKey)) {
          duplicateCount++;
          previewRows.push({
            rowNumber: rowNum,
            action: 'DUPLICATE_IN_CSV',
            matchedBy: match!.matchedBy,
            identityLabel: row.fullName || row.cricsheetId,
            season,
            summary: `Duplicate season (${season}) entry for player inside CSV`
          });
          continue;
        }
        seenSeasonKeys.add(dedupKey);

        if (existingStatKeys.has(dedupKey)) {
          updateCount++;
          previewRows.push({
            rowNumber: rowNum,
            action: 'UPDATE',
            matchedBy: match!.matchedBy,
            identityLabel: row.fullName || row.cricsheetId,
            season,
            summary: `Updates season ${season} stats`
          });
        } else {
          insertCount++;
          previewRows.push({
            rowNumber: rowNum,
            action: 'INSERT',
            matchedBy: match!.matchedBy,
            identityLabel: row.fullName || row.cricsheetId,
            season,
            summary: `Adds season ${season} stats`
          });
        }
      }
    }

    return {
      importMode: input.importMode,
      sourceName: input.sourceName,
      totalRows: rows.length,
      insertCount,
      updateCount,
      duplicateCount,
      errorCount: errors.length,
      canCommit: errors.length === 0 && duplicateCount === 0 && (insertCount > 0 || updateCount > 0),
      errors: errors.slice(0, 100),
      previewRows: previewRows.slice(0, 100)
    };
  }

  static async commitImport(
    input: ParsedInput,
    sessionId?: string
  ): Promise<{ batch: PlayerImportBatchDto; report: CsvImportReportDto }> {
    const report = await PlayerImportService.previewImport(input);
    if (!report.canCommit) {
      await prisma.playerImportBatch.create({
        data: {
          sourceName: input.sourceName,
          fileName: input.fileName || null,
          importMode: input.importMode,
          status: 'FAILED',
          totalRows: report.totalRows,
          insertedCount: 0,
          updatedCount: 0,
          skippedCount: report.duplicateCount,
          errorCount: report.errorCount + report.duplicateCount,
          errorsJson: report.errors as unknown as Prisma.InputJsonValue,
          provenanceNotes: input.provenanceNotes || 'Rejected before commit due to validation/duplicate errors (no partial mutations applied).',
          createdBySessionId: sessionId || null
        }
      });

      throw new AppError(
        `CSV import validation failed (${report.errorCount} error(s), ${report.duplicateCount} duplicate(s)). Changes rolled back cleanly.`,
        400,
        'IMPORT_VALIDATION_FAILED',
        { report }
      );
    }

    const { rows } = parseCsvRecords(input.csvText);
    const lookups = await PlayerImportService.buildIdentityLookups();
    const insertedPlayerIds: string[] = [];

    const batch = await prisma.$transaction(async (tx) => {
      let insertedCount = 0;
      let updatedCount = 0;

      if (input.importMode === 'PLAYERS') {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const match = PlayerImportService.matchExistingPlayer(row, lookups);
          const errors: CsvImportErrorDto[] = [];

          const nationality = isBlankOrUnknown(row.nationality) ? null : row.nationality.trim();
          const isOverseas =
            row.isOverseas === 'true'
              ? true
              : row.isOverseas === 'false'
              ? false
              : nationality
              ? nationality.toLowerCase() !== 'india'
              : false;

          const teamHistory = !isBlankOrUnknown(row.teamHistory)
            ? row.teamHistory.split('|').map((s) => s.trim()).filter(Boolean)
            : undefined;

          const dobVal = !isBlankOrUnknown(row.dateOfBirth)
            ? new Date(`${row.dateOfBirth.trim()}T00:00:00Z`)
            : null;
          const validDob = dobVal && !Number.isNaN(dobVal.getTime()) ? dobVal : null;

          const age = parseNullableInt(row.age, 'age', i + 2, errors, 14);
          const basePriceLakhs = parseNullableInt(row.basePriceLakhs, 'basePriceLakhs', i + 2, errors, 5);
          const iplDebutYear = parseNullableInt(row.iplDebutYear, 'iplDebutYear', i + 2, errors, 2008);
          const iplLastYear = parseNullableInt(row.iplLastYear, 'iplLastYear', i + 2, errors, 2008);

          const dataPayload: any = {
            fullName: row.fullName.trim(),
            ...(row.cricsheetId ? { cricsheetId: row.cricsheetId.trim() } : {}),
            ...(row.cricinfoId ? { cricinfoId: row.cricinfoId.trim() } : {}),
            ...(row.nationality !== undefined ? { nationality } : {}),
            ...(row.nationality !== undefined || row.isOverseas !== undefined ? { isOverseas } : {}),
            ...(validDob ? { dateOfBirth: validDob } : {}),
            ...(age !== null ? { age } : {}),
            ...(row.playingRole ? { playingRole: row.playingRole as CricketRole } : {}),
            ...(row.secondaryRole !== undefined
              ? { secondaryRole: isBlankOrUnknown(row.secondaryRole) ? null : (row.secondaryRole as CricketRole) }
              : {}),
            ...(row.battingStyle !== undefined
              ? { battingStyle: isBlankOrUnknown(row.battingStyle) ? null : (row.battingStyle as BattingStyle) }
              : {}),
            ...(row.bowlingStyle !== undefined
              ? { bowlingStyle: isBlankOrUnknown(row.bowlingStyle) ? null : (row.bowlingStyle as BowlingStyle) }
              : {}),
            ...(basePriceLakhs !== null ? { basePriceLakhs } : {}),
            ...(row.imageUrl !== undefined
              ? { imageUrl: isBlankOrUnknown(row.imageUrl) ? null : row.imageUrl.trim() }
              : {}),
            ...(teamHistory !== undefined ? { teamHistoryJson: teamHistory } : {}),
            ...(iplDebutYear !== null ? { iplDebutYear } : {}),
            ...(iplLastYear !== null ? { iplLastYear } : {}),
            provenanceSource: row.provenanceSource || input.sourceName,
            ...(row.seasonCoverage ? { seasonCoverage: row.seasonCoverage } : {})
          };

          if (match) {
            await tx.masterPlayer.update({
              where: { id: match.playerId },
              data: dataPayload
            });
            updatedCount++;
          } else {
            const slug = row.fullName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '');
            const created = await tx.masterPlayer.create({
              data: {
                externalKey:
                  row.externalKey ||
                  (row.cricsheetId ? `${slug}-${row.cricsheetId}` : `${slug}-${Date.now()}-${i}`),
                ...dataPayload
              },
              select: { id: true }
            });
            insertedPlayerIds.push(created.id);
            insertedCount++;
          }
        }
      } else {
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const rowNum = i + 2;
          const match = PlayerImportService.matchExistingPlayer(row, lookups);
          if (!match) {
            throw new AppError(`Unmatched player on row ${rowNum}`, 400, 'PLAYER_NOT_FOUND');
          }
          const errors: CsvImportErrorDto[] = [];
          const season = parseNullableInt(row.season, 'season', rowNum, errors, 2008)!;

          const statData = {
            teamCode: isBlankOrUnknown(row.teamCode) ? null : row.teamCode.trim(),
            matches: parseNullableInt(row.matches, 'matches', rowNum, errors, 0),
            innings: parseNullableInt(row.innings, 'innings', rowNum, errors, 0),
            battingInnings: parseNullableInt(row.battingInnings, 'battingInnings', rowNum, errors, 0),
            bowlingInnings: parseNullableInt(row.bowlingInnings, 'bowlingInnings', rowNum, errors, 0),
            runs: parseNullableInt(row.runs, 'runs', rowNum, errors, 0),
            ballsFaced: parseNullableInt(row.ballsFaced, 'ballsFaced', rowNum, errors, 0),
            notOuts: parseNullableInt(row.notOuts, 'notOuts', rowNum, errors, 0),
            highestScore: parseNullableInt(row.highestScore, 'highestScore', rowNum, errors, 0),
            highestScoreText: isBlankOrUnknown(row.highestScoreText) ? null : row.highestScoreText.trim(),
            battingAverage: parseNullableDecimal(row.battingAverage, 'battingAverage', rowNum, errors),
            strikeRate: parseNullableDecimal(row.strikeRate, 'strikeRate', rowNum, errors),
            fifties: parseNullableInt(row.fifties, 'fifties', rowNum, errors, 0),
            hundreds: parseNullableInt(row.hundreds, 'hundreds', rowNum, errors, 0),
            wickets: parseNullableInt(row.wickets, 'wickets', rowNum, errors, 0),
            ballsBowled: parseNullableInt(row.ballsBowled, 'ballsBowled', rowNum, errors, 0),
            runsConceded: parseNullableInt(row.runsConceded, 'runsConceded', rowNum, errors, 0),
            bowlingAverage: parseNullableDecimal(row.bowlingAverage, 'bowlingAverage', rowNum, errors),
            economy: parseNullableDecimal(row.economy, 'economy', rowNum, errors),
            bowlingStrikeRate: parseNullableDecimal(row.bowlingStrikeRate, 'bowlingStrikeRate', rowNum, errors),
            bestBowling: isBlankOrUnknown(row.bestBowling) ? null : row.bestBowling.trim(),
            catches: parseNullableInt(row.catches, 'catches', rowNum, errors, 0),
            stumpings: parseNullableInt(row.stumpings, 'stumpings', rowNum, errors, 0),
            provenanceSource: row.provenanceSource || input.sourceName
          };

          const existingStat = await tx.playerSeasonStat.findUnique({
            where: { playerId_season: { playerId: match.playerId, season } },
            select: { id: true }
          });
          if (existingStat) {
            await tx.playerSeasonStat.update({
              where: { id: existingStat.id },
              data: statData
            });
            updatedCount++;
          } else {
            await tx.playerSeasonStat.create({
              data: { playerId: match.playerId, season, ...statData }
            });
            insertedCount++;
          }
        }
      }

      return tx.playerImportBatch.create({
        data: {
          sourceName: input.sourceName,
          fileName: input.fileName || null,
          importMode: input.importMode,
          status: 'COMMITTED',
          totalRows: rows.length,
          insertedCount,
          updatedCount,
          skippedCount: 0,
          errorCount: 0,
          insertedPlayerIds,
          provenanceNotes: input.provenanceNotes || null,
          createdBySessionId: sessionId || null
        }
      });
    });

    return {
      batch: {
        id: batch.id,
        sourceName: batch.sourceName,
        fileName: batch.fileName,
        importMode: batch.importMode,
        status: batch.status,
        totalRows: batch.totalRows,
        insertedCount: batch.insertedCount,
        updatedCount: batch.updatedCount,
        skippedCount: batch.skippedCount,
        errorCount: batch.errorCount,
        provenanceNotes: batch.provenanceNotes,
        createdAt: batch.createdAt.toISOString(),
        rolledBackAt: null
      },
      report
    };
  }

  static async rollbackBatch(batchId: string): Promise<PlayerImportBatchDto> {
    const batch = await prisma.playerImportBatch.findUnique({ where: { id: batchId } });
    if (!batch) {
      throw new AppError('Import batch not found.', 404, 'BATCH_NOT_FOUND');
    }
    if (batch.status !== 'COMMITTED') {
      throw new AppError(`Batch cannot be rolled back from status '${batch.status}'.`, 409, 'CANNOT_ROLLBACK');
    }

    const insertedIds = Array.isArray(batch.insertedPlayerIds)
      ? (batch.insertedPlayerIds as string[])
      : [];

    const updated = await prisma.$transaction(async (tx) => {
      if (insertedIds.length > 0) {
        const referencedLots = await tx.roomPlayerLot.findMany({
          where: { playerId: { in: insertedIds } },
          select: { playerId: true }
        });
        const referencedRet = await tx.roomRetention.findMany({
          where: { playerId: { in: insertedIds } },
          select: { playerId: true }
        });
        const protectedIds = new Set([
          ...referencedLots.map((l) => l.playerId),
          ...referencedRet.map((r) => r.playerId)
        ]);
        const safeDeleteIds = insertedIds.filter((id) => !protectedIds.has(id));
        if (safeDeleteIds.length > 0) {
          await tx.masterPlayer.deleteMany({
            where: { id: { in: safeDeleteIds } }
          });
        }
      }

      return tx.playerImportBatch.update({
        where: { id: batchId },
        data: { status: 'ROLLED_BACK', rolledBackAt: new Date() }
      });
    });

    return {
      id: updated.id,
      sourceName: updated.sourceName,
      fileName: updated.fileName,
      importMode: updated.importMode,
      status: updated.status,
      totalRows: updated.totalRows,
      insertedCount: updated.insertedCount,
      updatedCount: updated.updatedCount,
      skippedCount: updated.skippedCount,
      errorCount: updated.errorCount,
      provenanceNotes: updated.provenanceNotes,
      createdAt: updated.createdAt.toISOString(),
      rolledBackAt: updated.rolledBackAt ? updated.rolledBackAt.toISOString() : null
    };
  }

  static async listBatches(): Promise<PlayerImportBatchDto[]> {
    const rows = await prisma.playerImportBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: 25
    });
    return rows.map((b) => ({
      id: b.id,
      sourceName: b.sourceName,
      fileName: b.fileName,
      importMode: b.importMode,
      status: b.status,
      totalRows: b.totalRows,
      insertedCount: b.insertedCount,
      updatedCount: b.updatedCount,
      skippedCount: b.skippedCount,
      errorCount: b.errorCount,
      provenanceNotes: b.provenanceNotes,
      createdAt: b.createdAt.toISOString(),
      rolledBackAt: b.rolledBackAt ? b.rolledBackAt.toISOString() : null
    }));
  }
}
