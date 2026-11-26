import { LotStatus as DbLotStatus, RoomStatus as DbRoomStatus, prisma } from '@auctioncraze/database';
import { SOCKET_EVENTS } from '@auctioncraze/shared';
import { redis } from '../../lib/redis';
import { emitToRoom } from '../../sockets/socketServer';
import { appendRoomEvent, lockRoomByCode } from '../rooms/roomHelpers';

const ACTIVE_TIMERS_ZSET = 'auction:active_timers';

function timerKey(roomCode: string): string {
  return `auction:timer:${roomCode.toUpperCase()}`;
}

function closeLockKey(lotId: string): string {
  return `lock:timer-close:${lotId}`;
}

export class AuctionTimerManager {
  private static intervalId: NodeJS.Timeout | null = null;
  private static isTicking = false;
  private static lastSyncPulseByRoom = new Map<string, number>();

  static async setRunningTimer(roomCode: string, lotId: string, deadlineMs: number): Promise<void> {
    const code = roomCode.toUpperCase();
    await redis
      .multi()
      .set(
        timerKey(code),
        JSON.stringify({ roomCode: code, lotId, status: 'RUNNING', deadlineMs }),
        'EX',
        86400
      )
      .zadd(ACTIVE_TIMERS_ZSET, deadlineMs, code)
      .exec();
  }

  static async setPausedTimer(roomCode: string, lotId: string, remainingMs: number): Promise<void> {
    const code = roomCode.toUpperCase();
    await redis
      .multi()
      .zrem(ACTIVE_TIMERS_ZSET, code)
      .set(
        timerKey(code),
        JSON.stringify({ roomCode: code, lotId, status: 'PAUSED', remainingMs }),
        'EX',
        86400
      )
      .exec();
  }

  static async clearTimer(roomCode: string): Promise<void> {
    const code = roomCode.toUpperCase();
    await redis.multi().zrem(ACTIVE_TIMERS_ZSET, code).del(timerKey(code)).exec();
  }

  /**
   * Restores Redis timer state from PostgreSQL after an API server restart.
   */
  static async recoverActiveTimersOnBoot(): Promise<number> {
    const liveRooms = await prisma.room.findMany({
      where: {
        status: { in: [DbRoomStatus.LIVE, DbRoomStatus.PAUSED] },
        currentLotId: { not: null }
      },
      select: {
        id: true,
        code: true,
        status: true,
        isPaused: true,
        currentLotId: true,
        timerDeadlineMs: true,
        timerRemainingMs: true
      }
    });

    let recovered = 0;
    for (const room of liveRooms) {
      if (!room.currentLotId) continue;
      const lot = await prisma.roomPlayerLot.findUnique({
        where: { id: room.currentLotId },
        select: { id: true, status: true }
      });
      if (!lot || lot.status !== DbLotStatus.ACTIVE) continue;

      if (room.isPaused || room.status === DbRoomStatus.PAUSED) {
        await AuctionTimerManager.setPausedTimer(room.code, lot.id, room.timerRemainingMs ?? 0);
        recovered++;
      } else if (room.timerDeadlineMs !== null) {
        await AuctionTimerManager.setRunningTimer(room.code, lot.id, Number(room.timerDeadlineMs));
        recovered++;
      }
    }

    if (recovered > 0) {
      console.log(`⏱️  Recovered ${recovered} active auction timer(s) from PostgreSQL.`);
      await AuctionTimerManager.processExpiredTimers(Date.now());
    }
    return recovered;
  }

