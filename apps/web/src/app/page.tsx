'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  AUCTION_MODE_PRESETS,
  AuctionMode,
  IPL_FRANCHISE_PRESETS,
  PublicRoomSummaryDto,
  ROOM_DEFAULTS,
  RoomVisibility
} from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { useSessionStore } from '@/stores/sessionStore';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { FranchiseEmblem } from '@/components/ui/FranchiseEmblem';
import {
  Crown,
  Flame,
  Globe,
  Lock,
  Radio,
  Settings2,
  Shield,
  Sparkles,
  Timer,
  Users,
  Wallet,
  ArrowRight
} from 'lucide-react';

export default function AuctionCrazeHomePage() {
  const router = useRouter();
  const { session, hydrate, ensureSession, clearSession } = useSessionStore();

  const [displayName, setDisplayName] = useState('');
  const [roomName, setRoomName] = useState('IPL Mega Auction Night');
  const [selectedFranchise, setSelectedFranchise] = useState('CSK');
  const [visibility, setVisibility] = useState<RoomVisibility>(RoomVisibility.PUBLIC);
  const [auctionMode, setAuctionMode] = useState<AuctionMode>(AuctionMode.MEGA);

  // Configurable auction settings
  const [purseCrores, setPurseCrores] = useState(ROOM_DEFAULTS.INITIAL_PURSE_LAKHS / 100);
  const [minSquadSize, setMinSquadSize] = useState<number>(ROOM_DEFAULTS.MIN_SQUAD_SIZE);
  const [maxSquadSize, setMaxSquadSize] = useState<number>(ROOM_DEFAULTS.MAX_SQUAD_SIZE);
  const [maxOverseas, setMaxOverseas] = useState<number>(ROOM_DEFAULTS.MAX_OVERSEAS);
  const [countdownSeconds, setCountdownSeconds] = useState<number>(ROOM_DEFAULTS.COUNTDOWN_SECONDS);
  const [bidExtensionSeconds, setBidExtensionSeconds] = useState<number>(
    ROOM_DEFAULTS.BID_EXTENSION_SECONDS
  );
  const [allowHostSkip, setAllowHostSkip] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [joinCode, setJoinCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (session?.displayName && !displayName) {
      setDisplayName(session.displayName);
    }
  }, [session?.displayName, displayName]);

  const {
    data: publicRooms = [],
    isLoading: isLoadingRooms,
    refetch: refetchPublicRooms
  } = useQuery({
    queryKey: ['public-rooms'],
    queryFn: async () => {
      const res: any = await api.get('/rooms/public');
      return (res.data || []) as PublicRoomSummaryDto[];
    },
    refetchInterval: 15_000
  });

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedName = displayName.trim();
    if (trimmedName.length < 2) {
      setFormError('Enter a display name (at least 2 characters) to host a room.');
      return;
    }

    setIsCreating(true);
    try {
      await ensureSession(trimmedName);

      const res: any = await api.post('/rooms', {
        roomName: roomName.trim(),
        displayName: trimmedName,
        franchiseCode: selectedFranchise,
        visibility,
        auctionMode,
        settings: {
          initialPurseLakhs: Math.round(Number(purseCrores) * 100),
          minSquadSize: Number(minSquadSize),
          maxSquadSize: Number(maxSquadSize),
          maxOverseas: Number(maxOverseas),
          countdownSeconds: Number(countdownSeconds),
          bidExtensionSeconds: Number(bidExtensionSeconds),
          extensionThresholdSeconds: Math.min(5, Number(countdownSeconds)),
          allowHostSkip
        }
      });

      const createdCode = res.data.code as string;
      await refetchPublicRooms();
      router.push(`/room/${createdCode}`);
    } catch (err: any) {
      setFormError(err.message || 'Unable to create room.');
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinByCode = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = joinCode.trim().toUpperCase();
    if (!cleaned) return;
    router.push(`/room/${cleaned}`);
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top Broadcast Bar */}
      <header className="border-b border-stadium-border bg-stadium-surface/80 backdrop-blur-xl sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-gold-400 via-gold-500 to-gold-600 flex items-center justify-center text-stadium-canvas font-display font-extrabold text-xl shadow-gold-glow">
              AC
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display text-2xl font-extrabold tracking-wide text-stadium-text">
                  AUCTION<span className="text-gold-400">CRAZE</span>
                </span>
                <Badge tone="electric">MULTIPLAYER</Badge>
              </div>
              <p className="text-[11px] text-stadium-muted -mt-0.5 hidden sm:block">
                Real-Time IPL Franchise Auction Arena
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Link href="/seasons">
              <Button variant="electric" size="sm" data-testid="nav-seasons-btn">
                Seasons &amp; Leaderboard
              </Button>
            </Link>
            <Link href="/players">
              <Button variant="surface" size="sm" data-testid="nav-player-catalog-btn">
                Player Archive
              </Button>
            </Link>
            {session ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-stadium-card border border-gold-500/35 text-xs">
                <span className="w-2 h-2 rounded-full bg-signal-sold animate-pulse" />
                <span className="text-stadium-muted">Playing as</span>
                <span className="font-bold text-gold-300">{session.displayName}</span>
                <button
                  type="button"
                  onClick={() => {
                    clearSession();
                    setDisplayName('');
                  }}
                  className="ml-1 text-[10px] uppercase tracking-wider text-electric-400 hover:text-electric-300 font-semibold"
                >
                  Switch
                </button>
              </div>
            ) : (
              <Badge tone="neutral">Guest Mode Ready</Badge>
            )}
          </div>
        </div>
      </header>

      {/* Main Arena Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8 space-y-8">
        {/* Hero Strip */}
        <section className="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div className="space-y-2 max-w-2xl">
            <div className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-gold-400">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Instant Multiplayer Cricket Auction</span>
            </div>
            <h1 className="font-display text-4xl sm:text-5xl font-extrabold tracking-tight text-white leading-none">
              CLAIM YOUR FRANCHISE.{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-gold-300 via-gold-400 to-electric-400">
                COMMAND THE GAVEL.
              </span>
            </h1>
            <p className="text-sm sm:text-base text-stadium-muted">
              No mandatory sign-up. Host a private or public auction room, pick your IPL franchise,
              invite friends with a room code, and battle live with synchronized server timers.
            </p>
          </div>
        </section>

        {/* Two-Column Hub: Create Room (Left) + Join & Public Rooms (Right) */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Create Room Panel */}
          <Card highlight="gold" className="lg:col-span-7 p-6 space-y-6">
            <div className="flex items-center justify-between border-b border-stadium-border pb-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-gold-500/15 text-gold-400 border border-gold-500/30">
                  <Crown className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-display text-2xl font-bold tracking-wide text-white">
                    CREATE AUCTION ROOM
                  </h2>
                  <p className="text-xs text-stadium-muted">
                    You become Room Host and play on equal footing with your chosen franchise.
                  </p>
                </div>
              </div>
            </div>

            <form onSubmit={handleCreateRoom} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label="Your Display Name"
                  placeholder="e.g. CaptainVikram"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                  maxLength={28}
                />
                <Input
                  label="Room Name"
                  placeholder="e.g. Weekend IPL Mega Auction"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  required
                  maxLength={50}
                />
              </div>

              {/* Auction Mode */}
              <div className="space-y-2">
                <span className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                  Auction Mode
                </span>
                <div className="grid grid-cols-3 gap-2.5">
                  {([AuctionMode.MOCK, AuctionMode.MEGA, AuctionMode.CUSTOM] as const).map((mode) => {
                    const preset = AUCTION_MODE_PRESETS[mode];
                    const active = auctionMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => {
                          setAuctionMode(mode);
                          setPurseCrores(preset.initialPurseLakhs / 100);
                          setMinSquadSize(preset.minSquadSize);
                          setMaxSquadSize(preset.maxSquadSize);
                          setMaxOverseas(preset.maxOverseas);
                          setCountdownSeconds(preset.countdownSeconds);
                          setBidExtensionSeconds(preset.bidExtensionSeconds);
                        }}
                        className={`p-2.5 rounded-xl border text-left transition-all ${
                          active
                            ? 'bg-gold-500/15 border-gold-400 text-white'
                            : 'bg-stadium-card/70 border-stadium-border text-stadium-muted hover:border-white/25'
                        }`}
                      >
                        <div className="text-xs font-bold text-white">{preset.label}</div>
                        <div className="text-[10px] opacity-75">
                          {(preset.initialPurseLakhs / 100).toFixed(0)}Cr · {preset.countdownSeconds}s
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Room Visibility */}
              <div className="space-y-2">
                <span className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                  Room Visibility
                </span>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setVisibility(RoomVisibility.PUBLIC)}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                      visibility === RoomVisibility.PUBLIC
                        ? 'bg-electric-500/15 border-electric-400/60 text-white'
                        : 'bg-stadium-card/70 border-stadium-border text-stadium-muted hover:border-white/25'
                    }`}
                  >
                    <Globe className="w-4 h-4 text-electric-400 shrink-0" />
                    <div>
                      <div className="text-sm font-bold">Public Room</div>
                      <div className="text-[11px] opacity-75">Listed in public rooms browser</div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setVisibility(RoomVisibility.PRIVATE)}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                      visibility === RoomVisibility.PRIVATE
                        ? 'bg-gold-500/15 border-gold-400/60 text-white'
                        : 'bg-stadium-card/70 border-stadium-border text-stadium-muted hover:border-white/25'
                    }`}
                  >
                    <Lock className="w-4 h-4 text-gold-400 shrink-0" />
                    <div>
                      <div className="text-sm font-bold">Private Room</div>
                      <div className="text-[11px] opacity-75">Join only via Room Code / link</div>
                    </div>
                  </button>
                </div>
              </div>

              {/* IPL Franchise Picker */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                    Select Your Franchise
                  </span>
                  <span className="text-xs font-mono text-gold-300">
                    Selected: {selectedFranchise}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                  {IPL_FRANCHISE_PRESETS.map((franchise) => {
                    const active = selectedFranchise === franchise.code;
                    return (
                      <button
                        key={franchise.code}
                        type="button"
                        onClick={() => setSelectedFranchise(franchise.code)}
                        className={`p-2.5 rounded-xl border text-left transition-all flex flex-col items-center gap-1.5 ${
                          active
                            ? 'bg-stadium-elevated border-gold-400 shadow-gold-glow scale-[1.02]'
                            : 'bg-stadium-card/60 border-stadium-border hover:border-white/25'
                        }`}
                      >
                        <FranchiseEmblem
                          code={franchise.shortName}
                          primaryColor={franchise.primaryColor}
                          secondaryColor={franchise.secondaryColor}
                          size="sm"
                        />
                        <span className="text-[11px] font-bold text-center leading-tight text-white line-clamp-1">
                          {franchise.shortName}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Auction Settings Accordion */}
              <div className="rounded-xl border border-stadium-border bg-stadium-card/50 p-4 space-y-4">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="w-full flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-2 text-sm font-bold text-white">
                    <Settings2 className="w-4 h-4 text-gold-400" />
                    <span>Auction Rules & Timer Settings</span>
                  </div>
                  <span className="text-xs font-mono text-stadium-muted">
                    {purseCrores} Cr · {minSquadSize}-{maxSquadSize} Squad · {countdownSeconds}s
                  </span>
                </button>

                {showAdvanced && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-stadium-border">
                    <Input
                      label="Purse (Crores)"
                      type="number"
                      min={10}
                      max={500}
                      value={purseCrores}
                      onChange={(e) => setPurseCrores(Number(e.target.value))}
                    />
                    <Input
                      label="Min Squad"
                      type="number"
                      min={1}
                      max={25}
                      value={minSquadSize}
                      onChange={(e) => setMinSquadSize(Number(e.target.value))}
                    />
                    <Input
                      label="Max Squad"
                      type="number"
                      min={1}
                      max={30}
                      value={maxSquadSize}
                      onChange={(e) => setMaxSquadSize(Number(e.target.value))}
                    />
                    <Input
                      label="Max Overseas"
                      type="number"
                      min={0}
                      max={15}
                      value={maxOverseas}
                      onChange={(e) => setMaxOverseas(Number(e.target.value))}
                    />
                    <Input
                      label="Timer (Seconds)"
                      type="number"
                      min={5}
                      max={120}
                      value={countdownSeconds}
                      onChange={(e) => setCountdownSeconds(Number(e.target.value))}
                    />
                    <Input
                      label="Bid Reset (Sec)"
                      type="number"
                      min={0}
                      max={60}
                      value={bidExtensionSeconds}
                      onChange={(e) => setBidExtensionSeconds(Number(e.target.value))}
                    />
                    <label className="col-span-2 sm:col-span-3 flex items-center gap-2.5 text-xs text-stadium-muted cursor-pointer pt-1">
                      <input
                        type="checkbox"
                        checked={allowHostSkip}
                        onChange={(e) => setAllowHostSkip(e.target.checked)}
                        className="rounded border-stadium-border bg-stadium-card text-gold-500 focus:ring-gold-400"
                      />
                      <span>Allow Host to skip current player lot if needed</span>
                    </label>
                  </div>
                )}
              </div>

              {formError && (
                <div className="rounded-xl border border-signal-unsold/40 bg-signal-unsold/10 px-3.5 py-2.5 text-xs text-signal-unsold font-medium">
                  {formError}
                </div>
              )}

              <Button
                type="submit"
                variant="gold"
                size="lg"
                className="w-full"
                isLoading={isCreating}
                leftIcon={<Flame className="w-5 h-5" />}
              >
                Create Room & Enter Lobby
              </Button>
            </form>
          </Card>

          {/* Right Column: Join by Code + Public Room Browser */}
          <div className="lg:col-span-5 space-y-6">
            {/* Join by Code */}
            <Card highlight="electric" className="p-6 space-y-4">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-electric-500/15 text-electric-400 border border-electric-400/30">
                  <Shield className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="font-display text-2xl font-bold tracking-wide text-white">
                    JOIN WITH ROOM CODE
                  </h2>
                  <p className="text-xs text-stadium-muted">
                    Enter an invite code from your host to preview or enter a room.
                  </p>
                </div>
              </div>

              <form onSubmit={handleJoinByCode} className="flex gap-2.5">
                <input
                  type="text"
                  placeholder="AC-7X9K2M"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  className="flex-1 rounded-xl bg-stadium-card border border-stadium-border px-3.5 py-2.5 font-mono text-sm uppercase tracking-widest text-white placeholder:text-stadium-muted/40 focus:outline-none focus:border-electric-400"
                />
                <Button type="submit" variant="electric" right-icon="true">
                  Open <ArrowRight className="w-4 h-4" />
                </Button>
              </form>
            </Card>

            {/* Public Rooms Directory */}
            <Card className="p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Radio className="w-4 h-4 text-signal-sold animate-pulse" />
                  <h2 className="font-display text-xl font-bold tracking-wide text-white">
                    PUBLIC AUCTION ROOMS
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => refetchPublicRooms()}
                  className="text-xs font-semibold text-electric-400 hover:text-electric-300"
                >
                  Refresh
                </button>
              </div>

              {isLoadingRooms ? (
                <div className="py-8 text-center text-xs text-stadium-muted">
                  Loading public rooms...
                </div>
              ) : publicRooms.length === 0 ? (
                <div className="rounded-xl border border-dashed border-stadium-border p-6 text-center space-y-1">
                  <p className="text-sm font-semibold text-white">No public rooms active right now</p>
                  <p className="text-xs text-stadium-muted">
                    Create a public room on the left to start an open IPL auction.
                  </p>
                </div>
              ) : (
                <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                  {publicRooms.map((room) => (
                    <div
                      key={room.id}
                      onClick={() => router.push(`/room/${room.code}`)}
                      className="cursor-pointer rounded-xl bg-stadium-card/80 border border-stadium-border hover:border-gold-500/45 p-3.5 transition-all space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-bold text-sm text-white">{room.name}</h3>
                          <p className="text-xs text-stadium-muted">
                            Hosted by <span className="text-gold-300 font-semibold">{room.hostDisplayName}</span>
                          </p>
                        </div>
                        <Badge tone={room.status === 'LIVE' ? 'sold' : 'gold'}>
                          {room.status}
                        </Badge>
                      </div>

                      <div className="flex items-center justify-between text-[11px] font-mono text-stadium-muted pt-1 border-t border-stadium-border/60">
                        <span className="text-gold-300 font-bold">{room.code}</span>
                        <span className="inline-flex items-center gap-1">
                          <Users className="w-3 h-3" /> {room.occupiedFranchises}/{room.totalFranchises}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Wallet className="w-3 h-3" /> {(room.initialPurseLakhs / 100).toFixed(0)}Cr
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Timer className="w-3 h-3" /> {room.countdownSeconds}s
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
