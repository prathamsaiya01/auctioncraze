import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const PLACEHOLDER_MARKERS = ['replace_with_', 'changeme', 'your_secret_here', 'example_secret'];

function containsLoopbackHost(rawUrl: string): boolean {
  try {
    const withScheme = /^https?:\/\//i.test(rawUrl) || /^rediss?:\/\//i.test(rawUrl)
      ? rawUrl
      : `http://${rawUrl}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function requireStrongSecret(name: string, value: string | undefined, isProd: boolean): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length < 32) {
    throw new Error(
      `Security error: ${name} must be set and at least 32 characters long.`
    );
  }
  if (
    isProd &&
    PLACEHOLDER_MARKERS.some((marker) => trimmed.toLowerCase().includes(marker))
  ) {
    throw new Error(
      `Security error: ${name} contains a placeholder value and cannot be used in production.`
    );
  }
  return trimmed;
}

function requireProdUrl(name: string, value: string | undefined, allowNoScheme = false): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Configuration error: ${name} must be explicitly set in production.`);
  }
  const normalized =
    allowNoScheme && !/^https?:\/\//i.test(trimmed) ? `http://${trimmed}` : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Configuration error: ${name} must be a valid URL.`);
  }

  if (containsLoopbackHost(normalized)) {
    throw new Error(`Configuration error: ${name} must not point to localhost/loopback in production.`);
  }

  return parsed.toString().replace(/\/+$/, '');
}

function parseTrustProxyHops(rawValue: string | undefined, isProd: boolean): number {
  if (rawValue === undefined || rawValue.trim() === '') {
    return isProd ? 1 : 0;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'false') {
    throw new Error(
      'Security error: TRUST_PROXY_HOPS must be a bounded integer (0-5), not a boolean.'
    );
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 5) {
    throw new Error('Security error: TRUST_PROXY_HOPS must be an integer between 0 and 5.');
  }
  return parsed;
}

function parseCorsOrigins(env: Record<string, string | undefined>, isProd: boolean): string[] {
  const raw = env.CORS_ORIGIN || env.NEXT_PUBLIC_APP_URL || (isProd ? '' : 'http://localhost:3001');
  const origins = raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  if (isProd) {
    if (origins.length === 0) {
      throw new Error('Configuration error: CORS_ORIGIN must list allowed frontend origins in production.');
    }
    for (const origin of origins) {
      if (origin === '*') {
        throw new Error('Security error: CORS_ORIGIN cannot use wildcard "*" with credentialed APIs.');
      }
      if (containsLoopbackHost(origin)) {
        throw new Error('Configuration error: CORS_ORIGIN must not contain localhost/loopback in production.');
      }
    }
  }

  return origins;
}

export function parseEnvConfig(env: Record<string, string | undefined>) {
  const nodeEnv = (env.NODE_ENV || 'development').trim();
  const isProd = nodeEnv === 'production';

  const port = parseInt(env.PORT || '4001', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Configuration error: PORT must be a valid TCP port (1-65535).');
  }

  const jwtSecret = requireStrongSecret('JWT_SECRET', env.JWT_SECRET, isProd);
  const internalMlServiceKey = requireStrongSecret(
    'INTERNAL_ML_SERVICE_KEY',
    env.INTERNAL_ML_SERVICE_KEY,
    isProd
  );

  if (isProd && jwtSecret === internalMlServiceKey) {
    throw new Error(
      'Security error: JWT_SECRET and INTERNAL_ML_SERVICE_KEY must be distinct in production.'
    );
  }

  const databaseUrl = isProd
    ? requireProdUrl('DATABASE_URL', env.DATABASE_URL)
    : env.DATABASE_URL?.trim() ||
      'postgresql://auctioncraze:auctioncraze_dev_password@localhost:5433/auctioncraze_db?schema=public';

  const redisUrl = isProd
    ? requireProdUrl('REDIS_URL', env.REDIS_URL)
    : env.REDIS_URL?.trim() || 'redis://localhost:6380';

  if (!/^rediss?:\/\//i.test(redisUrl)) {
    throw new Error('Configuration error: REDIS_URL must use redis:// or rediss:// scheme.');
  }

  const mlServiceUrl = isProd
    ? requireProdUrl('ML_SERVICE_URL', env.ML_SERVICE_URL, true)
    : (() => {
        const raw = env.ML_SERVICE_URL?.trim() || 'http://localhost:8001';
        return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : `http://${raw}`;
      })();

  const guestSessionTtlSeconds = parseInt(env.GUEST_SESSION_TTL_SECONDS || '604800', 10);
  if (!Number.isInteger(guestSessionTtlSeconds) || guestSessionTtlSeconds < 60) {
    throw new Error('Configuration error: GUEST_SESSION_TTL_SECONDS must be an integer >= 60.');
  }

  return {
    port,
    nodeEnv,
    corsOrigins: parseCorsOrigins(env, isProd),
    trustProxyHops: parseTrustProxyHops(env.TRUST_PROXY_HOPS, isProd),
    databaseUrl,
    redisUrl,
    redisTlsRejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
    jwtSecret,
    jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
    guestSessionTtlSeconds,
    mlServiceUrl,
    internalMlServiceKey
  } as const;
}

export const config = parseEnvConfig(process.env);
