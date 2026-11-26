import { Prisma, prisma } from '@auctioncraze/database';
import { AppError } from '../../middleware/errorHandler';

export const ROOM_RELATIONS_INCLUDE = {
  season: { select: { code: true, name: true } },
  franchises: { orderBy: { presetCode: 'asc' } },
  participants: { orderBy: { joinedAt: 'asc' } },
  lots: {
    include: { player: true },
    orderBy: { sequenceOrder: 'asc' }
  },
  retentions: {
    include: { player: true },
    orderBy: { slotNumber: 'asc' }
  }
} satisfies Prisma.RoomInclude;

export async function lockRoomByCode(
  tx: Prisma.TransactionClient,
  code: string
): Promise<{ id: string }> {
  const normalized = code.trim().toUpperCase();
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "Room" WHERE "code" = ${normalized} FOR UPDATE
  `;
  if (!rows || rows.length === 0) {
    throw new AppError(`Room '${normalized}' not found.`, 404, 'ROOM_NOT_FOUND');
  }
  return rows[0];
}

export async function appendRoomEvent(
  tx: Prisma.TransactionClient,
  roomId: string,
  roomVersion: number,
  eventType: string,
  payload: Record<string, any>
): Promise<void> {
  const latest = await tx.auctionEvent.aggregate({
    where: { roomId },
    _max: { sequenceNumber: true }
  });
  const nextSeq = (latest._max.sequenceNumber || 0) + 1;
  await tx.auctionEvent.create({
    data: {
      roomId,
      sequenceNumber: nextSeq,
      roomVersion,
      eventType,
      payload
    }
  });
}

export async function fetchRoomWithRelations(tx: Prisma.TransactionClient, roomId: string) {
  return tx.room.findUniqueOrThrow({
    where: { id: roomId },
    include: ROOM_RELATIONS_INCLUDE
  });
}

export async function fetchRoomByCodeWithRelations(code: string) {
  return prisma.room.findUnique({
    where: { code: code.trim().toUpperCase() },
    include: ROOM_RELATIONS_INCLUDE
  });
}
