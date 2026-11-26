import {
  LedgerEntryType,
  LotStatus as DbLotStatus,
  RoomRole as DbRoomRole,
  RoomStatus as DbRoomStatus,
  prisma
} from '@auctioncraze/database';
import { calculateNextBidLakhs, validateBid } from '@auctioncraze/auction-engine';
import {
  AuctionBidDto,
  AuctionStateSnapshotDto,
  LotStatus,
  RoomStatus,
  SOCKET_EVENTS,
  formatFranchiseDisplayName
} from '@auctioncraze/shared';
import { AppError } from '../../middleware/errorHandler';
import { emitToRoom } from '../../sockets/socketServer';
import { appendRoomEvent, fetchRoomWithRelations, lockRoomByCode } from '../rooms/roomHelpers';
import { evaluateRoomReadiness, resolveBidTiers } from '../rooms/roomMapper';
import { AUCTION_ROOM_INCLUDE, mapAuctionStateSnapshot } from './auctionMapper';
import { AuctionTimerManager } from './timerManager';

function assertActiveHost(room: any, guestSessionId: string) {
  const caller = room.participants.find(
    (p: any) => p.guestSessionId === guestSessionId && !p.isRemoved && !p.leftAt
  );
  if (!caller || caller.id !== room.hostParticipantId || caller.role !== DbRoomRole.HOST) {
    throw new AppError('Only the room host can control auction flow.', 403, 'HOST_ONLY');
  }
  return caller;
}

export class AuctionService {
  static async getAuctionState(
    code: string,
    guestSessionId: string
  ): Promise<AuctionStateSnapshotDto> {
    const normalized = code.trim().toUpperCase();
    const room = await prisma.room.findUnique({
      where: { code: normalized },
      include: AUCTION_ROOM_INCLUDE
    });

    if (!room) {
      throw new AppError(`Room '${normalized}' not found.`, 404, 'ROOM_NOT_FOUND');
    }

    const member = room.participants.find(
      (p) => p.guestSessionId === guestSessionId && !p.isRemoved && !p.leftAt
    );
    if (!member) {
      throw new AppError('You are not an active member of this room.', 403, 'NOT_A_MEMBER');
    }

    return mapAuctionStateSnapshot(room);
  }

