import {
  CricketRole,
  Prisma,
  RoomRole as DbRoomRole,
  RoomStatus as DbRoomStatus,
  TradeDirection as DbTradeDirection,
  TradeStatus as DbTradeStatus,
  prisma
} from '@auctioncraze/database';
import {
  RoomStatus,
  SOCKET_EVENTS,
  TradeCenterStateDto,
  TradeDirection,
  TradeProposalDto,
  TradeStatus,
  formatFranchiseDisplayName
} from '@auctioncraze/shared';
import { AppError } from '../../middleware/errorHandler';
import { emitToRoom } from '../../sockets/socketServer';
import { AUCTION_ROOM_INCLUDE, mapAuctionStateSnapshot } from '../auction/auctionMapper';
import { appendRoomEvent, fetchRoomWithRelations, lockRoomByCode } from '../rooms/roomHelpers';
import { mapRoomToDetailDto } from '../rooms/roomMapper';

const TRADE_INCLUDE = {
  proposerFranchise: true,
  receiverFranchise: true,
  items: {
    include: { player: true }
  }
} satisfies Prisma.TradeProposalInclude;

interface OwnedSquadEntry {
  playerId: string;
  sourceType: 'AUCTION' | 'RETENTION';
  recordId: string;
  priceLakhs: number;
  isOverseas: boolean;
  fullName: string;
}

function assertLifecyclePermitsTrading(status: DbRoomStatus): void {
  if (status === DbRoomStatus.LOBBY) {
    throw new AppError(
      'Player trading is not available before the auction begins.',
      409,
      'AUCTION_NOT_STARTED'
    );
  }
  if (status === DbRoomStatus.CANCELLED) {
    throw new AppError('Trading is closed for cancelled rooms.', 409, 'ROOM_CLOSED');
  }
}

async function lockFranchisesInOrder(tx: Prisma.TransactionClient, idA: string, idB: string): Promise<void> {
  const ordered = [idA, idB].sort((a, b) => a.localeCompare(b));
  await tx.$queryRaw`
    SELECT "id" FROM "RoomFranchise"
    WHERE "id" IN (${ordered[0]}, ${ordered[1]})
    ORDER BY "id" ASC
    FOR UPDATE
  `;
}

async function loadFranchiseRosterMap(
  tx: Prisma.TransactionClient,
  roomId: string,
  franchiseId: string
): Promise<Map<string, OwnedSquadEntry>> {
  const [purchases, retentions] = await Promise.all([
    tx.purchase.findMany({
      where: { roomId, franchiseId },
      include: { player: true }
    }),
    tx.roomRetention.findMany({
      where: { roomId, franchiseId },
      include: { player: true }
    })
  ]);

  const map = new Map<string, OwnedSquadEntry>();
  for (const r of retentions) {
    map.set(r.playerId, {
      playerId: r.playerId,
      sourceType: 'RETENTION',
      recordId: r.id,
      priceLakhs: r.retentionCostLakhs,
      isOverseas: !!r.player.isOverseas,
      fullName: r.player.fullName
    });
  }
  for (const p of purchases) {
    map.set(p.playerId, {
      playerId: p.playerId,
      sourceType: 'AUCTION',
      recordId: p.id,
      priceLakhs: p.purchasePriceLakhs,
      isOverseas: !!p.player.isOverseas,
      fullName: p.player.fullName
    });
  }
  return map;
}

async function recomputeFranchiseCounts(
  tx: Prisma.TransactionClient,
  roomId: string,
  franchiseId: string
): Promise<{ squadCount: number; overseasCount: number; retainedCount: number }> {
  const [purchases, retentions] = await Promise.all([
    tx.purchase.findMany({
      where: { roomId, franchiseId },
      include: { player: { select: { isOverseas: true } } }
    }),
    tx.roomRetention.findMany({
      where: { roomId, franchiseId },
      include: { player: { select: { isOverseas: true } } }
    })
  ]);

  const squadCount = purchases.length + retentions.length;
  const retainedCount = retentions.length;
  const overseasCount =
    purchases.filter((p) => p.player.isOverseas).length +
    retentions.filter((r) => r.player.isOverseas).length;

  await tx.roomFranchise.update({
    where: { id: franchiseId },
    data: { squadCount, overseasCount, retainedCount }
  });

  return { squadCount, overseasCount, retainedCount };
}

