import { NextFunction, Response } from 'express';
import {
  SeasonStatus,
  claimSeasonFranchiseSchema,
  createSeasonRoomSchema,
  createSeasonSchema,
  seasonPointAdjustmentSchema
} from '@auctioncraze/shared';
import { AuthenticatedRequest } from '../../middleware/auth';
import { SeasonService } from './seasonService';

export class SeasonController {
  static async list(_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = await SeasonService.listSeasons();
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async create(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = createSeasonSchema.parse(req.body);
      const data = await SeasonService.createSeason({
        guestSessionId: req.guestSession!.id,
        defaultDisplayName: req.guestSession!.displayName,
        displayNameOverride: body.displayName,
        name: body.name,
        year: body.year,
        description: body.description,
        startDate: body.startDate,
        endDate: body.endDate
      });
      res.status(201).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async getByCode(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = String(req.params.code || '').trim().toUpperCase();
      const monthKey = typeof req.query.month === 'string' ? req.query.month : undefined;
      const roomCode = typeof req.query.roomCode === 'string' ? req.query.roomCode : undefined;
      const data = await SeasonService.getSeasonByCode(code, req.guestSession?.id, {
        monthKey,
        roomCode
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async claimFranchise(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = String(req.params.code || '').trim().toUpperCase();
      const body = claimSeasonFranchiseSchema.parse(req.body);
      const data = await SeasonService.claimSeasonFranchise(code, {
        guestSessionId: req.guestSession!.id,
        defaultDisplayName: req.guestSession!.displayName,
        displayNameOverride: body.displayName,
        franchiseCode: body.franchiseCode,
        customSuffix: body.customSuffix,
        recoveryCode: body.recoveryCode
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async issueRecovery(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = String(req.params.code || '').trim().toUpperCase();
      const entryId = String(req.params.entryId || '');
      const data = await SeasonService.issueRecoveryCode(code, req.guestSession!.id, entryId);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async releaseFranchise(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = String(req.params.code || '').trim().toUpperCase();
      const entryId = String(req.params.entryId || '');
      const data = await SeasonService.releaseSeasonFranchise(code, req.guestSession!.id, entryId);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async createRoom(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = String(req.params.code || '').trim().toUpperCase();
      const body = createSeasonRoomSchema.parse(req.body);
      const data = await SeasonService.createSeasonRoom(
        code,
        req.guestSession!.id,
        req.guestSession!.displayName,
        {
          roomName: body.roomName,
          franchiseCode: body.franchiseCode,
          visibility: body.visibility,
          auctionMode: body.auctionMode,
          seasonMonthLabel: body.seasonMonthLabel,
          seasonMonthKey: body.seasonMonthKey,
          settings: body.settings
        }
      );
      res.status(201).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async adjustPoints(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = String(req.params.code || '').trim().toUpperCase();
      const body = seasonPointAdjustmentSchema.parse(req.body);
      const data = await SeasonService.adjustPoints(code, {
        hostSessionId: req.guestSession!.id,
        hostDisplayName: req.guestSession!.displayName,
        entryId: body.entryId,
        pointsDelta: body.pointsDelta,
        reason: body.reason,
        roomId: body.roomId,
        monthKey: body.monthKey
      });
      res.status(201).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async archive(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = String(req.params.code || '').trim().toUpperCase();
      const data = await SeasonService.setSeasonStatus(code, req.guestSession!.id, SeasonStatus.ARCHIVED);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async reopen(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const code = String(req.params.code || '').trim().toUpperCase();
      const data = await SeasonService.setSeasonStatus(code, req.guestSession!.id, SeasonStatus.ACTIVE);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
}
