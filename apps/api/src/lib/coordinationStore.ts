import { config } from '../config/env';
import { redis } from './redis';

interface CounterEntry {
  count: number;
  expiresAtMs: number;
}

interface ValueEntry {
  value: string;
  expiresAtMs: number;
}

const MAX_MEMORY_ENTRIES = 10_000;
const CLEANUP_INTERVAL_MS = 60_000;

class InMemoryCoordinationStore {
  private readonly counters = new Map<string, CounterEntry>();
  private readonly values = new Map<string, ValueEntry>();
  private readonly presenceSets = new Map<string, Set<string>>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  private ensureCleanupLoop(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.pruneExpired(Date.now());
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  private pruneExpired(nowMs: number): void {
    for (const [k, entry] of this.counters.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        this.counters.delete(k);
      }
    }
    for (const [k, entry] of this.values.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        this.values.delete(k);
      }
    }
  }

  private evictOldestIfFull<T>(map: Map<string, T>): void {
    if (map.size < MAX_MEMORY_ENTRIES) return;
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }

  incrementCounter(key: string, ttlSeconds: number): number {
    this.ensureCleanupLoop();
    const nowMs = Date.now();
    const existing = this.counters.get(key);
    if (existing && existing.expiresAtMs > nowMs) {
      existing.count += 1;
      return existing.count;
    }
    this.evictOldestIfFull(this.counters);
    this.counters.set(key, {
      count: 1,
      expiresAtMs: nowMs + Math.max(1, ttlSeconds) * 1000
    });
    return 1;
  }

  getExpiringValue(key: string): string | null {
    const existing = this.values.get(key);
    if (!existing) return null;
    if (existing.expiresAtMs <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return existing.value;
  }

  setExpiringValue(key: string, value: string, ttlSeconds: number): void {
    this.ensureCleanupLoop();
    this.evictOldestIfFull(this.values);
    this.values.set(key, {
      value,
      expiresAtMs: Date.now() + Math.max(1, ttlSeconds) * 1000
    });
  }

  addPresenceSocket(key: string, socketId: string): void {
    let set = this.presenceSets.get(key);
    if (!set) {
      this.evictOldestIfFull(this.presenceSets);
      set = new Set<string>();
      this.presenceSets.set(key, set);
    }
    set.add(socketId);
  }

  removePresenceSocket(key: string, socketId: string): number {
    const set = this.presenceSets.get(key);
    if (!set) return 0;
    set.delete(socketId);
    const remaining = set.size;
    if (remaining === 0) {
      this.presenceSets.delete(key);
    }
    return remaining;
  }

  clearPresenceKey(key: string): void {
    this.presenceSets.delete(key);
  }

  getMemoryStats(): { counters: number; values: number; presenceKeys: number } {
    return {
      counters: this.counters.size,
      values: this.values.size,
      presenceKeys: this.presenceSets.size
    };
  }

  clearAll(): void {
    this.counters.clear();
    this.values.clear();
    this.presenceSets.clear();
  }
}

const memoryStore = new InMemoryCoordinationStore();

export async function incrementCounter(key: string, ttlSeconds: number): Promise<number> {
  if (!config.enableRedis) {
    return memoryStore.incrementCounter(key, ttlSeconds);
  }
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, ttlSeconds);
  }
  return count;
}

export async function getExpiringValue(key: string): Promise<string | null> {
  if (!config.enableRedis) {
    return memoryStore.getExpiringValue(key);
  }
  return redis.get(key);
}

export async function setExpiringValue(
  key: string,
  value: string,
  ttlSeconds: number
): Promise<void> {
  if (!config.enableRedis) {
    memoryStore.setExpiringValue(key, value, ttlSeconds);
    return;
  }
  await redis.set(key, value, 'EX', Math.max(1, ttlSeconds));
}

export async function addPresenceSocket(
  key: string,
  socketId: string,
  ttlSeconds = 86400
): Promise<void> {
  if (!config.enableRedis) {
    memoryStore.addPresenceSocket(key, socketId);
    return;
  }
  await redis.sadd(key, socketId);
  await redis.expire(key, ttlSeconds);
}

export async function removePresenceSocket(key: string, socketId: string): Promise<number> {
  if (!config.enableRedis) {
    return memoryStore.removePresenceSocket(key, socketId);
  }
  await redis.srem(key, socketId);
  const remaining = await redis.scard(key);
  if (remaining === 0) {
    await redis.del(key);
  }
  return remaining;
}

export async function clearPresenceKey(key: string): Promise<void> {
  if (!config.enableRedis) {
    memoryStore.clearPresenceKey(key);
    return;
  }
  await redis.del(key);
}

export function clearMemoryCoordinationStores(): void {
  memoryStore.clearAll();
}

export function getMemoryCoordinationStats() {
  return memoryStore.getMemoryStats();
}

export async function clearRateLimitEntriesForTest(prefix = 'rl:*'): Promise<void> {
  if (!config.enableRedis) {
    memoryStore.clearAll();
    return;
  }
  const keys = await redis.keys(prefix);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}
