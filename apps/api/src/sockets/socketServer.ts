import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { prisma, RoomStatus as DbRoomStatus } from '@auctioncraze/database';
import { placeBidSchema, SOCKET_EVENTS, SOCKET_ROOMS } from '@auctioncraze/shared';
import { config } from '../config/env';
import { verifyGuestToken } from '../middleware/auth';
import { redis } from '../lib/redis';
import { mapRoomToDetailDto } from '../modules/rooms/roomMapper';
import { ROOM_RELATIONS_INCLUDE } from '../modules/rooms/roomHelpers';
import { AUCTION_ROOM_INCLUDE, mapAuctionStateSnapshot } from '../modules/auction/auctionMapper';
import { AuctionService } from '../modules/auction/auctionService';

export interface AuthenticatedSocket extends Socket {
  guestSession?: {
    id: string;
    displayName: string;
  };
  joinedRooms?: Map<string, string>; // roomCode -> participantId
}

let ioInstance: Server | null = null;
let pubClient: Redis | null = null;
let subClient: Redis | null = null;

function onlineSocketsKey(roomCode: string, participantId: string): string {
  return `presence:${roomCode.toUpperCase()}:${participantId}`;
}

export function getIO(): Server | null {
  return ioInstance;
}

export function emitToRoom(roomCode: string, event: string, payload: unknown): void {
  if (!ioInstance) return;
  ioInstance.to(SOCKET_ROOMS.room(roomCode)).emit(event, payload);
}

export async function kickParticipantSockets(
  roomCode: string,
  participantId: string,
  payload: unknown
): Promise<void> {
  if (!ioInstance) return;
  const normalized = roomCode.toUpperCase();
  const participantChannel = SOCKET_ROOMS.participant(participantId);
  ioInstance.to(participantChannel).emit(SOCKET_EVENTS.PARTICIPANT_KICKED, payload);

  const sockets = await ioInstance.in(participantChannel).fetchSockets();
  for (const s of sockets) {
    s.leave(SOCKET_ROOMS.room(normalized));
    s.leave(participantChannel);
  }
  await redis.del(onlineSocketsKey(normalized, participantId)).catch(() => {});
}

async function fetchPublicRoomSnapshot(roomCode: string) {
  const room = await prisma.room.findUnique({
    where: { code: roomCode.toUpperCase() },
    include: ROOM_RELATIONS_INCLUDE
  });
  if (!room) return null;
  return mapRoomToDetailDto(room, false);
}

