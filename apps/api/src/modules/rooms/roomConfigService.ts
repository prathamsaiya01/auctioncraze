import {
  AuctionMode as DbAuctionMode,
  CricketRole,
  LedgerEntryType,
  LotStatus,
  RoomRole as DbRoomRole,
  RoomStatus as DbRoomStatus,
  RoomVisibility as DbRoomVisibility,
  prisma
} from '@auctioncraze/database';
import { validateAuctionConfiguration } from '@auctioncraze/auction-engine';
import {
  AuctionMode,
  BidTierConfig,
  RoomDetailDto,
  RoomVisibility,
  SOCKET_EVENTS
} from '@auctioncraze/shared';
import crypto from 'crypto';
import { AppError } from '../../middleware/errorHandler';
import { emitToRoom } from '../../sockets/socketServer';
import { appendRoomEvent, fetchRoomWithRelations, lockRoomByCode } from './roomHelpers';
import { mapRoomToDetailDto } from './roomMapper';

export interface UpdateAuctionConfigInput {
  auctionMode: AuctionMode;
  visibility?: RoomVisibility;
  initialPurseLakhs: number;
  minSquadSize: number;
  maxSquadSize: number;
  maxOverseas: number;
  maxSpectators: number;
  minOwnersRequired: number;
  defaultBasePriceLakhs: number;
  bidIncrementTiers: BidTierConfig[];
  countdownSeconds: number;
  allowLateBidExtension: boolean;
  bidExtensionSeconds: number;
  extensionThresholdSeconds: number;
  allowHostSkip: boolean;
  allowTeamPurseAdjustments: boolean;
  retentionEnabled: boolean;
  maxRetentionsPerFranchise: number;
  maxOverseasRetentions: number;
  franchisePurseAdjustments?: Array<{
    franchiseCode: string;
    adjustmentLakhs: number;
  }>;
}

export interface ConfigurePoolLotInput {
  playerId: string;
  setCategory: string;
  basePriceLakhs: number;
  sequenceOrder: number;
}

function assertHostEditableLobby(room: any, guestSessionId: string) {
  const caller = room.participants.find(
    (p: any) => p.guestSessionId === guestSessionId && !p.isRemoved && !p.leftAt
  );
  if (!caller || caller.id !== room.hostParticipantId || caller.role !== DbRoomRole.HOST) {
    throw new AppError('Only the room host can modify auction configuration.', 403, 'HOST_ONLY');
  }
  if (room.status !== DbRoomStatus.LOBBY) {
    throw new AppError('Configuration can only be modified while in the lobby.', 409, 'ROOM_NOT_IN_LOBBY');
  }
  if (room.configFinalized) {
    throw new AppError(
      'Auction configuration has been finalized and locked.',
      409,
      'CONFIG_FINALIZED'
    );
  }
  return caller;
}

function broadcastConfigAndReadiness(
  roomCode: string,
  event: string,
  dto: RoomDetailDto
): void {
  emitToRoom(roomCode, event, {
    roomCode,
    version: dto.version,
    configFinalized: dto.configFinalized,
    settings: dto.settings,
    lotsCount: dto.lots.length,
    retentionsCount: dto.retentions.length
  });
  emitToRoom(roomCode, SOCKET_EVENTS.AUCTION_READINESS_CHANGED, {
    roomCode,
    readiness: dto.readiness
  });
  emitToRoom(roomCode, SOCKET_EVENTS.ROOM_STATE, dto);
}

export class RoomConfigService {
  static async updateConfig(
    code: string,
    guestSessionId: string,
    input: UpdateAuctionConfigInput
  ): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();

    const engineValidation = validateAuctionConfiguration({
      initialPurseLakhs: input.initialPurseLakhs,
      minSquadSize: input.minSquadSize,
      maxSquadSize: input.maxSquadSize,
      maxOverseas: input.maxOverseas,
      minOwnersRequired: input.minOwnersRequired,
      defaultBasePriceLakhs: input.defaultBasePriceLakhs,
      countdownSeconds: input.countdownSeconds,
      allowLateBidExtension: input.allowLateBidExtension,
      bidExtensionSeconds: input.bidExtensionSeconds,
      extensionThresholdSeconds: input.extensionThresholdSeconds,
      retentionEnabled: input.retentionEnabled,
      maxRetentionsPerFranchise: input.maxRetentionsPerFranchise,
      maxOverseasRetentions: input.maxOverseasRetentions,
      bidIncrementTiers: input.bidIncrementTiers
    });

