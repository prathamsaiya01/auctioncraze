import crypto from 'crypto';
import { Prisma, RoomRole as DbRoomRole, prisma } from '@auctioncraze/database';
import {
  ChatMessageDto,
  RoomChatStateDto,
  RoomRole,
  SOCKET_EVENTS,
  formatFranchiseDisplayName
} from '@auctioncraze/shared';
import { AppError } from '../../middleware/errorHandler';
import { redis } from '../../lib/redis';
import { emitToRoom } from '../../sockets/socketServer';

function sanitizeChatMessage(raw: string): string {
  // Strip unsafe control characters and collapse newlines/tabs into clean single spaces
  const stripped = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped;
}

function mapChatDto(
  row: {
    id: string;
    roomId: string;
    participantId: string | null;
    guestSessionId: string;
    senderName: string;
    senderRole: string;
    franchiseCode: string | null;
    franchiseDisplayName: string | null;
    message: string;
    createdAt: Date;
  },
  roomCode?: string
): ChatMessageDto {
  return {
    id: row.id,
    roomId: row.roomId,
    roomCode,
    participantId: row.participantId,
    guestSessionId: row.guestSessionId,
    senderName: row.senderName,
    senderRole: row.senderRole as RoomRole,
    franchiseCode: row.franchiseCode,
    franchiseDisplayName: row.franchiseDisplayName,
    message: row.message,
    createdAt: row.createdAt.toISOString()
  };
}

