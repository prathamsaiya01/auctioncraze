// Set zero-cost env BEFORE importing config/app modules so dotenv preserves these overrides
process.env.ENABLE_REDIS = 'false';
process.env.ENABLE_ML_SERVICE = 'false';
process.env.REDIS_URL = '';
process.env.ML_SERVICE_URL = '';
process.env.INTERNAL_ML_SERVICE_KEY = '';

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { io as ioClient, Socket } from 'socket.io-client';
import { prisma } from '@auctioncraze/database';
import {
  AuctionMode,
  RoomRole,
  RoomStatus,
  RoomVisibility,
  SOCKET_EVENTS
} from '@auctioncraze/shared';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reqJson(
  baseUrl: string,
  method: string,
  route: string,
  token?: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; json: any }> {
  const url = route.startsWith('/health') ? `${baseUrl}${route}` : `${baseUrl}/api/v1${route}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extraHeaders || {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function connectSocket(baseUrl: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { auth: { token }, transports: ['websocket'] });
    const t = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket connect timeout'));
    }, 5000);
    socket.on('connect', () => {
      clearTimeout(t);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

function emitAck(socket: Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve) => socket.emit(event, payload, (ack: any) => resolve(ack)));
}

function waitForEvent(socket: Socket, eventName: string, timeoutMs = 6000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs);
    socket.once(eventName, (data: any) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

async function runZeroCostTests() {
  const { config, parseEnvConfig } = await import('../config/env');
  const { createApp } = await import('../app');
  const { connectRedis, disconnectRedis } = await import('../lib/redis');
  const { clearMemoryCoordinationStores, getMemoryCoordinationStats } = await import(
    '../lib/coordinationStore'
  );
  const { setupSocketServer, closeSocketServer } = await import('../sockets/socketServer');
  const { AuctionTimerManager } = await import('../modules/auction/timerManager');

  // ------------------------------------------------------------------
  // 1. Config: Production zero-cost startup + single-instance guard
  // ------------------------------------------------------------------
  assert.equal(config.enableRedis, false);
  assert.equal(config.enableMlService, false);

  const zeroCostProd = parseEnvConfig({
    NODE_ENV: 'production',
    ENABLE_REDIS: 'false',
    ENABLE_ML_SERVICE: 'false',
    CORS_ORIGIN: 'https://auctioncraze-free.netlify.app',
    DATABASE_URL: 'postgresql://user:pass@ep-cool-pool.neon.tech/auctioncraze_db?sslmode=require',
    JWT_SECRET: 'zero_cost_prod_jwt_' + 'k'.repeat(48)
  });
  assert.equal(zeroCostProd.enableRedis, false);
  assert.equal(zeroCostProd.enableMlService, false);
  assert.equal(zeroCostProd.trustProxyHops, 1);

  assert.throws(
    () =>
      parseEnvConfig({
        NODE_ENV: 'production',
        ENABLE_REDIS: 'false',
        ENABLE_ML_SERVICE: 'false',
        RENDER_INSTANCE_COUNT: '2',
        CORS_ORIGIN: 'https://auctioncraze-free.netlify.app',
        DATABASE_URL: 'postgresql://user:pass@ep-cool-pool.neon.tech/auctioncraze_db',
        JWT_SECRET: 'zero_cost_prod_jwt_' + 'k'.repeat(48)
      }),
    /single-instance/i
  );
  console.log('✓ Test 1: Zero-cost production config & horizontal-scaling block verified');

  await prisma.$connect();
  await connectRedis();
  clearMemoryCoordinationStores();

  const app = createApp();
  const server = http.createServer(app);
  await setupSocketServer(server);
  AuctionTimerManager.start(100);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const createdRoomCodes: string[] = [];
  const createdSessionIds: string[] = [];
  const sockets: Socket[] = [];

  try {
    // ------------------------------------------------------------------
    // 2. Idle scheduler & /health endpoint without Redis/ML
    // ------------------------------------------------------------------
    assert.equal(
      AuctionTimerManager.isSchedulerLoopActive(),
      false,
      'Timer loop must remain stopped (0 DB polling) when no active rooms exist'
    );

    const healthRes = await reqJson(baseUrl, 'GET', '/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.json.status, 'healthy');
    assert.equal(healthRes.json.mode, 'single-instance-memory');
    assert.equal(healthRes.json.dependencies.postgres, 'up');
    assert.equal(healthRes.json.dependencies.redis, 'disabled');
    assert.equal(healthRes.json.dependencies.ml, 'disabled');
    console.log('✓ Test 2: /health reports 200 healthy & timer scheduler stays idle without Redis');

    // Setup sessions & private/public rooms
    const createUser = async (name: string) => {
      const r = await reqJson(baseUrl, 'POST', '/sessions/guest', undefined, {
        displayName: `${name}_${crypto.randomBytes(2).toString('hex')}`
      });
      assert.equal(r.status, 201);
      createdSessionIds.push(r.json.data.session.id);
      return { token: r.json.data.token as string, sessionId: r.json.data.session.id as string };
    };

    const host = await createUser('ZCHost');
    const owner2 = await createUser('ZCOwner2');
    const owner3 = await createUser('ZCOwner3');
    const outsider = await createUser('ZCOutsider');

    const players = await prisma.masterPlayer.findMany({ take: 6, orderBy: { fullName: 'asc' } });
    assert.ok(players.length >= 4);

    // Create private room to verify invite-token + room isolation in Redis-free mode
    const privRes = await reqJson(baseUrl, 'POST', '/rooms', host.token, {
      roomName: 'Zero Cost Private Arena',
      visibility: RoomVisibility.PRIVATE,
      displayName: 'ZCHost',
      franchiseCode: 'CSK',
      settings: {
        minSquadSize: 1,
        maxSquadSize: 6,
        maxOverseas: 4,
        countdownSeconds: 5,
        bidExtensionSeconds: 0,
        extensionThresholdSeconds: 1
      }
    });
    assert.equal(privRes.status, 201);
    const room = privRes.json.data;
    createdRoomCodes.push(room.code);

    // ------------------------------------------------------------------
    // 3. Room isolation & Invite-token security without Redis
    // ------------------------------------------------------------------
    assert.equal((await reqJson(baseUrl, 'GET', `/rooms/${room.code}`, outsider.token)).status, 403);
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${room.code}/join`, outsider.token, {
          displayName: 'ZCOutsider',
          joinAs: RoomRole.OWNER,
          franchiseCode: 'MI',
          inviteToken: room.spectatorInviteToken
        })
      ).status,
      403
    );

    const outsiderSock = await connectSocket(baseUrl, outsider.token);
    sockets.push(outsiderSock);
    const joinBlockedAck = await emitAck(outsiderSock, SOCKET_EVENTS.ROOM_JOIN, { roomCode: room.code });
    assert.equal(joinBlockedAck.ok, false);
    assert.equal(joinBlockedAck.code, 'NOT_A_MEMBER');

    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${room.code}/join`, owner2.token, {
          displayName: 'ZCOwner2',
          joinAs: RoomRole.OWNER,
          franchiseCode: 'MI',
          inviteToken: room.inviteToken
        })
      ).status,
      200
    );
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${room.code}/join`, owner3.token, {
          displayName: 'ZCOwner3',
          joinAs: RoomRole.OWNER,
          franchiseCode: 'RCB',
          inviteToken: room.inviteToken
        })
      ).status,
      200
    );
    console.log('✓ Test 3: Private invite-token security & room isolation verified without Redis');

    // ------------------------------------------------------------------
    // 4. ML disabled (503 ML_SERVICE_DISABLED)
    // ------------------------------------------------------------------
    const mlRes = await reqJson(
      baseUrl,
      'GET',
      `/intelligence/rooms/${room.code}/ratings/leaderboard`,
      host.token
    );
    assert.equal(mlRes.status, 503);
    assert.equal(mlRes.json.code, 'ML_SERVICE_DISABLED');
    console.log('✓ Test 4: ML endpoints fail gracefully with 503 ML_SERVICE_DISABLED');

    // Configure pool & start auction
    const poolPutRes = await reqJson(baseUrl, 'PUT', `/rooms/${room.code}/pool`, host.token, {
      lots: players.slice(0, 4).map((p, idx) => ({
        playerId: p.id,
        setCategory: 'MARQUEE',
        basePriceLakhs: 100,
        sequenceOrder: idx + 1
      }))
    });
    assert.equal(poolPutRes.status, 200);
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${room.code}/config/finalize`, host.token, {})).status, 200);
    assert.equal((await reqJson(baseUrl, 'PATCH', `/rooms/${room.code}/ready`, host.token, { isReady: true })).status, 200);
    assert.equal((await reqJson(baseUrl, 'PATCH', `/rooms/${room.code}/ready`, owner2.token, { isReady: true })).status, 200);
    assert.equal((await reqJson(baseUrl, 'PATCH', `/rooms/${room.code}/ready`, owner3.token, { isReady: true })).status, 200);
    const startRes = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/start`, host.token, {});
    assert.equal(startRes.status, 200);
    assert.equal(AuctionTimerManager.isSchedulerLoopActive(), true, 'Scheduler loop wakes on LIVE lot');

    // ------------------------------------------------------------------
    // 5. Two tabs for 1 participant (multi-tab presence in-memory)
    // ------------------------------------------------------------------
    const miTab1 = await connectSocket(baseUrl, owner2.token);
    const miTab2 = await connectSocket(baseUrl, owner2.token);
    const rcbSock = await connectSocket(baseUrl, owner3.token);
    sockets.push(miTab1, miTab2, rcbSock);

    assert.equal((await emitAck(miTab1, SOCKET_EVENTS.ROOM_JOIN, { roomCode: room.code })).ok, true);
    assert.equal((await emitAck(miTab2, SOCKET_EVENTS.ROOM_JOIN, { roomCode: room.code })).ok, true);
    assert.equal((await emitAck(rcbSock, SOCKET_EVENTS.ROOM_JOIN, { roomCode: room.code })).ok, true);

    // Close Tab 1; Tab 2 remains connected so MI must stay isConnected=true and be able to bid!
    miTab1.disconnect();
    await sleep(150);

    const miParticipantAfterTab1 = await prisma.roomParticipant.findFirstOrThrow({
      where: { guestSessionId: owner2.sessionId }
    });
    assert.equal(miParticipantAfterTab1.isConnected, true, 'Closing 1 of 2 tabs must keep participant connected');

    // ------------------------------------------------------------------
    // 6. Simultaneous bidding without Redis
    // ------------------------------------------------------------------
    const activeLotId = startRes.json.data.currentLot.id as string;
    const baseBid = startRes.json.data.currentLot.nextBidLakhs as number;
    const [bMi, bRcb] = await Promise.all([
      emitAck(miTab2, SOCKET_EVENTS.BID_SUBMIT, {
        roomCode: room.code,
        lotId: activeLotId,
        bidAmountLakhs: baseBid,
        idempotencyKey: `zc-mi-${Date.now()}`
      }),
      emitAck(rcbSock, SOCKET_EVENTS.BID_SUBMIT, {
        roomCode: room.code,
        lotId: activeLotId,
        bidAmountLakhs: baseBid,
        idempotencyKey: `zc-rcb-${Date.now()}`
      })
    ]);
    assert.equal([bMi.ok, bRcb.ok].filter(Boolean).length, 1, 'Exactly 1 concurrent equal bid wins via FOR UPDATE lock');

    // Close Tab 2 -> now MI has 0 tabs open -> isConnected flips to false
    miTab2.disconnect();
    await sleep(150);
    const miParticipantAfterTab2 = await prisma.roomParticipant.findFirstOrThrow({
      where: { guestSessionId: owner2.sessionId }
    });
    assert.equal(miParticipantAfterTab2.isConnected, false, 'Closing last tab must mark participant disconnected');
    console.log('✓ Test 5 & 6: Multi-tab presence & simultaneous bidding verified without Redis');

    // ------------------------------------------------------------------
    // 7. Timer expiry -> BIDDING_CLOSED without auto-selling + Host SOLD
    // ------------------------------------------------------------------
    const closedPromise = waitForEvent(rcbSock, SOCKET_EVENTS.BIDDING_CLOSED, 10000);
    const closedEvent = await closedPromise;
    assert.equal(closedEvent.lotId, activeLotId);

    const afterExpiry = await reqJson(baseUrl, 'GET', `/rooms/${room.code}/auction`, host.token);
    assert.equal(afterExpiry.json.data.auctionStage, 'BIDDING_CLOSED');
    assert.equal(
      await prisma.purchase.count({ where: { lotId: activeLotId } }),
      0,
      'Expired lot must NEVER auto-sell'
    );
    assert.equal(
      AuctionTimerManager.isSchedulerLoopActive(),
      false,
      'Scheduler loop returns idle (0 DB polling) once lot closes'
    );

    const soldRes = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/sold`, host.token, {
      lotId: activeLotId
    });
    assert.equal(soldRes.status, 200);
    assert.equal(await prisma.purchase.count({ where: { lotId: activeLotId } }), 1);
    console.log('✓ Test 7: Timer expiry -> BIDDING_CLOSED (no auto-sell) + Host SOLD + idle stop verified');

    // ------------------------------------------------------------------
    // 8. Timer restart recovery (LIVE and PAUSED) from PostgreSQL
    // ------------------------------------------------------------------
    const nextRes = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/next`, host.token, {});
    assert.equal(nextRes.status, 200);

    // Pause Lot #2, wipe in-memory scheduler & restart, verify PAUSED preserved, then resume & restart LIVE
    const pauseRes = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/pause`, host.token, {});
    assert.equal(pauseRes.status, 200);
    const pausedRemMs = (await prisma.room.findUniqueOrThrow({ where: { code: room.code } }))
      .timerRemainingMs;

    AuctionTimerManager.stop();
    AuctionTimerManager.start(100);
    const recoveredPaused = await AuctionTimerManager.recoverActiveTimersOnBoot();
    assert.ok(recoveredPaused >= 1);
    const memPaused = AuctionTimerManager.getMemoryTimerState(room.code);
    assert.equal(memPaused?.status, 'PAUSED');
    assert.equal(memPaused?.remainingMs, pausedRemMs);

    const resumeRes = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/resume`, host.token, {});
    assert.equal(resumeRes.status, 200);
    const liveDeadline = Number(
      (await prisma.room.findUniqueOrThrow({ where: { code: room.code } })).timerDeadlineMs
    );

    AuctionTimerManager.stop();
    AuctionTimerManager.start(100);
    const recoveredLive = await AuctionTimerManager.recoverActiveTimersOnBoot();
    assert.ok(recoveredLive >= 1);
    const memLive = AuctionTimerManager.getMemoryTimerState(room.code);
    assert.equal(memLive?.status, 'RUNNING');
    assert.equal(memLive?.deadlineMs, liveDeadline);
    console.log('✓ Test 8: Timer restart recovery restored both PAUSED and LIVE timers from PostgreSQL');

    // ------------------------------------------------------------------
    // 9. Chat anti-spam without Redis
    // ------------------------------------------------------------------
    const msg1 = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/chat`, host.token, {
      message: 'Zero-cost chat check!'
    });
    assert.equal(msg1.status, 201);
    const dupMsg = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/chat`, host.token, {
      message: 'Zero-cost chat check!'
    });
    assert.equal(dupMsg.status, 429, 'Duplicate back-to-back chat must be blocked in-memory');

    let hitChatRateLimit = false;
    for (let i = 0; i < 10; i++) {
      const r = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/chat`, host.token, {
        message: `Unique burst message ${i}`
      });
      if (r.status === 429) {
        hitChatRateLimit = true;
        break;
      }
    }
    assert.equal(hitChatRateLimit, true, 'Chat 8/10s rate limit must trigger without Redis');

    // ------------------------------------------------------------------
    // 10. HTTP Rate limiting without Redis (bounded memory store)
    // ------------------------------------------------------------------
    clearMemoryCoordinationStores();
    let hitHttpLimit = false;
    for (let i = 0; i < 35; i++) {
      const r = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/join`, outsider.token, {
        displayName: 'ZCOutsider',
        joinAs: RoomRole.SPECTATOR
      });
      if (r.status === 429) {
        hitHttpLimit = true;
        break;
      }
    }
    assert.equal(hitHttpLimit, true, 'HTTP rate limit must enforce 429 cleanly without Redis');
    const memStats = getMemoryCoordinationStats();
    assert.ok(memStats.counters <= 10_000 && memStats.presenceKeys <= 10_000);
    console.log('✓ Test 9 & 10: Chat anti-spam & HTTP rate limiting verified without Redis');
  } finally {
    AuctionTimerManager.stop();
    for (const s of sockets) s.disconnect();
    await closeSocketServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    if (createdRoomCodes.length > 0) {
      await prisma.room.deleteMany({ where: { code: { in: createdRoomCodes } } });
    }
    if (createdSessionIds.length > 0) {
      await prisma.guestSession.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    clearMemoryCoordinationStores();
    await disconnectRedis();
    await prisma.$disconnect();
  }

  console.log('\n🎉 All Phase 8C.2 Zero-Cost Redis-Optional & ML-Optional tests passed!');
}

runZeroCostTests().catch((err) => {
  console.error('❌ Phase 8C.2 test failed:', err);
  process.exit(1);
});
