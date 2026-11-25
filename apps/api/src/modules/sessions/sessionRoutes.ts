import { Router } from 'express';
import { authenticateGuest } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { SessionController } from './sessionController';

const router = Router();

router.post(
  '/guest',
  rateLimit({ keyPrefix: 'guest_create', windowSeconds: 60, maxRequests: 20 }),
  SessionController.createGuest
);

router.get('/me', authenticateGuest, SessionController.getMe);
router.patch('/me', authenticateGuest, SessionController.updateMe);

export default router;
