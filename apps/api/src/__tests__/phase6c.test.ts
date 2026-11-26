import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { prisma } from '@auctioncraze/database';
import { RoomRole, RoomStatus, RoomVisibility } from '@auctioncraze/shared';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const ML_PORT = 8021;
process.env.ML_SERVICE_URL = `http://127.0.0.1:${ML_PORT}`;

async function waitForMlHealth(url: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error(`Timed out waiting for ML service at ${url}`);
}

async function createGuest(baseUrl: string, displayName: string) {
  const res = await fetch(`${baseUrl}/api/v1/sessions/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName })
  });
  assert.equal(res.status, 201);
  const body: any = await res.json();
  return { token: body.data.token as string, sessionId: body.data.session.id as string };
}

async function runPhase6cApiTests(): Promise<void> {
  const mlDir = path.resolve(__dirname, '../../../../services/ml');
  const mlProc = spawn(
    'python',
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(ML_PORT)],
    { cwd: mlDir, stdio: 'pipe' }
  );

  let server: http.Server | null = null;
  const createdRoomIds: string[] = [];
  const createdSessionIds: string[] = [];

  try {
    await waitForMlHealth(`http://127.0.0.1:${ML_PORT}`);

    const { createApp } = await import('../app');
    const { connectRedis, disconnectRedis } = await import('../lib/redis');

    await connectRedis();
    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as any;
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Setup Room A (Host=CSK, Owner2=MI, Owner3=RCB with tiny 2-player squad, Spectator=Spec)
    // and Room B (Host=CSK in separate room)
    const hostA = await createGuest(baseUrl, 'P6C_Host_CSK');
    const ownerMiA = await createGuest(baseUrl, 'P6C_Owner_MI');
    const ownerRcbA = await createGuest(baseUrl, 'P6C_Owner_RCB');
    const specA = await createGuest(baseUrl, 'P6C_Spectator');
    const otherHostB = await createGuest(baseUrl, 'P6C_RoomB_Host');
    createdSessionIds.push(
      hostA.sessionId,
      ownerMiA.sessionId,
      ownerRcbA.sessionId,
      specA.sessionId,
      otherHostB.sessionId
    );

    const createRes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostA.token}` },
      body: JSON.stringify({
        roomName: 'Phase 6C Post Auction Room',
        displayName: 'P6C_Host_CSK',
        visibility: RoomVisibility.PUBLIC,
        franchiseCode: 'CSK',
        settings: {
          minSquadSize: 2,
          maxSquadSize: 25,
          maxOverseas: 8,
          countdownSeconds: 20,
          bidExtensionSeconds: 0,
          extensionThresholdSeconds: 2
        }
      })
    });
    assert.equal(createRes.status, 201);
    const roomA: any = (await createRes.json()).data;
    createdRoomIds.push(roomA.id);

    const csk = roomA.franchises.find((f: any) => f.presetCode === 'CSK');
    const mi = roomA.franchises.find((f: any) => f.presetCode === 'MI');
    const rcb = roomA.franchises.find((f: any) => f.presetCode === 'RCB');
    assert.ok(csk && mi && rcb);

    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerMiA.token}` },
          body: JSON.stringify({ displayName: 'P6C_Owner_MI', joinAs: RoomRole.OWNER, franchiseCode: 'MI' })
        })
      ).status,
      200
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerRcbA.token}` },
          body: JSON.stringify({ displayName: 'P6C_Owner_RCB', joinAs: RoomRole.OWNER, franchiseCode: 'RCB' })
        })
      ).status,
      200
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/join`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${specA.token}` },
          body: JSON.stringify({ displayName: 'P6C_Spectator', joinAs: RoomRole.SPECTATOR })
        })
      ).status,
      200
    );

    const roomBRes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${otherHostB.token}` },
      body: JSON.stringify({
        roomName: 'Phase 6C Isolated Room B',
        displayName: 'P6C_RoomB_Host',
        visibility: RoomVisibility.PRIVATE,
        franchiseCode: 'CSK'
      })
    });
    assert.equal(roomBRes.status, 201);
    const roomB: any = (await roomBRes.json()).data;
    createdRoomIds.push(roomB.id);

    // -----------------------------------------------------------------
    // TEST 1: Pre-completion guardrails (LOBBY/LIVE rejected with 409)
    // -----------------------------------------------------------------
    const hostHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${hostA.token}` };
    const preReady = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/readiness`,
      { headers: hostHeaders }
    );
    assert.equal(preReady.status, 200);
    assert.equal(((await preReady.json()) as any).data.isCompleted, false);

    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/ratings`, {
          headers: hostHeaders
        })
      ).status,
      409
    );
    console.log('✅ Test 1: Post-auction ratings strictly gated while auction is not COMPLETED (409)');

    // -----------------------------------------------------------------
    // TEST 2: Real Auction SOLD/UNSOLD lifecycle -> COMPLETED
    // -----------------------------------------------------------------
    // Pre-retain 11 players on CSK & 10 players on MI + 2 players on RCB (insufficient data!)
    const cskNames = [
      'Rohit Sharma', 'Shubman Gill', 'Suryakumar Yadav', 'MS Dhoni', 'Ravindra Jadeja',
      'Hardik Pandya', 'Jasprit Bumrah', 'Mohammed Siraj', 'Yuzvendra Chahal', 'Jos Buttler', 'Trent Boult'
    ];
    const miNames = [
      'Shikhar Dhawan', 'KL Rahul', 'Rishabh Pant', 'Sanju Samson', 'Shreyas Iyer',
      'Axar Patel', 'Kuldeep Yadav', 'Bhuvneshwar Kumar', 'David Warner', 'Rashid Khan'
    ];
    const rcbNames = ['Andre Russell', 'Sunil Narine']; // < 5 players => INSUFFICIENT_DATA
    const soldTarget = await prisma.masterPlayer.findFirstOrThrow({ where: { fullName: 'Virat Kohli' } });
    const unsoldExcluded = await prisma.masterPlayer.findFirstOrThrow({ where: { fullName: 'CH Gayle' } });

    const [cskPlayers, miPlayers, rcbPlayers] = await Promise.all([
      prisma.masterPlayer.findMany({ where: { fullName: { in: cskNames } } }),
      prisma.masterPlayer.findMany({ where: { fullName: { in: miNames } } }),
      prisma.masterPlayer.findMany({ where: { fullName: { in: rcbNames } } })
    ]);

    await prisma.roomRetention.createMany({
      data: [
        ...cskPlayers.map((p, idx) => ({
          roomId: roomA.id, franchiseId: csk.id, playerId: p.id, retentionCostLakhs: 200, slotNumber: idx + 1
        })),
        ...miPlayers.map((p, idx) => ({
          roomId: roomA.id, franchiseId: mi.id, playerId: p.id, retentionCostLakhs: 200, slotNumber: idx + 1
        })),
        ...rcbPlayers.map((p, idx) => ({
          roomId: roomA.id, franchiseId: rcb.id, playerId: p.id, retentionCostLakhs: 200, slotNumber: idx + 1
        }))
      ]
    });
    await Promise.all([
      prisma.roomFranchise.update({
        where: { id: csk.id },
        data: { squadCount: cskPlayers.length, overseasCount: cskPlayers.filter((p) => p.isOverseas).length, remainingPurseLakhs: 7800 }
      }),
      prisma.roomFranchise.update({
        where: { id: mi.id },
        data: { squadCount: miPlayers.length, overseasCount: miPlayers.filter((p) => p.isOverseas).length, remainingPurseLakhs: 8000 }
      }),
      prisma.roomFranchise.update({
        where: { id: rcb.id },
        data: { squadCount: rcbPlayers.length, overseasCount: rcbPlayers.filter((p) => p.isOverseas).length, remainingPurseLakhs: 9600 }
      })
    ]);

    // Configure pool with 2 lots: Virat Kohli (will be SOLD to MI) & Chris Gayle (will go UNSOLD)
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/pool`, {
          method: 'PUT',
          headers: hostHeaders,
          body: JSON.stringify({
            lots: [
              { playerId: soldTarget.id, sequenceOrder: 1, setCategory: 'Marquee', basePriceLakhs: 200 },
              { playerId: unsoldExcluded.id, sequenceOrder: 2, setCategory: 'Marquee', basePriceLakhs: 200 }
            ]
          })
        })
      ).status,
      200
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/config/finalize`, {
          method: 'POST',
          headers: hostHeaders
        })
      ).status,
      200
    );

    const miHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerMiA.token}` };
    const rcbHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerRcbA.token}` };
    for (const h of [hostHeaders, miHeaders, rcbHeaders]) {
      await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/ready`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify({ isReady: true })
      });
    }

    const startRes = await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/auction/start`, {
      method: 'POST',
      headers: hostHeaders
    });
    assert.equal(startRes.status, 200);
    const startSnap: any = (await startRes.json()).data;
    const lot1Id = startSnap.currentLot.id;

    // MI bids on Virat Kohli & Host marks SOLD
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/auction/bids`, {
          method: 'POST',
          headers: miHeaders,
          body: JSON.stringify({ lotId: lot1Id, bidAmountLakhs: 200, idempotencyKey: 'p6c-bid-1' })
        })
      ).status,
      201
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/auction/sold`, {
          method: 'POST',
          headers: hostHeaders,
          body: JSON.stringify({ lotId: lot1Id })
        })
      ).status,
      200
    );

    // Next player -> Chris Gayle -> UNSOLD -> Next -> Auction reaches COMPLETED!
    const next1Res = await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/auction/next`, {
      method: 'POST',
      headers: hostHeaders
    });
    assert.equal(next1Res.status, 200);
    const lot2Id = ((await next1Res.json()) as any).data.currentLot.id;

    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/auction/unsold`, {
          method: 'POST',
          headers: hostHeaders,
          body: JSON.stringify({ lotId: lot2Id })
        })
      ).status,
      200
    );

    const endRes = await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/auction/next`, {
      method: 'POST',
      headers: hostHeaders
    });
    assert.equal(endRes.status, 200);
    assert.equal(((await endRes.json()) as any).data.auctionStage, 'COMPLETED');
    console.log('✅ Test 2: Real auction completed with Virat Kohli SOLD to MI and Chris Gayle UNSOLD');

    // -----------------------------------------------------------------
    // TEST 3: Host comparison, SOLD inclusion, UNSOLD exclusion & reproducibility
    // -----------------------------------------------------------------
    const hostRatings1Res = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/ratings`,
      { headers: hostHeaders }
    );
    assert.equal(hostRatings1Res.status, 200);
    const r1: any = (await hostRatings1Res.json()).data;
    assert.equal(r1.snapshotVersion, 1);
    assert.equal(r1.isOfficialRating, false);
    assert.equal(r1.allowBiddingAdvice, false);

    // Reproducibility: second call with unchanged roster reuses exact snapshot v1
    const hostRatings2Res = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/ratings`,
      { headers: hostHeaders }
    );
    assert.equal(hostRatings2Res.status, 200);
    const r2: any = (await hostRatings2Res.json()).data;
    assert.equal(r2.snapshotVersion, 1);
    assert.equal(r2.rosterFingerprint, r1.rosterFingerprint);

    // RCB (2 players) must be unranked (rank: null, INSUFFICIENT_DATA); CSK & MI ranked #1/#2
    const rcbRow = r1.overallRankings.find((x: any) => x.franchiseCode === 'RCB');
    const miRow = r1.overallRankings.find((x: any) => x.franchiseCode === 'MI');
    assert.ok(rcbRow && miRow);
    assert.equal(rcbRow.sufficiencyStatus, 'INSUFFICIENT_DATA');
    assert.equal(rcbRow.rank, null);
    assert.equal(rcbRow.overallRating, null);
    assert.ok(miRow.rank === 1 || miRow.rank === 2);

    // Host comparison & MI report checks: Virat Kohli included in MI, UNSOLD Chris Gayle strictly excluded!
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/comparison`, {
          headers: hostHeaders
        })
      ).status,
      200
    );

    const miRepRes = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/franchises/${mi.id}/report`,
      { headers: hostHeaders }
    );
    assert.equal(miRepRes.status, 200);
    const miRep: any = (await miRepRes.json()).data.report;
    const miRosterNames = miRep.roster.map((p: any) => p.fullName);
    assert.ok(miRosterNames.includes('Virat Kohli'), 'Purchased Virat Kohli must appear in MI post-auction roster');
    assert.ok(!miRosterNames.includes('CH Gayle'), 'UNSOLD CH Gayle must NOT appear in MI roster');
    assert.ok(!JSON.stringify(miRep).includes('CH Gayle'), 'UNSOLD player must not appear anywhere in franchise report');
    assert.equal(miRep.playing_xi_prediction.available, true);
    assert.equal(miRep.playing_xi_prediction.is_prediction, true);
    assert.equal(miRep.playing_xi_prediction.playing_xi.length, 11);

    // Recalculation increments snapshotVersion cleanly
    const recalcRes = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/recalculate`,
      { method: 'POST', headers: hostHeaders, body: '{}' }
    );
    assert.equal(recalcRes.status, 200);
    assert.equal(((await recalcRes.json()) as any).data.snapshotVersion, 2);
    console.log('✅ Test 3: Host dashboard, SOLD inclusion, UNSOLD exclusion, insufficient-data unranked status, and snapshot versioning verified');

    // -----------------------------------------------------------------
    // TEST 4: Franchise Owner (MI) vs Rival (403) vs Spectator (403) vs Unauth (401) vs Cross-Room (403)
    // -----------------------------------------------------------------
    // MI owner can access readiness + OWN report & Playing XI
    const miOwnRep = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/franchises/${mi.id}/report`,
      { headers: miHeaders }
    );
    assert.equal(miOwnRep.status, 200);
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/franchises/${mi.id}/playing-xi`,
          { headers: miHeaders }
        )
      ).status,
      200
    );

    // MI owner CANNOT access host-wide ratings, comparison, recalculate, or rival CSK report!
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/ratings`, {
          headers: miHeaders
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/comparison`, {
          headers: miHeaders
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/recalculate`, {
          method: 'POST',
          headers: miHeaders
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/franchises/${csk.id}/report`,
          { headers: miHeaders }
        )
      ).status,
      403
    );

    // Spectator blocked (403) across ALL post-auction endpoints
    const specHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${specA.token}` };
    for (const url of [
      `/api/v1/intelligence/rooms/${roomA.code}/post-auction/readiness`,
      `/api/v1/intelligence/rooms/${roomA.code}/post-auction/ratings`,
      `/api/v1/intelligence/rooms/${roomA.code}/post-auction/comparison`,
      `/api/v1/intelligence/rooms/${roomA.code}/post-auction/franchises/${mi.id}/report`
    ]) {
      assert.equal((await fetch(`${baseUrl}${url}`, { headers: specHeaders })).status, 403);
      assert.equal((await fetch(`${baseUrl}${url}`)).status, 401);
    }

    // Cross-room access denied (Room B Host -> Room A -> 403)
    const roomBHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${otherHostB.token}` };
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/ratings`, {
          headers: roomBHeaders
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/post-auction/franchises/${mi.id}/report`,
          { headers: roomBHeaders }
        )
      ).status,
      403
    );
    console.log('✅ Test 4: Strict server-side RBAC verified (Host-only comparison, owner-only private report, spectator 403, unauth 401, cross-room 403)');

    await disconnectRedis();
  } finally {
    for (const rid of createdRoomIds) {
      await prisma.room.delete({ where: { id: rid } }).catch(() => {});
    }
    for (const sid of createdSessionIds) {
      await prisma.guestSession.delete({ where: { id: sid } }).catch(() => {});
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    mlProc.kill();
    await prisma.$disconnect();
  }
}

runPhase6cApiTests().catch((err) => {
  console.error('❌ Phase 6C Post-Auction Team Ratings test failed:', err);
  process.exit(1);
});
