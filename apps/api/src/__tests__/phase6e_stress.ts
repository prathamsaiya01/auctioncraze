import assert from 'node:assert/strict';
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import dotenv from 'dotenv';
import { io as ioClient, Socket } from 'socket.io-client';
import { prisma } from '@auctioncraze/database';
import {
  AuctionMode,
  RoomRole,
  RoomVisibility,
  SOCKET_EVENTS
} from '@auctioncraze/shared';
import { createApp } from '../app';
import { connectRedis, disconnectRedis, redis } from '../lib/redis';
import { closeSocketServer, setupSocketServer } from '../sockets/socketServer';
import { AuctionTimerManager } from '../modules/auction/timerManager';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

const PRESET_CODES = ['CSK', 'MI', 'RCB', 'KKR', 'SRH', 'DC', 'RR', 'PBKS', 'GT', 'LSG'] as const;

interface GuestClient {
  token: string;
  sessionId: string;
  displayName: string;
}

interface JoinedClient extends GuestClient {
  role: RoomRole;
  franchiseCode?: string;
  socket: Socket;
  ackMs: number;
  bidEvents: Array<{ bidId: string; bidAmountLakhs: number; franchiseId: string; lotId: string }>;
}

interface TierMetrics {
  label: string;
  owners: number;
  spectators: number;
  totalClients: number;
  connectSuccessPct: number;
  socketAckAvgMs: number;
  socketAckP95Ms: number;
  socketAckMaxMs: number;
  bidHttpAvgMs: number;
  bidHttpP95Ms: number;
  bidHttpMaxMs: number;
  broadcastDeliveryAvgMs: number;
  broadcastDeliveryMaxMs: number;
  acceptedBids: number;
  rejectedBidsExpected: number;
  serverErrors5xx: number;
  droppedBroadcasts: number;
  duplicateBidEvents: number;
  heapUsedMb: number;
  rssMb: number;
}

function stats(arr: number[]): { avg: number; p95: number; max: number } {
  if (!arr.length) return { avg: 0, p95: 0, max: 0 };
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return {
    avg: Number((sum / sorted.length).toFixed(2)),
    p95: Number(sorted[p95Idx].toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2))
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function reqJson(
  baseUrl: string,
  method: string,
  route: string,
  token?: string,
  body?: unknown,
  artificialDelayMs = 0
): Promise<{ status: number; json: any; ms: number }> {
  if (artificialDelayMs > 0) {
    await sleep(artificialDelayMs);
  }
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

async function createGuest(baseUrl: string, displayName: string, tracker: string[]): Promise<GuestClient> {
  const res = await reqJson(baseUrl, 'POST', '/sessions/guest', undefined, { displayName });
  assert.equal(res.status, 201, `Guest create failed (${res.status}): ${JSON.stringify(res.json)}`);
  const sessionId = res.json.data.session?.id ?? res.json.data.id;
  tracker.push(sessionId);
  return {
    token: res.json.data.session?.token ?? res.json.data.token,
    sessionId,
    displayName
  };
}

async function connectSocketAndJoin(
  baseUrl: string,
  token: string,
  roomCode: string,
  reconnection = false
): Promise<{ socket: Socket; ackMs: number; ack: any }> {
  const t0 = performance.now();
  const socket = ioClient(baseUrl, {
    auth: { token },
    transports: ['websocket'],
    reconnection
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connect timeout')), 8000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  const ack = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ROOM_JOIN ack timeout')), 8000);
    socket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode }, (resp: any) => {
      clearTimeout(timer);
      resolve(resp);
    });
  });
  const ackMs = performance.now() - t0;
  return { socket, ackMs, ack };
}

