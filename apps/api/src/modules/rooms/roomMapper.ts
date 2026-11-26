import { RoomRole as DbRoomRole } from '@auctioncraze/database';
import { validateAuctionConfiguration } from '@auctioncraze/auction-engine';
import {
  AuctionMode,
  AuctionReadinessDto,
  BidTierConfig,
  CricketRole,
  DEFAULT_BID_TIERS_LAKHS,
  LotStatus,
  ReadinessCheckItem,
  RoomDetailDto,
  RoomRole,
  RoomStatus,
  RoomVisibility
} from '@auctioncraze/shared';

export function resolveBidTiers(raw: unknown): BidTierConfig[] {
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((t: any) => ({
      minAmount: Number(t.minAmount),
      maxAmount: Number(t.maxAmount),
      increment: Number(t.increment)
    }));
  }
  return [...DEFAULT_BID_TIERS_LAKHS];
}

export function evaluateRoomReadiness(room: any): AuctionReadinessDto {
  const activeParticipants = (room.participants || []).filter((p: any) => !p.isRemoved && !p.leftAt);
  const activeOwners = activeParticipants.filter(
    (p: any) => p.role === DbRoomRole.HOST || p.role === DbRoomRole.OWNER
  );
  const host = activeParticipants.find((p: any) => p.id === room.hostParticipantId);

  // Detect any franchise conflicts or invalid purse balances
  const seenFranchiseIds = new Set<string>();
  let hasFranchiseConflict = false;
  for (const p of activeOwners) {
    if (!p.franchiseId) {
      hasFranchiseConflict = true;
      break;
    }
    if (seenFranchiseIds.has(p.franchiseId)) {
      hasFranchiseConflict = true;
      break;
    }
    seenFranchiseIds.add(p.franchiseId);
  }

  const bidTiers = resolveBidTiers(room.bidIncrementTiersJson);
  const configValidation = validateAuctionConfiguration({
    initialPurseLakhs: room.initialPurseLakhs,
    minSquadSize: room.minSquadSize,
    maxSquadSize: room.maxSquadSize,
    maxOverseas: room.maxOverseas,
    minOwnersRequired: room.minOwnersRequired,
    defaultBasePriceLakhs: room.defaultBasePriceLakhs,
    countdownSeconds: room.countdownSeconds,
    allowLateBidExtension: room.allowLateBidExtension,
    bidExtensionSeconds: room.bidExtensionSeconds,
    extensionThresholdSeconds: room.extensionThresholdSeconds,
    retentionEnabled: room.retentionEnabled,
    maxRetentionsPerFranchise: room.maxRetentionsPerFranchise,
    maxOverseasRetentions: room.maxOverseasRetentions,
    bidIncrementTiers: bidTiers
  });

  const negativePurseFranchises = (room.franchises || []).filter(
    (f: any) => f.remainingPurseLakhs < 0
  );

  const lotsCount = (room.lots || []).length;

  const checks: ReadinessCheckItem[] = [
    {
      key: 'host_exists',
      label: 'Room Host Assigned',
      passed: !!host && host.role === DbRoomRole.HOST,
      message: host ? `Host is ${host.displayName}` : 'No active room host assigned.'
    },
    {
      key: 'host_franchise',
      label: 'Host Owns a Franchise',
      passed: !!host?.franchiseId,
      message: host?.franchiseId
        ? 'Host participates as a franchise owner.'
        : 'Host must claim a franchise before starting.'
    },
    {
      key: 'no_conflicts',
      label: 'No Franchise Conflicts',
      passed: !hasFranchiseConflict,
      message: !hasFranchiseConflict
        ? 'All claimed franchises are uniquely assigned.'
        : 'Conflicting or missing franchise ownership detected.'
    },
    {
      key: 'owners_present',
      label: `Required Owners (${activeOwners.length}/${room.minOwnersRequired})`,
      passed: activeOwners.length >= room.minOwnersRequired,
      message:
        activeOwners.length >= room.minOwnersRequired
          ? `${activeOwners.length} franchise owner(s) ready in room.`
          : `At least ${room.minOwnersRequired} franchise owner(s) must join before starting.`
    },
    {
      key: 'config_valid',
      label: 'Auction Rules Valid',
      passed: configValidation.isValid && negativePurseFranchises.length === 0,
      message: !configValidation.isValid
        ? configValidation.errorMessage || 'Invalid auction configuration.'
        : negativePurseFranchises.length > 0
          ? 'One or more franchises have negative remaining purse.'
          : 'Purse, squad, overseas, retention, and bid tiers are valid.'
    },
    {
      key: 'player_pool',
      label: `Player Pool (${lotsCount} Players)`,
      passed: lotsCount > 0,
      message:
        lotsCount > 0
          ? `${lotsCount} player lot(s) queued for auction.`
          : 'Add at least 1 player to the auction pool.'
    },
    {
      key: 'config_finalized',
      label: 'Configuration Finalized',
      passed: !!room.configFinalized,
      message: room.configFinalized
        ? 'Rules and player pool are locked and ready.'
        : 'Host must finalize and lock configuration before auction start.'
    }
  ];

  return {
    isReadyToStart: checks.every((c) => c.passed),
    checks
  };
}

