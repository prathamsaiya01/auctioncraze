import { Request, Response, NextFunction } from 'express';
import { CricketRole, prisma } from '@auctioncraze/database';
import {
  csvImportSchema,
  MasterPlayerCatalogDto,
  PlayerCareerSummaryDto,
  PlayerProfileDetailDto,
  PlayerSeasonStatDto
} from '@auctioncraze/shared';
import { AuthenticatedRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import { PlayerImportService } from './playerImportService';

function toNum(d: any): number | null {
  if (d === null || d === undefined) return null;
  const n = Number(d);
  return Number.isFinite(n) ? n : null;
}

function sumNullable(values: Array<number | null | undefined>): number | null {
  let sum = 0;
  let seen = false;
  for (const v of values) {
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      sum += v;
      seen = true;
    }
  }
  return seen ? sum : null;
}

function computeCareerSummary(stats: PlayerSeasonStatDto[]): PlayerCareerSummaryDto {
  const matches = sumNullable(stats.map((s) => s.matches));
  const batInnings = sumNullable(stats.map((s) => s.battingInnings ?? (s.runs !== null ? s.innings : null)));
  const totalRuns = sumNullable(stats.map((s) => s.runs));
  const ballsFaced = sumNullable(stats.map((s) => s.ballsFaced));
  const notOuts = sumNullable(stats.map((s) => s.notOuts));
  const fifties = sumNullable(stats.map((s) => s.fifties));
  const hundreds = sumNullable(stats.map((s) => s.hundreds));

  let bestHsText: string | null = null;
  let bestHsVal = -1;
  let bestHsNo = false;
  for (const s of stats) {
    if (s.highestScore === null) continue;
    const isNo = Boolean(s.highestScoreText?.endsWith('*'));
    if (s.highestScore > bestHsVal || (s.highestScore === bestHsVal && isNo && !bestHsNo)) {
      bestHsVal = s.highestScore;
      bestHsNo = isNo;
      bestHsText = s.highestScoreText || String(s.highestScore);
    }
  }

  let dismissals: number | null = null;
  if (batInnings !== null && notOuts !== null) {
    dismissals = Math.max(0, batInnings - notOuts);
  }
  const batAverage =
    totalRuns !== null && dismissals !== null && dismissals > 0
      ? Number((totalRuns / dismissals).toFixed(2))
      : null;
  const batStrikeRate =
    totalRuns !== null && ballsFaced !== null && ballsFaced > 0
      ? Number(((totalRuns * 100) / ballsFaced).toFixed(2))
      : null;

  const bowlInnings = sumNullable(stats.map((s) => s.bowlingInnings));
  const totalWickets = sumNullable(stats.map((s) => s.wickets));
  const ballsBowled = sumNullable(stats.map((s) => s.ballsBowled));
  const runsConceded = sumNullable(stats.map((s) => s.runsConceded));

  const bowlAverage =
    runsConceded !== null && totalWickets !== null && totalWickets > 0
      ? Number((runsConceded / totalWickets).toFixed(2))
      : null;
  const economy =
    runsConceded !== null && ballsBowled !== null && ballsBowled > 0
      ? Number(((runsConceded * 6) / ballsBowled).toFixed(2))
      : null;
  const bowlStrikeRate =
    ballsBowled !== null && totalWickets !== null && totalWickets > 0
      ? Number((ballsBowled / totalWickets).toFixed(2))
      : null;

  let bestBowling: string | null = null;
  let bestW = -1;
  let bestR = Number.MAX_SAFE_INTEGER;
  for (const s of stats) {
    if (!s.bestBowling || !s.bestBowling.includes('/')) continue;
    const [wStr, rStr] = s.bestBowling.split('/');
    const w = Number(wStr);
    const r = Number(rStr);
    if (Number.isFinite(w) && Number.isFinite(r)) {
      if (w > bestW || (w === bestW && r < bestR)) {
        bestW = w;
        bestR = r;
        bestBowling = s.bestBowling;
      }
    }
  }

  const catches = sumNullable(stats.map((s) => s.catches));
  const stumpings = sumNullable(stats.map((s) => s.stumpings));

  return {
    seasonsPlayed: stats.length,
    matches,
    batting: {
      innings: batInnings,
      runs: totalRuns,
      ballsFaced,
      notOuts,
      highestScoreText: bestHsText,
      average: batAverage,
      strikeRate: batStrikeRate,
      fifties,
      hundreds
    },
    bowling: {
      innings: bowlInnings,
      wickets: totalWickets,
      ballsBowled,
      runsConceded,
      average: bowlAverage,
      economy,
      strikeRate: bowlStrikeRate,
      bestBowling
    },
    fielding: {
      catches,
      stumpings
    }
  };
}

