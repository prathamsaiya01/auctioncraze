import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@auctioncraze/database';
import { config } from '../config/env';

export interface GuestJwtPayload {
  sub: string;
  jti: string;
  kind: 'guest';
}

export interface AuthenticatedRequest extends Request {
  guestSession?: {
    id: string;
    displayName: string;
    avatarSeed: string;
    expiresAt: Date;
  };
}

export function hashTokenSecret(rawSecret: string): string {
  return crypto.createHash('sha256').update(rawSecret).digest('hex');
}

export async function verifyGuestToken(token: string) {
  const decoded = jwt.verify(token, config.jwtSecret, {
    algorithms: ['HS256']
  }) as GuestJwtPayload;

  if (!decoded?.sub || !decoded?.jti || decoded.kind !== 'guest') {
    return null;
  }

  const session = await prisma.guestSession.findUnique({
    where: { id: decoded.sub }
  });

  if (!session || session.expiresAt <= new Date()) {
    return null;
  }

  const expectedDigest = hashTokenSecret(decoded.jti);
  const actualBuf = Buffer.from(session.tokenSecret, 'hex');
  const expectedBuf = Buffer.from(expectedDigest, 'hex');

  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }

  return session;
}

export async function authenticateGuest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    res.status(401).json({
      success: false,
      code: 'AUTH_REQUIRED',
      message: 'Guest session token required.'
    });
    return;
  }

  try {
    const session = await verifyGuestToken(token);
    if (!session) {
      res.status(401).json({
        success: false,
        code: 'INVALID_SESSION',
        message: 'Guest session is invalid or expired.'
      });
      return;
    }

    req.guestSession = {
      id: session.id,
      displayName: session.displayName,
      avatarSeed: session.avatarSeed,
      expiresAt: session.expiresAt
    };

    next();
  } catch {
    res.status(401).json({
      success: false,
      code: 'INVALID_SESSION',
      message: 'Invalid or expired guest session token.'
    });
  }
}

export async function optionalAuthenticateGuest(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    next();
    return;
  }

  try {
    const session = await verifyGuestToken(token);
    if (session) {
      req.guestSession = {
        id: session.id,
        displayName: session.displayName,
        avatarSeed: session.avatarSeed,
        expiresAt: session.expiresAt
      };
    }
  } catch {
    // Ignore invalid optional token on public/invite-gated reads
  }
  next();
}
