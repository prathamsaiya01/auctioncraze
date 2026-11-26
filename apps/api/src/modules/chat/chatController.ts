import { NextFunction, Response } from 'express';
import {
  chatModerationSettingsSchema,
  chatMuteParticipantSchema,
  chatSendSchema,
  roomCodeParamSchema
} from '@auctioncraze/shared';
import { AuthenticatedRequest } from '../../middleware/auth';
import { ChatService } from './chatService';

export class ChatController {
  static async getMessages(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const data = await ChatService.getRoomChatState(code, req.guestSession!.id);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async sendMessage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const body = chatSendSchema.parse(req.body);
      const data = await ChatService.sendMessage({
        roomCode: code,
        guestSessionId: req.guestSession!.id,
        rawMessage: body.message,
        idempotencyKey: body.idempotencyKey
      });
      res.status(201).json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async updateSettings(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const body = chatModerationSettingsSchema.parse(req.body);
      const data = await ChatService.updateChatSettings(code, req.guestSession!.id, body);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async deleteMessage(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const messageId = String(req.params.messageId || '');
      const data = await ChatService.deleteMessage(code, req.guestSession!.id, messageId);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async muteParticipant(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = roomCodeParamSchema.parse(req.params);
      const participantId = String(req.params.participantId || '');
      const body = chatMuteParticipantSchema.parse(req.body);
      const data = await ChatService.muteParticipant(code, req.guestSession!.id, participantId, body.muted);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
}
