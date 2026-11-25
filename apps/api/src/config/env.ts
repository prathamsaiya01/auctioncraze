import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

function requireStrongSecret(name: string, value: string | undefined): string {
  if (!value || value.trim().length < 32) {
    throw new Error(
      `Security error: ${name} must be set and at least 32 characters long. Check D:\\AUCTIONCRAZE\\.env.`
    );
  }
  return value.trim();
}

const rawCorsOrigins = process.env.CORS_ORIGIN || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';
const corsOrigins = rawCorsOrigins
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

export const config = {
  port: parseInt(process.env.PORT || '4001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigins,
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgresql://auctioncraze:auctioncraze_dev_password@localhost:5433/auctioncraze_db?schema=public',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6380',
  jwtSecret: requireStrongSecret('JWT_SECRET', process.env.JWT_SECRET),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  guestSessionTtlSeconds: parseInt(process.env.GUEST_SESSION_TTL_SECONDS || '604800', 10),
  mlServiceUrl: process.env.ML_SERVICE_URL || 'http://localhost:8001'
} as const;
