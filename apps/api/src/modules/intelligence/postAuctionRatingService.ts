import crypto from 'crypto';
import { RoomStatus as DbRoomStatus, prisma } from '@auctioncraze/database';
import { formatFranchiseDisplayName } from '@auctioncraze/shared';
import { AppError } from '../../middleware/errorHandler';
import {
  ActiveOwnerContext,
  assertAuctionCompleted,
  requireActiveFranchiseOwner,
  requireHostCompletedDashboard
} from './intelligenceAuth';
import { callMlService } from './mlClient';

interface SquadPlayerSnapshot {
  playerId: string;
  cricsheetId: string | null;
  externalKey: string | null;
  fullName: string;
  playingRole: string;
  isOverseas: boolean;
  nationality: string | null;
  acquisitionType: 'RETAINED' | 'SOLD';
  priceLakhs: number;
}

interface PostAuctionMlPayload {
  sufficiency_status: string;
  has_sufficient_data: boolean;
  data_confidence: string;
  squad_size: number;
  min_squad_size: number;
  team_ratings: {
    overall_rating: number | null;
    batting_strength: number;
    bowling_strength: number;
    all_rounder_strength: number;
    squad_depth: number;
    pace_coverage: number;
    spin_coverage: number;
    wicketkeeper_coverage: number;
    role_balance: number;
    [key: string]: any;
  };
  overseas_composition: Record<string, any>;
  composition: Record<string, any>;
  sample_size_warnings: string[];
  score_explanations?: Record<string, any>;
  disclaimer?: string;
  playing_xi_prediction?: Record<string, any>;
  [key: string]: any;
}

interface PostAuctionSnapshotSummary {
  roomId: string;
  roomCode: string;
  roomName: string;
  auctionMode: string;
  poolSummary: {
    totalLots: number;
    soldCount: number;
    unsoldExcludedCount: number;
  };
  isOfficialRating: boolean;
  allowBiddingAdvice: boolean;
  disclaimer: string;
  scoreExplanations: Record<string, any>;
  overallRankings: any[];
  franchiseReportsById: Record<string, any>;
}

type PersistedSnapshotResult = PostAuctionSnapshotSummary & {
  snapshotVersion: number;
  rosterFingerprint: string;
  calculatedAt: string;
};

function buildFinalizedRosterFromFranchise(franchise: any): SquadPlayerSnapshot[] {
  const seen = new Set<string>();
  const roster: SquadPlayerSnapshot[] = [];

  for (const r of franchise.retentions || []) {
    if (!r.player || seen.has(r.player.id)) continue;
    seen.add(r.player.id);
    roster.push({
      playerId: r.player.id,
      cricsheetId: r.player.cricsheetId,
      externalKey: r.player.externalKey,
      fullName: r.player.fullName,
      playingRole: r.player.playingRole,
      isOverseas: r.player.isOverseas,
      nationality: r.player.nationality,
      acquisitionType: 'RETAINED',
      priceLakhs: r.retentionCostLakhs
    });
  }

  // Strictly finalized SOLD purchases only (Purchase rows are created atomically only on SOLD; UNSOLD lots have no Purchase row)
  for (const p of franchise.purchases || []) {
    if (!p.player || seen.has(p.player.id)) continue;
    seen.add(p.player.id);
    roster.push({
      playerId: p.player.id,
      cricsheetId: p.player.cricsheetId,
      externalKey: p.player.externalKey,
      fullName: p.player.fullName,
      playingRole: p.player.playingRole,
      isOverseas: p.player.isOverseas,
      nationality: p.player.nationality,
      acquisitionType: 'SOLD',
      priceLakhs: p.purchasePriceLakhs
    });
  }

  return roster;
}

function computeRosterFingerprint(
  franchises: Array<{ id: string; presetCode: string; roster: SquadPlayerSnapshot[] }>
): string {
  const canonical = [...franchises]
    .sort((a, b) => a.presetCode.localeCompare(b.presetCode))
    .map((f) => ({
      franchiseId: f.id,
      code: f.presetCode,
      players: [...f.roster]
        .sort((x, y) => x.playerId.localeCompare(y.playerId))
        .map((p) => `${p.playerId}:${p.acquisitionType}:${p.priceLakhs}`)
    }));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24);
}

