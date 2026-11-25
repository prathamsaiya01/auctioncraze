import { Router } from 'express';
import { authenticateGuest } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { AuctionController } from './auctionController';

const router = Router({ mergeParams: true });

router.get('/', authenticateGuest, AuctionController.getState);
router.post('/start', authenticateGuest, AuctionController.start);
router.post(
  '/bids',
  authenticateGuest,
  rateLimit({ keyPrefix: 'auction_bid', windowSeconds: 10, maxRequests: 30 }),
  AuctionController.placeBid
);
router.post('/pause', authenticateGuest, AuctionController.pause);
router.post('/resume', authenticateGuest, AuctionController.resume);
router.post('/extend-timer', authenticateGuest, AuctionController.extendTimer);
router.post('/sold', authenticateGuest, AuctionController.markSold);
router.post('/unsold', authenticateGuest, AuctionController.markUnsold);
router.post('/next', authenticateGuest, AuctionController.nextPlayer);
router.post('/skip', authenticateGuest, AuctionController.skipPlayer);

export default router;
