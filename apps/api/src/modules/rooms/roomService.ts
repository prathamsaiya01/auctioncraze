import crypto from 'crypto';
import {
  AuctionMode as DbAuctionMode,
  LedgerEntryType,
  RoomRole as DbRoomRole,
  RoomStatus as DbRoomStatus,
  RoomVisibility as DbRoomVisibility,
  prisma
} from '@auctioncraze/database';
import {
  AUCTION_MODE_PRESETS,
  AuctionMode,
  IPL_FRANCHISE_PRESETS,
  PublicRoomSummaryDto,
  RoomDetailDto,
  RoomRole,
  RoomVisibility,
  SOCKET_EVENTS
} from '@auctioncraze/shared';
import { AppError } from '../../middleware/errorHandler';
import { emitToRoom, kickParticipantSockets } from '../../sockets/socketServer';
import { generateRoomCode } from './roomCode';
import { mapRoomToDetailDto } from './roomMapper';
import {
  ROOM_RELATIONS_INCLUDE,
  appendRoomEvent,
  fetchRoomWithRelations,
  lockRoomByCode
} from './roomHelpers';

interface CreateRoomInput {
  guestSessionId: string;
  defaultDisplayName: string;
  displayNameOverride?: string;
  roomName: string;
  franchiseCode: string;
  visibility: RoomVisibility;
  auctionMode?: AuctionMode;
  settings: {
    initialPurseLakhs: number;
    minSquadSize: number;
    maxSquadSize: number;
    maxOverseas: number;
    maxSpectators: number;
    countdownSeconds: number;
    bidExtensionSeconds: number;
    extensionThresholdSeconds: number;
    allowHostSkip: boolean;
  };
}

interface JoinRoomInput {
  guestSessionId: string;
  defaultDisplayName: string;
  displayNameOverride?: string;
  joinAs: RoomRole.OWNER | RoomRole.SPECTATOR;
  franchiseCode?: string;
  inviteToken?: string;
}

