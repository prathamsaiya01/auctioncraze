import { NextFunction, Response } from 'express';
import {
  createTradeProposalSchema,
  respondTradeSchema,
  roomCodeParamSchema
} from '@auctioncraze/shared';
import { z } from 'zod';
import { AuthenticatedRequest } from '../../middleware/auth';
import { TradeService } from './tradeService';

const tradeIdParamSchema = z.object({
  tradeId: z.string().uuid('Invalid trade ID')
});

export class TradeController {
  static async list(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const data = await TradeService.listTrades(code, req.guestSession!.id);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async propose(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const payload = createTradeProposalSchema.parse(req.body);
      const data = await TradeService.proposeTrade(code, req.guestSession!.id, payload);
      res.status(201).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async accept(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { tradeId } = tradeIdParamSchema.parse(req.params);
      const payload = respondTradeSchema.parse(req.body || {});
      const data = await TradeService.acceptTrade(
        code,
        req.guestSession!.id,
        tradeId,
        payload.idempotencyKey
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async reject(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { tradeId } = tradeIdParamSchema.parse(req.params);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
      const data = await TradeService.rejectTrade(code, req.guestSession!.id, tradeId, reason);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async cancel(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const { tradeId } = tradeIdParamSchema.parse(req.params);
      const data = await TradeService.cancelTrade(code, req.guestSession!.id, tradeId);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
}