async function loadRoomForPostAuction(roomId: string) {
  return prisma.room.findUniqueOrThrow({
    where: { id: roomId },
    include: {
      franchises: {
        orderBy: { presetCode: 'asc' },
        include: {
          owner: {
            select: {
              id: true,
              displayName: true,
              role: true,
              isRemoved: true,
              leftAt: true
            }
          },
          retentions: {
            orderBy: { slotNumber: 'asc' },
            include: {
              player: {
                select: {
                  id: true,
                  cricsheetId: true,
                  externalKey: true,
                  fullName: true,
                  playingRole: true,
                  isOverseas: true,
                  nationality: true
                }
              }
            }
          },
          purchases: {
            orderBy: { soldAt: 'asc' },
            include: {
              player: {
                select: {
                  id: true,
                  cricsheetId: true,
                  externalKey: true,
                  fullName: true,
                  playingRole: true,
                  isOverseas: true,
                  nationality: true
                }
              }
            }
          }
        }
      },
      lots: {
        select: { status: true }
      }
    }
  });
}

async function computeAndPersistSnapshot(
  ctx: ActiveOwnerContext,
  forceRecalculate: boolean
): Promise<PersistedSnapshotResult> {
  const room = await loadRoomForPostAuction(ctx.room.id);
  if (room.status !== DbRoomStatus.COMPLETED) {
    throw new AppError(
      `Post-auction team ratings are only available once the auction reaches COMPLETED (current status: ${room.status}).`,
      409,
      'AUCTION_NOT_COMPLETED'
    );
  }

  const enrichedFranchises = room.franchises.map((f) => {
    const activeOwner =
      f.owner && !f.owner.isRemoved && !f.owner.leftAt ? f.owner : null;
    const roster = buildFinalizedRosterFromFranchise(f);
    const spentLakhs = roster.reduce((acc, p) => acc + p.priceLakhs, 0);
    return {
      franchise: f,
      ownerDisplayName: activeOwner?.displayName || null,
      isClaimed: Boolean(activeOwner),
      roster,
      spentLakhs
    };
  });

  // Include all claimed franchises plus any franchise holding purchased/retained players
  const activeFranchises = enrichedFranchises.filter(
    (item) => item.isClaimed || item.roster.length > 0
  );

  const rosterFingerprint = computeRosterFingerprint(
    activeFranchises.map((item) => ({
      id: item.franchise.id,
      presetCode: item.franchise.presetCode,
      roster: item.roster
    }))
  );

  const latestSnapshot = await prisma.postAuctionRatingSnapshot.findFirst({
    where: { roomId: room.id },
    orderBy: { snapshotVersion: 'desc' }
  });

  if (
    latestSnapshot &&
    !forceRecalculate &&
    latestSnapshot.rosterFingerprint === rosterFingerprint
  ) {
    const cached = latestSnapshot.summaryJson as unknown as PostAuctionSnapshotSummary;
    const liveById = new Map(room.franchises.map((f) => [f.id, f]));
    const updatedRankings = (cached.overallRankings || []).map((row: any) => {
      const f = liveById.get(row.franchiseId);
      const disp = f
        ? formatFranchiseDisplayName(f.name, f.presetCode, f.customSuffix, !!room.allowCustomTeamName)
        : row.franchiseDisplayName || row.franchiseName;
      return { ...row, franchiseDisplayName: disp };
    });
    const updatedReportsById: Record<string, any> = {};
    for (const [fId, rep] of Object.entries(cached.franchiseReportsById || {})) {
      const f = liveById.get(fId);
      const disp = f
        ? formatFranchiseDisplayName(f.name, f.presetCode, f.customSuffix, !!room.allowCustomTeamName)
        : (rep as any).franchiseDisplayName || (rep as any).franchiseName;
      updatedReportsById[fId] = { ...(rep as any), franchiseDisplayName: disp };
    }
    return {
      ...cached,
      overallRankings: updatedRankings,
      franchiseReportsById: updatedReportsById,
      snapshotVersion: latestSnapshot.snapshotVersion,
      rosterFingerprint: latestSnapshot.rosterFingerprint,
      calculatedAt: latestSnapshot.calculatedAt.toISOString()
    };
  }

  // Call Python ML service for each franchise's actual purchased + retained squad
  const rawReports = await Promise.all(
    activeFranchises.map(async (item) => {
      const mlPayload = await callMlService<PostAuctionMlPayload>(
        '/v1/analysis/post-auction-franchise',
        {
          method: 'POST',
          body: {
            room_id: room.id,
            franchise_code: item.franchise.presetCode,
            squad: item.roster.map((p) => ({
              player_id: p.cricsheetId || p.externalKey || p.fullName,
              playing_role: p.playingRole,
              is_overseas: p.isOverseas
            })),
            min_squad_size: room.minSquadSize,
            max_squad_size: room.maxSquadSize,
            max_overseas_in_squad: room.maxOverseas
          }
        }
      );

      return {
        ...mlPayload,
        franchiseId: item.franchise.id,
        franchiseCode: item.franchise.presetCode,
        franchiseName: item.franchise.name,
        franchiseDisplayName: formatFranchiseDisplayName(
          item.franchise.name,
          item.franchise.presetCode,
          item.franchise.customSuffix,
          !!room.allowCustomTeamName
        ),
        primaryColor: item.franchise.primaryColor,
        secondaryColor: item.franchise.secondaryColor,
        ownerDisplayName: item.ownerDisplayName,
        isClaimed: item.isClaimed,
        initialPurseLakhs: item.franchise.initialPurseLakhs,
        remainingPurseLakhs: item.franchise.remainingPurseLakhs,
        spentLakhs: item.spentLakhs,
        roster: item.roster
      };
    })
  );

  // Assign deterministic ranking strictly among franchises with sufficient data; insufficient teams retain rank: null
  const rankable = rawReports
    .filter((r) => r.has_sufficient_data && typeof r.team_ratings?.overall_rating === 'number')
    .sort((a, b) => {
      const diff = (b.team_ratings.overall_rating || 0) - (a.team_ratings.overall_rating || 0);
      if (Math.abs(diff) > 1e-4) return diff;
      const depthDiff =
        (b.team_ratings.batting_strength + b.team_ratings.bowling_strength) -
        (a.team_ratings.batting_strength + a.team_ratings.bowling_strength);
      if (Math.abs(depthDiff) > 1e-4) return depthDiff;
      return a.franchiseCode.localeCompare(b.franchiseCode);
    });

  const rankByFranchiseId = new Map<string, number>();
  rankable.forEach((r, idx) => {
    rankByFranchiseId.set(r.franchiseId, idx + 1);
  });

  const reportsWithRank = rawReports.map((r) => ({
    ...r,
    rank: rankByFranchiseId.get(r.franchiseId) ?? null
  }));

  reportsWithRank.sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
    if (a.rank !== null) return -1;
    if (b.rank !== null) return 1;
    return a.franchiseCode.localeCompare(b.franchiseCode);
  });

  const soldCount = room.lots.filter((l) => l.status === 'SOLD').length;
  const unsoldCount = room.lots.filter((l) => l.status === 'UNSOLD').length;

  const overallRankings = reportsWithRank.map((r) => ({
    franchiseId: r.franchiseId,
    franchiseCode: r.franchiseCode,
    franchiseName: r.franchiseName,
    franchiseDisplayName: r.franchiseDisplayName ?? r.franchiseName,
    primaryColor: r.primaryColor,
    secondaryColor: r.secondaryColor,
    ownerDisplayName: r.ownerDisplayName,
    isClaimed: r.isClaimed,
    rank: r.rank,
    sufficiencyStatus: r.sufficiency_status,
    hasSufficientData: r.has_sufficient_data,
    dataConfidence: r.data_confidence,
    squadSize: r.squad_size,
    minSquadSize: r.min_squad_size,
    remainingPurseLakhs: r.remainingPurseLakhs,
    spentLakhs: r.spentLakhs,
    overallRating: r.team_ratings.overall_rating,
    battingStrength: r.team_ratings.batting_strength,
    bowlingStrength: r.team_ratings.bowling_strength,
    allRounderStrength: r.team_ratings.all_rounder_strength,
    squadDepth: r.team_ratings.squad_depth,
    paceCoverage: r.team_ratings.pace_coverage,
    spinCoverage: r.team_ratings.spin_coverage,
    wicketkeeperCoverage: r.team_ratings.wicketkeeper_coverage,
    roleBalance: r.team_ratings.role_balance,
    overseasComposition: r.overseas_composition,
    composition: r.composition,
    sampleSizeWarnings: r.sample_size_warnings
  }));

  const franchiseReportsById: Record<string, any> = {};
  for (const r of reportsWithRank) {
    franchiseReportsById[r.franchiseId] = r;
  }

  const firstMethodology = reportsWithRank[0]?.score_explanations || {};
  const nextVersion = (latestSnapshot?.snapshotVersion ?? 0) + 1;

  const summaryPayload = {
    roomId: room.id,
    roomCode: room.code,
    roomName: room.name,
    auctionMode: room.auctionMode,
    poolSummary: {
      totalLots: room.lots.length,
      soldCount,
      unsoldExcludedCount: unsoldCount
    },
    isOfficialRating: false,
    allowBiddingAdvice: false,
    disclaimer:
      reportsWithRank[0]?.disclaimer ||
      'POST_AUCTION_ANALYTICAL_REPORT (No buying/selling/retention advice)',
    scoreExplanations: firstMethodology,
    overallRankings,
    franchiseReportsById
  };

  const saved = await prisma.postAuctionRatingSnapshot.create({
    data: {
      roomId: room.id,
      snapshotVersion: nextVersion,
      rosterFingerprint,
      triggeredByRole: ctx.participant.role,
      summaryJson: summaryPayload as any
    }
  });

  return {
    snapshotVersion: saved.snapshotVersion,
    rosterFingerprint: saved.rosterFingerprint,
    calculatedAt: saved.calculatedAt.toISOString(),
    ...summaryPayload
  };
}