export class PlayerController {
  static async listCatalog(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const role = typeof req.query.role === 'string' ? req.query.role.trim().toUpperCase() : '';
      const overseasParam = req.query.overseas;
      const team = typeof req.query.team === 'string' ? req.query.team.trim().toUpperCase() : '';
      const seasonParam = typeof req.query.season === 'string' ? Number(req.query.season) : null;
      const sortParam = typeof req.query.sort === 'string' ? req.query.sort : 'basePrice';

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(250, Math.max(1, Number(req.query.limit) || 100));

      const where: any = { isActive: true };
      if (search) {
        where.OR = [
          { fullName: { contains: search, mode: 'insensitive' } },
          { nationality: { contains: search, mode: 'insensitive' } },
          { cricsheetId: { contains: search, mode: 'insensitive' } },
          { cricinfoId: { contains: search, mode: 'insensitive' } }
        ];
      }
      if (role && Object.values(CricketRole).includes(role as CricketRole)) {
        where.playingRole = role as CricketRole;
      }
      if (overseasParam === 'true') where.isOverseas = true;
      if (overseasParam === 'false') where.isOverseas = false;
      if (team) {
        where.teamHistoryJson = { array_contains: team };
      }
      if (seasonParam && Number.isInteger(seasonParam)) {
        where.seasonStats = { some: { season: seasonParam } };
      }

      const isStatSort = sortParam === 'runs' || sortParam === 'wickets' || sortParam === 'matches';

      const [total, players, statAggs, distinctSeasons] = await Promise.all([
        prisma.masterPlayer.count({ where }),
        prisma.masterPlayer.findMany({
          where,
          include: {
            seasonStats: {
              select: { matches: true, runs: true, wickets: true }
            }
          },
          orderBy:
            sortParam === 'name'
              ? [{ fullName: 'asc' }]
              : [{ basePriceLakhs: 'desc' }, { iplLastYear: 'desc' }, { fullName: 'asc' }],
          ...(isStatSort ? {} : { skip: (page - 1) * limit, take: limit })
        }),
        prisma.playerSeasonStat.aggregate({ _count: { id: true } }),
        prisma.playerSeasonStat.findMany({
          distinct: ['season'],
          select: { season: true },
          orderBy: { season: 'desc' }
        })
      ]);

      let mapped: MasterPlayerCatalogDto[] = players.map((p) => {
        const careerMatches = sumNullable(p.seasonStats.map((s) => s.matches));
        const careerRuns = sumNullable(p.seasonStats.map((s) => s.runs));
        const careerWickets = sumNullable(p.seasonStats.map((s) => s.wickets));

        return {
          id: p.id,
          externalKey: p.externalKey,
          cricsheetId: p.cricsheetId,
          cricinfoId: p.cricinfoId,
          fullName: p.fullName,
          nationality: p.nationality,
          isOverseas: p.isOverseas,
          age: p.age,
          playingRole: p.playingRole as any,
          secondaryRole: (p.secondaryRole as any) || null,
          battingStyle: p.battingStyle,
          bowlingStyle: p.bowlingStyle,
          basePriceLakhs: p.basePriceLakhs,
          imageUrl: p.imageUrl,
          iplDebutYear: p.iplDebutYear,
          iplLastYear: p.iplLastYear,
          teamHistory: Array.isArray(p.teamHistoryJson) ? (p.teamHistoryJson as string[]) : [],
          provenanceSource: p.provenanceSource,
          seasonCoverage: p.seasonCoverage,
          careerMatches,
          careerRuns,
          careerWickets
        };
      });

      if (sortParam === 'runs') {
        mapped.sort((a, b) => (b.careerRuns ?? -1) - (a.careerRuns ?? -1));
      } else if (sortParam === 'wickets') {
        mapped.sort((a, b) => (b.careerWickets ?? -1) - (a.careerWickets ?? -1));
      } else if (sortParam === 'matches') {
        mapped.sort((a, b) => (b.careerMatches ?? -1) - (a.careerMatches ?? -1));
      }

      if (isStatSort) {
        mapped = mapped.slice((page - 1) * limit, page * limit);
      }

      res.json({
        success: true,
        data: mapped,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(total / limit)),
          seasonsAvailable: distinctSeasons.map((s) => s.season),
          totalSeasonRecords: statAggs._count.id
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async getProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = String(req.params.id || '').trim();
      if (!id) {
        throw new AppError('Player ID is required.', 400, 'INVALID_PLAYER_ID');
      }

      const player = await prisma.masterPlayer.findFirst({
        where: { OR: [{ id }, { externalKey: id }, { cricsheetId: id }] },
        include: {
          seasonStats: {
            orderBy: { season: 'desc' }
          }
        }
      });

      if (!player) {
        throw new AppError('Player not found.', 404, 'PLAYER_NOT_FOUND');
      }

      const seasonStats: PlayerSeasonStatDto[] = player.seasonStats.map((s) => ({
        id: s.id,
        season: s.season,
        teamCode: s.teamCode,
        matches: s.matches,
        innings: s.innings,
        battingInnings: s.battingInnings,
        bowlingInnings: s.bowlingInnings,
        runs: s.runs,
        ballsFaced: s.ballsFaced,
        notOuts: s.notOuts,
        highestScore: s.highestScore,
        highestScoreText: s.highestScoreText,
        battingAverage: toNum(s.battingAverage),
        strikeRate: toNum(s.strikeRate),
        fifties: s.fifties,
        hundreds: s.hundreds,
        wickets: s.wickets,
        ballsBowled: s.ballsBowled,
        runsConceded: s.runsConceded,
        bowlingAverage: toNum(s.bowlingAverage),
        economy: toNum(s.economy),
        bowlingStrikeRate: toNum(s.bowlingStrikeRate),
        bestBowling: s.bestBowling,
        catches: s.catches,
        stumpings: s.stumpings,
        provenanceSource: s.provenanceSource
      }));

      const careerSummary = computeCareerSummary(seasonStats);

      const profile: PlayerProfileDetailDto = {
        id: player.id,
        externalKey: player.externalKey,
        cricsheetId: player.cricsheetId,
        cricinfoId: player.cricinfoId,
        fullName: player.fullName,
        nationality: player.nationality,
        isOverseas: player.isOverseas,
        dateOfBirth: player.dateOfBirth ? player.dateOfBirth.toISOString().slice(0, 10) : null,
        age: player.age,
        playingRole: player.playingRole as any,
        secondaryRole: (player.secondaryRole as any) || null,
        battingStyle: player.battingStyle,
        bowlingStyle: player.bowlingStyle,
        basePriceLakhs: player.basePriceLakhs,
        imageUrl: player.imageUrl,
        iplDebutYear: player.iplDebutYear,
        iplLastYear: player.iplLastYear,
        teamHistory: Array.isArray(player.teamHistoryJson) ? (player.teamHistoryJson as string[]) : [],
        provenanceSource: player.provenanceSource,
        seasonCoverage: player.seasonCoverage,
        careerMatches: careerSummary.matches,
        careerRuns: careerSummary.batting.runs,
        careerWickets: careerSummary.bowling.wickets,
        careerSummary,
        seasonStats
      };

      res.json({ success: true, data: profile });
    } catch (err) {
      next(err);
    }
  }

  static async previewImport(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const payload = csvImportSchema.parse(req.body);
      const report = await PlayerImportService.previewImport(payload);
      res.json({ success: true, data: report });
    } catch (err) {
      next(err);
    }
  }

  static async commitImport(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const payload = csvImportSchema.parse(req.body);
      const result = await PlayerImportService.commitImport(payload, req.guestSession?.id);
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  static async listImportBatches(
    _req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const batches = await PlayerImportService.listBatches();
      res.json({ success: true, data: batches });
    } catch (err) {
      next(err);
    }
  }

  static async rollbackImportBatch(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const batchId = String(req.params.batchId || '');
      const updated = await PlayerImportService.rollbackBatch(batchId);
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  }
}
