import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import { prisma } from '@auctioncraze/database';
import {
  AuctionMode,
  RoomRole,
  RoomVisibility
} from '@auctioncraze/shared';
import { createApp } from '../app';
import { connectRedis, disconnectRedis } from '../lib/redis';
import { closeSocketServer, setupSocketServer } from '../sockets/socketServer';
import { AuctionTimerManager } from '../modules/auction/timerManager';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

async function reqJson(
  baseUrl: string,
  method: string,
  route: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/v1${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function createGuest(baseUrl: string, displayName: string, tracker: string[]) {
  const res = await reqJson(baseUrl, 'POST', '/sessions/guest', undefined, { displayName });
  assert.equal(res.status, 201);
  const sessionId = res.json.data.session?.id ?? res.json.data.id;
  tracker.push(sessionId);
  return {
    token: res.json.data.session?.token ?? res.json.data.token,
    sessionId,
    displayName
  };
}

async function runInviteSecurityTests() {
  await connectRedis();
  const app = createApp();
  const httpServer = http.createServer(app);
  await setupSocketServer(httpServer);
  AuctionTimerManager.start(150);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const createdSessionIds: string[] = [];
  const createdRoomCodes: string[] = [];
  const createdSeasonIds: string[] = [];

  try {
    const host = await createGuest(baseUrl, 'Inv_Host', createdSessionIds);
    const ownerGuest = await createGuest(baseUrl, 'Inv_Owner', createdSessionIds);
    const specGuest = await createGuest(baseUrl, 'Inv_Spec', createdSessionIds);
    const escalater = await createGuest(baseUrl, 'Inv_Escalater', createdSessionIds);

    const sznRes = await reqJson(baseUrl, 'POST', '/seasons', host.token, {
      name: 'Invite Audit Season 2026',
      year: 2026
    });
    assert.equal(sznRes.status, 201);
    const season = sznRes.json.data;
    createdSeasonIds.push(season.id);

    // 1. Private season-linked room issues distinct inviteToken and spectatorInviteToken
    const privRes = await reqJson(baseUrl, 'POST', `/seasons/${season.code}/rooms`, host.token, {
      roomName: 'Private Invite Room',
      franchiseCode: 'CSK',
      visibility: RoomVisibility.PRIVATE,
      auctionMode: AuctionMode.MOCK,
      seasonMonthLabel: 'Invite Audit Month',
      seasonMonthKey: '2026-11'
    });
    assert.equal(privRes.status, 201);
    const privRoom = privRes.json.data;
    createdRoomCodes.push(privRoom.code);
    assert.ok(privRoom.inviteToken);
    assert.ok(privRoom.spectatorInviteToken);
    assert.notEqual(privRoom.inviteToken, privRoom.spectatorInviteToken);
    assert.equal(privRoom.seasonCode, season.code);

    // Unauthenticated read without invite rejected (403); invalid invite rejected (403 INVALID_INVITE_TOKEN)
    assert.equal((await reqJson(baseUrl, 'GET', `/rooms/${privRoom.code}`)).status, 403);
    const badInvRead = await reqJson(baseUrl, 'GET', `/rooms/${privRoom.code}?invite=bad-token`);
    assert.equal(badInvRead.status, 403);
    assert.equal(badInvRead.json.code, 'INVALID_INVITE_TOKEN');

    // Reading with spectatorInviteToken marks inviteAccessRole === SPECTATOR_ONLY & hides owner inviteToken
    const specPreview = await reqJson(
      baseUrl,
      'GET',
      `/rooms/${privRoom.code}?invite=${privRoom.spectatorInviteToken}`
    );
    assert.equal(specPreview.status, 200);
    assert.equal(specPreview.json.data.inviteAccessRole, 'SPECTATOR_ONLY');
    assert.equal(specPreview.json.data.inviteToken, undefined);

    // Spectator invite token MUST block OWNER escalation on Private room (403 SPECTATOR_INVITE_ONLY)
    const specEscalateAttempt = await reqJson(baseUrl, 'POST', `/rooms/${privRoom.code}/join`, escalater.token, {
      joinAs: RoomRole.OWNER,
      franchiseCode: 'MI',
      inviteToken: privRoom.spectatorInviteToken
    });
    assert.equal(specEscalateAttempt.status, 403);
    assert.equal(specEscalateAttempt.json.code, 'SPECTATOR_INVITE_ONLY');

    // Joining as Spectator via spectatorInviteToken succeeds and does NOT leak owner inviteToken
    const specJoinRes = await reqJson(baseUrl, 'POST', `/rooms/${privRoom.code}/join`, specGuest.token, {
      joinAs: RoomRole.SPECTATOR,
      inviteToken: privRoom.spectatorInviteToken
    });
    assert.equal(specJoinRes.status, 200);
    assert.equal(specJoinRes.json.data.inviteToken, undefined, 'Spectators must never receive owner inviteToken');

    // Joined Spectator cannot claim franchise afterward
    const specClaimRes = await reqJson(baseUrl, 'PATCH', `/rooms/${privRoom.code}/franchise`, specGuest.token, {
      franchiseCode: 'MI'
    });
    assert.equal(specClaimRes.status, 403);

    // Owner invite succeeds on MI -> duplicate MI rejected cleanly (409)
    const ownerJoinRes = await reqJson(baseUrl, 'POST', `/rooms/${privRoom.code}/join`, ownerGuest.token, {
      joinAs: RoomRole.OWNER,
      franchiseCode: 'MI',
      inviteToken: privRoom.inviteToken
    });
    assert.equal(ownerJoinRes.status, 200);
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${privRoom.code}/join`, escalater.token, {
          joinAs: RoomRole.OWNER,
          franchiseCode: 'MI',
          inviteToken: privRoom.inviteToken
        })
      ).status,
      409
    );

    // 2. Invite revocation / rotation (Host-only) invalidates old inviteToken & old spectatorInviteToken!
    assert.equal(
      (await reqJson(baseUrl, 'POST', `/rooms/${privRoom.code}/invite/regenerate`, ownerGuest.token, {})).status,
      403
    );
    const oldOwnerInvite = privRoom.inviteToken;
    const oldSpecInvite = privRoom.spectatorInviteToken;
    const regenRes = await reqJson(baseUrl, 'POST', `/rooms/${privRoom.code}/invite/regenerate`, host.token, {});
    assert.equal(regenRes.status, 200);
    const newOwnerInvite = regenRes.json.data.inviteToken;
    const newSpecInvite = regenRes.json.data.spectatorInviteToken;
    assert.ok(newOwnerInvite && newOwnerInvite !== oldOwnerInvite);
    assert.ok(newSpecInvite && newSpecInvite !== oldSpecInvite);

    // Revoked tokens must fail cleanly with 403 INVALID_INVITE_TOKEN
    assert.equal((await reqJson(baseUrl, 'GET', `/rooms/${privRoom.code}?invite=${oldOwnerInvite}`)).status, 403);
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${privRoom.code}/join`, escalater.token, {
          joinAs: RoomRole.OWNER,
          franchiseCode: 'RCB',
          inviteToken: oldOwnerInvite
        })
      ).status,
      403
    );
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${privRoom.code}/join`, escalater.token, {
          joinAs: RoomRole.SPECTATOR,
          inviteToken: oldSpecInvite
        })
      ).status,
      403
    );

    // Fresh token works cleanly
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${privRoom.code}/join`, escalater.token, {
          joinAs: RoomRole.OWNER,
          franchiseCode: 'RCB',
          inviteToken: newOwnerInvite
        })
      ).status,
      200
    );

    // 3. Public room spectatorInviteToken also blocks OWNER escalation via parameter tampering
    const pubRes = await reqJson(baseUrl, 'POST', '/rooms', host.token, {
      roomName: 'Public Invite Lock Room',
      franchiseCode: 'CSK',
      visibility: RoomVisibility.PUBLIC,
      auctionMode: AuctionMode.MOCK
    });
    assert.equal(pubRes.status, 201);
    const pubRoom = pubRes.json.data;
    createdRoomCodes.push(pubRoom.code);
    const pubEscalation = await reqJson(baseUrl, 'POST', `/rooms/${pubRoom.code}/join`, escalater.token, {
      joinAs: RoomRole.OWNER,
      franchiseCode: 'MI',
      inviteToken: pubRoom.spectatorInviteToken
    });
    assert.equal(pubEscalation.status, 403);
    assert.equal(pubEscalation.json.code, 'SPECTATOR_INVITE_ONLY');

    console.log('✅ All Phase 7 Invite Security, Spectator-Lock, & Revocation tests passed!');
  } finally {
    AuctionTimerManager.stop();
    await closeSocketServer();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));

    try {
      if (createdRoomCodes.length > 0) {
        await prisma.room.deleteMany({ where: { code: { in: createdRoomCodes } } });
        for (const c of createdRoomCodes) {
          await AuctionTimerManager.clearTimer(c);
        }
      }
      if (createdSeasonIds.length > 0) {
        await prisma.season.deleteMany({ where: { id: { in: createdSeasonIds } } });
      }
      if (createdSessionIds.length > 0) {
        await prisma.guestSession.deleteMany({ where: { id: { in: createdSessionIds } } });
      }
    } catch (e) {
      console.error('Invite test cleanup warning:', e);
    }

    await disconnectRedis();
    await prisma.$disconnect();
  }
}

runInviteSecurityTests().catch(async (err) => {
  console.error('❌ Invite security test failed:', err);
  await disconnectRedis().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