export class PostAuctionRatingService {
  static async getReadiness(code: string, guestSessionId: string) {
    const ctx = await requireActiveFranchiseOwner(guestSessionId, code);
    const isCompleted = ctx.room.status === DbRoomStatus.COMPLETED;
    const latest = await prisma.postAuctionRatingSnapshot.findFirst({
      where: { roomId: ctx.room.id },
      orderBy: { snapshotVersion: 'desc' },
      select: {
        snapshotVersion: true,
        rosterFingerprint: true,
        calculatedAt: true
      }
    });

    return {
      roomCode: ctx.room.code,
      roomStatus: ctx.room.status,
      isCompleted,
      isHost: ctx.participant.isHost,
      role: ctx.participant.role,
      ownedFranchiseId: ctx.ownedFranchise.id,
      ownedFranchiseCode: ctx.ownedFranchise.presetCode,
      ownedFranchiseName: ctx.ownedFranchise.name,
      latestSnapshotVersion: latest?.snapshotVersion ?? null,
      rosterFingerprint: latest?.rosterFingerprint ?? null,
      calculatedAt: latest?.calculatedAt?.toISOString() ?? null,
      message: isCompleted
        ? 'Auction completed. Post-auction analytics are ready.'
        : `Auction is currently ${ctx.room.status}. Post-auction team ratings unlock once the auction is COMPLETED.`
    };
  }