async function waitForHealth(baseUrl: string, timeoutMs = 15000): Promise<number> {
  const t0 = performance.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.status === 200) {
        return performance.now() - t0;
      }
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health`);
}

function spawnProductionApi(port: number): { child: ChildProcess; logs: string[] } {
  const apiDir = path.resolve(__dirname, '../..');
  const distEntry = path.resolve(apiDir, 'dist/server.js');
  const child = spawn(process.execPath, [distEntry], {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs: string[] = [];
  child.stdout?.on('data', (d) => logs.push(String(d).trim()));
  child.stderr?.on('data', (d) => logs.push(String(d).trim()));
  return { child, logs };
}

function killProcessTree(child: ChildProcess | null): void {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // already dead
  }
}

async function runPhase6eStressSuite() {
  await connectRedis();
  const createdRoomCodes: string[] = [];
  const createdSessionIds: string[] = [];
  const masterPlayers = await prisma.masterPlayer.findMany({
    take: 10,
    orderBy: { fullName: 'asc' }
  });
  assert.ok(masterPlayers.length >= 8, 'Need at least 8 seeded master players');

  const app = createApp();
  const httpServer = http.createServer(app);
  await setupSocketServer(httpServer);
  AuctionTimerManager.start(150);

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as any;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const tierResults: TierMetrics[] = [];
  const socketPool: Socket[] = [];
  let inProcessStopped = false;
  let childApi: ChildProcess | null = null;

  try {
    console.log('\n=== PRIORITY 1 & 4: MULTIPLAYER LOAD & BID CONCURRENCY MATRIX ===');

    const loadTiers: Array<{ label: string; owners: number; spectators: number; testTradesAndIsolation?: boolean }> = [
      { label: 'Tier 1 (2 owners + 2 spectators)', owners: 2, spectators: 2 },
      { label: 'Tier 2 (5 owners + 5 spectators)', owners: 5, spectators: 5 },
      { label: 'Tier 3 (10 owners + 10 spectators)', owners: 10, spectators: 10 },
      { label: 'Tier 4 (10 owners + 40 spectators)', owners: 10, spectators: 40, testTradesAndIsolation: true }
    ];

    for (const tier of loadTiers) {
      const tierSockets: Socket[] = [];
      const ackLatencies: number[] = [];
      const bidLatencies: number[] = [];
      const broadcastDeliveryMs: number[] = [];
      const clients: JoinedClient[] = [];
      let serverErrors5xx = 0;
      let rejectedBidsExpected = 0;
      let acceptedBids = 0;

      const host = await createGuest(baseUrl, `P6E_${tier.owners}O_Host`, createdSessionIds);
      const createRes = await reqJson(baseUrl, 'POST', '/rooms', host.token, {
        roomName: `P6E Stress ${tier.owners}O+${tier.spectators}S`,
        franchiseCode: PRESET_CODES[0],
        visibility: RoomVisibility.PUBLIC,
        auctionMode: AuctionMode.MOCK,
        settings: {
          initialPurseLakhs: 10000,
          minSquadSize: 1,
          maxSquadSize: 20,
          maxOverseas: 8,
          maxSpectators: Math.max(20, tier.spectators + 5),
          countdownSeconds: 12,
          bidExtensionSeconds: 4,
          extensionThresholdSeconds: 4,
          allowHostSkip: true
        }
      });
      assert.equal(createRes.status, 201);
      const roomCode: string = createRes.json.data.code;
      createdRoomCodes.push(roomCode);

      const otherGuests: Array<{ guest: GuestClient; role: RoomRole; franchiseCode?: string }> = [];
      for (let i = 1; i < tier.owners; i++) {
        otherGuests.push({
          guest: await createGuest(baseUrl, `P6E_O${i}`, createdSessionIds),
          role: RoomRole.OWNER,
          franchiseCode: PRESET_CODES[i]
        });
      }
      for (let s = 0; s < tier.spectators; s++) {
        otherGuests.push({
          guest: await createGuest(baseUrl, `P6E_S${s}`, createdSessionIds),
          role: RoomRole.SPECTATOR
        });
      }

      await Promise.all(
        otherGuests.map(async (item) => {
          const jRes = await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/join`, item.guest.token, {
            joinAs: item.role,
            ...(item.franchiseCode ? { franchiseCode: item.franchiseCode } : {})
          });
          assert.equal(jRes.status, 200, `Join failed for ${item.guest.displayName}: ${JSON.stringify(jRes.json)}`);
          if (item.role === RoomRole.OWNER) {
            await reqJson(baseUrl, 'PATCH', `/rooms/${roomCode}/ready`, item.guest.token, { isReady: true });
          }
        })
      );

      const poolLots = masterPlayers.slice(0, 6).map((p, idx) => ({
        playerId: p.id,
        sequenceOrder: idx + 1,
        setCategory: 'Marquee',
        basePriceLakhs: 200
      }));
      assert.equal((await reqJson(baseUrl, 'PUT', `/rooms/${roomCode}/pool`, host.token, { lots: poolLots })).status, 200);
      assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/config/finalize`, host.token, {})).status, 200);
      const startRes = await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/start`, host.token, {});
      assert.equal(startRes.status, 200);

      if (tier.testTradesAndIsolation) {
        await reqJson(baseUrl, 'PATCH', `/rooms/${roomCode}/live-settings`, host.token, {
          allowPlayerTrades: true,
          allowCustomTeamName: true
        });
      }

      const allJoinConfigs = [
        { guest: host, role: RoomRole.OWNER, franchiseCode: PRESET_CODES[0] },
        ...otherGuests
      ];

      let connectSuccessCount = 0;
      const connectedClients = await Promise.all(
        allJoinConfigs.map(async (item) => {
          const { socket, ackMs, ack } = await connectSocketAndJoin(baseUrl, item.guest.token, roomCode);
          assert.equal(ack.ok, true, `Socket ROOM_JOIN failed: ${JSON.stringify(ack)}`);
          connectSuccessCount++;
          ackLatencies.push(ackMs);
          tierSockets.push(socket);
          socketPool.push(socket);

          const bidEvents: JoinedClient['bidEvents'] = [];
          socket.on(SOCKET_EVENTS.BID_PLACED, (evt: any) => {
            if (evt?.bid) {
              bidEvents.push({
                bidId: evt.bid.id,
                bidAmountLakhs: evt.bid.bidAmountLakhs,
                franchiseId: evt.bid.franchiseId,
                lotId: evt.lotId
              });
            }
          });
          return {
            ...item.guest,
            role: item.role,
            franchiseCode: item.franchiseCode,
            socket,
            ackMs,
            bidEvents
          } satisfies JoinedClient;
        })
      );
      clients.push(...connectedClients);

      const owners = clients.filter((c) => c.role === RoomRole.OWNER);

      // Simultaneous bid burst on Lot #1 (All N owners bid simultaneously at base/next price!)
      const snap0 = (await reqJson(baseUrl, 'GET', `/rooms/${roomCode}/auction`, host.token)).json.data;
      const lot1Id = snap0.currentLot.id;
      const openingBidAmount = snap0.currentLot.nextBidLakhs;
      const burstResults = await Promise.all(
        owners.map((o, idx) =>
          reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/bids`, o.token, {
            lotId: lot1Id,
            bidAmountLakhs: openingBidAmount,
            idempotencyKey: `burst-${roomCode}-${idx}-${Date.now()}`
          })
        )
      );
      for (const br of burstResults) {
        bidLatencies.push(br.ms);
        if (br.status >= 500) serverErrors5xx++;
        else if (br.status === 201) acceptedBids++;
        else rejectedBidsExpected++;
      }
      assert.equal(
        burstResults.filter((r) => r.status === 201).length,
        1,
        `Simultaneous equal-price burst must produce EXACTLY 1 winner (got statuses: ${burstResults.map((b) => b.status).join(',')})`
      );

      // Sequential escalation bids verifying convergence across ALL connected owners + spectators
      await sleep(100);
      for (let round = 0; round < Math.min(8, owners.length * 2); round++) {
        const cur = (await reqJson(baseUrl, 'GET', `/rooms/${roomCode}/auction`, host.token)).json.data;
        const bidder = owners[round % owners.length];
        const bidderFran = cur.franchises.find((f: any) => f.presetCode === bidder.franchiseCode);
        if (cur.currentLot.winningFranchiseId && cur.currentLot.winningFranchiseId === bidderFran?.id) {
          continue;
        }
        const tBid0 = performance.now();
        const bidRes = await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/bids`, bidder.token, {
          lotId: lot1Id,
          bidAmountLakhs: cur.currentLot.nextBidLakhs,
          idempotencyKey: `seq-${roomCode}-${round}-${Date.now()}`
        });
        bidLatencies.push(bidRes.ms);
        if (bidRes.status >= 500) serverErrors5xx++;
        if (bidRes.status === 201) {
          acceptedBids++;
          const targetBidId = bidRes.json.data.bid.id;
          const convergeDeadline = Date.now() + 2500;
          while (Date.now() < convergeDeadline) {
            if (clients.every((c) => c.bidEvents.some((b) => b.bidId === targetBidId))) {
              break;
            }
            await sleep(5);
          }
          broadcastDeliveryMs.push(performance.now() - tBid0);
        }
      }

      // Verify pause + reject + resume + manual SOLD
      assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/pause`, host.token, {})).status, 200);
      const pausedBid = await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/bids`, owners[1].token, {
        lotId: lot1Id,
        bidAmountLakhs: 9999,
        idempotencyKey: `paused-${roomCode}-${Date.now()}`
      });
      assert.equal(pausedBid.status, 409);
      assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/resume`, host.token, {})).status, 200);

      const preSold = (await reqJson(baseUrl, 'GET', `/rooms/${roomCode}/auction`, host.token)).json.data;
      const expectedWinningId = preSold.currentLot.winningFranchiseId;
      const expectedSoldPrice = preSold.currentLot.currentBidLakhs;
      const expectedBeforePurse = preSold.franchises.find((f: any) => f.id === expectedWinningId).remainingPurseLakhs;

      const soldRes = await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/sold`, host.token, {
        lotId: lot1Id
      });
      assert.equal(soldRes.status, 200);
      const postSold = soldRes.json.data;
      const winnerAfter = postSold.franchises.find((f: any) => f.id === expectedWinningId);
      assert.equal(winnerAfter.remainingPurseLakhs, expectedBeforePurse - expectedSoldPrice);
      assert.ok(winnerAfter.remainingPurseLakhs >= 0);

      const expectedBidIdCount = acceptedBids;
      let droppedBroadcasts = 0;
      let duplicateBidEvents = 0;
      for (const c of clients) {
        const uniqueIds = new Set(c.bidEvents.map((b) => b.bidId));
        if (c.bidEvents.length > uniqueIds.size) {
          duplicateBidEvents += c.bidEvents.length - uniqueIds.size;
        }
        if (uniqueIds.size < expectedBidIdCount) {
          droppedBroadcasts += expectedBidIdCount - uniqueIds.size;
        }
      }
      assert.equal(duplicateBidEvents, 0, `${tier.label}: duplicate bid events detected`);
      assert.equal(droppedBroadcasts, 0, `${tier.label}: dropped bid broadcasts detected`);

      if (tier.testTradesAndIsolation) {
        assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/next`, host.token, {})).status, 200);
        const lot2State = (await reqJson(baseUrl, 'GET', `/rooms/${roomCode}/auction`, host.token)).json.data;
        const bid2Res = await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/bids`, owners[1].token, {
          lotId: lot2State.currentLot.id,
          bidAmountLakhs: lot2State.currentLot.nextBidLakhs,
          idempotencyKey: `lot2-bid-${roomCode}`
        });
        assert.equal(bid2Res.status, 201);
        assert.equal(
          (await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/sold`, host.token, { lotId: lot2State.currentLot.id })).status,
          200
        );

        const afterLot2 = (await reqJson(baseUrl, 'GET', `/rooms/${roomCode}/auction`, host.token)).json.data;
        const fran0 = afterLot2.franchises.find((f: any) => f.squadCount > 0);
        let fran1 = afterLot2.franchises.find((f: any) => f.squadCount > 0 && f.id !== fran0.id);
        if (!fran1) {
          assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/next`, host.token, {})).status, 200);
          const l3 = (await reqJson(baseUrl, 'GET', `/rooms/${roomCode}/auction`, host.token)).json.data;
          const altOwner = owners.find((o) => {
            const f = l3.franchises.find((fr: any) => fr.presetCode === o.franchiseCode);
            return f.id !== fran0.id;
          })!;
          assert.equal(
            (
              await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/bids`, altOwner.token, {
                lotId: l3.currentLot.id,
                bidAmountLakhs: l3.currentLot.nextBidLakhs,
                idempotencyKey: `lot3-bid-${roomCode}`
              })
            ).status,
            201
          );
          assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/sold`, host.token, { lotId: l3.currentLot.id })).status, 200);
          const afterL3 = (await reqJson(baseUrl, 'GET', `/rooms/${roomCode}/auction`, host.token)).json.data;
          fran1 = afterL3.franchises.find((f: any) => f.squadCount > 0 && f.id !== fran0.id);
        }
        const finalSnap = (await reqJson(baseUrl, 'GET', `/rooms/${roomCode}/auction`, host.token)).json.data;
        const thirdFran = finalSnap.franchises.find((f: any) => f.id !== fran0.id && f.id !== fran1.id)!;
        assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/next`, host.token, {})).status, 200);
        const l4 = (await reqJson(baseUrl, 'GET', `/rooms/${roomCode}/auction`, host.token)).json.data;
        const thirdOwner = owners.find((o) => {
          const f = l4.franchises.find((fr: any) => fr.presetCode === o.franchiseCode);
          return f.id === thirdFran.id;
        })!;
        assert.equal(
          (
            await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/bids`, thirdOwner.token, {
              lotId: l4.currentLot.id,
              bidAmountLakhs: l4.currentLot.nextBidLakhs,
              idempotencyKey: `lot4-bid-${roomCode}`
            })
          ).status,
          201
        );
        assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/sold`, host.token, { lotId: l4.currentLot.id })).status, 200);

        const stateForTrade = (await reqJson(baseUrl, 'GET', `/rooms/${roomCode}/auction`, host.token)).json.data;
        const fA = stateForTrade.franchises.find((f: any) => f.id === fran0.id)!;
        const fB = stateForTrade.franchises.find((f: any) => f.id === fran1.id)!;
        const fC = stateForTrade.franchises.find((f: any) => f.id === thirdFran.id)!;
        const ownerA = owners.find((o) => o.franchiseCode === fA.presetCode)!;
        const ownerB = owners.find((o) => o.franchiseCode === fB.presetCode)!;
        const ownerC = owners.find((o) => o.franchiseCode === fC.presetCode)!;

        // Trade Race 1: Simultaneous conflicting proposals for the SAME fB player -> strictly 1 succeeds, 1 rejected 409
        const [prop1, prop2] = await Promise.all([
          reqJson(baseUrl, 'POST', `/rooms/${roomCode}/trades`, ownerA.token, {
            receiverFranchiseId: fB.id,
            outgoingPlayerIds: [fA.squad[0].playerId],
            incomingPlayerIds: [fB.squad[0].playerId],
            idempotencyKey: `race-p1-${roomCode}`
          }),
          reqJson(baseUrl, 'POST', `/rooms/${roomCode}/trades`, ownerC.token, {
            receiverFranchiseId: fB.id,
            outgoingPlayerIds: [fC.squad[0].playerId],
            incomingPlayerIds: [fB.squad[0].playerId],
            idempotencyKey: `race-p2-${roomCode}`
          })
        ]);
        const winningProp = [prop1, prop2].find((p) => p.status === 201);
        const rejectedProp = [prop1, prop2].find((p) => p.status === 409);
        assert.ok(winningProp && rejectedProp, `Simultaneous conflicting proposals must yield 201+409 (got ${prop1.status}, ${prop2.status})`);

        // Duplicate concurrent accept race (different idempotency keys on winningProp) -> strictly ONE 200, ONE 409!
        const [acc1, acc2] = await Promise.all([
          reqJson(baseUrl, 'POST', `/rooms/${roomCode}/trades/${winningProp.json.data.id}/accept`, ownerB.token, {
            idempotencyKey: `race-a1-${roomCode}`
          }),
          reqJson(baseUrl, 'POST', `/rooms/${roomCode}/trades/${winningProp.json.data.id}/accept`, ownerB.token, {
            idempotencyKey: `race-a2-${roomCode}`
          })
        ]);
        const acceptedCount = [acc1, acc2].filter((r) => r.status === 200).length;
        const conflictCount = [acc1, acc2].filter((r) => r.status === 409).length;
        assert.equal(acceptedCount, 1, 'Concurrent duplicate accepts must execute exactly ONE swap');
        assert.equal(conflictCount, 1, 'Second concurrent accept must return 409 cleanly');

        // Trade Race 2: Simultaneous accept vs cancel on a fresh pending trade
        const stateAfterSwap1 = (await reqJson(baseUrl, 'GET', `/rooms/${roomCode}/auction`, host.token)).json.data;
        const freshWinnerA = stateAfterSwap1.franchises.find((f: any) => f.id === fA.id)!;
        const freshWinnerC = stateAfterSwap1.franchises.find((f: any) => f.id === fC.id)!;
        const prop3 = await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/trades`, ownerA.token, {
          receiverFranchiseId: freshWinnerC.id,
          outgoingPlayerIds: [freshWinnerA.squad[0].playerId],
          incomingPlayerIds: [freshWinnerC.squad[0].playerId],
          idempotencyKey: `race-ac-${roomCode}`
        });
        assert.equal(prop3.status, 201);
        const [raceAcc, raceCan] = await Promise.all([
          reqJson(baseUrl, 'POST', `/rooms/${roomCode}/trades/${prop3.json.data.id}/accept`, ownerC.token, {
            idempotencyKey: `race-ac-acc-${roomCode}`
          }),
          reqJson(baseUrl, 'POST', `/rooms/${roomCode}/trades/${prop3.json.data.id}/cancel`, ownerA.token, {})
        ]);
        const win200 = [raceAcc, raceCan].filter((r) => r.status === 200).length;
        assert.equal(win200, 1, 'Accept vs Cancel race must yield strictly ONE 200 winner');

        // Cross-Room Isolation & Security Checks under 50-client load!
        const outsiderHost = await createGuest(baseUrl, 'P6E_RoomB_Host', createdSessionIds);
        const roomBRes = await reqJson(baseUrl, 'POST', '/rooms', outsiderHost.token, {
          roomName: 'P6E Isolated Room B',
          franchiseCode: 'CSK',
          visibility: RoomVisibility.PRIVATE,
          auctionMode: AuctionMode.MOCK,
          settings: {
            initialPurseLakhs: 10000,
            minSquadSize: 1,
            maxSquadSize: 20,
            maxOverseas: 8,
            maxSpectators: 10,
            countdownSeconds: 15,
            bidExtensionSeconds: 5,
            extensionThresholdSeconds: 5,
            allowHostSkip: true
          }
        });
        assert.equal(roomBRes.status, 201);
        const roomBCode = roomBRes.json.data.code;
        createdRoomCodes.push(roomBCode);

        const specClient = clients.find((c) => c.role === RoomRole.SPECTATOR)!;
        assert.equal((await reqJson(baseUrl, 'GET', `/rooms/${roomBCode}/auction`, host.token)).status, 403);
        assert.equal((await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/pause`, owners[1].token, {})).status, 403);
        assert.equal(
          (
            await reqJson(baseUrl, 'POST', `/rooms/${roomCode}/auction/bids`, specClient.token, {
              lotId: l4.currentLot.id,
              bidAmountLakhs: 500,
              idempotencyKey: `spec-forbid-${roomCode}`
            })
          ).status,
          403
        );
        const isoJoin = await connectSocketAndJoin(baseUrl, host.token, roomBCode);
        socketPool.push(isoJoin.socket);
        assert.equal(isoJoin.ack.ok, false, 'Cross-room socket subscription must fail');
        console.log('  ✅ 50-client Trade Concurrency (double-accept race + accept-vs-cancel race) & Security Isolation passed!');
      }

      for (const s of tierSockets) s.disconnect();

      const ackS = stats(ackLatencies);
      const bidS = stats(bidLatencies);
      const bcS = stats(broadcastDeliveryMs);
      const mem = process.memoryUsage();
      const metrics: TierMetrics = {
        label: tier.label,
        owners: tier.owners,
        spectators: tier.spectators,
        totalClients: tier.owners + tier.spectators,
        connectSuccessPct: Number(((connectSuccessCount / allJoinConfigs.length) * 100).toFixed(2)),
        socketAckAvgMs: ackS.avg,
        socketAckP95Ms: ackS.p95,
        socketAckMaxMs: ackS.max,
        bidHttpAvgMs: bidS.avg,
        bidHttpP95Ms: bidS.p95,
        bidHttpMaxMs: bidS.max,
        broadcastDeliveryAvgMs: bcS.avg,
        broadcastDeliveryMaxMs: bcS.max,
        acceptedBids,
        rejectedBidsExpected,
        serverErrors5xx,
        droppedBroadcasts,
        duplicateBidEvents,
        heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(2)),
        rssMb: Number((mem.rss / 1024 / 1024).toFixed(2))
      };
      tierResults.push(metrics);
      assert.equal(serverErrors5xx, 0);
      console.log(`  ✅ ${tier.label}: ${JSON.stringify(metrics)}`);
    }

    // Wait briefly for in-process disconnect handlers to finish cleanly before shutting down sockets/redis
    await sleep(200);
    AuctionTimerManager.stop();
    await closeSocketServer();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    inProcessStopped = true;

    // =========================================================================
    // PRIORITY 3: REAL SERVER PROCESS CRASH, TIMER RECOVERY & REDIS FAILURE
    // =========================================================================
    console.log('\n=== PRIORITY 3: SERVER CRASH, TIMER RECOVERY & REDIS RESILIENCE ===');
    const CRASH_PORT = 4099;
    const crashUrl = `http://127.0.0.1:${CRASH_PORT}`;
    let spawned = spawnProductionApi(CRASH_PORT);
    childApi = spawned.child;
    const bootMs = await waitForHealth(crashUrl);
    console.log(`  Child production server booted on :${CRASH_PORT} in ${bootMs.toFixed(1)} ms`);

    const cHost = await createGuest(crashUrl, 'Crash_Host', createdSessionIds);
    const cMi = await createGuest(crashUrl, 'Crash_MI', createdSessionIds);
    const cSpec = await createGuest(crashUrl, 'Crash_Spec', createdSessionIds);

    const crashRoomRes = await reqJson(crashUrl, 'POST', '/rooms', cHost.token, {
      roomName: 'P6E Crash Recovery Room',
      franchiseCode: 'CSK',
      visibility: RoomVisibility.PUBLIC,
      auctionMode: AuctionMode.MOCK,
      settings: {
        initialPurseLakhs: 10000,
        minSquadSize: 1,
        maxSquadSize: 20,
        maxOverseas: 8,
        maxSpectators: 10,
        countdownSeconds: 8,
        bidExtensionSeconds: 3,
        extensionThresholdSeconds: 3,
        allowHostSkip: true
      }
    });
    assert.equal(crashRoomRes.status, 201);
    const crashCode = crashRoomRes.json.data.code;
    createdRoomCodes.push(crashCode);

    await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/join`, cMi.token, { joinAs: RoomRole.OWNER, franchiseCode: 'MI' });
    await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/join`, cSpec.token, { joinAs: RoomRole.SPECTATOR });
    await reqJson(crashUrl, 'PATCH', `/rooms/${crashCode}/ready`, cMi.token, { isReady: true });

    const crashLots = masterPlayers.slice(0, 4).map((p, idx) => ({
      playerId: p.id,
      sequenceOrder: idx + 1,
      setCategory: 'Marquee',
      basePriceLakhs: 200
    }));
    await reqJson(crashUrl, 'PUT', `/rooms/${crashCode}/pool`, cHost.token, { lots: crashLots });
    await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/config/finalize`, cHost.token, {});
    await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/start`, cHost.token, {});

    const snapBeforeCrash = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;
    const cBid = await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/bids`, cMi.token, {
      lotId: snapBeforeCrash.currentLot.id,
      bidAmountLakhs: snapBeforeCrash.currentLot.nextBidLakhs,
      idempotencyKey: `crash-bid-1-${Date.now()}`
    });
    assert.equal(cBid.status, 201);
    const preCrashState = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;
    const preDeadlineMs = preCrashState.timer.deadlineMs;
    assert.ok(typeof preDeadlineMs === 'number' && preDeadlineMs > Date.now());

    // 3A: Kill child process while countdown is ACTIVE -> restart immediately!
    killProcessTree(childApi);
    childApi = null;
    await sleep(300);

    spawned = spawnProductionApi(CRASH_PORT);
    childApi = spawned.child;
    const recoverBootMs = await waitForHealth(crashUrl);
    const postCrashState = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;

    assert.equal(postCrashState.currentLot.currentBidLakhs, preCrashState.currentLot.currentBidLakhs, 'Highest bid must survive crash');
    assert.equal(postCrashState.currentLot.winningFranchiseId, preCrashState.currentLot.winningFranchiseId, 'Winning bidder must survive crash');
    assert.equal(
      postCrashState.timer.deadlineMs,
      preDeadlineMs,
      `Timer deadline must recover untouched (${postCrashState.timer.deadlineMs} vs ${preDeadlineMs}) — NOT reset!`
    );
    console.log(`  ✅ Scenario 3A: Killed ACTIVE API server & recovered exact deadlineMs in ${recoverBootMs.toFixed(1)} ms`);

    // 3B: Wait until recovered countdown expires -> must enter BIDDING_CLOSED (NO auto-SOLD!)
    const waitExpiryMs = Math.max(500, postCrashState.timer.deadlineMs - Date.now() + 900);
    await sleep(waitExpiryMs);
    const afterExpiry = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;
    assert.equal(afterExpiry.auctionStage, 'BIDDING_CLOSED', 'Expired timer must enter BIDDING_CLOSED, never auto-SOLD');
    const cSold = await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/sold`, cHost.token, {
      lotId: afterExpiry.currentLot.id
    });
    assert.equal(cSold.status, 200);
    assert.equal(cSold.json.data.auctionStage, 'PLAYER_SOLD');
    console.log('  ✅ Scenario 3B: Timer expired into BIDDING_CLOSED (zero auto-SOLD); Host settled SOLD cleanly');

    // 3C: Crash during PAUSED + repeated restart recovery
    await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/next`, cHost.token, {});
    const lot2Pre = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;
    await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/bids`, cHost.token, {
      lotId: lot2Pre.currentLot.id,
      bidAmountLakhs: lot2Pre.currentLot.nextBidLakhs,
      idempotencyKey: `crash-bid-2-${Date.now()}`
    });
    await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/pause`, cHost.token, {});
    const pausedPre = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;

    for (let restart = 1; restart <= 2; restart++) {
      killProcessTree(childApi);
      childApi = null;
      await sleep(250);
      spawned = spawnProductionApi(CRASH_PORT);
      childApi = spawned.child;
      await waitForHealth(crashUrl);
    }
    const pausedPost = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;
    assert.equal(pausedPost.auctionStage, 'PAUSED');
    assert.equal(pausedPost.timer.remainingSeconds, pausedPre.timer.remainingSeconds);

    await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/resume`, cHost.token, {});
    const resumedState = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;
    assert.equal(resumedState.auctionStage, 'LIVE');
    await sleep(Math.max(500, resumedState.timer.deadlineMs - Date.now() + 900));
    const lot2Closed = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;
    assert.equal(lot2Closed.auctionStage, 'BIDDING_CLOSED');
    await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/sold`, cHost.token, {
      lotId: lot2Closed.currentLot.id
    });
    console.log('  ✅ Scenario 3C: Repeated restart while PAUSED preserved exact remainingSeconds & resumed cleanly');

    // 3D: Redis Key Wipe Self-Healing Recovery on Lot #3
    await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/next`, cHost.token, {});
    const lot3Live = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;
    assert.equal(lot3Live.auctionStage, 'LIVE');

    await redis.zrem('auction:active_timers', crashCode);
    await redis.del(`auction:timer:${crashCode}`);
    const healWait = Math.max(1000, lot3Live.timer.deadlineMs - Date.now() + 4200);
    await sleep(healWait);
    const afterRedisWipe = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;
    assert.equal(
      afterRedisWipe.auctionStage,
      'BIDDING_CLOSED',
      `TimerManager must self-heal wiped Redis timer from Postgres (got ${afterRedisWipe.auctionStage})`
    );
    assert.equal(
      (await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/unsold`, cHost.token, { lotId: afterRedisWipe.currentLot.id })).status,
      200
    );
    console.log('  ✅ Scenario 3D: Redis timer key loss self-healed via Postgres safety sweep into BIDDING_CLOSED');

    // =========================================================================
    // PRIORITY 2: DEGRADED NETWORK LATENCY BENCHMARK (CLIENT-MEASURED DELAY)
    // =========================================================================
    console.log('\n=== PRIORITY 2: SIMULATED NETWORK DELAY BENCHMARK (150ms & 380ms RTT) ===');
    assert.equal((await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/next`, cHost.token, {})).status, 200);
    assert.equal((await reqJson(crashUrl, 'POST', `/rooms/${crashCode}/auction/extend-timer`, cHost.token, { extraSeconds: 30 })).status, 200);
    const l4Degraded = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;

    const degraded150Rtts: number[] = [];
    for (let i = 0; i < 6; i++) {
      const actor = i % 2 === 0 ? cHost : cMi;
      const cur = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;
      const jitter = 130 + ((i * 11) % 50);
      const t0 = performance.now();
      const b = await reqJson(
        crashUrl,
        'POST',
        `/rooms/${crashCode}/auction/bids`,
        actor.token,
        {
          lotId: l4Degraded.currentLot.id,
          bidAmountLakhs: cur.currentLot.nextBidLakhs,
          idempotencyKey: `net150-${i}-${Date.now()}`
        },
        jitter
      );
      assert.equal(b.status, 201);
      degraded150Rtts.push(performance.now() - t0);
    }

    const degraded380Rtts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const actor = i % 2 === 0 ? cHost : cMi;
      const cur = (await reqJson(crashUrl, 'GET', `/rooms/${crashCode}/auction`, cHost.token)).json.data;
      const jitter = 340 + ((i * 23) % 90);
      const t0 = performance.now();
      const b = await reqJson(
        crashUrl,
        'POST',
        `/rooms/${crashCode}/auction/bids`,
        actor.token,
        {
          lotId: l4Degraded.currentLot.id,
          bidAmountLakhs: cur.currentLot.nextBidLakhs,
          idempotencyKey: `net380-${i}-${Date.now()}`
        },
        jitter
      );
      assert.equal(b.status, 201);
      degraded380Rtts.push(performance.now() - t0);
    }
    console.log(
      '📊 NETWORK_DELAY_SIM_METRICS:',
      JSON.stringify({
        simulated150msStats: stats(degraded150Rtts),
        simulated380msStats: stats(degraded380Rtts)
      })
    );
    console.log('📊 LOAD_MATRIX_SUMMARY:', JSON.stringify(tierResults));
    console.log('\n🎉 All Phase 6E Load, Concurrency, Crash/Recovery & Redis Resilience checks passed!');
  } catch (err) {
    console.error('❌ Error inside runPhase6eStressSuite:', err);
    throw err;
  } finally {
    killProcessTree(childApi);
    for (const s of socketPool) {
      try {
        s.disconnect();
      } catch {}
    }
    if (!inProcessStopped) {
      await sleep(200);
      AuctionTimerManager.stop();
      await closeSocketServer();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }

    try {
      if (createdRoomCodes.length > 0) {
        await prisma.room.deleteMany({
          where: { code: { in: createdRoomCodes } }
        });
        for (const code of createdRoomCodes) {
          await redis.zrem('auction:active_timers', code);
          await redis.del(`auction:timer:${code}`);
        }
      }
      if (createdSessionIds.length > 0) {
        await prisma.guestSession.deleteMany({
          where: { id: { in: createdSessionIds } }
        });
      }
    } catch (cleanupErr) {
      console.error('Cleanup warning:', cleanupErr);
    }

    await disconnectRedis();
    await prisma.$disconnect();
  }
}

runPhase6eStressSuite().catch(async () => {
  await disconnectRedis().catch(() => {});
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