function mapTradeToDto(
  trade: any,
  room: { allowCustomTeamName: boolean; franchises: any[]; participants: any[] }
): TradeProposalDto {
  const franById = new Map<string, any>();
  room.franchises.forEach((f) => franById.set(f.id, f));
  const participantById = new Map<string, any>();
  room.participants.forEach((p) => participantById.set(p.id, p));

  const propFran = franById.get(trade.proposerFranchiseId) || trade.proposerFranchise;
  const recvFran = franById.get(trade.receiverFranchiseId) || trade.receiverFranchise;

  const mapItem = (it: any) => {
    const fromF = franById.get(it.fromFranchiseId);
    const toF = franById.get(it.toFranchiseId);
    return {
      id: it.id,
      playerId: it.playerId,
      playerName: it.player?.fullName || 'Unknown Player',
      playingRole: (it.player?.playingRole || CricketRole.ALL_ROUNDER) as CricketRole,
      isOverseas: !!it.player?.isOverseas,
      sourceType: it.sourceType as 'AUCTION' | 'RETENTION',
      direction: it.direction as TradeDirection,
      fromFranchiseId: it.fromFranchiseId,
      fromFranchiseCode: fromF?.presetCode || '',
      toFranchiseId: it.toFranchiseId,
      toFranchiseCode: toF?.presetCode || '',
      priceLakhs: it.priceLakhs
    };
  };

  const propOwner = participantById.get(trade.proposerParticipantId);
  const recvOwner = participantById.get(trade.receiverParticipantId);

  return {
    id: trade.id,
    roomId: trade.roomId,
    proposerFranchiseId: trade.proposerFranchiseId,
    proposerFranchiseCode: propFran?.presetCode || '',
    proposerFranchiseDisplayName: propFran
      ? formatFranchiseDisplayName(
          propFran.name,
          propFran.presetCode,
          propFran.customSuffix,
          !!room.allowCustomTeamName
        )
      : '',
    receiverFranchiseId: trade.receiverFranchiseId,
    receiverFranchiseCode: recvFran?.presetCode || '',
    receiverFranchiseDisplayName: recvFran
      ? formatFranchiseDisplayName(
          recvFran.name,
          recvFran.presetCode,
          recvFran.customSuffix,
          !!room.allowCustomTeamName
        )
      : '',
    proposerOwnerName: propOwner?.displayName || 'Owner',
    receiverOwnerName: recvOwner?.displayName || 'Owner',
    status: trade.status as TradeStatus,
    note: trade.note ?? null,
    failureReason: trade.failureReason ?? null,
    expiresAt: trade.expiresAt.toISOString(),
    respondedAt: trade.respondedAt ? trade.respondedAt.toISOString() : null,
    executedAt: trade.executedAt ? trade.executedAt.toISOString() : null,
    createdAt: trade.createdAt.toISOString(),
    outgoingPlayers: (trade.items || [])
      .filter((i: any) => i.direction === DbTradeDirection.OUTGOING)
      .map(mapItem),
    incomingPlayers: (trade.items || [])
      .filter((i: any) => i.direction === DbTradeDirection.INCOMING)
      .map(mapItem)
  };
}

async function expirePendingTradesInTx(
  tx: Prisma.TransactionClient,
  roomId: string,
  now: Date
): Promise<string[]> {
  const stale = await tx.tradeProposal.findMany({
    where: {
      roomId,
      status: DbTradeStatus.PENDING,
      expiresAt: { lte: now }
    },
    select: { id: true }
  });
  if (stale.length === 0) return [];
  const ids = stale.map((s) => s.id);
  await tx.tradeProposal.updateMany({
    where: { id: { in: ids }, status: DbTradeStatus.PENDING },
    data: {
      status: DbTradeStatus.EXPIRED,
      respondedAt: now,
      failureReason: 'Proposal expired before receiver response.'
    }
  });
  return ids;
}

async function flushExpiredTradesByCode(roomCode: string, now: Date): Promise<void> {
  const roomRow = await prisma.room.findUnique({
    where: { code: roomCode },
    select: { id: true }
  });
  if (!roomRow) return;
  const expiredIds = await prisma.$transaction((tx) => expirePendingTradesInTx(tx, roomRow.id, now));
  for (const id of expiredIds) {
    emitToRoom(roomCode, SOCKET_EVENTS.TRADE_EXPIRED, { roomCode, tradeId: id });
  }
}

