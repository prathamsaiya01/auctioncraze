import { Request, Response, NextFunction } from 'express';
import { createGuestSessionSchema, updateGuestSessionSchema } from '@auctioncraze/shared';
import { AuthenticatedRequest } from '../../middleware/auth';
import { SessionService } from './sessionService';

export class SessionController {
  static async createGuest(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { displayName } = createGuestSessionSchema.parse(req.body);
      const result = await SessionService.createGuestSession(displayName);
      res.status(201).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  static async getMe(req: AuthenticatedRequest, res: Response): Promise<void> {
    const session = req.guestSession!;
    res.json({
      success: true,
      data: {
        id: session.id,
        displayName: session.displayName,
        avatarSeed: session.avatarSeed,
        expiresAt: session.expiresAt.toISOString()
      }
    });
  }

  static async updateMe(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { displayName } = updateGuestSessionSchema.parse(req.body);
      const updated = await SessionService.updateDisplayName(req.guestSession!.id, displayName);
      res.json({
        success: true,
        data: updated
      });
    } catch (err) {
      next(err);
    }
  }
}
