import { Router } from 'express';
import { authenticateGuest, optionalAuthenticateGuest } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rateLimit';
import { SeasonController } from './seasonController';

const router = Router();

router.get('/', SeasonController.list);
router.get('/:code', optionalAuthenticateGuest, SeasonController.getByCode);

router.post(
  '/',
  authenticateGuest,
  rateLimit({ keyPrefix: 'season_create', windowSeconds: 60, maxRequests: 20 }),
  SeasonController.create
);

router.post(
  '/:code/claim',
  authenticateGuest,
  rateLimit({ keyPrefix: 'season_claim', windowSeconds: 60, maxRequests: 30 }),
  SeasonController.claimFranchise
);

router.post(
  '/:code/rooms',
  authenticateGuest,
  rateLimit({ keyPrefix: 'season_room_create', windowSeconds: 60, maxRequests: 20 }),
  SeasonController.createRoom
);

router.post('/:code/points', authenticateGuest, SeasonController.adjustPoints);
router.post('/:code/entries/:entryId/recovery-code', authenticateGuest, SeasonController.issueRecovery);
router.post('/:code/entries/:entryId/release', authenticateGuest, SeasonController.releaseFranchise);
router.patch('/:code/archive', authenticateGuest, SeasonController.archive);
router.patch('/:code/reopen', authenticateGuest, SeasonController.reopen);

export default router;
