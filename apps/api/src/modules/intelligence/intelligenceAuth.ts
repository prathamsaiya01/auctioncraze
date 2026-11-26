import { RoomRole as DbRoomRole, RoomStatus as DbRoomStatus, prisma } from '@auctioncraze/database';
import { roomCodeParamSchema } from '@auctioncraze/shared';
import { AppError } from '../../middleware/errorHandler';

export interface ActiveOwnerContext {
  room: {
    id: string;
    code: string;
    status: DbRoomStatus;
    hostParticipantId: string | null;
    minSquadSize: number;
    maxSquadSize: number;
    maxOverseas: number;
  };
  participant: {
    id: string;
    role: DbRoomRole;
    isHost: boolean;
    franchiseId: string;
    displayName: string;
  };
  ownedFranchise: {
    id: string;
    presetCode: string;
    name: string;
  };
}

/**
 * Verifies the caller has an active guest session that holds an active OWNER or HOST
 * seat with a claimed franchise in the specified room. Spectators and non-members
 * are strictly rejected with 403.
 */
export async function requireActiveFranchiseOwner(
  guestSessionId: string,
  rawRoomCode: string
): Promise<ActiveOwnerContext> {
  const { code } = roomCodeParamSchema.parse({ code: rawRoomCode });

  const room = await prisma.room.findUnique({
    where: { code },
    select: {
      id: true,
      code: true,
      status: true,
      hostParticipantId: true,
      minSquadSize: true,
      maxSquadSize: true,
      maxOverseas: true
    }
  });

  if (!room) {
    throw new AppError(`Room '${code}' not found.`, 404, 'ROOM_NOT_FOUND');
  }

  const participant = await prisma.roomParticipant.findFirst({
    where: {
      roomId: room.id,
      guestSessionId,
      isRemoved: false,
      leftAt: null
    },
    select: {
      id: true,
      role: true,
      franchiseId: true,
      displayName: true
    }
  });

  if (!participant) {
    throw new AppError(
      'Access denied: you are not an active member of this room.',
      403,
      'NOT_ROOM_MEMBER'
    );
  }

  if (participant.role === DbRoomRole.SPECTATOR || !participant.franchiseId) {
    throw new AppError(
      'Access denied: spectators cannot access private franchise intelligence.',
      403,
      'OWNER_ONLY'
    );
  }

  const ownedFranchise = await prisma.roomFranchise.findFirst({
    where: {
      id: participant.franchiseId,
      roomId: room.id
    },
    select: {
      id: true,
      presetCode: true,
      name: true
    }
  });

  if (!ownedFranchise) {
    throw new AppError(
      'Access denied: no claimed franchise found for your session in this room.',
      403,
      'FRANCHISE_OWNERSHIP_REQUIRED'
    );
  }

  const isHost =
    participant.id === room.hostParticipantId && participant.role === DbRoomRole.HOST;

  return {
    room,
    participant: {
      id: participant.id,
      role: participant.role,
      isHost,
      franchiseId: ownedFranchise.id,
      displayName: participant.displayName
    },
    ownedFranchise
  };
}

/**
 * Verifies the auction has reached COMPLETED status before serving post-auction reports.
 */
export function assertAuctionCompleted(ctx: ActiveOwnerContext): void {
  if (ctx.room.status !== DbRoomStatus.COMPLETED) {
    throw new AppError(
      `Post-auction team ratings are only available after the auction completes (current status: ${ctx.room.status}).`,
      409,
      'AUCTION_NOT_COMPLETED'
    );
  }
}

/**
 * Verifies the caller is the active Room Host AND the auction is COMPLETED.
 * Used for league-wide host-only team comparisons, rankings, and recalculation.
 */
export async function requireHostCompletedDashboard(
  guestSessionId: string,
  rawRoomCode: string
): Promise<ActiveOwnerContext> {
  const ctx = await requireActiveFranchiseOwner(guestSessionId, rawRoomCode);
  if (!ctx.participant.isHost) {
    throw new AppError(
      'Access denied: only the room host can access league-wide franchise comparisons.',
      403,
      'HOST_ONLY'
    );
  }
  assertAuctionCompleted(ctx);
  return ctx;
}

/**
 * Verifies both active owner membership in `rawRoomCode` AND exact ownership of
 * `requestedFranchiseIdOrCode` within that same room. Even the room host or rival
 * franchise owners cannot read another franchise's Team Strength or Playing XI.
 */
export async function requireExactFranchiseOwnership(
  guestSessionId: string,
  rawRoomCode: string,
  requestedFranchiseIdOrCode: string
): Promise<ActiveOwnerContext> {
  const ctx = await requireActiveFranchiseOwner(guestSessionId, rawRoomCode);
  const key = requestedFranchiseIdOrCode.trim();
  if (!key) {
    throw new AppError('Franchise identifier is required.', 400, 'INVALID_FRANCHISE_ID');
  }

  const targetFranchise = await prisma.roomFranchise.findFirst({
    where: {
      roomId: ctx.room.id,
      OR: [{ id: key }, { presetCode: key.toUpperCase() }]
    },
    select: {
      id: true,
      presetCode: true,
      name: true
    }
  });

  if (!targetFranchise) {
    throw new AppError(
      `Franchise '${key}' not found in room '${ctx.room.code}'.`,
      404,
      'FRANCHISE_NOT_FOUND'
    );
  }

  if (targetFranchise.id !== ctx.ownedFranchise.id) {
    throw new AppError(
      'Access denied: private squad strength and Playing XI analytics are restricted to the franchise owner.',
      403,
      'FRANCHISE_OWNERSHIP_REQUIRED'
    );
  }

  return ctx;
}
