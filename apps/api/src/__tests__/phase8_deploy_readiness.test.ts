import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { prisma } from '@auctioncraze/database';
import { createApp } from '../app';
import { config, parseEnvConfig } from '../config/env';
import { attachRedisLifecycleLogging, connectRedis, disconnectRedis, redis, safeQuitRedis } from '../lib/redis';
import { rateLimit, resolveRateLimitClientKey } from '../middleware/rateLimit';
import { authenticateGuest } from '../middleware/auth';
import { resolveMetadataBase } from '../../../web/src/lib/siteMetadata';

async function listenApp(app: any): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function runPhase8DeployReadinessTests() {
  await prisma.$connect();
  await connectRedis();

  // Clean test rate limit buckets before running
  const staleKeys = await redis.keys('rl:test_proxy_*');
  if (staleKeys.length > 0) await redis.del(...staleKeys);

  // ------------------------------------------------------------------
  // 1. Env validation tests (Task 7)
  // ------------------------------------------------------------------
  const validProdBase = {
    NODE_ENV: 'production',
    PORT: '10000',
    CORS_ORIGIN: 'https://auctioncraze.netlify.app',
    DATABASE_URL: 'postgresql://user:pass@dpg-internal:5432/auctioncraze_db',
    REDIS_URL: 'rediss://red-internal:6379',
    ML_SERVICE_URL: 'auctioncraze-ml:8001',
    JWT_SECRET: 'prod_jwt_secret_' + 'a'.repeat(48),
    INTERNAL_ML_SERVICE_KEY: 'prod_ml_secret_' + 'b'.repeat(48)
  };

  const parsedProd = parseEnvConfig(validProdBase);
  assert.equal(parsedProd.trustProxyHops, 1, 'Production should default to 1 trusted proxy hop');
  assert.equal(parsedProd.mlServiceUrl, 'http://auctioncraze-ml:8001', 'Render hostport must normalize cleanly');
  assert.deepEqual(parsedProd.corsOrigins, ['https://auctioncraze.netlify.app']);

  assert.throws(
    () => parseEnvConfig({ ...validProdBase, DATABASE_URL: undefined }),
    /DATABASE_URL/
  );
  assert.throws(
    () => parseEnvConfig({ ...validProdBase, REDIS_URL: 'redis://localhost:6380' }),
    /localhost/
  );
  assert.throws(
    () => parseEnvConfig({ ...validProdBase, CORS_ORIGIN: '*' }),
    /wildcard/
  );
  assert.throws(
    () => parseEnvConfig({ ...validProdBase, TRUST_PROXY_HOPS: 'true' }),
    /bounded integer/
  );
  assert.throws(
    () => parseEnvConfig({ ...validProdBase, JWT_SECRET: 'replace_with_' + 'z'.repeat(48) }),
    /placeholder/
  );
  assert.throws(
    () => parseEnvConfig({ ...validProdBase, INTERNAL_ML_SERVICE_KEY: validProdBase.JWT_SECRET }),
    /distinct/
  );

  // ------------------------------------------------------------------
  // 2. Frontend production metadataBase checks (Task 6)
  // ------------------------------------------------------------------
  assert.equal(
    resolveMetadataBase({ NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'http://localhost:3001' }),
    undefined,
    'Production build must never emit localhost metadataBase'
  );
  const resolvedMeta = resolveMetadataBase({
    NODE_ENV: 'production',
    NEXT_PUBLIC_APP_URL: 'https://auctioncraze.netlify.app/'
  });
  assert.equal(resolvedMeta?.origin, 'https://auctioncraze.netlify.app');

  // ------------------------------------------------------------------
  // 3. Trust proxy & rate limiting security tests (Task 4)
  // ------------------------------------------------------------------
  const unproxiedApp = createApp({ trustProxyHops: 0 });
  unproxiedApp.get(
    '/test/anon-limit',
    rateLimit({ keyPrefix: 'test_proxy_unproxied', windowSeconds: 60, maxRequests: 2 }),
    (req, res) => res.json({ key: resolveRateLimitClientKey(req), ip: req.ip })
  );
  const unproxied = await listenApp(unproxiedApp);

  try {
    // Even with forged X-Forwarded-For headers, trustProxyHops=0 ignores them completely
    const r1 = await fetch(`${unproxied.baseUrl}/test/anon-limit`, {
      headers: { 'X-Forwarded-For': '203.0.113.1' }
    });
    assert.equal(r1.status, 200);
    const r2 = await fetch(`${unproxied.baseUrl}/test/anon-limit`, {
      headers: { 'X-Forwarded-For': '198.51.100.2' }
    });
    assert.equal(r2.status, 200);
    const r3 = await fetch(`${unproxied.baseUrl}/test/anon-limit`, {
      headers: { 'X-Forwarded-For': '192.0.2.3' }
    });
    assert.equal(r3.status, 429, 'Unproxied mode must throttle despite forged X-Forwarded-For');
  } finally {
    await new Promise<void>((resolve) => unproxied.server.close(() => resolve()));
  }

  const proxiedApp = createApp({ trustProxyHops: 1 });
  proxiedApp.get(
    '/test/proxied-anon',
    rateLimit({ keyPrefix: 'test_proxy_hop1', windowSeconds: 60, maxRequests: 2 }),
    (req, res) => res.json({ key: resolveRateLimitClientKey(req), ip: req.ip })
  );
  proxiedApp.get(
    '/test/proxied-auth',
    authenticateGuest,
    rateLimit({ keyPrefix: 'test_proxy_auth', windowSeconds: 60, maxRequests: 2 }),
    (req, res) => res.json({ key: resolveRateLimitClientKey(req), ip: req.ip })
  );
  const proxied = await listenApp(proxiedApp);

  const createdSessionIds: string[] = [];
  try {
    // Client A (203.0.113.10) vs Client B (198.51.100.20) get independent buckets behind Render proxy
    const a1 = await fetch(`${proxied.baseUrl}/test/proxied-anon`, {
      headers: { 'X-Forwarded-For': '203.0.113.10' }
    });
    const b1 = await fetch(`${proxied.baseUrl}/test/proxied-anon`, {
      headers: { 'X-Forwarded-For': '198.51.100.20' }
    });
    assert.equal(a1.status, 200);
    assert.equal(b1.status, 200);
    const a1Json: any = await a1.json();
    const b1Json: any = await b1.json();
    assert.equal(a1Json.key, 'ip:203.0.113.10');
    assert.equal(b1Json.key, 'ip:198.51.100.20');

    // Spoofed left-hand IP prepended before real peer IP appended by proxy MUST still resolve to 203.0.113.10
    const a2 = await fetch(`${proxied.baseUrl}/test/proxied-anon`, {
      headers: { 'X-Forwarded-For': '8.8.8.8, 203.0.113.10', 'X-Real-IP': '1.1.1.1' }
    });
    assert.equal(a2.status, 200);
    assert.equal(((await a2.json()) as any).key, 'ip:203.0.113.10');

    const a3 = await fetch(`${proxied.baseUrl}/test/proxied-anon`, {
      headers: { 'X-Forwarded-For': '9.9.9.9, 203.0.113.10' }
    });
    assert.equal(a3.status, 429, 'Spoofing left-most X-Forwarded-For cannot bypass rate limit');

    // Client B must still pass cleanly
    const b2 = await fetch(`${proxied.baseUrl}/test/proxied-anon`, {
      headers: { 'X-Forwarded-For': '198.51.100.20' }
    });
    assert.equal(b2.status, 200);

    // Two authenticated users behind the SAME NAT IP (203.0.113.77) must NOT throttle each other
    const g1Res = await fetch(`${proxied.baseUrl}/api/v1/sessions/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.77' },
      body: JSON.stringify({ displayName: `NatUser1_${crypto.randomBytes(2).toString('hex')}` })
    });
    const g2Res = await fetch(`${proxied.baseUrl}/api/v1/sessions/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.77' },
      body: JSON.stringify({ displayName: `NatUser2_${crypto.randomBytes(2).toString('hex')}` })
    });
    const g1Body: any = await g1Res.json();
    const g2Body: any = await g2Res.json();
    createdSessionIds.push(g1Body.data.session.id, g2Body.data.session.id);

    for (let i = 0; i < 2; i++) {
      const u1 = await fetch(`${proxied.baseUrl}/test/proxied-auth`, {
        headers: {
          Authorization: `Bearer ${g1Body.data.token}`,
          'X-Forwarded-For': '203.0.113.77'
        }
      });
      assert.equal(u1.status, 200);
    }
    const u1Over = await fetch(`${proxied.baseUrl}/test/proxied-auth`, {
      headers: {
        Authorization: `Bearer ${g1Body.data.token}`,
        'X-Forwarded-For': '203.0.113.77'
      }
    });
    assert.equal(u1Over.status, 429);

    // Second user behind exact same NAT IP still has full quota
    const u2Ok = await fetch(`${proxied.baseUrl}/test/proxied-auth`, {
      headers: {
        Authorization: `Bearer ${g2Body.data.token}`,
        'X-Forwarded-For': '203.0.113.77'
      }
    });
    assert.equal(u2Ok.status, 200);
    assert.equal(((await u2Ok.json()) as any).key, `session:${g2Body.data.session.id}`);
  } finally {
    await new Promise<void>((resolve) => proxied.server.close(() => resolve()));
    if (createdSessionIds.length > 0) {
      await prisma.guestSession.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
  }

  // ------------------------------------------------------------------
  // 4. Redis resilience & safe shutdown (Task 5)
  // ------------------------------------------------------------------
  const resilientDummy = new Redis('redis://127.0.0.1:63999', {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null
  });
  attachRedisLifecycleLogging(resilientDummy, 'TestDummy');
  // Emitting 'error' with lifecycle logger attached must NOT crash the process
  resilientDummy.emit('error', new Error('simulated connection blip'));
  await safeQuitRedis(resilientDummy, 'TestDummy');

  const cleanupKeys = await redis.keys('rl:test_proxy_*');
  if (cleanupKeys.length > 0) await redis.del(...cleanupKeys);

  // Also ensure config runtime loaded cleanly without throwing
  assert.ok(config.port > 0);
  console.log('✅ Phase 8B.1 deployment readiness tests passed (proxy, NAT isolation, Redis resilience, env validation, metadataBase).');
}

runPhase8DeployReadinessTests()
  .catch((err) => {
    console.error('❌ Phase 8B.1 test failure:', err);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectRedis();
    await prisma.$disconnect();
  });