export class ChatService {
  static async getRoomChatState(code: string, guestSessionId: string): Promise<RoomChatStateDto> {
    const normalized = code.trim().toUpperCase();
    const room = await prisma.room.findUnique({
      where: { code: normalized },
      select: {
        id: true,
        code: true,
        chatEnabled: true,
        spectatorChatEnabled: true,
        participants: {
          where: { guestSessionId, isRemoved: false, leftAt: null },
          take: 1,
          select: { id: true, isChatMuted: true }
        }
      }
    });

    if (!room) {
      throw new AppError(`Room '${normalized}' not found.`, 404, 'ROOM_NOT_FOUND');
    }
    const participant = room.participants[0];
    if (!participant) {
      throw new AppError('Only active room members may access room chat.', 403, 'ROOM_MEMBERSHIP_REQUIRED');
    }

    const recentRows = await prisma.chatMessage.findMany({
      where: { roomId: room.id, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    return {
      roomCode: room.code,
      chatEnabled: room.chatEnabled,
      spectatorChatEnabled: room.spectatorChatEnabled,
      isMuted: participant.isChatMuted,
      messages: recentRows.reverse().map((r) => mapChatDto(r, room.code))
    };
  }

  static async sendMessage(input: {
    roomCode: string;
    guestSessionId: string;
    rawMessage: string;
    idempotencyKey?: string;
  }): Promise<ChatMessageDto> {
    const normalized = input.roomCode.trim().toUpperCase();
    const cleanText = sanitizeChatMessage(input.rawMessage);
    if (!cleanText || cleanText.length < 1) {
      throw new AppError('Chat message cannot be empty.', 400, 'EMPTY_CHAT_MESSAGE');
    }
    if (cleanText.length > 360) {
      throw new AppError('Chat message cannot exceed 360 characters.', 400, 'CHAT_TOO_LONG');
    }

    // Idempotent duplicate check first (before rate limit)
    if (input.idempotencyKey) {
      const existing = await prisma.chatMessage.findUnique({
        where: { idempotencyKey: input.idempotencyKey }
      });
      if (existing) {
        return mapChatDto(existing, normalized);
      }
    }

    const room = await prisma.room.findUnique({
      where: { code: normalized },
      include: {
        franchises: true,
        participants: {
          where: { guestSessionId: input.guestSessionId, isRemoved: false, leftAt: null },
          take: 1
        }
      }
    });

    if (!room) {
      throw new AppError(`Room '${normalized}' not found.`, 404, 'ROOM_NOT_FOUND');
    }
    const participant = room.participants[0];
    if (!participant) {
      throw new AppError('You are not an active participant in this room.', 403, 'ROOM_MEMBERSHIP_REQUIRED');
    }
    if (!room.chatEnabled) {
      throw new AppError('Room chat is currently disabled by the host.', 403, 'CHAT_DISABLED');
    }
    if (participant.role === DbRoomRole.SPECTATOR && !room.spectatorChatEnabled) {
      throw new AppError('Spectator chat is disabled in this room.', 403, 'SPECTATOR_CHAT_DISABLED');
    }
    if (participant.isChatMuted) {
      throw new AppError('You have been muted by the room host.', 403, 'PARTICIPANT_MUTED');
    }

    // Per-session per-room sliding fixed window rate limit (max 8 msgs / 10s)
    const rateKey = `chat:rl:${normalized}:${input.guestSessionId}`;
    const count = await redis.incr(rateKey);
    if (count === 1) {
      await redis.expire(rateKey, 10);
    }
    if (count > 8) {
      throw new AppError('Slow down! Chat rate limit exceeded.', 429, 'CHAT_RATE_LIMITED');
    }

    // Basic anti-spam: disallow identical back-to-back text within 3 seconds
    const msgHash = crypto.createHash('sha1').update(cleanText.toLowerCase()).digest('hex');
    const spamKey = `chat:dup:${normalized}:${input.guestSessionId}`;
    const prevHash = await redis.get(spamKey);
    if (prevHash === msgHash) {
      throw new AppError('Duplicate spam message blocked. Wait a moment before repeating.', 429, 'CHAT_SPAM_BLOCKED');
    }
    await redis.set(spamKey, msgHash, 'EX', 3);

    const ownedFranchise = participant.franchiseId
      ? room.franchises.find((f) => f.id === participant.franchiseId)
      : null;

    const franchiseCode = ownedFranchise?.presetCode || null;
    const franchiseDisplayName = ownedFranchise
      ? formatFranchiseDisplayName(
          ownedFranchise.name,
          ownedFranchise.presetCode,
          ownedFranchise.customSuffix,
          room.allowCustomTeamName
        )
      : participant.role === DbRoomRole.SPECTATOR
      ? 'Spectator'
      : null;

    let created;
    try {
      created = await prisma.chatMessage.create({
        data: {
          roomId: room.id,
          guestSessionId: input.guestSessionId,
          participantId: participant.id,
          senderName: participant.displayName,
          senderRole: participant.role,
          franchiseCode,
          franchiseDisplayName,
          message: cleanText,
          idempotencyKey: input.idempotencyKey || null
        }
      });
    } catch (err) {
      if (
        input.idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const dup = await prisma.chatMessage.findUnique({
          where: { idempotencyKey: input.idempotencyKey }
        });
        if (dup) return mapChatDto(dup, normalized);
      }
      throw err;
    }

    const dto = mapChatDto(created, normalized);
    emitToRoom(normalized, SOCKET_EVENTS.CHAT_MESSAGE, dto);
    return dto;
  }

  static async updateChatSettings(
    code: string,
    hostSessionId: string,
    settings: { chatEnabled?: boolean; spectatorChatEnabled?: boolean }
  ): Promise<{ roomCode: string; chatEnabled: boolean; spectatorChatEnabled: boolean }> {
    const normalized = code.trim().toUpperCase();
    const room = await prisma.room.findUnique({
      where: { code: normalized },
      include: { participants: true }
    });
    if (!room) throw new AppError(`Room '${normalized}' not found.`, 404, 'ROOM_NOT_FOUND');

    const host = room.participants.find(
      (p) => p.id === room.hostParticipantId && !p.isRemoved && !p.leftAt
    );
    if (!host || host.guestSessionId !== hostSessionId) {
      throw new AppError('Only the room host can update chat moderation settings.', 403, 'HOST_ONLY');
    }

    const updated = await prisma.room.update({
      where: { id: room.id },
      data: {
        ...(settings.chatEnabled !== undefined ? { chatEnabled: settings.chatEnabled } : {}),
        ...(settings.spectatorChatEnabled !== undefined
          ? { spectatorChatEnabled: settings.spectatorChatEnabled }
          : {})
      }
    });

    const payload = {
      roomCode: normalized,
      chatEnabled: updated.chatEnabled,
      spectatorChatEnabled: updated.spectatorChatEnabled
    };
    emitToRoom(normalized, SOCKET_EVENTS.CHAT_SETTINGS_UPDATED, payload);
    return payload;
  }

  static async deleteMessage(
    code: string,
    hostSessionId: string,
    messageId: string
  ): Promise<{ roomCode: string; messageId: string }> {
    const normalized = code.trim().toUpperCase();
    const room = await prisma.room.findUnique({
      where: { code: normalized },
      include: { participants: true }
    });
    if (!room) throw new AppError(`Room '${normalized}' not found.`, 404, 'ROOM_NOT_FOUND');

    const host = room.participants.find(
      (p) => p.id === room.hostParticipantId && !p.isRemoved && !p.leftAt
    );
    if (!host || host.guestSessionId !== hostSessionId) {
      throw new AppError('Only the room host can moderate and delete chat messages.', 403, 'HOST_ONLY');
    }

    const msg = await prisma.chatMessage.findFirst({
      where: { id: messageId, roomId: room.id }
    });
    if (!msg) {
      throw new AppError('Message not found in this room.', 404, 'CHAT_MESSAGE_NOT_FOUND');
    }

    await prisma.chatMessage.update({
      where: { id: msg.id },
      data: {
        isDeleted: true,
        deletedBySessionId: hostSessionId,
        deletedAt: new Date()
      }
    });

    const payload = { roomCode: normalized, messageId: msg.id };
    emitToRoom(normalized, SOCKET_EVENTS.CHAT_MESSAGE_DELETED, payload);
    return payload;
  }

  static async muteParticipant(
    code: string,
    hostSessionId: string,
    targetParticipantId: string,
    muted: boolean
  ): Promise<{ roomCode: string; participantId: string; isChatMuted: boolean }> {
    const normalized = code.trim().toUpperCase();
    const room = await prisma.room.findUnique({
      where: { code: normalized },
      include: { participants: true }
    });
    if (!room) throw new AppError(`Room '${normalized}' not found.`, 404, 'ROOM_NOT_FOUND');

    const host = room.participants.find(
      (p) => p.id === room.hostParticipantId && !p.isRemoved && !p.leftAt
    );
    if (!host || host.guestSessionId !== hostSessionId) {
      throw new AppError('Only the room host can mute or unmute participants.', 403, 'HOST_ONLY');
    }

    const target = room.participants.find(
      (p) => p.id === targetParticipantId && !p.isRemoved && !p.leftAt
    );
    if (!target) {
      throw new AppError('Participant not found in this room.', 404, 'PARTICIPANT_NOT_FOUND');
    }
    if (target.id === host.id) {
      throw new AppError('The room host cannot mute themselves.', 400, 'CANNOT_MUTE_HOST');
    }

    await prisma.roomParticipant.update({
      where: { id: target.id },
      data: { isChatMuted: muted }
    });

    const payload = {
      roomCode: normalized,
      participantId: target.id,
      guestSessionId: target.guestSessionId,
      isChatMuted: muted
    };
    emitToRoom(normalized, SOCKET_EVENTS.CHAT_PARTICIPANT_MUTED, payload);
    return payload;
  }
}
