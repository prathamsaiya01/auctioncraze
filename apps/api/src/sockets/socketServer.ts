import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { prisma, RoomStatus as DbRoomStatus } from '@auctioncraze/database';
import { chatSendSchema, placeBidSchema, SOCKET_EVENTS, SOCKET_ROOMS } from '@auctioncraze/shared';
import { config } from '../config/env';
import { verifyGuestToken } from '../middleware/auth';
import { redis } from '../lib/redis';
import { mapRoomToDetailDto } from '../modules/rooms/roomMapper';
import { ROOM_RELATIONS_INCLUDE } from '../modules/rooms/roomHelpers';
import { AUCTION_ROOM_INCLUDE, mapAuctionStateSnapshot } from '../modules/auction/auctionMapper';
import { AuctionService } from '../modules/auction/auctionService';
import { ChatService } from '../modules/chat/chatService';

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
    socket.on(
      SOCKET_EVENTS.ROOM_JOIN,
      async (payload: { roomCode?: string }, ack?: (res: Record<string, unknown>) => void) => {
        try {
          const roomCode = payload?.roomCode?.trim().toUpperCase();
          if (!roomCode) {
            const errPayload = {
              ok: false,
              code: 'INVALID_ROOM_CODE',
              message: 'Room code is required.'
            };
            socket.emit(SOCKET_EVENTS.ROOM_ERROR, errPayload);
            ack?.(errPayload);
            return;
          }

          const room = await prisma.room.findUnique({
            where: { code: roomCode },
            select: { id: true, code: true, inviteToken: true }
          });

          if (!room) {
            const errPayload = {
              ok: false,
              code: 'ROOM_NOT_FOUND',
              message: `Room '${roomCode}' not found.`
            };
            socket.emit(SOCKET_EVENTS.ROOM_ERROR, errPayload);
            ack?.(errPayload);
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
            const errPayload = {
              ok: false,
              code: 'NOT_A_MEMBER',
              message: 'You must join this room before subscribing to real-time updates.'
            };
            socket.emit(SOCKET_EVENTS.ROOM_ERROR, errPayload);
            ack?.(errPayload);
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

          const serverTimeIso = new Date().toISOString();
          const serverTimeMs = Date.now();
          if (fullRoom) {
            socket.emit(SOCKET_EVENTS.ROOM_JOINED, {
              roomCode: room.code,
              participantId: participant.id,
              version: fullRoom.version,
              serverTime: serverTimeIso
            });

            if (fullRoom.status === DbRoomStatus.LOBBY) {
              socket.emit(SOCKET_EVENTS.ROOM_STATE, mapRoomToDetailDto(fullRoom, true));
              if (wasDisconnected) {
                socket.to(SOCKET_ROOMS.room(room.code)).emit(SOCKET_EVENTS.ROOM_STATE, mapRoomToDetailDto(fullRoom, false));
              }
            } else {
              const auctionRoom = await prisma.room.findUnique({
                where: { id: room.id },
                include: AUCTION_ROOM_INCLUDE
              });
              if (auctionRoom) {
                socket.emit(SOCKET_EVENTS.AUCTION_STATE, mapAuctionStateSnapshot(auctionRoom));
                if (wasDisconnected) {
                  socket.to(SOCKET_ROOMS.room(room.code)).emit(SOCKET_EVENTS.PARTICIPANT_JOINED, {
                    roomCode: room.code,
                    participant: {
                      id: participant.id,
                      displayName: participant.displayName,
                      role: participant.role
                    }
                  });
                }
              }
            }
          }

          ack?.({
            ok: true,
            roomCode: room.code,
            participantId: participant.id,
            version: fullRoom?.version ?? 1,
            serverTimeMs
          });
        } catch (err) {
          console.error('[Socket] ROOM_JOIN error:', err);
          const errPayload = {
            ok: false,
            code: 'JOIN_FAILED',
            message: 'Unable to subscribe to room updates.'
          };
          socket.emit(SOCKET_EVENTS.ROOM_ERROR, errPayload);
          ack?.(errPayload);
        }
      }
    );

    socket.on(
      SOCKET_EVENTS.SYNC_REQUEST,
      async (payload: { roomCode?: string }, ack?: (res: Record<string, unknown>) => void) => {
        try {
          const roomCode = payload?.roomCode?.trim().toUpperCase();
          if (!roomCode) {
            ack?.({ ok: false, code: 'INVALID_ROOM_CODE', message: 'Room code is required.' });
            return;
          }
          const fullRoom = await prisma.room.findUnique({
            where: { code: roomCode },
            include: ROOM_RELATIONS_INCLUDE
          });
          if (!fullRoom) {
            ack?.({ ok: false, code: 'ROOM_NOT_FOUND', message: 'Room not found.' });
            return;
          }
          const participant = fullRoom.participants.find(
            (p) => p.guestSessionId === socket.guestSession!.id && !p.isRemoved && !p.leftAt
          );
          if (!participant) {
            ack?.({ ok: false, code: 'NOT_A_MEMBER', message: 'Active membership required.' });
            return;
          }

          socket.join(SOCKET_ROOMS.room(fullRoom.code));
          socket.join(SOCKET_ROOMS.participant(participant.id));
          socket.joinedRooms?.set(fullRoom.code, participant.id);

          const presenceKey = onlineSocketsKey(fullRoom.code, participant.id);
          await redis.sadd(presenceKey, socket.id);
          await redis.expire(presenceKey, 86400);
          if (!participant.isConnected) {
            await prisma.roomParticipant.update({
              where: { id: participant.id },
              data: { isConnected: true, lastHeartbeatAt: new Date() }
            });
          } else {
            await prisma.roomParticipant.update({
              where: { id: participant.id },
              data: { lastHeartbeatAt: new Date() }
            });
          }

          if (fullRoom.status === DbRoomStatus.LOBBY) {
            socket.emit(SOCKET_EVENTS.ROOM_STATE, mapRoomToDetailDto(fullRoom, true));
          } else {
            const auctionRoom = await prisma.room.findUnique({
              where: { id: fullRoom.id },
              include: AUCTION_ROOM_INCLUDE
            });
            if (auctionRoom) {
              socket.emit(SOCKET_EVENTS.AUCTION_STATE, mapAuctionStateSnapshot(auctionRoom));
            }
          }

          const ackPayload = {
            ok: true,
            roomCode: fullRoom.code,
            version: fullRoom.version,
            serverTimeMs: Date.now()
          };
          socket.emit(SOCKET_EVENTS.SYNC_ACK, ackPayload);
          ack?.(ackPayload);
        } catch (err) {
          console.error('[Socket] SYNC_REQUEST error:', err);
          ack?.({ ok: false, code: 'SYNC_FAILED', message: 'State resynchronization failed.' });
        }
      }
    );

    socket.on(
      SOCKET_EVENTS.BID_SUBMIT,
      async (
        payload: {
          roomCode?: string;
          lotId?: string;
          bidAmountLakhs?: number;
          idempotencyKey?: string;
        },
        ack?: (res: Record<string, unknown>) => void
      ) => {
        try {
          const roomCode = payload?.roomCode?.trim().toUpperCase();
          if (!roomCode || !socket.joinedRooms?.has(roomCode)) {
            const errPayload = {
              ok: false,
              code: 'NOT_A_MEMBER',
              message: 'Join the room before placing bids.'
            };
            socket.emit(SOCKET_EVENTS.BID_REJECTED, errPayload);
            ack?.(errPayload);
            return;
          }

          const parsed = placeBidSchema.parse({
            lotId: payload.lotId,
            bidAmountLakhs: payload.bidAmountLakhs,
            idempotencyKey: payload.idempotencyKey
          });

          const bidResult = await AuctionService.placeBid(roomCode, socket.guestSession!.id, parsed);
          ack?.({
            ok: true,
            ...bidResult,
            serverTimeMs: Date.now()
          });
        } catch (err: any) {
          const errPayload = {
            ok: false,
            code: err?.code || 'BID_REJECTED',
            message: err?.message || 'Bid rejected by server.'
          };
          socket.emit(SOCKET_EVENTS.BID_REJECTED, errPayload);
          ack?.(errPayload);
        }
      }
    );

    socket.on(
      SOCKET_EVENTS.CHAT_SEND,
      async (
        payload: { roomCode?: string; message?: string; idempotencyKey?: string },
        ack?: (res: Record<string, unknown>) => void
      ) => {
        try {
          const roomCode = payload?.roomCode?.trim().toUpperCase();
          if (!roomCode || !socket.joinedRooms?.has(roomCode)) {
            ack?.({
              ok: false,
              code: 'NOT_A_MEMBER',
              message: 'Join the room before sending chat messages.'
            });
            return;
          }
          const parsed = chatSendSchema.parse({
            message: payload?.message,
            idempotencyKey: payload?.idempotencyKey
          });
          const msgDto = await ChatService.sendMessage({
            roomCode,
            guestSessionId: socket.guestSession!.id,
            rawMessage: parsed.message,
            idempotencyKey: parsed.idempotencyKey
          });
          ack?.({ ok: true, data: msgDto });
        } catch (err: any) {
          ack?.({
            ok: false,
            code: err?.code || 'CHAT_REJECTED',
            message: err?.message || 'Unable to send chat message.'
          });
        }
      }
    );

    socket.on(
      SOCKET_EVENTS.SEASON_JOIN,
      async (payload: { seasonCode?: string }, ack?: (res: Record<string, unknown>) => void) => {
        try {
          const seasonCode = payload?.seasonCode?.trim().toUpperCase();
          if (!seasonCode) {
            ack?.({ ok: false, code: 'INVALID_SEASON_CODE', message: 'Season code is required.' });
            return;
          }
          const exists = await prisma.season.findUnique({
            where: { code: seasonCode },
            select: { id: true }
          });
          if (!exists) {
            ack?.({ ok: false, code: 'SEASON_NOT_FOUND', message: 'Season not found.' });
            return;
          }
          await socket.join(SOCKET_ROOMS.season(seasonCode));
          ack?.({ ok: true, seasonCode });
        } catch (err: any) {
          ack?.({ ok: false, code: 'SEASON_JOIN_FAILED', message: err?.message || 'Unable to subscribe to season.' });
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
      select: {
        id: true,
        displayName: true,
        isRemoved: true,
        leftAt: true,
        isConnected: true,
        room: { select: { status: true } }
      }
    });

    if (!participant || participant.isRemoved || participant.leftAt || !participant.isConnected) {
      return;
    }

    await prisma.roomParticipant.updateMany({
      where: { id: participantId, isRemoved: false, leftAt: null },
      data: { isConnected: false }
    });

    if (participant.room?.status === DbRoomStatus.LOBBY) {
      const snapshot = await fetchPublicRoomSnapshot(roomCode);
      if (snapshot) {
        emitToRoom(roomCode, SOCKET_EVENTS.ROOM_STATE, snapshot);
      }
    } else {
      emitToRoom(roomCode, SOCKET_EVENTS.PARTICIPANT_LEFT, {
        roomCode,
        participantId: participant.id,
        displayName: participant.displayName,
        reason: 'DISCONNECTED'
      });
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
