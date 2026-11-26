import { Router } from 'express';
import { authenticateGuest } from '../../middleware/auth';
import { IntelligenceController } from './intelligenceController';

const router = Router();

// All cricket intelligence endpoints require authenticated guest session + server-side
// active franchise owner membership in :code. Internal ML evaluation/artifact routes are
// deliberately NOT exposed here.
router.use(authenticateGuest);

router.get('/rooms/:code/access', IntelligenceController.checkOwnerAccess);
router.get('/rooms/:code/players/:id/analytics', IntelligenceController.playerAnalytics);
router.post('/rooms/:code/players/:id/rating', IntelligenceController.playerRating);
router.get('/rooms/:code/ratings/leaderboard', IntelligenceController.ratingsLeaderboard);
router.get(
  '/rooms/:code/franchises/:franchiseId/team-strength',
  IntelligenceController.roomFranchiseTeamStrength
);
router.post(
  '/rooms/:code/franchises/:franchiseId/playing-xi',
  IntelligenceController.roomFranchisePlayingXI
);
router.get('/rooms/:code/match-predictor/metadata', IntelligenceController.matchPredictorMetadata);
router.post('/rooms/:code/match-predictor/predict', IntelligenceController.predictMatch);

export default router;
