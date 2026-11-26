import Redis, { RedisOptions } from 'ioredis';
import { config } from '../config/env';

export function createRedisClientOptions(
  _label: string,
  overrides?: Partial<RedisOptions>
): RedisOptions {
  const usesTls = /^rediss:\/\//i.test(config.redisUrl);
  return {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: (times: number) => Math.min(times * 250, 5000),
    ...(usesTls ? { tls: { rejectUnauthorized: config.redisTlsRejectUnauthorized } } : {}),
    ...overrides
  };
}

export function attachRedisLifecycleLogging(client: Redis, label: string): void {
  client.on('error', (err) => {
    // Log message only so credentials embedded in URLs are never exposed
    console.error(`[Redis:${label}] Client error: ${err?.message || 'Unknown error'}`);
  });
  client.on('reconnecting', (delayMs: number) => {
    console.warn(`[Redis:${label}] Reconnecting in ${delayMs}ms...`);
  });
  client.on('end', () => {
    console.warn(`[Redis:${label}] Connection closed.`);
  });
}

export async function safeQuitRedis(client: Redis | null, label: string): Promise<void> {
  if (!client || client.status === 'end') return;
  try {
    await Promise.race([
      client.quit(),
      new Promise<void>((resolve) => setTimeout(resolve, 2000))
    ]);
  } catch (err: any) {
    console.warn(`[Redis:${label}] Graceful quit fallback: ${err?.message || 'timeout'}`);
  } finally {
    if ((client.status as string) !== 'end') {
      client.disconnect();
    }
  }
}

export const redis = new Redis(
  config.redisUrl || 'redis://127.0.0.1:6380',
  createRedisClientOptions('Primary', {
    ...(config.enableRedis ? {} : { retryStrategy: () => null })
  })
);

if (config.enableRedis) {
  attachRedisLifecycleLogging(redis, 'Primary');
} else {
  // Prevent accidental unhandled error emissions when Redis is intentionally disabled
  redis.on('error', () => {});
}

export async function connectRedis(): Promise<void> {
  if (!config.enableRedis) {
    console.log('ℹ️  Redis disabled (single-instance memory mode active).');
    return;
  }
  if (redis.status === 'wait') {
    await redis.connect();
  }
  const pong = await redis.ping();
  if (pong !== 'PONG') {
    throw new Error(`Unexpected Redis PING response: ${pong}`);
  }
}

export async function checkRedisHealth(): Promise<boolean | null> {
  if (!config.enableRedis) {
    return null;
  }
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
}

export async function disconnectRedis(): Promise<void> {
  if (!config.enableRedis) return;
  await safeQuitRedis(redis, 'Primary');
}
