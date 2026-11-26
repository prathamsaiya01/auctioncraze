import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import { io as ioClient, Socket } from 'socket.io-client';
import { prisma } from '@auctioncraze/database';
import {
  AuctionMode,
  RoomRole,
  RoomVisibility,
  SOCKET_EVENTS,
  SeasonStatus
} from '@auctioncraze/shared';
import { createApp } from '../app';
import { connectRedis, disconnectRedis } from '../lib/redis';
import { closeSocketServer, setupSocketServer } from '../sockets/socketServer';
import { AuctionTimerManager } from '../modules/auction/timerManager';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

interface GuestClient {
  token: string;
  sessionId: string;
  displayName: string;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function createGuest(baseUrl: string, displayName: string, tracker: string[]): Promise<GuestClient> {
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

async function connectSocket(baseUrl: string, token: string): Promise<Socket> {
  const socket = ioClient(baseUrl, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Socket connect timeout')), 6000);
    socket.once('connect', () => {
      clearTimeout(t);
      resolve();
    });
    socket.once('connect_error', reject);
  });
  return socket;
}

async function emitAck(socket: Socket, event: string, payload: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ack of ${event}`)), 6000);
    socket.emit(event, payload, (resp: any) => {
      clearTimeout(t);
      resolve(resp);
    });
  });
}

async function runPhase7Tests() {
  await connectRedis();
  const app = createApp();
  const httpServer = http.createServer(app);
  await setupSocketServer(httpServer);
  AuctionTimerManager.start(150);

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const createdSessionIds: string[] = [];
  const createdSeasonIds: string[] = [];
  const createdRoomCodes: string[] = [];
  const sockets: Socket[] = [];

  try {
    const host1 = await createGuest(baseUrl, 'P7_Host1', createdSessionIds);
    const miOwner = await createGuest(baseUrl, 'P7_MI_Owner', createdSessionIds);
    const miLostSession = await createGuest(baseUrl, 'P7_MI_Recovered', createdSessionIds);
    const rcbOwner = await createGuest(baseUrl, 'P7_RCB_Owner', createdSessionIds);
    const spec1 = await createGuest(baseUrl, 'P7_Spectator1', createdSessionIds);
    const host2 = await createGuest(baseUrl, 'P7_Host2_OtherSzn', createdSessionIds);

    // =========================================================================
    // 1. SEASON MANAGEMENT, LOGIN-FREE IDENTITY, LEADERBOARD & ISOLATION
    // =========================================================================
    const szn1Res = await reqJson(baseUrl, 'POST', '/seasons', host1.token, {
      name: 'AuctionCraze Season 2026',
      year: 2026,
      description: 'Monthly recurring IPL mega season',
      startDate: '2026-11-01',
      endDate: '2027-02-28'
    });
    assert.equal(szn1Res.status, 201);
    const szn1 = szn1Res.json.data;
    createdSeasonIds.push(szn1.id);
    assert.equal(szn1.leaderboard.length, 10);
    assert.equal(szn1.isHost, true);
    assert.equal(szn1.status, SeasonStatus.ACTIVE);

    // Second independent season by Host 2
    const szn2Res = await reqJson(baseUrl, 'POST', '/seasons', host2.token, {
      name: 'Legends Super Season',
      year: 2027
    });
    assert.equal(szn2Res.status, 201);
    const szn2 = szn2Res.json.data;
    createdSeasonIds.push(szn2.id);

    // MI claims franchise in Season 1 without login (with custom suffix)
    const miClaim = await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/claim`, miOwner.token, {
      franchiseCode: 'MI',
      customSuffix: 'Blue Storm'
    });
    assert.equal(miClaim.status, 200);
    const miRow = miClaim.json.data.leaderboard.find((r: any) => r.presetCode === 'MI');
    assert.equal(miRow.isOwnedByRequester, true);
    assert.equal(miRow.customSuffix, 'Blue Storm');