async function emitRoomAndAuctionState(roomCode: string, roomId: string): Promise<void> {
  const [roomFull, auctionFull] = await Promise.all([
    prisma.room.findUnique({
      where: { id: roomId },
      include: {
        franchises: { orderBy: { presetCode: 'asc' } },
        participants: { orderBy: { joinedAt: 'asc' } },
        lots: { include: { player: true }, orderBy: { sequenceOrder: 'asc' } },
        retentions: { include: { player: true }, orderBy: { slotNumber: 'asc' } }
      }
    }),
    prisma.room.findUnique({
      where: { id: roomId },
      include: AUCTION_ROOM_INCLUDE
    })
  ]);

  if (roomFull) {
    emitToRoom(roomCode, SOCKET_EVENTS.ROOM_STATE, mapRoomToDetailDto(roomFull, false));
  }
  if (auctionFull) {
    const snap = mapAuctionStateSnapshot(auctionFull);
    for (const f of snap.franchises) {
      emitToRoom(roomCode, SOCKET_EVENTS.SQUAD_UPDATED, {
        roomCode,
        franchiseId: f.id,
        franchiseCode: f.presetCode,
        squadCount: f.squadCount,
        overseasCount: f.overseasCount,
        squad: f.squad
      });
    }
    emitToRoom(roomCode, SOCKET_EVENTS.AUCTION_STATE, snap);
  }
}

