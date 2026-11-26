'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  AUCTION_MODE_PRESETS,
  AuctionMode,
  BidTierConfig,
  CricketRole,
  MasterPlayerCatalogDto,
  RoomDetailDto,
  RoomStatus
} from '@auctioncraze/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { FranchiseEmblem } from '@/components/ui/FranchiseEmblem';
import { PlayerProfileModal } from '@/components/players/PlayerProfileModal';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleAlert,
  Eye,
  Gavel,
  Layers,
  Lock,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Sliders,
  Sparkles,
  Trash2,
  UserPlus,
  Users
} from 'lucide-react';

type ConfigTab = 'MODE' | 'BIDDING' | 'POOL' | 'RETENTION';

interface EditableLot {
  playerId: string;
  fullName: string;
  nationality: string | null;
  isOverseas: boolean;
  playingRole: CricketRole;
  setCategory: string;
  basePriceLakhs: number;
}

interface AuctionConfigPanelProps {
  room: RoomDetailDto;
  isHost: boolean;
  onRoomUpdated: (room: RoomDetailDto) => void;
}

export function AuctionConfigPanel({ room, isHost, onRoomUpdated }: AuctionConfigPanelProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ConfigTab>('MODE');
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingAuction, setIsStartingAuction] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configSuccess, setConfigSuccess] = useState<string | null>(null);
  const [inspectedPlayerId, setInspectedPlayerId] = useState<string | null>(null);

  const canEdit = isHost && !room.configFinalized && room.status === 'LOBBY';

  // Local draft state synced from authoritative room snapshot
  const [auctionMode, setAuctionMode] = useState<AuctionMode>(room.settings.auctionMode);
  const [initialPurseLakhs, setInitialPurseLakhs] = useState(room.settings.initialPurseLakhs);
  const [minSquadSize, setMinSquadSize] = useState(room.settings.minSquadSize);
  const [maxSquadSize, setMaxSquadSize] = useState(room.settings.maxSquadSize);
  const [maxOverseas, setMaxOverseas] = useState(room.settings.maxOverseas);
  const [minOwnersRequired, setMinOwnersRequired] = useState(room.settings.minOwnersRequired);
  const [allowTeamPurseAdjustments, setAllowTeamPurseAdjustments] = useState(
    room.settings.allowTeamPurseAdjustments
  );
  const [purseAdjustments, setPurseAdjustments] = useState<Record<string, number>>({});

  const [defaultBasePriceLakhs, setDefaultBasePriceLakhs] = useState(
    room.settings.defaultBasePriceLakhs
  );
  const [countdownSeconds, setCountdownSeconds] = useState(room.settings.countdownSeconds);
  const [allowLateBidExtension, setAllowLateBidExtension] = useState(
    room.settings.allowLateBidExtension
  );
  const [bidExtensionSeconds, setBidExtensionSeconds] = useState(
    room.settings.bidExtensionSeconds
  );
  const [extensionThresholdSeconds, setExtensionThresholdSeconds] = useState(
    room.settings.extensionThresholdSeconds
  );
  const [allowHostSkip, setAllowHostSkip] = useState(room.settings.allowHostSkip);
  const [bidTiers, setBidTiers] = useState<BidTierConfig[]>(room.settings.bidIncrementTiers);

  const [retentionEnabled, setRetentionEnabled] = useState(room.settings.retentionEnabled);
  const [maxRetentionsPerFranchise, setMaxRetentionsPerFranchise] = useState(
    room.settings.maxRetentionsPerFranchise
  );
  const [maxOverseasRetentions, setMaxOverseasRetentions] = useState(
    room.settings.maxOverseasRetentions
  );

  // Player Pool draft
  const [draftLots, setDraftLots] = useState<EditableLot[]>([]);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogRole, setCatalogRole] = useState<string>('ALL');
  const [catalogOrigin, setCatalogOrigin] = useState<'ALL' | 'DOMESTIC' | 'OVERSEAS'>('ALL');

  // Retention assignment form
  const [retFranchiseCode, setRetFranchiseCode] = useState(room.franchises[0]?.presetCode || 'CSK');
  const [retPlayerId, setRetPlayerId] = useState('');
  const [retCostLakhs, setRetCostLakhs] = useState(1500);

  // Sync draft whenever authoritative room version changes
  useEffect(() => {
    setAuctionMode(room.settings.auctionMode);
    setInitialPurseLakhs(room.settings.initialPurseLakhs);
    setMinSquadSize(room.settings.minSquadSize);
    setMaxSquadSize(room.settings.maxSquadSize);
    setMaxOverseas(room.settings.maxOverseas);
    setMinOwnersRequired(room.settings.minOwnersRequired);
    setAllowTeamPurseAdjustments(room.settings.allowTeamPurseAdjustments);
    setDefaultBasePriceLakhs(room.settings.defaultBasePriceLakhs);
    setCountdownSeconds(room.settings.countdownSeconds);
    setAllowLateBidExtension(room.settings.allowLateBidExtension);
    setBidExtensionSeconds(room.settings.bidExtensionSeconds);
    setExtensionThresholdSeconds(room.settings.extensionThresholdSeconds);
    setAllowHostSkip(room.settings.allowHostSkip);
    setBidTiers(room.settings.bidIncrementTiers);
    setRetentionEnabled(room.settings.retentionEnabled);
    setMaxRetentionsPerFranchise(room.settings.maxRetentionsPerFranchise);
    setMaxOverseasRetentions(room.settings.maxOverseasRetentions);

    const adjMap: Record<string, number> = {};
    room.franchises.forEach((f) => {
      adjMap[f.presetCode] = f.purseAdjustmentLakhs;
    });
    setPurseAdjustments(adjMap);

    setDraftLots(
      room.lots.map((l) => ({
        playerId: l.playerId,
        fullName: l.fullName,
        nationality: l.nationality,
        isOverseas: l.isOverseas,
        playingRole: l.playingRole,
        setCategory: l.setCategory,
        basePriceLakhs: l.basePriceLakhs
      }))
    );
  }, [room]);

  const { data: catalogPlayers = [], isLoading: isLoadingCatalog } = useQuery({
    queryKey: ['player-catalog', catalogSearch, catalogRole, catalogOrigin],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('limit', '150');
      if (catalogSearch.trim()) params.set('search', catalogSearch.trim());
      if (catalogRole !== 'ALL') params.set('role', catalogRole);
      if (catalogOrigin === 'DOMESTIC') params.set('overseas', 'false');
      if (catalogOrigin === 'OVERSEAS') params.set('overseas', 'true');
      const res: any = await api.get(`/players/catalog?${params.toString()}`);
      return (res.data || []) as MasterPlayerCatalogDto[];
    }
  });

  const retainedPlayerIds = useMemo(
    () => new Set(room.retentions.map((r) => r.playerId)),
    [room.retentions]
  );

  const poolPlayerIds = useMemo(() => new Set(draftLots.map((l) => l.playerId)), [draftLots]);

  const filteredCatalog = useMemo(() => {
    return catalogPlayers.filter((p) => {
      if (catalogRole !== 'ALL' && p.playingRole !== catalogRole) return false;
      if (catalogOrigin === 'DOMESTIC' && p.isOverseas) return false;
      if (catalogOrigin === 'OVERSEAS' && !p.isOverseas) return false;
      if (
        catalogSearch.trim() &&
        !p.fullName.toLowerCase().includes(catalogSearch.trim().toLowerCase()) &&
        !(p.nationality || '').toLowerCase().includes(catalogSearch.trim().toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [catalogPlayers, catalogRole, catalogOrigin, catalogSearch]);

  const eligibleRetentionPlayers = useMemo(
    () => catalogPlayers.filter((p) => !retainedPlayerIds.has(p.id)),
    [catalogPlayers, retainedPlayerIds]
  );

  useEffect(() => {
    if (!retPlayerId && eligibleRetentionPlayers.length > 0) {
      setRetPlayerId(eligibleRetentionPlayers[0].id);
    }
  }, [eligibleRetentionPlayers, retPlayerId]);

  const clearBanners = () => {
    setConfigError(null);
    setConfigSuccess(null);
  };

  const applyModePreset = (mode: AuctionMode) => {
    if (!canEdit) return;
    clearBanners();
    const preset = AUCTION_MODE_PRESETS[mode];
    setAuctionMode(mode);
    setInitialPurseLakhs(preset.initialPurseLakhs);
    setMinSquadSize(preset.minSquadSize);
    setMaxSquadSize(preset.maxSquadSize);
    setMaxOverseas(preset.maxOverseas);
    setMinOwnersRequired(preset.minOwnersRequired);
    setDefaultBasePriceLakhs(preset.defaultBasePriceLakhs);
    setCountdownSeconds(preset.countdownSeconds);
    setAllowLateBidExtension(preset.allowLateBidExtension);
    setBidExtensionSeconds(preset.bidExtensionSeconds);
    setExtensionThresholdSeconds(preset.extensionThresholdSeconds);
    setRetentionEnabled(preset.retentionEnabled);
    setMaxRetentionsPerFranchise(preset.maxRetentionsPerFranchise);
    setMaxOverseasRetentions(preset.maxOverseasRetentions);
    setAllowTeamPurseAdjustments(preset.allowTeamPurseAdjustments);
    setBidTiers(preset.bidIncrementTiers);
  };

  const handleSaveConfig = async () => {
    if (!canEdit) return;
    clearBanners();
    setIsSaving(true);
    try {
      const res: any = await api.patch(`/rooms/${room.code}/config`, {
        auctionMode,
        initialPurseLakhs: Number(initialPurseLakhs),
        minSquadSize: Number(minSquadSize),
        maxSquadSize: Number(maxSquadSize),
        maxOverseas: Number(maxOverseas),
        maxSpectators: room.settings.maxSpectators,
        minOwnersRequired: Number(minOwnersRequired),
        defaultBasePriceLakhs: Number(defaultBasePriceLakhs),
        bidIncrementTiers: bidTiers.map((t) => ({
          minAmount: Number(t.minAmount),
          maxAmount: Number(t.maxAmount),
          increment: Number(t.increment)
        })),
        countdownSeconds: Number(countdownSeconds),
        allowLateBidExtension,
        bidExtensionSeconds: Number(bidExtensionSeconds),
        extensionThresholdSeconds: Number(extensionThresholdSeconds),
        allowHostSkip,
        allowTeamPurseAdjustments,
        retentionEnabled,
        maxRetentionsPerFranchise: Number(maxRetentionsPerFranchise),
        maxOverseasRetentions: Number(maxOverseasRetentions),
        franchisePurseAdjustments: allowTeamPurseAdjustments
          ? room.franchises.map((f) => ({
              franchiseCode: f.presetCode,
              adjustmentLakhs: Number(purseAdjustments[f.presetCode] || 0)
            }))
          : undefined
      });
      onRoomUpdated(res.data as RoomDetailDto);
      setConfigSuccess('Auction configuration saved and synced to all participants.');
    } catch (err: any) {
      setConfigError(err.message || 'Unable to save auction configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSavePool = async () => {
    if (!canEdit) return;
    clearBanners();
    setIsSaving(true);
    try {
      const res: any = await api.put(`/rooms/${room.code}/pool`, {
        lots: draftLots.map((lot, index) => ({
          playerId: lot.playerId,
          setCategory: lot.setCategory || 'Marquee',
          basePriceLakhs: Number(lot.basePriceLakhs),
          sequenceOrder: index + 1
        }))
      });
      onRoomUpdated(res.data as RoomDetailDto);
      setConfigSuccess(`Saved ${draftLots.length} player lot(s) to the room auction pool.`);
    } catch (err: any) {
      setConfigError(err.message || 'Unable to save player pool.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAutoFillPool = async () => {
    if (!canEdit) return;
    clearBanners();
    setIsSaving(true);
    try {
      const res: any = await api.post(`/rooms/${room.code}/pool/auto-fill`, {
        roles: catalogRole !== 'ALL' ? [catalogRole as CricketRole] : undefined,
        includeOverseas: catalogOrigin !== 'DOMESTIC',
        includeDomestic: catalogOrigin !== 'OVERSEAS',
        useDefaultBasePrice: false
      });
      onRoomUpdated(res.data as RoomDetailDto);
      setConfigSuccess('Auto-filled auction pool from verified player catalog.');
    } catch (err: any) {
      setConfigError(err.message || 'Unable to auto-fill player pool.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddRetention = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || !retPlayerId) return;
    clearBanners();
    setIsSaving(true);
    try {
      const res: any = await api.post(`/rooms/${room.code}/retentions`, {
        franchiseCode: retFranchiseCode,
        playerId: retPlayerId,
        retentionCostLakhs: Number(retCostLakhs)
      });
      onRoomUpdated(res.data as RoomDetailDto);
      setRetPlayerId('');
      setConfigSuccess('Player retention recorded and franchise purse updated.');
    } catch (err: any) {
      setConfigError(err.message || 'Unable to add retention.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveRetention = async (retentionId: string) => {
    if (!canEdit) return;
    clearBanners();
    setIsSaving(true);
    try {
      const res: any = await api.delete(`/rooms/${room.code}/retentions/${retentionId}`);
      onRoomUpdated(res.data as RoomDetailDto);
      setConfigSuccess('Retention released and franchise purse restored.');
    } catch (err: any) {
      setConfigError(err.message || 'Unable to remove retention.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleFinalizeConfig = async () => {
    if (!canEdit) return;
    clearBanners();
    setIsSaving(true);
    try {
      const res: any = await api.post(`/rooms/${room.code}/config/finalize`);
      onRoomUpdated(res.data as RoomDetailDto);
      setConfigSuccess('Configuration finalized and locked for all participants.');
    } catch (err: any) {
      setConfigError(err.message || 'Unable to finalize configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  const addLotFromCatalog = (p: MasterPlayerCatalogDto) => {
    if (!canEdit || poolPlayerIds.has(p.id) || retainedPlayerIds.has(p.id)) return;
    const roleSetMap: Record<CricketRole, string> = {
      [CricketRole.BATSMAN]: 'Batters',
      [CricketRole.BOWLER]: 'Bowlers',
      [CricketRole.ALL_ROUNDER]: 'All-Rounders',
      [CricketRole.WICKET_KEEPER]: 'Wicketkeepers'
    };
    setDraftLots((prev) => [
      ...prev,
      {
        playerId: p.id,
        fullName: p.fullName,
        nationality: p.nationality,
        isOverseas: p.isOverseas,
        playingRole: p.playingRole,
        setCategory: roleSetMap[p.playingRole] || 'Pool',
        basePriceLakhs: p.basePriceLakhs || defaultBasePriceLakhs
      }
    ]);
  };

  const moveLot = (index: number, delta: -1 | 1) => {
    if (!canEdit) return;
    const target = index + delta;
    if (target < 0 || target >= draftLots.length) return;
    setDraftLots((prev) => {
      const copy = [...prev];
      const [item] = copy.splice(index, 1);
      copy.splice(target, 0, item);
      return copy;
    });
  };

  return (
    <div className="space-y-6">
      {/* Main Pre-Auction Configuration Card */}
      <Card highlight={room.configFinalized ? 'gold' : 'electric'} className="p-6 space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-stadium-border pb-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Sliders className="w-5 h-5 text-gold-400" />
              <h2 className="font-display text-2xl font-extrabold tracking-wide text-white">
                PRE-AUCTION CONFIGURATION
              </h2>
              <Badge tone={room.configFinalized ? 'sold' : 'electric'}>
                {room.configFinalized ? (
                  <>
                    <Lock className="w-3 h-3" /> FINALIZED & LOCKED
                  </>
                ) : (
                  `${AUCTION_MODE_PRESETS[room.settings.auctionMode].label}`
                )}
              </Badge>
              {!isHost && <Badge tone="neutral">Read-Only View</Badge>}
            </div>
            <p className="text-xs text-stadium-muted">
              {room.configFinalized
                ? 'Rules, retentions, and player pool are locked and synchronized across all room participants.'
                : isHost
                  ? 'Configure auction mode, franchise rules, bid tiers, player pool, and retentions before locking setup.'
                  : 'Host is configuring the pre-auction rules. All changes update here live.'}
            </p>
          </div>

          {canEdit && (
            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              <Button variant="electric" size="sm" onClick={handleSaveConfig} isLoading={isSaving}>
                Save Rules
              </Button>
              <Button
                variant="gold"
                size="sm"
                onClick={handleFinalizeConfig}
                isLoading={isSaving}
                leftIcon={<Lock className="w-3.5 h-3.5" />}
              >
                Finalize & Lock Config
              </Button>
            </div>
          )}
        </div>

        {/* Navigation Tabs */}
        <div className="flex flex-wrap gap-2">
          {(
            [
              { id: 'MODE', label: 'Mode & Franchises', icon: Sparkles },
              { id: 'BIDDING', label: 'Bidding & Timers', icon: Gavel },
              { id: 'POOL', label: `Player Pool (${draftLots.length})`, icon: Layers },
              { id: 'RETENTION', label: `Retentions (${room.retentions.length})`, icon: ShieldCheck }
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold uppercase tracking-wider border transition-all ${
                  active
                    ? 'bg-gold-500/15 text-gold-300 border-gold-500/50 shadow-gold-glow'
                    : 'bg-stadium-card/70 text-stadium-muted border-stadium-border hover:text-white'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {configError && (
          <div className="rounded-xl border border-signal-unsold/45 bg-signal-unsold/10 px-4 py-2.5 text-xs text-signal-unsold font-medium">
            {configError}
          </div>
        )}
        {configSuccess && (
          <div className="rounded-xl border border-signal-sold/45 bg-signal-sold/10 px-4 py-2.5 text-xs text-signal-sold font-medium">
            {configSuccess}
          </div>
        )}

        {/* TAB 1: MODE & FRANCHISES */}
        {activeTab === 'MODE' && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
              {([AuctionMode.MOCK, AuctionMode.MEGA, AuctionMode.CUSTOM] as const).map((mode) => {
                const preset = AUCTION_MODE_PRESETS[mode];
                const selected = auctionMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => applyModePreset(mode)}
                    className={`p-4 rounded-xl border text-left transition-all space-y-1.5 ${
                      selected
                        ? 'bg-stadium-elevated border-gold-400 shadow-gold-glow'
                        : 'bg-stadium-card/60 border-stadium-border hover:border-white/25'
                    } disabled:opacity-80`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-display text-lg font-bold text-white">{preset.label}</span>
                      {selected && <Badge tone="gold">ACTIVE</Badge>}
                    </div>
                    <p className="text-xs text-stadium-muted">{preset.description}</p>
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3.5">
              <Input
                label="Purse (Lakhs)"
                type="number"
                disabled={!canEdit}
                value={initialPurseLakhs}
                onChange={(e) => setInitialPurseLakhs(Number(e.target.value))}
                hint={`${(initialPurseLakhs / 100).toFixed(1)} Cr`}
              />
              <Input
                label="Min Squad"
                type="number"
                disabled={!canEdit}
                value={minSquadSize}
                onChange={(e) => setMinSquadSize(Number(e.target.value))}
              />
              <Input
                label="Max Squad"
                type="number"
                disabled={!canEdit}
                value={maxSquadSize}
                onChange={(e) => setMaxSquadSize(Number(e.target.value))}
              />
              <Input
                label="Max Overseas"
                type="number"
                disabled={!canEdit}
                value={maxOverseas}
                onChange={(e) => setMaxOverseas(Number(e.target.value))}
              />
              <Input
                label="Min Owners"
                type="number"
                disabled={!canEdit}
                value={minOwnersRequired}
                onChange={(e) => setMinOwnersRequired(Number(e.target.value))}
              />
            </div>

            {/* Optional Per-Franchise Purse Adjustments */}
            <div className="rounded-xl bg-stadium-card/50 border border-stadium-border p-4 space-y-3">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-sm font-bold text-white">Team-Specific Purse Adjustments</div>
                  <div className="text-xs text-stadium-muted">
                    Permit custom +/- purse offsets per franchise (recommended for Custom / Handicap rooms).
                  </div>
                </div>
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={allowTeamPurseAdjustments}
                  onChange={(e) => setAllowTeamPurseAdjustments(e.target.checked)}
                  className="w-4 h-4 rounded border-stadium-border bg-stadium-card"
                />
              </label>

              {allowTeamPurseAdjustments && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 pt-2 border-t border-stadium-border">
                  {room.franchises.map((f) => (
                    <div key={f.id} className="rounded-lg bg-stadium-surface p-2.5 border border-stadium-border space-y-1.5">
                      <div className="flex items-center gap-2">
                        <FranchiseEmblem
                          code={f.abbreviation}
                          primaryColor={f.primaryColor}
                          secondaryColor={f.secondaryColor}
                          size="sm"
                        />
                        <div className="text-xs font-mono text-stadium-muted">
                          Eff: {((initialPurseLakhs + (purseAdjustments[f.presetCode] || 0)) / 100).toFixed(1)}Cr
                        </div>
                      </div>
                      <input
                        type="number"
                        disabled={!canEdit}
                        value={purseAdjustments[f.presetCode] ?? 0}
                        onChange={(e) =>
                          setPurseAdjustments((prev) => ({
                            ...prev,
                            [f.presetCode]: Number(e.target.value)
                          }))
                        }
                        className="w-full rounded-lg bg-stadium-card border border-stadium-border px-2 py-1 text-xs font-mono text-white"
                        placeholder="Adj (L)"
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: BIDDING & TIMERS */}
        {activeTab === 'BIDDING' && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
              <Input
                label="Default Base (Lakhs)"
                type="number"
                disabled={!canEdit}
                value={defaultBasePriceLakhs}
                onChange={(e) => setDefaultBasePriceLakhs(Number(e.target.value))}
              />
              <Input
                label="Countdown (Sec)"
                type="number"
                disabled={!canEdit}
                value={countdownSeconds}
                onChange={(e) => setCountdownSeconds(Number(e.target.value))}
              />
              <Input
                label="Late Ext (Sec)"
                type="number"
                disabled={!canEdit || !allowLateBidExtension}
                value={bidExtensionSeconds}
                onChange={(e) => setBidExtensionSeconds(Number(e.target.value))}
              />
              <Input
                label="Ext Threshold (Sec)"
                type="number"
                disabled={!canEdit || !allowLateBidExtension}
                value={extensionThresholdSeconds}
                onChange={(e) => setExtensionThresholdSeconds(Number(e.target.value))}
              />
            </div>

            <div className="flex flex-wrap gap-6 text-xs text-stadium-muted">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={allowLateBidExtension}
                  onChange={(e) => setAllowLateBidExtension(e.target.checked)}
                />
                <span>Extend countdown on late bids</span>
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={allowHostSkip}
                  onChange={(e) => setAllowHostSkip(e.target.checked)}
                />
                <span>Allow Host to skip lots</span>
              </label>
            </div>

            {/* Configurable Bid Increment Tiers */}
            <div className="rounded-xl bg-stadium-card/50 border border-stadium-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-white">Bid Increment Tiers (Lakhs)</h3>
                  <p className="text-xs text-stadium-muted">
                    Ranges must be strictly ascending and non-overlapping.
                  </p>
                </div>
                {canEdit && (
                  <Button
                    type="button"
                    size="sm"
                    variant="surface"
                    onClick={() => {
                      const lastMax = bidTiers[bidTiers.length - 1]?.maxAmount || 1000;
                      setBidTiers((prev) => [
                        ...prev,
                        { minAmount: lastMax + 1, maxAmount: lastMax + 1000, increment: 50 }
                      ]);
                    }}
                    leftIcon={<Plus className="w-3.5 h-3.5" />}
                  >
                    Add Tier
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                {bidTiers.map((tier, idx) => (
                  <div key={idx} className="grid grid-cols-4 gap-2.5 items-center">
                    <input
                      type="number"
                      disabled={!canEdit}
                      value={tier.minAmount}
                      onChange={(e) =>
                        setBidTiers((prev) =>
                          prev.map((t, i) => (i === idx ? { ...t, minAmount: Number(e.target.value) } : t))
                        )
                      }
                      aria-label={`Tier ${idx + 1} Min`}
                      className="rounded-lg bg-stadium-surface border border-stadium-border px-2.5 py-1.5 text-xs font-mono text-white"
                    />
                    <input
                      type="number"
                      disabled={!canEdit}
                      value={tier.maxAmount}
                      onChange={(e) =>
                        setBidTiers((prev) =>
                          prev.map((t, i) => (i === idx ? { ...t, maxAmount: Number(e.target.value) } : t))
                        )
                      }
                      aria-label={`Tier ${idx + 1} Max`}
                      className="rounded-lg bg-stadium-surface border border-stadium-border px-2.5 py-1.5 text-xs font-mono text-white"
                    />
                    <input
                      type="number"
                      disabled={!canEdit}
                      value={tier.increment}
                      onChange={(e) =>
                        setBidTiers((prev) =>
                          prev.map((t, i) => (i === idx ? { ...t, increment: Number(e.target.value) } : t))
                        )
                      }
                      aria-label={`Tier ${idx + 1} Increment`}
                      className="rounded-lg bg-stadium-surface border border-stadium-border px-2.5 py-1.5 text-xs font-mono text-gold-300"
                    />
                    <div className="flex justify-end">
                      {canEdit && bidTiers.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setBidTiers((prev) => prev.filter((_, i) => i !== idx))}
                          className="p-1.5 rounded-lg text-signal-unsold hover:bg-signal-unsold/15"
                          title="Remove Tier"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: PLAYER POOL */}
        {activeTab === 'POOL' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
            {/* Catalog Browser (Host Editable) */}
            {canEdit && (
              <div className="lg:col-span-5 rounded-xl bg-stadium-card/50 border border-stadium-border p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-white">Player Catalog</h3>
                  <Button
                    type="button"
                    size="sm"
                    variant="electric"
                    onClick={handleAutoFillPool}
                    isLoading={isSaving}
                  >
                    Auto-Fill Pool
                  </Button>
                </div>

                <div className="space-y-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-stadium-muted absolute left-3 top-2.5" />
                    <input
                      type="text"
                      placeholder="Search player or country..."
                      value={catalogSearch}
                      onChange={(e) => setCatalogSearch(e.target.value)}
                      className="w-full rounded-lg bg-stadium-surface border border-stadium-border pl-8 pr-3 py-1.5 text-xs text-white"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={catalogRole}
                      onChange={(e) => setCatalogRole(e.target.value)}
                      className="rounded-lg bg-stadium-surface border border-stadium-border px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="ALL">All Roles</option>
                      <option value="BATSMAN">Batsmen</option>
                      <option value="BOWLER">Bowlers</option>
                      <option value="ALL_ROUNDER">All-Rounders</option>
                      <option value="WICKET_KEEPER">Wicketkeepers</option>
                    </select>
                    <select
                      value={catalogOrigin}
                      onChange={(e) => setCatalogOrigin(e.target.value as any)}
                      className="rounded-lg bg-stadium-surface border border-stadium-border px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="ALL">Domestic & Overseas</option>
                      <option value="DOMESTIC">Domestic Only</option>
                      <option value="OVERSEAS">Overseas Only</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {isLoadingCatalog ? (
                    <p className="text-xs text-stadium-muted py-4 text-center">Loading catalog...</p>
                  ) : (
                    filteredCatalog.map((p) => {
                      const isRetained = retainedPlayerIds.has(p.id);
                      const inPool = poolPlayerIds.has(p.id);
                      return (
                        <div
                          key={p.id}
                          className="rounded-lg bg-stadium-surface border border-stadium-border px-3 py-2 flex items-center justify-between gap-2 text-xs"
                        >
                          <div className="min-w-0">
                            <button
                              type="button"
                              onClick={() => setInspectedPlayerId(p.id)}
                              className="font-bold text-white hover:text-gold-300 truncate text-left block max-w-full"
                              title="Inspect full IPL career stats"
                            >
                              {p.fullName}
                            </button>
                            <div className="text-[11px] text-stadium-muted font-mono">
                              {p.playingRole} · {p.isOverseas ? 'OVERSEAS' : 'DOMESTIC'} · {p.basePriceLakhs}L
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => setInspectedPlayerId(p.id)}
                              className="p-1.5 rounded-lg text-stadium-muted hover:text-gold-300 hover:bg-white/5"
                              title="View IPL Career Stats"
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                            <Button
                              type="button"
                              size="sm"
                              variant={inPool || isRetained ? 'ghost' : 'surface'}
                              disabled={inPool || isRetained}
                              onClick={() => addLotFromCatalog(p)}
                            >
                              {isRetained ? 'Retained' : inPool ? 'In Pool' : 'Add'}
                            </Button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* Room Auction Pool */}
            <div
              className={`${
                canEdit ? 'lg:col-span-7' : 'lg:col-span-12'
              } rounded-xl bg-stadium-card/50 border border-stadium-border p-4 space-y-3`}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-white">
                  Room Auction Order ({draftLots.length} Players)
                </h3>
                {canEdit && (
                  <Button
                    type="button"
                    size="sm"
                    variant="gold"
                    onClick={handleSavePool}
                    isLoading={isSaving}
                  >
                    Save Player Pool
                  </Button>
                )}
              </div>

              {draftLots.length === 0 ? (
                <div className="rounded-lg border border-dashed border-stadium-border p-6 text-center text-xs text-stadium-muted">
                  No players queued yet. {canEdit ? 'Use Auto-Fill Pool or add players from the catalog.' : 'Waiting for Host to populate the pool.'}
                </div>
              ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                  {draftLots.map((lot, idx) => (
                    <div
                      key={lot.playerId}
                      className="rounded-lg bg-stadium-surface border border-stadium-border px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="font-mono text-gold-300 font-bold w-6">#{idx + 1}</span>
                        <div className="min-w-0">
                          <div className="font-bold text-white truncate">{lot.fullName}</div>
                          <div className="text-[11px] font-mono text-stadium-muted">
                            {lot.playingRole} · {lot.isOverseas ? 'OVERSEAS' : 'DOMESTIC'}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          disabled={!canEdit}
                          value={lot.setCategory}
                          onChange={(e) =>
                            setDraftLots((prev) =>
                              prev.map((l, i) => (i === idx ? { ...l, setCategory: e.target.value } : l))
                            )
                          }
                          className="w-24 rounded bg-stadium-card border border-stadium-border px-2 py-1 text-[11px] text-white"
                          title="Player Set"
                        />
                        <input
                          type="number"
                          disabled={!canEdit}
                          value={lot.basePriceLakhs}
                          onChange={(e) =>
                            setDraftLots((prev) =>
                              prev.map((l, i) =>
                                i === idx ? { ...l, basePriceLakhs: Number(e.target.value) } : l
                              )
                            )
                          }
                          className="w-16 rounded bg-stadium-card border border-stadium-border px-2 py-1 text-[11px] font-mono text-gold-300"
                          title="Base Price (Lakhs)"
                        />
                        {canEdit && (
                          <>
                            <button
                              type="button"
                              onClick={() => moveLot(idx, -1)}
                              disabled={idx === 0}
                              className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveLot(idx, 1)}
                              disabled={idx === draftLots.length - 1}
                              className="p-1 rounded hover:bg-white/10 disabled:opacity-30"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setDraftLots((prev) => prev.filter((_, i) => i !== idx))
                              }
                              className="p-1 rounded text-signal-unsold hover:bg-signal-unsold/15"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: RETENTION SETUP */}
        {activeTab === 'RETENTION' && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 items-end">
              <label className="rounded-xl bg-stadium-card/60 border border-stadium-border px-3.5 py-2.5 flex items-center justify-between gap-2 text-xs text-white cursor-pointer">
                <span className="font-bold">Enable Player Retention</span>
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={retentionEnabled}
                  onChange={(e) => setRetentionEnabled(e.target.checked)}
                />
              </label>
              <Input
                label="Max Retentions / Team"
                type="number"
                disabled={!canEdit || !retentionEnabled}
                value={maxRetentionsPerFranchise}
                onChange={(e) => setMaxRetentionsPerFranchise(Number(e.target.value))}
              />
              <Input
                label="Max Overseas Retentions"
                type="number"
                disabled={!canEdit || !retentionEnabled}
                value={maxOverseasRetentions}
                onChange={(e) => setMaxOverseasRetentions(Number(e.target.value))}
              />
            </div>

            {canEdit && room.settings.retentionEnabled && (
              <form
                onSubmit={handleAddRetention}
                className="rounded-xl bg-stadium-card/50 border border-stadium-border p-4 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
              >
                <div className="sm:col-span-3 space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                    Franchise
                  </label>
                  <select
                    value={retFranchiseCode}
                    onChange={(e) => setRetFranchiseCode(e.target.value)}
                    className="w-full rounded-xl bg-stadium-surface border border-stadium-border px-3 py-2 text-xs text-white"
                  >
                    {room.franchises.map((f) => (
                      <option key={f.id} value={f.presetCode}>
                        {f.abbreviation} ({(f.remainingPurseLakhs / 100).toFixed(1)}Cr left)
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-4 space-y-1.5">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-stadium-muted">
                    Player
                  </label>
                  <select
                    value={retPlayerId}
                    onChange={(e) => setRetPlayerId(e.target.value)}
                    className="w-full rounded-xl bg-stadium-surface border border-stadium-border px-3 py-2 text-xs text-white"
                  >
                    {eligibleRetentionPlayers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.fullName} ({p.playingRole}{p.isOverseas ? ', OS' : ''})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="sm:col-span-3">
                  <Input
                    label="Retention Cost (Lakhs)"
                    type="number"
                    min={1}
                    value={retCostLakhs}
                    onChange={(e) => setRetCostLakhs(Number(e.target.value))}
                  />
                </div>

                <div className="sm:col-span-2">
                  <Button
                    type="submit"
                    variant="gold"
                    size="sm"
                    className="w-full"
                    isLoading={isSaving}
                    leftIcon={<UserPlus className="w-3.5 h-3.5" />}
                  >
                    Retain
                  </Button>
                </div>
              </form>
            )}

            {canEdit && retentionEnabled !== room.settings.retentionEnabled && (
              <p className="text-xs text-gold-300">
                Click <strong>Save Rules</strong> above to apply your Retention enable/disable toggle before adding players.
              </p>
            )}

            {room.retentions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-stadium-border p-5 text-center text-xs text-stadium-muted">
                No retained players assigned yet.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {room.retentions.map((r) => (
                  <div
                    key={r.id}
                    className="rounded-xl bg-stadium-card/80 border border-stadium-border px-3.5 py-2.5 flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="font-bold text-white truncate">
                        <span className="text-gold-300 font-mono mr-1.5">[{r.franchiseCode}]</span>
                        {r.playerName}
                      </div>
                      <div className="text-[11px] font-mono text-stadium-muted">
                        Slot #{r.slotNumber} · {r.playingRole} · {r.isOverseas ? 'OVERSEAS' : 'DOMESTIC'} ·{' '}
                        <span className="text-gold-300">{r.retentionCostLakhs}L</span>
                      </div>
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => handleRemoveRetention(r.id)}
                        className="p-1.5 rounded-lg text-signal-unsold hover:bg-signal-unsold/15"
                        title="Release Retention"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Pre-Auction Readiness Checklist */}
      <Card highlight={room.readiness.isReadyToStart ? 'gold' : 'none'} className="p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stadium-border pb-3">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-gold-400" />
            <h3 className="font-display text-xl font-bold text-white tracking-wide">
              PRE-AUCTION READINESS CHECKLIST
            </h3>
          </div>
          <Badge tone={room.readiness.isReadyToStart ? 'sold' : 'unsold'}>
            {room.readiness.isReadyToStart ? 'ALL CHECKS PASSED' : 'SETUP INCOMPLETE'}
          </Badge>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          {room.readiness.checks.map((check) => (
            <div
              key={check.key}
              className={`rounded-xl border px-3 py-2.5 space-y-1 ${
                check.passed
                  ? 'bg-signal-sold/10 border-signal-sold/35'
                  : 'bg-stadium-card/70 border-stadium-border'
              }`}
            >
              <div className="flex items-center gap-1.5 text-xs font-bold text-white">
                {check.passed ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-signal-sold shrink-0" />
                ) : (
                  <CircleAlert className="w-3.5 h-3.5 text-signal-warn shrink-0" />
                )}
                <span className="truncate">{check.label}</span>
              </div>
              <p className="text-[11px] text-stadium-muted leading-snug">{check.message}</p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-stadium-border">
          <p className="text-xs text-stadium-muted">
            {room.status !== RoomStatus.LOBBY
              ? 'This auction is underway or finished. Enter the live floor now.'
              : isHost
              ? room.readiness.isReadyToStart
                ? 'All readiness checks passed. Launch the live broadcast auction room for all connected franchises.'
                : 'Complete the remaining checks above (including locking config and readying owners) to unlock auction launch.'
              : 'Waiting for the Host to start the live auction once all checks pass.'}
          </p>

          {room.status !== RoomStatus.LOBBY ? (
            <Button
              variant="gold"
              onClick={() => router.push(`/room/${room.code}/auction`)}
              leftIcon={<Play className="w-4 h-4" />}
              data-testid="enter-live-auction-btn"
            >
              Enter Live Auction
            </Button>
          ) : isHost ? (
            <Button
              variant="gold"
              disabled={!room.readiness.isReadyToStart || isStartingAuction}
              isLoading={isStartingAuction}
              leftIcon={<Gavel className="w-4 h-4" />}
              data-testid="start-auction-btn"
              onClick={async () => {
                setConfigError(null);
                setIsStartingAuction(true);
                try {
                  await api.post(`/rooms/${room.code}/auction/start`, {});
                  router.push(`/room/${room.code}/auction`);
                } catch (err: any) {
                  setConfigError(err?.message || 'Failed to start auction');
                  setIsStartingAuction(false);
                }
              }}
            >
              Start Live Auction
            </Button>
          ) : null}
        </div>
      </Card>

      <PlayerProfileModal
        playerId={inspectedPlayerId}
        onClose={() => setInspectedPlayerId(null)}
      />
    </div>
  );
}