  static async getHostRatings(code: string, guestSessionId: string) {
    const ctx = await requireHostCompletedDashboard(guestSessionId, code);
    const snap = await computeAndPersistSnapshot(ctx, false);
    return {
      roomCode: snap.roomCode,
      roomName: snap.roomName,
      auctionMode: snap.auctionMode,
      snapshotVersion: snap.snapshotVersion,
      rosterFingerprint: snap.rosterFingerprint,
      calculatedAt: snap.calculatedAt,
      poolSummary: snap.poolSummary,
      isOfficialRating: false,
      allowBiddingAdvice: false,
      disclaimer: snap.disclaimer,
      scoreExplanations: snap.scoreExplanations,
      overallRankings: snap.overallRankings
    };
  }

  static async getHostComparison(code: string, guestSessionId: string) {
    const ctx = await requireHostCompletedDashboard(guestSessionId, code);
    const snap = await computeAndPersistSnapshot(ctx, false);
    return {
      roomCode: snap.roomCode,
      snapshotVersion: snap.snapshotVersion,
      rosterFingerprint: snap.rosterFingerprint,
      calculatedAt: snap.calculatedAt,
      isOfficialRating: false,
      allowBiddingAdvice: false,
      disclaimer: snap.disclaimer,
      scoreExplanations: snap.scoreExplanations,
      teams: snap.overallRankings
    };
  }

