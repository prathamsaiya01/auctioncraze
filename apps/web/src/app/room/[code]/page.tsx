'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  RoomDetailDto,
  RoomRole,
  RoomStatus,
  RoomVisibility,
  SOCKET_EVENTS
} from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { disconnectRoomSocket, getRoomSocket } from '@/lib/socket';
import { useSessionStore } from '@/stores/sessionStore';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { FranchiseEmblem } from '@/components/ui/FranchiseEmblem';
import { Modal } from '@/components/ui/Modal';
import { AuctionConfigPanel } from '@/components/room/AuctionConfigPanel';
import { FranchiseNicknameEditor } from '@/components/room/FranchiseNicknameEditor';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  Crown,
  Eye,
  Gavel,
  Globe,
  KeyRound,
  Lock,
  LogOut,
  Play,
  Radio,
  Settings2,
  Share2,
  ShieldAlert,
  Timer,
  UserMinus,
  Users,
  Wallet,
  Wifi,
  WifiOff
} from 'lucide-react';

type SocketStatus = 'CONNECTED' | 'RECONNECTING' | 'SYNCHRONIZING' | 'DISCONNECTED';

interface ActivityEntry {
  id: string;
  text: string;
  timestamp: string;
  tone: 'gold' | 'electric' | 'sold' | 'unsold';
}