export function mapRoomToDetailDto(room: any, includeInviteToken = false): RoomDetailDto {
  const activeParticipants = (room.participants || []).filter(
    (p: any) => !p.isRemoved && !p.leftAt
  );
  const participantByFranchise = new Map<string, any>();
  activeParticipants.forEach((p: any) => {
    if (p.franchiseId) {
      participantByFranchise.set(p.franchiseId, p);
    }
  });

  const franchiseById = new Map<string, any>();
  (room.franchises || []).forEach((f: any) => {
    franchiseById.set(f.id, f);
  });

  const bidIncrementTiers = resolveBidTiers(room.bidIncrementTiersJson);

  return {
    id: room.id,
    code: room.code,
    name: room.name,
    visibility: room.visibility as RoomVisibility,
    ...(includeInviteToken ? { inviteToken: room.inviteToken ?? null } : {}),
    status: room.status as RoomStatus,
    hostParticipantId: room.hostParticipantId,
    version: room.version,
    configFinalized: !!room.configFinalized,
    configFinalizedAt: room.configFinalizedAt ? room.configFinalizedAt.toISOString() : null,
    settings: {
      auctionMode: (room.auctionMode || AuctionMode.MEGA) as AuctionMode,
      initialPurseLakhs: room.initialPurseLakhs,
      minSquadSize: room.minSquadSize,
      maxSquadSize: room.maxSquadSize,
      maxOverseas: room.maxOverseas,
      maxSpectators: room.maxSpectators,
      minOwnersRequired: room.minOwnersRequired,
      defaultBasePriceLakhs: room.defaultBasePriceLakhs,
      bidIncrementTiers,
      countdownSeconds: room.countdownSeconds,
      allowLateBidExtension: room.allowLateBidExtension,
      bidExtensionSeconds: room.bidExtensionSeconds,
      extensionThresholdSeconds: room.extensionThresholdSeconds,
      allowHostSkip: room.allowHostSkip,
      allowTeamPurseAdjustments: room.allowTeamPurseAdjustments,
      retentionEnabled: room.retentionEnabled,
      maxRetentionsPerFranchise: room.maxRetentionsPerFranchise,
      maxOverseasRetentions: room.maxOverseasRetentions
    },
    franchises: (room.franchises || []).map((f: any) => {
      const owner = participantByFranchise.get(f.id);
      return {
        id: f.id,
        presetCode: f.presetCode,
        name: f.name,
        abbreviation: f.abbreviation,
        primaryColor: f.primaryColor,
        secondaryColor: f.secondaryColor,
        initialPurseLakhs: f.initialPurseLakhs,
        purseAdjustmentLakhs: f.purseAdjustmentLakhs ?? 0,
        remainingPurseLakhs: f.remainingPurseLakhs,
        squadCount: f.squadCount,
        overseasCount: f.overseasCount,
        retainedCount: f.retainedCount ?? 0,
        claimedByParticipantId: owner ? owner.id : null,
        claimedByDisplayName: owner ? owner.displayName : null
      };
    }),
    participants: activeParticipants.map((p: any) => ({
      id: p.id,
      guestSessionId: p.guestSessionId,
      displayName: p.displayName,
      role: p.role as RoomRole,
      franchiseId: p.franchiseId,
      franchiseCode: p.franchiseId ? franchiseById.get(p.franchiseId)?.presetCode || null : null,
      isReady: p.isReady,
      isConnected: p.isConnected,
      joinedAt: p.joinedAt.toISOString()
    })),
    lots: (room.lots || []).map((l: any) => ({
      id: l.id,
      playerId: l.playerId,
      roundNumber: l.roundNumber ?? 1,
      fullName: l.player?.fullName || 'Unknown Player',
      nationality: l.player?.nationality ?? null,
      isOverseas: !!l.player?.isOverseas,
      playingRole: (l.player?.playingRole || CricketRole.ALL_ROUNDER) as CricketRole,
      sequenceOrder: l.sequenceOrder,
      setCategory: l.setCategory,
      basePriceLakhs: l.basePriceLakhs,
      status: l.status as LotStatus
    })),
    retentions: (room.retentions || []).map((r: any) => ({
      id: r.id,
      franchiseId: r.franchiseId,
      franchiseCode: franchiseById.get(r.franchiseId)?.presetCode || '',
      playerId: r.playerId,
      playerName: r.player?.fullName || 'Unknown Player',
      playingRole: (r.player?.playingRole || CricketRole.ALL_ROUNDER) as CricketRole,
      isOverseas: !!r.player?.isOverseas,
      retentionCostLakhs: r.retentionCostLakhs,
      slotNumber: r.slotNumber
    })),
    readiness: evaluateRoomReadiness(room),
    spectatorCount: activeParticipants.filter((p: any) => p.role === DbRoomRole.SPECTATOR).length,
    createdAt: room.createdAt.toISOString()
  };
}
