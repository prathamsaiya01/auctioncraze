import { NextFunction, Response } from 'express';
import { prisma } from '@auctioncraze/database';
import { config } from '../../config/env';
import { AuthenticatedRequest } from '../../middleware/auth';
import { AppError } from '../../middleware/errorHandler';
import {
  requireActiveFranchiseOwner,
  requireExactFranchiseOwnership
} from './intelligenceAuth';

const SENSITIVE_INTERNAL_KEYS = new Set([
  'artifact_path',
  'dataset_fingerprint',
  'holdout_metrics',
  'validation_metrics',
  'validation_candidates',
  'baseline_comparisons',
  'selected_candidate',
  'feature_breakdown',
  'team_elo',
  'sample_counts'
]);

function scrubSensitiveFields<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => scrubSensitiveFields(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_INTERNAL_KEYS.has(k)) continue;
      out[k] = scrubSensitiveFields(v);
    }
    return out as T;
  }
  return value;
}

async function callMlService<T = unknown>(
  path: string,
  options?: { method?: string; body?: unknown }
): Promise<T> {
  const internalKey = config.internalMlServiceKey;
  if (!internalKey || internalKey.length < 32) {
    throw new AppError(
      'Internal ML service secret is missing (failing closed).',
      503,
      'INTERNAL_ML_AUTH_MISSING'
    );
  }

  const url = `${config.mlServiceUrl.replace(/\/+$/, '')}${path}`;
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: options?.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Key': internalKey
      },
      ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw new AppError(
      'Cricket intelligence service is currently offline or unreachable.',
      503,
      'ML_SERVICE_UNAVAILABLE'
    );
  }

  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      (payload && (payload.detail || payload.message)) ||
      `ML service error (${response.status})`;
    const code =
      response.status === 503
        ? 'MODEL_UNAVAILABLE'
        : response.status === 422
        ? 'INSUFFICIENT_OR_INVALID_INPUT'
        : response.status === 404
        ? 'NOT_FOUND'
        : response.status === 401 || response.status === 403
        ? 'ML_INTERNAL_UNAUTHORIZED'
        : 'ML_REQUEST_FAILED';
    throw new AppError(String(detail), response.status, code);
  }

  return scrubSensitiveFields(payload as T);
}

async function resolvePlayerKeyForMl(idOrKey: string): Promise<string> {
  const trimmed = idOrKey.trim();
  const found = await prisma.masterPlayer.findFirst({
    where: {
      OR: [
        { id: trimmed },
        { cricsheetId: trimmed },
        { externalKey: trimmed },
        { fullName: { equals: trimmed, mode: 'insensitive' } }
      ]
    },
    select: {
      cricsheetId: true,
      externalKey: true,
      fullName: true
    }
  });

  if (!found) {
    return trimmed;
  }
  return found.cricsheetId || found.externalKey || found.fullName;
}

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
}
