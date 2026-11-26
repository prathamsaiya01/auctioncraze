import crypto from 'crypto';
import {
  AuctionMode as DbAuctionMode,
  Prisma,
  RoomStatus as DbRoomStatus,
  SeasonStatus as DbSeasonStatus,
  prisma
} from '@auctioncraze/database';
import {
  AuctionMode,
  IPL_FRANCHISE_PRESETS,
  RoomStatus,
  RoomVisibility,
  SOCKET_EVENTS,
  SOCKET_ROOMS,
  SeasonAuctionSummaryDto,
  SeasonDetailDto,
  SeasonFranchiseLeaderboardRowDto,
  SeasonPointLedgerDto,
  SeasonStatus,
  SeasonSummaryDto,
  formatFranchiseDisplayName
} from '@auctioncraze/shared';
import { AppError } from '../../middleware/errorHandler';
import { getIO } from '../../sockets/socketServer';
import { RoomService } from '../rooms/roomService';

const SEASON_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

function generateSeasonCode(year: number): string {
  const bytes = crypto.randomBytes(4);
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += SEASON_CODE_CHARS[bytes[i] % SEASON_CODE_CHARS.length];
  }
  return `SZN-${String(year).slice(-2)}-${suffix}`;
}

function generateShortRecoveryToken(): string {
  const bytes = crypto.randomBytes(6);
  let token = 'REC-';
  for (let i = 0; i < 6; i++) {
    token += SEASON_CODE_CHARS[bytes[i] % SEASON_CODE_CHARS.length];
  }
  return token;
}

function sortSeasonEntries(a: { totalPoints: number; auctionsJoined: number; presetCode: string }, b: { totalPoints: number; auctionsJoined: number; presetCode: string }): number {
  if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
  if (b.auctionsJoined !== a.auctionsJoined) return b.auctionsJoined - a.auctionsJoined;
  return a.presetCode.localeCompare(b.presetCode);
}

