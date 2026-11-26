'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AuctionBidDto,
  AuctionFranchiseStateDto,
  AuctionResultItemDto,
  AuctionStage,
  AuctionStateSnapshotDto,
  AuctionTimerDto,
  BidTierConfig,
  CricketRole,
  LotStatus,
  RoomRole,
  RoomStatus,
  SOCKET_EVENTS
} from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { formatCricketStyle, formatLakhs } from '@/lib/formatPrice';
import { playBidChime, playCountdownTick, playSoldGavel, playUnsoldTone } from '@/lib/audioEffects';
import { getRoomSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { FranchiseEmblem } from '@/components/ui/FranchiseEmblem';
import { Modal } from '@/components/ui/Modal';
import { PlayerProfileModal } from '@/components/players/PlayerProfileModal';
import { SquadIntelligencePanel } from '@/components/room/SquadIntelligencePanel';
import {
  ArrowLeft,
  Award,
  BarChart3,
  CheckCircle2,
  Clock,
  Crown,
  Eye,
  FastForward,
  Gavel,
  Globe,
  Hammer,
  History,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  ShieldCheck,
  SkipForward,
  Sparkles,
  UserCheck,
  Users,
  Volume2,
  VolumeX,
  Wallet,
  Wifi,
  WifiOff,
  XCircle
} from 'lucide-react';

type SocketStatus = 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED';

interface FeedEvent {
  id: string;
  text: string;
  timestamp: string;
  tone: 'gold' | 'electric' | 'sold' | 'unsold';
}

interface SettlementOverlayState {
  type: 'SOLD' | 'UNSOLD';
  playerName: string;
  playingRole: CricketRole;
  isOverseas: boolean;
  franchiseCode?: string;
  franchiseName?: string;
  franchiseColor?: string;
  priceLakhs?: number;
}

const ROLE_LABEL: Record<CricketRole, string> = {
  BATSMAN: 'Batsman',
  BOWLER: 'Bowler',
  ALL_ROUNDER: 'All-Rounder',
  WICKET_KEEPER: 'Wicketkeeper'
};

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'PL';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function resolveIncrementForAmount(
  amountLakhs: number,
  tiers: readonly BidTierConfig[]
): number {
  const sorted = [...tiers].sort((a, b) => a.minAmount - b.minAmount);
  for (const tier of sorted) {
    if (amountLakhs >= tier.minAmount && amountLakhs <= tier.maxAmount) {
      return tier.increment;
    }
  }
  return sorted[sorted.length - 1]?.increment ?? 10;
}

function stepForwardBid(
  startBidLakhs: number,
  steps: number,
  tiers: readonly BidTierConfig[]
): number {
  let current = startBidLakhs;
  for (let i = 0; i < steps; i++) {
    current += resolveIncrementForAmount(current, tiers);
  }
  return current;
}

function formatRoleBadgeTone(stage: AuctionStage): 'sold' | 'gold' | 'electric' | 'unsold' | 'neutral' {
  switch (stage) {
    case 'LIVE':
      return 'electric';
    case 'PAUSED':
      return 'gold';
    case 'BIDDING_CLOSED':
      return 'gold';
    case 'PLAYER_SOLD':
      return 'sold';
    case 'PLAYER_UNSOLD':
      return 'unsold';
    case 'COMPLETED':
      return 'sold';
    default:
      return 'neutral';
  }
}

export default function LiveAuctionPage() {
  const params = useParams();
  const router = useRouter();
  const roomCode = String(params?.code || '').toUpperCase();
  const prefersReducedMotion = useReducedMotion();

  const { session, token, isHydrated, hydrate } = useSessionStore();

  const [auction, setAuction] = useState<AuctionStateSnapshotDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('CONNECTING');

  const [actionError, setActionError] = useState<string | null>(null);
  const [isBidding, setIsBidding] = useState(false);
  const [isHostActing, setIsHostActing] = useState(false);

  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [settlementOverlay, setSettlementOverlay] = useState<SettlementOverlayState | null>(null);
  const [inspectedFranchiseId, setInspectedFranchiseId] = useState<string | null>(null);
  const [squadTab, setSquadTab] = useState<'ROSTER' | 'STRENGTH' | 'PLAYING_XI'>('ROSTER');
  const [inspectedPlayerId, setInspectedPlayerId] = useState<string | null>(null);
  const [imageFailedLotId, setImageFailedLotId] = useState<string | null>(null);
  const [sideTab, setSideTab] = useState<'QUEUE' | 'BIDS' | 'RESULTS' | 'FEED'>('QUEUE');
  const [resultsFilter, setResultsFilter] = useState<'ALL' | 'SOLD' | 'UNSOLD'>('ALL');
  const [resultsSearch, setResultsSearch] = useState('');

  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(0.65);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Server-authoritative timer offset (`serverTimeMs - Date.now()`) & ticking seconds
  const clockOffsetRef = useRef<number>(0);
  const lastTickSecRef = useRef<number | null>(null);
  const [liveRemainingSeconds, setLiveRemainingSeconds] = useState<number>(0);

  const pushFeed = useCallback((text: string, tone: FeedEvent['tone'] = 'electric') => {
    setFeed((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text,
        timestamp: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }),
        tone
      },
      ...prev.slice(0, 29)
    ]);
  }, []);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const syncClock = useCallback((serverTimeMs: number | undefined) => {
    if (typeof serverTimeMs === 'number' && Number.isFinite(serverTimeMs)) {
      clockOffsetRef.current = serverTimeMs - Date.now();
    }
  }, []);

  const fetchAuctionSnapshot = useCallback(async () => {
    if (!roomCode) return;
    if (!token) {
      setLoadError('Join the room from the lobby first so your team session is authenticated.');
      setIsLoading(false);
      return;
    }
    setLoadError(null);
    try {
      const res: any = await api.get(`/rooms/${roomCode}/auction`);
      const snap = res.data as AuctionStateSnapshotDto;
      syncClock(snap.serverTimeMs);
      setAuction(snap);
      if (snap.roomStatus === RoomStatus.LOBBY) {
        router.replace(`/room/${snap.roomCode}`);
      }
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load live auction room');
    } finally {
      setIsLoading(false);
    }
  }, [roomCode, token, syncClock, router]);

  useEffect(() => {
    if (!isHydrated) return;
    fetchAuctionSnapshot();
  }, [isHydrated, fetchAuctionSnapshot]);

  // Smooth countdown interval driven strictly by server deadlineMs + clockOffset
  useEffect(() => {
    const compute = () => {
      if (!auction) {
        setLiveRemainingSeconds(0);
        return;
      }
      if (auction.isPaused || auction.auctionStage === 'PAUSED' || auction.timer.isPaused) {
        setLiveRemainingSeconds(auction.timer.remainingSeconds);
        return;
      }
      if (
        auction.auctionStage === 'BIDDING_CLOSED' ||
        auction.auctionStage === 'PLAYER_SOLD' ||
        auction.auctionStage === 'PLAYER_UNSOLD' ||
        auction.auctionStage === 'COMPLETED'
      ) {
        setLiveRemainingSeconds(0);
        return;
      }
      if (auction.timer.deadlineMs) {
        const estimatedServerNow = Date.now() + clockOffsetRef.current;
        const diffSec = Math.max(0, (auction.timer.deadlineMs - estimatedServerNow) / 1000);
        setLiveRemainingSeconds(diffSec);
        const ceilSec = Math.ceil(diffSec);
        if (ceilSec >= 1 && ceilSec <= 3 && lastTickSecRef.current !== ceilSec) {
          lastTickSecRef.current = ceilSec;
          playCountdownTick(isMuted, volume);
        } else if (ceilSec > 3 || ceilSec <= 0) {
          lastTickSecRef.current = null;
        }
      } else {
        setLiveRemainingSeconds(auction.timer.remainingSeconds);
      }
    };

    compute();
    const interval = setInterval(compute, 100);
    return () => clearInterval(interval);
  }, [auction, isMuted, volume]);

  // Real-time incremental Socket.IO listener setup
  useEffect(() => {
    if (!token || !roomCode) return;
    const socket = getRoomSocket(token);
    setSocketStatus(socket.connected ? 'CONNECTED' : 'CONNECTING');

    const joinRoom = () => {
      setSocketStatus('CONNECTED');
      socket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode }, (ack: any) => {
        if (ack && !ack.ok && ack.code === 'NOT_MEMBER') {
          setActionError('You are not an active participant in this auction room.');
        }
      });
    };

    const onDisconnect = () => setSocketStatus('DISCONNECTED');

    const onAuctionState = (snap: AuctionStateSnapshotDto) => {
      syncClock(snap.serverTimeMs);
      setAuction(snap);
      if (snap.auctionStage === 'PLAYER_SOLD' && snap.currentLot?.winningFranchiseCode) {
        setSettlementOverlay({
          type: 'SOLD',
          playerName: snap.currentLot.player.fullName,
          playingRole: snap.currentLot.player.playingRole,
          isOverseas: snap.currentLot.player.isOverseas,
          franchiseCode: snap.currentLot.winningFranchiseCode,
          franchiseName: snap.currentLot.winningFranchiseName || snap.currentLot.winningFranchiseCode,
          franchiseColor: snap.currentLot.winningFranchiseColor || '#D4AF37',
          priceLakhs: snap.currentLot.currentBidLakhs
        });
      } else if (snap.auctionStage === 'PLAYER_UNSOLD' && snap.currentLot) {
        setSettlementOverlay({
          type: 'UNSOLD',
          playerName: snap.currentLot.player.fullName,
          playingRole: snap.currentLot.player.playingRole,
          isOverseas: snap.currentLot.player.isOverseas
        });
      } else {
        setSettlementOverlay(null);
      }
    };

    const onAuctionStarted = () => {
      pushFeed('Auction broadcast started!', 'gold');
      fetchAuctionSnapshot();
    };

    const onPlayerLotStarted = (evt: any) => {
      setActionError(null);
      setSettlementOverlay(null);
      setAuction((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          auctionStage: 'LIVE',
          isPaused: false,
          currentLot: evt.currentLot ?? prev.currentLot,
          upNextLots: Array.isArray(evt.upNextLots) ? evt.upNextLots : prev.upNextLots
        };
      });
      if (evt?.currentLot?.player?.fullName) {
        pushFeed(
          `Lot #${evt.currentLot.sequenceOrder} on stage: ${evt.currentLot.player.fullName} (Base ${formatLakhs(evt.currentLot.basePriceLakhs)})`,
          'electric'
        );
      }
    };

    const onBidPlaced = (evt: any) => {
      syncClock(evt.serverTimeMs);
      setActionError(null);
      const bid: AuctionBidDto | undefined = evt?.bid;
      if (!bid) return;

      setAuction((prev) => {
        if (!prev || !prev.currentLot || prev.currentLot.id !== evt.lotId) return prev;
        const alreadyPresent = prev.currentLot.bids.some((b) => b.id === bid.id);
        const nextBids = alreadyPresent
          ? prev.currentLot.bids
          : [bid, ...prev.currentLot.bids];
        const nextAllBids = prev.allBids.some((b) => b.id === bid.id)
          ? prev.allBids
          : [bid, ...prev.allBids].slice(0, 250);

        return {
          ...prev,
          allBids: nextAllBids,
          currentLot: {
            ...prev.currentLot,
            currentBidLakhs: bid.bidAmountLakhs,
            nextBidLakhs: evt.nextBidLakhs ?? prev.currentLot.nextBidLakhs,
            incrementLakhs: evt.incrementLakhs ?? prev.currentLot.incrementLakhs,
            winningFranchiseId: bid.franchiseId,
            winningFranchiseCode: bid.franchiseCode,
            winningFranchiseName: evt.winningFranchiseName ?? bid.franchiseCode,
            winningFranchiseColor: bid.franchiseColor,
            winningOwnerName: bid.bidderDisplayName,
            bids: nextBids
          }
        };
      });

      playBidChime(isMuted, volume);
      pushFeed(
        `${bid.franchiseCode} (${bid.bidderDisplayName}) bids ${formatLakhs(bid.bidAmountLakhs)}`,
        'gold'
      );
    };

    const onBidRejected = (evt: any) => {
      setIsBidding(false);
      setActionError(evt?.message || 'Bid was rejected by the auction server.');
    };

    const onTimerUpdated = (timer: AuctionTimerDto) => {
      syncClock(timer.serverTimeMs);
      setAuction((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          timer
        };
      });
    };

    const onBiddingClosed = (evt: any) => {
      setAuction((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          auctionStage: 'BIDDING_CLOSED',
          timer: {
            ...prev.timer,
            deadlineMs: null,
            remainingSeconds: 0,
            isPaused: false
          },
          currentLot:
            prev.currentLot && prev.currentLot.id === evt.lotId
              ? { ...prev.currentLot, status: LotStatus.BIDDING_CLOSED }
              : prev.currentLot
        };
      });
      pushFeed('Countdown expired — bidding closed. Waiting for host verdict.', 'gold');
    };

    const onAuctionPaused = () => {
      setAuction((prev) => (prev ? { ...prev, isPaused: true, auctionStage: 'PAUSED' } : prev));
      pushFeed('Host paused the auction floor.', 'gold');
    };

    const onAuctionResumed = () => {
      setAuction((prev) => (prev ? { ...prev, isPaused: false, auctionStage: 'LIVE' } : prev));
      pushFeed('Auction resumed by host.', 'electric');
    };

    const onPlayerSold = (evt: any) => {
      playSoldGavel(isMuted, volume);
      setSettlementOverlay({
        type: 'SOLD',
        playerName: evt.playerName,
        playingRole: evt.playingRole,
        isOverseas: Boolean(evt.isOverseas),
        franchiseCode: evt.franchiseCode,
        franchiseName: evt.franchiseName,
        franchiseColor: evt.franchiseColor || '#D4AF37',
        priceLakhs: evt.soldPriceLakhs
      });

      setAuction((prev) => {
        if (!prev) return prev;
        const resultItem: AuctionResultItemDto = {
          lotId: evt.lotId,
          playerId: evt.playerId,
          playerName: evt.playerName,
          playingRole: evt.playingRole,
          isOverseas: Boolean(evt.isOverseas),
          status: LotStatus.SOLD,
          soldPriceLakhs: evt.soldPriceLakhs,
          franchiseCode: evt.franchiseCode,
          franchiseColor: evt.franchiseColor,
          settledAt: evt.settledAt || new Date().toISOString()
        };
        const deduped = prev.recentResults.filter((r) => r.lotId !== evt.lotId);
        return {
          ...prev,
          auctionStage: 'PLAYER_SOLD',
          timer: { ...prev.timer, deadlineMs: null, remainingSeconds: 0 },
          currentLot:
            prev.currentLot && prev.currentLot.id === evt.lotId
              ? { ...prev.currentLot, status: LotStatus.SOLD }
              : prev.currentLot,
          recentResults: [resultItem, ...deduped]
        };
      });

      pushFeed(
        `SOLD! ${evt.playerName} to ${evt.franchiseCode} for ${formatLakhs(evt.soldPriceLakhs)}`,
        'sold'
      );
    };

    const onPlayerUnsold = (evt: any) => {
      playUnsoldTone(isMuted, volume);
      setSettlementOverlay({
        type: 'UNSOLD',
        playerName: evt.playerName,
        playingRole: evt.playingRole,
        isOverseas: Boolean(evt.isOverseas)
      });

      setAuction((prev) => {
        if (!prev) return prev;
        const resultItem: AuctionResultItemDto = {
          lotId: evt.lotId,
          playerId: evt.playerId,
          playerName: evt.playerName,
          playingRole: evt.playingRole,
          isOverseas: Boolean(evt.isOverseas),
          status: LotStatus.UNSOLD,
          soldPriceLakhs: null,
          franchiseCode: null,
          franchiseColor: null,
          settledAt: evt.settledAt || new Date().toISOString()
        };
        const deduped = prev.recentResults.filter((r) => r.lotId !== evt.lotId);
        return {
          ...prev,
          auctionStage: 'PLAYER_UNSOLD',
          unsoldCount: prev.recentResults.some((r) => r.lotId === evt.lotId && r.status === LotStatus.UNSOLD)
            ? prev.unsoldCount
            : prev.unsoldCount + 1,
          timer: { ...prev.timer, deadlineMs: null, remainingSeconds: 0 },
          currentLot:
            prev.currentLot && prev.currentLot.id === evt.lotId
              ? { ...prev.currentLot, status: LotStatus.UNSOLD }
              : prev.currentLot,
          recentResults: [resultItem, ...deduped]
        };
      });

      pushFeed(`UNSOLD: ${evt.playerName}`, 'unsold');
    };

    const onPurseUpdated = (evt: any) => {
      setAuction((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          franchises: prev.franchises.map((f) =>
            f.id === evt.franchiseId
              ? { ...f, remainingPurseLakhs: evt.remainingPurseLakhs }
              : f
          )
        };
      });
    };

    const onSquadUpdated = (evt: any) => {
      setAuction((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          franchises: prev.franchises.map((f) =>
            f.id === evt.franchiseId
              ? {
                  ...f,
                  squadCount: evt.squadCount,
                  overseasCount: evt.overseasCount,
                  squad: Array.isArray(evt.squad) ? evt.squad : f.squad
                }
              : f
          )
        };
      });
    };

    const onAuctionCompleted = (evt: any) => {
      setSettlementOverlay(null);
      setAuction((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          roomStatus: RoomStatus.COMPLETED,
          auctionStage: 'COMPLETED',
          currentLot: null,
          timer: { lotId: null, deadlineMs: null, remainingSeconds: 0, isPaused: false, serverTimeMs: Date.now() },
          franchises: Array.isArray(evt?.franchises) ? evt.franchises : prev.franchises
        };
      });
      pushFeed('Auction complete! Final squads locked.', 'sold');
    };

    const onLotRoundReentered = (evt: any) => {
      setSettlementOverlay(null);
      if (evt?.snapshot) {
        syncClock(evt.snapshot.serverTimeMs);
        setAuction(evt.snapshot);
      } else {
        fetchAuctionSnapshot();
      }
      pushFeed(
        `Accelerated Round ${evt?.roundNumber || ''}: ${evt?.requeuedCount || 0} unsold player(s) re-entered!`,
        'gold'
      );
    };

    const onParticipantEvent = () => {
      fetchAuctionSnapshot();
    };

    socket.on('connect', joinRoom);
    socket.on('disconnect', onDisconnect);
    socket.on(SOCKET_EVENTS.AUCTION_STATE, onAuctionState);
    socket.on(SOCKET_EVENTS.AUCTION_STARTED, onAuctionStarted);
    socket.on(SOCKET_EVENTS.PLAYER_LOT_STARTED, onPlayerLotStarted);
    socket.on(SOCKET_EVENTS.BID_PLACED, onBidPlaced);
    socket.on(SOCKET_EVENTS.BID_REJECTED, onBidRejected);
    socket.on(SOCKET_EVENTS.TIMER_UPDATED, onTimerUpdated);
    socket.on(SOCKET_EVENTS.BIDDING_CLOSED, onBiddingClosed);
    socket.on(SOCKET_EVENTS.AUCTION_PAUSED, onAuctionPaused);
    socket.on(SOCKET_EVENTS.AUCTION_RESUMED, onAuctionResumed);
    socket.on(SOCKET_EVENTS.PLAYER_SOLD, onPlayerSold);
    socket.on(SOCKET_EVENTS.PLAYER_UNSOLD, onPlayerUnsold);
    socket.on(SOCKET_EVENTS.PURSE_UPDATED, onPurseUpdated);
    socket.on(SOCKET_EVENTS.SQUAD_UPDATED, onSquadUpdated);
    socket.on(SOCKET_EVENTS.LOT_ROUND_REENTERED, onLotRoundReentered);
    socket.on(SOCKET_EVENTS.AUCTION_COMPLETED, onAuctionCompleted);
    socket.on(SOCKET_EVENTS.HOST_CHANGED, onParticipantEvent);
    socket.on(SOCKET_EVENTS.PARTICIPANT_JOINED, onParticipantEvent);
    socket.on(SOCKET_EVENTS.PARTICIPANT_LEFT, onParticipantEvent);

    if (socket.connected) {
      joinRoom();
    }

    return () => {
      socket.off('connect', joinRoom);
      socket.off('disconnect', onDisconnect);
      socket.off(SOCKET_EVENTS.AUCTION_STATE, onAuctionState);
      socket.off(SOCKET_EVENTS.AUCTION_STARTED, onAuctionStarted);
      socket.off(SOCKET_EVENTS.PLAYER_LOT_STARTED, onPlayerLotStarted);
      socket.off(SOCKET_EVENTS.BID_PLACED, onBidPlaced);
      socket.off(SOCKET_EVENTS.BID_REJECTED, onBidRejected);
      socket.off(SOCKET_EVENTS.TIMER_UPDATED, onTimerUpdated);
      socket.off(SOCKET_EVENTS.BIDDING_CLOSED, onBiddingClosed);
      socket.off(SOCKET_EVENTS.AUCTION_PAUSED, onAuctionPaused);
      socket.off(SOCKET_EVENTS.AUCTION_RESUMED, onAuctionResumed);
      socket.off(SOCKET_EVENTS.PLAYER_SOLD, onPlayerSold);
      socket.off(SOCKET_EVENTS.PLAYER_UNSOLD, onPlayerUnsold);
      socket.off(SOCKET_EVENTS.PURSE_UPDATED, onPurseUpdated);
      socket.off(SOCKET_EVENTS.SQUAD_UPDATED, onSquadUpdated);
      socket.off(SOCKET_EVENTS.LOT_ROUND_REENTERED, onLotRoundReentered);
      socket.off(SOCKET_EVENTS.AUCTION_COMPLETED, onAuctionCompleted);
      socket.off(SOCKET_EVENTS.HOST_CHANGED, onParticipantEvent);
      socket.off(SOCKET_EVENTS.PARTICIPANT_JOINED, onParticipantEvent);
      socket.off(SOCKET_EVENTS.PARTICIPANT_LEFT, onParticipantEvent);
    };
  }, [token, roomCode, syncClock, fetchAuctionSnapshot, pushFeed, isMuted, volume]);

  const myParticipant = useMemo(() => {
    if (!auction || !session) return null;
    return auction.participants.find((p) => p.guestSessionId === session.id) || null;
  }, [auction, session]);

  const isHost = Boolean(
    myParticipant &&
      (myParticipant.id === auction?.hostParticipantId || myParticipant.role === RoomRole.HOST)
  );

  const myFranchise = useMemo(() => {
    if (!auction || !myParticipant?.franchiseId) return null;
    return auction.franchises.find((f) => f.id === myParticipant.franchiseId) || null;
  }, [auction, myParticipant]);

  const inspectedFranchise: AuctionFranchiseStateDto | null = useMemo(() => {
    if (!auction || !inspectedFranchiseId) return null;
    return auction.franchises.find((f) => f.id === inspectedFranchiseId) || null;
  }, [auction, inspectedFranchiseId]);

  const isActiveOwner = Boolean(
    myFranchise && myParticipant && myParticipant.role !== RoomRole.SPECTATOR
  );

  const isOwnInspectedFranchise = Boolean(
    isActiveOwner && inspectedFranchise && myFranchise && inspectedFranchise.id === myFranchise.id
  );

  const bidCheck = useMemo(() => {
    if (!auction || !auction.currentLot) {
      return { canBid: false, reason: 'No active player lot on stage.' };
    }
    if (!myParticipant || myParticipant.role === RoomRole.SPECTATOR) {
      return { canBid: false, reason: 'Spectators cannot place bids.' };
    }
    if (!myFranchise) {
      return { canBid: false, reason: 'No franchise assigned to your session.' };
    }
    if (auction.isPaused || auction.auctionStage === 'PAUSED') {
      return { canBid: false, reason: 'Auction is paused by Host.' };
    }
    if (auction.auctionStage === 'BIDDING_CLOSED' || auction.currentLot.status === LotStatus.BIDDING_CLOSED) {
      return { canBid: false, reason: 'Timer expired — waiting for Host verdict.' };
    }
    if (auction.currentLot.status !== LotStatus.ACTIVE) {
      return { canBid: false, reason: 'Bidding is not active on this lot.' };
    }
    if (auction.currentLot.winningFranchiseId === myFranchise.id) {
      return { canBid: false, reason: 'You currently hold the highest bid.' };
    }
    if (myFranchise.squadCount >= auction.settings.maxSquadSize) {
      return { canBid: false, reason: `Squad limit (${auction.settings.maxSquadSize}) reached.` };
    }
    if (
      auction.currentLot.player.isOverseas &&
      myFranchise.overseasCount >= auction.settings.maxOverseas
    ) {
      return { canBid: false, reason: `Overseas limit (${auction.settings.maxOverseas}) reached.` };
    }
    if (myFranchise.remainingPurseLakhs < auction.currentLot.nextBidLakhs) {
      return {
        canBid: false,
        reason: `Insufficient purse (${formatLakhs(myFranchise.remainingPurseLakhs)} left).`
      };
    }
    return { canBid: true, reason: null };
  }, [auction, myParticipant, myFranchise]);

  const jumpBidOptions = useMemo(() => {
    if (!auction?.currentLot) return [];
    const tiers = auction.settings.bidIncrementTiers;
    const baseNext = auction.currentLot.nextBidLakhs;
    const step2 = stepForwardBid(baseNext, 1, tiers);
    const step4 = stepForwardBid(baseNext, 3, tiers);
    return [baseNext, step2, step4].filter((val, idx, arr) => arr.indexOf(val) === idx);
  }, [auction]);

  const handlePlaceBid = async (bidAmountLakhs: number) => {
    if (!auction?.currentLot || isBidding) return;
    setActionError(null);
    setIsBidding(true);
    try {
      const idempotencyKey =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await api.post(`/rooms/${roomCode}/auction/bids`, {
        lotId: auction.currentLot.id,
        bidAmountLakhs,
        idempotencyKey
      });
    } catch (err: any) {
      setActionError(err?.message || 'Unable to place bid.');
    } finally {
      setIsBidding(false);
    }
  };

  const handleHostAction = async (
    endpoint: string,
    payload: Record<string, unknown> = {}
  ) => {
    if (!isHost || isHostActing) return;
    setActionError(null);
    setIsHostActing(true);
    try {
      await api.post(`/rooms/${roomCode}/auction/${endpoint}`, payload);
    } catch (err: any) {
      setActionError(err?.message || 'Host command failed.');
    } finally {
      setIsHostActing(false);
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Ignore fullscreen denial in restricted browsers
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stadium-bg px-4">
        <Card className="p-8 text-center space-y-3 max-w-md w-full">
          <div className="w-10 h-10 rounded-full border-2 border-gold-400 border-t-transparent animate-spin mx-auto" />
          <p className="font-display text-xl tracking-wide text-white">ENTERING LIVE STADIUM...</p>
        </Card>
      </div>
    );
  }

  if (loadError || !auction) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stadium-bg px-4">
        <Card className="p-8 text-center space-y-4 max-w-md w-full">
          <h1 className="font-display text-2xl font-bold text-white">UNABLE TO LOAD AUCTION</h1>
          <p className="text-sm text-stadium-muted">{loadError || 'Auction state unavailable.'}</p>
          <div className="flex justify-center gap-3">
            <Link href={`/room/${roomCode}`}>
              <Button variant="gold">Return to Lobby</Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const currentLot = auction.currentLot;
  const maxTimerSec = Math.max(1, auction.settings.countdownSeconds);
  const progressRatio = Math.max(0, Math.min(1, liveRemainingSeconds / maxTimerSec));
  const isUrgent =
    liveRemainingSeconds > 0 &&
    liveRemainingSeconds <= 5 &&
    auction.auctionStage === 'LIVE' &&
    !auction.isPaused;
  const ringCircumference = 2 * Math.PI * 38;
  const ringOffset = ringCircumference * (1 - progressRatio);

  return (
    <main className="min-h-screen bg-stadium-bg pb-12">
      {/* Broadcast Top Bar */}
      <header className="sticky top-0 z-30 border-b border-stadium-border bg-stadium-bg/90 backdrop-blur-lg">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href={`/room/${auction.roomCode}`}
              className="p-2 rounded-lg text-stadium-muted hover:text-white hover:bg-white/5 transition-colors"
              aria-label="Back to room lobby"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="font-display text-xl sm:text-2xl font-extrabold tracking-wide text-white truncate">
                  {auction.roomName}
                </h1>
                <span className="font-mono text-xs px-2 py-0.5 rounded-md bg-gold-500/15 text-gold-300 border border-gold-500/35">
                  {auction.roomCode}
                </span>
                <Badge tone={formatRoleBadgeTone(auction.auctionStage)} data-testid="auction-stage-badge">
                  <Radio className="w-3 h-3" />
                  {auction.auctionStage.replace(/_/g, ' ')}
                </Badge>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {isActiveOwner && (
              <Link
                href={`/intelligence?roomCode=${encodeURIComponent(roomCode)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="electric" size="sm" data-testid="nav-owner-intelligence-btn">
                  Owner Intelligence
                </Button>
              </Link>
            )}
            {isHost && (
              <Badge tone="gold" className="hidden md:inline-flex">
                <Crown className="w-3 h-3" /> Host + Owner
              </Badge>
            )}

            {/* Sound Controls */}
            <div className="hidden sm:flex items-center gap-2 rounded-xl border border-stadium-border bg-stadium-surface px-2.5 py-1.5">
              <button
                type="button"
                onClick={() => setIsMuted((m) => !m)}
                aria-label={isMuted ? 'Unmute auction sounds' : 'Mute auction sounds'}
                className="text-stadium-muted hover:text-white transition-colors"
              >
                {isMuted ? <VolumeX className="w-4 h-4 text-signal-unsold" /> : <Volume2 className="w-4 h-4 text-gold-400" />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setVolume(val);
                  if (val > 0 && isMuted) setIsMuted(false);
                }}
                aria-label="Audio effects volume"
                className="w-16 accent-gold-500 cursor-pointer"
              />
            </div>

            <button
              type="button"
              onClick={toggleFullscreen}
              className="p-2 rounded-xl border border-stadium-border bg-stadium-surface text-stadium-muted hover:text-white transition-colors"
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>

            <Badge tone={socketStatus === 'CONNECTED' ? 'sold' : 'unsold'}>
              {socketStatus === 'CONNECTED' ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              <span className="hidden sm:inline">{socketStatus === 'CONNECTED' ? 'LIVE' : 'SYNCING'}</span>
            </Badge>
          </div>
        </div>
      </header>

      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 pt-5 space-y-5">
        {actionError && (
          <div
            role="alert"
            className="rounded-xl border border-signal-unsold/50 bg-signal-unsold/15 px-4 py-3 text-sm text-white flex items-center justify-between gap-3"
          >
            <div className="flex items-center gap-2">
              <XCircle className="w-4 h-4 text-signal-unsold shrink-0" />
              <span>{actionError}</span>
            </div>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="text-xs text-stadium-muted hover:text-white"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* COMPLETED SCREEN */}
        {auction.auctionStage === 'COMPLETED' ? (
          <section className="space-y-6" data-testid="auction-completed-view">
            <Card highlight="gold" className="p-8 text-center space-y-3">
              <div className="w-14 h-14 rounded-2xl bg-gold-500/20 border border-gold-500/40 flex items-center justify-center mx-auto">
                <Award className="w-8 h-8 text-gold-400" />
              </div>
              <h2 className="font-display text-4xl font-extrabold tracking-wide text-white">
                AUCTION COMPLETE
              </h2>
              <p className="text-sm text-stadium-muted max-w-xl mx-auto">
                Every lot in the auction pool has been settled. Inspect every franchise&apos;s final squad and remaining purse below.
              </p>
              <div className="pt-2 flex flex-wrap justify-center gap-3">
                {isHost && (
                  <Link href={`/room/${auction.roomCode}/team-ratings`}>
                    <Button
                      variant="gold"
                      leftIcon={<BarChart3 className="w-4 h-4" />}
                      data-testid="completed-team-ratings-btn"
                    >
                      TEAM RATINGS
                    </Button>
                  </Link>
                )}
                {!isHost && isActiveOwner && (
                  <Link href={`/room/${auction.roomCode}/team-ratings`}>
                    <Button
                      variant="electric"
                      leftIcon={<BarChart3 className="w-4 h-4" />}
                      data-testid="completed-owner-report-btn"
                    >
                      MY TEAM REPORT
                    </Button>
                  </Link>
                )}
                {isHost && auction.unsoldCount > 0 && (
                  <Button
                    variant="gold"
                    isLoading={isHostActing}
                    onClick={() => handleHostAction('requeue-unsold', {})}
                    leftIcon={<RotateCcw className="w-4 h-4" />}
                    data-testid="completed-requeue-unsold-btn"
                  >
                    Re-Enter {auction.unsoldCount} Unsold Player{auction.unsoldCount === 1 ? '' : 's'} (Round {auction.currentRound + 1})
                  </Button>
                )}
                <Link href={`/room/${auction.roomCode}`}>
                  <Button variant="surface">Back to Room Overview</Button>
                </Link>
              </div>
            </Card>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {auction.franchises.map((f) => (
                <Card
                  key={f.id}
                  className="p-5 space-y-4 cursor-pointer hover:border-gold-500/45 transition-colors"
                  onClick={() => setInspectedFranchiseId(f.id)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <FranchiseEmblem
                        code={f.presetCode}
                        primaryColor={f.primaryColor}
                        secondaryColor={f.secondaryColor}
                      />
                      <div className="min-w-0">
                        <h3 className="font-display text-xl font-bold text-white truncate">{f.name}</h3>
                        <p className="text-xs text-stadium-muted truncate">
                          {f.ownerDisplayName ? `Owner: ${f.ownerDisplayName}` : 'Unclaimed Franchise'}
                        </p>
                      </div>
                    </div>
                    <Badge tone="gold">{f.squadCount} Players</Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 pt-2 border-t border-stadium-border text-xs">
                    <div>
                      <p className="text-stadium-muted">Remaining</p>
                      <p className="font-mono font-bold text-white">{formatLakhs(f.remainingPurseLakhs)}</p>
                    </div>
                    <div>
                      <p className="text-stadium-muted">Overseas</p>
                      <p className="font-mono font-bold text-white">{f.overseasCount}/{auction.settings.maxOverseas}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-stadium-muted">Inspect</p>
                      <p className="text-gold-300 font-semibold">View Squad →</p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </section>
        ) : (
          /* LIVE 3-COLUMN ARENA GRID */
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
            {/* LEFT COLUMN: Franchises & Live Purses */}
            <aside className="xl:col-span-3 space-y-3 order-2 xl:order-1">
              <Card className="p-4 space-y-3">
                <div className="flex items-center justify-between border-b border-stadium-border pb-2.5">
                  <div className="flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-gold-400" />
                    <h2 className="font-display text-lg font-bold text-white tracking-wide">
                      FRANCHISE PURSES
                    </h2>
                  </div>
                  <span className="text-[11px] font-mono text-stadium-muted">
                    {auction.franchises.filter((f) => f.ownerParticipantId).length}/{auction.franchises.length} Active
                  </span>
                </div>

                <div className="space-y-2 max-h-[560px] overflow-y-auto pr-1">
                  {auction.franchises.map((f) => {
                    const isMine = myFranchise?.id === f.id;
                    const isWinning = currentLot?.winningFranchiseId === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => {
                          setSquadTab('ROSTER');
                          setInspectedFranchiseId(f.id);
                        }}
                        data-testid={`franchise-purse-${f.presetCode}`}
                        className={`w-full text-left rounded-xl border p-3 transition-all ${
                          isWinning
                            ? 'bg-gold-500/15 border-gold-400 shadow-glow-gold'
                            : isMine
                            ? 'bg-electric-500/10 border-electric-400/50'
                            : 'bg-stadium-card/65 border-stadium-border hover:border-white/25'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <FranchiseEmblem
                              code={f.presetCode}
                              primaryColor={f.primaryColor}
                              secondaryColor={f.secondaryColor}
                              size="sm"
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="font-display font-bold text-sm text-white truncate">
                                  {f.presetCode}
                                </span>
                                {isMine && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-electric-500/20 text-electric-400 font-bold">
                                    YOU
                                  </span>
                                )}
                                {isWinning && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gold-500/25 text-gold-300 font-bold">
                                    HIGH BID
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-stadium-muted truncate">
                                {f.ownerDisplayName || 'Unclaimed'}
                              </p>
                            </div>
                          </div>

                          <div className="text-right shrink-0">
                            <p className="font-mono text-xs font-bold text-white">
                              {formatLakhs(f.remainingPurseLakhs)}
                            </p>
                            <p className="text-[10px] font-mono text-stadium-muted">
                              {f.squadCount}/{auction.settings.maxSquadSize} • OS {f.overseasCount}/{auction.settings.maxOverseas}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </Card>
            </aside>

            {/* CENTER STAGE: Spotlight + Timer + Bid Deck + Host Controls */}
            <section className="xl:col-span-6 space-y-5 order-1 xl:order-2">
              {currentLot ? (
                <Card
                  highlight={
                    auction.auctionStage === 'PLAYER_SOLD'
                      ? 'gold'
                      : isUrgent
                      ? 'electric'
                      : 'gold'
                  }
                  className="relative overflow-hidden p-5 sm:p-7 space-y-6"
                >
                  {/* Animated Sold/Unsold Verdict Overlay */}
                  <AnimatePresence>
                    {settlementOverlay && (
                      <motion.div
                        data-testid="settlement-overlay"
                        initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.92 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: prefersReducedMotion ? 0 : 0.25 }}
                        className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-stadium-bg/92 backdrop-blur-md p-6 text-center"
                      >
                        {settlementOverlay.type === 'SOLD' && !prefersReducedMotion && (
                          <div className="pointer-events-none absolute inset-0 overflow-hidden flex items-center justify-center">
                            {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
                              <motion.span
                                key={deg}
                                initial={{ opacity: 0.95, x: 0, y: 0, scale: 0.5 }}
                                animate={{
                                  opacity: 0,
                                  x: Math.cos((deg * Math.PI) / 180) * 180,
                                  y: Math.sin((deg * Math.PI) / 180) * 180,
                                  scale: 1.2
                                }}
                                transition={{ duration: 0.9, ease: 'easeOut' }}
                                className="absolute w-2.5 h-2.5 rounded-full bg-gold-400"
                              />
                            ))}
                          </div>
                        )}

                        <div
                          className={`inline-flex items-center gap-2 rounded-2xl border-2 px-6 py-2.5 font-display text-3xl sm:text-4xl font-extrabold tracking-widest uppercase shadow-lg ${
                            settlementOverlay.type === 'SOLD'
                              ? 'border-signal-sold bg-signal-sold/15 text-signal-sold'
                              : 'border-signal-unsold bg-signal-unsold/15 text-signal-unsold'
                          }`}
                        >
                          {settlementOverlay.type === 'SOLD' ? (
                            <Hammer className="w-7 h-7" />
                          ) : (
                            <XCircle className="w-7 h-7" />
                          )}
                          {settlementOverlay.type}
                        </div>

                        <h3 className="mt-4 font-display text-3xl font-extrabold text-white">
                          {settlementOverlay.playerName}
                        </h3>
                        {settlementOverlay.type === 'SOLD' ? (
                          <div className="mt-2 space-y-1">
                            <p className="text-sm text-stadium-muted">
                              Acquired by{' '}
                              <span className="font-bold text-white">
                                {settlementOverlay.franchiseName} ({settlementOverlay.franchiseCode})
                              </span>
                            </p>
                            <p className="font-mono text-2xl font-bold text-gold-300">
                              {formatLakhs(settlementOverlay.priceLakhs || 0)}
                            </p>
                          </div>
                        ) : (
                          <p className="mt-2 text-sm text-stadium-muted">
                            No bids confirmed — moves to Unsold pool.
                          </p>
                        )}

                        {isHost && (
                          <Button
                            variant="gold"
                            className="mt-6"
                            isLoading={isHostActing}
                            onClick={() => handleHostAction('next')}
                            leftIcon={<FastForward className="w-4 h-4" />}
                            data-testid="overlay-next-player-btn"
                          >
                            Bring Next Player to Stage
                          </Button>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Lot Header + Live Countdown Ring */}
                  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-stadium-border pb-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge tone="gold" data-testid="lot-number-badge">
                          {currentLot.sequenceOrder <= currentLot.totalLots
                            ? `LOT #${currentLot.sequenceOrder} OF ${currentLot.totalLots}`
                            : `LOT #${currentLot.sequenceOrder}`}
                        </Badge>
                        {currentLot.roundNumber > 1 && (
                          <Badge tone="electric">ROUND {currentLot.roundNumber} · RE-ENTRY</Badge>
                        )}
                        <Badge tone="neutral">{currentLot.setCategory}</Badge>
                        <Badge tone={currentLot.player.isOverseas ? 'electric' : 'sold'}>
                          <Globe className="w-3 h-3" />
                          {currentLot.player.isOverseas ? 'OVERSEAS' : 'DOMESTIC'}
                        </Badge>
                      </div>
                      <p className="text-xs text-stadium-muted">
                        Status:{' '}
                        <span className="font-semibold text-white">
                          {currentLot.status.replace(/_/g, ' ')}
                        </span>
                      </p>
                    </div>

                    {/* Circular Server-Authoritative Timer */}
                    <div className="flex items-center gap-3" data-testid="auction-timer">
                      <div className={`relative w-20 h-20 flex items-center justify-center ${isUrgent && !prefersReducedMotion ? 'animate-pulse' : ''}`}>
                        <svg className="w-20 h-20 -rotate-90" viewBox="0 0 88 88">
                          <circle
                            cx="44"
                            cy="44"
                            r="38"
                            stroke="rgba(255,255,255,0.08)"
                            strokeWidth="6"
                            fill="transparent"
                          />
                          <circle
                            cx="44"
                            cy="44"
                            r="38"
                            stroke={
                              auction.auctionStage === 'BIDDING_CLOSED'
                                ? '#F59E0B'
                                : isUrgent
                                ? '#EF4444'
                                : '#D4AF37'
                            }
                            strokeWidth="6"
                            strokeLinecap="round"
                            fill="transparent"
                            strokeDasharray={ringCircumference}
                            strokeDashoffset={ringOffset}
                          />
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                          <span
                            className={`font-mono text-xl font-bold leading-none ${
                              auction.auctionStage === 'BIDDING_CLOSED'
                                ? 'text-signal-warn text-xs'
                                : isUrgent
                                ? 'text-signal-unsold'
                                : 'text-white'
                            }`}
                          >
                            {auction.auctionStage === 'PAUSED'
                              ? `${Math.ceil(liveRemainingSeconds)}s`
                              : auction.auctionStage === 'BIDDING_CLOSED'
                              ? 'CLOSED'
                              : `${Math.ceil(liveRemainingSeconds)}s`}
                          </span>
                          <span className="text-[9px] uppercase tracking-wider text-stadium-muted mt-0.5">
                            {auction.isPaused ? 'Paused' : 'Clock'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Player Spotlight Core */}
                  <div className="flex flex-col sm:flex-row gap-5 items-center sm:items-stretch">
                    {/* Portrait / Broadcast Crest */}
                    <div className="w-36 h-44 rounded-2xl border border-gold-500/35 bg-gradient-to-b from-stadium-card to-stadium-bg flex flex-col items-center justify-center overflow-hidden shrink-0 shadow-stage relative">
                      {currentLot.player.imageUrl && imageFailedLotId !== currentLot.id ? (
                        <img
                          src={currentLot.player.imageUrl}
                          alt={currentLot.player.fullName}
                          onError={() => setImageFailedLotId(currentLot.id)}
                          className="w-full h-full object-cover object-top"
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center gap-2 px-3 text-center">
                          <div className="w-16 h-16 rounded-2xl bg-gold-500/15 border border-gold-500/35 flex items-center justify-center font-display text-2xl font-extrabold text-gold-300">
                            {getInitials(currentLot.player.fullName)}
                          </div>
                          <span className="text-[10px] uppercase tracking-widest text-stadium-muted font-semibold">
                            {ROLE_LABEL[currentLot.player.playingRole]}
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Player Identity + Attributes */}
                    <div className="flex-1 min-w-0 space-y-4 w-full text-center sm:text-left">
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                        <div>
                          <p className="text-xs uppercase tracking-widest text-gold-400 font-bold">
                            {ROLE_LABEL[currentLot.player.playingRole]}
                            {currentLot.player.secondaryRole ? ` / ${ROLE_LABEL[currentLot.player.secondaryRole]}` : ''}
                            {' • '}
                            {currentLot.player.nationality || 'Nationality Unknown'}
                          </p>
                          <h2
                            data-testid="spotlight-player-name"
                            className="font-display text-3xl sm:text-4xl font-extrabold text-white tracking-wide leading-tight mt-0.5"
                          >
                            {currentLot.player.fullName}
                          </h2>
                        </div>
                        <Button
                          variant="surface"
                          size="sm"
                          onClick={() => setInspectedPlayerId(currentLot.player.id)}
                          leftIcon={<UserCheck className="w-3.5 h-3.5 text-gold-300" />}
                          data-testid="view-player-profile-btn"
                        >
                          Career Stats
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-left">
                        <div className="rounded-xl border border-stadium-border bg-stadium-card/70 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wider text-stadium-muted">Batting</p>
                          <p className="text-xs font-semibold text-white truncate">
                            {formatCricketStyle(currentLot.player.battingStyle)}
                          </p>
                        </div>
                        <div className="rounded-xl border border-stadium-border bg-stadium-card/70 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wider text-stadium-muted">Bowling</p>
                          <p className="text-xs font-semibold text-white truncate">
                            {formatCricketStyle(currentLot.player.bowlingStyle)}
                          </p>
                        </div>
                        <div className="rounded-xl border border-stadium-border bg-stadium-card/70 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wider text-stadium-muted">IPL Span</p>
                          <p className="font-mono text-xs font-semibold text-white truncate">
                            {currentLot.player.iplDebutYear
                              ? `${currentLot.player.iplDebutYear}–${currentLot.player.iplLastYear || currentLot.player.iplDebutYear}`
                              : '—'}
                          </p>
                        </div>
                        <div className="rounded-xl border border-stadium-border bg-stadium-card/70 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wider text-stadium-muted">Base Price</p>
                          <p className="font-mono text-xs font-bold text-gold-300">
                            {formatLakhs(currentLot.basePriceLakhs)}
                          </p>
                        </div>
                      </div>

                      {currentLot.player.teamHistory && currentLot.player.teamHistory.length > 0 && (
                        <div className="flex flex-wrap items-center justify-center sm:justify-start gap-1.5 text-[10px] font-mono">
                          <span className="text-stadium-muted uppercase">Franchise History:</span>
                          {currentLot.player.teamHistory.map((code) => (
                            <span
                              key={code}
                              className="px-2 py-0.5 rounded bg-stadium-card border border-stadium-border text-white"
                            >
                              {code}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Current High Bid Box */}
                      <div className="rounded-2xl border border-gold-500/35 bg-gradient-to-r from-stadium-card via-stadium-card to-gold-500/10 p-4 flex flex-wrap items-center justify-between gap-4">
                        <div>
                          <p className="text-[11px] uppercase tracking-wider text-stadium-muted font-semibold">
                            {currentLot.winningFranchiseId ? 'Current Highest Bid' : 'Opening Base Bid'}
                          </p>
                          <p
                            data-testid="current-bid-value"
                            className="font-mono text-3xl font-extrabold text-gold-300 mt-0.5"
                          >
                            {currentLot.winningFranchiseId
                              ? formatLakhs(currentLot.currentBidLakhs)
                              : formatLakhs(currentLot.basePriceLakhs)}
                          </p>
                        </div>

                        {currentLot.winningFranchiseId ? (
                          <div className="flex items-center gap-2.5" data-testid="highest-bidder-box">
                            <FranchiseEmblem
                              code={currentLot.winningFranchiseCode || 'BID'}
                              primaryColor={currentLot.winningFranchiseColor || '#D4AF37'}
                              secondaryColor="#0C1322"
                              size="md"
                            />
                            <div className="text-left">
                              <p className="font-display text-base font-bold text-white leading-tight">
                                {currentLot.winningFranchiseName}
                              </p>
                              <p className="text-[11px] text-stadium-muted">
                                {currentLot.winningOwnerName || 'Franchise Owner'}
                              </p>
                            </div>
                          </div>
                        ) : (
                          <div className="text-right">
                            <Badge tone="neutral">No Bids Placed Yet</Badge>
                            <p className="text-[11px] text-stadium-muted mt-1">
                              Next ask: {formatLakhs(currentLot.nextBidLakhs)}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Recent Bid History Strip */}
                  {currentLot.bids.length > 0 && (
                    <div className="pt-2 border-t border-stadium-border">
                      <p className="text-[11px] uppercase tracking-wider text-stadium-muted mb-2">
                        Recent Bids On Lot
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {currentLot.bids.slice(0, 5).map((b) => (
                          <div
                            key={b.id}
                            className="inline-flex items-center gap-2 rounded-lg border border-stadium-border bg-stadium-card/80 px-2.5 py-1 text-xs"
                          >
                            <span
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: b.franchiseColor || '#D4AF37' }}
                            />
                            <span className="font-bold text-white">{b.franchiseCode}</span>
                            <span className="font-mono text-gold-300">{formatLakhs(b.bidAmountLakhs)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </Card>
              ) : (
                <Card className="p-8 text-center space-y-2">
                  <p className="font-display text-2xl font-bold text-white">PREPARING NEXT LOT</p>
                  <p className="text-sm text-stadium-muted">Waiting for the next player to walk onto the stage.</p>
                </Card>
              )}

              {/* OWNER BIDDING DECK (Equal rules for Host & Non-Host Owners; Hidden action for Spectators) */}
              <Card className="p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stadium-border pb-3">
                  <div className="flex items-center gap-2">
                    <Gavel className="w-4 h-4 text-gold-400" />
                    <h3 className="font-display text-xl font-bold text-white tracking-wide">
                      {myParticipant?.role === RoomRole.SPECTATOR
                        ? 'SPECTATOR VIEWPORT'
                        : myFranchise
                        ? `BIDDING PADDLE — ${myFranchise.name.toUpperCase()}`
                        : 'BIDDING PADDLE'}
                    </h3>
                  </div>
                  {myFranchise && (
                    <div className="flex items-center gap-3 text-xs font-mono">
                      <span className="text-stadium-muted">
                        Purse: <strong className="text-white">{formatLakhs(myFranchise.remainingPurseLakhs)}</strong>
                      </span>
                      <span className="text-stadium-muted">
                        Squad: <strong className="text-white">{myFranchise.squadCount}/{auction.settings.maxSquadSize}</strong>
                      </span>
                    </div>
                  )}
                </div>

                {myParticipant?.role === RoomRole.SPECTATOR ? (
                  <div className="flex items-center gap-3 rounded-xl border border-stadium-border bg-stadium-card/60 px-4 py-3 text-sm text-stadium-muted">
                    <Eye className="w-4 h-4 text-electric-400 shrink-0" />
                    <span>
                      You are watching as a Spectator. Live bids, purses, and squad verdicts update in real time.
                    </span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {bidCheck.reason && (
                      <p
                        data-testid="bid-disabled-reason"
                        className="text-xs text-signal-warn bg-signal-warn/10 border border-signal-warn/30 rounded-xl px-3 py-2"
                      >
                        {bidCheck.reason}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-3">
                      {jumpBidOptions.map((amount, index) => {
                        const affordable = myFranchise ? myFranchise.remainingPurseLakhs >= amount : false;
                        return (
                          <Button
                            key={amount}
                            variant={index === 0 ? 'gold' : 'surface'}
                            size={index === 0 ? 'lg' : 'md'}
                            disabled={!bidCheck.canBid || !affordable || isBidding}
                            isLoading={isBidding && index === 0}
                            onClick={() => handlePlaceBid(amount)}
                            leftIcon={<Hammer className="w-4 h-4" />}
                            data-testid={index === 0 ? 'place-bid-btn' : `jump-bid-btn-${index}`}
                          >
                            {index === 0
                              ? `Bid ${formatLakhs(amount)}`
                              : `Jump ${formatLakhs(amount)}`}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </Card>

              {/* HOST FLOOR CONTROLS (Strictly Host-Only) */}
              {isHost && (
                <Card highlight="electric" className="p-5 space-y-4" data-testid="host-controls-panel">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stadium-border pb-3">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-electric-400" />
                      <h3 className="font-display text-xl font-bold text-white tracking-wide">
                        HOST FLOOR CONTROLS
                      </h3>
                    </div>
                    <span className="text-[11px] text-stadium-muted">
                      Timer expiry stops bidding; confirm SOLD or UNSOLD manually.
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-2.5">
                    {auction.isPaused ? (
                      <Button
                        variant="electric"
                        size="sm"
                        isLoading={isHostActing}
                        onClick={() => handleHostAction('resume')}
                        leftIcon={<Play className="w-4 h-4" />}
                        data-testid="host-resume-btn"
                      >
                        Resume Auction
                      </Button>
                    ) : (
                      <Button
                        variant="surface"
                        size="sm"
                        isLoading={isHostActing}
                        disabled={
                          auction.auctionStage === 'PLAYER_SOLD' ||
                          auction.auctionStage === 'PLAYER_UNSOLD' ||
                          auction.auctionStage === 'BIDDING_CLOSED'
                        }
                        onClick={() => handleHostAction('pause')}
                        leftIcon={<Pause className="w-4 h-4" />}
                        data-testid="host-pause-btn"
                      >
                        Pause
                      </Button>
                    )}

                    <Button
                      variant="surface"
                      size="sm"
                      isLoading={isHostActing}
                      disabled={
                        !currentLot ||
                        (currentLot.status !== LotStatus.ACTIVE &&
                          currentLot.status !== LotStatus.BIDDING_CLOSED)
                      }
                      onClick={() => handleHostAction('extend-timer', { extraSeconds: 10 })}
                      leftIcon={<Plus className="w-4 h-4" />}
                      data-testid="host-extend-btn"
                    >
                      +10s Timer
                    </Button>

                    <Button
                      variant="gold"
                      size="sm"
                      isLoading={isHostActing}
                      disabled={
                        !currentLot ||
                        !currentLot.winningFranchiseId ||
                        (currentLot.status !== LotStatus.ACTIVE &&
                          currentLot.status !== LotStatus.BIDDING_CLOSED)
                      }
                      onClick={() => currentLot && handleHostAction('sold', { lotId: currentLot.id })}
                      leftIcon={<CheckCircle2 className="w-4 h-4" />}
                      data-testid="host-sold-btn"
                    >
                      Confirm SOLD
                    </Button>

                    <Button
                      variant="danger"
                      size="sm"
                      isLoading={isHostActing}
                      disabled={
                        !currentLot ||
                        (currentLot.status !== LotStatus.ACTIVE &&
                          currentLot.status !== LotStatus.BIDDING_CLOSED)
                      }
                      onClick={() => currentLot && handleHostAction('unsold', { lotId: currentLot.id })}
                      leftIcon={<XCircle className="w-4 h-4" />}
                      data-testid="host-unsold-btn"
                    >
                      Mark UNSOLD
                    </Button>

                    <Button
                      variant="electric"
                      size="sm"
                      isLoading={isHostActing}
                      disabled={
                        auction.auctionStage !== 'PLAYER_SOLD' &&
                        auction.auctionStage !== 'PLAYER_UNSOLD'
                      }
                      onClick={() => handleHostAction('next')}
                      leftIcon={<FastForward className="w-4 h-4" />}
                      data-testid="host-next-btn"
                    >
                      Next Player
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      isLoading={isHostActing}
                      disabled={
                        !currentLot ||
                        (currentLot.status !== LotStatus.ACTIVE &&
                          currentLot.status !== LotStatus.BIDDING_CLOSED)
                      }
                      onClick={() => handleHostAction('skip')}
                      leftIcon={<SkipForward className="w-4 h-4" />}
                      data-testid="host-skip-btn"
                    >
                      Skip Lot
                    </Button>

                    {auction.unsoldCount > 0 && (
                      <Button
                        variant="surface"
                        size="sm"
                        isLoading={isHostActing}
                        disabled={
                          auction.auctionStage === 'LIVE' ||
                          auction.auctionStage === 'BIDDING_CLOSED' ||
                          auction.auctionStage === 'PAUSED'
                        }
                        onClick={() => handleHostAction('requeue-unsold', {})}
                        leftIcon={<RotateCcw className="w-4 h-4 text-gold-400" />}
                        data-testid="host-requeue-unsold-btn"
                      >
                        Re-Enter Unsold ({auction.unsoldCount})
                      </Button>
                    )}
                  </div>
                </Card>
              )}
            </section>

            {/* RIGHT COLUMN: Tabbed Queue / Full Bid History / Filterable Results / Live Activity Feed */}
            <aside className="xl:col-span-3 space-y-4 order-3">
              <Card className="p-4 space-y-3">
                <div className="grid grid-cols-4 gap-1 rounded-xl bg-stadium-bg p-1 border border-stadium-border">
                  {(
                    [
                      { key: 'QUEUE', label: 'Queue' },
                      { key: 'BIDS', label: 'Bids' },
                      { key: 'RESULTS', label: 'Results' },
                      { key: 'FEED', label: 'Feed' }
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => setSideTab(t.key)}
                      data-testid={`side-tab-${t.key.toLowerCase()}`}
                      className={`py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-colors ${
                        sideTab === t.key
                          ? 'bg-gold-500 text-stadium-canvas shadow'
                          : 'text-stadium-muted hover:text-white'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {sideTab === 'QUEUE' && (
                  <div className="space-y-3" data-testid="side-panel-queue">
                    <div className="flex items-center justify-between border-b border-stadium-border pb-2">
                      <div className="flex items-center gap-2">
                        <Clock className="w-4 h-4 text-electric-400" />
                        <h2 className="font-display text-lg font-bold text-white tracking-wide">
                          UP NEXT
                        </h2>
                      </div>
                      <span className="text-[11px] font-mono text-stadium-muted">
                        Round {auction.currentRound} • {auction.upNextLots.length} queued
                      </span>
                    </div>

                    {auction.upNextLots.length === 0 ? (
                      <p className="text-xs text-stadium-muted py-4 text-center">No further lots queued right now.</p>
                    ) : (
                      <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
                        {auction.upNextLots.map((lot) => (
                          <button
                            key={lot.id}
                            type="button"
                            onClick={() => setInspectedPlayerId(lot.playerId)}
                            className="w-full text-left rounded-xl border border-stadium-border bg-stadium-card/65 hover:border-gold-500/40 px-3 py-2 flex items-center justify-between gap-2 transition-colors"
                          >
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-white truncate">
                                #{lot.sequenceOrder} {lot.fullName}
                              </p>
                              <p className="text-[10px] text-stadium-muted">
                                {ROLE_LABEL[lot.playingRole]} • {lot.setCategory}
                                {lot.roundNumber > 1 ? ` • R${lot.roundNumber}` : ''}
                              </p>
                            </div>
                            <span className="font-mono text-[11px] font-bold text-gold-300 shrink-0">
                              {formatLakhs(lot.basePriceLakhs)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {sideTab === 'BIDS' && (
                  <div className="space-y-3" data-testid="side-panel-bids">
                    <div className="flex items-center justify-between border-b border-stadium-border pb-2">
                      <div className="flex items-center gap-2">
                        <History className="w-4 h-4 text-gold-400" />
                        <h2 className="font-display text-lg font-bold text-white tracking-wide">
                          COMPLETE BID HISTORY
                        </h2>
                      </div>
                      <span className="text-[11px] font-mono text-stadium-muted">
                        {auction.allBids.length} bids
                      </span>
                    </div>

                    {auction.allBids.length === 0 ? (
                      <p className="text-xs text-stadium-muted py-4 text-center">No bids placed yet in this room.</p>
                    ) : (
                      <div className="space-y-2 max-h-[520px] overflow-y-auto pr-1">
                        {auction.allBids.map((b) => (
                          <div
                            key={b.id}
                            className="rounded-xl border border-stadium-border bg-stadium-card/65 px-3 py-2 flex items-center justify-between gap-2 text-xs"
                          >
                            <div className="min-w-0">
                              <p className="font-semibold text-white truncate">
                                {b.playerName || 'Player Lot'}
                              </p>
                              <p className="text-[10px] text-stadium-muted">
                                <strong style={{ color: b.franchiseColor || '#D4AF37' }}>
                                  {b.franchiseCode}
                                </strong>{' '}
                                • {b.bidderDisplayName} • R{b.roundNumber || 1} #{b.sequenceNumber}
                              </p>
                            </div>
                            <span className="font-mono font-bold text-gold-300 shrink-0">
                              {formatLakhs(b.bidAmountLakhs)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {sideTab === 'RESULTS' && (
                  <div className="space-y-3" data-testid="side-panel-results">
                    <div className="flex items-center justify-between border-b border-stadium-border pb-2">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-gold-400" />
                        <h2 className="font-display text-lg font-bold text-white tracking-wide">
                          AUCTION RESULTS
                        </h2>
                      </div>
                      <span className="text-[11px] font-mono text-stadium-muted">
                        {auction.recentResults.length} settled
                      </span>
                    </div>

                    <div className="space-y-2">
                      <input
                        type="text"
                        value={resultsSearch}
                        onChange={(e) => setResultsSearch(e.target.value)}
                        placeholder="Search player name..."
                        className="w-full rounded-lg bg-stadium-bg border border-stadium-border px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-gold-400"
                      />
                      <div className="flex gap-1.5">
                        {(['ALL', 'SOLD', 'UNSOLD'] as const).map((f) => (
                          <button
                            key={f}
                            type="button"
                            onClick={() => setResultsFilter(f)}
                            className={`flex-1 py-1 rounded-lg text-[10px] font-bold uppercase border ${
                              resultsFilter === f
                                ? 'bg-gold-500/20 border-gold-400 text-gold-300'
                                : 'bg-stadium-card border-stadium-border text-stadium-muted'
                            }`}
                          >
                            {f}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-2 max-h-[430px] overflow-y-auto pr-1">
                      {auction.recentResults
                        .filter((r) => resultsFilter === 'ALL' || r.status === resultsFilter)
                        .filter((r) =>
                          !resultsSearch.trim()
                            ? true
                            : r.playerName.toLowerCase().includes(resultsSearch.trim().toLowerCase())
                        )
                        .map((res) => (
                          <button
                            key={res.lotId}
                            type="button"
                            onClick={() => setInspectedPlayerId(res.playerId)}
                            className="w-full text-left rounded-xl border border-stadium-border bg-stadium-card/65 hover:border-gold-500/40 px-3 py-2 flex items-center justify-between gap-2 transition-colors"
                          >
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-white truncate">{res.playerName}</p>
                              <p className="text-[10px] text-stadium-muted">
                                {res.status === LotStatus.SOLD
                                  ? `${res.franchiseCode} • ${formatLakhs(res.soldPriceLakhs || 0)}`
                                  : 'Passed Unsold'}
                              </p>
                            </div>
                            <Badge tone={res.status === LotStatus.SOLD ? 'sold' : 'unsold'}>
                              {res.status}
                            </Badge>
                          </button>
                        ))}
                    </div>
                  </div>
                )}

                {sideTab === 'FEED' && (
                  <div className="space-y-3" data-testid="side-panel-feed">
                    <div className="flex items-center gap-2 border-b border-stadium-border pb-2">
                      <Users className="w-4 h-4 text-electric-400" />
                      <h2 className="font-display text-lg font-bold text-white tracking-wide">
                        AUCTION FEED
                      </h2>
                    </div>
                    <div className="space-y-1.5 max-h-[520px] overflow-y-auto pr-1">
                      {feed.length === 0 ? (
                        <p className="text-xs text-stadium-muted py-1">Connected to live floor updates.</p>
                      ) : (
                        feed.map((item) => (
                          <div
                            key={item.id}
                            className="text-[11px] leading-snug rounded-lg bg-stadium-card/50 border border-stadium-border/70 px-2.5 py-1.5 flex items-start justify-between gap-2"
                          >
                            <span
                              className={
                                item.tone === 'sold'
                                  ? 'text-signal-sold'
                                  : item.tone === 'unsold'
                                  ? 'text-signal-unsold'
                                  : item.tone === 'gold'
                                  ? 'text-gold-300'
                                  : 'text-white'
                              }
                            >
                              {item.text}
                            </span>
                            <span className="font-mono text-[10px] text-stadium-muted shrink-0">
                              {item.timestamp}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </Card>
            </aside>
          </div>
        )}
      </div>

      {/* Squad Inspector Modal */}
      <Modal
        open={Boolean(inspectedFranchise)}
        onClose={() => {
          setInspectedFranchiseId(null);
          setSquadTab('ROSTER');
        }}
        title={inspectedFranchise ? `${inspectedFranchise.name} (${inspectedFranchise.presetCode})` : ''}
        subtitle={
          inspectedFranchise
            ? `Remaining Purse: ${formatLakhs(inspectedFranchise.remainingPurseLakhs)} • Squad ${inspectedFranchise.squadCount}/${auction.settings.maxSquadSize} • Overseas ${inspectedFranchise.overseasCount}/${auction.settings.maxOverseas}`
            : undefined
        }
      >
        {inspectedFranchise && (
          <div className="space-y-3.5 max-h-[65vh] overflow-y-auto pr-1" data-testid="squad-inspector-modal">
            <div className="flex flex-wrap items-center gap-2 border-b border-stadium-border pb-2.5">
              <button
                type="button"
                data-testid="tab-squad-roster"
                onClick={() => setSquadTab('ROSTER')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                  squadTab === 'ROSTER'
                    ? 'bg-gold-500 text-stadium-bg'
                    : 'bg-stadium-card text-stadium-muted hover:text-white border border-stadium-border'
                }`}
              >
                Roster ({inspectedFranchise.squad.length})
              </button>
              {isOwnInspectedFranchise && (
                <>
                  <button
                    type="button"
                    data-testid="tab-squad-strength"
                    onClick={() => setSquadTab('STRENGTH')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      squadTab === 'STRENGTH'
                        ? 'bg-electric-500 text-white'
                        : 'bg-stadium-card text-stadium-muted hover:text-white border border-stadium-border'
                    }`}
                  >
                    Team Strength
                  </button>
                  <button
                    type="button"
                    data-testid="tab-playing-xi"
                    onClick={() => setSquadTab('PLAYING_XI')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                      squadTab === 'PLAYING_XI'
                        ? 'bg-electric-500 text-white'
                        : 'bg-stadium-card text-stadium-muted hover:text-white border border-stadium-border'
                    }`}
                  >
                    Playing XI + Impact
                  </button>
                </>
              )}
            </div>

            {isOwnInspectedFranchise && squadTab === 'STRENGTH' ? (
              <SquadIntelligencePanel
                roomCode={roomCode}
                franchiseId={inspectedFranchise.id}
                mode="STRENGTH"
              />
            ) : isOwnInspectedFranchise && squadTab === 'PLAYING_XI' ? (
              <SquadIntelligencePanel
                roomCode={roomCode}
                franchiseId={inspectedFranchise.id}
                mode="PLAYING_XI"
              />
            ) : inspectedFranchise.squad.length === 0 ? (
              <p className="text-sm text-stadium-muted py-4 text-center">
                No retained or purchased players yet.
              </p>
            ) : (
              inspectedFranchise.squad.map((member) => (
                <button
                  key={`${member.playerId}-${member.acquisitionType}`}
                  type="button"
                  onClick={() => setInspectedPlayerId(member.playerId)}
                  className="w-full text-left rounded-xl border border-stadium-border bg-stadium-card/70 hover:border-gold-500/45 px-3.5 py-2.5 flex items-center justify-between gap-3 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-white truncate">{member.fullName}</p>
                      {member.isOverseas && <Badge tone="electric">OS</Badge>}
                      <Badge tone={member.acquisitionType === 'RETAINED' ? 'gold' : 'sold'}>
                        {member.acquisitionType}
                      </Badge>
                    </div>
                    <p className="text-[11px] text-stadium-muted mt-0.5">
                      {ROLE_LABEL[member.playingRole]} • {member.nationality || 'Unknown'}
                    </p>
                  </div>
                  <span className="font-mono text-sm font-bold text-gold-300 shrink-0">
                    {formatLakhs(member.priceLakhs)}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </Modal>

      <PlayerProfileModal
        playerId={inspectedPlayerId}
        onClose={() => setInspectedPlayerId(null)}
        intelligenceRoomCode={roomCode}
        canViewIntelligence={isActiveOwner}
      />
    </main>
  );
}
