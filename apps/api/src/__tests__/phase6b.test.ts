import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
import { prisma } from '@auctioncraze/database';
import { RoomRole, RoomVisibility } from '@auctioncraze/shared';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const ML_PORT = 8019;
const ML_FAILCLOSED_PORT = 8020;
process.env.ML_SERVICE_URL = `http://127.0.0.1:${ML_PORT}`;

async function waitForMlHealth(url: string, timeoutMs = 45000): Promise<void> {
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

function assertNoSensitiveKeys(obj: unknown, label: string): void {
  const forbidden = new Set([
    'artifact_path',
    'dataset_fingerprint',
    'holdout_metrics',
    'validation_metrics',
    'validation_candidates',
    'baseline_comparisons',
    'selected_candidate',
    'feature_breakdown',
    'team_elo',
    'sample_counts'
  ]);
  const text = JSON.stringify(obj);
  for (const key of forbidden) {
    assert.ok(!text.includes(`"${key}"`), `Sensitive internal key '${key}' leaked in ${label}`);
  }
}

async function runPhase6bApiTests(): Promise<void> {
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

    // Verify Virat Kohli exists in catalog
    const vk = await prisma.masterPlayer.findFirst({ where: { fullName: 'Virat Kohli' } });
    assert.ok(vk, 'Virat Kohli must exist in MasterPlayer seed');

    // Setup Room A (Host = CSK, Owner = MI with 13 players, Spectator = SpecUser)
    // and Room B (Host = CSK in separate room)
    const hostA = await createGuest(baseUrl, 'P6B_Host_CSK');
    const ownerMiA = await createGuest(baseUrl, 'P6B_Owner_MI');
    const specA = await createGuest(baseUrl, 'P6B_Spectator');
    const ownerB = await createGuest(baseUrl, 'P6B_OtherRoom_CSK');
    createdSessionIds.push(hostA.sessionId, ownerMiA.sessionId, specA.sessionId, ownerB.sessionId);

    const roomARes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hostA.token}` },
      body: JSON.stringify({
        roomName: 'Phase 6B Security Room A',
        displayName: 'P6B_Host_CSK',
        visibility: RoomVisibility.PUBLIC,
        franchiseCode: 'CSK'
      })
    });
    assert.equal(roomARes.status, 201);
    const roomA: any = (await roomARes.json()).data;
    createdRoomIds.push(roomA.id);
    const miFranchise = roomA.franchises.find((f: any) => f.presetCode === 'MI');
    const cskFranchise = roomA.franchises.find((f: any) => f.presetCode === 'CSK');
    assert.ok(miFranchise && cskFranchise);

    const joinMiRes = await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerMiA.token}` },
      body: JSON.stringify({ displayName: 'P6B_Owner_MI', joinAs: RoomRole.OWNER, franchiseCode: 'MI' })
    });
    assert.equal(joinMiRes.status, 200);

    const joinSpecRes = await fetch(`${baseUrl}/api/v1/rooms/${roomA.code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${specA.token}` },
      body: JSON.stringify({ displayName: 'P6B_Spectator', joinAs: RoomRole.SPECTATOR })
    });
    assert.equal(joinSpecRes.status, 200);

    const roomBRes = await fetch(`${baseUrl}/api/v1/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerB.token}` },
      body: JSON.stringify({
        roomName: 'Phase 6B Isolated Room B',
        displayName: 'P6B_OtherRoom_CSK',
        visibility: RoomVisibility.PRIVATE,
        franchiseCode: 'CSK'
      })
    });
    assert.equal(roomBRes.status, 201);
    const roomB: any = (await roomBRes.json()).data;
    createdRoomIds.push(roomB.id);

    // Populate MI squad with 13 real IPL players
    const targetNames = [
      'Rohit Sharma',
      'Virat Kohli',
      'MS Dhoni',
      'Suryakumar Yadav',
      'Hardik Pandya',
      'Ravindra Jadeja',
      'Jasprit Bumrah',
      'Mohammed Siraj',
      'Yuzvendra Chahal',
      'Jos Buttler',
      'Andre Russell',
      'Sunil Narine',
      'Rashid Khan'
    ];
    const players = await prisma.masterPlayer.findMany({ where: { fullName: { in: targetNames } } });
    assert.ok(players.length >= 12);
    await prisma.roomRetention.createMany({
      data: players.map((p, idx) => ({
        roomId: roomA.id,
        franchiseId: miFranchise.id,
        playerId: p.id,
        retentionCostLakhs: 500,
        slotNumber: idx + 1
      }))
    });

    // ---------------------------------------------------------------
    // SCENARIO 1: Public visitor (unauthenticated)
    // ---------------------------------------------------------------
    const catRes = await fetch(`${baseUrl}/api/v1/players/catalog?limit=5`);
    assert.equal(catRes.status, 200);
    const profRes = await fetch(`${baseUrl}/api/v1/players/${vk.id}/profile`);
    assert.equal(profRes.status, 200);

    // Removed internal routes blocked unauthenticated (401) and non-existent even when authenticated (404)
    assert.equal((await fetch(`${baseUrl}/api/v1/intelligence/models/health`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/v1/intelligence/models/MATCH_PRED/evaluation`)).status, 401);
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/intelligence/models/health`, { headers: { Authorization: `Bearer ${ownerMiA.token}` } })).status,
      404
    );
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/intelligence/models/MATCH_PRED/evaluation`, { headers: { Authorization: `Bearer ${ownerMiA.token}` } })).status,
      404
    );

    // Unauthenticated callers rejected with 401 across all intelligence endpoints
    assert.equal((await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/access`)).status, 401);
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/players/${vk.id}/analytics`)).status,
      401
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/players/${vk.id}/rating`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'CAREER' })
        })
      ).status,
      401
    );
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/ratings/leaderboard`)).status,
      401
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/franchises/${miFranchise.id}/team-strength`
        )
      ).status,
      401
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/franchises/${miFranchise.id}/playing-xi`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        )
      ).status,
      401
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/match-predictor/predict`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ home_franchise_code: 'CSK', away_franchise_code: 'MI', venue: 'Wankhede Stadium' })
        })
      ).status,
      401
    );
    console.log('✅ Test 1: Public visitors allowed catalog/profile (200) and blocked from all intelligence (401/404)');

    // ---------------------------------------------------------------
    // SCENARIO 2: Spectator in Room A (blocked with 403 OWNER_ONLY)
    // ---------------------------------------------------------------
    const specHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${specA.token}` };
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/access`, { headers: specHeaders })).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/players/${vk.id}/analytics`, {
          headers: specHeaders
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/players/${vk.id}/rating`, {
          method: 'POST',
          headers: specHeaders,
          body: JSON.stringify({ scope: 'CAREER' })
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/ratings/leaderboard`, {
          headers: specHeaders
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/franchises/${miFranchise.id}/team-strength`,
          { headers: specHeaders }
        )
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/franchises/${miFranchise.id}/playing-xi`,
          { method: 'POST', headers: specHeaders, body: '{}' }
        )
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/match-predictor/predict`, {
          method: 'POST',
          headers: specHeaders,
          body: JSON.stringify({ home_franchise_code: 'CSK', away_franchise_code: 'MI', venue: 'Wankhede Stadium' })
        })
      ).status,
      403
    );
    console.log('✅ Test 2: Spectator rejected (403) on all private intelligence endpoints');

    // ---------------------------------------------------------------
    // SCENARIO 3: Authorized MI Owner in Room A + Response Scrubbing
    // ---------------------------------------------------------------
    const miHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerMiA.token}` };

    const accessRes = await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/access`, {
      headers: miHeaders
    });
    assert.equal(accessRes.status, 200);
    const accessBody: any = await accessRes.json();
    assert.equal(accessBody.data.authorized, true);
    assert.equal(accessBody.data.franchiseCode, 'MI');

    const advRes = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/players/${vk.id}/analytics?scope=CAREER`,
      { headers: miHeaders }
    );
    assert.equal(advRes.status, 200);
    const advBody: any = await advRes.json();
    assert.equal(advBody.data.allow_bidding_advice, false);
    assert.ok(advBody.data.stats.runs > 7000);
    assertNoSensitiveKeys(advBody, 'playerAnalytics');

    const ratRes = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/players/${vk.id}/rating`,
      { method: 'POST', headers: miHeaders, body: JSON.stringify({ scope: 'CAREER' }) }
    );
    assert.equal(ratRes.status, 200);
    const ratBody: any = await ratRes.json();
    assert.ok(ratBody.data.batting_rating > 65);
    assertNoSensitiveKeys(ratBody, 'playerRating');

    const lbRes = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/ratings/leaderboard?sort_by=overall_rating&limit=10`,
      { headers: miHeaders }
    );
    assert.equal(lbRes.status, 200);
    assert.equal(((await lbRes.json()) as any).data.players.length, 10);

    const tsRes = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/franchises/${miFranchise.id}/team-strength`,
      { headers: miHeaders }
    );
    assert.equal(tsRes.status, 200);
    const tsBody: any = await tsRes.json();
    assert.equal(tsBody.data.allow_bidding_advice, false);
    assert.equal(tsBody.data.squad_size, players.length);
    assertNoSensitiveKeys(tsBody, 'teamStrength');

    const xiRes = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/franchises/${miFranchise.id}/playing-xi`,
      { method: 'POST', headers: miHeaders, body: JSON.stringify({ pitch_type: 'BALANCED' }) }
    );
    assert.equal(xiRes.status, 200);
    const xiBody: any = await xiRes.json();
    assert.equal(xiBody.data.is_prediction, true);
    assert.equal(xiBody.data.playing_xi.length, 11);
    assert.ok(xiBody.data.overseas_count_in_xi <= 4);
    assert.ok(xiBody.data.impact_player);
    assertNoSensitiveKeys(xiBody, 'playingXI');

    const metaRes = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/match-predictor/metadata`,
      { headers: miHeaders }
    );
    assert.equal(metaRes.status, 200);
    const metaBody: any = await metaRes.json();
    assertNoSensitiveKeys(metaBody, 'matchMetadata');

    const predRes = await fetch(
      `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/match-predictor/predict`,
      {
        method: 'POST',
        headers: miHeaders,
        body: JSON.stringify({ home_franchise_code: 'CSK', away_franchise_code: 'MI', venue: 'Wankhede Stadium' })
      }
    );
    assert.equal(predRes.status, 200);
    const predBody: any = await predRes.json();
    assert.equal(predBody.data.allow_bidding_advice, false);
    assert.ok(Math.abs(predBody.data.home_win_probability + predBody.data.away_win_probability - 1.0) < 0.01);
    assertNoSensitiveKeys(predBody, 'matchPrediction');
    console.log('✅ Test 3: Active MI owner received full authorized intelligence with sensitive internals scrubbed');

    // ---------------------------------------------------------------
    // SCENARIO 4: Cross-franchise isolation within same Room A (CSK Host spying on MI -> 403)
    // ---------------------------------------------------------------
    const cskHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${hostA.token}` };
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/franchises/${cskFranchise.id}/team-strength`,
          { headers: cskHeaders }
        )
      ).status,
      200
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/franchises/${miFranchise.id}/team-strength`,
          { headers: cskHeaders }
        )
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/franchises/MI/playing-xi`,
          { method: 'POST', headers: cskHeaders, body: '{}' }
        )
      ).status,
      403
    );
    console.log('✅ Test 4: Cross-franchise Team Strength & Playing XI spying rejected with 403');

    // ---------------------------------------------------------------
    // SCENARIO 5: Cross-room isolation (Room B Owner accessing Room A or passing foreign franchise ID)
    // ---------------------------------------------------------------
    const roomBHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerB.token}` };
    assert.equal(
      (await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/access`, { headers: roomBHeaders })).status,
      403
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/players/${vk.id}/analytics`, {
          headers: roomBHeaders
        })
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomA.code}/franchises/${miFranchise.id}/team-strength`,
          { headers: roomBHeaders }
        )
      ).status,
      403
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}/api/v1/intelligence/rooms/${roomB.code}/franchises/${miFranchise.id}/team-strength`,
          { headers: roomBHeaders }
        )
      ).status,
      404
    );
    console.log('✅ Test 5: Cross-room access and foreign franchise probing strictly rejected (403/404)');

    // ---------------------------------------------------------------
    // SCENARIO 6: Direct ML internal auth & fail-closed checks
    // ---------------------------------------------------------------
    const mlHealthRes = await fetch(`http://127.0.0.1:${ML_PORT}/health`);
    assert.equal(mlHealthRes.status, 200);
    const mlHealthBody: any = await mlHealthRes.json();
    assert.deepEqual(mlHealthBody, {
      status: 'healthy',
      service: 'auctioncraze-ml',
      allow_bidding_advice: false
    });

    assert.equal((await fetch(`http://127.0.0.1:${ML_PORT}/v1/ratings/leaderboard`)).status, 401);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${ML_PORT}/v1/ratings/leaderboard`, {
          headers: { 'X-Internal-Service-Key': 'wrong-secret' }
        })
      ).status,
      401
    );

    const failClosedProc = spawn(
      'python',
      ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(ML_FAILCLOSED_PORT)],
      {
        cwd: mlDir,
        env: { ...process.env, INTERNAL_ML_SERVICE_KEY: '' },
        stdio: 'pipe'
      }
    );
    try {
      await waitForMlHealth(`http://127.0.0.1:${ML_FAILCLOSED_PORT}`);
      const failRes = await fetch(`http://127.0.0.1:${ML_FAILCLOSED_PORT}/v1/ratings/leaderboard`, {
        headers: { 'X-Internal-Service-Key': 'any-attempt' }
      });
      assert.equal(failRes.status, 503);
    } finally {
      failClosedProc.kill();
    }
    console.log('✅ Test 6: Direct ML endpoint rejected (401), /health scrubbed, and unset secret failed closed (503)');

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

runPhase6bApiTests().catch((err) => {
  console.error('❌ Phase 6B RBAC & Security test failed:', err);
  process.exit(1);
});