    // Another guest CANNOT steal MI without recovery code -> 409 SEASON_FRANCHISE_LOCKED
    const stealMi = await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/claim`, miLostSession.token, {
      franchiseCode: 'MI'
    });
    assert.equal(stealMi.status, 409);
    assert.equal(stealMi.json.code, 'SEASON_FRANCHISE_LOCKED');

    // Non-host CANNOT issue recovery code -> 403
    assert.equal(
      (await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/entries/${miRow.entryId}/recovery-code`, rcbOwner.token, {})).status,
      403
    );

    // Host issues 1-time recovery code -> returning user reclaims MI -> recovery code is burned
    const recIssue = await reqJson(
      baseUrl,
      'POST',
      `/seasons/${szn1.code}/entries/${miRow.entryId}/recovery-code`,
      host1.token,
      {}
    );
    assert.equal(recIssue.status, 200);
    const recoveryCode = recIssue.json.data.recoveryCode;
    const reclaimMi = await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/claim`, miLostSession.token, {
      franchiseCode: 'MI',
      recoveryCode
    });
    assert.equal(reclaimMi.status, 200);
    assert.equal(
      reclaimMi.json.data.leaderboard.find((r: any) => r.presetCode === 'MI').isOwnedByRequester,
      true
    );
    // Reusing spent recovery code fails 409
    assert.equal(
      (await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/claim`, miOwner.token, {
        franchiseCode: 'MI',
        recoveryCode
      })).status,
      409
    );

    // Subscribe listener to Season 1 live updates via Socket.IO
    const seasonListenerSock = await connectSocket(baseUrl, rcbOwner.token);
    sockets.push(seasonListenerSock);
    const sznJoinAck = await emitAck(seasonListenerSock, SOCKET_EVENTS.SEASON_JOIN, { seasonCode: szn1.code });
    assert.equal(sznJoinAck.ok, true);

    const liveLeaderboardEvents: any[] = [];
    seasonListenerSock.on(SOCKET_EVENTS.SEASON_LEADERBOARD_UPDATED, (evt: any) => {
      liveLeaderboardEvents.push(evt);
    });

    // Host creates 2 monthly auctions in Season 1 (Nov + Dec)
    const novRoomRes = await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/rooms`, host1.token, {
      roomName: 'November Auction',
      franchiseCode: 'CSK',
      visibility: RoomVisibility.PUBLIC,
      auctionMode: AuctionMode.MOCK,
      seasonMonthLabel: 'November Auction',
      seasonMonthKey: '2026-11'
    });
    assert.equal(novRoomRes.status, 201);
    const novRoom = novRoomRes.json.data;
    createdRoomCodes.push(novRoom.code);
    assert.equal(novRoom.seasonCode, szn1.code);

    const decRoomRes = await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/rooms`, host1.token, {
      roomName: 'December Auction',
      franchiseCode: 'CSK',
      visibility: RoomVisibility.PUBLIC,
      auctionMode: AuctionMode.MOCK,
      seasonMonthLabel: 'December Auction',
      seasonMonthKey: '2026-12'
    });
    assert.equal(decRoomRes.status, 201);
    const decRoom = decRoomRes.json.data;
    createdRoomCodes.push(decRoom.code);

    // Non-host cannot create room in Season 1
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/rooms`, rcbOwner.token, {
          roomName: 'Rogue Room',
          franchiseCode: 'RCB'
        })
      ).status,
      403
    );

    // MI (recovered session) joins Nov room -> duplicate MI claim by RCB fails 409 (independent room seat lock)
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${novRoom.code}/join`, miLostSession.token, {
          joinAs: RoomRole.OWNER,
          franchiseCode: 'MI'
        })
      ).status,
      200
    );
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${novRoom.code}/join`, rcbOwner.token, {
          joinAs: RoomRole.OWNER,
          franchiseCode: 'MI'
        })
      ).status,
      409
    );
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${novRoom.code}/join`, rcbOwner.token, {
          joinAs: RoomRole.OWNER,
          franchiseCode: 'RCB'
        })
      ).status,
      200
    );
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${novRoom.code}/join`, spec1.token, {
          joinAs: RoomRole.SPECTATOR
        })
      ).status,
      200
    );

    // Non-host point edit strictly rejected (403); empty reason rejected (400)
    const cskRow = szn1.leaderboard.find((r: any) => r.presetCode === 'CSK');
    const rcbRow = szn1.leaderboard.find((r: any) => r.presetCode === 'RCB');
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/points`, miLostSession.token, {
          entryId: miRow.entryId,
          pointsDelta: 10,
          reason: 'Cheating attempt'
        })
      ).status,
      403
    );
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/points`, host1.token, {
          entryId: miRow.entryId,
          pointsDelta: 10,
          reason: 'x'
        })
      ).status,
      400
    );

    // Host awards points across Nov & Dec + negative deduction correction (audit history preserved!)
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/points`, host1.token, {
          entryId: miRow.entryId,
          pointsDelta: 15,
          reason: 'November tournament winner',
          roomId: novRoom.id
        })
      ).status,
      201
    );
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/points`, host1.token, {
          entryId: cskRow.entryId,
          pointsDelta: 10,
          reason: 'December bonus',
          roomId: decRoom.id
        })
      ).status,
      201
    );
    const negRes = await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/points`, host1.token, {
      entryId: rcbRow.entryId,
      pointsDelta: -5,
      reason: 'Late squad penalty',
      roomId: novRoom.id
    });
    assert.equal(negRes.status, 201);

    await sleep(120);
    assert.ok(liveLeaderboardEvents.length >= 3, 'Live Socket.IO leaderboard broadcasts must arrive cleanly');

    // Verify full audit history & month/auction filtering + Season 2 isolation
    const szn1Detail = (await reqJson(baseUrl, 'GET', `/seasons/${szn1.code}`, host1.token)).json.data;
    assert.equal(szn1Detail.pointHistory.length, 3);
    assert.equal(szn1Detail.leaderboard[0].presetCode, 'MI');
    assert.equal(szn1Detail.leaderboard[0].totalPoints, 15);
    assert.equal(szn1Detail.leaderboard[1].presetCode, 'CSK');
    assert.equal(szn1Detail.leaderboard.find((r: any) => r.presetCode === 'RCB').totalPoints, -5);

    const decFiltered = (await reqJson(baseUrl, 'GET', `/seasons/${szn1.code}?month=2026-12`, host1.token)).json.data;
    assert.equal(decFiltered.leaderboard.find((r: any) => r.presetCode === 'CSK').filteredPoints, 10);
    assert.equal(decFiltered.leaderboard.find((r: any) => r.presetCode === 'MI').filteredPoints, 0);

    // Season 2 must have 0 points & 0 auctions from Season 1
    const szn2Detail = (await reqJson(baseUrl, 'GET', `/seasons/${szn2.code}`, host2.token)).json.data;
    assert.equal(szn2Detail.pointHistory.length, 0);
    assert.equal(szn2Detail.auctions.length, 0);
    assert.ok(szn2Detail.leaderboard.every((r: any) => r.totalPoints === 0));

    // Archive Season 1 -> data still readable, mutations blocked cleanly (409)
    const archRes = await reqJson(baseUrl, 'PATCH', `/seasons/${szn1.code}/archive`, host1.token, {});
    assert.equal(archRes.status, 200);
    assert.equal(archRes.json.data.status, SeasonStatus.ARCHIVED);
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/seasons/${szn1.code}/points`, host1.token, {
          entryId: miRow.entryId,
          pointsDelta: 5,
          reason: 'Post-archive attempt'
        })
      ).status,
      409
    );
    assert.equal((await reqJson(baseUrl, 'GET', `/seasons/${szn1.code}`, miLostSession.token)).status, 200);
    console.log('✅ Part C Season Management, Login-Free Identity, Recovery, Leaderboard & Isolation passed!');

    // =========================================================================
    // 2. MULTIPLAYER CHATBOX, MODERATION, ANTI-SPAM, ISOLATION & AUCTION EVENTS
    // =========================================================================
    const hostSock = await connectSocket(baseUrl, host1.token);
    const miSock = await connectSocket(baseUrl, miLostSession.token);
    const specSock = await connectSocket(baseUrl, spec1.token);
    const decHostSock = await connectSocket(baseUrl, host1.token);
    sockets.push(hostSock, miSock, specSock, decHostSock);

    assert.equal((await emitAck(hostSock, SOCKET_EVENTS.ROOM_JOIN, { roomCode: novRoom.code })).ok, true);
    assert.equal((await emitAck(miSock, SOCKET_EVENTS.ROOM_JOIN, { roomCode: novRoom.code })).ok, true);
    assert.equal((await emitAck(specSock, SOCKET_EVENTS.ROOM_JOIN, { roomCode: novRoom.code })).ok, true);
    assert.equal((await emitAck(decHostSock, SOCKET_EVENTS.ROOM_JOIN, { roomCode: decRoom.code })).ok, true);

    const miChatMsgs: any[] = [];
    const specChatMsgs: any[] = [];
    const decRoomChatMsgs: any[] = [];
    miSock.on(SOCKET_EVENTS.CHAT_MESSAGE, (m: any) => miChatMsgs.push(m));
    specSock.on(SOCKET_EVENTS.CHAT_MESSAGE, (m: any) => specChatMsgs.push(m));
    decHostSock.on(SOCKET_EVENTS.CHAT_MESSAGE, (m: any) => decRoomChatMsgs.push(m));

    // Malicious XSS-like payload stored verbatim as inert escaped text & synced only to novRoom
    const xssText = '<script>alert("xss")</script> Nice bid CSK!';
    const chatIdemKey1 = `chat-idem-1-${Date.now()}`;
    const send1 = await emitAck(hostSock, SOCKET_EVENTS.CHAT_SEND, {
      roomCode: novRoom.code,
      message: xssText,
      idempotencyKey: chatIdemKey1
    });
    assert.equal(send1.ok, true);
    assert.equal(send1.data.message, xssText);

    // Duplicate idempotencyKey returns existing row cleanly without double-persisting
    const dupIdem = await emitAck(hostSock, SOCKET_EVENTS.CHAT_SEND, {
      roomCode: novRoom.code,
      message: xssText,
      idempotencyKey: chatIdemKey1
    });
    assert.equal(dupIdem.ok, true);
    assert.equal(dupIdem.data.id, send1.data.id);

    await sleep(100);
    assert.equal(miChatMsgs.length, 1);
    assert.equal(specChatMsgs.length, 1);
    assert.equal(decRoomChatMsgs.length, 0, 'Room chat must NEVER leak across rooms!');

    // Spectator blocked by default -> Host enables spectator chat -> Spectator sends cleanly
    const specDenied = await emitAck(specSock, SOCKET_EVENTS.CHAT_SEND, {
      roomCode: novRoom.code,
      message: 'Hello floor!'
    });
    assert.equal(specDenied.ok, false);
    assert.equal(specDenied.code, 'SPECTATOR_CHAT_DISABLED');

    assert.equal(
      (
        await reqJson(baseUrl, 'PATCH', `/rooms/${novRoom.code}/chat/settings`, miLostSession.token, {
          spectatorChatEnabled: true
        })
      ).status,
      403
    );
    assert.equal(
      (
        await reqJson(baseUrl, 'PATCH', `/rooms/${novRoom.code}/chat/settings`, host1.token, {
          spectatorChatEnabled: true
        })
      ).status,
      200
    );
    const specOk = await emitAck(specSock, SOCKET_EVENTS.CHAT_SEND, {
      roomCode: novRoom.code,
      message: 'Hello floor from spectator!',
      idempotencyKey: `spec-chat-${Date.now()}`
    });
    assert.equal(specOk.ok, true);

    // Anti-spam & Rate limit verification
    const dupSpam = await emitAck(miSock, SOCKET_EVENTS.CHAT_SEND, {
      roomCode: novRoom.code,
      message: 'First quick msg',
      idempotencyKey: `spam-1-${Date.now()}`
    });
    assert.equal(dupSpam.ok, true);
    const spamBlocked = await emitAck(miSock, SOCKET_EVENTS.CHAT_SEND, {
      roomCode: novRoom.code,
      message: 'First quick msg',
      idempotencyKey: `spam-2-${Date.now()}`
    });
    assert.equal(spamBlocked.ok, false);
    assert.equal(spamBlocked.code, 'CHAT_SPAM_BLOCKED');

    // Burst > 8 unique messages within 10s triggers CHAT_RATE_LIMITED cleanly
    let rateLimitedHit = false;
    for (let r = 0; r < 10; r++) {
      const rlRes = await emitAck(miSock, SOCKET_EVENTS.CHAT_SEND, {
        roomCode: novRoom.code,
        message: `Burst check line ${r} ${Date.now()}`,
        idempotencyKey: `rl-${r}-${Date.now()}`
      });
      if (!rlRes.ok && rlRes.code === 'CHAT_RATE_LIMITED') {
        rateLimitedHit = true;
        break;
      }
    }
    assert.equal(rateLimitedHit, true, 'Exceeding 8 chat messages/10s must enforce CHAT_RATE_LIMITED');

    // Mute MI participant -> blocked -> unmute -> delete message -> disable chat -> cross-room REST 403
    const miParticipant = novRoom.participants.find((p: any) => p.franchiseCode === 'MI') ||
      (await reqJson(baseUrl, 'GET', `/rooms/${novRoom.code}`, host1.token)).json.data.participants.find(
        (p: any) => p.franchiseCode === 'MI'
      );
    assert.equal(
      (
        await reqJson(
          baseUrl,
          'POST',
          `/rooms/${novRoom.code}/chat/participants/${miParticipant.id}/mute`,
          host1.token,
          { muted: true }
        )
      ).status,
      200
    );
    const mutedSend = await emitAck(miSock, SOCKET_EVENTS.CHAT_SEND, {
      roomCode: novRoom.code,
      message: 'Trying while muted',
      idempotencyKey: `muted-send-${Date.now()}`
    });
    assert.equal(mutedSend.ok, false);
    assert.equal(mutedSend.code, 'PARTICIPANT_MUTED');

    assert.equal(
      (await reqJson(baseUrl, 'DELETE', `/rooms/${novRoom.code}/chat/${send1.data.id}`, host1.token)).status,
      200
    );
    assert.equal((await reqJson(baseUrl, 'GET', `/rooms/${decRoom.code}/chat`, miLostSession.token)).status, 403);

    // Reconnection history recovery check
    specSock.disconnect();
    await sleep(60);
    const specReconnected = await connectSocket(baseUrl, spec1.token);
    sockets.push(specReconnected);
    await emitAck(specReconnected, SOCKET_EVENTS.ROOM_JOIN, { roomCode: novRoom.code });
    const recoveredHistory = (await reqJson(baseUrl, 'GET', `/rooms/${novRoom.code}/chat`, spec1.token)).json.data;
    assert.equal(recoveredHistory.messages.some((m: any) => m.id === send1.data.id), false, 'Deleted message excluded from history');
    assert.equal(recoveredHistory.messages.some((m: any) => m.id === specOk.data.id), true);

    // =========================================================================
    // 3. LIVE AUCTION PAYLOADS FOR ANIMATIONS + AUDIO DEDUP + TIMER EXTEND
    // =========================================================================
    const players = await prisma.masterPlayer.findMany({ take: 3, orderBy: { fullName: 'asc' } });
    await reqJson(
      baseUrl,
      'PUT',
      `/rooms/${novRoom.code}/pool`,
      host1.token,
      {
        lots: players.map((p, idx) => ({
          playerId: p.id,
          sequenceOrder: idx + 1,
          setCategory: 'Marquee',
          basePriceLakhs: 200
        }))
      }
    );
    await reqJson(baseUrl, 'POST', `/rooms/${novRoom.code}/config/finalize`, host1.token, {});
    await reqJson(baseUrl, 'PATCH', `/rooms/${novRoom.code}/ready`, miLostSession.token, { isReady: true });
    await reqJson(baseUrl, 'PATCH', `/rooms/${novRoom.code}/ready`, rcbOwner.token, { isReady: true });
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${novRoom.code}/auction/start`, host1.token, {})).status, 200);

    const bidPayloads: any[] = [];
    const timerPayloads: any[] = [];
    miSock.on(SOCKET_EVENTS.BID_PLACED, (e: any) => bidPayloads.push(e));
    miSock.on(SOCKET_EVENTS.TIMER_UPDATED, (e: any) => timerPayloads.push(e));

    const snap = (await reqJson(baseUrl, 'GET', `/rooms/${novRoom.code}/auction`, host1.token)).json.data;
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${novRoom.code}/auction/bids`, miLostSession.token, {
          lotId: snap.currentLot.id,
          bidAmountLakhs: snap.currentLot.nextBidLakhs,
          idempotencyKey: `p7-bid1-${Date.now()}`
        })
      ).status,
      201
    );
    const snap2 = (await reqJson(baseUrl, 'GET', `/rooms/${novRoom.code}/auction`, host1.token)).json.data;
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${novRoom.code}/auction/bids`, rcbOwner.token, {
          lotId: snap2.currentLot.id,
          bidAmountLakhs: snap2.currentLot.nextBidLakhs,
          idempotencyKey: `p7-bid2-${Date.now()}`
        })
      ).status,
      201
    );
    await reqJson(baseUrl, 'POST', `/rooms/${novRoom.code}/auction/extend-timer`, host1.token, { extraSeconds: 5 });
    await sleep(100);

    assert.equal(bidPayloads.length, 2);
    assert.equal(bidPayloads[1].previousBidLakhs, 200);
    assert.equal(bidPayloads[1].hadPreviousBidder, true);
    assert.ok(timerPayloads.some((t) => t.extended === true), 'Timer extension must emit extended: true cue');

    // Verify Season points remain untouched by auction purchases (separate concepts!)
    await reqJson(baseUrl, 'POST', `/rooms/${novRoom.code}/auction/sold`, host1.token, { lotId: snap2.currentLot.id });
    const sznAfterSale = (await reqJson(baseUrl, 'GET', `/seasons/${szn1.code}`, host1.token)).json.data;
    assert.equal(sznAfterSale.pointHistory.length, 3, 'Auction purchases must NOT auto-invent season points');

    console.log('✅ Part A/B/D Live Chat, Moderation, XSS/Spam Protection & Animation/Sound Payloads passed!');
    console.log('\n🎉 All Phase 7 integration tests passed!');
  } finally {
    AuctionTimerManager.stop();
    for (const s of sockets) {
      try {
        s.disconnect();
      } catch {}
    }
    await sleep(150);
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
    } catch (cleanupErr) {
      console.error('Phase 7 cleanup warning:', cleanupErr);
    }

    await disconnectRedis();
    await prisma.$disconnect();
  }
}

runPhase7Tests().catch(async (err) => {
  console.error('❌ Phase 7 test failed:', err);
  await disconnectRedis().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
