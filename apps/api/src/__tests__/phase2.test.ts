import assert from 'node:assert/strict';
import http from 'node:http';
import { io as ioClient, Socket } from 'socket.io-client';
import { prisma } from '@auctioncraze/database';
import {
  IPL_FRANCHISE_PRESETS,
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
  displayName: string;
}

async function createGuest(baseUrl: string, displayName: string): Promise<GuestClient> {
  const res = await fetch(`${baseUrl}/api/v1/sessions/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  assert.equal(res.status, 201);
  const body: any = await res.json();
  return {
    token: body.data.token,
    sessionId: body.data.session.id,
    displayName: body.data.session.displayName
  };
}

function connectSocket(baseUrl: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      auth: { token },
      transports: ['websocket']
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket connection timed out'));
    }, 5000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForEvent<T = any>(socket: Socket, eventName: string, timeoutMs = 4000): Promise<T> {
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

async function runPhase2Tests() {
  await prisma.$connect();
  await connectRedis();
  await clearRateLimitEntriesForTest('rl:*');

  const app = createApp();
  const server = http.createServer(app);
  await setupSocketServer(server);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test HTTP server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const createdRoomIds: string[] = [];
  const createdSessionIds: string[] = [];
  const openSockets: Socket[] = [];

  try {
    // Provision guests
    const host = await createGuest(baseUrl, 'Host_Dhoni');
    const owner1 = await createGuest(baseUrl, 'Owner_Rohit');
    const spectator1 = await createGuest(baseUrl, 'Spec_Harsha');
    const outsider = await createGuest(baseUrl, 'Outsider_X');
    createdSessionIds.push(host.sessionId, owner1.sessionId, spectator1.sessionId, outsider.sessionId);

    // 1. Host creates PUBLIC room owning CSK with maxSpectators=1
    const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${host.token}`
      },
      body: JSON.stringify({
        roomName: 'Phase 2 Multiplayer Test Arena',
        franchiseCode: 'CSK',
        visibility: RoomVisibility.PUBLIC,
        settings: {
          initialPurseLakhs: 10000,
          minSquadSize: 15,
          maxSquadSize: 25,
          maxOverseas: 8,
          maxSpectators: 1,
          countdownSeconds: 20,
          bidExtensionSeconds: 10,
          extensionThresholdSeconds: 5,
          allowHostSkip: true
        }
      })
    });
    assert.equal(createRes.status, 201);
    const room = ((await createRes.json()) as any).data;
    createdRoomIds.push(room.id);
    const roomCode = room.code as string;

    // 2. Invalid room codes
    const badFormatRes = await fetch(`${baseUrl}/api/v1/rooms/!!`);
    assert.equal(badFormatRes.status, 400);
    const notFoundRes = await fetch(`${baseUrl}/api/v1/rooms/AC-999999/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ joinAs: RoomRole.OWNER, franchiseCode: 'MI' })
    });
    assert.equal(notFoundRes.status, 404);
    console.log('✅ Test 1: Invalid room code format (400) & unknown room (404) rejected');

    // 3. Duplicate franchise ownership prevention (owner1 tries CSK)
    const dupFranchiseRes = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ joinAs: RoomRole.OWNER, franchiseCode: 'CSK' })
    });
    assert.equal(dupFranchiseRes.status, 409);
    console.log('✅ Test 2: Duplicate franchise claim rejected with 409');

    // 4. Successful room joining (case-insensitive room code) & duplicate membership prevention
    const joinRes = await fetch(`${baseUrl}/api/v1/rooms/${roomCode.toLowerCase()}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ joinAs: RoomRole.OWNER, franchiseCode: 'RCB' })
    });
    assert.equal(joinRes.status, 200);
    const joinBody: any = await joinRes.json();
    assert.equal(joinBody.data.participants.length, 2);

    const dupJoinRes = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ joinAs: RoomRole.OWNER, franchiseCode: 'KKR' })
    });
    assert.equal(dupJoinRes.status, 409);
    console.log('✅ Test 3: Successful join + duplicate membership prevented (409)');

    // 5. Concurrent franchise-claim race test (5 users racing for MI -> exactly 1 wins)
    const racers = await Promise.all([
      createGuest(baseUrl, 'Racer_1'),
      createGuest(baseUrl, 'Racer_2'),
      createGuest(baseUrl, 'Racer_3'),
      createGuest(baseUrl, 'Racer_4'),
      createGuest(baseUrl, 'Racer_5')
    ]);
    racers.forEach((r) => createdSessionIds.push(r.sessionId));

    const raceResults = await Promise.all(
      racers.map((r) =>
        fetch(`${baseUrl}/api/v1/rooms/${roomCode}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${r.token}` },
          body: JSON.stringify({ joinAs: RoomRole.OWNER, franchiseCode: 'MI' })
        })
      )
    );
    const raceStatuses = raceResults.map((r) => r.status);
    assert.equal(raceStatuses.filter((s) => s === 200).length, 1);
    assert.equal(raceStatuses.filter((s) => s === 409).length, 4);
    console.log('✅ Test 4: Concurrent franchise-claim race (5 users -> 1 winner, 4 rejected cleanly)');

    // 6. Spectator joining + full spectator rejection
    const specJoinRes = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${spectator1.token}` },
      body: JSON.stringify({ joinAs: RoomRole.SPECTATOR })
    });
    assert.equal(specJoinRes.status, 200);
    assert.equal(((await specJoinRes.json()) as any).data.spectatorCount, 1);

    const specFullRes = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${outsider.token}` },
      body: JSON.stringify({ joinAs: RoomRole.SPECTATOR })
    });
    assert.equal(specFullRes.status, 409);
    console.log('✅ Test 5: Spectator join succeeded & maxSpectators capacity enforced (409)');

    // 7. Full franchises rejection (claim remaining 7 franchises, then 11th owner rejected)
    const remainingCodes = IPL_FRANCHISE_PRESETS.map((f) => f.code).filter(
      (c) => !['CSK', 'RCB', 'MI'].includes(c)
    );
    for (let i = 0; i < remainingCodes.length; i++) {
      const filler = await createGuest(baseUrl, `Filler_${i}`);
      createdSessionIds.push(filler.sessionId);
      const r = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${filler.token}` },
        body: JSON.stringify({ joinAs: RoomRole.OWNER, franchiseCode: remainingCodes[i] })
      });
      assert.equal(r.status, 200);
    }
    const eleventhOwnerRes = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${outsider.token}` },
      body: JSON.stringify({ joinAs: RoomRole.OWNER, franchiseCode: 'GT' })
    });
    assert.equal(eleventhOwnerRes.status, 409);
    console.log('✅ Test 6: Full franchises (10/10 claimed) rejects 11th owner with 409');

    // 8. Private room authorization
    const privCreateRes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({
        roomName: 'Private Champions Room',
        franchiseCode: 'KKR',
        visibility: RoomVisibility.PRIVATE
      })
    });
    assert.equal(privCreateRes.status, 201);
    const privRoom = ((await privCreateRes.json()) as any).data;
    createdRoomIds.push(privRoom.id);
    assert.ok(privRoom.inviteToken);

    const uninvitedRead = await fetch(`${baseUrl}/api/v1/rooms/${privRoom.code}`);
    assert.equal(uninvitedRead.status, 403);

    const noInviteJoin = await fetch(`${baseUrl}/api/v1/rooms/${privRoom.code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${outsider.token}` },
      body: JSON.stringify({ joinAs: RoomRole.OWNER, franchiseCode: 'SRH' })
    });
    assert.equal(noInviteJoin.status, 403);

    const wrongInviteJoin = await fetch(`${baseUrl}/api/v1/rooms/${privRoom.code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${outsider.token}` },
      body: JSON.stringify({
        joinAs: RoomRole.OWNER,
        franchiseCode: 'SRH',
        inviteToken: 'wrong-token-12345'
      })
    });
    assert.equal(wrongInviteJoin.status, 403);

    const validInviteJoin = await fetch(`${baseUrl}/api/v1/rooms/${privRoom.code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${outsider.token}` },
      body: JSON.stringify({
        joinAs: RoomRole.OWNER,
        franchiseCode: 'SRH',
        inviteToken: privRoom.inviteToken
      })
    });
    assert.equal(validInviteJoin.status, 200);
    console.log('✅ Test 7: Private room invite authorization enforced & valid invite succeeded');

    // 9. Unauthorized socket connection & unauthorized room subscription
    await assert.rejects(() => connectSocket(baseUrl, 'invalid.jwt.token'));

    const outsiderSocket = await connectSocket(baseUrl, outsider.token);
    openSockets.push(outsiderSocket);
    const errPromise = waitForEvent<any>(outsiderSocket, SOCKET_EVENTS.ROOM_ERROR);
    outsiderSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode }); // outsider is NOT in public roomCode
    const errPayload = await errPromise;
    assert.equal(errPayload.code, 'NOT_A_MEMBER');
    console.log('✅ Test 8: Unauthorized socket & non-member room subscription blocked');

    // 10. Real-time Socket.IO events + reconnection & state recovery
    const hostSocket = await connectSocket(baseUrl, host.token);
    const ownerSocket = await connectSocket(baseUrl, owner1.token);
    openSockets.push(hostSocket, ownerSocket);

    const hostSnapPromise = waitForEvent<any>(hostSocket, SOCKET_EVENTS.ROOM_STATE);
    hostSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode });
    const hostSnap = await hostSnapPromise;
    assert.equal(hostSnap.code, roomCode);

    const ownerSnapPromise = waitForEvent<any>(ownerSocket, SOCKET_EVENTS.ROOM_STATE);
    ownerSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode });
    const ownerSnap = await ownerSnapPromise;
    assert.equal(ownerSnap.participants.length, 11);

    // Ready / Not-Ready events
    const readyEvtPromise = waitForEvent<any>(hostSocket, SOCKET_EVENTS.PARTICIPANT_READY);
    await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/ready`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ isReady: true })
    });
    const readyEvt = await readyEvtPromise;
    assert.equal(readyEvt.isReady, true);

    const notReadyEvtPromise = waitForEvent<any>(hostSocket, SOCKET_EVENTS.PARTICIPANT_NOT_READY);
    await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/ready`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ isReady: false })
    });
    const notReadyEvt = await notReadyEvtPromise;
    assert.equal(notReadyEvt.isReady, false);

    // Disconnect & reconnect without duplicating participant
    const offlineStatePromise = waitForEvent<any>(hostSocket, SOCKET_EVENTS.ROOM_STATE);
    ownerSocket.disconnect();
    const offlineState = await offlineStatePromise;
    const ownerRowOffline = offlineState.participants.find((p: any) => p.guestSessionId === owner1.sessionId);
    assert.equal(ownerRowOffline.isConnected, false);

    const reconnectedOwnerSocket = await connectSocket(baseUrl, owner1.token);
    openSockets.push(reconnectedOwnerSocket);
    const recoveredStatePromise = waitForEvent<any>(reconnectedOwnerSocket, SOCKET_EVENTS.ROOM_STATE);
    reconnectedOwnerSocket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode });
    const recoveredState = await recoveredStatePromise;
    assert.equal(
      recoveredState.participants.filter((p: any) => p.guestSessionId === owner1.sessionId).length,
      1
    );
    const ownerRowOnline = recoveredState.participants.find((p: any) => p.guestSessionId === owner1.sessionId);
    assert.equal(ownerRowOnline.isConnected, true);
    console.log('✅ Test 9: Socket.IO ready events, offline presence & reconnect recovery without duplication verified');

    // 11. Host-only permissions + Controlled Host Transfer + Kick Authorization
    const owner1Participant = recoveredState.participants.find((p: any) => p.guestSessionId === owner1.sessionId);
    const specParticipant = recoveredState.participants.find((p: any) => p.guestSessionId === spectator1.sessionId);

    // Non-host cannot kick, transfer host, or update settings
    const nonHostKick = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ participantId: specParticipant.id })
    });
    assert.equal(nonHostKick.status, 403);

    const nonHostSettings = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ settings: {} })
    });
    assert.equal(nonHostSettings.status, 403);

    // Host transfers host to owner1 (cannot transfer to spectator)
    const badTransfer = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/transfer-host`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ targetParticipantId: specParticipant.id })
    });
    assert.equal(badTransfer.status, 400);

    const hostChangedPromise = waitForEvent<any>(hostSocket, SOCKET_EVENTS.HOST_CHANGED);
    const transferRes = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/transfer-host`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ targetParticipantId: owner1Participant.id })
    });
    assert.equal(transferRes.status, 200);
    const hostChangedEvt = await hostChangedPromise;
    assert.equal(hostChangedEvt.newHostParticipantId, owner1Participant.id);

    // Previous host now loses host permission
    const oldHostKick = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ participantId: specParticipant.id })
    });
    assert.equal(oldHostKick.status, 403);

    // New host (owner1) kicks spectator1 & kicked user cannot rejoin
    const kickedEvtPromise = waitForEvent<any>(hostSocket, SOCKET_EVENTS.PARTICIPANT_KICKED);
    const newHostKick = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ participantId: specParticipant.id })
    });
    assert.equal(newHostKick.status, 200);
    const kickedEvt = await kickedEvtPromise;
    assert.equal(kickedEvt.participantId, specParticipant.id);

    const kickedRejoinRes = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${spectator1.token}` },
      body: JSON.stringify({ joinAs: RoomRole.SPECTATOR })
    });
    assert.equal(kickedRejoinRes.status, 403);
    console.log('✅ Test 10: Host-only permissions, controlled host transfer & kick enforcement verified');

    // 12. Spectator restriction + Franchise release & switch events + Closed room rejection
    const hostParticipant = recoveredState.participants.find((p: any) => p.guestSessionId === host.sessionId);
    const releasedEvtPromise = waitForEvent<any>(reconnectedOwnerSocket, SOCKET_EVENTS.FRANCHISE_RELEASED);
    // Former host (now OWNER) steps down to spectator, releasing CSK
    const releaseRes = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/franchise`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ franchiseCode: null })
    });
    assert.equal(releaseRes.status, 200);
    const releasedEvt = await releasedEvtPromise;
    assert.equal(releasedEvt.franchiseCode, 'CSK');
    assert.equal(releasedEvt.participantId, hostParticipant.id);

    // Spectator (former owner who stepped down) cannot claim a franchise or mark ready
    const specClaimAttempt = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/franchise`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ franchiseCode: 'CSK' })
    });
    assert.equal(specClaimAttempt.status, 403);

    const specReadyAttempt = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/ready`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ isReady: true })
    });
    assert.equal(specReadyAttempt.status, 403);

    // Active owner (owner1 currently on RCB) switches to CSK -> emits FRANCHISE_RELEASED (RCB) + FRANCHISE_CLAIMED (CSK)
    const switchReleasePromise = waitForEvent<any>(hostSocket, SOCKET_EVENTS.FRANCHISE_RELEASED);
    const switchClaimPromise = waitForEvent<any>(hostSocket, SOCKET_EVENTS.FRANCHISE_CLAIMED);
    const switchRes = await fetch(`${baseUrl}/api/v1/rooms/${roomCode}/franchise`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner1.token}` },
      body: JSON.stringify({ franchiseCode: 'CSK' })
    });
    assert.equal(switchRes.status, 200);
    const switchReleasedEvt = await switchReleasePromise;
    const switchClaimedEvt = await claimeEvtGuard(switchClaimPromise);
    assert.equal(switchReleasedEvt.franchiseCode, 'RCB');
    assert.equal(switchClaimedEvt.franchiseCode, 'CSK');

    // Close private room via sole host leaving -> CANCELLED -> subsequent join rejected 409
    await fetch(`${baseUrl}/api/v1/rooms/${privRoom.code}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${outsider.token}` }
    });
    await fetch(`${baseUrl}/api/v1/rooms/${privRoom.code}/leave`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${host.token}` }
    });
    const closedJoinRes = await fetch(`${baseUrl}/api/v1/rooms/${privRoom.code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${outsider.token}` },
      body: JSON.stringify({
        joinAs: RoomRole.OWNER,
        franchiseCode: 'SRH',
        inviteToken: privRoom.inviteToken
      })
    });
    assert.equal(closedJoinRes.status, 409);
    console.log('✅ Test 11: Franchise release/claim Socket.IO events & closed-room rejection verified');

    console.log('\n🎉 All 11 Phase 2 Multiplayer Lobby & Security tests passed.');
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

async function claimeEvtGuard<T>(p: Promise<T>): Promise<T> {
  return p;
}

runPhase2Tests().catch((err) => {
  console.error('❌ Phase 2 test failed:', err);
  process.exit(1);
});