export class TradeService {
  static async listTrades(code: string, guestSessionId: string): Promise<TradeCenterStateDto> {
    const normalized = code.trim().toUpperCase();
    const now = new Date();

    const result = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const expiredIds = await expirePendingTradesInTx(tx, roomId, now);

      const room = await tx.room.findUniqueOrThrow({
        where: { id: roomId },
        include: {
          franchises: { orderBy: { presetCode: 'asc' } },
          participants: true
        }
      });

      const activeParticipants = room.participants.filter((p) => !p.isRemoved && !p.leftAt);
      const caller = activeParticipants.find((p) => p.guestSessionId === guestSessionId);
      if (!caller) {
        throw new AppError('You are not an active member of this room.', 403, 'NOT_A_MEMBER');
      }
      if (caller.role === DbRoomRole.SPECTATOR) {
        throw new AppError(
          'Spectators cannot access the franchise Trade Centre.',
          403,
          'SPECTATOR_FORBIDDEN'
        );
      }
      if (!caller.franchiseId) {
        throw new AppError('You must own a franchise to use the Trade Centre.', 400, 'NO_FRANCHISE_OWNED');
      }

      const myFranchise = room.franchises.find((f) => f.id === caller.franchiseId);
      if (!myFranchise) {
        throw new AppError('Owned franchise not found.', 404, 'FRANCHISE_NOT_FOUND');
      }

      const allTrades = await tx.tradeProposal.findMany({
        where: { roomId: room.id },
        include: TRADE_INCLUDE,
        orderBy: { createdAt: 'desc' }
      });

      const visibleTrades = allTrades.filter(
        (t) =>
          t.proposerFranchiseId === myFranchise.id || t.receiverFranchiseId === myFranchise.id
      );

      const mapped = visibleTrades.map((t) => mapTradeToDto(t, room));
      const pendingIncoming = mapped.filter(
        (t) => t.status === TradeStatus.PENDING && t.receiverFranchiseId === myFranchise.id
      );
      const pendingOutgoing = mapped.filter(
        (t) => t.status === TradeStatus.PENDING && t.proposerFranchiseId === myFranchise.id
      );
      const history = mapped.filter((t) => t.status !== TradeStatus.PENDING);

      return {
        expiredIds,
        state: {
          roomCode: room.code,
          allowPlayerTrades: !!room.allowPlayerTrades,
          lifecyclePermitsTrading:
            room.status === DbRoomStatus.LIVE ||
            room.status === DbRoomStatus.PAUSED ||
            room.status === DbRoomStatus.COMPLETED,
          roomStatus: room.status as RoomStatus,
          myFranchiseId: myFranchise.id,
          myFranchiseCode: myFranchise.presetCode,
          myFranchiseDisplayName: formatFranchiseDisplayName(
            myFranchise.name,
            myFranchise.presetCode,
            myFranchise.customSuffix,
            !!room.allowCustomTeamName
          ),
          pendingIncoming,
          pendingOutgoing,
          history
        }
      };
    });

    for (const id of result.expiredIds) {
      emitToRoom(normalized, SOCKET_EVENTS.TRADE_EXPIRED, { roomCode: normalized, tradeId: id });
    }

    return result.state;
  }

  static async proposeTrade(
    code: string,
    guestSessionId: string,
    input: {
      receiverFranchiseId: string;
      outgoingPlayerIds: string[];
      incomingPlayerIds: string[];
      note?: string;
      expiresInMinutes: number;
      idempotencyKey: string;
    }
  ): Promise<TradeProposalDto> {
    const normalized = code.trim().toUpperCase();
    const now = new Date();
    await flushExpiredTradesByCode(normalized, now);

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      await expirePendingTradesInTx(tx, roomId, now);

      const room = await tx.room.findUniqueOrThrow({
        where: { id: roomId },
        include: {
          franchises: true,
          participants: true,
          lots: {
            where: { status: { in: ['ACTIVE', 'BIDDING_CLOSED'] } },
            select: { playerId: true }
          }
        }
      });

      const activeParticipants = room.participants.filter((p) => !p.isRemoved && !p.leftAt);
      const caller = activeParticipants.find((p) => p.guestSessionId === guestSessionId);
      if (!caller) {
        throw new AppError('You are not an active member of this room.', 403, 'NOT_A_MEMBER');
      }
      if (caller.role === DbRoomRole.SPECTATOR) {
        throw new AppError('Spectators cannot propose franchise trades.', 403, 'SPECTATOR_FORBIDDEN');
      }
      if (!caller.franchiseId) {
        throw new AppError('You must own a franchise to propose trades.', 400, 'NO_FRANCHISE_OWNED');
      }

      // Idempotent retry protection
      const existingIdem = await tx.tradeProposal.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: TRADE_INCLUDE
      });
      if (existingIdem) {
        if (
          existingIdem.roomId === room.id &&
          existingIdem.proposerFranchiseId === caller.franchiseId &&
          existingIdem.receiverFranchiseId === input.receiverFranchiseId
        ) {
          return { duplicate: true as const, tradeDto: mapTradeToDto(existingIdem, room) };
        }
        throw new AppError('Idempotency key already used for a different trade.', 409, 'DUPLICATE_IDEMPOTENCY_KEY');
      }

      if (!room.allowPlayerTrades) {
        throw new AppError(
          'Player trading is currently disabled by the room host.',
          403,
          'TRADES_DISABLED'
        );
      }
      assertLifecyclePermitsTrading(room.status);

      const proposerFranchise = room.franchises.find((f) => f.id === caller.franchiseId);
      const receiverFranchise = room.franchises.find((f) => f.id === input.receiverFranchiseId);
      if (!proposerFranchise || !receiverFranchise) {
        throw new AppError(
          'Both trading franchises must belong to this auction room.',
          404,
          'FRANCHISE_NOT_FOUND'
        );
      }
      if (proposerFranchise.id === receiverFranchise.id) {
        throw new AppError('Cannot propose a trade with your own franchise.', 400, 'SELF_TRADE_FORBIDDEN');
      }

      const receiverOwner = activeParticipants.find(
        (p) => p.franchiseId === receiverFranchise.id && p.role !== DbRoomRole.SPECTATOR
      );
      if (!receiverOwner) {
        throw new AppError(
          `${receiverFranchise.presetCode} does not have an active franchise owner in this room.`,
          409,
          'RECEIVER_NO_ACTIVE_OWNER'
        );
      }

      await lockFranchisesInOrder(tx, proposerFranchise.id, receiverFranchise.id);

      const [propRoster, recvRoster] = await Promise.all([
        loadFranchiseRosterMap(tx, room.id, proposerFranchise.id),
        loadFranchiseRosterMap(tx, room.id, receiverFranchise.id)
      ]);

      const activeLotPlayerIds = new Set(room.lots.map((l) => l.playerId));
      const outgoingEntries: OwnedSquadEntry[] = [];
      for (const pid of input.outgoingPlayerIds) {
        if (activeLotPlayerIds.has(pid)) {
          throw new AppError('Cannot trade a player currently active on the auction block.', 409, 'PLAYER_ON_BLOCK');
        }
        const owned = propRoster.get(pid);
        if (!owned) {
          throw new AppError(
            `You do not own selected outgoing player (${pid}).`,
            400,
            'OUTGOING_PLAYER_NOT_OWNED'
          );
        }
        if (recvRoster.has(pid)) {
          throw new AppError('Receiver already owns one of the offered players.', 409, 'DUPLICATE_PLAYER_CONFLICT');
        }
        outgoingEntries.push(owned);
      }

      const incomingEntries: OwnedSquadEntry[] = [];
      for (const pid of input.incomingPlayerIds) {
        if (activeLotPlayerIds.has(pid)) {
          throw new AppError('Cannot request a player currently active on the auction block.', 409, 'PLAYER_ON_BLOCK');
        }
        const owned = recvRoster.get(pid);
        if (!owned) {
          throw new AppError(
            `${receiverFranchise.presetCode} does not own requested incoming player (${pid}).`,
            400,
            'INCOMING_PLAYER_NOT_OWNED'
          );
        }
        if (propRoster.has(pid)) {
          throw new AppError('You already own one of the requested players.', 409, 'DUPLICATE_PLAYER_CONFLICT');
        }
        incomingEntries.push(owned);
      }

      // Check that no selected player is currently locked in another PENDING trade in this room
      const involvedIds = [...input.outgoingPlayerIds, ...input.incomingPlayerIds];
      const conflictingPending = await tx.tradeProposalItem.findFirst({
        where: {
          playerId: { in: involvedIds },
          trade: {
            roomId: room.id,
            status: DbTradeStatus.PENDING,
            expiresAt: { gt: now }
          }
        },
        include: { player: { select: { fullName: true } } }
      });
      if (conflictingPending) {
        throw new AppError(
          `${conflictingPending.player.fullName} is already part of another pending trade proposal.`,
          409,
          'PLAYER_IN_PENDING_TRADE'
        );
      }

      // Validate post-trade squad size and overseas ceilings for BOTH franchises
      const outOverseas = outgoingEntries.filter((p) => p.isOverseas).length;
      const inOverseas = incomingEntries.filter((p) => p.isOverseas).length;
      const propCurrentCount = propRoster.size;
      const recvCurrentCount = recvRoster.size;
      const propCurrentOverseas = Array.from(propRoster.values()).filter((p) => p.isOverseas).length;
      const recvCurrentOverseas = Array.from(recvRoster.values()).filter((p) => p.isOverseas).length;

      const propNextCount = propCurrentCount - outgoingEntries.length + incomingEntries.length;
      const recvNextCount = recvCurrentCount - incomingEntries.length + outgoingEntries.length;
      const propNextOverseas = propCurrentOverseas - outOverseas + inOverseas;
      const recvNextOverseas = recvCurrentOverseas - inOverseas + outOverseas;

      if (propNextCount > room.maxSquadSize) {
        throw new AppError(
          `Trade rejected: ${proposerFranchise.presetCode} would exceed max squad size (${propNextCount}/${room.maxSquadSize}).`,
          400,
          'MAX_SQUAD_EXCEEDED'
        );
      }
      if (recvNextCount > room.maxSquadSize) {
        throw new AppError(
          `Trade rejected: ${receiverFranchise.presetCode} would exceed max squad size (${recvNextCount}/${room.maxSquadSize}).`,
          400,
          'MAX_SQUAD_EXCEEDED'
        );
      }
      if (propNextOverseas > room.maxOverseas) {
        throw new AppError(
          `Trade rejected: ${proposerFranchise.presetCode} would exceed max overseas players (${propNextOverseas}/${room.maxOverseas}).`,
          400,
          'MAX_OVERSEAS_EXCEEDED'
        );
      }
      if (recvNextOverseas > room.maxOverseas) {
        throw new AppError(
          `Trade rejected: ${receiverFranchise.presetCode} would exceed max overseas players (${recvNextOverseas}/${room.maxOverseas}).`,
          400,
          'MAX_OVERSEAS_EXCEEDED'
        );
      }

      const expiresAt = new Date(now.getTime() + input.expiresInMinutes * 60 * 1000);
      const created = await tx.tradeProposal.create({
        data: {
          roomId: room.id,
          proposerFranchiseId: proposerFranchise.id,
          receiverFranchiseId: receiverFranchise.id,
          proposerParticipantId: caller.id,
          receiverParticipantId: receiverOwner.id,
          status: DbTradeStatus.PENDING,
          idempotencyKey: input.idempotencyKey,
          note: input.note?.trim() || null,
          expiresAt,
          items: {
            create: [
              ...outgoingEntries.map((p) => ({
                playerId: p.playerId,
                sourceType: p.sourceType,
                direction: DbTradeDirection.OUTGOING,
                fromFranchiseId: proposerFranchise.id,
                toFranchiseId: receiverFranchise.id,
                priceLakhs: p.priceLakhs
              })),
              ...incomingEntries.map((p) => ({
                playerId: p.playerId,
                sourceType: p.sourceType,
                direction: DbTradeDirection.INCOMING,
                fromFranchiseId: receiverFranchise.id,
                toFranchiseId: proposerFranchise.id,
                priceLakhs: p.priceLakhs
              }))
            ]
          }
        },
        include: TRADE_INCLUDE
      });

      const nextVersion = room.version + 1;
      await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });
      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.TRADE_PROPOSED, {
        tradeId: created.id,
        proposerFranchiseCode: proposerFranchise.presetCode,
        receiverFranchiseCode: receiverFranchise.presetCode,
        outgoingPlayerIds: input.outgoingPlayerIds,
        incomingPlayerIds: input.incomingPlayerIds
      });

      return { duplicate: false as const, tradeDto: mapTradeToDto(created, room) };
    });

    if (!txResult.duplicate) {
      emitToRoom(normalized, SOCKET_EVENTS.TRADE_PROPOSED, {
        roomCode: normalized,
        trade: txResult.tradeDto
      });
    }

    return txResult.tradeDto;
  }

  static async acceptTrade(
    code: string,
    guestSessionId: string,
    tradeId: string,
    acceptIdempotencyKey?: string
  ): Promise<TradeProposalDto> {
    const normalized = code.trim().toUpperCase();
    const now = new Date();
    await flushExpiredTradesByCode(normalized, now);

    const txResult = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      await expirePendingTradesInTx(tx, roomId, now);

      const room = await tx.room.findUniqueOrThrow({
        where: { id: roomId },
        include: {
          franchises: true,
          participants: true
        }
      });

      const activeParticipants = room.participants.filter((p) => !p.isRemoved && !p.leftAt);
      const caller = activeParticipants.find((p) => p.guestSessionId === guestSessionId);
      if (!caller) {
        throw new AppError('You are not an active member of this room.', 403, 'NOT_A_MEMBER');
      }
      if (caller.role === DbRoomRole.SPECTATOR) {
        throw new AppError('Spectators cannot respond to franchise trades.', 403, 'SPECTATOR_FORBIDDEN');
      }

      if (acceptIdempotencyKey) {
        const existingAccepted = await tx.tradeProposal.findUnique({
          where: { acceptIdempotencyKey },
          include: TRADE_INCLUDE
        });
        if (existingAccepted) {
          if (
            existingAccepted.id === tradeId &&
            existingAccepted.roomId === room.id &&
            existingAccepted.receiverFranchiseId === caller.franchiseId
          ) {
            return { duplicate: true as const, roomId: room.id, tradeDto: mapTradeToDto(existingAccepted, room) };
          }
          throw new AppError(
            'Accept idempotency key already used for a different trade.',
            409,
            'DUPLICATE_IDEMPOTENCY_KEY'
          );
        }
      }

      const trade = await tx.tradeProposal.findFirst({
        where: { id: tradeId, roomId: room.id },
        include: TRADE_INCLUDE
      });
      if (!trade) {
        throw new AppError('Trade proposal not found in this room.', 404, 'TRADE_NOT_FOUND');
      }

      // Host or proposer CANNOT approve on behalf of receiver
      if (!caller.franchiseId || caller.franchiseId !== trade.receiverFranchiseId) {
        throw new AppError(
          'Only the receiving franchise owner may accept this trade proposal.',
          403,
          'RECEIVER_OWNER_ONLY'
        );
      }

      if (trade.status !== DbTradeStatus.PENDING) {
        throw new AppError(
          `Trade cannot be accepted because its status is ${trade.status}.`,
          409,
          'INVALID_TRADE_STATE'
        );
      }

      if (!room.allowPlayerTrades) {
        throw new AppError(
          'Player trading is disabled by the room host.',
          403,
          'TRADES_DISABLED'
        );
      }
      assertLifecyclePermitsTrading(room.status);

      const proposerOwner = activeParticipants.find(
        (p) => p.franchiseId === trade.proposerFranchiseId && p.role !== DbRoomRole.SPECTATOR
      );
      if (!proposerOwner) {
        await tx.tradeProposal.update({
          where: { id: trade.id },
          data: {
            status: DbTradeStatus.CANCELLED,
            respondedAt: now,
            failureReason: 'Proposing franchise no longer has an active owner.'
          }
        });
        throw new AppError(
          'Proposing franchise no longer has an active owner in this room.',
          409,
          'PROPOSER_NO_ACTIVE_OWNER'
        );
      }

      await lockFranchisesInOrder(tx, trade.proposerFranchiseId, trade.receiverFranchiseId);

      const [propRoster, recvRoster] = await Promise.all([
        loadFranchiseRosterMap(tx, room.id, trade.proposerFranchiseId),
        loadFranchiseRosterMap(tx, room.id, trade.receiverFranchiseId)
      ]);

      const outgoingItems = trade.items.filter((i) => i.direction === DbTradeDirection.OUTGOING);
      const incomingItems = trade.items.filter((i) => i.direction === DbTradeDirection.INCOMING);

      // Re-verify live ownership before executing exchange
      const outMoves: OwnedSquadEntry[] = [];
      for (const item of outgoingItems) {
        const entry = propRoster.get(item.playerId);
        if (!entry) {
          throw new AppError(
            `${item.player.fullName} is no longer owned by the proposing franchise.`,
            409,
            'OWNERSHIP_CHANGED'
          );
        }
        outMoves.push(entry);
      }

      const inMoves: OwnedSquadEntry[] = [];
      for (const item of incomingItems) {
        const entry = recvRoster.get(item.playerId);
        if (!entry) {
          throw new AppError(
            `${item.player.fullName} is no longer owned by the receiving franchise.`,
            409,
            'OWNERSHIP_CHANGED'
          );
        }
        inMoves.push(entry);
      }

      // Re-verify post-trade squad and overseas limits
      const outOverseas = outMoves.filter((m) => m.isOverseas).length;
      const inOverseas = inMoves.filter((m) => m.isOverseas).length;
      const propNextCount = propRoster.size - outMoves.length + inMoves.length;
      const recvNextCount = recvRoster.size - inMoves.length + outMoves.length;
      const propNextOverseas =
        Array.from(propRoster.values()).filter((p) => p.isOverseas).length - outOverseas + inOverseas;
      const recvNextOverseas =
        Array.from(recvRoster.values()).filter((p) => p.isOverseas).length - inOverseas + outOverseas;

      if (propNextCount > room.maxSquadSize || recvNextCount > room.maxSquadSize) {
        throw new AppError('Trade would violate maximum squad size limit.', 400, 'MAX_SQUAD_EXCEEDED');
      }
      if (propNextOverseas > room.maxOverseas || recvNextOverseas > room.maxOverseas) {
        throw new AppError('Trade would violate maximum overseas limit.', 400, 'MAX_OVERSEAS_EXCEEDED');
      }

      // Execute atomic ownership transfer (player-for-player only; remainingPurseLakhs untouched)
      for (const m of outMoves) {
        if (m.sourceType === 'AUCTION') {
          await tx.purchase.update({
            where: { id: m.recordId },
            data: { franchiseId: trade.receiverFranchiseId }
          });
        } else {
          await tx.roomRetention.update({
            where: { id: m.recordId },
            data: { franchiseId: trade.receiverFranchiseId }
          });
        }
      }

      for (const m of inMoves) {
        if (m.sourceType === 'AUCTION') {
          await tx.purchase.update({
            where: { id: m.recordId },
            data: { franchiseId: trade.proposerFranchiseId }
          });
        } else {
          await tx.roomRetention.update({
            where: { id: m.recordId },
            data: { franchiseId: trade.proposerFranchiseId }
          });
        }
      }

      await Promise.all([
        recomputeFranchiseCounts(tx, room.id, trade.proposerFranchiseId),
        recomputeFranchiseCounts(tx, room.id, trade.receiverFranchiseId)
      ]);

      const executedTrade = await tx.tradeProposal.update({
        where: { id: trade.id },
        data: {
          status: DbTradeStatus.ACCEPTED,
          respondedAt: now,
          executedAt: now,
          ...(acceptIdempotencyKey ? { acceptIdempotencyKey } : {})
        },
        include: TRADE_INCLUDE
      });

      const nextVersion = room.version + 1;
      await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.TRADE_ACCEPTED, {
        tradeId: executedTrade.id,
        proposerFranchiseId: trade.proposerFranchiseId,
        receiverFranchiseId: trade.receiverFranchiseId,
        outgoingPlayerIds: outgoingItems.map((i) => i.playerId),
        incomingPlayerIds: incomingItems.map((i) => i.playerId),
        executedAt: now.toISOString()
      });

      return { duplicate: false as const, roomId: room.id, tradeDto: mapTradeToDto(executedTrade, room) };
    });

    if (!txResult.duplicate) {
      emitToRoom(normalized, SOCKET_EVENTS.TRADE_ACCEPTED, {
        roomCode: normalized,
        trade: txResult.tradeDto
      });
      await emitRoomAndAuctionState(normalized, txResult.roomId);
    }

    return txResult.tradeDto;
  }

  static async rejectTrade(
    code: string,
    guestSessionId: string,
    tradeId: string,
    reason?: string
  ): Promise<TradeProposalDto> {
    const normalized = code.trim().toUpperCase();
    const now = new Date();
    await flushExpiredTradesByCode(normalized, now);

    const dto = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      await expirePendingTradesInTx(tx, roomId, now);

      const room = await fetchRoomWithRelations(tx, roomId);
      const caller = room.participants.find(
        (p) => p.guestSessionId === guestSessionId && !p.isRemoved && !p.leftAt
      );
      if (!caller || caller.role === DbRoomRole.SPECTATOR || !caller.franchiseId) {
        throw new AppError('Only the receiving franchise owner may reject trades.', 403, 'RECEIVER_OWNER_ONLY');
      }

      const trade = await tx.tradeProposal.findFirst({
        where: { id: tradeId, roomId: room.id },
        include: TRADE_INCLUDE
      });
      if (!trade) {
        throw new AppError('Trade proposal not found.', 404, 'TRADE_NOT_FOUND');
      }
      if (caller.franchiseId !== trade.receiverFranchiseId) {
        throw new AppError('Only the receiving franchise owner may reject this trade.', 403, 'RECEIVER_OWNER_ONLY');
      }
      if (trade.status !== DbTradeStatus.PENDING) {
        throw new AppError(`Trade is already ${trade.status}.`, 409, 'INVALID_TRADE_STATE');
      }

      const updated = await tx.tradeProposal.update({
        where: { id: trade.id },
        data: {
          status: DbTradeStatus.REJECTED,
          respondedAt: now,
          failureReason: reason?.trim() || 'Declined by receiving franchise owner.'
        },
        include: TRADE_INCLUDE
      });

      const nextVersion = room.version + 1;
      await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });
      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.TRADE_REJECTED, {
        tradeId: updated.id,
        rejectedByFranchiseId: caller.franchiseId
      });

      return mapTradeToDto(updated, room);
    });

    emitToRoom(normalized, SOCKET_EVENTS.TRADE_REJECTED, { roomCode: normalized, trade: dto });
    return dto;
  }

  static async cancelTrade(
    code: string,
    guestSessionId: string,
    tradeId: string
  ): Promise<TradeProposalDto> {
    const normalized = code.trim().toUpperCase();
    const now = new Date();
    await flushExpiredTradesByCode(normalized, now);

    const dto = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      await expirePendingTradesInTx(tx, roomId, now);

      const room = await fetchRoomWithRelations(tx, roomId);
      const caller = room.participants.find(
        (p) => p.guestSessionId === guestSessionId && !p.isRemoved && !p.leftAt
      );
      if (!caller || caller.role === DbRoomRole.SPECTATOR || !caller.franchiseId) {
        throw new AppError('Only the proposing franchise owner may cancel trades.', 403, 'PROPOSER_OWNER_ONLY');
      }

      const trade = await tx.tradeProposal.findFirst({
        where: { id: tradeId, roomId: room.id },
        include: TRADE_INCLUDE
      });
      if (!trade) {
        throw new AppError('Trade proposal not found.', 404, 'TRADE_NOT_FOUND');
      }
      if (caller.franchiseId !== trade.proposerFranchiseId) {
        throw new AppError('Only the proposing franchise owner may cancel this trade.', 403, 'PROPOSER_OWNER_ONLY');
      }
      if (trade.status !== DbTradeStatus.PENDING) {
        throw new AppError(`Trade is already ${trade.status}.`, 409, 'INVALID_TRADE_STATE');
      }

      const updated = await tx.tradeProposal.update({
        where: { id: trade.id },
        data: {
          status: DbTradeStatus.CANCELLED,
          respondedAt: now,
          failureReason: 'Cancelled by proposing franchise owner.'
        },
        include: TRADE_INCLUDE
      });

      const nextVersion = room.version + 1;
      await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });
      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.TRADE_CANCELLED, {
        tradeId: updated.id,
        cancelledByFranchiseId: caller.franchiseId
      });

      return mapTradeToDto(updated, room);
    });

    emitToRoom(normalized, SOCKET_EVENTS.TRADE_CANCELLED, { roomCode: normalized, trade: dto });
    return dto;
  }
}
