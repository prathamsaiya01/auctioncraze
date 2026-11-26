import { Request, Response, NextFunction } from 'express';
import { incrementCounter } from '../lib/coordinationStore';
import { AuthenticatedRequest } from './auth';

interface RateLimitOptions {
  keyPrefix: string;
  windowSeconds: number;
  maxRequests: number;
}

export function normalizeClientIp(rawIp: string | undefined): string {
  if (!rawIp) return 'unknown';
  const trimmed = rawIp.trim();
  if (!trimmed) return 'unknown';
  return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

/**
 * Resolves a caller rate-limit bucket key:
 * - Authenticated requests always key by verified `guestSession.id` so users behind shared NATs do not throttle each other.
 * - Anonymous requests key strictly by Express's hop-bounded `req.ip` (governed by `trust proxy` hops), ignoring arbitrary forwarded headers.
 */
export function resolveRateLimitClientKey(req: Request): string {
  const authReq = req as AuthenticatedRequest;
  if (authReq.guestSession?.id) {
    return `session:${authReq.guestSession.id}`;
  }
  return `ip:${normalizeClientIp(req.ip || req.socket?.remoteAddress)}`;
}

/**
 * Redis-backed fixed-window rate limiter keyed by authenticated session ID when available,
 * falling back to hop-validated client IP for anonymous endpoints.
 */
export function rateLimit(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const clientKey = resolveRateLimitClientKey(req);
      const bucket = Math.floor(Date.now() / 1000 / options.windowSeconds);
      const rateKey = `rl:${options.keyPrefix}:${clientKey}:${bucket}`;

      const count = await incrementCounter(rateKey, options.windowSeconds + 1);

      res.setHeader('X-RateLimit-Limit', String(options.maxRequests));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, options.maxRequests - count)));

      if (count > options.maxRequests) {
        res.status(429).json({
          success: false,
          code: 'RATE_LIMITED',
          message: 'Too many requests. Please slow down and try again.'
        });
        return;
      }

      next();
    } catch {
      // Fail open only if Redis is momentarily unavailable, without crashing requests
      next();
    }
  };
}
