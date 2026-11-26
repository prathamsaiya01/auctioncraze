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

// Phase 6C: Post-Auction Team Ratings Dashboard endpoints
router.get('/rooms/:code/post-auction/readiness', IntelligenceController.postAuctionReadiness);
router.get('/rooms/:code/post-auction/ratings', IntelligenceController.postAuctionHostRatings);
router.get('/rooms/:code/post-auction/comparison', IntelligenceController.postAuctionHostComparison);
router.get(
  '/rooms/:code/post-auction/franchises/:franchiseId/report',
  IntelligenceController.postAuctionFranchiseReport
);
router.get(
  '/rooms/:code/post-auction/franchises/:franchiseId/playing-xi',
  IntelligenceController.postAuctionFranchisePlayingXI
);
router.post('/rooms/:code/post-auction/recalculate', IntelligenceController.postAuctionRecalculate);

export default router;
