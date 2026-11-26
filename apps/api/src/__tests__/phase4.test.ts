import assert from 'node:assert/strict';
import http from 'node:http';
import { io as ioClient, Socket } from 'socket.io-client';
import { prisma } from '@auctioncraze/database';
import {
  AuctionMode,
  DEFAULT_BID_TIERS_LAKHS,
  LotStatus,
  RoomRole,
  RoomStatus,
  RoomVisibility,
  SOCKET_EVENTS
} from '@auctioncraze/shared';
import { createApp } from '../app';
import { config } from '../config/env';
import { clearRateLimitEntriesForTest } from '../lib/coordinationStore';
import { connectRedis, disconnectRedis, redis } from '../lib/redis';
import { closeSocketServer, setupSocketServer } from '../sockets/socketServer';
import { AuctionTimerManager } from '../modules/auction/timerManager';

interface GuestClient {
  token: string;
  sessionId: string;
}

async function createGuest(baseUrl: string, displayName: string): Promise<GuestClient> {
  const res = await fetch(`${baseUrl}/api/v1/sessions/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  assert.equal(res.status, 201);
  const body: any = await res.json();
  return { token: body.data.token, sessionId: body.data.session.id };
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

function waitForEvent<T = any>(socket: Socket, eventName: string, timeoutMs = 4500): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timed out waiting for socket event '${eventName}'`));
    }, timeoutMs);
    const handler = (data: T) => {
      clearTimeout(timer);
      resolve(data);
    };
    socket.once(eventName, handler);
  });
}

async function joinSocketRoom(socket: Socket, roomCode: string): Promise<any> {
  const joined = waitForEvent(socket, SOCKET_EVENTS.ROOM_JOINED, 4500);
  socket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode });
  return joined;
}

async function apiPost(baseUrl: string, path: string, token: string, body: unknown = {}) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const json: any = await res.json();
  return { status: res.status, json };
}

async function apiPut(baseUrl: string, path: string, token: string, body: unknown = {}) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const json: any = await res.json();
  return { status: res.status, json };
}

async function apiPatch(baseUrl: string, path: string, token: string, body: unknown = {}) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const json: any = await res.json();
  return { status: res.status, json };
}

async function apiGet(baseUrl: string, path: string, token: string) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const json: any = await res.json();
  return { status: res.status, json };
}