export default function RoomLobbyPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const roomCode = String(params?.code || '').toUpperCase();
  const inviteFromUrl = searchParams.get('invite') || '';

  const { session, token, isHydrated, hydrate, ensureSession } = useSessionStore();

  const [room, setRoom] = useState<RoomDetailDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requiresInviteToken, setRequiresInviteToken] = useState(false);
  const [inviteTokenInput, setInviteTokenInput] = useState(inviteFromUrl);

  // Join panel state (for visitors)
  const [joinDisplayName, setJoinDisplayName] = useState('');
  const [joinAs, setJoinAs] = useState<RoomRole.OWNER | RoomRole.SPECTATOR>(RoomRole.OWNER);
  const [selectedFranchiseCode, setSelectedFranchiseCode] = useState<string>('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);

  // Real-time Socket.IO state
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('DISCONNECTED');
  const [activityFeed, setActivityFeed] = useState<ActivityEntry[]>([]);
  const [kickedMessage, setKickedMessage] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  // Host modals
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [editPurseCr, setEditPurseCr] = useState(100);
  const [editMinSquad, setEditMinSquad] = useState(15);
  const [editMaxSquad, setEditMaxSquad] = useState(25);
  const [editMaxOverseas, setEditMaxOverseas] = useState(8);
  const [editMaxSpectators, setEditMaxSpectators] = useState(20);
  const [editCountdown, setEditCountdown] = useState(20);
  const [editBidExt, setEditBidExt] = useState(10);
  const [editAllowSkip, setEditAllowSkip] = useState(true);
  const [editVisibility, setEditVisibility] = useState<RoomVisibility>(RoomVisibility.PUBLIC);

  const [confirmAction, setConfirmAction] = useState<{
    kind: 'KICK' | 'TRANSFER';
    participantId: string;
    displayName: string;
  } | null>(null);

  const pushActivity = useCallback((text: string, tone: ActivityEntry['tone'] = 'electric') => {
    setActivityFeed((prev) => [
      {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        tone
      },
      ...prev.slice(0, 24)
    ]);
  }, []);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (session?.displayName && !joinDisplayName) {
      setJoinDisplayName(session.displayName);
    }
  }, [session?.displayName, joinDisplayName]);

  const fetchRoom = useCallback(
    async (inviteOverride?: string) => {
      if (!roomCode) return;
      setIsLoading(true);
      setLoadError(null);
      try {
        const activeInvite = (inviteOverride ?? inviteTokenInput) || inviteFromUrl;
        const query = activeInvite ? `?invite=${encodeURIComponent(activeInvite)}` : '';
        const res: any = await api.get(`/rooms/${roomCode}${query}`);
        const data = res.data as RoomDetailDto;
        setRoom(data);
        setRequiresInviteToken(false);

        const firstOpen = data.franchises.find((f) => !f.claimedByParticipantId);
        setSelectedFranchiseCode((prev) => prev || firstOpen?.presetCode || '');
      } catch (err: any) {
        const msg = err.message || 'Unable to load room';
        if (msg.toLowerCase().includes('private room') || msg.toLowerCase().includes('invite')) {
          setRequiresInviteToken(true);
        } else {
          setLoadError(msg);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [roomCode, inviteFromUrl, inviteTokenInput]
  );

  useEffect(() => {
    if (isHydrated) {
      fetchRoom();
    }
  }, [isHydrated, fetchRoom]);

  const myParticipant = useMemo(() => {
    if (!room || !session) return null;
    return room.participants.find((p) => p.guestSessionId === session.id) || null;
  }, [room, session]);

  const isHost = useMemo(() => {
    return !!myParticipant && room?.hostParticipantId === myParticipant.id;
  }, [myParticipant, room?.hostParticipantId]);

  // Connect Socket.IO once user is an active member of this room
  useEffect(() => {
    if (!room || !myParticipant || !token) {
      return;
    }

    setSocketStatus('SYNCHRONIZING');
    const socket = getRoomSocket(token);

    const requestSync = () => {
      if (!socket.connected) return;
      setSocketStatus('SYNCHRONIZING');
      socket.emit(SOCKET_EVENTS.ROOM_JOIN, { roomCode: room.code }, (ack: any) => {
        if (ack?.ok) {
          setSocketStatus('CONNECTED');
        }
      });
    };

    const onConnect = () => {
      requestSync();
    };

    const onReconnectAttempt = () => {
      setSocketStatus('RECONNECTING');
    };

    const onDisconnect = () => {
      setSocketStatus('DISCONNECTED');
    };

    const onVisibilityOrOnline = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (socket.connected) {
        setSocketStatus('SYNCHRONIZING');
        socket.emit(SOCKET_EVENTS.SYNC_REQUEST, { roomCode: room.code }, (ack: any) => {
          if (ack?.ok) setSocketStatus('CONNECTED');
        });
      } else {
        setSocketStatus('RECONNECTING');
        socket.connect();
      }
    };

    const onRoomState = (snapshot: RoomDetailDto) => {
      setRoom((prev) => (prev && snapshot.version < prev.version ? prev : snapshot));
      setSocketStatus('CONNECTED');
    };

    const onJoined = (evt: any) => {
      if (evt?.participant?.displayName) {
        pushActivity(
          `${evt.participant.displayName} joined as ${evt.participant.franchiseCode || evt.participant.role}`,
          'sold'
        );
      }
    };

    const onLeft = (evt: any) => {
      if (evt?.displayName) {
        pushActivity(`${evt.displayName} left the room`, 'unsold');
      }
    };

    const onFranchiseClaimed = (evt: any) => {
      if (evt?.displayName && evt?.franchiseCode) {
        pushActivity(`${evt.displayName} claimed ${evt.franchiseCode}`, 'gold');
      }
    };

    const onFranchiseReleased = (evt: any) => {
      if (evt?.franchiseCode) {
        pushActivity(`${evt.franchiseCode} slot is now open`, 'electric');
      }
    };

    const onReady = (evt: any) => {
      if (evt?.displayName) {
        pushActivity(`${evt.displayName} is Ready`, 'sold');
      }
    };

    const onNotReady = (evt: any) => {
      if (evt?.displayName) {
        pushActivity(`${evt.displayName} marked Not Ready`, 'electric');
      }
    };

    const onHostChanged = (evt: any) => {
      if (evt?.newHostDisplayName) {
        pushActivity(`${evt.newHostDisplayName} is now the Room Host`, 'gold');
      }
    };

    const onKicked = (evt: any) => {
      if (evt?.participantId === myParticipant.id) {
        setKickedMessage('You were removed from this room by the host.');
        disconnectRoomSocket();
        setSocketStatus('DISCONNECTED');
      } else if (evt?.displayName) {
        pushActivity(`${evt.displayName} was removed by host`, 'unsold');
      }
    };

    const onSettingsUpdated = () => {
      pushActivity('Host updated room auction settings', 'gold');
    };

    const onConfigUpdated = () => {
      pushActivity('Host updated pre-auction configuration', 'gold');
    };

    const onConfigFinalized = () => {
      pushActivity('Auction configuration finalized & locked by Host', 'sold');
    };

    const onReadinessChanged = (evt: any) => {
      if (evt?.readiness) {
        setRoom((prev) => (prev ? { ...prev, readiness: evt.readiness } : prev));
      }
    };

    const onAuctionStarted = (evt: any) => {
      const targetCode = evt?.roomCode || room?.code;
      pushActivity('Live auction started! Entering the auction floor...', 'gold');
      if (targetCode) {
        router.push(`/room/${targetCode}/auction`);
      }
    };

    const onIdentityUpdated = (evt: any) => {
      if (evt?.franchiseCode && evt?.displayName) {
        pushActivity(`${evt.franchiseCode} updated identity to ${evt.displayName}`, 'gold');
      }
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.io.on('reconnect_attempt', onReconnectAttempt);
    socket.on(SOCKET_EVENTS.ROOM_STATE, onRoomState);
    socket.on(SOCKET_EVENTS.PARTICIPANT_JOINED, onJoined);
    socket.on(SOCKET_EVENTS.PARTICIPANT_LEFT, onLeft);
    socket.on(SOCKET_EVENTS.FRANCHISE_CLAIMED, onFranchiseClaimed);
    socket.on(SOCKET_EVENTS.FRANCHISE_RELEASED, onFranchiseReleased);
    socket.on(SOCKET_EVENTS.FRANCHISE_IDENTITY_UPDATED, onIdentityUpdated);
    socket.on(SOCKET_EVENTS.PARTICIPANT_READY, onReady);
    socket.on(SOCKET_EVENTS.PARTICIPANT_NOT_READY, onNotReady);
    socket.on(SOCKET_EVENTS.HOST_CHANGED, onHostChanged);
    socket.on(SOCKET_EVENTS.PARTICIPANT_KICKED, onKicked);
    socket.on(SOCKET_EVENTS.ROOM_SETTINGS_UPDATED, onSettingsUpdated);
    socket.on(SOCKET_EVENTS.ROOM_LIVE_SETTINGS_UPDATED, onSettingsUpdated);
    socket.on(SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, onConfigUpdated);
    socket.on(SOCKET_EVENTS.AUCTION_CONFIG_FINALIZED, onConfigFinalized);
    socket.on(SOCKET_EVENTS.AUCTION_READINESS_CHANGED, onReadinessChanged);
    socket.on(SOCKET_EVENTS.AUCTION_STARTED, onAuctionStarted);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityOrOnline);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onVisibilityOrOnline);
    }

    if (socket.connected) {
      onConnect();
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.off(SOCKET_EVENTS.ROOM_STATE, onRoomState);
      socket.off(SOCKET_EVENTS.PARTICIPANT_JOINED, onJoined);
      socket.off(SOCKET_EVENTS.PARTICIPANT_LEFT, onLeft);
      socket.off(SOCKET_EVENTS.FRANCHISE_CLAIMED, onFranchiseClaimed);
      socket.off(SOCKET_EVENTS.FRANCHISE_RELEASED, onFranchiseReleased);
      socket.off(SOCKET_EVENTS.FRANCHISE_IDENTITY_UPDATED, onIdentityUpdated);
      socket.off(SOCKET_EVENTS.PARTICIPANT_READY, onReady);
      socket.off(SOCKET_EVENTS.PARTICIPANT_NOT_READY, onNotReady);
      socket.off(SOCKET_EVENTS.HOST_CHANGED, onHostChanged);
      socket.off(SOCKET_EVENTS.PARTICIPANT_KICKED, onKicked);
      socket.off(SOCKET_EVENTS.ROOM_SETTINGS_UPDATED, onSettingsUpdated);
      socket.off(SOCKET_EVENTS.ROOM_LIVE_SETTINGS_UPDATED, onSettingsUpdated);
      socket.off(SOCKET_EVENTS.AUCTION_CONFIG_UPDATED, onConfigUpdated);
      socket.off(SOCKET_EVENTS.AUCTION_CONFIG_FINALIZED, onConfigFinalized);
      socket.off(SOCKET_EVENTS.AUCTION_READINESS_CHANGED, onReadinessChanged);
      socket.off(SOCKET_EVENTS.AUCTION_STARTED, onAuctionStarted);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityOrOnline);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onVisibilityOrOnline);
      }
    };
  }, [room?.code, myParticipant?.id, token, pushActivity, router]);

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!room) return;
    setActionError(null);

    const trimmed = joinDisplayName.trim();
    if (trimmed.length < 2) {
      setActionError('Enter a display name (at least 2 characters) to join.');
      return;
    }

    if (joinAs === RoomRole.OWNER && !selectedFranchiseCode) {
      setActionError('Select an open IPL franchise or choose Spectator mode.');
      return;
    }

    setIsActing(true);
    try {
      await ensureSession(trimmed);
      const res: any = await api.post(`/rooms/${room.code}/join`, {
        displayName: trimmed,
        joinAs,
        franchiseCode: joinAs === RoomRole.OWNER ? selectedFranchiseCode : undefined,
        inviteToken: inviteTokenInput || inviteFromUrl || undefined
      });
      const joinedRoom = res.data as RoomDetailDto;
      setRoom(joinedRoom);
      if (joinedRoom.status === RoomStatus.LIVE || joinedRoom.status === RoomStatus.PAUSED) {
        router.push(`/room/${joinedRoom.code}/auction`);
      }
    } catch (err: any) {
      setActionError(err.message || 'Unable to join room.');
    } finally {
      setIsActing(false);
    }
  };

  const handleClaimFranchise = async (franchiseCode: string | null) => {
    if (!room || !myParticipant) return;
    setActionError(null);
    setIsActing(true);
    try {
      const res: any = await api.patch(`/rooms/${room.code}/franchise`, { franchiseCode });
      setRoom(res.data as RoomDetailDto);
    } catch (err: any) {
      setActionError(err.message || 'Unable to update franchise selection.');
    } finally {
      setIsActing(false);
    }
  };

  const handleToggleReady = async () => {
    if (!room || !myParticipant) return;
    setActionError(null);
    setIsActing(true);
    try {
      const res: any = await api.patch(`/rooms/${room.code}/ready`, {
        isReady: !myParticipant.isReady
      });
      setRoom(res.data as RoomDetailDto);
    } catch (err: any) {
      setActionError(err.message || 'Unable to update ready status.');
    } finally {
      setIsActing(false);
    }
  };

  const handleLeaveRoom = async () => {
    if (!room) return;
    setIsActing(true);
    try {
      await api.post(`/rooms/${room.code}/leave`);
      disconnectRoomSocket();
      router.push('/');
    } catch (err: any) {
      setActionError(err.message || 'Unable to leave room.');
    } finally {
      setIsActing(false);
    }
  };

  const handleConfirmHostAction = async () => {
    if (!room || !confirmAction) return;
    setActionError(null);
    setIsActing(true);
    try {
      if (confirmAction.kind === 'KICK') {
        const res: any = await api.post(`/rooms/${room.code}/kick`, {
          participantId: confirmAction.participantId
        });
        setRoom(res.data as RoomDetailDto);
      } else {
        const res: any = await api.post(`/rooms/${room.code}/transfer-host`, {
          targetParticipantId: confirmAction.participantId
        });
        setRoom(res.data as RoomDetailDto);
      }
      setConfirmAction(null);
    } catch (err: any) {
      setActionError(err.message || 'Host action failed.');
    } finally {
      setIsActing(false);
    }
  };

  const openSettingsModal = () => {
    if (!room) return;
    setEditPurseCr(room.settings.initialPurseLakhs / 100);
    setEditMinSquad(room.settings.minSquadSize);
    setEditMaxSquad(room.settings.maxSquadSize);
    setEditMaxOverseas(room.settings.maxOverseas);
    setEditMaxSpectators(room.settings.maxSpectators);
    setEditCountdown(room.settings.countdownSeconds);
    setEditBidExt(room.settings.bidExtensionSeconds);
    setEditAllowSkip(room.settings.allowHostSkip);
    setEditVisibility(room.visibility);
    setShowSettingsModal(true);
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!room) return;
    setActionError(null);
    setIsActing(true);
    try {
      const res: any = await api.patch(`/rooms/${room.code}/settings`, {
        visibility: editVisibility,
        settings: {
          initialPurseLakhs: Math.round(Number(editPurseCr) * 100),
          minSquadSize: Number(editMinSquad),
          maxSquadSize: Number(editMaxSquad),
          maxOverseas: Number(editMaxOverseas),
          maxSpectators: Number(editMaxSpectators),
          countdownSeconds: Number(editCountdown),
          bidExtensionSeconds: Number(editBidExt),
          extensionThresholdSeconds: Math.min(5, Number(editCountdown)),
          allowHostSkip: editAllowSkip
        }
      });
      setRoom(res.data as RoomDetailDto);
      setShowSettingsModal(false);
    } catch (err: any) {
      setActionError(err.message || 'Unable to update room settings.');
    } finally {
      setIsActing(false);
    }
  };

  const shareableUrl = useMemo(() => {
    if (typeof window === 'undefined' || !room) return '';
    const base = `${window.location.origin}/room/${room.code}`;
    if (room.visibility === RoomVisibility.PRIVATE && room.inviteToken) {
      return `${base}?invite=${room.inviteToken}`;
    }
    return base;
  }, [room]);

  const handleCopyCode = async () => {
    if (!room || typeof window === 'undefined') return;
    await navigator.clipboard.writeText(room.code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1800);
  };

  const handleCopyInviteLink = async () => {
    if (!shareableUrl || typeof window === 'undefined') return;
    await navigator.clipboard.writeText(shareableUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-gold-400 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs font-mono uppercase tracking-widest text-stadium-muted">
            Connecting to Room {roomCode}...
          </p>
        </div>
      </div>
    );
  }

  if (requiresInviteToken) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card highlight="gold" className="max-w-md w-full p-7 space-y-5">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gold-500/15 text-gold-400 border border-gold-500/35">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-display text-3xl font-bold text-white">PRIVATE ROOM LOCKED</h1>
              <p className="text-xs text-stadium-muted">
                Room <span className="font-mono text-gold-300">{roomCode}</span> requires an invite link or token.
              </p>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              fetchRoom(inviteTokenInput.trim());
            }}
            className="space-y-4"
          >
            <Input
              label="Invite Token"
              placeholder="Paste invite token from host"
              value={inviteTokenInput}
              onChange={(e) => setInviteTokenInput(e.target.value)}
              required
            />
            <div className="flex items-center justify-between gap-3">
              <Link href="/" className="text-xs text-stadium-muted hover:text-white">
                ← Back to Hub
              </Link>
              <Button type="submit" variant="gold">
                Unlock Room
              </Button>
            </div>
          </form>
        </Card>
      </div>
    );
  }

  if (kickedMessage) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8 text-center space-y-4 border-signal-unsold/40">
          <ShieldAlert className="w-10 h-10 text-signal-unsold mx-auto" />
          <h1 className="font-display text-3xl font-bold text-white">Removed from Room</h1>
          <p className="text-sm text-stadium-muted">{kickedMessage}</p>
          <Link href="/" className="inline-block">
            <Button variant="gold" leftIcon={<ArrowLeft className="w-4 h-4" />}>
              Return to Arena Hub
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  if (loadError || !room) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8 text-center space-y-4">
          <h1 className="font-display text-3xl font-bold text-white">Room Unavailable</h1>
          <p className="text-sm text-stadium-muted">
            {loadError || `No auction room found for code ${roomCode}.`}
          </p>
          <Link href="/" className="inline-block">
            <Button variant="gold" leftIcon={<ArrowLeft className="w-4 h-4" />}>
              Back to Arena Hub
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  const owners = room.participants.filter((p) => p.role !== RoomRole.SPECTATOR);
  const spectators = room.participants.filter((p) => p.role === RoomRole.SPECTATOR);
  const readyOwnersCount = owners.filter((p) => p.isReady).length;
  const openFranchises = room.franchises.filter((f) => !f.claimedByParticipantId);
  const hostParticipant = room.participants.find((p) => p.id === room.hostParticipantId);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top Broadcast Lobby Bar */}
      <header className="border-b border-stadium-border bg-stadium-surface/90 backdrop-blur-xl sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 min-h-16 py-2.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 max-w-full">
            <Link
              href="/"
              className="p-2 rounded-xl bg-stadium-card border border-stadium-border text-stadium-muted hover:text-white transition-colors shrink-0"
              title="Back to Arena Hub"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-display text-xl sm:text-2xl font-extrabold tracking-wide text-white truncate max-w-full">
                  {room.name}
                </span>
                <Badge tone={room.visibility === RoomVisibility.PUBLIC ? 'electric' : 'gold'}>
                  {room.visibility === RoomVisibility.PUBLIC ? (
                    <>
                      <Globe className="w-3 h-3" /> Public
                    </>
                  ) : (
                    <>
                      <Lock className="w-3 h-3" /> Private
                    </>
                  )}
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-[11px] text-stadium-muted">
                <span className="font-mono text-gold-300 font-bold">{room.code}</span>
                <span>•</span>
                <span>
                  {owners.length}/{room.franchises.length} Franchises · {spectators.length} Spectators
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            <Link href="/players">
              <Button variant="ghost" size="sm">
                IPL Archive
              </Button>
            </Link>
            {myParticipant && (
              <div
                data-testid="lobby-connection-pill"
                className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-stadium-card border border-stadium-border text-[11px] font-mono"
              >
                {socketStatus === 'CONNECTED' ? (
                  <>
                    <Wifi className="w-3.5 h-3.5 text-signal-sold" />
                    <span className="text-signal-sold">Connected</span>
                  </>
                ) : socketStatus === 'SYNCHRONIZING' ? (
                  <>
                    <Wifi className="w-3.5 h-3.5 text-electric-400 animate-spin" />
                    <span className="text-electric-400">Synchronizing</span>
                  </>
                ) : (
                  <>
                    <WifiOff className="w-3.5 h-3.5 text-signal-warn animate-pulse" />
                    <span className="text-signal-warn">
                      {socketStatus === 'RECONNECTING' ? 'Reconnecting' : 'Disconnected'}
                    </span>
                  </>
                )}
              </div>
            )}

            <Button
              variant="surface"
              size="sm"
              onClick={handleCopyCode}
              leftIcon={copiedCode ? <Check className="w-3.5 h-3.5 text-signal-sold" /> : <Copy className="w-3.5 h-3.5" />}
            >
              {copiedCode ? 'Copied' : room.code}
            </Button>

            {myParticipant && (
              <Button
                variant="electric"
                size="sm"
                onClick={handleCopyInviteLink}
                leftIcon={copiedLink ? <Check className="w-3.5 h-3.5" /> : <Share2 className="w-3.5 h-3.5" />}
              >
                {copiedLink ? 'Link Copied' : 'Share Invite'}
              </Button>
            )}

            {isHost && room.status === RoomStatus.LOBBY && !room.configFinalized && (
              <Button
                variant="surface"
                size="sm"
                onClick={openSettingsModal}
                leftIcon={<Settings2 className="w-3.5 h-3.5 text-gold-400" />}
              >
                Settings
              </Button>
            )}

            {myParticipant && (
              <Button
                variant="danger"
                size="sm"
                onClick={handleLeaveRoom}
                disabled={isActing}
                leftIcon={<LogOut className="w-3.5 h-3.5" />}
              >
                Leave
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Status & Rules Summary Banner */}
        <Card highlight="gold" className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="gold">{room.status === RoomStatus.LOBBY ? 'ROOM LOBBY' : room.status}</Badge>
              <span className="text-xs text-gold-300 font-semibold inline-flex items-center gap-1">
                <Crown className="w-3.5 h-3.5" />
                Host: {hostParticipant?.displayName || 'Unassigned'}
                {isHost ? ' (You)' : ''}
              </span>
              {owners.length < 2 ? (
                <span className="text-xs text-electric-400 font-medium inline-flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5 animate-pulse" />
                  Waiting for more players to claim franchises...
                </span>
              ) : (
                <span className="text-xs text-signal-sold font-medium inline-flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {readyOwnersCount}/{owners.length} Franchise Owners Ready
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs font-mono text-stadium-muted">
              <span className="inline-flex items-center gap-1.5">
                <Wallet className="w-3.5 h-3.5 text-gold-400" />
                Purse: {(room.settings.initialPurseLakhs / 100).toFixed(0)} Cr
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-electric-400" />
                Squad: {room.settings.minSquadSize}-{room.settings.maxSquadSize} (Max{' '}
                {room.settings.maxOverseas} Overseas)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Timer className="w-3.5 h-3.5 text-electric-400" />
                Timer: {room.settings.countdownSeconds}s (+{room.settings.bidExtensionSeconds}s reset)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Eye className="w-3.5 h-3.5 text-stadium-muted" />
                Spectators: {spectators.length}/{room.settings.maxSpectators}
              </span>
            </div>
          </div>

          {myParticipant && (
            <div className="flex flex-wrap items-center gap-3 shrink-0">
              {room.status !== RoomStatus.LOBBY && (
                <Button
                  variant="gold"
                  onClick={() => router.push(`/room/${room.code}/auction`)}
                  leftIcon={<Play className="w-4 h-4" />}
                  data-testid="lobby-enter-auction-btn"
                >
                  Enter Live Auction
                </Button>
              )}
              {myParticipant.role !== RoomRole.SPECTATOR && room.status === RoomStatus.LOBBY && (
                <>
                  {isHost && room.readiness.isReadyToStart && (
                    <Button
                      variant="gold"
                      onClick={async () => {
                        setActionError(null);
                        setIsActing(true);
                        try {
                          await api.post(`/rooms/${room.code}/auction/start`, {});
                          router.push(`/room/${room.code}/auction`);
                        } catch (err: any) {
                          setActionError(err?.message || 'Unable to start live auction');
                          setIsActing(false);
                        }
                      }}
                      isLoading={isActing}
                      leftIcon={<Gavel className="w-4 h-4" />}
                      data-testid="lobby-start-auction-btn"
                    >
                      Start Auction
                    </Button>
                  )}
                  <Button
                    variant={myParticipant.isReady ? 'surface' : 'gold'}
                    onClick={handleToggleReady}
                    isLoading={isActing}
                    leftIcon={<CheckCircle2 className="w-4 h-4" />}
                  >
                    {myParticipant.isReady ? 'Ready (Click to Cancel)' : 'Mark as Ready'}
                  </Button>
                  {!isHost && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleClaimFranchise(null)}
                      disabled={isActing}
                    >
                      Switch to Spectator
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
        </Card>

        {actionError && (
          <div className="rounded-xl border border-signal-unsold/45 bg-signal-unsold/10 px-4 py-3 text-xs text-signal-unsold font-medium">
            {actionError}
          </div>
        )}

        {/* Visitor Join Panel (shown only if caller has not joined yet) */}
        {!myParticipant && (
          <Card highlight="electric" className="p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-stadium-border pb-3">
              <div>
                <h2 className="font-display text-2xl font-bold text-white">JOIN THIS ROOM</h2>
                <p className="text-xs text-stadium-muted">
                  {room.status === RoomStatus.LOBBY
                    ? 'Pick an available IPL franchise below to compete, or join as a Spectator.'
                    : room.settings.allowLateJoin
                    ? 'Auction is live — claim an unclaimed franchise via late join, or join as a Spectator.'
                    : 'Auction is live and Host disabled late franchise joining. Spectators may still enter.'}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={room.status !== RoomStatus.LOBBY && !room.settings.allowLateJoin}
                  variant={joinAs === RoomRole.OWNER ? 'gold' : 'surface'}
                  onClick={() => setJoinAs(RoomRole.OWNER)}
                >
                  Franchise Owner
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={joinAs === RoomRole.SPECTATOR ? 'electric' : 'surface'}
                  onClick={() => setJoinAs(RoomRole.SPECTATOR)}
                >
                  Spectator
                </Button>
              </div>
            </div>

            <form onSubmit={handleJoinRoom} className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
              <div className="md:col-span-4">
                <Input
                  label="Your Display Name"
                  placeholder="e.g. HitmanRohit"
                  value={joinDisplayName}
                  onChange={(e) => setJoinDisplayName(e.target.value)}
                  required
                  maxLength={28}
                />
              </div>

              {joinAs === RoomRole.OWNER ? (
                <div className="md:col-span-5 space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                    Select Open Franchise
                  </label>
                  <select
                    value={selectedFranchiseCode}
                    onChange={(e) => setSelectedFranchiseCode(e.target.value)}
                    className="w-full rounded-xl bg-stadium-card border border-stadium-border px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-gold-400"
                  >
                    {openFranchises.length === 0 ? (
                      <option value="">No franchises available</option>
                    ) : (
                      openFranchises.map((f) => (
                        <option key={f.id} value={f.presetCode}>
                          {f.abbreviation} — {f.name}
                        </option>
                      ))
                    )}
                  </select>
                </div>
              ) : (
                <div className="md:col-span-5 rounded-xl bg-stadium-card/60 border border-stadium-border px-4 py-2.5 text-xs text-stadium-muted">
                  Joining as <span className="text-electric-400 font-bold">Spectator</span> — watch the
                  lobby and live auction without owning a franchise.
                </div>
              )}

              <div className="md:col-span-3">
                <Button
                  type="submit"
                  variant="gold"
                  className="w-full"
                  isLoading={isActing}
                  disabled={joinAs === RoomRole.OWNER && openFranchises.length === 0}
                >
                  {joinAs === RoomRole.OWNER ? 'Claim & Join' : 'Join as Spectator'}
                </Button>
              </div>
            </form>
          </Card>
        )}

        {/* Main 2-Column Lobby Grid: Franchises (Left 8) + Participants & Spectators (Right 4) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Franchise Selection Grid */}
          <div className="lg:col-span-8 min-w-0 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-2xl font-bold tracking-wide text-white">
                FRANCHISE SLOTS ({owners.length}/{room.franchises.length} CLAIMED)
              </h2>
              <span className="text-xs font-mono text-stadium-muted">
                {openFranchises.length} OPEN
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              {room.franchises.map((f) => {
                const owner = room.participants.find((p) => p.id === f.claimedByParticipantId);
                const isMine = !!myParticipant && owner?.id === myParticipant.id;
                const isClaimed = !!owner;
                const isOwnerHost = owner?.id === room.hostParticipantId;

                return (
                  <Card
                    key={f.id}
                    highlight={isMine ? 'gold' : isClaimed ? 'electric' : 'none'}
                    className="p-4 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <FranchiseEmblem
                        code={f.abbreviation}
                        primaryColor={f.primaryColor}
                        secondaryColor={f.secondaryColor}
                        size="md"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-bold text-white truncate">{f.displayName}</span>
                        </div>
                        {f.displayName !== f.name && (
                          <div className="text-[10px] text-stadium-muted truncate">Official: {f.name}</div>
                        )}
                        <div className="text-xs font-mono text-stadium-muted">
                          {(f.remainingPurseLakhs / 100).toFixed(0)} Cr Purse
                        </div>
                        {owner ? (
                          <div className="mt-1 space-y-1">
                            <div className="flex items-center gap-1.5 text-xs min-w-0">
                              <span
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  owner.isConnected ? 'bg-signal-sold' : 'bg-stadium-muted/50'
                                }`}
                              />
                              <span className="font-semibold text-gold-300 truncate flex items-center gap-1 min-w-0">
                                {isOwnerHost && <Crown className="w-3 h-3 shrink-0" />}
                                <span className="truncate">
                                  {owner.displayName}
                                  {isMine ? ' (You)' : ''}
                                </span>
                              </span>
                              {owner.isReady && (
                                <Badge tone="sold" className="ml-1 shrink-0">
                                  READY
                                </Badge>
                              )}
                            </div>
                            {isMine && (
                              <FranchiseNicknameEditor
                                roomCode={room.code}
                                presetCode={f.presetCode}
                                currentSuffix={f.customSuffix}
                                enabled={room.settings.allowCustomTeamName}
                                onUpdated={() => fetchRoom()}
                              />
                            )}
                          </div>
                        ) : (
                          <div className="mt-1 text-[11px] font-mono text-stadium-muted/70">
                            UNCLAIMED SLOT
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="shrink-0">
                      {!isClaimed &&
                      myParticipant &&
                      myParticipant.role !== RoomRole.SPECTATOR &&
                      room.status === RoomStatus.LOBBY ? (
                        <Button
                          variant="surface"
                          size="sm"
                          disabled={isActing}
                          onClick={() => handleClaimFranchise(f.presetCode)}
                        >
                          Switch
                        </Button>
                      ) : !isClaimed && !myParticipant ? (
                        <Button
                          variant={selectedFranchiseCode === f.presetCode ? 'gold' : 'ghost'}
                          size="sm"
                          onClick={() => {
                            setJoinAs(RoomRole.OWNER);
                            setSelectedFranchiseCode(f.presetCode);
                          }}
                        >
                          {selectedFranchiseCode === f.presetCode ? 'Selected' : 'Pick'}
                        </Button>
                      ) : !isClaimed ? (
                        <Badge tone="neutral">OPEN</Badge>
                      ) : isMine ? (
                        <Badge tone="gold">YOUR TEAM</Badge>
                      ) : (
                        <Badge tone="neutral">LOCKED</Badge>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          </div>

          {/* Participants, Spectators & Live Activity */}
          <div className="lg:col-span-4 min-w-0 space-y-5">
            {/* Participants List */}
            <Card className="p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-stadium-border pb-3">
                <h2 className="font-display text-xl font-bold text-white flex items-center gap-2">
                  <Users className="w-4 h-4 text-gold-400" />
                  PLAYERS ({owners.length})
                </h2>
                <span className="text-xs font-mono text-signal-sold">
                  {owners.filter((o) => o.isConnected).length} ONLINE
                </span>
              </div>

              <div className="space-y-2.5">
                {owners.map((p) => {
                  const pIsHost = p.id === room.hostParticipantId;
                  const pIsMe = p.id === myParticipant?.id;

                  return (
                    <div
                      key={p.id}
                      className="rounded-xl bg-stadium-card/80 border border-stadium-border px-3.5 py-2.5 flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`w-2 h-2 rounded-full shrink-0 ${
                              p.isConnected ? 'bg-signal-sold' : 'bg-stadium-muted/50'
                            }`}
                            title={p.isConnected ? 'Online' : 'Offline'}
                          />
                          <span className="text-sm font-bold text-white truncate">
                            {p.displayName}
                            {pIsMe ? ' (You)' : ''}
                          </span>
                          {pIsHost && <Badge tone="gold">HOST</Badge>}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] font-mono text-stadium-muted">
                          <span>{p.franchiseCode || 'NO TEAM'}</span>
                          <span>•</span>
                          <span className={p.isReady ? 'text-signal-sold' : 'text-stadium-muted'}>
                            {p.isReady ? 'READY' : 'WAITING'}
                          </span>
                        </div>
                      </div>

                      {isHost && !pIsHost && (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmAction({
                                kind: 'TRANSFER',
                                participantId: p.id,
                                displayName: p.displayName
                              })
                            }
                            title="Transfer Host"
                            className="p-1.5 rounded-lg bg-gold-500/15 text-gold-300 border border-gold-500/30 hover:bg-gold-500/25"
                          >
                            <Crown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmAction({
                                kind: 'KICK',
                                participantId: p.id,
                                displayName: p.displayName
                              })
                            }
                            title="Kick Participant"
                            className="p-1.5 rounded-lg bg-signal-unsold/15 text-signal-unsold border border-signal-unsold/30 hover:bg-signal-unsold/25"
                          >
                            <UserMinus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Spectators Panel */}
            <Card className="p-5 space-y-3">
              <div className="flex items-center justify-between border-b border-stadium-border pb-2.5">
                <h2 className="font-display text-xl font-bold text-white flex items-center gap-2">
                  <Eye className="w-4 h-4 text-electric-400" />
                  SPECTATORS ({spectators.length})
                </h2>
                <span className="text-[11px] font-mono text-stadium-muted">
                  MAX {room.settings.maxSpectators}
                </span>
              </div>

              {spectators.length === 0 ? (
                <p className="text-xs text-stadium-muted/80">
                  No spectators in this room yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {spectators.map((s) => (
                    <div
                      key={s.id}
                      className="rounded-xl bg-stadium-card/60 border border-stadium-border px-3 py-2 flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${
                            s.isConnected ? 'bg-electric-400' : 'bg-stadium-muted/50'
                          }`}
                        />
                        <span className="font-semibold text-white truncate">
                          {s.displayName}
                          {s.id === myParticipant?.id ? ' (You)' : ''}
                        </span>
                      </div>
                      {isHost && (
                        <button
                          type="button"
                          onClick={() =>
                            setConfirmAction({
                              kind: 'KICK',
                              participantId: s.id,
                              displayName: s.displayName
                            })
                          }
                          title="Remove Spectator"
                          className="p-1 rounded-lg text-signal-unsold hover:bg-signal-unsold/15"
                        >
                          <UserMinus className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Live Lobby Feed */}
            {myParticipant && (
              <Card className="p-5 space-y-3">
                <h2 className="font-display text-lg font-bold text-white tracking-wide">
                  LIVE LOBBY FEED
                </h2>
                {activityFeed.length === 0 ? (
                  <p className="text-xs text-stadium-muted">
                    Connected to live room channel. Waiting for lobby activity...
                  </p>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {activityFeed.map((item) => (
                      <div
                        key={item.id}
                        className="text-xs flex items-start justify-between gap-2 border-b border-stadium-border/50 pb-1.5"
                      >
                        <span className="text-stadium-text">{item.text}</span>
                        <span className="font-mono text-[10px] text-stadium-muted shrink-0">
                          {item.timestamp}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}
          </div>
        </div>

        {/* Phase 3: Pre-Auction Configuration & Readiness */}
        <AuctionConfigPanel room={room} isHost={isHost} onRoomUpdated={setRoom} />
      </main>

      {/* Host Edit Settings Modal */}
      <Modal
        open={showSettingsModal}
        onClose={() => setShowSettingsModal(false)}
        title="Room Lobby Settings"
        subtitle="Only the Host can update rules before the auction starts."
      >
        <form onSubmit={handleSaveSettings} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Purse (Crores)"
              type="number"
              min={10}
              max={500}
              value={editPurseCr}
              onChange={(e) => setEditPurseCr(Number(e.target.value))}
            />
            <Input
              label="Max Spectators"
              type="number"
              min={0}
              max={100}
              value={editMaxSpectators}
              onChange={(e) => setEditMaxSpectators(Number(e.target.value))}
            />
            <Input
              label="Min Squad"
              type="number"
              min={1}
              max={25}
              value={editMinSquad}
              onChange={(e) => setEditMinSquad(Number(e.target.value))}
            />
            <Input
              label="Max Squad"
              type="number"
              min={1}
              max={30}
              value={editMaxSquad}
              onChange={(e) => setEditMaxSquad(Number(e.target.value))}
            />
            <Input
              label="Max Overseas"
              type="number"
              min={0}
              max={15}
              value={editMaxOverseas}
              onChange={(e) => setEditMaxOverseas(Number(e.target.value))}
            />
            <Input
              label="Timer (Seconds)"
              type="number"
              min={5}
              max={120}
              value={editCountdown}
              onChange={(e) => setEditCountdown(Number(e.target.value))}
            />
            <Input
              label="Bid Reset (Sec)"
              type="number"
              min={0}
              max={60}
              value={editBidExt}
              onChange={(e) => setEditBidExt(Number(e.target.value))}
            />
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                Visibility
              </label>
              <select
                value={editVisibility}
                onChange={(e) => setEditVisibility(e.target.value as RoomVisibility)}
                className="w-full rounded-xl bg-stadium-card border border-stadium-border px-3 py-2.5 text-sm text-white"
              >
                <option value={RoomVisibility.PUBLIC}>Public</option>
                <option value={RoomVisibility.PRIVATE}>Private</option>
              </select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-stadium-muted cursor-pointer">
            <input
              type="checkbox"
              checked={editAllowSkip}
              onChange={(e) => setEditAllowSkip(e.target.checked)}
              className="rounded border-stadium-border bg-stadium-card"
            />
            <span>Allow Host to skip player lots</span>
          </label>

          <div className="flex justify-end gap-2.5 pt-2">
            <Button type="button" variant="ghost" onClick={() => setShowSettingsModal(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="gold" isLoading={isActing}>
              Save Settings
            </Button>
          </div>
        </form>
      </Modal>

      {/* Host Kick / Transfer Confirmation Modal */}
      <Modal
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title={confirmAction?.kind === 'KICK' ? 'Remove Participant' : 'Transfer Host Privileges'}
        subtitle={
          confirmAction?.kind === 'KICK'
            ? `Remove ${confirmAction.displayName} from this room and release their franchise slot?`
            : `Promote ${confirmAction?.displayName} to Room Host? You will remain a normal franchise owner.`
        }
      >
        <div className="flex justify-end gap-2.5 pt-2">
          <Button variant="ghost" onClick={() => setConfirmAction(null)}>
            Cancel
          </Button>
          <Button
            variant={confirmAction?.kind === 'KICK' ? 'danger' : 'gold'}
            isLoading={isActing}
            onClick={handleConfirmHostAction}
          >
            {confirmAction?.kind === 'KICK' ? 'Kick Participant' : 'Confirm Transfer'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
