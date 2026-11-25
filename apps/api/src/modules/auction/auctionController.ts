import { Response, NextFunction } from 'express';
import {
  extendTimerSchema,
  placeBidSchema,
  resolveLotSchema,
  roomCodeParamSchema
} from '@auctioncraze/shared';
import { AuthenticatedRequest } from '../../middleware/auth';
import { AuctionService } from './auctionService';

export class AuctionController {
  static async getState(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const state = await AuctionService.getAuctionState(code, req.guestSession!.id);
      res.json({ success: true, data: state });
    } catch (err) {
      next(err);
    }
  }

  static async start(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const state = await AuctionService.startAuction(code, req.guestSession!.id);
      res.json({ success: true, data: state });
    } catch (err) {
      next(err);
    }
  }

  static async placeBid(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const payload = placeBidSchema.parse(req.body);
      const result = await AuctionService.placeBid(code, req.guestSession!.id, payload);
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  }

  static async pause(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const state = await AuctionService.pauseAuction(code, req.guestSession!.id);
      res.json({ success: true, data: state });
    } catch (err) {
      next(err);
    }
  }

  static async resume(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const state = await AuctionService.resumeAuction(code, req.guestSession!.id);
      res.json({ success: true, data: state });
    } catch (err) {
      next(err);
    }
  }

  static async extendTimer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { extraSeconds } = extendTimerSchema.parse(req.body || {});
      const state = await AuctionService.extendTimer(code, req.guestSession!.id, extraSeconds);
      res.json({ success: true, data: state });
    } catch (err) {
      next(err);
    }
  }

  static async markSold(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { lotId } = resolveLotSchema.parse(req.body);
      const state = await AuctionService.markSold(code, req.guestSession!.id, lotId);
      res.json({ success: true, data: state });
    } catch (err) {
      next(err);
    }
  }

  static async markUnsold(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { lotId } = resolveLotSchema.parse(req.body);
      const state = await AuctionService.markUnsold(code, req.guestSession!.id, lotId);
      res.json({ success: true, data: state });
    } catch (err) {
      next(err);
    }
  }

  static async nextPlayer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const state = await AuctionService.nextPlayer(code, req.guestSession!.id);
      res.json({ success: true, data: state });
    } catch (err) {
      next(err);
    }
  }

  static async skipPlayer(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const state = await AuctionService.skipPlayer(code, req.guestSession!.id);
      res.json({ success: true, data: state });
    } catch (err) {
      next(err);
    }
  }
}