async function runPhase4Tests() {
  await prisma.$connect();
  await connectRedis();
  await clearRateLimitEntriesForTest('rl:*');
  await prisma.room.deleteMany({
    where: { name: { in: ['Phase 4 Championship Room', 'Room 2 Constrained Purse'] } }
  });

  const app = createApp();
  const server = http.createServer(app);
  await setupSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind server');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  AuctionTimerManager.start(150);

  const createdRoomIds: string[] = [];
  const sockets: Socket[] = [];

  try {
    // Load 4 master players for deterministic pool configuration
    const catalogRes = await fetch(`${baseUrl}/api/v1/players/catalog?limit=10`);
    assert.equal(catalogRes.status, 200);
    const catalogJson: any = await catalogRes.json();
    const poolPlayers = catalogJson.data.slice(0, 4);
    assert.equal(poolPlayers.length, 4, 'Expected at least 4 seeded master players');

    const host = await createGuest(baseUrl, 'P4 Host CSK');
    const owner2 = await createGuest(baseUrl, 'P4 Owner MI');
    const spectator = await createGuest(baseUrl, 'P4 Spectator');

    // Create Room 1
    const createRes = await apiPost(baseUrl, '/rooms', host.token, {
      roomName: 'Phase 4 Championship Room',
      visibility: RoomVisibility.PUBLIC,
      displayName: 'P4 Host CSK',
      franchiseCode: 'CSK',
      settings: {
        initialPurseLakhs: 10000,
        minSquadSize: 1,
        maxSquadSize: 4,
        maxOverseas: 2,
        countdownSeconds: 15,
        bidExtensionSeconds: 4,
        extensionThresholdSeconds: 4,
        allowHostSkip: true
      }
    });
    assert.equal(createRes.status, 201);
    const room1 = createRes.json.data;
    createdRoomIds.push(room1.id);

    // Owner2 & Spectator join Room 1
    const j2 = await apiPost(baseUrl, `/rooms/${room1.code}/join`, owner2.token, {
      displayName: 'P4 Owner MI',
      joinAs: RoomRole.OWNER,
      franchiseCode: 'MI'
    });
    assert.equal(j2.status, 200);

    const jSpec = await apiPost(baseUrl, `/rooms/${room1.code}/join`, spectator.token, {
      displayName: 'P4 Spectator',
      joinAs: RoomRole.SPECTATOR
    });
    assert.equal(jSpec.status, 200);

    // Configure compact 4-player pool with explicit base price 100 Lakhs (1 Cr)
    const poolRes = await apiPut(baseUrl, `/rooms/${room1.code}/pool`, host.token, {
      lots: poolPlayers.map((p: any, idx: number) => ({
        playerId: p.id,
        setCategory: idx < 2 ? 'MARQUEE' : 'BATTERS',
        basePriceLakhs: 100,
        sequenceOrder: idx + 1
      }))
    });
    assert.equal(poolRes.status, 200);

    // Finalize config & mark both owners ready
    const finRes = await apiPost(baseUrl, `/rooms/${room1.code}/config/finalize`, host.token, {});
    assert.equal(finRes.status, 200);
    assert.equal((await apiPatch(baseUrl, `/rooms/${room1.code}/ready`, host.token, { isReady: true })).status, 200);
    assert.equal((await apiPatch(baseUrl, `/rooms/${room1.code}/ready`, owner2.token, { isReady: true })).status, 200);

    // Connect all 3 sockets and join Room 1
    const hostSock = await connectSocket(baseUrl, host.token);
    const owner2Sock = await connectSocket(baseUrl, owner2.token);
    const specSock = await connectSocket(baseUrl, spectator.token);
    sockets.push(hostSock, owner2Sock, specSock);

    await Promise.all([
      joinSocketRoom(hostSock, room1.code),
      joinSocketRoom(owner2Sock, room1.code),
      joinSocketRoom(specSock, room1.code)
    ]);

    // 1. Non-host cannot start auction or execute host controls
    const nonHostStart = await apiPost(baseUrl, `/rooms/${room1.code}/auction/start`, owner2.token, {});
    assert.equal(nonHostStart.status, 403);
    console.log('✓ Test 1: Unauthorized non-host start rejected (403)');

    // 2. Host starts auction -> AUCTION_STARTED broadcast
    const ownerStartedPromise = waitForEvent(owner2Sock, SOCKET_EVENTS.AUCTION_STARTED);
    const startRes = await apiPost(baseUrl, `/rooms/${room1.code}/auction/start`, host.token, {});
    assert.equal(startRes.status, 200);
    await ownerStartedPromise;
    const snap1 = startRes.json.data;
    assert.equal(snap1.auctionStage, 'LIVE');
    assert.equal(snap1.currentLot.sequenceOrder, 1);
    assert.equal(snap1.currentLot.nextBidLakhs, 100);
    const lot1Id = snap1.currentLot.id;
    console.log('✓ Test 2: Host started auction and all participants received AUCTION_STARTED');

    // Non-host host-controls rejected during live auction
    assert.equal((await apiPost(baseUrl, `/rooms/${room1.code}/auction/pause`, owner2.token, {})).status, 403);
    assert.equal((await apiPost(baseUrl, `/rooms/${room1.code}/auction/sold`, owner2.token, { lotId: lot1Id })).status, 403);
    assert.equal((await apiPost(baseUrl, `/rooms/${room1.code}/auction/unsold`, owner2.token, { lotId: lot1Id })).status, 403);
    assert.equal((await apiPost(baseUrl, `/rooms/${room1.code}/auction/next`, owner2.token, {})).status, 403);
    assert.equal((await apiPost(baseUrl, `/rooms/${room1.code}/auction/skip`, owner2.token, {})).status, 403);

    // 3. Spectator bid rejected
    const specBid = await apiPost(baseUrl, `/rooms/${room1.code}/auction/bids`, spectator.token, {
      lotId: lot1Id,
      bidAmountLakhs: 100,
      idempotencyKey: 'spec-attempt-1'
    });
    assert.equal(specBid.status, 403);
    console.log('✓ Test 3: Spectator bid rejected (403)');

    // 4. Simultaneous competing bids at exact same amount (100L) -> 1 succeeds, 1 rejects cleanly
    const bidBroadcastPromise = waitForEvent(specSock, SOCKET_EVENTS.BID_PLACED);
    const [rHostBid, rOwner2Bid] = await Promise.all([
      apiPost(baseUrl, `/rooms/${room1.code}/auction/bids`, host.token, {
        lotId: lot1Id,
        bidAmountLakhs: 100,
        idempotencyKey: 'race-host-100'
      }),
      apiPost(baseUrl, `/rooms/${room1.code}/auction/bids`, owner2.token, {
        lotId: lot1Id,
        bidAmountLakhs: 100,
        idempotencyKey: 'race-mi-100'
      })
    ]);
    const raceStatuses = [rHostBid.status, rOwner2Bid.status].sort();
    assert.equal(raceStatuses.filter((s) => s === 201).length, 1, 'Exactly one simultaneous equal bid may succeed');
    await bidBroadcastPromise;
    console.log('✓ Test 4: Simultaneous competing bids serialized atomically with single winner');

    // Determine who currently leads vs trails
    const afterRaceState = (await apiGet(baseUrl, `/rooms/${room1.code}/auction`, host.token)).json.data;
    const leaderIsHost = afterRaceState.currentLot.winningFranchiseCode === 'CSK';
    const trailingToken = leaderIsHost ? owner2.token : host.token;
    const leadingToken = leaderIsHost ? host.token : owner2.token;

    // Leader cannot outbid themselves
    const selfBid = await apiPost(baseUrl, `/rooms/${room1.code}/auction/bids`, leadingToken, {
      lotId: lot1Id,
      bidAmountLakhs: afterRaceState.currentLot.nextBidLakhs,
      idempotencyKey: 'self-bid-reject'
    });
    assert.ok(selfBid.status >= 400 && selfBid.status < 500);

    // 5. Invalid increment rejection (bidding below nextBidLakhs = 110)
    const badIncBid = await apiPost(baseUrl, `/rooms/${room1.code}/auction/bids`, trailingToken, {
      lotId: lot1Id,
      bidAmountLakhs: 105,
      idempotencyKey: 'bad-inc-105'
    });
    assert.equal(badIncBid.status, 400);
    console.log('✓ Test 5: Invalid bid increment and self-outbid rejected');

    // 6. Trailing owner places valid counter-bid; if Host trails, verifies Host equal-footing bid; otherwise MI leads and Host counter-bids next!
    const validStep1 = await apiPost(baseUrl, `/rooms/${room1.code}/auction/bids`, trailingToken, {
      lotId: lot1Id,
      bidAmountLakhs: afterRaceState.currentLot.nextBidLakhs,
      idempotencyKey: 'valid-counter-1'
    });
    assert.equal(validStep1.status, 201);

    // Guarantee Host places at least one valid counter-bid if Host won the initial race
    if (leaderIsHost) {
      const s2 = (await apiGet(baseUrl, `/rooms/${room1.code}/auction`, host.token)).json.data;
      const hostBid2 = await apiPost(baseUrl, `/rooms/${room1.code}/auction/bids`, host.token, {
        lotId: lot1Id,
        bidAmountLakhs: s2.currentLot.nextBidLakhs,
        idempotencyKey: 'host-parity-bid-2'
      });
      assert.equal(hostBid2.status, 201);
    }
    console.log('✓ Test 6: Host bids cleanly on equal terms with non-host owners');

    // 7. Pause stops bidding -> Resume restores bidding
    const pausedEvt = waitForEvent(owner2Sock, SOCKET_EVENTS.AUCTION_PAUSED);
    const pauseRes = await apiPost(baseUrl, `/rooms/${room1.code}/auction/pause`, host.token, {});
    assert.equal(pauseRes.status, 200);
    await pausedEvt;

    const pausedState = pauseRes.json.data;
    const nextBidderToken = pausedState.currentLot.winningFranchiseCode === 'CSK' ? owner2.token : host.token;
    const bidWhilePaused = await apiPost(baseUrl, `/rooms/${room1.code}/auction/bids`, nextBidderToken, {
      lotId: lot1Id,
      bidAmountLakhs: pausedState.currentLot.nextBidLakhs,
      idempotencyKey: 'bid-while-paused'
    });
    assert.equal(bidWhilePaused.status, 409);

    const resumedEvt = waitForEvent(owner2Sock, SOCKET_EVENTS.AUCTION_RESUMED);
    const resumeRes = await apiPost(baseUrl, `/rooms/${room1.code}/auction/resume`, host.token, {});
    assert.equal(resumeRes.status, 200);
    await resumedEvt;
    console.log('✓ Test 7: Bidding rejected during pause and restored on resume');

    // 8. Timer expiry transitions to BIDDING_CLOSED without auto-selling
    const expiredAt = BigInt(Date.now() - 500);
    await prisma.room.update({
      where: { id: room1.id },
      data: { timerDeadlineMs: expiredAt }
    });
    await AuctionTimerManager.setRunningTimer(room1.code, lot1Id, Number(expiredAt));

    const closedEvtPromise = waitForEvent(owner2Sock, SOCKET_EVENTS.BIDDING_CLOSED);
    await AuctionTimerManager.processExpiredTimers();
    const closedEvt = await closedEvtPromise;
    assert.equal(closedEvt.lotId, lot1Id);

    const lot1AfterClose = await prisma.roomPlayerLot.findUnique({ where: { id: lot1Id } });
    assert.equal(lot1AfterClose?.status, LotStatus.BIDDING_CLOSED);
    const purchasesBeforeManual = await prisma.purchase.count({ where: { roomId: room1.id } });
    assert.equal(purchasesBeforeManual, 0, 'Timer expiry must NEVER auto-sell player');

    // Bids rejected when BIDDING_CLOSED
    const bidWhenClosed = await apiPost(baseUrl, `/rooms/${room1.code}/auction/bids`, nextBidderToken, {
      lotId: lot1Id,
      bidAmountLakhs: pausedState.currentLot.nextBidLakhs,
      idempotencyKey: 'bid-after-close'
    });
    assert.equal(bidWhenClosed.status, 409);
    console.log('✓ Test 8: Timer expiry transitioned to BIDDING_CLOSED (no auto-sell) and blocked late bids');

    // 9. Host manually confirms SOLD after timer expiry + updates purse & squad
    const soldEvtPromise = waitForEvent(specSock, SOCKET_EVENTS.PLAYER_SOLD);
    const soldRes = await apiPost(baseUrl, `/rooms/${room1.code}/auction/sold`, host.token, {
      lotId: lot1Id
    });
    assert.equal(soldRes.status, 200);
    const soldEvt = await soldEvtPromise;
    assert.equal(soldEvt.lotId, lot1Id);

    const stateAfterSold = soldRes.json.data;
    const winningFranchise = stateAfterSold.franchises.find(
      (f: any) => f.id === stateAfterSold.currentLot.winningFranchiseId
    );
    assert.equal(winningFranchise.squadCount, 1);
    assert.equal(
      winningFranchise.remainingPurseLakhs,
      10000 - stateAfterSold.currentLot.currentBidLakhs
    );

    // 10. Duplicate SOLD idempotency check
    const dupSoldRes = await apiPost(baseUrl, `/rooms/${room1.code}/auction/sold`, host.token, {
      lotId: lot1Id
    });
    assert.equal(dupSoldRes.status, 200);
    const purchasesAfterDup = await prisma.purchase.count({ where: { roomId: room1.id } });
    assert.equal(purchasesAfterDup, 1, 'Duplicate SOLD must remain idempotent');
    console.log('✓ Test 9 & 10: Manual SOLD post-expiry updated purse/squad and duplicate SOLD was idempotent');

    // 11. Host advances to Lot #2 -> marks UNSOLD -> duplicate UNSOLD idempotent
    const lot2EvtPromise = waitForEvent(owner2Sock, SOCKET_EVENTS.PLAYER_LOT_STARTED);
    const nextRes = await apiPost(baseUrl, `/rooms/${room1.code}/auction/next`, host.token, {});
    assert.equal(nextRes.status, 200);
    const lot2Evt = await lot2EvtPromise;
    const lot2Id = lot2Evt.currentLot.id;
    assert.notEqual(lot2Id, lot1Id);

    const unsoldEvtPromise = waitForEvent(specSock, SOCKET_EVENTS.PLAYER_UNSOLD);
    const unsoldRes = await apiPost(baseUrl, `/rooms/${room1.code}/auction/unsold`, host.token, {
      lotId: lot2Id
    });
    assert.equal(unsoldRes.status, 200);
    await unsoldEvtPromise;

    const dupUnsoldRes = await apiPost(baseUrl, `/rooms/${room1.code}/auction/unsold`, host.token, {
      lotId: lot2Id
    });
    assert.equal(dupUnsoldRes.status, 200);
    assert.equal(dupUnsoldRes.json.data.auctionStage, 'PLAYER_UNSOLD');
    console.log('✓ Test 11: Next player + UNSOLD + duplicate UNSOLD idempotency verified');

    // Advance to Lot #3 so Room 1 stays LIVE for timer recovery & reconnection checks
    await apiPost(baseUrl, `/rooms/${room1.code}/auction/next`, host.token, {});

    // 12. Timer recovery after simulated server restart
    if (config.enableRedis) {
      await redis.del('auction:active_timers', `auction:timer:${room1.code}`);
      const recoveredCount = await AuctionTimerManager.recoverActiveTimersOnBoot();
      assert.ok(recoveredCount >= 1, 'Expected at least 1 active room timer to recover from DB');
      const restoredZScore = await redis.zscore('auction:active_timers', room1.code);
      assert.ok(restoredZScore !== null, 'Expected recovered timer in Redis ZSET');
    } else {
      await AuctionTimerManager.clearTimer(room1.code);
      const recoveredCount = await AuctionTimerManager.recoverActiveTimersOnBoot();
      assert.ok(recoveredCount >= 1, 'Expected at least 1 active room timer to recover from DB');
      const restoredState = AuctionTimerManager.getMemoryTimerState(room1.code);
      assert.ok(restoredState !== null, 'Expected recovered timer in single-instance memory store');
    }
    console.log('✓ Test 12: Active timer recovered from PostgreSQL after timer store reset');

    // 13. Reconnection state recovery via fresh socket ROOM_JOIN
    const reconnectSock = await connectSocket(baseUrl, owner2.token);
    sockets.push(reconnectSock);
    const recoveryStatePromise = waitForEvent(reconnectSock, SOCKET_EVENTS.AUCTION_STATE);
    await joinSocketRoom(reconnectSock, room1.code);
    const recoveryState = await recoveryStatePromise;
    assert.equal(recoveryState.roomCode, room1.code);
    assert.equal(recoveryState.auctionStage, 'LIVE');
    assert.equal(recoveryState.currentLot.sequenceOrder, 3);
    assert.ok(recoveryState.timer.deadlineMs > Date.now());
    console.log('✓ Test 13: Reconnecting socket received full AUCTION_STATE + live deadlineMs');

    // 14. Two independent rooms + Insufficient purse rejection in Room 2
    const host2 = await createGuest(baseUrl, 'R2 Host RCB');
    const ownerR2 = await createGuest(baseUrl, 'R2 Owner KKR');
    const c2 = await apiPost(baseUrl, '/rooms', host2.token, {
      roomName: 'Room 2 Constrained Purse',
      visibility: RoomVisibility.PUBLIC,
      displayName: 'R2 Host RCB',
      franchiseCode: 'RCB',
      settings: {
        initialPurseLakhs: 1000,
        minSquadSize: 1,
        maxSquadSize: 3,
        maxOverseas: 2,
        countdownSeconds: 20,
        bidExtensionSeconds: 5,
        extensionThresholdSeconds: 5,
        allowHostSkip: true
      }
    });
    assert.equal(c2.status, 201);
    const room2 = c2.json.data;
    createdRoomIds.push(room2.id);

    assert.equal(
      (
        await apiPost(baseUrl, `/rooms/${room2.code}/join`, ownerR2.token, {
          displayName: 'R2 Owner KKR',
          joinAs: RoomRole.OWNER,
          franchiseCode: 'KKR'
        })
      ).status,
      200
    );

    // Lower KKR purse adjustment so KKR has only 50 Lakhs total remaining purse against 100 Lakhs base price
    const adjRes = await apiPatch(baseUrl, `/rooms/${room2.code}/config`, host2.token, {
      auctionMode: AuctionMode.CUSTOM,
      initialPurseLakhs: 1000,
      minSquadSize: 1,
      maxSquadSize: 3,
      maxOverseas: 2,
      maxSpectators: 10,
      minOwnersRequired: 2,
      defaultBasePriceLakhs: 100,
      bidIncrementTiers: [...DEFAULT_BID_TIERS_LAKHS],
      countdownSeconds: 20,
      allowLateBidExtension: true,
      bidExtensionSeconds: 5,
      extensionThresholdSeconds: 5,
      allowHostSkip: true,
      allowTeamPurseAdjustments: true,
      retentionEnabled: false,
      maxRetentionsPerFranchise: 0,
      maxOverseasRetentions: 0,
      franchisePurseAdjustments: [{ franchiseCode: 'KKR', adjustmentLakhs: -950 }]
    });
    assert.equal(adjRes.status, 200);

    await apiPut(baseUrl, `/rooms/${room2.code}/pool`, host2.token, {
      lots: poolPlayers.slice(0, 2).map((p: any, idx: number) => ({
        playerId: p.id,
        setCategory: 'MARQUEE',
        basePriceLakhs: 100,
        sequenceOrder: idx + 1
      }))
    });
    await apiPost(baseUrl, `/rooms/${room2.code}/config/finalize`, host2.token, {});
    await apiPatch(baseUrl, `/rooms/${room2.code}/ready`, host2.token, { isReady: true });
    await apiPatch(baseUrl, `/rooms/${room2.code}/ready`, ownerR2.token, { isReady: true });

    const r2HostSock = await connectSocket(baseUrl, host2.token);
    const r2OwnerSock = await connectSocket(baseUrl, ownerR2.token);
    sockets.push(r2HostSock, r2OwnerSock);
    await Promise.all([
      joinSocketRoom(r2HostSock, room2.code),
      joinSocketRoom(r2OwnerSock, room2.code)
    ]);

    let leakedToRoom1 = false;
    specSock.once(SOCKET_EVENTS.AUCTION_STARTED, () => {
      leakedToRoom1 = true;
    });

    const r2Start = await apiPost(baseUrl, `/rooms/${room2.code}/auction/start`, host2.token, {});
    assert.equal(r2Start.status, 200);
    const r2LotId = r2Start.json.data.currentLot.id;

    // KKR has 50 Lakhs remaining purse -> bidding 100 Lakhs must fail
    const poorBid = await apiPost(baseUrl, `/rooms/${room2.code}/auction/bids`, ownerR2.token, {
      lotId: r2LotId,
      bidAmountLakhs: 100,
      idempotencyKey: 'kkr-poor-bid'
    });
    assert.equal(poorBid.status, 400);

    // Wait briefly to confirm zero cross-room Socket.IO leakage into Room 1
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(leakedToRoom1, false, 'Room 2 socket events must never leak into Room 1');
    console.log('✓ Test 14: Insufficient purse rejected & dual independent rooms isolated');

    console.log('ALL PHASE 4 TESTS PASSED (14/14)');
  } finally {
    AuctionTimerManager.stop();
    for (const s of sockets) {
      s.disconnect();
    }
    if (createdRoomIds.length > 0) {
      await prisma.room.deleteMany({ where: { id: { in: createdRoomIds } } });
    }
    await closeSocketServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectRedis();
    await prisma.$disconnect();
  }
}

runPhase4Tests().catch((err) => {
  console.error('Phase 4 tests failed:', err);
  process.exit(1);
});
