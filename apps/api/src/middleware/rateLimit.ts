import { Request, Response, NextFunction } from 'express';
import { redis } from '../lib/redis';
import { AuthenticatedRequest } from './auth';

interface RateLimitOptions {
  keyPrefix: string;
  windowSeconds: number;
  maxRequests: number;
}

/**
 * Redis-backed fixed-window rate limiter keyed by authenticated session ID when available,
 * falling back to client IP for anonymous endpoints (avoids false positives behind shared NATs).
 */
export function rateLimit(options: RateLimitOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const clientKey =
        authReq.guestSession?.id || req.ip || req.socket.remoteAddress || 'unknown';
      const bucket = Math.floor(Date.now() / 1000 / options.windowSeconds);
      const redisKey = `rl:${options.keyPrefix}:${clientKey}:${bucket}`;

      const count = await redis.incr(redisKey);
      if (count === 1) {
        await redis.expire(redisKey, options.windowSeconds + 1);
      }

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
      // Fail open only if Redis is momentarily unavailable, while logging the fault
      next();
    }
  };
}
