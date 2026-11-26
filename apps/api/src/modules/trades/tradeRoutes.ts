import { Router } from 'express';
import { authenticateGuest } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { TradeController } from './tradeController';

const router = Router({ mergeParams: true });

router.use(authenticateGuest);

router.get('/', TradeController.list);
router.post(
  '/',
  rateLimit({ keyPrefix: 'trade_propose', windowSeconds: 60, maxRequests: 25 }),
  TradeController.propose
);
router.post(
  '/:tradeId/accept',
  rateLimit({ keyPrefix: 'trade_accept', windowSeconds: 60, maxRequests: 25 }),
  TradeController.accept
);
router.post('/:tradeId/reject', TradeController.reject);
router.post('/:tradeId/cancel', TradeController.cancel);

export default router;