    if (!engineValidation.isValid) {
      throw new AppError(
        engineValidation.errorMessage || 'Invalid auction configuration.',
        400,
        'INVALID_AUCTION_CONFIG'
      );
    }

    const updatedRoom = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertHostEditableLobby(room, guestSessionId);

      if (
        input.franchisePurseAdjustments &&
        input.franchisePurseAdjustments.length > 0 &&
        !input.allowTeamPurseAdjustments
      ) {
        throw new AppError(
          'Team-specific purse adjustments are disabled for this configuration.',
          400,
          'PURSE_ADJUSTMENTS_DISABLED'
        );
      }

      if (!input.retentionEnabled && room.retentions.length > 0) {
        throw new AppError(
          'Remove existing retained players before disabling retention.',
          400,
          'RETENTIONS_EXIST'
        );
      }

      // Check existing retentions against tighter retention limits
      for (const franchise of room.franchises) {
        const franRetentions = room.retentions.filter((r) => r.franchiseId === franchise.id);
        if (franRetentions.length > input.maxRetentionsPerFranchise) {
          throw new AppError(
            `${franchise.abbreviation} has ${franRetentions.length} retained players, exceeding max ${input.maxRetentionsPerFranchise}.`,
            400,
            'RETENTION_LIMIT_CONFLICT'
          );
        }
        const franOverseasRet = franRetentions.filter((r) => r.player.isOverseas).length;
        if (franOverseasRet > input.maxOverseasRetentions || franOverseasRet > input.maxOverseas) {
          throw new AppError(
            `${franchise.abbreviation} has ${franOverseasRet} overseas retentions, exceeding new limit.`,
            400,
            'OVERSEAS_RETENTION_CONFLICT'
          );
        }
      }

      const adjByCode = new Map<string, number>();
      if (input.allowTeamPurseAdjustments && input.franchisePurseAdjustments) {
        for (const adj of input.franchisePurseAdjustments) {
          adjByCode.set(adj.franchiseCode, adj.adjustmentLakhs);
        }
      }

      // Recompute purses cleanly and ensure no franchise drops below 0
      for (const franchise of room.franchises) {
        const nextAdjustment = input.allowTeamPurseAdjustments
          ? adjByCode.get(franchise.presetCode) ?? franchise.purseAdjustmentLakhs
          : 0;
        const retentionTotal = room.retentions
          .filter((r) => r.franchiseId === franchise.id)
          .reduce((sum, r) => sum + r.retentionCostLakhs, 0);
        const nextRemaining = input.initialPurseLakhs + nextAdjustment - retentionTotal;

        if (nextRemaining < 0) {
          throw new AppError(
            `Purse configuration makes ${franchise.abbreviation} balance negative (${nextRemaining}L).`,
            400,
            'NEGATIVE_FRANCHISE_PURSE'
          );
        }

        if (
          franchise.initialPurseLakhs !== input.initialPurseLakhs ||
          franchise.purseAdjustmentLakhs !== nextAdjustment ||
          franchise.remainingPurseLakhs !== nextRemaining
        ) {
          await tx.roomFranchise.update({
            where: { id: franchise.id },
            data: {
              initialPurseLakhs: input.initialPurseLakhs,
              purseAdjustmentLakhs: nextAdjustment,
              remainingPurseLakhs: nextRemaining
            }
          });
        }
      }

      const nextVisibility = (input.visibility ?? room.visibility) as DbRoomVisibility;
      const nextInviteToken =
        nextVisibility === DbRoomVisibility.PRIVATE
          ? room.inviteToken || crypto.randomBytes(12).toString('hex')
          : null;

