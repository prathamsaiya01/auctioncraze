import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '@auctioncraze/database';
import { GuestSessionDto } from '@auctioncraze/shared';
import { config } from '../../config/env';
import { hashTokenSecret } from '../../middleware/auth';

export class SessionService {
  static async createGuestSession(displayName: string): Promise<{
    token: string;
    session: GuestSessionDto;
  }> {
    const rawSecret = crypto.randomBytes(32).toString('hex');
    const tokenSecret = hashTokenSecret(rawSecret);
    const avatarSeed = crypto.randomBytes(6).toString('hex');
    const expiresAt = new Date(Date.now() + config.guestSessionTtlSeconds * 1000);

    const created = await prisma.guestSession.create({
      data: {
        tokenSecret,
        displayName,
        avatarSeed,
        expiresAt
      }
    });

    const token = jwt.sign(
      {
        sub: created.id,
        jti: rawSecret,
        kind: 'guest'
      },
      config.jwtSecret,
      {
        algorithm: 'HS256',
        expiresIn: config.guestSessionTtlSeconds
      }
    );

    return {
      token,
      session: {
        id: created.id,
        displayName: created.displayName,
        avatarSeed: created.avatarSeed,
        expiresAt: created.expiresAt.toISOString()
      }
    };
  }

  static async updateDisplayName(sessionId: string, displayName: string): Promise<GuestSessionDto> {
    const updated = await prisma.guestSession.update({
      where: { id: sessionId },
      data: {
        displayName,
        lastSeenAt: new Date()
      }
    });

    return {
      id: updated.id,
      displayName: updated.displayName,
      avatarSeed: updated.avatarSeed,
      expiresAt: updated.expiresAt.toISOString()
    };
  }
}
