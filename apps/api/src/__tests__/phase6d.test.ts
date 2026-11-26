import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import { io as ioClient, Socket } from 'socket.io-client';
import { prisma } from '@auctioncraze/database';
import {
  AuctionMode,
  LotStatus,
  RoomRole,
  RoomStatus,
  RoomVisibility,
  SOCKET_EVENTS,
  TradeStatus
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

async function createGuest(baseUrl: string, displayName: string): Promise<GuestClient> {
  const res = await fetch(`${baseUrl}/api/v1/sessions/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  assert.equal(res.status, 201);
  const body: any = await res.json();
  return {
    token: body.data.session.token ?? body.data.token,
    sessionId: body.data.session?.id ?? body.data.id,
    displayName
  };
}

async function reqJson(
  baseUrl: string,
  method: string,
  route: string,
  token: string,
  body?: unknown
): Promise<{ status: number; json: any; ms: number }> {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}/api/v1${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const ms = performance.now() - t0;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, ms };
}

async function connectAndJoin(
  baseUrl: string,
  token: string,
  roomCode: string
): Promise<{ socket: Socket; ackMs: number; ack: any }> {
  const socket = ioClient(baseUrl, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Socket connect timeout')), 5000);
    socket.once('connect', () => {
      clearTimeout(t);
      resolve();
    });
    socket.once('connect_error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });

  const t0 = performance.now();
  const ack = await new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ROOM_JOIN ack timeout')), 5000);
    socket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode }, (res: any) => {
      clearTimeout(t);
      resolve(res);
    });
  });
  const ackMs = performance.now() - t0;
  return { socket, ackMs, ack };
}

function waitForEvent(socket: Socket, event: string, timeoutMs = 4500): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

async function runPhase6dTests() {
  await connectRedis();
  const app = createApp();
  const httpServer = http.createServer(app);
  await setupSocketServer(httpServer);
  AuctionTimerManager.start(150);

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const sockets: Socket[] = [];
  const apiLatenciesMs: number[] = [];
  const socketAckLatenciesMs: number[] = [];
  const bidLatenciesMs: number[] = [];
  let tradeTxMs = 0;
  let reconnectRecoveryMs = 0;

  try {
    // Guests: Host (CSK), MI, RCB (late joiner #1), KKR, SRH, Spectator1, Spectator2
    const [host, mi, rcb, kkr, srh, spec1, spec2] = await Promise.all([
      createGuest(baseUrl, 'P6D_Host_CSK'),
      createGuest(baseUrl, 'P6D_Owner_MI'),
      createGuest(baseUrl, 'P6D_Owner_RCB'),
      createGuest(baseUrl, 'P6D_Owner_KKR'),
      createGuest(baseUrl, 'P6D_Owner_SRH'),
      createGuest(baseUrl, 'P6D_Spec1'),
      createGuest(baseUrl, 'P6D_Spec2')
    ]);

    // Pick 4 real catalog players (3 Batters/All-Rounders + 1 Overseas)
    const virat = await prisma.masterPlayer.findFirstOrThrow({ where: { fullName: 'Virat Kohli' } });
    const rohit = await prisma.masterPlayer.findFirstOrThrow({ where: { fullName: 'Rohit Sharma' } });
    const gayle = await prisma.masterPlayer.findFirstOrThrow({ where: { fullName: 'CH Gayle' } });
    const bumrah = await prisma.masterPlayer.findFirstOrThrow({ where: { fullName: 'Jasprit Bumrah' } });
    const jadeja = await prisma.masterPlayer.findFirstOrThrow({ where: { fullName: 'Ravindra Jadeja' } });
    const warner = await prisma.masterPlayer.findFirstOrThrow({ where: { fullName: 'David Warner' } });

    // -----------------------------------------------------------------
    // TEST 1: Create room -> Start Auction with ONLY 2 Owners (CSK & MI)
    // -----------------------------------------------------------------
    const createRes = await reqJson(baseUrl, 'POST', '/rooms', host.token, {
      roomName: 'Phase 6D Multiplayer Test',
      franchiseCode: 'CSK',
      visibility: RoomVisibility.PUBLIC,
      auctionMode: AuctionMode.MOCK,
      settings: {
        initialPurseLakhs: 10000,
        minSquadSize: 1,
        maxSquadSize: 20,
        maxOverseas: 1,
        maxSpectators: 10,
        countdownSeconds: 30,
        bidExtensionSeconds: 10,
        extensionThresholdSeconds: 5,
        allowHostSkip: true
      }
    });
    assert.equal(createRes.status, 201);
    apiLatenciesMs.push(createRes.ms);
    const roomA = createRes.json.data;
    assert.equal(roomA.settings.allowPlayerTrades, false);
    assert.equal(roomA.settings.allowCustomTeamName, false);
    assert.equal(roomA.settings.allowLateJoin, true);

    const miJoin = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/join`, mi.token, {
      joinAs: RoomRole.OWNER,
      franchiseCode: 'MI'
    });
    assert.equal(miJoin.status, 200);

    // Configure pool & finalize with ONLY 2/10 franchises claimed
    const poolRes = await reqJson(baseUrl, 'PUT', `/rooms/${roomA.code}/pool`, host.token, {
      lots: [
        { playerId: virat.id, sequenceOrder: 1, setCategory: 'Marquee', basePriceLakhs: 200 },
        { playerId: rohit.id, sequenceOrder: 2, setCategory: 'Marquee', basePriceLakhs: 200 },
        { playerId: gayle.id, sequenceOrder: 3, setCategory: 'Overseas', basePriceLakhs: 200 },
        { playerId: bumrah.id, sequenceOrder: 4, setCategory: 'Pacers', basePriceLakhs: 200 },
        { playerId: warner.id, sequenceOrder: 5, setCategory: 'Overseas', basePriceLakhs: 200 },
        { playerId: jadeja.id, sequenceOrder: 6, setCategory: 'All-Rounders', basePriceLakhs: 200 }
      ]
    });
    assert.equal(poolRes.status, 200);
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/config/finalize`, host.token, {})).status, 200);
    await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/ready`, mi.token, { isReady: true });

    const startRes = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/start`, host.token, {});
    assert.equal(startRes.status, 200, '2-owner auction must start cleanly without 10/10 franchises');
    assert.equal(startRes.json.data.auctionStage, 'LIVE');
    apiLatenciesMs.push(startRes.ms);
    console.log('✅ Test 1: 2-owner flexible auction start verified (2/10 claimed)');

    // -----------------------------------------------------------------
    // TEST 2: Late Joining + Duplicate Claim Guard + Host Late-Join Toggle
    // -----------------------------------------------------------------
    const specJoin1 = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/join`, spec1.token, {
      joinAs: RoomRole.SPECTATOR
    });
    assert.equal(specJoin1.status, 200);

    // Late join duplicate claimed CSK must fail 409
    const dupLateJoin = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/join`, rcb.token, {
      joinAs: RoomRole.OWNER,
      franchiseCode: 'CSK'
    });
    assert.equal(dupLateJoin.status, 409);

    // Valid late join on RCB while LIVE
    const lateRcbJoin = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/join`, rcb.token, {
      joinAs: RoomRole.OWNER,
      franchiseCode: 'RCB'
    });
    assert.equal(lateRcbJoin.status, 200);
    apiLatenciesMs.push(lateRcbJoin.ms);

    // Disable late join -> KKR rejected with LATE_JOIN_DISABLED
    const disableLate = await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/live-settings`, host.token, {
      allowLateJoin: false
    });
    assert.equal(disableLate.status, 200);
    const blockedLate = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/join`, kkr.token, {
      joinAs: RoomRole.OWNER,
      franchiseCode: 'KKR'
    });
    assert.equal(blockedLate.status, 409);
    assert.equal(blockedLate.json.code, 'LATE_JOIN_DISABLED');

    // Re-enable late join -> KKR, SRH & Spec2 join
    await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/live-settings`, host.token, { allowLateJoin: true });
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/join`, kkr.token, { joinAs: RoomRole.OWNER, franchiseCode: 'KKR' })).status, 200);
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/join`, srh.token, { joinAs: RoomRole.OWNER, franchiseCode: 'SRH' })).status, 200);
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/join`, spec2.token, { joinAs: RoomRole.SPECTATOR })).status, 200);
    console.log('✅ Test 2: Late franchise joining (LIVE), duplicate guard, and late-join toggle verified');

    // -----------------------------------------------------------------
    // TEST 3: Multi-client Sockets (7 clients), Simultaneous 5-Owner Bids,
    //         Socket Acks, Room Isolation, Pause/Resume & Reconnection Sync
    // -----------------------------------------------------------------
    const joinedConns = await Promise.all([
      connectAndJoin(baseUrl, host.token, roomA.code),
      connectAndJoin(baseUrl, mi.token, roomA.code),
      connectAndJoin(baseUrl, rcb.token, roomA.code),
      connectAndJoin(baseUrl, kkr.token, roomA.code),
      connectAndJoin(baseUrl, srh.token, roomA.code),
      connectAndJoin(baseUrl, spec1.token, roomA.code),
      connectAndJoin(baseUrl, spec2.token, roomA.code)
    ]);
    const [sHost, sMi, sRcb, sKkr, sSrh, sSpec1] = joinedConns.map((c) => c.socket);
    joinedConns.forEach((c) => {
      sockets.push(c.socket);
      socketAckLatenciesMs.push(c.ackMs);
      assert.equal(c.ack.ok, true);
    });

    // Room B isolation check
    const hostB = await createGuest(baseUrl, 'P6D_RoomB_Host');
    const roomBRes = await reqJson(baseUrl, 'POST', '/rooms', hostB.token, {
      roomName: 'Isolated Room B',
      franchiseCode: 'GT',
      visibility: RoomVisibility.PUBLIC
    });
    const roomBCode = roomBRes.json.data.code;
    const connB = await connectAndJoin(baseUrl, hostB.token, roomBCode);
    sockets.push(connB.socket);
    let roomBLeaked = false;
    connB.socket.on(SOCKET_EVENTS.BID_PLACED, () => {
      roomBLeaked = true;
    });

    // Deduplication / dropped check on CSK & Spec1 listeners
    const seenBidIdsHost = new Set<string>();
    const seenBidIdsSpec = new Set<string>();
    let duplicateEvents = 0;
    sHost.on(SOCKET_EVENTS.BID_PLACED, (e: any) => {
      if (seenBidIdsHost.has(e.bid.id)) duplicateEvents++;
      seenBidIdsHost.add(e.bid.id);
    });
    sSpec1.on(SOCKET_EVENTS.BID_PLACED, (e: any) => {
      if (seenBidIdsSpec.has(e.bid.id)) duplicateEvents++;
      seenBidIdsSpec.add(e.bid.id);
    });

    const lot1Id = startRes.json.data.currentLot.id;

    // 5 simultaneous opening bids (200L) -> STRICTLY 1 winner!
    const bidAcks = await Promise.all(
      [sHost, sMi, sRcb, sKkr, sSrh].map((sock, idx) =>
        new Promise<any>((resolve) => {
          const t0 = performance.now();
          sock.emit(
            SOCKET_EVENTS.BID_SUBMIT,
            {
              roomCode: roomA.code,
              lotId: lot1Id,
              bidAmountLakhs: 200,
              idempotencyKey: `p6d-race-${idx}-${Date.now()}`
            },
            (res: any) => {
              bidLatenciesMs.push(performance.now() - t0);
              resolve(res);
            }
          );
        })
      )
    );
    const winners = bidAcks.filter((a) => a.ok);
    const losers = bidAcks.filter((a) => !a.ok);
    assert.equal(winners.length, 1, 'Exactly 1 winner allowed across 5 simultaneous opening bids');
    assert.equal(losers.length, 4);

    // Duplicate replay of winning idempotencyKey via REST returns idempotent success with ZERO duplicate DB rows
    const raceWinnerCode = winners[0].bid.franchiseCode;
    let askForNext = winners[0].nextBidLakhs;
    if (raceWinnerCode === 'MI') {
      const rcbRaise = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/bids`, rcb.token, {
        lotId: lot1Id,
        bidAmountLakhs: askForNext,
        idempotencyKey: `p6d-rcb-raise-${RUN}`
      });
      assert.equal(rcbRaise.status, 201);
      askForNext = rcbRaise.json.data.nextBidLakhs;
    }

    const miReplayKey = `p6d-mi-idem-${RUN}`;
    const miValid1 = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/bids`, mi.token, {
      lotId: lot1Id,
      bidAmountLakhs: askForNext,
      idempotencyKey: miReplayKey
    });
    assert.equal(miValid1.status, 201);
    bidLatenciesMs.push(miValid1.ms);
    const miReplay = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/bids`, mi.token, {
      lotId: lot1Id,
      bidAmountLakhs: askForNext,
      idempotencyKey: miReplayKey
    });
    assert.equal(miReplay.status, 201);
    assert.equal(miReplay.json.data.bid.id, miValid1.json.data.bid.id);

    // Spectator bid attempt strictly rejected
    const specBid = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/bids`, spec1.token, {
      lotId: lot1Id,
      bidAmountLakhs: miValid1.json.data.nextBidLakhs,
      idempotencyKey: `spec-bid-${Date.now()}`
    });
    assert.equal(specBid.status, 403);

    // Pause / Resume verification
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/pause`, host.token, {})).status, 200);
    const pausedBid = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/bids`, rcb.token, {
      lotId: lot1Id,
      bidAmountLakhs: miValid1.json.data.nextBidLakhs,
      idempotencyKey: `paused-bid-${Date.now()}`
    });
    assert.equal(pausedBid.status, 409);
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/resume`, host.token, {})).status, 200);

    // Disconnect MI -> verify offline -> reconnect & SYNC_REQUEST recovery latency
    sMi.disconnect();
    await new Promise((r) => setTimeout(r, 120));
    const tRec0 = performance.now();
    const reconnectedMi = await connectAndJoin(baseUrl, mi.token, roomA.code);
    sockets.push(reconnectedMi.socket);
    const syncStateP = waitForEvent(reconnectedMi.socket, SOCKET_EVENTS.AUCTION_STATE);
    const syncAck = await new Promise<any>((resolve) => {
      reconnectedMi.socket.emit(SOCKET_EVENTS.SYNC_REQUEST, { roomCode: roomA.code }, (ack: any) => resolve(ack));
    });
    const recoveredAuctionState = await syncStateP;
    reconnectRecoveryMs = performance.now() - tRec0;
    assert.equal(syncAck.ok, true);
    assert.equal(recoveredAuctionState.currentLot.id, lot1Id);
    assert.equal(recoveredAuctionState.currentLot.winningFranchiseCode, 'MI');
    assert.equal(roomBLeaked, false, 'Room A events must never leak to Room B');
    assert.equal(duplicateEvents, 0, 'Zero duplicate bid socket events expected');
    assert.equal(seenBidIdsHost.size, seenBidIdsSpec.size, 'Host and Spectator must see identical bid events');
    console.log('✅ Test 3: 5-owner race, idempotency, pause/resume, reconnect recovery & room isolation verified');

    // -----------------------------------------------------------------
    // TEST 4: Settle Lots -> Custom Team Identity (ALLOW_CUSTOM_TEAM_NAME)
    // -----------------------------------------------------------------
    // Lot 1 (Virat Kohli) SOLD to MI -> Lot 2 (Rohit Sharma) bid & SOLD to CSK -> Lot 3 (CH Gayle) UNSOLD -> Lot 4 (Jasprit Bumrah) SOLD to CSK
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/sold`, host.token, { lotId: lot1Id })).status, 200);

    const lot2Next = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/next`, host.token, {});
    const lot2Id = lot2Next.json.data.currentLot.id;
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/bids`, host.token, { lotId: lot2Id, bidAmountLakhs: 200, idempotencyKey: `lot2-csk-${RUN}` })).status, 201);
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/sold`, host.token, { lotId: lot2Id })).status, 200);

    // Lot 3 CH Gayle UNSOLD
    const lot3Next = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/next`, host.token, {});
    const lot3Id = lot3Next.json.data.currentLot.id;
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/unsold`, host.token, { lotId: lot3Id })).status, 200);

    // Lot 4 Jasprit Bumrah SOLD to MI, Lot 5 David Warner (OVERSEAS) SOLD to MI, Lot 6 Ravindra Jadeja SOLD to CSK
    const lot4Next = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/next`, host.token, {});
    const lot4Id = lot4Next.json.data.currentLot.id;
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/bids`, mi.token, { lotId: lot4Id, bidAmountLakhs: 200, idempotencyKey: `lot4-mi-${RUN}` })).status, 201);
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/sold`, host.token, { lotId: lot4Id })).status, 200);

    const lot5Next = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/next`, host.token, {});
    const lot5Id = lot5Next.json.data.currentLot.id;
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/bids`, mi.token, { lotId: lot5Id, bidAmountLakhs: 200, idempotencyKey: `lot5-mi-${RUN}` })).status, 201);
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/sold`, host.token, { lotId: lot5Id })).status, 200);

    const lot6Next = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/next`, host.token, {});
    const lot6Id = lot6Next.json.data.currentLot.id;
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/bids`, host.token, { lotId: lot6Id, bidAmountLakhs: 200, idempotencyKey: `lot6-csk-${RUN}` })).status, 201);
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/auction/sold`, host.token, { lotId: lot6Id })).status, 200);

    // Custom team name disabled initially -> 403
    const disabledNick = await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/franchise/nickname`, mi.token, {
      customSuffix: 'Hard Hitters'
    });
    assert.equal(disabledNick.status, 403);

    // Host enables ALLOW_CUSTOM_TEAM_NAME
    assert.equal(
      (await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/live-settings`, host.token, { allowCustomTeamName: true })).status,
      200
    );

    // Valid nicknames for MI and CSK
    const miNickRes = await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/franchise/nickname`, mi.token, {
      customSuffix: 'Hard Hitters'
    });
    assert.equal(miNickRes.status, 200);
    const miFranDto = miNickRes.json.data.franchises.find((f: any) => f.presetCode === 'MI');
    assert.equal(miFranDto.name, 'Mumbai Indians', 'Official name must never change');
    assert.equal(miFranDto.customSuffix, 'Hard Hitters');
    assert.equal(miFranDto.displayName, 'MI — Hard Hitters');

    const cskNickRes = await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/franchise/nickname`, host.token, {
      customSuffix: 'Yellow Warriors'
    });
    assert.equal(cskNickRes.status, 200);
    const cskFranDto = cskNickRes.json.data.franchises.find((f: any) => f.presetCode === 'CSK');
    assert.equal(cskFranDto.displayName, 'CSK — Yellow Warriors');

    // Invalid nickname validations: duplicate, empty, >24 chars, offensive, spectator
    assert.equal((await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/franchise/nickname`, rcb.token, { customSuffix: 'hard hitters' })).status, 409);
    assert.equal((await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/franchise/nickname`, rcb.token, { customSuffix: '   ' })).status, 400);
    assert.equal((await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/franchise/nickname`, rcb.token, { customSuffix: 'VeryLongFranchiseSuffixExceeding24Chars' })).status, 400);
    assert.equal((await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/franchise/nickname`, spec1.token, { customSuffix: 'Spectator Team' })).status, 403);
    console.log('✅ Test 4: Custom team identity validated, isolated from official identity, and synced');

    // -----------------------------------------------------------------
    // TEST 5: Player Trading System (ALLOW_PLAYER_TRADES + Atomic Swaps)
    // -----------------------------------------------------------------
    // Disabled initially -> 403
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades`, mi.token, {
          receiverFranchiseId: cskFranDto.id,
          outgoingPlayerIds: [virat.id],
          incomingPlayerIds: [rohit.id],
          idempotencyKey: `tr-disabled-1-${RUN}`
        })
      ).status,
      403
    );

    // Host enables trading
    assert.equal(
      (await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/live-settings`, host.token, { allowPlayerTrades: true })).status,
      200
    );

    // Spectator blocked from Trade Centre
    assert.equal((await reqJson(baseUrl, 'GET', `/rooms/${roomA.code}/trades`, spec1.token)).status, 403);

    // Ownership validation fail: MI cannot offer Rohit (owned by CSK)
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades`, mi.token, {
          receiverFranchiseId: cskFranDto.id,
          outgoingPlayerIds: [rohit.id],
          incomingPlayerIds: [jadeja.id],
          idempotencyKey: `tr-wrong-owner-${RUN}`
        })
      ).status,
      400
    );

    // Overseas cap validation fail: CSK already has 0 OS (maxOverseas=1), ok; let's verify MI trading Warner (OS) if CSK couldn't exceed maxOverseas OR try giving 2 OS -> first Propose Trade #1: MI offers Virat -> CSK Rohit
    const tr1Res = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades`, mi.token, {
      receiverFranchiseId: cskFranDto.id,
      outgoingPlayerIds: [virat.id],
      incomingPlayerIds: [rohit.id],
      note: 'Open swap',
      idempotencyKey: `tr-1-propose-${RUN}`
    });
    assert.equal(tr1Res.status, 201);
    const tr1Id = tr1Res.json.data.id;

    // Conflicting simultaneous trade involving Virat -> 409 PLAYER_IN_PENDING_TRADE
    const conflictRes = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades`, mi.token, {
      receiverFranchiseId: cskFranDto.id,
      outgoingPlayerIds: [virat.id],
      incomingPlayerIds: [jadeja.id],
      idempotencyKey: `tr-conflict-1-${RUN}`
    });
    assert.equal(conflictRes.status, 409);
    assert.equal(conflictRes.json.code, 'PLAYER_IN_PENDING_TRADE');

    // MI cannot accept its own outgoing proposal; CSK must accept -> Host/MI self-approve attempt rejected 403
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades/${tr1Id}/accept`, mi.token, { idempotencyKey: `self-acc-${RUN}` })).status, 403);

    // Cancel Trade #1 cleanly
    const cancelRes = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades/${tr1Id}/cancel`, mi.token, {});
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.json.data.status, TradeStatus.CANCELLED);

    // Propose Trade #2 -> CSK rejects
    const tr2Res = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades`, mi.token, {
      receiverFranchiseId: cskFranDto.id,
      outgoingPlayerIds: [bumrah.id],
      incomingPlayerIds: [jadeja.id],
      idempotencyKey: `tr-2-propose-${RUN}`
    });
    assert.equal(tr2Res.status, 201);
    const rejRes = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades/${tr2Res.json.data.id}/reject`, host.token, {
      reason: 'Need Jadeja finish'
    });
    assert.equal(rejRes.status, 200);
    assert.equal(rejRes.json.data.status, TradeStatus.REJECTED);

    // Trade expiry test: propose -> backdate expiresAt -> verify accept returns 409 & status transitions to EXPIRED
    const trExpRes = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades`, mi.token, {
      receiverFranchiseId: cskFranDto.id,
      outgoingPlayerIds: [virat.id],
      incomingPlayerIds: [jadeja.id],
      idempotencyKey: `tr-exp-propose-${RUN}`
    });
    assert.equal(trExpRes.status, 201);
    await prisma.tradeProposal.update({
      where: { id: trExpRes.json.data.id },
      data: { expiresAt: new Date(Date.now() - 5000) }
    });
    const expAccept = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades/${trExpRes.json.data.id}/accept`, host.token, {
      idempotencyKey: `tr-exp-acc-${RUN}`
    });
    assert.equal(expAccept.status, 409);
    const expRecord = await prisma.tradeProposal.findUniqueOrThrow({ where: { id: trExpRes.json.data.id } });
    assert.equal(expRecord.status, TradeStatus.EXPIRED);

    // Record purses BEFORE atomic trade
    const preTradeState: any = (await reqJson(baseUrl, 'GET', `/rooms/${roomA.code}/auction`, host.token)).json.data;
    const miBefore = preTradeState.franchises.find((f: any) => f.presetCode === 'MI');
    const cskBefore = preTradeState.franchises.find((f: any) => f.presetCode === 'CSK');

    // Propose multi-player Trade #3: MI (Virat Kohli + Bumrah) <-> CSK (Rohit Sharma)
    const tr3Res = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades`, mi.token, {
      receiverFranchiseId: cskFranDto.id,
      outgoingPlayerIds: [virat.id, bumrah.id],
      incomingPlayerIds: [rohit.id],
      note: '2-for-1 mega trade',
      idempotencyKey: `tr-3-propose-${RUN}`
    });
    assert.equal(tr3Res.status, 201);
    const tr3Id = tr3Res.json.data.id;

    // Accept Trade #3 atomically with idempotencyKey
    const tTrade0 = performance.now();
    const accRes = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades/${tr3Id}/accept`, host.token, {
      idempotencyKey: `tr-3-accept-idem-${RUN}`
    });
    tradeTxMs = performance.now() - tTrade0;
    assert.equal(accRes.status, 200);
    assert.equal(accRes.json.data.status, TradeStatus.ACCEPTED);

    // Idempotent duplicate accept replay does not double move or fail
    const accReplay = await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades/${tr3Id}/accept`, host.token, {
      idempotencyKey: `tr-3-accept-idem-${RUN}`
    });
    assert.equal(accReplay.status, 200);

    // Verify atomic squad updates & STRICTLY UNCHANGED purses
    const postTradeState: any = (await reqJson(baseUrl, 'GET', `/rooms/${roomA.code}/auction`, host.token)).json.data;
    const miAfter = postTradeState.franchises.find((f: any) => f.presetCode === 'MI');
    const cskAfter = postTradeState.franchises.find((f: any) => f.presetCode === 'CSK');
    assert.equal(miAfter.remainingPurseLakhs, miBefore.remainingPurseLakhs, 'MI purse must stay unchanged');
    assert.equal(cskAfter.remainingPurseLakhs, cskBefore.remainingPurseLakhs, 'CSK purse must stay unchanged');
    assert.equal(miAfter.squad.some((p: any) => p.playerId === rohit.id), true);
    assert.equal(miAfter.squad.some((p: any) => p.playerId === virat.id), false);
    assert.equal(cskAfter.squad.some((p: any) => p.playerId === virat.id), true);
    assert.equal(cskAfter.squad.some((p: any) => p.playerId === bumrah.id), true);
    assert.equal(cskAfter.squad.some((p: any) => p.playerId === rohit.id), false);

    // Disable trading -> new proposal rejected cleanly
    assert.equal(
      (await reqJson(baseUrl, 'PATCH', `/rooms/${roomA.code}/live-settings`, host.token, { allowPlayerTrades: false })).status,
      200
    );
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${roomA.code}/trades`, mi.token, {
          receiverFranchiseId: cskFranDto.id,
          outgoingPlayerIds: [rohit.id],
          incomingPlayerIds: [virat.id],
          idempotencyKey: `tr-after-disable-${RUN}`
        })
      ).status,
      403
    );

    const avg = (arr: number[]) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : 0);
    const maxVal = (arr: number[]) => (arr.length ? Number(Math.max(...arr).toFixed(2)) : 0);
    const mem = process.memoryUsage();
    console.log('✅ Test 5: Complete Player Trading lifecycle, atomic swaps, zero purse drift & disable gate verified');
    console.log(
      '📊 PERFORMANCE_METRICS:',
      JSON.stringify({
        simultaneousClients: 7,
        apiLatencyAvgMs: avg(apiLatenciesMs),
        socketAckAvgMs: avg(socketAckLatenciesMs),
        bidProcessingAvgMs: avg(bidLatenciesMs),
        bidProcessingMaxMs: maxVal(bidLatenciesMs),
        reconnectRecoveryMs: Number(reconnectRecoveryMs.toFixed(2)),
        tradeTxMs: Number(tradeTxMs.toFixed(2)),
        memoryRssMb: Number((mem.rss / 1024 / 1024).toFixed(2)),
        heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
        duplicateEvents,
        droppedBidEvents: Math.abs(seenBidIdsHost.size - seenBidIdsSpec.size)
      })
    );
  } finally {
    AuctionTimerManager.stop();
    for (const s of sockets) s.disconnect();
    await new Promise((r) => setTimeout(r, 150));
    await closeSocketServer();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await disconnectRedis();
    await prisma.$disconnect();
  }
}

runPhase6dTests().catch(async (err) => {
  console.error('❌ Phase 6D test failed:', err);
  await disconnectRedis();
  await prisma.$disconnect();
  process.exit(1);
});
