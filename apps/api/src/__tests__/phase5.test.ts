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

async function reqJson(
  baseUrl: string,
  method: string,
  path: string,
  token?: string,
  body?: unknown
) {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const json: any = await res.json();
  return { status: res.status, json };
}

async function runPhase5Tests() {
  await prisma.$connect();
  await connectRedis();
  const rlKeys = await redis.keys('rl:*');
  if (rlKeys.length > 0) await redis.del(...rlKeys);
  await prisma.room.deleteMany({ where: { name: 'Phase 5 Unsold Reentry Room' } });
  await prisma.masterPlayer.deleteMany({
    where: { cricsheetId: { in: ['test-cs-p5-alpha', 'test-cs-p5-fail'] } }
  });
  await prisma.playerImportBatch.deleteMany({
    where: { sourceName: { startsWith: 'p5_test_' } }
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
    // 1. Verify Expanded Verifiable IPL Player Catalog (809 players, 2008-2026) & search/filters
    const catalogAll = await reqJson(baseUrl, 'GET', '/players/catalog?limit=25&sort=runs');
    assert.equal(catalogAll.status, 200);
    assert.ok(catalogAll.json.meta.total >= 800, `Expected >=800 IPL players, got ${catalogAll.json.meta.total}`);
    assert.ok(catalogAll.json.meta.totalSeasonRecords >= 3000);
    assert.ok(catalogAll.json.meta.seasonsAvailable.includes(2008));
    assert.ok(catalogAll.json.meta.seasonsAvailable.includes(2026));
    assert.equal(catalogAll.json.data[0].fullName, 'Virat Kohli');

    const overseasBowlersRcb = await reqJson(
      baseUrl,
      'GET',
      '/players/catalog?role=BOWLER&overseas=true&team=RCB&season=2016'
    );
    assert.equal(overseasBowlersRcb.status, 200);
    assert.ok(overseasBowlersRcb.json.data.every((p: any) => p.playingRole === 'BOWLER' && p.isOverseas));
    console.log(`✓ Test 1: Verified catalog (${catalogAll.json.meta.total} players, ${catalogAll.json.meta.totalSeasonRecords} season rows) & search filters`);

    // 2. Detailed Player Profile & Null Preservation (no fake zeroes!)
    const vkId = catalogAll.json.data[0].id;
    const vkProfile = await reqJson(baseUrl, 'GET', `/players/${vkId}/profile`);
    assert.equal(vkProfile.status, 200);
    assert.ok(vkProfile.json.data.seasonStats.length >= 15);
    assert.ok(vkProfile.json.data.careerSummary.batting.runs >= 8000);
    assert.equal(vkProfile.json.data.provenanceSource.includes('cricsheet'), true);

    // Check a season where Kohli didn't bowl preserves bowling averages/economy strictly as null
    const noBowlSeason = vkProfile.json.data.seasonStats.find((s: any) => s.wickets === null && s.economy === null);
    assert.ok(noBowlSeason, 'Expected missing/inapplicable bowling stats to remain null, never 0');

    // Check Jasprit Bumrah has verified wickets & missing 100s/batting average handled properly
    const jbSearch = await reqJson(baseUrl, 'GET', '/players/catalog?search=Jasprit+Bumrah');
    assert.equal(jbSearch.status, 200);
    const jbId = jbSearch.json.data[0].id;
    const jbProfile = await reqJson(baseUrl, 'GET', `/players/${jbId}/profile`);
    assert.equal(jbProfile.status, 200);
    assert.ok(jbProfile.json.data.careerSummary.bowling.wickets > 100);
    console.log('✓ Test 2: Detailed player profiles, career breakdown & null preservation verified');

    // 3. Player Identity Matching, Duplicate CSV Detection, Validation & Safe Rollback on Failure
    const guest = await createGuest(baseUrl, 'P5 Curator');

    const badDupCsv = [
      'fullName,cricsheetId,nationality,playingRole,battingStyle,bowlingStyle',
      'Nicolas Pooran,,West Indies,WICKET_KEEPER,LEFT_HAND,RIGHT_ARM_SPIN',
      'Virat Kohli,,India,BATSMAN,RIGHT_HAND,RIGHT_ARM_MEDIUM',
      'Virat Kohli,,India,BATSMAN,RIGHT_HAND,RIGHT_ARM_MEDIUM'
    ].join('\n');

    const dupPreview = await reqJson(baseUrl, 'POST', '/players/import/preview', guest.token, {
      importMode: 'PLAYERS',
      sourceName: 'p5_test_dup',
      csvText: badDupCsv
    });
    assert.equal(dupPreview.status, 200);
    assert.equal(dupPreview.json.data.canCommit, false);
    assert.equal(dupPreview.json.data.duplicateCount, 1);
    assert.equal(dupPreview.json.data.previewRows[0].matchedBy, 'fullName', 'Alias Nicolas Pooran should match Nicholas Pooran');

    // Attempting commit with invalid/failed CSV rejects cleanly and mutates 0 players
    const countBeforeFail = await prisma.masterPlayer.count();
    const failSeasonCsv = [
      'fullName,season,runs,wickets',
      'Virat Kohli,2027,120,0',
      'Definitely Nonexistent Player XYZ,2027,50,1'
    ].join('\n');
    const failCommit = await reqJson(baseUrl, 'POST', '/players/import/commit', guest.token, {
      importMode: 'SEASONS',
      sourceName: 'p5_test_atomic_fail',
      csvText: failSeasonCsv
    });
    assert.equal(failCommit.status, 400);
    assert.equal(await prisma.masterPlayer.count(), countBeforeFail);
    const vk2027Check = await prisma.playerSeasonStat.findFirst({ where: { playerId: vkId, season: 2027 } });
    assert.equal(vk2027Check, null, 'Failed SEASONS batch must atomically roll back preceding valid rows');
    console.log('✓ Test 3: Identity matching (alias), duplicate detection & atomic failed-import rollback verified');

    // 4. Valid PLAYERS CSV Commit + Batch Rollback
    const validPlayersCsv = [
      'fullName,cricsheetId,nationality,playingRole,battingStyle,bowlingStyle,iplDebutYear,basePriceLakhs',
      'Test Auction Prospect Alpha,test-cs-p5-alpha,India,ALL_ROUNDER,LEFT_HAND,,2026,75'
    ].join('\n');
    const goodCommit = await reqJson(baseUrl, 'POST', '/players/import/commit', guest.token, {
      importMode: 'PLAYERS',
      sourceName: 'p5_test_valid_players',
      csvText: validPlayersCsv
    });
    assert.equal(goodCommit.status, 201);
    const batchId = goodCommit.json.data.batch.id;
    const insertedPlayer = await prisma.masterPlayer.findUnique({ where: { cricsheetId: 'test-cs-p5-alpha' } });
    assert.ok(insertedPlayer);
    assert.equal(insertedPlayer.bowlingStyle, null, 'Blank bowlingStyle in CSV must stay null');

    // Import valid season row for inserted player preserving empty bowling stats as null
    const validSeasonCsv = [
      'cricsheetId,season,teamCode,matches,runs,ballsFaced,notOuts,wickets,economy',
      'test-cs-p5-alpha,2026,CSK,4,88,61,1,,'
    ].join('\n');
    const seasonCommit = await reqJson(baseUrl, 'POST', '/players/import/commit', guest.token, {
      importMode: 'SEASONS',
      sourceName: 'p5_test_valid_season',
      csvText: validSeasonCsv
    });
    assert.equal(seasonCommit.status, 201);
    const stat2026 = await prisma.playerSeasonStat.findUnique({
      where: { playerId_season: { playerId: insertedPlayer.id, season: 2026 } }
    });
    assert.equal(stat2026?.runs, 88);
    assert.equal(stat2026?.wickets, null);
    assert.equal(stat2026?.economy, null);

    // Rollback PLAYERS batch -> cleanly deletes unreferenced synthetic test player
    const rbRes = await reqJson(
      baseUrl,
      'POST',
      `/players/import/batches/${batchId}/rollback`,
      guest.token,
      {}
    );
    assert.equal(rbRes.status, 200);
    assert.equal(rbRes.json.data.status, 'ROLLED_BACK');
    assert.equal(await prisma.masterPlayer.findUnique({ where: { id: insertedPlayer.id } }), null);
    console.log('✓ Test 4: Valid CSV PLAYERS + SEASONS commit, missing-stat null preservation & batch rollback verified');

    // 5. Unsold Player Re-Entry + Complete Bid History + Duplicate Sale Prevention
    const host = await createGuest(baseUrl, 'P5 Host CSK');
    const owner2 = await createGuest(baseUrl, 'P5 Owner MI');
    const roomCreate = await reqJson(baseUrl, 'POST', '/rooms', host.token, {
      roomName: 'Phase 5 Unsold Reentry Room',
      visibility: RoomVisibility.PUBLIC,
      displayName: 'P5 Host CSK',
      franchiseCode: 'CSK',
      settings: {
        initialPurseLakhs: 10000,
        minSquadSize: 1,
        maxSquadSize: 5,
        maxOverseas: 3,
        countdownSeconds: 20,
        bidExtensionSeconds: 0,
        extensionThresholdSeconds: 2,
        allowHostSkip: true
      }
    });
    assert.equal(roomCreate.status, 201);
    const room = roomCreate.json.data;
    createdRoomIds.push(room.id);

    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${room.code}/join`, owner2.token, {
          displayName: 'P5 Owner MI',
          joinAs: RoomRole.OWNER,
          franchiseCode: 'MI'
        })
      ).status,
      200
    );

    const p1 = vkId;
    const p2 = jbId;
    assert.equal(
      (
        await reqJson(baseUrl, 'PUT', `/rooms/${room.code}/pool`, host.token, {
          lots: [
            { playerId: p1, setCategory: 'MARQUEE', basePriceLakhs: 200, sequenceOrder: 1 },
            { playerId: p2, setCategory: 'PACERS', basePriceLakhs: 200, sequenceOrder: 2 }
          ]
        })
      ).status,
      200
    );
    assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${room.code}/config/finalize`, host.token, {})).status, 200);
    assert.equal((await reqJson(baseUrl, 'PATCH', `/rooms/${room.code}/ready`, host.token, { isReady: true })).status, 200);
    assert.equal((await reqJson(baseUrl, 'PATCH', `/rooms/${room.code}/ready`, owner2.token, { isReady: true })).status, 200);

    const sHost = await connectSocket(baseUrl, host.token);
    const sOwner = await connectSocket(baseUrl, owner2.token);
    sockets.push(sHost, sOwner);
    await Promise.all([joinSocketRoom(sHost, room.code), joinSocketRoom(sOwner, room.code)]);

    const startRes = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/start`, host.token, {});
    assert.equal(startRes.status, 200);
    const lot1Id = startRes.json.data.currentLot.id;

    // CSK bids and buys Lot #1 (SOLD)
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/bids`, host.token, {
          lotId: lot1Id,
          bidAmountLakhs: 200,
          idempotencyKey: 'p5-l1-csk-200'
        })
      ).status,
      201
    );
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/sold`, host.token, {
          lotId: lot1Id
        })
      ).status,
      200
    );

    // Advance to Lot #2 -> mark UNSOLD (room stays in PLAYER_UNSOLD or next moves to COMPLETED)
    const nextRes = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/next`, host.token, {});
    assert.equal(nextRes.status, 200);
    const lot2Id = nextRes.json.data.currentLot.id;

    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/unsold`, host.token, {
          lotId: lot2Id
        })
      ).status,
      200
    );
    const finishR1 = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/next`, host.token, {});
    assert.equal(finishR1.status, 200);
    assert.equal(finishR1.json.data.auctionStage, 'COMPLETED');
    assert.equal(finishR1.json.data.unsoldCount, 1);

    // Attempting to re-enter SOLD lot1 must fail (409)
    const badRequeue = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/requeue-unsold`, host.token, {
      lotIds: [lot1Id]
    });
    assert.equal(badRequeue.status, 409);

    // Host re-enters all unsold lots -> socket event LOT_ROUND_REENTERED + room reopens LIVE in Round 2 with Lot #2
    const reentryPromise = waitForEvent(sOwner, SOCKET_EVENTS.LOT_ROUND_REENTERED);
    const requeueRes = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/requeue-unsold`, host.token, {});
    assert.equal(requeueRes.status, 200);
    const reentryEvt = await reentryPromise;
    assert.equal(reentryEvt.roundNumber, 2);
    assert.equal(reentryEvt.requeuedCount, 1);
    assert.equal(requeueRes.json.data.auctionStage, 'LIVE');
    assert.equal(requeueRes.json.data.currentLot.id, lot2Id);
    assert.equal(requeueRes.json.data.currentLot.roundNumber, 2);

    // MI bids on Lot #2 in Round 2 -> Host marks SOLD -> room completes cleanly on next -> 2 total purchases, purses exact!
    assert.equal(
      (
        await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/bids`, owner2.token, {
          lotId: lot2Id,
          bidAmountLakhs: 200,
          idempotencyKey: 'p5-l2-mi-r2-200'
        })
      ).status,
      201
    );
    const soldR2 = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/sold`, host.token, {
      lotId: lot2Id
    });
    assert.equal(soldR2.status, 200);
    assert.equal(soldR2.json.data.unsoldCount, 0);
    assert.equal(soldR2.json.data.allBids.length, 2, 'Complete bid history should preserve Round 1 & Round 2 bids');
    assert.equal(soldR2.json.data.recentResults.length, 2);

    const completeFinal = await reqJson(baseUrl, 'POST', `/rooms/${room.code}/auction/next`, host.token, {});
    assert.equal(completeFinal.json.data.auctionStage, 'COMPLETED');

    const purchasesCount = await prisma.purchase.count({ where: { roomId: room.id } });
    assert.equal(purchasesCount, 2, 'Exactly 2 unique Purchase records allowed (zero duplicates)');
    const cskState = completeFinal.json.data.franchises.find((f: any) => f.presetCode === 'CSK');
    const miState = completeFinal.json.data.franchises.find((f: any) => f.presetCode === 'MI');
    assert.equal(cskState.remainingPurseLakhs, 9800);
    assert.equal(miState.remainingPurseLakhs, 9800);
    console.log('✓ Test 5: Unsold re-entry Round 2, complete bid/results history & zero duplicate sales verified');

    console.log('ALL PHASE 5 TESTS PASSED (5/5)');
  } finally {
    AuctionTimerManager.stop();
    for (const s of sockets) s.disconnect();
    if (createdRoomIds.length > 0) {
      await prisma.room.deleteMany({ where: { id: { in: createdRoomIds } } });
    }
    await prisma.masterPlayer.deleteMany({
      where: { cricsheetId: { in: ['test-cs-p5-alpha', 'test-cs-p5-fail'] } }
    });
    await prisma.playerImportBatch.deleteMany({
      where: { sourceName: { startsWith: 'p5_test_' } }
    });
    await closeSocketServer();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectRedis();
    await prisma.$disconnect();
  }
}

runPhase5Tests().catch((err) => {
  console.error('Phase 5 tests failed:', err);
  process.exit(1);
});