  static async recalculate(code: string, guestSessionId: string) {
    const ctx = await requireHostCompletedDashboard(guestSessionId, code);
    const snap = await computeAndPersistSnapshot(ctx, true);
    return {
      roomCode: snap.roomCode,
      roomName: snap.roomName,
      auctionMode: snap.auctionMode,
      snapshotVersion: snap.snapshotVersion,
      rosterFingerprint: snap.rosterFingerprint,
      calculatedAt: snap.calculatedAt,
      poolSummary: snap.poolSummary,
      isOfficialRating: false,
      allowBiddingAdvice: false,
      disclaimer: snap.disclaimer,
      scoreExplanations: snap.scoreExplanations,
      overallRankings: snap.overallRankings
    };
  }

  static async getFranchiseReport(
    code: string,
    guestSessionId: string,
    franchiseIdOrCode: string
  ) {
    const ctx = await requireActiveFranchiseOwner(guestSessionId, code);
    assertAuctionCompleted(ctx);

    const key = franchiseIdOrCode.trim();
    if (!key) {
      throw new AppError('Franchise identifier is required.', 400, 'INVALID_FRANCHISE_ID');
    }

    const targetFranchise = await prisma.roomFranchise.findFirst({
      where: {
        roomId: ctx.room.id,
        OR: [{ id: key }, { presetCode: key.toUpperCase() }]
      },
      select: { id: true, presetCode: true, name: true, customSuffix: true }
    });

    if (!targetFranchise) {
      throw new AppError(
        `Franchise '${key}' not found in room '${ctx.room.code}'.`,
        404,
        'FRANCHISE_NOT_FOUND'
      );
    }

    // Host may inspect any franchise in this completed room; non-host owner ONLY their own!
    if (!ctx.participant.isHost && targetFranchise.id !== ctx.ownedFranchise.id) {
      throw new AppError(
        'Access denied: franchise owners can only view their own post-auction franchise report.',
        403,
        'FRANCHISE_OWNERSHIP_REQUIRED'
      );
    }

    const snap = await computeAndPersistSnapshot(ctx, false);
    const report = snap.franchiseReportsById?.[targetFranchise.id];
    if (!report) {
      throw new AppError(
        `No post-auction report available for '${targetFranchise.presetCode}' (unclaimed and empty).`,
        404,
        'FRANCHISE_REPORT_NOT_AVAILABLE'
      );
    }

    return {
      roomCode: snap.roomCode,
      snapshotVersion: snap.snapshotVersion,
      rosterFingerprint: snap.rosterFingerprint,
      calculatedAt: snap.calculatedAt,
      isOfficialRating: false,
      allowBiddingAdvice: false,
      report
    };
  }

  static async getFranchisePlayingXI(
    code: string,
    guestSessionId: string,
    franchiseIdOrCode: string
  ) {
    const data = await this.getFranchiseReport(code, guestSessionId, franchiseIdOrCode);
    return {
      roomCode: data.roomCode,
      snapshotVersion: data.snapshotVersion,
      calculatedAt: data.calculatedAt,
      franchiseId: data.report.franchiseId,
      franchiseCode: data.report.franchiseCode,
      franchiseName: data.report.franchiseName,
      allowBiddingAdvice: false,
      playingXiPrediction: data.report.playing_xi_prediction
    };
  }
}
