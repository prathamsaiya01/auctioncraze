import { Request, Response, NextFunction } from 'express';
import {
  addRetentionSchema,
  autoFillPoolSchema,
  claimFranchiseSchema,
  configurePlayerPoolSchema,
  createRoomSchema,
  joinRoomSchema,
  kickParticipantSchema,
  roomCodeParamSchema,
  setReadySchema,
  transferHostSchema,
  updateAuctionConfigSchema,
  updateFranchiseNicknameSchema,
  updateLiveSettingsSchema,
  updateRoomSettingsSchema
} from '@auctioncraze/shared';
import { AuthenticatedRequest } from '../../middleware/auth';
import { RoomService } from './roomService';
import { RoomConfigService } from './roomConfigService';
import { z } from 'zod';

export class RoomController {
  static async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const payload = createRoomSchema.parse(req.body);
      const session = req.guestSession!;

      const room = await RoomService.createRoom({
        guestSessionId: session.id,
        defaultDisplayName: session.displayName,
        displayNameOverride: payload.displayName,
        roomName: payload.roomName,
        franchiseCode: payload.franchiseCode,
        visibility: payload.visibility,
        auctionMode: payload.auctionMode,
        settings: payload.settings
      });

      res.status(201).json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async listPublic(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rooms = await RoomService.listPublicRooms();
      res.json({ success: true, data: rooms });
    } catch (err) {
      next(err);
    }
  }

  static async getByCode(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const inviteToken =
        (req.query.invite as string | undefined) ||
        (req.headers['x-invite-token'] as string | undefined);

      const room = await RoomService.getRoomByCode(code, req.guestSession?.id, inviteToken);
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async join(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const payload = joinRoomSchema.parse(req.body);
      const session = req.guestSession!;

      const room = await RoomService.joinRoom(code, {
        guestSessionId: session.id,
        defaultDisplayName: session.displayName,
        displayNameOverride: payload.displayName,
        joinAs: payload.joinAs,
        franchiseCode: payload.franchiseCode,
        inviteToken: payload.inviteToken
      });

      res.status(200).json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async claimFranchise(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { franchiseCode } = claimFranchiseSchema.parse(req.body);

      const room = await RoomService.claimOrReleaseFranchise(
        code,
        req.guestSession!.id,
        franchiseCode
      );
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async setReady(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { isReady } = setReadySchema.parse(req.body);

      const room = await RoomService.setReady(code, req.guestSession!.id, isReady);
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async leave(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      await RoomService.leaveRoom(code, req.guestSession!.id);
      res.json({ success: true, message: 'Left room successfully.' });
    } catch (err) {
      next(err);
    }
  }

  static async kick(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { participantId } = kickParticipantSchema.parse(req.body);

      const room = await RoomService.kickParticipant(code, req.guestSession!.id, participantId);
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async transferHost(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { targetParticipantId } = transferHostSchema.parse(req.body);

      const room = await RoomService.transferHost(
        code,
        req.guestSession!.id,
        targetParticipantId
      );
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async updateSettings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const payload = updateRoomSettingsSchema.parse(req.body);

      const room = await RoomService.updateSettings(code, req.guestSession!.id, payload);
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async updateConfig(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const payload = updateAuctionConfigSchema.parse(req.body);
      const room = await RoomConfigService.updateConfig(code, req.guestSession!.id, payload);
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async configurePool(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { lots } = configurePlayerPoolSchema.parse(req.body);
      const room = await RoomConfigService.configurePlayerPool(code, req.guestSession!.id, lots);
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async autoFillPool(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const filters = autoFillPoolSchema.parse(req.body || {});
      const room = await RoomConfigService.autoFillPlayerPool(code, req.guestSession!.id, filters);
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async addRetention(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const payload = addRetentionSchema.parse(req.body);
      const room = await RoomConfigService.addRetention(code, req.guestSession!.id, payload);
      res.status(201).json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async removeRetention(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const retentionId = z.string().uuid('Invalid retention ID').parse(req.params.retentionId);
      const room = await RoomConfigService.removeRetention(code, req.guestSession!.id, retentionId);
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async finalizeConfig(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const room = await RoomConfigService.finalizeConfiguration(code, req.guestSession!.id);
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async updateLiveSettings(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const payload = updateLiveSettingsSchema.parse(req.body);
      const room = await RoomService.updateLiveSettings(code, req.guestSession!.id, payload);
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }

  static async updateFranchiseNickname(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { customSuffix } = updateFranchiseNicknameSchema.parse(req.body);
      const room = await RoomService.updateFranchiseNickname(
        code,
        req.guestSession!.id,
        customSuffix
      );
      res.json({ success: true, data: room });
    } catch (err) {
      next(err);
    }
  }
}