  static async startAuction(code: string, guestSessionId: string): Promise<AuctionStateSnapshotDto> {
    const normalized = code.trim().toUpperCase();
    const nowMs = Date.now();

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertActiveHost(room, guestSessionId);

      if (room.status !== DbRoomStatus.LOBBY) {
        throw new AppError(`Auction is already ${room.status.toLowerCase()}.`, 409, 'INVALID_TRANSITION');
      }

      const readiness = evaluateRoomReadiness(room);
      if (!readiness.isReadyToStart) {
        const failed = readiness.checks.find((c) => !c.passed);
        throw new AppError(
          failed?.message || 'Room is not ready to start the auction.',
          400,
          'AUCTION_NOT_READY'
        );
      }

      const firstLot = room.lots.find((l) => l.status === DbLotStatus.QUEUED);
      if (!firstLot) {
        throw new AppError('No queued players found in pool.', 400, 'EMPTY_PLAYER_POOL');
      }

      const deadlineMs = nowMs + room.countdownSeconds * 1000;
      const nextVersion = room.version + 1;

      await tx.roomPlayerLot.update({
        where: { id: firstLot.id },
        data: {
          status: DbLotStatus.ACTIVE,
          startedAt: new Date(nowMs)
        }
      });

      await tx.room.update({
        where: { id: room.id },
        data: {
          status: DbRoomStatus.LIVE,
          isPaused: false,
          currentLotId: firstLot.id,
          timerDeadlineMs: BigInt(deadlineMs),
          timerRemainingMs: null,
          startedAt: new Date(nowMs),
          version: nextVersion
        }
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.AUCTION_STARTED, {
        startedAt: new Date(nowMs).toISOString(),
        firstLotId: firstLot.id
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.PLAYER_LOT_STARTED, {
        lotId: firstLot.id,
        playerId: firstLot.playerId,
        playerName: firstLot.player.fullName,
        sequenceOrder: firstLot.sequenceOrder,
        basePriceLakhs: firstLot.basePriceLakhs
      });

      const full = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        include: AUCTION_ROOM_INCLUDE
      });

      return { full, firstLotId: firstLot.id, deadlineMs, countdownSeconds: room.countdownSeconds };
    });

    await AuctionTimerManager.setRunningTimer(normalized, txResult.firstLotId, txResult.deadlineMs);
    const snapshot = mapAuctionStateSnapshot(txResult.full, nowMs);

    emitToRoom(normalized, SOCKET_EVENTS.AUCTION_STARTED, {
      roomCode: normalized,
      auctionStage: snapshot.auctionStage,
      startedAt: new Date(nowMs).toISOString()
    });
    emitToRoom(normalized, SOCKET_EVENTS.PLAYER_LOT_STARTED, {
      roomCode: normalized,
      currentLot: snapshot.currentLot,
      upNextLots: snapshot.upNextLots
    });
    emitToRoom(normalized, SOCKET_EVENTS.TIMER_UPDATED, snapshot.timer);
    emitToRoom(normalized, SOCKET_EVENTS.AUCTION_STATE, snapshot);

    return snapshot;
  }

  static async placeBid(
    code: string,
    guestSessionId: string,
    input: { lotId: string; bidAmountLakhs: number; idempotencyKey: string }
  ): Promise<{
    bid: AuctionBidDto;
    nextBidLakhs: number;
    incrementLakhs: number;
    timerExtended: boolean;
    deadlineMs: number | null;
    remainingSeconds: number;
  }> {
    const normalized = code.trim().toUpperCase();
    const nowMs = Date.now();

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await tx.room.findUniqueOrThrow({
        where: { id: roomId },
        include: {
          franchises: true,
          participants: true,
          lots: {
            where: { id: input.lotId },
            include: {
              player: true,
              bids: { orderBy: { sequenceNumber: 'desc' }, take: 1 }
            }
          }
        }
      });

      const participant = room.participants.find(
        (p) => p.guestSessionId === guestSessionId && !p.isRemoved && !p.leftAt
      );
      if (!participant) {
        throw new AppError('You are not an active member of this room.', 403, 'NOT_A_MEMBER');
      }
      if (participant.role === DbRoomRole.SPECTATOR) {
        throw new AppError('Spectators cannot place bids.', 403, 'SPECTATOR_CANNOT_BID');
      }
      if (!participant.isConnected) {
        throw new AppError('Disconnected sessions cannot submit bids. Reconnect first.', 403, 'SESSION_DISCONNECTED');
      }
      if (!participant.franchiseId) {
        throw new AppError('You must own a franchise to bid.', 400, 'NO_FRANCHISE_OWNED');
      }

      // Check idempotency key inside the room lock
      const existingIdempotentBid = await tx.bid.findUnique({
        where: { idempotencyKey: input.idempotencyKey }
      });
      if (existingIdempotentBid) {
        if (
          existingIdempotentBid.lotId === input.lotId &&
          existingIdempotentBid.participantId === participant.id
        ) {
          const fran = room.franchises.find((f) => f.id === existingIdempotentBid.franchiseId)!;
          const lot = room.lots[0];
          const tiers = resolveBidTiers(room.bidIncrementTiersJson);
          const { nextBidLakhs, incrementLakhs } = calculateNextBidLakhs(
            lot?.currentBidLakhs || existingIdempotentBid.bidAmountLakhs,
            lot?.basePriceLakhs || existingIdempotentBid.bidAmountLakhs,
            tiers
          );
          const deadlineMs = room.timerDeadlineMs ? Number(room.timerDeadlineMs) : null;
          return {
            duplicate: true as const,
            bidDto: {
              id: existingIdempotentBid.id,
              lotId: existingIdempotentBid.lotId,
              playerName: lot?.player?.fullName,
              roundNumber: existingIdempotentBid.roundNumber ?? 1,
              franchiseId: fran.id,
              franchiseCode: fran.presetCode,
              franchiseColor: fran.primaryColor,
              participantId: participant.id,
              bidderDisplayName: participant.displayName,
              bidAmountLakhs: existingIdempotentBid.bidAmountLakhs,
              sequenceNumber: existingIdempotentBid.sequenceNumber,
              createdAt: existingIdempotentBid.createdAt.toISOString()
            },
            nextBidLakhs,
            incrementLakhs,
            timerExtended: false,
            deadlineMs,
            remainingSeconds: deadlineMs ? Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000)) : 0
          };
        }
        throw new AppError('Idempotency key already used for a different bid.', 409, 'DUPLICATE_IDEMPOTENCY_KEY');
      }

      const lot = room.lots[0];
      if (!lot || room.currentLotId !== lot.id) {
        throw new AppError('Player lot is not currently active on stage.', 409, 'LOT_NOT_ACTIVE');
      }

      const franchise = room.franchises.find((f) => f.id === participant.franchiseId);
      if (!franchise) {
        throw new AppError('Claimed franchise not found.', 404, 'INVALID_FRANCHISE');
      }

      const currentDeadlineMs = room.timerDeadlineMs !== null ? Number(room.timerDeadlineMs) : null;
      const customTiers = resolveBidTiers(room.bidIncrementTiersJson);

      const validation = validateBid({
        roomStatus: room.status as unknown as RoomStatus,
        isPaused: room.isPaused,
        lotStatus: lot.status as unknown as LotStatus,
        biddingDeadlineMs: currentDeadlineMs,
        nowMs,
        currentBidLakhs: lot.currentBidLakhs,
        basePriceLakhs: lot.basePriceLakhs,
        bidAmountLakhs: input.bidAmountLakhs,
        highestBidderFranchiseId: lot.winningFranchiseId,
        franchiseId: franchise.id,
        remainingPurseLakhs: franchise.remainingPurseLakhs,
        squadCount: franchise.squadCount,
        overseasCount: franchise.overseasCount,
        playerIsOverseas: lot.player.isOverseas,
        minSquadSize: room.minSquadSize,
        maxSquadSize: room.maxSquadSize,
        maxOverseas: room.maxOverseas,
        customTiers
      });

      if (!validation.isValid) {
        const statusCode =
          validation.errorCode === 'BID_TOO_LOW' ||
          validation.errorCode === 'INSUFFICIENT_PURSE' ||
          validation.errorCode === 'RESERVE_PURSE_EXCEEDED' ||
          validation.errorCode === 'MAX_SQUAD_REACHED' ||
          validation.errorCode === 'MAX_OVERSEAS_REACHED'
            ? 400
            : 409;
        throw new AppError(
          validation.errorMessage || 'Bid rejected.',
          statusCode,
          validation.errorCode || 'BID_REJECTED'
        );
      }

      const seq = (lot.bids[0]?.sequenceNumber || 0) + 1;
      const lotRound = lot.roundNumber ?? 1;
      const createdBid = await tx.bid.create({
        data: {
          lotId: lot.id,
          franchiseId: franchise.id,
          participantId: participant.id,
          bidAmountLakhs: input.bidAmountLakhs,
          roundNumber: lotRound,
          sequenceNumber: seq,
          idempotencyKey: input.idempotencyKey
        }
      });

      await tx.roomPlayerLot.update({
        where: { id: lot.id },
        data: {
          currentBidLakhs: input.bidAmountLakhs,
          winningFranchiseId: franchise.id
        }
      });

      // Late-bid countdown extension
      let nextDeadlineMs = currentDeadlineMs;
      let timerExtended = false;
      if (
        room.allowLateBidExtension &&
        currentDeadlineMs !== null &&
        room.bidExtensionSeconds > 0 &&
        currentDeadlineMs - nowMs <= room.extensionThresholdSeconds * 1000
      ) {
        nextDeadlineMs = nowMs + room.bidExtensionSeconds * 1000;
        timerExtended = true;
      }

      const nextVersion = room.version + 1;
      await tx.room.update({
        where: { id: room.id },
        data: {
          version: nextVersion,
          ...(timerExtended && nextDeadlineMs !== null
            ? { timerDeadlineMs: BigInt(nextDeadlineMs) }
            : {})
        }
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.BID_PLACED, {
        bidId: createdBid.id,
        lotId: lot.id,
        franchiseId: franchise.id,
        franchiseCode: franchise.presetCode,
        bidderDisplayName: participant.displayName,
        bidAmountLakhs: input.bidAmountLakhs,
        sequenceNumber: seq
      });

      const { nextBidLakhs, incrementLakhs } = calculateNextBidLakhs(
        input.bidAmountLakhs,
        lot.basePriceLakhs,
        customTiers
      );

      return {
        duplicate: false as const,
        lotId: lot.id,
        bidDto: {
          id: createdBid.id,
          lotId: createdBid.lotId,
          playerName: lot.player.fullName,
          roundNumber: lotRound,
          franchiseId: franchise.id,
          franchiseCode: franchise.presetCode,
          franchiseDisplayName: formatFranchiseDisplayName(
            franchise.name,
            franchise.presetCode,
            franchise.customSuffix,
            !!room.allowCustomTeamName
          ),
          franchiseColor: franchise.primaryColor,
          participantId: participant.id,
          bidderDisplayName: participant.displayName,
          bidAmountLakhs: createdBid.bidAmountLakhs,
          sequenceNumber: seq,
          createdAt: createdBid.createdAt.toISOString()
        },
        franchiseName: franchise.name,
        franchiseDisplayName: formatFranchiseDisplayName(
          franchise.name,
          franchise.presetCode,
          franchise.customSuffix,
          !!room.allowCustomTeamName
        ),
        nextBidLakhs,
        incrementLakhs,
        timerExtended,
        deadlineMs: nextDeadlineMs,
        remainingSeconds: nextDeadlineMs ? Math.max(0, Math.ceil((nextDeadlineMs - nowMs) / 1000)) : 0
      };
    });

    if (!txResult.duplicate) {
      if (txResult.timerExtended && txResult.deadlineMs !== null) {
        await AuctionTimerManager.setRunningTimer(normalized, txResult.lotId, txResult.deadlineMs);
        emitToRoom(normalized, SOCKET_EVENTS.TIMER_UPDATED, {
          roomCode: normalized,
          lotId: txResult.lotId,
          deadlineMs: txResult.deadlineMs,
          remainingSeconds: txResult.remainingSeconds,
          isPaused: false,
          extended: true,
          serverTimeMs: nowMs
        });
      }

      emitToRoom(normalized, SOCKET_EVENTS.BID_PLACED, {
        roomCode: normalized,
        lotId: txResult.lotId,
        bid: txResult.bidDto,
        winningFranchiseName: txResult.franchiseName,
        winningFranchiseDisplayName: txResult.franchiseDisplayName,
        nextBidLakhs: txResult.nextBidLakhs,
        incrementLakhs: txResult.incrementLakhs,
        serverTimeMs: nowMs
      });
    }

    return {
      bid: txResult.bidDto,
      nextBidLakhs: txResult.nextBidLakhs,
      incrementLakhs: txResult.incrementLakhs,
      timerExtended: txResult.timerExtended,
      deadlineMs: txResult.deadlineMs,
      remainingSeconds: txResult.remainingSeconds
    };
  }

  static async pauseAuction(code: string, guestSessionId: string): Promise<AuctionStateSnapshotDto> {
    const normalized = code.trim().toUpperCase();
    const nowMs = Date.now();

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertActiveHost(room, guestSessionId);

      if (room.status !== DbRoomStatus.LIVE || room.isPaused) {
        throw new AppError('Auction is not currently running.', 409, 'INVALID_TRANSITION');
      }

      const remainingMs =
        room.timerDeadlineMs !== null ? Math.max(0, Number(room.timerDeadlineMs) - nowMs) : 0;
      const nextVersion = room.version + 1;

      await tx.room.update({
        where: { id: room.id },
        data: {
          status: DbRoomStatus.PAUSED,
          isPaused: true,
          timerDeadlineMs: null,
          timerRemainingMs: remainingMs,
          version: nextVersion
        }
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.AUCTION_PAUSED, {
        pausedAt: new Date(nowMs).toISOString(),
        remainingMs
      });

      const full = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        include: AUCTION_ROOM_INCLUDE
      });
      return { full, remainingMs };
    });

    if (txResult.full.currentLotId) {
      await AuctionTimerManager.setPausedTimer(
        normalized,
        txResult.full.currentLotId,
        txResult.remainingMs
      );
    }

    const snapshot = mapAuctionStateSnapshot(txResult.full, nowMs);
    emitToRoom(normalized, SOCKET_EVENTS.AUCTION_PAUSED, {
      roomCode: normalized,
      auctionStage: snapshot.auctionStage,
      pausedAt: new Date(nowMs).toISOString()
    });
    emitToRoom(normalized, SOCKET_EVENTS.TIMER_UPDATED, snapshot.timer);

    return snapshot;
  }

  static async resumeAuction(code: string, guestSessionId: string): Promise<AuctionStateSnapshotDto> {
    const normalized = code.trim().toUpperCase();
    const nowMs = Date.now();

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertActiveHost(room, guestSessionId);

      if (room.status !== DbRoomStatus.PAUSED && !room.isPaused) {
        throw new AppError('Auction is not currently paused.', 409, 'INVALID_TRANSITION');
      }

      const activeLot = room.currentLotId
        ? room.lots.find((l) => l.id === room.currentLotId)
        : null;

      let deadlineMs: number | null = null;
      if (activeLot && activeLot.status === DbLotStatus.ACTIVE) {
        const remaining =
          room.timerRemainingMs && room.timerRemainingMs > 0
            ? room.timerRemainingMs
            : room.countdownSeconds * 1000;
        deadlineMs = nowMs + remaining;
      }

      const nextVersion = room.version + 1;
      await tx.room.update({
        where: { id: room.id },
        data: {
          status: DbRoomStatus.LIVE,
          isPaused: false,
          timerDeadlineMs: deadlineMs !== null ? BigInt(deadlineMs) : null,
          timerRemainingMs: null,
          version: nextVersion
        }
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.AUCTION_RESUMED, {
        resumedAt: new Date(nowMs).toISOString(),
        deadlineMs
      });

      const full = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        include: AUCTION_ROOM_INCLUDE
      });
      return { full, activeLotId: activeLot?.id || null, deadlineMs };
    });

    if (txResult.activeLotId && txResult.deadlineMs !== null) {
      await AuctionTimerManager.setRunningTimer(normalized, txResult.activeLotId, txResult.deadlineMs);
    }

    const snapshot = mapAuctionStateSnapshot(txResult.full, nowMs);
    emitToRoom(normalized, SOCKET_EVENTS.AUCTION_RESUMED, {
      roomCode: normalized,
      auctionStage: snapshot.auctionStage,
      resumedAt: new Date(nowMs).toISOString()
    });
    emitToRoom(normalized, SOCKET_EVENTS.TIMER_UPDATED, snapshot.timer);

    return snapshot;
  }

  static async extendTimer(
    code: string,
    guestSessionId: string,
    extraSeconds: number
  ): Promise<AuctionStateSnapshotDto> {
    const normalized = code.trim().toUpperCase();
    const nowMs = Date.now();

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertActiveHost(room, guestSessionId);

      if (room.status !== DbRoomStatus.LIVE || room.isPaused || !room.currentLotId) {
        throw new AppError('Timer can only be extended during active live bidding.', 409, 'INVALID_TRANSITION');
      }

      const lot = room.lots.find((l) => l.id === room.currentLotId);
      if (!lot || lot.status !== DbLotStatus.ACTIVE) {
        throw new AppError('Timer can only be extended while lot bidding is open.', 409, 'LOT_NOT_ACTIVE');
      }

      const baseMs = Math.max(nowMs, Number(room.timerDeadlineMs || nowMs));
      const newDeadlineMs = baseMs + extraSeconds * 1000;
      const nextVersion = room.version + 1;

      await tx.room.update({
        where: { id: room.id },
        data: { timerDeadlineMs: BigInt(newDeadlineMs), version: nextVersion }
      });

      const full = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        include: AUCTION_ROOM_INCLUDE
      });
      return { full, lotId: lot.id, newDeadlineMs };
    });

    await AuctionTimerManager.setRunningTimer(normalized, txResult.lotId, txResult.newDeadlineMs);
    const snapshot = mapAuctionStateSnapshot(txResult.full, nowMs);
    emitToRoom(normalized, SOCKET_EVENTS.TIMER_UPDATED, snapshot.timer);

    return snapshot;
  }

  static async markSold(
    code: string,
    guestSessionId: string,
    lotId: string
  ): Promise<AuctionStateSnapshotDto> {
    const normalized = code.trim().toUpperCase();
    const nowMs = Date.now();

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertActiveHost(room, guestSessionId);

      const lot = room.lots.find((l) => l.id === lotId);
      if (!lot) {
        throw new AppError('Player lot not found in this room.', 404, 'LOT_NOT_FOUND');
      }

      // Idempotent if already SOLD
      if (lot.status === DbLotStatus.SOLD) {
        const full = await tx.room.findUniqueOrThrow({
          where: { id: room.id },
          include: AUCTION_ROOM_INCLUDE
        });
        return { alreadySold: true as const, full };
      }

      if (lot.status !== DbLotStatus.ACTIVE && lot.status !== DbLotStatus.BIDDING_CLOSED) {
        throw new AppError(
          `Cannot mark player SOLD from status '${lot.status}'.`,
          409,
          'LOT_ALREADY_RESOLVED'
        );
      }

      if (!lot.winningFranchiseId || lot.currentBidLakhs <= 0) {
        throw new AppError(
          'Cannot mark SOLD without a valid highest bidder. Mark UNSOLD instead.',
          400,
          'NO_WINNING_BID'
        );
      }

      const franchise = room.franchises.find((f) => f.id === lot.winningFranchiseId);
      if (!franchise) {
        throw new AppError('Winning franchise not found.', 404, 'INVALID_FRANCHISE');
      }

      const salePrice = lot.currentBidLakhs;
      if (franchise.remainingPurseLakhs < salePrice) {
        throw new AppError(
          `${franchise.abbreviation} has insufficient purse (${franchise.remainingPurseLakhs}L < ${salePrice}L).`,
          409,
          'INSUFFICIENT_PURSE'
        );
      }

      if (franchise.squadCount >= room.maxSquadSize) {
        throw new AppError(
          `${franchise.abbreviation} has reached maximum squad size (${room.maxSquadSize}).`,
          409,
          'MAX_SQUAD_REACHED'
        );
      }

      if (lot.player.isOverseas && franchise.overseasCount >= room.maxOverseas) {
        throw new AppError(
          `${franchise.abbreviation} has reached maximum overseas players (${room.maxOverseas}).`,
          409,
          'MAX_OVERSEAS_REACHED'
        );
      }

      await tx.roomPlayerLot.update({
        where: { id: lot.id },
        data: {
          status: DbLotStatus.SOLD,
          settledAt: new Date(nowMs)
        }
      });

      const purchase = await tx.purchase.create({
        data: {
          lotId: lot.id,
          roomId: room.id,
          franchiseId: franchise.id,
          playerId: lot.playerId,
          purchasePriceLakhs: salePrice,
          soldAt: new Date(nowMs)
        }
      });

      const newRemainingPurse = franchise.remainingPurseLakhs - salePrice;
      const updatedFranchise = await tx.roomFranchise.update({
        where: { id: franchise.id },
        data: {
          remainingPurseLakhs: newRemainingPurse,
          squadCount: { increment: 1 },
          overseasCount: lot.player.isOverseas ? { increment: 1 } : undefined
        }
      });

      await tx.purseLedger.create({
        data: {
          franchiseId: franchise.id,
          purchaseId: purchase.id,
          entryType: LedgerEntryType.DEDUCTION,
          amountLakhs: -salePrice,
          balanceAfterLakhs: newRemainingPurse,
          description: `Acquired ${lot.player.fullName} in auction`
        }
      });

      const nextVersion = room.version + 1;
      await tx.room.update({
        where: { id: room.id },
        data: {
          status: DbRoomStatus.LIVE,
          isPaused: false,
          timerDeadlineMs: null,
          timerRemainingMs: null,
          version: nextVersion
        }
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.PLAYER_SOLD, {
        lotId: lot.id,
        playerId: lot.playerId,
        playerName: lot.player.fullName,
        franchiseId: franchise.id,
        franchiseCode: franchise.presetCode,
        purchasePriceLakhs: salePrice
      });

      const full = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        include: AUCTION_ROOM_INCLUDE
      });

      return {
        alreadySold: false as const,
        full,
        lot,
        franchise: updatedFranchise,
        salePrice
      };
    });

    await AuctionTimerManager.clearTimer(normalized);
    const snapshot = mapAuctionStateSnapshot(txResult.full, nowMs);

    if (!txResult.alreadySold) {
      const updatedFranDto = snapshot.franchises.find((f) => f.id === txResult.franchise.id)!;

      emitToRoom(normalized, SOCKET_EVENTS.PLAYER_SOLD, {
        roomCode: normalized,
        lotId: txResult.lot.id,
        playerId: txResult.lot.playerId,
        playerName: txResult.lot.player.fullName,
        playingRole: txResult.lot.player.playingRole,
        isOverseas: txResult.lot.player.isOverseas,
        franchiseId: updatedFranDto.id,
        franchiseCode: updatedFranDto.presetCode,
        franchiseName: updatedFranDto.name,
        franchiseDisplayName: updatedFranDto.displayName,
        franchiseColor: updatedFranDto.primaryColor,
        soldPriceLakhs: txResult.salePrice,
        settledAt: new Date(nowMs).toISOString()
      });

      emitToRoom(normalized, SOCKET_EVENTS.PURSE_UPDATED, {
        roomCode: normalized,
        franchiseId: updatedFranDto.id,
        franchiseCode: updatedFranDto.presetCode,
        remainingPurseLakhs: updatedFranDto.remainingPurseLakhs
      });

      emitToRoom(normalized, SOCKET_EVENTS.SQUAD_UPDATED, {
        roomCode: normalized,
        franchiseId: updatedFranDto.id,
        franchiseCode: updatedFranDto.presetCode,
        squadCount: updatedFranDto.squadCount,
        overseasCount: updatedFranDto.overseasCount,
        squad: updatedFranDto.squad
      });

      emitToRoom(normalized, SOCKET_EVENTS.TIMER_UPDATED, snapshot.timer);
    }

    return snapshot;
  }

  static async markUnsold(
    code: string,
    guestSessionId: string,
    lotId: string
  ): Promise<AuctionStateSnapshotDto> {
    const normalized = code.trim().toUpperCase();
    const nowMs = Date.now();

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertActiveHost(room, guestSessionId);

      const lot = room.lots.find((l) => l.id === lotId);
      if (!lot) {
        throw new AppError('Player lot not found in this room.', 404, 'LOT_NOT_FOUND');
      }

      // Idempotent if already UNSOLD
      if (lot.status === DbLotStatus.UNSOLD) {
        const full = await tx.room.findUniqueOrThrow({
          where: { id: room.id },
          include: AUCTION_ROOM_INCLUDE
        });
        return { alreadyUnsold: true as const, full };
      }

      if (lot.status !== DbLotStatus.ACTIVE && lot.status !== DbLotStatus.BIDDING_CLOSED) {
        throw new AppError(
          `Cannot mark player UNSOLD from status '${lot.status}'.`,
          409,
          'LOT_ALREADY_RESOLVED'
        );
      }

      await tx.roomPlayerLot.update({
        where: { id: lot.id },
        data: {
          status: DbLotStatus.UNSOLD,
          settledAt: new Date(nowMs)
        }
      });

      const nextVersion = room.version + 1;
      await tx.room.update({
        where: { id: room.id },
        data: {
          status: DbRoomStatus.LIVE,
          isPaused: false,
          timerDeadlineMs: null,
          timerRemainingMs: null,
          version: nextVersion
        }
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.PLAYER_UNSOLD, {
        lotId: lot.id,
        playerId: lot.playerId,
        playerName: lot.player.fullName
      });

      const full = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        include: AUCTION_ROOM_INCLUDE
      });

      return { alreadyUnsold: false as const, full, lot };
    });

    await AuctionTimerManager.clearTimer(normalized);
    const snapshot = mapAuctionStateSnapshot(txResult.full, nowMs);

    if (!txResult.alreadyUnsold) {
      emitToRoom(normalized, SOCKET_EVENTS.PLAYER_UNSOLD, {
        roomCode: normalized,
        lotId: txResult.lot.id,
        playerId: txResult.lot.playerId,
        playerName: txResult.lot.player.fullName,
        playingRole: txResult.lot.player.playingRole,
        isOverseas: txResult.lot.player.isOverseas,
        settledAt: new Date(nowMs).toISOString()
      });
      emitToRoom(normalized, SOCKET_EVENTS.TIMER_UPDATED, snapshot.timer);
    }

    return snapshot;
  }

  static async nextPlayer(code: string, guestSessionId: string): Promise<AuctionStateSnapshotDto> {
    const normalized = code.trim().toUpperCase();
    const nowMs = Date.now();

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertActiveHost(room, guestSessionId);

      if (room.status !== DbRoomStatus.LIVE && room.status !== DbRoomStatus.PAUSED) {
        throw new AppError('Auction must be live to advance to the next player.', 409, 'INVALID_TRANSITION');
      }

      const currentLot = room.currentLotId
        ? room.lots.find((l) => l.id === room.currentLotId)
        : null;
      if (
        currentLot &&
        (currentLot.status === DbLotStatus.ACTIVE || currentLot.status === DbLotStatus.BIDDING_CLOSED)
      ) {
        throw new AppError(
          'Resolve the current player (SOLD, UNSOLD, or Skip) before moving to the next lot.',
          409,
          'CURRENT_LOT_UNRESOLVED'
        );
      }

      const nextLot = room.lots.find((l) => l.status === DbLotStatus.QUEUED);
      const nextVersion = room.version + 1;

      if (!nextLot) {
        await tx.room.update({
          where: { id: room.id },
          data: {
            status: DbRoomStatus.COMPLETED,
            isPaused: false,
            currentLotId: null,
            timerDeadlineMs: null,
            timerRemainingMs: null,
            endedAt: new Date(nowMs),
            version: nextVersion
          }
        });

        await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.AUCTION_COMPLETED, {
          endedAt: new Date(nowMs).toISOString()
        });

        const full = await tx.room.findUniqueOrThrow({
          where: { id: room.id },
          include: AUCTION_ROOM_INCLUDE
        });
        return { completed: true as const, full };
      }

      const deadlineMs = nowMs + room.countdownSeconds * 1000;
      await tx.roomPlayerLot.update({
        where: { id: nextLot.id },
        data: {
          status: DbLotStatus.ACTIVE,
          startedAt: new Date(nowMs)
        }
      });

      await tx.room.update({
        where: { id: room.id },
        data: {
          status: DbRoomStatus.LIVE,
          isPaused: false,
          currentLotId: nextLot.id,
          timerDeadlineMs: BigInt(deadlineMs),
          timerRemainingMs: null,
          version: nextVersion
        }
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.PLAYER_LOT_STARTED, {
        lotId: nextLot.id,
        playerId: nextLot.playerId,
        playerName: nextLot.player.fullName,
        sequenceOrder: nextLot.sequenceOrder,
        basePriceLakhs: nextLot.basePriceLakhs
      });

      const full = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        include: AUCTION_ROOM_INCLUDE
      });

      return { completed: false as const, full, nextLotId: nextLot.id, deadlineMs };
    });

    if (txResult.completed) {
      await AuctionTimerManager.clearTimer(normalized);
      const snapshot = mapAuctionStateSnapshot(txResult.full, nowMs);
      emitToRoom(normalized, SOCKET_EVENTS.AUCTION_COMPLETED, {
        roomCode: normalized,
        endedAt: new Date(nowMs).toISOString(),
        franchises: snapshot.franchises
      });
      return snapshot;
    }

    await AuctionTimerManager.setRunningTimer(normalized, txResult.nextLotId, txResult.deadlineMs);
    const snapshot = mapAuctionStateSnapshot(txResult.full, nowMs);

    emitToRoom(normalized, SOCKET_EVENTS.PLAYER_LOT_STARTED, {
      roomCode: normalized,
      currentLot: snapshot.currentLot,
      upNextLots: snapshot.upNextLots
    });
    emitToRoom(normalized, SOCKET_EVENTS.TIMER_UPDATED, snapshot.timer);

    return snapshot;
  }

  static async skipPlayer(code: string, guestSessionId: string): Promise<AuctionStateSnapshotDto> {
    const normalized = code.trim().toUpperCase();
    const nowMs = Date.now();

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);
      assertActiveHost(room, guestSessionId);

      if (!room.allowHostSkip) {
        throw new AppError('Skipping players is disabled by room rules.', 403, 'SKIP_NOT_PERMITTED');
      }

      if (!room.currentLotId) {
        throw new AppError('No active player lot to skip.', 409, 'LOT_NOT_ACTIVE');
      }

      const currentLot = room.lots.find((l) => l.id === room.currentLotId);
      if (
        !currentLot ||
        (currentLot.status !== DbLotStatus.ACTIVE && currentLot.status !== DbLotStatus.BIDDING_CLOSED)
      ) {
        throw new AppError('Current player lot is already resolved.', 409, 'LOT_ALREADY_RESOLVED');
      }

      if (currentLot.currentBidLakhs > 0) {
        throw new AppError(
          'Cannot skip a player after bids have been placed. Mark SOLD or UNSOLD.',
          409,
          'CANNOT_SKIP_WITH_BIDS'
        );
      }

      await tx.roomPlayerLot.update({
        where: { id: currentLot.id },
        data: { status: DbLotStatus.SKIPPED, settledAt: new Date(nowMs) }
      });

      const nextLot = room.lots.find(
        (l) => l.id !== currentLot.id && l.status === DbLotStatus.QUEUED
      );
      const nextVersion = room.version + 1;

      if (!nextLot) {
        await tx.room.update({
          where: { id: room.id },
          data: {
            status: DbRoomStatus.COMPLETED,
            isPaused: false,
            currentLotId: null,
            timerDeadlineMs: null,
            timerRemainingMs: null,
            endedAt: new Date(nowMs),
            version: nextVersion
          }
        });
        await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.AUCTION_COMPLETED, {
          endedAt: new Date(nowMs).toISOString()
        });
        const full = await tx.room.findUniqueOrThrow({
          where: { id: room.id },
          include: AUCTION_ROOM_INCLUDE
        });
        return { completed: true as const, skippedLotId: currentLot.id, full };
      }

      const deadlineMs = nowMs + room.countdownSeconds * 1000;
      await tx.roomPlayerLot.update({
        where: { id: nextLot.id },
        data: { status: DbLotStatus.ACTIVE, startedAt: new Date(nowMs) }
      });

      await tx.room.update({
        where: { id: room.id },
        data: {
          status: DbRoomStatus.LIVE,
          isPaused: false,
          currentLotId: nextLot.id,
          timerDeadlineMs: BigInt(deadlineMs),
          timerRemainingMs: null,
          version: nextVersion
        }
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.PLAYER_LOT_STARTED, {
        lotId: nextLot.id,
        playerId: nextLot.playerId,
        playerName: nextLot.player.fullName,
        sequenceOrder: nextLot.sequenceOrder,
        basePriceLakhs: nextLot.basePriceLakhs
      });

      const full = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        include: AUCTION_ROOM_INCLUDE
      });
      return {
        completed: false as const,
        skippedLotId: currentLot.id,
        full,
        nextLotId: nextLot.id,
        deadlineMs
      };
    });

    if (txResult.completed) {
      await AuctionTimerManager.clearTimer(normalized);
      const snapshot = mapAuctionStateSnapshot(txResult.full, nowMs);
      emitToRoom(normalized, SOCKET_EVENTS.AUCTION_COMPLETED, {
        roomCode: normalized,
        endedAt: new Date(nowMs).toISOString(),
        franchises: snapshot.franchises
      });
      return snapshot;
    }

    await AuctionTimerManager.setRunningTimer(normalized, txResult.nextLotId, txResult.deadlineMs);
    const snapshot = mapAuctionStateSnapshot(txResult.full, nowMs);
    emitToRoom(normalized, SOCKET_EVENTS.PLAYER_LOT_STARTED, {
      roomCode: normalized,
      currentLot: snapshot.currentLot,
      upNextLots: snapshot.upNextLots
    });
    emitToRoom(normalized, SOCKET_EVENTS.TIMER_UPDATED, snapshot.timer);

    return snapshot;
  }

  /**
   * Re-queues UNSOLD players into a controlled accelerated round after current active bidding closes.
   * Guarantees zero duplicate sales by filtering out any lot with a Purchase record.
   */
  static async requeueUnsold(
    code: string,
    guestSessionId: string,
    lotIds?: string[]
  ): Promise<AuctionStateSnapshotDto> {
    const normalized = code.trim().toUpperCase();
    const nowMs = Date.now();

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await tx.room.findUniqueOrThrow({
        where: { id: roomId },
        include: {
          participants: true,
          lots: {
            include: { player: true, purchase: true },
            orderBy: { sequenceOrder: 'asc' }
          }
        }
      });

      assertActiveHost(room, guestSessionId);

      if (room.status === DbRoomStatus.LOBBY || room.status === DbRoomStatus.CANCELLED) {
        throw new AppError(
          'Unsold re-entry is only available once the auction has started.',
          409,
          'AUCTION_NOT_STARTED'
        );
      }

      const activeBlocking = room.currentLotId
        ? room.lots.find(
            (l) =>
              l.id === room.currentLotId &&
              (l.status === DbLotStatus.ACTIVE || l.status === DbLotStatus.BIDDING_CLOSED)
          )
        : null;
      if (activeBlocking) {
        throw new AppError(
          'Finish the current active player lot (SOLD / UNSOLD / SKIP) before starting an Unsold Re-Entry round.',
          409,
          'RESOLVE_CURRENT_LOT_FIRST'
        );
      }

      const targetIdSet = lotIds && lotIds.length > 0 ? new Set(lotIds) : null;
      if (targetIdSet) {
        for (const id of targetIdSet) {
          const found = room.lots.find((l) => l.id === id);
          if (!found) {
            throw new AppError(`Lot '${id}' does not belong to this room.`, 404, 'LOT_NOT_FOUND');
          }
          if (found.purchase || found.status !== DbLotStatus.UNSOLD) {
            throw new AppError(
              `Player '${found.player.fullName}' is not eligible for unsold re-entry.`,
              409,
              'LOT_NOT_ELIGIBLE_REENTRY'
            );
          }
        }
      }

      const eligible = room.lots.filter(
        (l) =>
          l.status === DbLotStatus.UNSOLD &&
          !l.purchase &&
          (!targetIdSet || targetIdSet.has(l.id))
      );
      if (eligible.length === 0) {
        throw new AppError('No unsold players are available to re-enter.', 400, 'NO_UNSOLD_PLAYERS');
      }

      const maxSeq = room.lots.reduce((max, l) => Math.max(max, l.sequenceOrder), 0);
      const nextRound = room.lots.reduce((max, l) => Math.max(max, l.roundNumber ?? 1), 1) + 1;

      for (let i = 0; i < eligible.length; i++) {
        await tx.roomPlayerLot.update({
          where: { id: eligible[i].id },
          data: {
            roundNumber: nextRound,
            sequenceOrder: maxSeq + i + 1,
            status: DbLotStatus.QUEUED,
            currentBidLakhs: 0,
            winningFranchiseId: null,
            biddingClosedAt: null,
            startedAt: null,
            settledAt: null
          }
        });
      }

      const shouldActivateFirst = room.status === DbRoomStatus.COMPLETED || room.currentLotId === null;
      let activatedLotId: string | null = null;
      let deadlineMs: number | null = null;
      const nextVersion = room.version + 1;

      if (shouldActivateFirst) {
        const firstLot = eligible[0];
        activatedLotId = firstLot.id;
        deadlineMs = nowMs + room.countdownSeconds * 1000;
        await tx.roomPlayerLot.update({
          where: { id: firstLot.id },
          data: { status: DbLotStatus.ACTIVE, startedAt: new Date(nowMs) }
        });
        await tx.room.update({
          where: { id: room.id },
          data: {
            status: DbRoomStatus.LIVE,
            isPaused: false,
            currentLotId: firstLot.id,
            timerDeadlineMs: BigInt(deadlineMs),
            timerRemainingMs: null,
            endedAt: null,
            version: nextVersion
          }
        });
      } else {
        await tx.room.update({
          where: { id: room.id },
          data: { version: nextVersion }
        });
      }

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.LOT_ROUND_REENTERED, {
        roundNumber: nextRound,
        requeuedCount: eligible.length,
        playerNames: eligible.map((l) => l.player.fullName)
      });

      const full = await tx.room.findUniqueOrThrow({
        where: { id: room.id },
        include: AUCTION_ROOM_INCLUDE
      });

      return {
        full,
        requeuedCount: eligible.length,
        roundNumber: nextRound,
        activatedLotId,
        deadlineMs
      };
    });

    if (txResult.activatedLotId && txResult.deadlineMs !== null) {
      await AuctionTimerManager.setRunningTimer(normalized, txResult.activatedLotId, txResult.deadlineMs);
    }

    const snapshot = mapAuctionStateSnapshot(txResult.full, nowMs);
    emitToRoom(normalized, SOCKET_EVENTS.LOT_ROUND_REENTERED, {
      roomCode: normalized,
      requeuedCount: txResult.requeuedCount,
      roundNumber: txResult.roundNumber,
      upNextLots: snapshot.upNextLots,
      activatedFirst: Boolean(txResult.activatedLotId),
      snapshot
    });

    if (txResult.activatedLotId) {
      emitToRoom(normalized, SOCKET_EVENTS.PLAYER_LOT_STARTED, {
        roomCode: normalized,
        currentLot: snapshot.currentLot,
        upNextLots: snapshot.upNextLots
      });
      emitToRoom(normalized, SOCKET_EVENTS.TIMER_UPDATED, snapshot.timer);
    }

    return snapshot;
  }
}
