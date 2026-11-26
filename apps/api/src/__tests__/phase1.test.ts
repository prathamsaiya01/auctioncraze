import assert from 'node:assert/strict';
import http from 'node:http';
import { prisma } from '@auctioncraze/database';
import { RoomRole, RoomStatus, RoomVisibility } from '@auctioncraze/shared';
import { createApp } from '../app';
import { config } from '../config/env';
import { clearRateLimitEntriesForTest } from '../lib/coordinationStore';
import { connectRedis, disconnectRedis } from '../lib/redis';

async function runPhase1Tests() {
  await prisma.$connect();
  await connectRedis();
  await clearRateLimitEntriesForTest('rl:*');

  const app = createApp();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test HTTP server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const createdRoomIds: string[] = [];
  const createdSessionIds: string[] = [];

  try {
    // 1. Health endpoint checks Postgres + Redis
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthBody: any = await healthRes.json();
    assert.equal(healthBody.status, 'healthy');
    assert.equal(healthBody.dependencies.postgres, 'up');
    assert.equal(healthBody.dependencies.redis, config.enableRedis ? 'up' : 'disabled');
    console.log('✅ Test 1: /health verified PostgreSQL & Redis connectivity');

    // 2. Unauthenticated room creation must be rejected (401)
    const unauthRoomRes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomName: 'Unauthorized Room',
        franchiseCode: 'MI'
      })
    });
    assert.equal(unauthRoomRes.status, 401);
    console.log('✅ Test 2: Unauthenticated POST /api/v1/rooms rejected with 401');

    // 3. Invalid display name rejected (400)
    const badGuestRes = await fetch(`${baseUrl}/api/v1/sessions/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'A' })
    });
    assert.equal(badGuestRes.status, 400);
    console.log('✅ Test 3: Short guest displayName rejected with 400');

    // 4. Guest session creation + /me + update displayName
    const guestRes = await fetch(`${baseUrl}/api/v1/sessions/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Captain_MS' })
    });
    assert.equal(guestRes.status, 201);
    const guestBody: any = await guestRes.json();
    const token = guestBody.data.token as string;
    const sessionId = guestBody.data.session.id as string;
    createdSessionIds.push(sessionId);
    assert.ok(token.length > 20);
    assert.equal(guestBody.data.session.displayName, 'Captain_MS');

    const meRes = await fetch(`${baseUrl}/api/v1/sessions/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(meRes.status, 200);
    const meBody: any = await meRes.json();
    assert.equal(meBody.data.id, sessionId);

    const patchMeRes = await fetch(`${baseUrl}/api/v1/sessions/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ displayName: 'Thala_7' })
    });
    assert.equal(patchMeRes.status, 200);
    const patchBody: any = await patchMeRes.json();
    assert.equal(patchBody.data.displayName, 'Thala_7');
    console.log('✅ Test 4: Guest session create, verify, and rename succeeded');

    // 5. Tampered JWT rejected (401)
    const tamperedToken = `${token.slice(0, -4)}xxxx`;
    const tamperedRes = await fetch(`${baseUrl}/api/v1/sessions/me`, {
      headers: { Authorization: `Bearer ${tamperedToken}` }
    });
    assert.equal(tamperedRes.status, 401);
    console.log('✅ Test 5: Tampered JWT token rejected with 401');

    // 6. Create PUBLIC Room as Host owning CSK
    const createPublicRes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        roomName: 'Friday Night IPL Mega Auction',
        franchiseCode: 'CSK',
        visibility: RoomVisibility.PUBLIC,
        settings: {
          initialPurseLakhs: 12000,
          minSquadSize: 15,
          maxSquadSize: 25,
          maxOverseas: 8,
          countdownSeconds: 25,
          bidExtensionSeconds: 10,
          extensionThresholdSeconds: 5,
          allowHostSkip: true
        }
      })
    });
    assert.equal(createPublicRes.status, 201);
    const publicRoomBody: any = await createPublicRes.json();
    const publicRoom = publicRoomBody.data;
    createdRoomIds.push(publicRoom.id);

    assert.match(publicRoom.code, /^AC-[A-Z0-9]{6}$/);
    assert.equal(publicRoom.status, RoomStatus.LOBBY);
    assert.equal(publicRoom.franchises.length, 10);
    assert.equal(publicRoom.participants.length, 1);
    assert.equal(publicRoom.participants[0].role, RoomRole.HOST);
    assert.equal(publicRoom.participants[0].franchiseCode, 'CSK');
    assert.equal(publicRoom.participants[0].displayName, 'Thala_7');

    const cskFranchise = publicRoom.franchises.find((f: any) => f.presetCode === 'CSK');
    assert.equal(cskFranchise.initialPurseLakhs, 12000);
    assert.equal(cskFranchise.claimedByParticipantId, publicRoom.participants[0].id);
    console.log(`✅ Test 6: Public room created (${publicRoom.code}) with Host owning CSK`);

    // 7. Create PRIVATE Room and confirm it does NOT appear in /rooms/public
    const createPrivateRes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        roomName: 'Secret Friends Room',
        franchiseCode: 'MI',
        visibility: RoomVisibility.PRIVATE
      })
    });
    assert.equal(createPrivateRes.status, 201);
    const privateRoomBody: any = await createPrivateRes.json();
    const privateRoom = privateRoomBody.data;
    createdRoomIds.push(privateRoom.id);

    const listPublicRes = await fetch(`${baseUrl}/api/v1/rooms/public`);
    assert.equal(listPublicRes.status, 200);
    const listPublicBody: any = await listPublicRes.json();
    const publicCodes = listPublicBody.data.map((r: any) => r.code);
    assert.ok(publicCodes.includes(publicRoom.code));
    assert.ok(!publicCodes.includes(privateRoom.code));
    console.log('✅ Test 7: Public room listing includes PUBLIC room and excludes PRIVATE room');

    // 8. Fetch room by code (case-insensitive) & 404 on unknown code
    const getByCodeRes = await fetch(`${baseUrl}/api/v1/rooms/${publicRoom.code.toLowerCase()}`);
    assert.equal(getByCodeRes.status, 200);
    const getByCodeBody: any = await getByCodeRes.json();
    assert.equal(getByCodeBody.data.id, publicRoom.id);

    const missingRes = await fetch(`${baseUrl}/api/v1/rooms/AC-ZZZZZZ`);
    assert.equal(missingRes.status, 404);
    console.log('✅ Test 8: Room lookup by code and 404 handling verified');

    console.log('\n🎉 All 8 Phase 1 API & Security integration tests passed.');
  } finally {
    if (createdRoomIds.length > 0) {
      await prisma.room.deleteMany({ where: { id: { in: createdRoomIds } } });
    }
    if (createdSessionIds.length > 0) {
      await prisma.guestSession.deleteMany({ where: { id: { in: createdSessionIds } } });
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectRedis();
    await prisma.$disconnect();
  }
}

runPhase1Tests().catch((err) => {
  console.error('❌ Phase 1 test failed:', err);
  process.exit(1);
});