      const nextVersion = room.version + 1;
      await tx.room.update({
        where: { id: room.id },
        data: {
          auctionMode: input.auctionMode as DbAuctionMode,
          visibility: nextVisibility,
          inviteToken: nextInviteToken,
          initialPurseLakhs: input.initialPurseLakhs,
          minSquadSize: input.minSquadSize,
          maxSquadSize: input.maxSquadSize,
          maxOverseas: input.maxOverseas,
          maxSpectators: input.maxSpectators,
          minOwnersRequired: input.minOwnersRequired,
          defaultBasePriceLakhs: input.defaultBasePriceLakhs,
          bidIncrementTiersJson: input.bidIncrementTiers as any,
          countdownSeconds: input.countdownSeconds,
          allowLateBidExtension: input.allowLateBidExtension,
          bidExtensionSeconds: input.bidExtensionSeconds,
          extensionThresholdSeconds: input.extensionThresholdSeconds,
          allowHostSkip: input.allowHostSkip,
          allowTeamPurseAdjustments: input.allowTeamPurseAdjustments,
          retentionEnabled: input.retentionEnabled,
          maxRetentionsPerFranchise: input.maxRetentionsPerFranchise,
          maxOverseasRetentions: input.maxOverseasRetentions,
          version: nextVersion
        }
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, {
        auctionMode: input.auctionMode,
        initialPurseLakhs: input.initialPurseLakhs
      });

      return fetchRoomWithRelations(tx, room.id);
    });

    const publicDto = mapRoomToDetailDto(updatedRoom, false);
    broadcastConfigAndReadiness(normalized, SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, publicDto);
    return mapRoomToDetailDto(updatedRoom, true);
  }

  static async configurePlayerPool(
    code: string,
    guestSessionId: string,
    lots: ConfigurePoolLotInput[]
  ): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();

    const updatedRoom = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertHostEditableLobby(room, guestSessionId);

      const seenPlayers = new Set<string>();
      const retainedSet = new Set(room.retentions.map((r) => r.playerId));

      for (const lot of lots) {
        if (seenPlayers.has(lot.playerId)) {
          throw new AppError('Duplicate player in auction pool.', 400, 'DUPLICATE_PLAYER_IN_POOL');
        }
        if (retainedSet.has(lot.playerId)) {
          throw new AppError(
            'A retained player cannot also be placed in the auction pool.',
            409,
            'PLAYER_ALREADY_RETAINED'
          );
        }
        seenPlayers.add(lot.playerId);
      }

      if (lots.length > 0) {
        const existingPlayers = await tx.masterPlayer.findMany({
          where: { id: { in: Array.from(seenPlayers) }, isActive: true },
          select: { id: true }
        });
        if (existingPlayers.length !== seenPlayers.size) {
          throw new AppError('One or more selected players do not exist.', 400, 'INVALID_PLAYER');
        }
      }

      await tx.roomPlayerLot.deleteMany({ where: { roomId: room.id } });

      const ordered = [...lots].sort((a, b) => a.sequenceOrder - b.sequenceOrder);
      if (ordered.length > 0) {
        await tx.roomPlayerLot.createMany({
          data: ordered.map((item, idx) => ({
            roomId: room.id,
            playerId: item.playerId,
            sequenceOrder: idx + 1,
            setCategory: item.setCategory.trim() || 'Marquee',
            basePriceLakhs: item.basePriceLakhs,
            status: LotStatus.QUEUED
          }))
        });
      }

      const nextVersion = room.version + 1;
      await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });
      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, {
        poolUpdated: true,
        lotsCount: ordered.length
      });

      return fetchRoomWithRelations(tx, room.id);
    });

    const publicDto = mapRoomToDetailDto(updatedRoom, false);
    broadcastConfigAndReadiness(normalized, SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, publicDto);
    return mapRoomToDetailDto(updatedRoom, true);
  }

  static async autoFillPlayerPool(
    code: string,
    guestSessionId: string,
    filters: {
      roles?: CricketRole[];
      includeOverseas: boolean;
      includeDomestic: boolean;
      useDefaultBasePrice: boolean;
    }
  ): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();

    const updatedRoom = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertHostEditableLobby(room, guestSessionId);

      const retainedSet = new Set(room.retentions.map((r) => r.playerId));
      const where: any = { isActive: true };
      if (filters.roles && filters.roles.length > 0) {
        where.playingRole = { in: filters.roles };
      }
      if (filters.includeOverseas && !filters.includeDomestic) {
        where.isOverseas = true;
      } else if (!filters.includeOverseas && filters.includeDomestic) {
        where.isOverseas = false;
      } else if (!filters.includeOverseas && !filters.includeDomestic) {
        throw new AppError('Select at least Domestic or Overseas players.', 400, 'INVALID_FILTER');
      }

      const players = await tx.masterPlayer.findMany({
        where,
        orderBy: [{ playingRole: 'asc' }, { fullName: 'asc' }]
      });

      const eligible = players.filter((p) => !retainedSet.has(p.id));
      if (eligible.length === 0) {
        throw new AppError('No eligible players matched the selected filters.', 400, 'EMPTY_PLAYER_POOL');
      }

      await tx.roomPlayerLot.deleteMany({ where: { roomId: room.id } });

      const roleToSet: Record<CricketRole, string> = {
        [CricketRole.BATSMAN]: 'Batters',
        [CricketRole.BOWLER]: 'Bowlers',
        [CricketRole.ALL_ROUNDER]: 'All-Rounders',
        [CricketRole.WICKET_KEEPER]: 'Wicketkeepers'
      };

      await tx.roomPlayerLot.createMany({
        data: eligible.map((p, i) => ({
          roomId: room.id,
          playerId: p.id,
          sequenceOrder: i + 1,
          setCategory: roleToSet[p.playingRole] || 'Pool',
          basePriceLakhs: filters.useDefaultBasePrice ? room.defaultBasePriceLakhs : p.basePriceLakhs,
          status: LotStatus.QUEUED
        }))
      });

      const nextVersion = room.version + 1;
      await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });
      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, {
        poolAutoFilled: true,
        lotsCount: eligible.length
      });

      return fetchRoomWithRelations(tx, room.id);
    });

    const publicDto = mapRoomToDetailDto(updatedRoom, false);
    broadcastConfigAndReadiness(normalized, SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, publicDto);
    return mapRoomToDetailDto(updatedRoom, true);
  }

  static async addRetention(
    code: string,
    guestSessionId: string,
    input: { franchiseCode: string; playerId: string; retentionCostLakhs: number }
  ): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();

    const updatedRoom = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertHostEditableLobby(room, guestSessionId);

      if (!room.retentionEnabled) {
        throw new AppError('Player retention is disabled for this room.', 400, 'RETENTION_DISABLED');
      }

      const franchise = room.franchises.find((f) => f.presetCode === input.franchiseCode);
      if (!franchise) {
        throw new AppError('Franchise not found in this room.', 404, 'INVALID_FRANCHISE');
      }

      const player = await tx.masterPlayer.findUnique({ where: { id: input.playerId } });
      if (!player || !player.isActive) {
        throw new AppError('Player not found in catalog.', 404, 'INVALID_PLAYER');
      }

      const alreadyRetained = room.retentions.find((r) => r.playerId === player.id);
      if (alreadyRetained) {
        throw new AppError(
          `${player.fullName} is already retained in this room.`,
          409,
          'PLAYER_ALREADY_RETAINED'
        );
      }

      const franRetentions = room.retentions.filter((r) => r.franchiseId === franchise.id);
      if (franRetentions.length >= room.maxRetentionsPerFranchise) {
        throw new AppError(
          `${franchise.abbreviation} has reached the maximum of ${room.maxRetentionsPerFranchise} retentions.`,
          400,
          'MAX_RETENTIONS_REACHED'
        );
      }

      if (player.isOverseas) {
        const overseasRetained = franRetentions.filter((r) => r.player.isOverseas).length;
        if (overseasRetained >= room.maxOverseasRetentions || franchise.overseasCount >= room.maxOverseas) {
          throw new AppError(
            `${franchise.abbreviation} has reached the overseas retention limit.`,
            400,
            'MAX_OVERSEAS_RETENTIONS_REACHED'
          );
        }
      }

      if (franchise.remainingPurseLakhs < input.retentionCostLakhs) {
        throw new AppError(
          `Insufficient purse for retention (${franchise.remainingPurseLakhs}L available, ${input.retentionCostLakhs}L required).`,
          400,
          'INSUFFICIENT_PURSE_FOR_RETENTION'
        );
      }

      const slotNumber = franRetentions.length + 1;
      await tx.roomRetention.create({
        data: {
          roomId: room.id,
          franchiseId: franchise.id,
          playerId: player.id,
          retentionCostLakhs: input.retentionCostLakhs,
          slotNumber
        }
      });

      // Remove player from queued auction pool if present
      await tx.roomPlayerLot.deleteMany({
        where: { roomId: room.id, playerId: player.id }
      });

      const nextRemaining = franchise.remainingPurseLakhs - input.retentionCostLakhs;
      await tx.roomFranchise.update({
        where: { id: franchise.id },
        data: {
          remainingPurseLakhs: nextRemaining,
          retainedCount: { increment: 1 },
          squadCount: { increment: 1 },
          overseasCount: player.isOverseas ? { increment: 1 } : undefined
        }
      });

      await tx.purseLedger.create({
        data: {
          franchiseId: franchise.id,
          entryType: LedgerEntryType.RETENTION_DEDUCTION,
          amountLakhs: -input.retentionCostLakhs,
          balanceAfterLakhs: nextRemaining,
          description: `Retained ${player.fullName} (Slot #${slotNumber})`
        }
      });

      const nextVersion = room.version + 1;
      await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });
      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, {
        retentionAdded: {
          franchiseCode: franchise.presetCode,
          playerName: player.fullName,
          retentionCostLakhs: input.retentionCostLakhs
        }
      });

      return fetchRoomWithRelations(tx, room.id);
    });

    const publicDto = mapRoomToDetailDto(updatedRoom, false);
    broadcastConfigAndReadiness(normalized, SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, publicDto);
    return mapRoomToDetailDto(updatedRoom, true);
  }

  static async removeRetention(
    code: string,
    guestSessionId: string,
    retentionId: string
  ): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();

    const updatedRoom = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertHostEditableLobby(room, guestSessionId);

      const retention = room.retentions.find((r) => r.id === retentionId);
      if (!retention) {
        throw new AppError('Retention record not found.', 404, 'RETENTION_NOT_FOUND');
      }

      const franchise = room.franchises.find((f) => f.id === retention.franchiseId)!;
      const refundedBalance = franchise.remainingPurseLakhs + retention.retentionCostLakhs;

      await tx.roomRetention.delete({ where: { id: retention.id } });

      await tx.roomFranchise.update({
        where: { id: franchise.id },
        data: {
          remainingPurseLakhs: refundedBalance,
          retainedCount: Math.max(0, franchise.retainedCount - 1),
          squadCount: Math.max(0, franchise.squadCount - 1),
          overseasCount: retention.player.isOverseas
            ? Math.max(0, franchise.overseasCount - 1)
            : undefined
        }
      });

      await tx.purseLedger.create({
        data: {
          franchiseId: franchise.id,
          entryType: LedgerEntryType.REFUND_REVERSAL,
          amountLakhs: retention.retentionCostLakhs,
          balanceAfterLakhs: refundedBalance,
          description: `Released retention of ${retention.player.fullName}`
        }
      });

      const nextVersion = room.version + 1;
      await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });
      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, {
        retentionRemoved: retention.id
      });

      return fetchRoomWithRelations(tx, room.id);
    });

    const publicDto = mapRoomToDetailDto(updatedRoom, false);
    broadcastConfigAndReadiness(normalized, SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, publicDto);
    return mapRoomToDetailDto(updatedRoom, true);
  }

  static async finalizeConfiguration(
    code: string,
    guestSessionId: string
  ): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();

    const updatedRoom = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertHostEditableLobby(room, guestSessionId);

      if (room.lots.length === 0) {
        throw new AppError(
          'Cannot finalize configuration with an empty player pool. Add at least 1 player.',
          400,
          'EMPTY_PLAYER_POOL'
        );
      }

      const preDto = mapRoomToDetailDto(room, false);
      const blockingChecks = preDto.readiness.checks.filter(
        (c) => c.key !== 'config_finalized' && c.key !== 'owners_present' && !c.passed
      );
      if (blockingChecks.length > 0) {
        throw new AppError(blockingChecks[0].message, 400, 'READINESS_CHECK_FAILED');
      }

      const nextVersion = room.version + 1;
      await tx.room.update({
        where: { id: room.id },
        data: {
          configFinalized: true,
          configFinalizedAt: new Date(),
          version: nextVersion
        }
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.AUCTION_CONFIG_FINALIZED, {
        lotsCount: room.lots.length,
        retentionsCount: room.retentions.length
      });

      return fetchRoomWithRelations(tx, room.id);
    });

    const publicDto = mapRoomToDetailDto(updatedRoom, false);
    broadcastConfigAndReadiness(normalized, SOCKET_EVENTS.AUCTION_CONFIG_FINALIZED, publicDto);
    return mapRoomToDetailDto(updatedRoom, true);
  }
}