export class SeasonService {
  private static async allocateUniqueSeasonCode(year: number): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const code = generateSeasonCode(year);
      const existing = await prisma.season.findUnique({ where: { code }, select: { id: true } });
      if (!existing) return code;
    }
    throw new AppError('Unable to generate unique season code. Please retry.', 503, 'CODE_GENERATION_FAILED');
  }

  static async createSeason(input: {
    guestSessionId: string;
    defaultDisplayName: string;
    displayNameOverride?: string;
    name: string;
    year: number;
    description?: string;
    startDate?: string;
    endDate?: string;
  }): Promise<SeasonDetailDto> {
    const code = await SeasonService.allocateUniqueSeasonCode(input.year);
    const parsedStart = input.startDate ? new Date(input.startDate) : null;
    const parsedEnd = input.endDate ? new Date(input.endDate) : null;
    if (parsedStart && Number.isNaN(parsedStart.getTime())) {
      throw new AppError('Invalid startDate format.', 400, 'INVALID_DATE');
    }
    if (parsedEnd && Number.isNaN(parsedEnd.getTime())) {
      throw new AppError('Invalid endDate format.', 400, 'INVALID_DATE');
    }
    if (parsedStart && parsedEnd && parsedEnd < parsedStart) {
      throw new AppError('Season endDate cannot be earlier than startDate.', 400, 'INVALID_DATE_RANGE');
    }

    const hostDisplay = input.displayNameOverride?.trim() || input.defaultDisplayName;

    await prisma.$transaction(async (tx) => {
      if (input.displayNameOverride && input.displayNameOverride.trim() !== input.defaultDisplayName) {
        await tx.guestSession.update({
          where: { id: input.guestSessionId },
          data: { displayName: hostDisplay, lastSeenAt: new Date() }
        });
      }

      const season = await tx.season.create({
        data: {
          code,
          name: input.name.trim(),
          year: input.year,
          description: input.description?.trim() || null,
          startDate: parsedStart,
          endDate: parsedEnd,
          status: DbSeasonStatus.ACTIVE,
          hostSessionId: input.guestSessionId
        }
      });

      for (const preset of IPL_FRANCHISE_PRESETS) {
        await tx.seasonFranchiseEntry.create({
          data: {
            seasonId: season.id,
            presetCode: preset.code,
            name: preset.name,
            abbreviation: preset.shortName,
            primaryColor: preset.primaryColor,
            secondaryColor: preset.secondaryColor
          }
        });
      }
    });

    return SeasonService.getSeasonByCode(code, input.guestSessionId);
  }

  static async listSeasons(): Promise<SeasonSummaryDto[]> {
    const seasons = await prisma.season.findMany({
      include: {
        _count: {
          select: { rooms: true }
        },
        entries: {
          select: { controllerSessionId: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 40
    });

    return seasons.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      year: s.year,
      description: s.description,
      status: s.status as unknown as SeasonStatus,
      auctionCount: s._count.rooms,
      claimedFranchisesCount: s.entries.filter((e) => e.controllerSessionId !== null).length,
      startDate: s.startDate ? s.startDate.toISOString() : null,
      endDate: s.endDate ? s.endDate.toISOString() : null,
      createdAt: s.createdAt.toISOString()
    }));
  }

  static async getSeasonByCode(
    code: string,
    requesterSessionId?: string,
    filters?: { monthKey?: string; roomCode?: string }
  ): Promise<SeasonDetailDto> {
    const normalized = code.trim().toUpperCase();
    const season = await prisma.season.findUnique({
      where: { code: normalized },
      include: {
        entries: {
          orderBy: { presetCode: 'asc' },
          include: {
            roomFranchises: {
              include: {
                room: { select: { id: true, code: true, name: true, seasonMonthKey: true } },
                owner: { select: { id: true } }
              }
            }
          }
        },
        rooms: {
          include: {
            participants: {
              where: { isRemoved: false, leftAt: null, franchiseId: { not: null } },
              select: { id: true }
            }
          },
          orderBy: { createdAt: 'desc' }
        },
        pointLedger: {
          include: {
            entry: { select: { presetCode: true, name: true, customSuffix: true } }
          },
          orderBy: { createdAt: 'desc' },
          take: 200
        }
      }
    });

    if (!season) {
      throw new AppError(`Season '${normalized}' not found.`, 404, 'SEASON_NOT_FOUND');
    }

    const roomById = new Map(season.rooms.map((r) => [r.id, r]));
    const filterMonth = filters?.monthKey?.trim() || null;
    const filterRoomCode = filters?.roomCode?.trim().toUpperCase() || null;
    const filterRoomId = filterRoomCode
      ? season.rooms.find((r) => r.code === filterRoomCode)?.id || '__NON_MATCHING__'
      : null;

    // Overall rank map for rank movement calculation
    const overallSorted = [...season.entries].sort(sortSeasonEntries);
    const overallRankById = new Map<string, number>();
    overallSorted.forEach((e, idx) => overallRankById.set(e.id, idx + 1));

    const entryRowsRaw = season.entries.map((entry) => {
      const entryLedger = season.pointLedger.filter((l) => l.entryId === entry.id);

      // Compute points grouped per auction / month
      const bucketMap = new Map<
        string,
        { roomId: string | null; roomCode: string | null; roomName: string | null; monthKey: string | null; points: number }
      >();
      for (const l of entryLedger) {
        const linkedRoom = l.roomId ? roomById.get(l.roomId) : undefined;
        const mKey = l.monthKey || linkedRoom?.seasonMonthKey || null;
        const bucketKey = `${l.roomId || 'general'}::${mKey || 'none'}`;
        const existing = bucketMap.get(bucketKey);
        if (existing) {
          existing.points += l.pointsDelta;
        } else {
          bucketMap.set(bucketKey, {
            roomId: l.roomId,
            roomCode: linkedRoom?.code || null,
            roomName: linkedRoom?.name || null,
            monthKey: mKey,
            points: l.pointsDelta
          });
        }
      }

      const filteredPoints = entryLedger
        .filter((l) => {
          const linkedRoom = l.roomId ? roomById.get(l.roomId) : undefined;
          const mKey = l.monthKey || linkedRoom?.seasonMonthKey || null;
          if (filterRoomId && l.roomId !== filterRoomId) return false;
          if (filterMonth && mKey !== filterMonth) return false;
          return true;
        })
        .reduce((acc, l) => acc + l.pointsDelta, 0);

      const distinctAuctionsJoined = new Set(
        entry.roomFranchises.filter((rf) => rf.owner !== null).map((rf) => rf.roomId)
      ).size;
      const auctionsParticipated = Math.max(entry.auctionsJoined, distinctAuctionsJoined);
      const currentOverallRank = overallRankById.get(entry.id) || 10;
      const rankMovement =
        entry.previousRank !== null && entry.previousRank !== undefined
          ? entry.previousRank - currentOverallRank
          : 0;

      return {
        entryId: entry.id,
        rankMovement,
        presetCode: entry.presetCode,
        name: entry.name,
        customSuffix: entry.customSuffix,
        displayName: formatFranchiseDisplayName(
          entry.name,
          entry.presetCode,
          entry.customSuffix,
          !!entry.customSuffix
        ),
        abbreviation: entry.abbreviation,
        primaryColor: entry.primaryColor,
        secondaryColor: entry.secondaryColor,
        isClaimedInSeason: entry.controllerSessionId !== null,
        isOwnedByRequester: !!requesterSessionId && entry.controllerSessionId === requesterSessionId,
        controllerDisplayName: entry.controllerDisplayName,
        totalPoints: entry.totalPoints,
        filteredPoints: filterMonth || filterRoomId ? filteredPoints : entry.totalPoints,
        auctionsParticipated,
        pointsByAuction: Array.from(bucketMap.values())
      };
    });

    const sortedRows = [...entryRowsRaw].sort((a, b) => {
      if (b.filteredPoints !== a.filteredPoints) return b.filteredPoints - a.filteredPoints;
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      if (b.auctionsParticipated !== a.auctionsParticipated) return b.auctionsParticipated - a.auctionsParticipated;
      return a.presetCode.localeCompare(b.presetCode);
    });

    const leaderboard: SeasonFranchiseLeaderboardRowDto[] = sortedRows.map((row, idx) => ({
      ...row,
      rank: idx + 1
    }));

    const auctions: SeasonAuctionSummaryDto[] = season.rooms.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      status: r.status as RoomStatus,
      auctionMode: r.auctionMode as AuctionMode,
      seasonMonthLabel: r.seasonMonthLabel,
      seasonMonthKey: r.seasonMonthKey,
      occupiedFranchises: r.participants.length,
      createdAt: r.createdAt.toISOString()
    }));

    const monthsSet = new Set<string>();
    for (const r of season.rooms) {
      if (r.seasonMonthKey) monthsSet.add(r.seasonMonthKey);
    }
    for (const l of season.pointLedger) {
      if (l.monthKey) monthsSet.add(l.monthKey);
    }

    const pointHistory: SeasonPointLedgerDto[] = season.pointLedger.map((l) => {
      const linkedRoom = l.roomId ? roomById.get(l.roomId) : undefined;
      return {
        id: l.id,
        entryId: l.entryId,
        presetCode: l.entry.presetCode,
        franchiseName: l.entry.name,
        franchiseDisplayName: formatFranchiseDisplayName(
          l.entry.name,
          l.entry.presetCode,
          l.entry.customSuffix,
          !!l.entry.customSuffix
        ),
        roomId: l.roomId,
        roomCode: linkedRoom?.code || null,
        roomName: linkedRoom?.name || null,
        monthKey: l.monthKey || linkedRoom?.seasonMonthKey || null,
        pointsDelta: l.pointsDelta,
        balanceAfter: l.balanceAfter,
        reason: l.reason,
        adjustedByName: l.adjustedByName,
        createdAt: l.createdAt.toISOString()
      };
    });

    return {
      id: season.id,
      code: season.code,
      name: season.name,
      year: season.year,
      description: season.description,
      status: season.status as unknown as SeasonStatus,
      auctionCount: season.rooms.length,
      claimedFranchisesCount: season.entries.filter((e) => e.controllerSessionId !== null).length,
      startDate: season.startDate ? season.startDate.toISOString() : null,
      endDate: season.endDate ? season.endDate.toISOString() : null,
      createdAt: season.createdAt.toISOString(),
      isHost: !!requesterSessionId && season.hostSessionId === requesterSessionId,
      leaderboard,
      auctions,
      availableMonths: Array.from(monthsSet).sort().reverse(),
      pointHistory
    };
  }

  static async claimSeasonFranchise(
    code: string,
    input: {
      guestSessionId: string;
      defaultDisplayName: string;
      displayNameOverride?: string;
      franchiseCode: string;
      customSuffix?: string | null;
      recoveryCode?: string;
    }
  ): Promise<SeasonDetailDto> {
    const normalized = code.trim().toUpperCase();
    const displayName = input.displayNameOverride?.trim() || input.defaultDisplayName;

    await prisma.$transaction(async (tx) => {
      const seasonRows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status" FROM "Season" WHERE "code" = ${normalized} FOR UPDATE
      `;
      if (!seasonRows.length) {
        throw new AppError(`Season '${normalized}' not found.`, 404, 'SEASON_NOT_FOUND');
      }
      if (seasonRows[0].status === DbSeasonStatus.ARCHIVED) {
        throw new AppError('This season is archived and read-only.', 409, 'SEASON_ARCHIVED');
      }

      const seasonId = seasonRows[0].id;
      const entry = await tx.seasonFranchiseEntry.findUnique({
        where: {
          seasonId_presetCode: {
            seasonId,
            presetCode: input.franchiseCode
          }
        }
      });
      if (!entry) {
        throw new AppError('Franchise preset not found in season.', 404, 'INVALID_FRANCHISE');
      }

      const hasValidRecovery =
        !!input.recoveryCode &&
        !!entry.recoveryCodeHash &&
        hashRecoveryCode(input.recoveryCode) === entry.recoveryCodeHash;

      if (
        entry.controllerSessionId &&
        entry.controllerSessionId !== input.guestSessionId &&
        !hasValidRecovery
      ) {
        throw new AppError(
          `${entry.name} (${entry.abbreviation}) is already claimed in this season. Ask the season host for a recovery code if you lost your browser session.`,
          409,
          'SEASON_FRANCHISE_LOCKED'
        );
      }

      if (input.displayNameOverride && input.displayNameOverride.trim() !== input.defaultDisplayName) {
        await tx.guestSession.update({
          where: { id: input.guestSessionId },
          data: { displayName, lastSeenAt: new Date() }
        });
      }

      await tx.seasonFranchiseEntry.update({
        where: { id: entry.id },
        data: {
          controllerSessionId: input.guestSessionId,
          controllerDisplayName: displayName,
          ...(input.customSuffix !== undefined ? { customSuffix: input.customSuffix } : {}),
          ...(hasValidRecovery ? { recoveryCodeHash: null } : {})
        }
      });
    });

    const detail = await SeasonService.getSeasonByCode(normalized, input.guestSessionId);
    SeasonService.broadcastLeaderboardUpdate(normalized, detail);
    return detail;
  }

  static async issueRecoveryCode(
    code: string,
    hostSessionId: string,
    entryId: string
  ): Promise<{ recoveryCode: string; entryId: string; presetCode: string }> {
    const normalized = code.trim().toUpperCase();
    const season = await prisma.season.findUnique({ where: { code: normalized } });
    if (!season) throw new AppError(`Season '${normalized}' not found.`, 404, 'SEASON_NOT_FOUND');
    if (season.hostSessionId !== hostSessionId) {
      throw new AppError('Only the season host can issue franchise recovery codes.', 403, 'HOST_ONLY');
    }

    const entry = await prisma.seasonFranchiseEntry.findFirst({
      where: { id: entryId, seasonId: season.id }
    });
    if (!entry) {
      throw new AppError('Franchise entry does not belong to this season.', 404, 'INVALID_ENTRY');
    }

    const plainCode = generateShortRecoveryToken();
    await prisma.seasonFranchiseEntry.update({
      where: { id: entry.id },
      data: { recoveryCodeHash: hashRecoveryCode(plainCode) }
    });

    return {
      recoveryCode: plainCode,
      entryId: entry.id,
      presetCode: entry.presetCode
    };
  }

  static async releaseSeasonFranchise(
    code: string,
    hostSessionId: string,
    entryId: string
  ): Promise<SeasonDetailDto> {
    const normalized = code.trim().toUpperCase();
    const season = await prisma.season.findUnique({ where: { code: normalized } });
    if (!season) throw new AppError(`Season '${normalized}' not found.`, 404, 'SEASON_NOT_FOUND');
    if (season.hostSessionId !== hostSessionId) {
      throw new AppError('Only the season host can release franchise control.', 403, 'HOST_ONLY');
    }

    const entry = await prisma.seasonFranchiseEntry.findFirst({
      where: { id: entryId, seasonId: season.id }
    });
    if (!entry) {
      throw new AppError('Franchise entry does not belong to this season.', 404, 'INVALID_ENTRY');
    }

    await prisma.seasonFranchiseEntry.update({
      where: { id: entry.id },
      data: {
        controllerSessionId: null,
        controllerDisplayName: null,
        recoveryCodeHash: null
      }
    });

    const detail = await SeasonService.getSeasonByCode(normalized, hostSessionId);
    SeasonService.broadcastLeaderboardUpdate(normalized, detail);
    return detail;
  }

  static async createSeasonRoom(
    code: string,
    hostSessionId: string,
    defaultDisplayName: string,
    input: {
      roomName: string;
      franchiseCode: string;
      visibility: RoomVisibility;
      auctionMode: AuctionMode;
      seasonMonthLabel?: string;
      seasonMonthKey?: string;
      settings: any;
    }
  ) {
    const normalized = code.trim().toUpperCase();
    const season = await prisma.season.findUnique({ where: { code: normalized } });
    if (!season) throw new AppError(`Season '${normalized}' not found.`, 404, 'SEASON_NOT_FOUND');
    if (season.hostSessionId !== hostSessionId) {
      throw new AppError('Only the season host can create auctions inside this season.', 403, 'HOST_ONLY');
    }
    if (season.status === DbSeasonStatus.ARCHIVED) {
      throw new AppError('Cannot create new auctions inside an archived season.', 409, 'SEASON_ARCHIVED');
    }

    const room = await RoomService.createRoom({
      guestSessionId: hostSessionId,
      defaultDisplayName,
      roomName: input.roomName,
      franchiseCode: input.franchiseCode,
      visibility: input.visibility,
      auctionMode: input.auctionMode,
      seasonCode: season.code,
      seasonMonthLabel: input.seasonMonthLabel,
      seasonMonthKey: input.seasonMonthKey,
      settings: input.settings
    });

    const detail = await SeasonService.getSeasonByCode(normalized, hostSessionId);
    SeasonService.broadcastLeaderboardUpdate(normalized, detail);
    return room;
  }

  static async adjustPoints(
    code: string,
    input: {
      hostSessionId: string;
      hostDisplayName: string;
      entryId: string;
      pointsDelta: number;
      reason: string;
      roomId?: string | null;
      monthKey?: string | null;
    }
  ): Promise<SeasonDetailDto> {
    const normalized = code.trim().toUpperCase();

    await prisma.$transaction(async (tx) => {
      const seasonRows = await tx.$queryRaw<Array<{ id: string; hostSessionId: string; status: string }>>`
        SELECT "id", "hostSessionId", "status" FROM "Season" WHERE "code" = ${normalized} FOR UPDATE
      `;
      if (!seasonRows.length) {
        throw new AppError(`Season '${normalized}' not found.`, 404, 'SEASON_NOT_FOUND');
      }
      const season = seasonRows[0];
      if (season.hostSessionId !== input.hostSessionId) {
        throw new AppError('Only the season host can adjust season points.', 403, 'HOST_ONLY');
      }
      if (season.status === DbSeasonStatus.ARCHIVED) {
        throw new AppError('Cannot modify points of an archived season.', 409, 'SEASON_ARCHIVED');
      }

      const allEntries = await tx.seasonFranchiseEntry.findMany({
        where: { seasonId: season.id }
      });
      const targetEntry = allEntries.find((e) => e.id === input.entryId);
      if (!targetEntry) {
        throw new AppError('Selected franchise entry does not belong to this season.', 404, 'INVALID_ENTRY');
      }

      let resolvedMonthKey = input.monthKey || null;
      if (input.roomId) {
        const room = await tx.room.findFirst({
          where: { id: input.roomId, seasonId: season.id },
          select: { id: true, seasonMonthKey: true }
        });
        if (!room) {
          throw new AppError('Referenced auction does not belong to this season.', 400, 'INVALID_SEASON_ROOM');
        }
        resolvedMonthKey = resolvedMonthKey || room.seasonMonthKey || null;
      }

      // Snapshot previous rank ordering cleanly across all 10 entries prior to updating points
      const priorSorted = [...allEntries].sort(sortSeasonEntries);
      for (let idx = 0; idx < priorSorted.length; idx++) {
        await tx.seasonFranchiseEntry.update({
          where: { id: priorSorted[idx].id },
          data: { previousRank: idx + 1 }
        });
      }

      const nextBalance = targetEntry.totalPoints + input.pointsDelta;
      await tx.seasonFranchiseEntry.update({
        where: { id: targetEntry.id },
        data: { totalPoints: nextBalance }
      });

      await tx.seasonPointLedger.create({
        data: {
          seasonId: season.id,
          entryId: targetEntry.id,
          roomId: input.roomId || null,
          monthKey: resolvedMonthKey,
          pointsDelta: input.pointsDelta,
          balanceAfter: nextBalance,
          reason: input.reason.trim(),
          adjustedBySessionId: input.hostSessionId,
          adjustedByName: input.hostDisplayName
        }
      });
    });

    const detail = await SeasonService.getSeasonByCode(normalized, input.hostSessionId);
    SeasonService.broadcastLeaderboardUpdate(normalized, detail);
    return detail;
  }

  static async setSeasonStatus(
    code: string,
    hostSessionId: string,
    status: SeasonStatus
  ): Promise<SeasonDetailDto> {
    const normalized = code.trim().toUpperCase();
    const season = await prisma.season.findUnique({ where: { code: normalized } });
    if (!season) throw new AppError(`Season '${normalized}' not found.`, 404, 'SEASON_NOT_FOUND');
    if (season.hostSessionId !== hostSessionId) {
      throw new AppError('Only the season host can archive or reopen this season.', 403, 'HOST_ONLY');
    }

    await prisma.season.update({
      where: { id: season.id },
      data: { status: status as unknown as DbSeasonStatus }
    });

    const detail = await SeasonService.getSeasonByCode(normalized, hostSessionId);
    SeasonService.broadcastLeaderboardUpdate(normalized, detail);
    return detail;
  }

  static broadcastLeaderboardUpdate(seasonCode: string, detail: SeasonDetailDto): void {
    const io = getIO();
    if (!io) return;
    io.to(SOCKET_ROOMS.season(seasonCode)).emit(SOCKET_EVENTS.SEASON_LEADERBOARD_UPDATED, {
      seasonCode: detail.code,
      status: detail.status,
      leaderboard: detail.leaderboard,
      pointHistory: detail.pointHistory,
      auctions: detail.auctions,
      availableMonths: detail.availableMonths
    });
  }
}