export async function setupSocketServer(httpServer: HttpServer): Promise<Server> {
  const io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true
    },
    transports: ['websocket', 'polling']
  });

  pubClient = new Redis(config.redisUrl);
  subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));

  io.use(async (socket: AuthenticatedSocket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ||
      (socket.handshake.headers?.authorization?.startsWith('Bearer ')
        ? socket.handshake.headers.authorization.slice(7).trim()
        : undefined);

    if (!token) {
      return next(new Error('AUTH_REQUIRED'));
    }

    try {
      const session = await verifyGuestToken(token);
      if (!session) {
        return next(new Error('INVALID_SESSION'));
      }
      socket.guestSession = {
        id: session.id,
        displayName: session.displayName
      };
      socket.joinedRooms = new Map();
      next();
    } catch {
      next(new Error('INVALID_SESSION'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    socket.on(SOCKET_EVENTS.ROOM_JOIN, async (payload: { roomCode?: string }) => {
      try {
        const roomCode = payload?.roomCode?.trim().toUpperCase();
        if (!roomCode) {
          socket.emit(SOCKET_EVENTS.ROOM_ERROR, {
            code: 'INVALID_ROOM_CODE',
            message: 'Room code is required.'
          });
          return;
        }

        const room = await prisma.room.findUnique({
          where: { code: roomCode },
          select: { id: true, code: true, inviteToken: true }
        });

        if (!room) {
          socket.emit(SOCKET_EVENTS.ROOM_ERROR, {
            code: 'ROOM_NOT_FOUND',
            message: `Room '${roomCode}' not found.`
          });
          return;
        }

        // Strictly verify active membership in PostgreSQL (never trust client participantId/role)
        const participant = await prisma.roomParticipant.findUnique({
          where: {
            roomId_guestSessionId: {
              roomId: room.id,
              guestSessionId: socket.guestSession!.id
            }
          }
        });

        if (!participant || participant.isRemoved || participant.leftAt) {
          socket.emit(SOCKET_EVENTS.ROOM_ERROR, {
            code: 'NOT_A_MEMBER',
            message: 'You must join this room before subscribing to real-time updates.'
          });
          return;
        }

        socket.join(SOCKET_ROOMS.room(room.code));
        socket.join(SOCKET_ROOMS.participant(participant.id));
        socket.joinedRooms?.set(room.code, participant.id);

        const presenceKey = onlineSocketsKey(room.code, participant.id);
        await redis.sadd(presenceKey, socket.id);
        await redis.expire(presenceKey, 86400);

        const wasDisconnected = !participant.isConnected;
        await prisma.roomParticipant.update({
          where: { id: participant.id },
          data: { isConnected: true, lastHeartbeatAt: new Date() }
        });

        // Fetch full authoritative snapshot for initial join & reconnection recovery
        const fullRoom = await prisma.room.findUnique({
          where: { id: room.id },
          include: ROOM_RELATIONS_INCLUDE
        });

        if (fullRoom) {
          const personalSnapshot = mapRoomToDetailDto(fullRoom, true);
          socket.emit(SOCKET_EVENTS.ROOM_JOINED, {
            roomCode: room.code,
            participantId: participant.id,
            serverTime: new Date().toISOString()
          });
          socket.emit(SOCKET_EVENTS.ROOM_STATE, personalSnapshot);

          if (fullRoom.status !== DbRoomStatus.LOBBY) {
            const auctionRoom = await prisma.room.findUnique({
              where: { id: room.id },
              include: AUCTION_ROOM_INCLUDE
            });
            if (auctionRoom) {
              socket.emit(SOCKET_EVENTS.AUCTION_STATE, mapAuctionStateSnapshot(auctionRoom));
            }
          }

          if (wasDisconnected) {
            const roomWideSnapshot = mapRoomToDetailDto(fullRoom, false);
            socket.to(SOCKET_ROOMS.room(room.code)).emit(SOCKET_EVENTS.ROOM_STATE, roomWideSnapshot);
          }
        }
      } catch (err) {
        console.error('[Socket] ROOM_JOIN error:', err);
        socket.emit(SOCKET_EVENTS.ROOM_ERROR, {
          code: 'JOIN_FAILED',
          message: 'Unable to subscribe to room updates.'
        });
      }
    });

    socket.on(
      SOCKET_EVENTS.BID_SUBMIT,
      async (payload: {
        roomCode?: string;
        lotId?: string;
        bidAmountLakhs?: number;
        idempotencyKey?: string;
      }) => {
        try {
          const roomCode = payload?.roomCode?.trim().toUpperCase();
          if (!roomCode || !socket.joinedRooms?.has(roomCode)) {
            socket.emit(SOCKET_EVENTS.BID_REJECTED, {
              code: 'NOT_A_MEMBER',
              message: 'Join the room before placing bids.'
            });
            return;
          }

          const parsed = placeBidSchema.parse({
            lotId: payload.lotId,
            bidAmountLakhs: payload.bidAmountLakhs,
            idempotencyKey: payload.idempotencyKey
          });

          await AuctionService.placeBid(roomCode, socket.guestSession!.id, parsed);
        } catch (err: any) {
          socket.emit(SOCKET_EVENTS.BID_REJECTED, {
            code: err?.code || 'BID_REJECTED',
            message: err?.message || 'Bid rejected by server.'
          });
        }
      }
    );

    socket.on(SOCKET_EVENTS.ROOM_LEAVE, async (payload: { roomCode?: string }) => {
      const roomCode = payload?.roomCode?.trim().toUpperCase();
      if (!roomCode) return;
      const participantId = socket.joinedRooms?.get(roomCode);
      socket.leave(SOCKET_ROOMS.room(roomCode));
      socket.joinedRooms?.delete(roomCode);

      if (participantId) {
        await handleSocketDetached(roomCode, participantId, socket.id);
      }
    });

    socket.on('disconnect', async () => {
      if (!socket.joinedRooms) return;
      for (const [roomCode, participantId] of socket.joinedRooms.entries()) {
        await handleSocketDetached(roomCode, participantId, socket.id);
      }
      socket.joinedRooms.clear();
    });
  });

  ioInstance = io;
  return io;
}

async function handleSocketDetached(
  roomCode: string,
  participantId: string,
  socketId: string
): Promise<void> {
  try {
    const key = onlineSocketsKey(roomCode, participantId);
    await redis.srem(key, socketId);
    const remaining = await redis.scard(key);
    if (remaining > 0) {
      return;
    }

    const participant = await prisma.roomParticipant.findUnique({
      where: { id: participantId },
      select: { id: true, isRemoved: true, leftAt: true, isConnected: true }
    });

    if (!participant || participant.isRemoved || participant.leftAt || !participant.isConnected) {
      return;
    }

    await prisma.roomParticipant.updateMany({
      where: { id: participantId, isRemoved: false, leftAt: null },
      data: { isConnected: false }
    });

    const snapshot = await fetchPublicRoomSnapshot(roomCode);
    if (snapshot) {
      emitToRoom(roomCode, SOCKET_EVENTS.ROOM_STATE, snapshot);
    }
  } catch (err) {
    console.error('[Socket] Disconnect presence cleanup error:', err);
  }
}

export async function closeSocketServer(): Promise<void> {
  if (ioInstance) {
    await ioInstance.close();
    ioInstance = null;
  }
  if (subClient) {
    await subClient.quit();
    subClient = null;
  }
  if (pubClient) {
    await pubClient.quit();
    pubClient = null;
  }
}