  /**
   * Transitions expired ACTIVE lots to BIDDING_CLOSED without auto-selling.
   * Uses a Redis SET NX lock to prevent duplicate closes across concurrent workers.
   */
  static async processExpiredTimers(nowMs = Date.now()): Promise<string[]> {
    const expiredCodes = await redis.zrangebyscore(ACTIVE_TIMERS_ZSET, '-inf', String(nowMs));
    const closedCodes: string[] = [];

    for (const roomCode of expiredCodes) {
      try {
        const rawTimer = await redis.get(timerKey(roomCode));
        const parsed = rawTimer ? JSON.parse(rawTimer) : null;
        const lotHint = parsed?.lotId || roomCode;

        // Distributed lock so multiple timer ticks/workers cannot close the same lot
        const acquired = await redis.set(closeLockKey(lotHint), '1', 'PX', 5000, 'NX');
        if (!acquired) continue;

        const outcome = await prisma.$transaction(async (tx) => {
          const { id: roomId } = await lockRoomByCode(tx, roomCode);
          const room = await tx.room.findUnique({ where: { id: roomId } });
          if (
            !room ||
            room.status !== DbRoomStatus.LIVE ||
            room.isPaused ||
            !room.currentLotId ||
            room.timerDeadlineMs === null
          ) {
            return { action: 'IGNORE' as const };
          }

          if (Number(room.timerDeadlineMs) > nowMs) {
            return {
              action: 'RESCHEDULE' as const,
              lotId: room.currentLotId,
              deadlineMs: Number(room.timerDeadlineMs)
            };
          }

          const lot = await tx.roomPlayerLot.findUnique({
            where: { id: room.currentLotId },
            include: { player: true }
          });

          if (!lot || lot.status !== DbLotStatus.ACTIVE) {
            return { action: 'CLEAR' as const };
          }

          const closedAt = new Date(nowMs);
          await tx.roomPlayerLot.update({
            where: { id: lot.id },
            data: {
              status: DbLotStatus.BIDDING_CLOSED,
              biddingClosedAt: closedAt
            }
          });

          const nextVersion = room.version + 1;
          await tx.room.update({
            where: { id: room.id },
            data: {
              timerDeadlineMs: null,
              timerRemainingMs: 0,
              version: nextVersion
            }
          });

          await appendRoomEvent(tx, room.id, nextVersion, SOCKET_EVENTS.BIDDING_CLOSED, {
            lotId: lot.id,
            playerId: lot.playerId,
            playerName: lot.player.fullName,
            currentBidLakhs: lot.currentBidLakhs,
            winningFranchiseId: lot.winningFranchiseId,
            closedAt: closedAt.toISOString()
          });

          return {
            action: 'CLOSED' as const,
            lotId: lot.id,
            currentBidLakhs: lot.currentBidLakhs,
            winningFranchiseId: lot.winningFranchiseId,
            closedAt: closedAt.toISOString()
          };
        });

        if (outcome.action === 'RESCHEDULE') {
          await AuctionTimerManager.setRunningTimer(roomCode, outcome.lotId, outcome.deadlineMs);
        } else if (outcome.action === 'IGNORE' || outcome.action === 'CLEAR') {
          await AuctionTimerManager.clearTimer(roomCode);
        } else if (outcome.action === 'CLOSED') {
          await AuctionTimerManager.clearTimer(roomCode);
          emitToRoom(roomCode, SOCKET_EVENTS.BIDDING_CLOSED, {
            roomCode,
            lotId: outcome.lotId,
            currentBidLakhs: outcome.currentBidLakhs,
            winningFranchiseId: outcome.winningFranchiseId,
            closedAt: outcome.closedAt
          });
          emitToRoom(roomCode, SOCKET_EVENTS.TIMER_UPDATED, {
            roomCode,
            lotId: outcome.lotId,
            deadlineMs: null,
            remainingSeconds: 0,
            isPaused: false,
            serverTimeMs: nowMs
          });
          closedCodes.push(roomCode);
        }
      } catch (err: any) {
        if (err?.code === 'ROOM_NOT_FOUND') {
          await AuctionTimerManager.clearTimer(roomCode);
        } else {
          console.error(`[TimerManager] Error processing expired timer for ${roomCode}:`, err);
        }
      }
    }

    // Broadcast lightweight drift-correction TIMER_UPDATED pulse every 5s for active rooms
    try {
      const runningRooms = await redis.zrangebyscore(
        ACTIVE_TIMERS_ZSET,
        `(${nowMs}`,
        '+inf',
        'WITHSCORES'
      );
      for (let i = 0; i < runningRooms.length; i += 2) {
        const roomCode = runningRooms[i];
        const deadlineMs = Number(runningRooms[i + 1]);
        const lastPulse = AuctionTimerManager.lastSyncPulseByRoom.get(roomCode) ?? 0;
        if (nowMs - lastPulse >= 5000) {
          AuctionTimerManager.lastSyncPulseByRoom.set(roomCode, nowMs);
          const raw = await redis.get(timerKey(roomCode));
          const parsed = raw ? JSON.parse(raw) : null;
          emitToRoom(roomCode, SOCKET_EVENTS.TIMER_UPDATED, {
            roomCode,
            lotId: parsed?.lotId ?? null,
            deadlineMs,
            remainingSeconds: Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000)),
            isPaused: false,
            serverTimeMs: nowMs
          });
        }
      }
    } catch {
      // Non-fatal sync pulse check
    }

    return closedCodes;
  }

  static start(intervalMs = 250): void {
    if (AuctionTimerManager.intervalId) return;
    AuctionTimerManager.recoverActiveTimersOnBoot().catch((err) => {
      console.error('[TimerManager] Boot recovery failed:', err);
    });

    AuctionTimerManager.intervalId = setInterval(async () => {
      if (AuctionTimerManager.isTicking) return;
      AuctionTimerManager.isTicking = true;
      try {
        await AuctionTimerManager.processExpiredTimers();
      } catch (err) {
        console.error('[TimerManager] Tick error:', err);
      } finally {
        AuctionTimerManager.isTicking = false;
      }
    }, intervalMs);
  }

  static stop(): void {
    if (AuctionTimerManager.intervalId) {
      clearInterval(AuctionTimerManager.intervalId);
      AuctionTimerManager.intervalId = null;
    }
  }
}
