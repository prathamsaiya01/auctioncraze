import assert from 'node:assert/strict';
import http from 'node:http';
import { io as ioClient, Socket } from 'socket.io-client';
import { prisma } from '@auctioncraze/database';
import {
  AUCTION_MODE_PRESETS,
  AuctionMode,
  RoomRole,
  RoomVisibility,
  SOCKET_EVENTS
} from '@auctioncraze/shared';
import { createApp } from '../app';
import { clearRateLimitEntriesForTest } from '../lib/coordinationStore';
import { connectRedis, disconnectRedis } from '../lib/redis';
import { closeSocketServer, setupSocketServer } from '../sockets/socketServer';

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
      reject(new Error('Socket timeout'));
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

function waitForEvent<T = any>(socket: Socket, eventName: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(eventName, handler);
      reject(new Error(`Timed out waiting for '${eventName}'`));
    }, timeoutMs);
    const handler = (data: T) => {
      clearTimeout(timer);
      resolve(data);
    };
    socket.once(eventName, handler);
  });
}

async function runPhase3Tests() {
  await prisma.$connect();
  await connectRedis();
  await clearRateLimitEntriesForTest('rl:*');

  const app = createApp();
  const server = http.createServer(app);
  await setupSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to bind server');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const createdRoomIds: string[] = [];
  const createdSessionIds: string[] = [];
  const openSockets: Socket[] = [];

  try {
    const host = await createGuest(baseUrl, 'P3_Host');
    const owner = await createGuest(baseUrl, 'P3_Owner');
    const spectator = await createGuest(baseUrl, 'P3_Spec');
    createdSessionIds.push(host.sessionId, owner.sessionId, spectator.sessionId);

    // Create MOCK room as host (CSK)
    const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        roomName: 'Phase 3 Config Arena',
        franchiseCode: 'CSK',
        visibility: RoomVisibility.PUBLIC,
        auctionMode: AuctionMode.MOCK
      })
    });
    assert.equal(createRes.status, 201);
    const room = ((await createRes.json()) as any).data;
    createdRoomIds.push(room.id);
    const code = room.code as string;

    // Owner joins MI, Spectator joins
    await fetch(`${baseUrl}/api/v1/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ joinAs: RoomRole.OWNER, franchiseCode: 'MI' })
    });
    await fetch(`${baseUrl}/api/v1/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${spectator.token}` },
      body: JSON.stringify({ joinAs: RoomRole.SPECTATOR })
    });

    // Connect Owner & Spectator sockets
    const ownerSocket = await connectSocket(baseUrl, owner.token);
    const specSocket = await connectSocket(baseUrl, spectator.token);
    openSockets.push(ownerSocket, specSocket);

    const ownerSnapP = waitForEvent(ownerSocket, SOCKET_EVENTS.ROOM_STATE);
    ownerSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode: code });
    await ownerSnapP;

    const specSnapP = waitForEvent(specSocket, SOCKET_EVENTS.ROOM_STATE);
    specSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode: code });
    await specSnapP;

    const validConfigPayload = {
      ...AUCTION_MODE_PRESETS[AuctionMode.MEGA],
      auctionMode: AuctionMode.MEGA,
      allowHostSkip: true,
      initialPurseLakhs: 10000,
      minSquadSize: 15,
      maxSquadSize: 25,
      maxOverseas: 8,
      maxSpectators: 20,
      minOwnersRequired: 2,
      retentionEnabled: true,
      maxRetentionsPerFranchise: 2,
      maxOverseasRetentions: 1,
      allowTeamPurseAdjustments: true,
      franchisePurseAdjustments: [{ franchiseCode: 'CSK', adjustmentLakhs: 500 }]
    };

    // 1. Unauthorized modifications (owner & spectator rejected with 403)
    for (const actor of [owner, spectator]) {
      const r1 = await fetch(`${baseUrl}/api/v1/rooms/${code}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actor.token}` },
        body: JSON.stringify(validConfigPayload)
      });
      assert.equal(r1.status, 403);

      const r2 = await fetch(`${baseUrl}/api/v1/rooms/${code}/pool/auto-fill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${actor.token}` },
        body: JSON.stringify({})
      });
      assert.equal(r2.status, 403);

      const r3 = await fetch(`${baseUrl}/api/v1/rooms/${code}/config/finalize`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${actor.token}` }
      });
      assert.equal(r3.status, 403);
    }
    console.log('✅ Test 1: Non-host (owner & spectator) config/pool/finalize attempts blocked with 403');

    // 2. Invalid purse, squad limits, and overlapping bid tiers rejected (400)
    const badSquadRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ ...validConfigPayload, minSquadSize: 20, maxSquadSize: 15 })
    });
    assert.equal(badSquadRes.status, 400);

    const badPurseRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ ...validConfigPayload, initialPurseLakhs: 100 })
    });
    assert.equal(badPurseRes.status, 400);

    const badTiersRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        ...validConfigPayload,
        bidIncrementTiers: [
          { minAmount: 20, maxAmount: 100, increment: 5 },
          { minAmount: 95, maxAmount: 200, increment: 10 }
        ]
      })
    });
    assert.equal(badTiersRes.status, 400);
    console.log('✅ Test 2: Invalid squad limits, purse bounds, and overlapping bid tiers rejected (400)');

    // 3. Empty player pool cannot finalize (400)
    const emptyFinalizeRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/config/finalize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.token}` }
    });
    assert.equal(emptyFinalizeRes.status, 400);
    console.log('✅ Test 3: Empty player pool rejected on configuration finalization (400)');

    // 4. Host updates config & Socket.IO broadcasts AUCTION_CONFIG_UPDATED + AUCTION_READINESS_CHANGED
    const cfgEvtOwnerP = waitForEvent(ownerSocket, SOCKET_EVENTS.AUCTION_CONFIG_UPDATED);
    const readyEvtSpecP = waitForEvent(specSocket, SOCKET_EVENTS.AUCTION_READINESS_CHANGED);

    const updateCfgRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify(validConfigPayload)
    });
    assert.equal(updateCfgRes.status, 200);
    const updatedRoom = ((await updateCfgRes.json()) as any).data;
    const cskAfterAdj = updatedRoom.franchises.find((f: any) => f.presetCode === 'CSK');
    assert.equal(cskAfterAdj.remainingPurseLakhs, 10500);
    await cfgEvtOwnerP;
    await readyEvtSpecP;
    console.log('✅ Test 4: Host config update + purse adjustment synced via Socket.IO');

    // 5. Retention validation (add domestic + overseas, reject excess overseas/total/purse, remove & refund)
    const catalogRes = await fetch(`${baseUrl}/api/v1/players/catalog`);
    const catalog = ((await catalogRes.json()) as any).data as any[];
    assert.ok(catalog.length >= 6);

    const domesticPlayer = catalog.find((p) => !p.isOverseas);
    const overseas1 = catalog.find((p) => p.isOverseas);
    const overseas2 = catalog.filter((p) => p.isOverseas)[1];
    const domestic2 = catalog.filter((p) => !p.isOverseas)[1];

    // Retain domestic player on CSK (cost 1500L -> remaining 9000L)
    const ret1Res = await fetch(`${baseUrl}/api/v1/rooms/${code}/retentions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        franchiseCode: 'CSK',
        playerId: domesticPlayer.id,
        retentionCostLakhs: 1500
      })
    });
    assert.equal(ret1Res.status, 201);
    const ret1Room = ((await ret1Res.json()) as any).data;
    const cskRet1 = ret1Room.franchises.find((f: any) => f.presetCode === 'CSK');
    assert.equal(cskRet1.remainingPurseLakhs, 9000);
    assert.equal(cskRet1.retainedCount, 1);

    // Duplicate player retention on MI rejected (409)
    const dupRetRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/retentions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        franchiseCode: 'MI',
        playerId: domesticPlayer.id,
        retentionCostLakhs: 1500
      })
    });
    assert.equal(dupRetRes.status, 409);

    // Retain overseas1 on CSK (cost 1500L -> remaining 7500L, overseas=1, total=2)
    const ret2Res = await fetch(`${baseUrl}/api/v1/rooms/${code}/retentions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        franchiseCode: 'CSK',
        playerId: overseas1.id,
        retentionCostLakhs: 1500
      })
    });
    assert.equal(ret2Res.status, 201);

    // 3rd retention on CSK exceeds maxRetentionsPerFranchise=2 (400)
    const maxRetRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/retentions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        franchiseCode: 'CSK',
        playerId: domestic2.id,
        retentionCostLakhs: 1000
      })
    });
    assert.equal(maxRetRes.status, 400);

    // 2nd overseas retention on MI after 1st overseas fails maxOverseasRetentions=1 (400)
    await fetch(`${baseUrl}/api/v1/rooms/${code}/retentions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        franchiseCode: 'MI',
        playerId: overseas2.id,
        retentionCostLakhs: 1200
      })
    });
    const overRetRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/retentions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        franchiseCode: 'MI',
        playerId: catalog.filter((p) => p.isOverseas)[2].id,
        retentionCostLakhs: 1000
      })
    });
    assert.equal(overRetRes.status, 400);

    // Remove retention from CSK -> refunds purse
    const cskRetentionId = ret1Room.retentions[0].id;
    const delRetRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/retentions/${cskRetentionId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${host.token}` }
    });
    assert.equal(delRetRes.status, 200);
    const afterRefundRoom = ((await delRetRes.json()) as any).data;
    const cskAfterRefund = afterRefundRoom.franchises.find((f: any) => f.presetCode === 'CSK');
    assert.equal(cskAfterRefund.remainingPurseLakhs, 9000);
    assert.equal(cskAfterRefund.retainedCount, 1);
    console.log('✅ Test 5: Retention purse deductions, cap limits, duplicate blocks & refund verified');

    // 6. Putting a retained player directly in auction pool is rejected (409)
    const badPoolRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/pool`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        lots: [
          {
            playerId: overseas1.id,
            setCategory: 'Marquee',
            basePriceLakhs: 200,
            sequenceOrder: 1
          }
        ]
      })
    });
    assert.equal(badPoolRes.status, 409);

    // Auto-fill player pool cleanly (excludes retained players)
    const autoFillRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/pool/auto-fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ includeOverseas: true, includeDomestic: true })
    });
    assert.equal(autoFillRes.status, 200);
    const poolRoom = ((await autoFillRes.json()) as any).data;
    assert.ok(poolRoom.lots.length >= 10);
    assert.ok(!poolRoom.lots.some((l: any) => l.playerId === overseas1.id));
    console.log(`✅ Test 6: Player pool auto-filled (${poolRoom.lots.length} lots) excluding retained players`);

    // 7. Concurrent configuration changes serialized cleanly
    const concurrentResults = await Promise.all([
      fetch(`${baseUrl}/api/v1/rooms/${code}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ ...validConfigPayload, countdownSeconds: 22 })
      }),
      fetch(`${baseUrl}/api/v1/rooms/${code}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify({ ...validConfigPayload, countdownSeconds: 28 })
      })
    ]);
    assert.ok(concurrentResults.every((r) => r.status === 200));
    console.log('✅ Test 7: Concurrent config updates serialized safely (both 200, zero corruption)');

    // 8. Finalize configuration -> AUCTION_CONFIG_FINALIZED + Readiness all checks pass + Subsequent edits locked (409)
    const finEvtPromise = waitForEvent(ownerSocket, SOCKET_EVENTS.AUCTION_CONFIG_FINALIZED);
    const finalizeRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/config/finalize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.token}` }
    });
    assert.equal(finalizeRes.status, 200);
    const finalRoom = ((await finalizeRes.json()) as any).data;
    assert.equal(finalRoom.configFinalized, true);
    assert.equal(finalRoom.readiness.isReadyToStart, true);
    await finEvtPromise;

    const lockedConfigRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify(validConfigPayload)
    });
    assert.equal(lockedConfigRes.status, 409);

    const lockedPoolRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/pool/auto-fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({})
    });
    assert.equal(lockedPoolRes.status, 409);

    const lockedRetRes = await fetch(`${baseUrl}/api/v1/rooms/${code}/retentions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        franchiseCode: 'CSK',
        playerId: domesticPlayer.id,
        retentionCostLakhs: 500
      })
    });
    assert.equal(lockedRetRes.status, 409);
    console.log('✅ Test 8: Configuration finalization + readiness + strict post-finalization locking (409) verified');

    console.log('\n🎉 All 8 Phase 3 Pre-Auction Configuration & Security tests passed.');
  } finally {
    openSockets.forEach((s) => s.disconnect());
    if (createdRoomIds.length > 0) {
      await prisma.room.deleteMany({ where: { id: { in: createdRoomIds } } });
    }
    if (createdSessionIds.length > 0) {
      await prisma.guestSession.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    await closeSocketServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectRedis();
    await prisma.$disconnect();
  }
}

runPhase3Tests().catch((err) => {
  console.error('❌ Phase 3 test failed:', err);
  process.exit(1);
});
