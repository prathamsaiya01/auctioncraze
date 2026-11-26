import { NextFunction, Response } from 'express';
import { prisma } from '@auctioncraze/database';
import { AuthenticatedRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import {
  requireActiveFranchiseOwner,
  requireExactFranchiseOwnership
} from './intelligenceAuth';
import { callMlService, resolvePlayerKeyForMl } from './mlClient';
import { PostAuctionRatingService } from './postAuctionRatingService';

async function loadOwnedFranchiseSquad(roomId: string, franchiseId: string) {
  const franchise = await prisma.roomFranchise.findFirst({
    where: { id: franchiseId, roomId },
    include: {
      retentions: {
        include: {
          player: {
            select: {
              id: true,
              cricsheetId: true,
              externalKey: true,
              fullName: true,
              playingRole: true,
              isOverseas: true
            }
          }
        }
      },
      purchases: {
        include: {
          player: {
            select: {
              id: true,
              cricsheetId: true,
              externalKey: true,
              fullName: true,
              playingRole: true,
              isOverseas: true
            }
          }
        }
      }
    }
  });

  if (!franchise) {
    throw new AppError('Owned franchise not found.', 404, 'FRANCHISE_NOT_FOUND');
  }

  const seenPlayerIds = new Set<string>();
  const squad: Array<{ player_id: string; playing_role: string; is_overseas: boolean }> = [];

  for (const r of franchise.retentions) {
    if (seenPlayerIds.has(r.player.id)) continue;
    seenPlayerIds.add(r.player.id);
    squad.push({
      player_id: r.player.cricsheetId || r.player.externalKey || r.player.fullName,
      playing_role: r.player.playingRole,
      is_overseas: r.player.isOverseas
    });
  }

  for (const p of franchise.purchases) {
    if (seenPlayerIds.has(p.player.id)) continue;
    seenPlayerIds.add(p.player.id);
    squad.push({
      player_id: p.player.cricsheetId || p.player.externalKey || p.player.fullName,
      playing_role: p.player.playingRole,
      is_overseas: p.player.isOverseas
    });
  }

  return squad;
}

export class IntelligenceController {
  static async checkOwnerAccess(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const ctx = await requireActiveFranchiseOwner(
        req.guestSession!.id,
        String(req.params.code || '')
      );
      res.json({
        success: true,
        data: {
          authorized: true,
          roomCode: ctx.room.code,
          role: ctx.participant.role,
          isHost: ctx.participant.isHost,
          franchiseId: ctx.ownedFranchise.id,
          franchiseCode: ctx.ownedFranchise.presetCode,
          franchiseName: ctx.ownedFranchise.name
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async playerAnalytics(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      await requireActiveFranchiseOwner(req.guestSession!.id, String(req.params.code || ''));
      const playerKey = await resolvePlayerKeyForMl(String(req.params.id || ''));
      const scope = String(req.query.scope || 'CAREER').toUpperCase();
      const data = await callMlService(
        `/v1/analytics/players/${encodeURIComponent(playerKey)}?scope=${encodeURIComponent(scope)}`
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async playerRating(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      await requireActiveFranchiseOwner(req.guestSession!.id, String(req.params.code || ''));
      const playerKey = await resolvePlayerKeyForMl(String(req.params.id || ''));
      const scope = String(req.body?.scope || req.query.scope || 'CAREER').toUpperCase();
      const data = await callMlService('/v1/ratings/player', {
        method: 'POST',
        body: { player_id: playerKey, scope }
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async ratingsLeaderboard(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      await requireActiveFranchiseOwner(req.guestSession!.id, String(req.params.code || ''));
      const qs = new URLSearchParams();
      if (req.query.role) qs.set('role', String(req.query.role));
      if (req.query.scope) qs.set('scope', String(req.query.scope));
      if (req.query.sort_by) qs.set('sort_by', String(req.query.sort_by));
      if (req.query.min_matches) qs.set('min_matches', String(req.query.min_matches));
      if (req.query.limit) qs.set('limit', String(req.query.limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const data = await callMlService(`/v1/ratings/leaderboard${suffix}`);
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async roomFranchiseTeamStrength(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const ctx = await requireExactFranchiseOwnership(
        req.guestSession!.id,
        String(req.params.code || ''),
        String(req.params.franchiseId || '')
      );
      const squad = await loadOwnedFranchiseSquad(ctx.room.id, ctx.ownedFranchise.id);
      const data = await callMlService('/v1/analysis/team-strength', {
        method: 'POST',
        body: {
          room_id: ctx.room.id,
          franchise_code: ctx.ownedFranchise.presetCode,
          squad,
          max_overseas_in_squad: ctx.room.maxOverseas
        }
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async roomFranchisePlayingXI(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const ctx = await requireExactFranchiseOwnership(
        req.guestSession!.id,
        String(req.params.code || ''),
        String(req.params.franchiseId || '')
      );
      const squad = await loadOwnedFranchiseSquad(ctx.room.id, ctx.ownedFranchise.id);
      const data = await callMlService('/v1/predictions/playing-xi', {
        method: 'POST',
        body: {
          room_id: ctx.room.id,
          franchise_code: ctx.ownedFranchise.presetCode,
          squad,
          venue: req.body?.venue || null,
          pitch_type: req.body?.pitch_type || null
        }
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async matchPredictorMetadata(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      await requireActiveFranchiseOwner(req.guestSession!.id, String(req.params.code || ''));
      const data = await callMlService('/v1/predictions/match/metadata');
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async predictMatch(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      await requireActiveFranchiseOwner(req.guestSession!.id, String(req.params.code || ''));
      const data = await callMlService('/v1/predictions/match', {
        method: 'POST',
        body: req.body || {}
      });
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  // ------------------------------------------------------------------
  // Phase 6C: Post-Auction Team Ratings Dashboard Endpoints
  // ------------------------------------------------------------------

  static async postAuctionReadiness(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const data = await PostAuctionRatingService.getReadiness(
        String(req.params.code || ''),
        req.guestSession!.id
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async postAuctionHostRatings(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const data = await PostAuctionRatingService.getHostRatings(
        String(req.params.code || ''),
        req.guestSession!.id
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async postAuctionHostComparison(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const data = await PostAuctionRatingService.getHostComparison(
        String(req.params.code || ''),
        req.guestSession!.id
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async postAuctionFranchiseReport(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const data = await PostAuctionRatingService.getFranchiseReport(
        String(req.params.code || ''),
        req.guestSession!.id,
        String(req.params.franchiseId || '')
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async postAuctionFranchisePlayingXI(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const data = await PostAuctionRatingService.getFranchisePlayingXI(
        String(req.params.code || ''),
        req.guestSession!.id,
        String(req.params.franchiseId || '')
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }

  static async postAuctionRecalculate(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const data = await PostAuctionRatingService.recalculate(
        String(req.params.code || ''),
        req.guestSession!.id
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
}
