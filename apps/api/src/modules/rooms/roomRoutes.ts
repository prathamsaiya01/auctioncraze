import { Router } from 'express';
import { authenticateGuest, optionalAuthenticateGuest } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { RoomController } from './roomController';
import auctionRoutes from '../auction/auctionRoutes';
import tradeRoutes from '../trades/tradeRoutes';
import chatRoutes from '../chat/chatRoutes';

const router = Router();

router.get('/public', RoomController.listPublic);
router.get('/:code', optionalAuthenticateGuest, RoomController.getByCode);

router.post(
  '/',
  authenticateGuest,
  rateLimit({ keyPrefix: 'room_create', windowSeconds: 60, maxRequests: 10 }),
  RoomController.create
);

router.post(
  '/:code/join',
  authenticateGuest,
  rateLimit({ keyPrefix: 'room_join', windowSeconds: 60, maxRequests: 30 }),
  RoomController.join
);

router.patch('/:code/franchise', authenticateGuest, RoomController.claimFranchise);
router.patch('/:code/ready', authenticateGuest, RoomController.setReady);
router.post('/:code/leave', authenticateGuest, RoomController.leave);
router.post('/:code/kick', authenticateGuest, RoomController.kick);
router.post('/:code/transfer-host', authenticateGuest, RoomController.transferHost);
router.patch('/:code/settings', authenticateGuest, RoomController.updateSettings);
router.patch('/:code/live-settings', authenticateGuest, RoomController.updateLiveSettings);
router.post('/:code/invite/regenerate', authenticateGuest, RoomController.regenerateInvites);
router.patch('/:code/franchise/nickname', authenticateGuest, RoomController.updateFranchiseNickname);

// Phase 3: Auction Configuration, Player Pool, Retentions & Finalization
router.patch('/:code/config', authenticateGuest, RoomController.updateConfig);
router.put('/:code/pool', authenticateGuest, RoomController.configurePool);
router.post('/:code/pool/auto-fill', authenticateGuest, RoomController.autoFillPool);
router.post('/:code/retentions', authenticateGuest, RoomController.addRetention);
router.delete('/:code/retentions/:retentionId', authenticateGuest, RoomController.removeRetention);
router.post('/:code/config/finalize', authenticateGuest, RoomController.finalizeConfig);

// Phase 4: Real-Time Auction Engine
router.use('/:code/auction', auctionRoutes);

// Phase 6D: Franchise Player Trading System
router.use('/:code/trades', tradeRoutes);

// Phase 7: Multiplayer Room Chat & Moderation
router.use('/:code/chat', chatRoutes);

export default router;