function timingSafeInviteMatch(expected: string | null | undefined, provided: string | undefined): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.trim(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class RoomService {
  private static async allocateUniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = generateRoomCode();
      const existing = await prisma.room.findUnique({ where: { code }, select: { id: true } });
      if (!existing) return code;
    }
    throw new AppError('Unable to allocate unique room code. Please retry.', 503, 'CODE_GENERATION_FAILED');
  }

  static async createRoom(input: CreateRoomInput): Promise<RoomDetailDto> {
    const selectedPreset = IPL_FRANCHISE_PRESETS.find((f) => f.code === input.franchiseCode);
    if (!selectedPreset) {
      throw new AppError('Invalid franchise selection.', 400, 'INVALID_FRANCHISE');
    }

    const hostDisplayName = input.displayNameOverride?.trim() || input.defaultDisplayName;
    const roomCode = await RoomService.allocateUniqueCode();
    const inviteToken =
      input.visibility === RoomVisibility.PRIVATE ? crypto.randomBytes(12).toString('hex') : null;

    const createdRoom = await prisma.$transaction(async (tx) => {
      if (input.displayNameOverride && input.displayNameOverride.trim() !== input.defaultDisplayName) {
        await tx.guestSession.update({
          where: { id: input.guestSessionId },
          data: { displayName: hostDisplayName, lastSeenAt: new Date() }
        });
      }

      const mode = input.auctionMode || AuctionMode.MEGA;
      const modePreset = AUCTION_MODE_PRESETS[mode];

      const room = await tx.room.create({
        data: {
          code: roomCode,
          name: input.roomName,
          visibility: input.visibility as DbRoomVisibility,
          inviteToken,
          status: DbRoomStatus.LOBBY,
          auctionMode: mode as DbAuctionMode,
          initialPurseLakhs: input.settings.initialPurseLakhs,
          minSquadSize: input.settings.minSquadSize,
          maxSquadSize: input.settings.maxSquadSize,
          maxOverseas: input.settings.maxOverseas,
          maxSpectators: input.settings.maxSpectators,
          minOwnersRequired: modePreset.minOwnersRequired,
          defaultBasePriceLakhs: modePreset.defaultBasePriceLakhs,
          bidIncrementTiersJson: modePreset.bidIncrementTiers as any,
          countdownSeconds: input.settings.countdownSeconds,
          allowLateBidExtension: modePreset.allowLateBidExtension,
          bidExtensionSeconds: input.settings.bidExtensionSeconds,
          extensionThresholdSeconds: input.settings.extensionThresholdSeconds,
          allowHostSkip: input.settings.allowHostSkip,
          allowTeamPurseAdjustments: modePreset.allowTeamPurseAdjustments,
          retentionEnabled: modePreset.retentionEnabled,
          maxRetentionsPerFranchise: modePreset.maxRetentionsPerFranchise,
          maxOverseasRetentions: modePreset.maxOverseasRetentions
        }
      });

      const createdFranchises = [];
      for (const preset of IPL_FRANCHISE_PRESETS) {
        const franchise = await tx.roomFranchise.create({
          data: {
            roomId: room.id,
            presetCode: preset.code,
            name: preset.name,
            abbreviation: preset.shortName,
            primaryColor: preset.primaryColor,
            secondaryColor: preset.secondaryColor,
            initialPurseLakhs: input.settings.initialPurseLakhs,
            remainingPurseLakhs: input.settings.initialPurseLakhs
          }
        });

        await tx.purseLedger.create({
          data: {
            franchiseId: franchise.id,
            entryType: LedgerEntryType.INITIAL,
            amountLakhs: input.settings.initialPurseLakhs,
            balanceAfterLakhs: input.settings.initialPurseLakhs,
            description: `Initial purse allocation for ${preset.shortName}`
          }
        });

        createdFranchises.push(franchise);
      }

      const hostFranchise = createdFranchises.find((f) => f.presetCode === selectedPreset.code)!;

      const hostParticipant = await tx.roomParticipant.create({
        data: {
          roomId: room.id,
          guestSessionId: input.guestSessionId,
          displayName: hostDisplayName,
          role: DbRoomRole.HOST,
          franchiseId: hostFranchise.id,
          isReady: true,
          isConnected: true
        }
      });

      await tx.room.update({
        where: { id: room.id },
        data: { hostParticipantId: hostParticipant.id }
      });

      await appendRoomEvent(tx, room.id, 1, 'ROOM_CREATED', {
        roomCode: room.code,
        hostParticipantId: hostParticipant.id,
        hostDisplayName,
        hostFranchiseCode: hostFranchise.presetCode
      });

      return fetchRoomWithRelations(tx, room.id);
    });

    return mapRoomToDetailDto(createdRoom, true);
  }

  static async listPublicRooms(): Promise<PublicRoomSummaryDto[]> {
    const rooms = await prisma.room.findMany({
      where: {
        visibility: DbRoomVisibility.PUBLIC,
        status: { in: [DbRoomStatus.LOBBY, DbRoomStatus.LIVE, DbRoomStatus.PAUSED] }
      },
      include: {
        franchises: { select: { id: true } },
        participants: {
          where: { isRemoved: false, leftAt: null },
          select: { id: true, role: true, displayName: true, franchiseId: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 30
    });

    return rooms.map((r) => {
      const host = r.participants.find((p) => p.id === r.hostParticipantId);
      const occupiedFranchises = r.participants.filter((p) => p.franchiseId !== null).length;
      const spectatorCount = r.participants.filter((p) => p.role === DbRoomRole.SPECTATOR).length;

      return {
        id: r.id,
        code: r.code,
        name: r.name,
        status: r.status as any,
        auctionMode: r.auctionMode as AuctionMode,
        hostDisplayName: host?.displayName || 'Host',
        occupiedFranchises,
        totalFranchises: r.franchises.length,
        spectatorCount,
        maxSpectators: r.maxSpectators,
        initialPurseLakhs: r.initialPurseLakhs,
        countdownSeconds: r.countdownSeconds,
        createdAt: r.createdAt.toISOString()
      };
    });
  }

  static async getRoomByCode(
    code: string,
    requesterGuestSessionId?: string,
    inviteToken?: string
  ): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();
    const room = await prisma.room.findUnique({
      where: { code: normalized },
      include: ROOM_RELATIONS_INCLUDE
    });

    if (!room) {
      throw new AppError(`Room '${normalized}' not found.`, 404, 'ROOM_NOT_FOUND');
    }

    const activeMembership = requesterGuestSessionId
      ? room.participants.find(
          (p) => p.guestSessionId === requesterGuestSessionId && !p.isRemoved && !p.leftAt
        )
      : undefined;

    if (room.visibility === DbRoomVisibility.PRIVATE) {
      const hasValidInvite = timingSafeInviteMatch(room.inviteToken, inviteToken);
      if (!activeMembership && !hasValidInvite) {
        throw new AppError(
          'This is a private room. A valid invite link or invite token is required.',
          403,
          'PRIVATE_ROOM_INVITE_REQUIRED'
        );
      }
    }

    return mapRoomToDetailDto(room, !!activeMembership);
  }

  static async joinRoom(code: string, input: JoinRoomInput): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();
    const displayName = input.displayNameOverride?.trim() || input.defaultDisplayName;

    const result = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);

      if (room.status === DbRoomStatus.COMPLETED || room.status === DbRoomStatus.CANCELLED) {
        throw new AppError(
          `Room '${normalized}' is ${room.status.toLowerCase()} and no longer accepting participants.`,
          409,
          'ROOM_CLOSED'
        );
      }

      if (room.visibility === DbRoomVisibility.PRIVATE) {
        if (!input.inviteToken) {
          throw new AppError(
            'Invite token is required to join a private room.',
            403,
            'INVITE_TOKEN_REQUIRED'
          );
        }
        if (!timingSafeInviteMatch(room.inviteToken, input.inviteToken)) {
          throw new AppError('Invalid private room invite token.', 403, 'INVALID_INVITE_TOKEN');
        }
      }

      const existingMembership = await tx.roomParticipant.findUnique({
        where: {
          roomId_guestSessionId: {
            roomId: room.id,
            guestSessionId: input.guestSessionId
          }
        }
      });

      if (existingMembership?.isRemoved) {
        throw new AppError(
          'You were removed from this room by the host and cannot rejoin.',
          403,
          'PARTICIPANT_KICKED'
        );
      }

      if (existingMembership && !existingMembership.leftAt) {
        throw new AppError('You have already joined this room.', 409, 'ALREADY_JOINED');
      }

      const activeParticipants = room.participants.filter((p) => !p.isRemoved && !p.leftAt);
      let targetFranchiseId: string | null = null;
      let targetFranchiseCode: string | null = null;

      if (input.joinAs === RoomRole.OWNER) {
        if (room.status !== DbRoomStatus.LOBBY) {
          throw new AppError(
            'Auction has already started. You can only join this room as a spectator.',
            409,
            'AUCTION_ALREADY_STARTED'
          );
        }

        const claimedIds = new Set(
          activeParticipants.map((p) => p.franchiseId).filter((id): id is string => !!id)
        );
        if (claimedIds.size >= room.franchises.length) {
          throw new AppError(
            'All franchises in this room are already claimed. Join as a spectator instead.',
            409,
            'ROOM_FRANCHISES_FULL'
          );
        }

        const franchise = room.franchises.find((f) => f.presetCode === input.franchiseCode);
        if (!franchise) {
          throw new AppError('Selected franchise does not exist in this room.', 400, 'INVALID_FRANCHISE');
        }
        if (claimedIds.has(franchise.id)) {
          throw new AppError(
            `${franchise.name} (${franchise.abbreviation}) is already claimed by another player.`,
            409,
            'FRANCHISE_ALREADY_CLAIMED'
          );
        }

        targetFranchiseId = franchise.id;
        targetFranchiseCode = franchise.presetCode;
      } else {
        const spectatorCount = activeParticipants.filter((p) => p.role === DbRoomRole.SPECTATOR).length;
        if (spectatorCount >= room.maxSpectators) {
          throw new AppError(
            'This room has reached its maximum spectator capacity.',
            409,
            'ROOM_FULL'
          );
        }
      }

      if (input.displayNameOverride && input.displayNameOverride.trim() !== input.defaultDisplayName) {
        await tx.guestSession.update({
          where: { id: input.guestSessionId },
          data: { displayName, lastSeenAt: new Date() }
        });
      }

      const participant = existingMembership
        ? await tx.roomParticipant.update({
            where: { id: existingMembership.id },
            data: {
              displayName,
              role: input.joinAs as DbRoomRole,
              franchiseId: targetFranchiseId,
              isReady: false,
              isConnected: true,
              leftAt: null,
              joinedAt: new Date(),
              lastHeartbeatAt: new Date()
            }
          })
        : await tx.roomParticipant.create({
            data: {
              roomId: room.id,
              guestSessionId: input.guestSessionId,
              displayName,
              role: input.joinAs as DbRoomRole,
              franchiseId: targetFranchiseId,
              isReady: false,
              isConnected: true
            }
          });

      const updatedVersion = room.version + 1;
      await tx.room.update({
        where: { id: room.id },
        data: { version: updatedVersion }
      });

      await appendRoomEvent(tx, room.id, updatedVersion, SOCKET_EVENTS.PARTICIPANT_JOINED, {
        participantId: participant.id,
        displayName: participant.displayName,
        role: participant.role,
        franchiseCode: targetFranchiseCode
      });

      if (targetFranchiseId) {
        await appendRoomEvent(tx, room.id, updatedVersion, SOCKET_EVENTS.FRANCHISE_CLAIMED, {
          participantId: participant.id,
          displayName: participant.displayName,
          franchiseId: targetFranchiseId,
          franchiseCode: targetFranchiseCode
        });
      }

      const fullRoom = await fetchRoomWithRelations(tx, room.id);
      return {
        fullRoom,
        joinedParticipant: {
          id: participant.id,
          guestSessionId: participant.guestSessionId,
          displayName: participant.displayName,
          role: participant.role as RoomRole,
          franchiseId: participant.franchiseId,
          franchiseCode: targetFranchiseCode,
          isReady: participant.isReady,
          isConnected: participant.isConnected,
          joinedAt: participant.joinedAt.toISOString()
        }
      };
    });

    const publicSnapshot = mapRoomToDetailDto(result.fullRoom, false);
    emitToRoom(normalized, SOCKET_EVENTS.PARTICIPANT_JOINED, {
      roomCode: normalized,
      participant: result.joinedParticipant
    });
    if (result.joinedParticipant.franchiseId) {
      emitToRoom(normalized, SOCKET_EVENTS.FRANCHISE_CLAIMED, {
        roomCode: normalized,
        participantId: result.joinedParticipant.id,
        displayName: result.joinedParticipant.displayName,
        franchiseId: result.joinedParticipant.franchiseId,
        franchiseCode: result.joinedParticipant.franchiseCode
      });
    }
    emitToRoom(normalized, SOCKET_EVENTS.AUCTION_READINESS_CHANGED, {
      roomCode: normalized,
      readiness: publicSnapshot.readiness
    });
    emitToRoom(normalized, SOCKET_EVENTS.ROOM_STATE, publicSnapshot);

    return mapRoomToDetailDto(result.fullRoom, true);
  }

  static async claimOrReleaseFranchise(
    code: string,
    guestSessionId: string,
    franchiseCode: string | null
  ): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();

    const result = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);

      if (room.status !== DbRoomStatus.LOBBY) {
        throw new AppError('Franchises can only be changed while in the lobby.', 409, 'ROOM_NOT_IN_LOBBY');
      }

      const participant = room.participants.find(
        (p) => p.guestSessionId === guestSessionId && !p.isRemoved && !p.leftAt
      );
      if (!participant) {
        throw new AppError('You are not an active member of this room.', 403, 'NOT_A_MEMBER');
      }

      const previousFranchise = participant.franchiseId
        ? room.franchises.find((f) => f.id === participant.franchiseId) || null
        : null;

      if (franchiseCode === null) {
        if (participant.role === DbRoomRole.HOST) {
          throw new AppError(
            'The host must own a franchise. Transfer host before switching to spectator.',
            400,
            'HOST_MUST_OWN_FRANCHISE'
          );
        }

        if (!participant.franchiseId) {
          return {
            fullRoom: room,
            released: null,
            claimed: null,
            participantId: participant.id,
            displayName: participant.displayName
          };
        }

        await tx.roomParticipant.update({
          where: { id: participant.id },
          data: {
            franchiseId: null,
            role: DbRoomRole.SPECTATOR,
            isReady: false
          }
        });

        const nextVersion = room.version + 1;
        await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });
        await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.FRANCHISE_RELEASED, {
          participantId: participant.id,
          franchiseId: previousFranchise!.id,
          franchiseCode: previousFranchise!.presetCode
        });

        const updated = await fetchRoomWithRelations(tx, room.id);
        return {
          fullRoom: updated,
          released: {
            franchiseId: previousFranchise!.id,
            franchiseCode: previousFranchise!.presetCode
          },
          claimed: null,
          participantId: participant.id,
          displayName: participant.displayName
        };
      }

      if (participant.role === DbRoomRole.SPECTATOR) {
        throw new AppError(
          'Spectators cannot claim franchises. Leave and rejoin as an owner to claim a team.',
          403,
          'SPECTATOR_CANNOT_CLAIM'
        );
      }

      const targetFranchise = room.franchises.find((f) => f.presetCode === franchiseCode);
      if (!targetFranchise) {
        throw new AppError('Selected franchise does not exist in this room.', 400, 'INVALID_FRANCHISE');
      }

      if (participant.franchiseId === targetFranchise.id) {
        return {
          fullRoom: room,
          released: null,
          claimed: null,
          participantId: participant.id,
          displayName: participant.displayName
        };
      }

      const activeOwner = room.participants.find(
        (p) => p.franchiseId === targetFranchise.id && !p.isRemoved && !p.leftAt
      );
      if (activeOwner) {
        throw new AppError(
          `${targetFranchise.name} (${targetFranchise.abbreviation}) is already claimed by ${activeOwner.displayName}.`,
          409,
          'FRANCHISE_ALREADY_CLAIMED'
        );
      }

      await tx.roomParticipant.update({
        where: { id: participant.id },
        data: {
          franchiseId: targetFranchise.id,
          role: participant.role === DbRoomRole.HOST ? DbRoomRole.HOST : DbRoomRole.OWNER
        }
      });

      const nextVersion = room.version + 1;
      await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });

      if (previousFranchise) {
        await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.FRANCHISE_RELEASED, {
          participantId: participant.id,
          franchiseId: previousFranchise.id,
          franchiseCode: previousFranchise.presetCode
        });
      }

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.FRANCHISE_CLAIMED, {
        participantId: participant.id,
        displayName: participant.displayName,
        franchiseId: targetFranchise.id,
        franchiseCode: targetFranchise.presetCode
      });

      const updated = await fetchRoomWithRelations(tx, room.id);
      return {
        fullRoom: updated,
        released: previousFranchise
          ? { franchiseId: previousFranchise.id, franchiseCode: previousFranchise.presetCode }
          : null,
        claimed: { franchiseId: targetFranchise.id, franchiseCode: targetFranchise.presetCode },
        participantId: participant.id,
        displayName: participant.displayName
      };
    });

    if (result.released) {
      emitToRoom(normalized, SOCKET_EVENTS.FRANCHISE_RELEASED, {
        roomCode: normalized,
        participantId: result.participantId,
        ...result.released
      });
    }
    if (result.claimed) {
      emitToRoom(normalized, SOCKET_EVENTS.FRANCHISE_CLAIMED, {
        roomCode: normalized,
        participantId: result.participantId,
        displayName: result.displayName,
        ...result.claimed
      });
    }
    if (result.released || result.claimed) {
      emitToRoom(normalized, SOCKET_EVENTS.ROOM_STATE, mapRoomToDetailDto(result.fullRoom, false));
    }

    return mapRoomToDetailDto(result.fullRoom, true);
  }

  static async setReady(code: string, guestSessionId: string, isReady: boolean): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();

    const result = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);

      if (room.status !== DbRoomStatus.LOBBY) {
        throw new AppError('Ready status can only be toggled in the lobby.', 409, 'ROOM_NOT_IN_LOBBY');
      }

      const participant = room.participants.find(
        (p) => p.guestSessionId === guestSessionId && !p.isRemoved && !p.leftAt
      );
      if (!participant) {
        throw new AppError('You are not an active member of this room.', 403, 'NOT_A_MEMBER');
      }

      if (participant.role === DbRoomRole.SPECTATOR) {
        throw new AppError('Spectators cannot mark ready.', 403, 'SPECTATOR_NO_READY');
      }

      await tx.roomParticipant.update({
        where: { id: participant.id },
        data: { isReady }
      });

      const nextVersion = room.version + 1;
      await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });

      const eventName = isReady ? SOCKET_EVENTS.PARTICIPANT_READY : SOCKET_EVENTS.PARTICIPANT_NOT_READY;
      await appendRoomEvent(tx, room.id, nextVersion, eventName, {
        participantId: participant.id,
        displayName: participant.displayName,
        isReady
      });

      const updated = await fetchRoomWithRelations(tx, room.id);
      return { fullRoom: updated, participantId: participant.id, displayName: participant.displayName, eventName };
    });

    emitToRoom(normalized, result.eventName, {
      roomCode: normalized,
      participantId: result.participantId,
      displayName: result.displayName,
      isReady
    });
    emitToRoom(normalized, SOCKET_EVENTS.ROOM_STATE, mapRoomToDetailDto(result.fullRoom, false));

    return mapRoomToDetailDto(result.fullRoom, true);
  }

  static async leaveRoom(code: string, guestSessionId: string): Promise<void> {
    const normalized = code.trim().toUpperCase();

    const result = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);

      const participant = room.participants.find(
        (p) => p.guestSessionId === guestSessionId && !p.isRemoved && !p.leftAt
      );
      if (!participant) {
        throw new AppError('You are not an active member of this room.', 403, 'NOT_A_MEMBER');
      }

      const releasedFranchise = participant.franchiseId
        ? room.franchises.find((f) => f.id === participant.franchiseId) || null
        : null;

      await tx.roomParticipant.update({
        where: { id: participant.id },
        data: {
          franchiseId: null,
          isReady: false,
          isConnected: false,
          leftAt: new Date()
        }
      });

      const nextVersion = room.version + 1;
      let newHost: { id: string; displayName: string } | null = null;
      let roomCancelled = false;

      if (participant.role === DbRoomRole.HOST) {
        const nextOwner = room.participants.find(
          (p) =>
            p.id !== participant.id &&
            !p.isRemoved &&
            !p.leftAt &&
            p.role === DbRoomRole.OWNER &&
            p.franchiseId !== null
        );

        if (nextOwner) {
          await tx.roomParticipant.update({
            where: { id: nextOwner.id },
            data: { role: DbRoomRole.HOST, isReady: true }
          });
          await tx.room.update({
            where: { id: room.id },
            data: { hostParticipantId: nextOwner.id, version: nextVersion }
          });
          newHost = { id: nextOwner.id, displayName: nextOwner.displayName };

          await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.HOST_CHANGED, {
            previousHostParticipantId: participant.id,
            newHostParticipantId: nextOwner.id,
            newHostDisplayName: nextOwner.displayName,
            reason: 'HOST_LEFT'
          });
        } else {
          roomCancelled = true;
          await tx.room.update({
            where: { id: room.id },
            data: {
              status: DbRoomStatus.CANCELLED,
              hostParticipantId: null,
              endedAt: new Date(),
              version: nextVersion
            }
          });
        }
      } else {
        await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });
      }

      if (releasedFranchise) {
        await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.FRANCHISE_RELEASED, {
          participantId: participant.id,
          franchiseId: releasedFranchise.id,
          franchiseCode: releasedFranchise.presetCode
        });
      }

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.PARTICIPANT_LEFT, {
        participantId: participant.id,
        displayName: participant.displayName
      });

      const updated = await fetchRoomWithRelations(tx, room.id);
      return {
        fullRoom: updated,
        participantId: participant.id,
        displayName: participant.displayName,
        releasedFranchise,
        newHost,
        roomCancelled
      };
    });

    if (result.releasedFranchise) {
      emitToRoom(normalized, SOCKET_EVENTS.FRANCHISE_RELEASED, {
        roomCode: normalized,
        participantId: result.participantId,
        franchiseId: result.releasedFranchise.id,
        franchiseCode: result.releasedFranchise.presetCode
      });
    }
    if (result.newHost) {
      emitToRoom(normalized, SOCKET_EVENTS.HOST_CHANGED, {
        roomCode: normalized,
        newHostParticipantId: result.newHost.id,
        newHostDisplayName: result.newHost.displayName
      });
    }
    emitToRoom(normalized, SOCKET_EVENTS.PARTICIPANT_LEFT, {
      roomCode: normalized,
      participantId: result.participantId,
      displayName: result.displayName
    });
    const leaveSnapshot = mapRoomToDetailDto(result.fullRoom, false);
    emitToRoom(normalized, SOCKET_EVENTS.AUCTION_READINESS_CHANGED, {
      roomCode: normalized,
      readiness: leaveSnapshot.readiness
    });
    emitToRoom(normalized, SOCKET_EVENTS.ROOM_STATE, leaveSnapshot);
  }

  static async kickParticipant(
    code: string,
    hostGuestSessionId: string,
    targetParticipantId: string
  ): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();

    const result = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);

      const caller = room.participants.find(
        (p) => p.guestSessionId === hostGuestSessionId && !p.isRemoved && !p.leftAt
      );
      if (!caller || caller.id !== room.hostParticipantId || caller.role !== DbRoomRole.HOST) {
        throw new AppError('Only the room host can kick participants.', 403, 'HOST_ONLY');
      }

      if (caller.id === targetParticipantId) {
        throw new AppError('Host cannot kick themselves.', 400, 'CANNOT_KICK_SELF');
      }

      const target = room.participants.find(
        (p) => p.id === targetParticipantId && !p.isRemoved && !p.leftAt
      );
      if (!target) {
        throw new AppError('Target participant is not active in this room.', 404, 'PARTICIPANT_NOT_FOUND');
      }

      const releasedFranchise = target.franchiseId
        ? room.franchises.find((f) => f.id === target.franchiseId) || null
        : null;

      await tx.roomParticipant.update({
        where: { id: target.id },
        data: {
          isRemoved: true,
          isConnected: false,
          isReady: false,
          franchiseId: null,
          leftAt: new Date()
        }
      });

      const nextVersion = room.version + 1;
      await tx.room.update({ where: { id: room.id }, data: { version: nextVersion } });

      if (releasedFranchise) {
        await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.FRANCHISE_RELEASED, {
          participantId: target.id,
          franchiseId: releasedFranchise.id,
          franchiseCode: releasedFranchise.presetCode
        });
      }

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.PARTICIPANT_KICKED, {
        participantId: target.id,
        displayName: target.displayName,
        kickedByParticipantId: caller.id
      });

      const updated = await fetchRoomWithRelations(tx, room.id);
      return { fullRoom: updated, target, releasedFranchise };
    });

    const kickedPayload = {
      roomCode: normalized,
      participantId: result.target.id,
      displayName: result.target.displayName
    };
    await kickParticipantSockets(normalized, result.target.id, kickedPayload);

    if (result.releasedFranchise) {
      emitToRoom(normalized, SOCKET_EVENTS.FRANCHISE_RELEASED, {
        roomCode: normalized,
        participantId: result.target.id,
        franchiseId: result.releasedFranchise.id,
        franchiseCode: result.releasedFranchise.presetCode
      });
    }
    emitToRoom(normalized, SOCKET_EVENTS.PARTICIPANT_KICKED, kickedPayload);
    const kickSnapshot = mapRoomToDetailDto(result.fullRoom, false);
    emitToRoom(normalized, SOCKET_EVENTS.AUCTION_READINESS_CHANGED, {
      roomCode: normalized,
      readiness: kickSnapshot.readiness
    });
    emitToRoom(normalized, SOCKET_EVENTS.ROOM_STATE, kickSnapshot);

    return mapRoomToDetailDto(result.fullRoom, true);
  }

  static async transferHost(
    code: string,
    hostGuestSessionId: string,
    targetParticipantId: string
  ): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();

    const result = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);

      const caller = room.participants.find(
        (p) => p.guestSessionId === hostGuestSessionId && !p.isRemoved && !p.leftAt
      );
      if (!caller || caller.id !== room.hostParticipantId || caller.role !== DbRoomRole.HOST) {
        throw new AppError('Only the room host can transfer host privileges.', 403, 'HOST_ONLY');
      }

      if (caller.id === targetParticipantId) {
        throw new AppError('You are already the host of this room.', 400, 'ALREADY_HOST');
      }

      const target = room.participants.find(
        (p) => p.id === targetParticipantId && !p.isRemoved && !p.leftAt
      );
      if (!target) {
        throw new AppError('Target participant is not active in this room.', 404, 'PARTICIPANT_NOT_FOUND');
      }

      if (target.role !== DbRoomRole.OWNER || !target.franchiseId) {
        throw new AppError(
          'Host privileges can only be transferred to an active franchise owner.',
          400,
          'TARGET_MUST_BE_OWNER'
        );
      }

      await tx.roomParticipant.update({
        where: { id: caller.id },
        data: { role: DbRoomRole.OWNER }
      });

      await tx.roomParticipant.update({
        where: { id: target.id },
        data: { role: DbRoomRole.HOST, isReady: true }
      });

      const nextVersion = room.version + 1;
      await tx.room.update({
        where: { id: room.id },
        data: { hostParticipantId: target.id, version: nextVersion }
      });

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.HOST_CHANGED, {
        previousHostParticipantId: caller.id,
        newHostParticipantId: target.id,
        newHostDisplayName: target.displayName,
        reason: 'HOST_TRANSFERRED'
      });

      const updated = await fetchRoomWithRelations(tx, room.id);
      return { fullRoom: updated, caller, target };
    });

    emitToRoom(normalized, SOCKET_EVENTS.HOST_CHANGED, {
      roomCode: normalized,
      previousHostParticipantId: result.caller.id,
      newHostParticipantId: result.target.id,
      newHostDisplayName: result.target.displayName
    });
    const transferSnapshot = mapRoomToDetailDto(result.fullRoom, false);
    emitToRoom(normalized, SOCKET_EVENTS.AUCTION_READINESS_CHANGED, {
      roomCode: normalized,
      readiness: transferSnapshot.readiness
    });
    emitToRoom(normalized, SOCKET_EVENTS.ROOM_STATE, transferSnapshot);

    return mapRoomToDetailDto(result.fullRoom, true);
  }

  static async updateSettings(
    code: string,
    hostGuestSessionId: string,
    payload: {
      visibility?: RoomVisibility;
      settings: CreateRoomInput['settings'];
    }
  ): Promise<RoomDetailDto> {
    const normalized = code.trim().toUpperCase();

    const updatedRoom = await prisma.$transaction(async (tx) => {
      const { id: roomId } = await lockRoomByCode(tx, normalized);
      const room = await fetchRoomWithRelations(tx, roomId);

      const caller = room.participants.find(
        (p) => p.guestSessionId === hostGuestSessionId && !p.isRemoved && !p.leftAt
      );
      if (!caller || caller.id !== room.hostParticipantId || caller.role !== DbRoomRole.HOST) {
        throw new AppError('Only the room host can update lobby settings.', 403, 'HOST_ONLY');
      }

      if (room.status !== DbRoomStatus.LOBBY) {
        throw new AppError('Room settings can only be changed in the lobby.', 409, 'ROOM_NOT_IN_LOBBY');
      }

      if (room.configFinalized) {
        throw new AppError(
          'Auction configuration is finalized and locked.',
          409,
          'CONFIG_FINALIZED'
        );
      }

      const nextVisibility = (payload.visibility ?? room.visibility) as DbRoomVisibility;
      const nextInviteToken =
        nextVisibility === DbRoomVisibility.PRIVATE
          ? room.inviteToken || crypto.randomBytes(12).toString('hex')
          : null;

      const nextVersion = room.version + 1;
      await tx.room.update({
        where: { id: room.id },
        data: {
          visibility: nextVisibility,
          inviteToken: nextInviteToken,
          initialPurseLakhs: payload.settings.initialPurseLakhs,
          minSquadSize: payload.settings.minSquadSize,
          maxSquadSize: payload.settings.maxSquadSize,
          maxOverseas: payload.settings.maxOverseas,
          maxSpectators: payload.settings.maxSpectators,
          countdownSeconds: payload.settings.countdownSeconds,
          bidExtensionSeconds: payload.settings.bidExtensionSeconds,
          extensionThresholdSeconds: payload.settings.extensionThresholdSeconds,
          allowHostSkip: payload.settings.allowHostSkip,
          version: nextVersion
        }
      });

      if (payload.settings.initialPurseLakhs !== room.initialPurseLakhs) {
        await tx.roomFranchise.updateMany({
          where: { roomId: room.id },
          data: {
            initialPurseLakhs: payload.settings.initialPurseLakhs,
            remainingPurseLakhs: payload.settings.initialPurseLakhs
          }
        });
      }

      await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.ROOM_SETTINGS_UPDATED, {
        visibility: nextVisibility,
        settings: payload.settings
      });

      return fetchRoomWithRelations(tx, room.id);
    });

    emitToRoom(normalized, SOCKET_EVENTS.ROOM_SETTINGS_UPDATED, {
      roomCode: normalized,
      settings: mapRoomToDetailDto(updatedRoom, false).settings
    });
    emitToRoom(normalized, SOCKET_EVENTS.ROOM_STATE, mapRoomToDetailDto(updatedRoom, false));

    return mapRoomToDetailDto(updatedRoom, true);
  }
}
