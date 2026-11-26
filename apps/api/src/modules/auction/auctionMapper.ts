import { LotStatus as DbLotStatus, Prisma, RoomStatus as DbRoomStatus } from '@auctioncraze/database';
import { calculateNextBidLakhs } from '@auctioncraze/auction-engine';
import {
  ActiveLotDetailDto,
  AuctionBidDto,
  AuctionFranchiseStateDto,
  AuctionResultItemDto,
  AuctionStage,
  AuctionStateSnapshotDto,
  CricketRole,
  LotStatus,
  RoomRole,
  RoomStatus,
  SquadMemberDto,
  formatFranchiseDisplayName
} from '@auctioncraze/shared';
import { resolveBidTiers } from '../rooms/roomMapper';

export const AUCTION_ROOM_INCLUDE = {
  season: { select: { code: true, name: true } },
  franchises: {
    include: {
      purchases: {
        include: { player: true },
        orderBy: { soldAt: 'asc' }
      },
      retentions: {
        include: { player: true },
        orderBy: { slotNumber: 'asc' }
      }
    },
    orderBy: { presetCode: 'asc' }
  },
  participants: { orderBy: { joinedAt: 'asc' } },
  lots: {
    include: {
      player: true,
      bids: {
        orderBy: { sequenceNumber: 'desc' }
      }
    },
    orderBy: { sequenceOrder: 'asc' }
  },
  retentions: {
    include: { player: true },
    orderBy: { slotNumber: 'asc' }
  }
} satisfies Prisma.RoomInclude;

export function mapAuctionStateSnapshot(room: any, nowMs = Date.now()): AuctionStateSnapshotDto {
  const activeParticipants = (room.participants || []).filter(
    (p: any) => !p.isRemoved && !p.leftAt
  );

  const participantById = new Map<string, any>();
  const ownerByFranchiseId = new Map<string, any>();
  activeParticipants.forEach((p: any) => {
    participantById.set(p.id, p);
    if (p.franchiseId) ownerByFranchiseId.set(p.franchiseId, p);
  });

  const franchiseById = new Map<string, any>();
  (room.franchises || []).forEach((f: any) => {
    franchiseById.set(f.id, f);
  });

  const bidTiers = resolveBidTiers(room.bidIncrementTiersJson);
  const lots = room.lots || [];
  const allowCustom = !!room.allowCustomTeamName;

  const currentLotRaw =
    (room.currentLotId ? lots.find((l: any) => l.id === room.currentLotId) : null) ||
    lots.find(
      (l: any) => l.status === DbLotStatus.ACTIVE || l.status === DbLotStatus.BIDDING_CLOSED
    ) ||
    null;

  let currentLot: ActiveLotDetailDto | null = null;
  if (currentLotRaw) {
    const { nextBidLakhs, incrementLakhs } = calculateNextBidLakhs(
      currentLotRaw.currentBidLakhs,
      currentLotRaw.basePriceLakhs,
      bidTiers
    );
    const winningFranchise = currentLotRaw.winningFranchiseId
      ? franchiseById.get(currentLotRaw.winningFranchiseId)
      : null;
    const winningOwner = winningFranchise ? ownerByFranchiseId.get(winningFranchise.id) : null;

    currentLot = {
      id: currentLotRaw.id,
      roundNumber: currentLotRaw.roundNumber ?? 1,
      sequenceOrder: currentLotRaw.sequenceOrder,
      totalLots: lots.length,
      setCategory: currentLotRaw.setCategory,
      status: currentLotRaw.status as LotStatus,
      basePriceLakhs: currentLotRaw.basePriceLakhs,
      currentBidLakhs: currentLotRaw.currentBidLakhs,
      nextBidLakhs,
      incrementLakhs,
      winningFranchiseId: winningFranchise?.id || null,
      winningFranchiseCode: winningFranchise?.presetCode || null,
      winningFranchiseName: winningFranchise?.name || null,
      winningFranchiseDisplayName: winningFranchise
        ? formatFranchiseDisplayName(
            winningFranchise.name,
            winningFranchise.presetCode,
            winningFranchise.customSuffix,
            allowCustom
          )
        : null,
      winningFranchiseColor: winningFranchise?.primaryColor || null,
      winningOwnerName: winningOwner?.displayName || null,
      player: {
        id: currentLotRaw.player.id,
        cricsheetId: currentLotRaw.player.cricsheetId || null,
        fullName: currentLotRaw.player.fullName,
        nationality: currentLotRaw.player.nationality ?? null,
        isOverseas: !!currentLotRaw.player.isOverseas,
        age: currentLotRaw.player.age,
        playingRole: currentLotRaw.player.playingRole as CricketRole,
        secondaryRole: (currentLotRaw.player.secondaryRole as CricketRole) || null,
        battingStyle: currentLotRaw.player.battingStyle ?? null,
        bowlingStyle: currentLotRaw.player.bowlingStyle ?? null,
        iplDebutYear: currentLotRaw.player.iplDebutYear ?? null,
        iplLastYear: currentLotRaw.player.iplLastYear ?? null,
        teamHistory: Array.isArray(currentLotRaw.player.teamHistoryJson)
          ? currentLotRaw.player.teamHistoryJson
          : [],
        imageUrl: currentLotRaw.player.imageUrl || null,
        provenanceSource: currentLotRaw.player.provenanceSource || null
      },
      bids: (currentLotRaw.bids || []).map((b: any) => {
        const fran = franchiseById.get(b.franchiseId);
        const bidder = participantById.get(b.participantId);
        return {
          id: b.id,
          lotId: b.lotId,
          playerName: currentLotRaw.player.fullName,
          roundNumber: b.roundNumber ?? currentLotRaw.roundNumber ?? 1,
          franchiseId: b.franchiseId,
          franchiseCode: fran?.presetCode || '',
          franchiseDisplayName: fran
            ? formatFranchiseDisplayName(fran.name, fran.presetCode, fran.customSuffix, allowCustom)
            : '',
          franchiseColor: fran?.primaryColor || '#38BDF8',
          participantId: b.participantId,
          bidderDisplayName: bidder?.displayName || 'Owner',
          bidAmountLakhs: b.bidAmountLakhs,
          sequenceNumber: b.sequenceNumber,
          createdAt: b.createdAt.toISOString()
        };
      })
    };
  }

  let auctionStage: AuctionStage = 'READY';
  if (room.status === DbRoomStatus.COMPLETED) {
    auctionStage = 'COMPLETED';
  } else if (room.status === DbRoomStatus.LOBBY) {
    auctionStage = room.configFinalized ? 'READY' : 'CONFIGURING';
  } else if (room.status === DbRoomStatus.PAUSED || room.isPaused) {
    auctionStage = 'PAUSED';
  } else if (currentLotRaw?.status === DbLotStatus.BIDDING_CLOSED) {
    auctionStage = 'BIDDING_CLOSED';
  } else if (currentLotRaw?.status === DbLotStatus.SOLD) {
    auctionStage = 'PLAYER_SOLD';
  } else if (currentLotRaw?.status === DbLotStatus.UNSOLD) {
    auctionStage = 'PLAYER_UNSOLD';
  } else if (room.status === DbRoomStatus.LIVE) {
    auctionStage = 'LIVE';
  }

  const deadlineMs =
    !room.isPaused &&
    room.status === DbRoomStatus.LIVE &&
    currentLotRaw?.status === DbLotStatus.ACTIVE &&
    room.timerDeadlineMs != null
      ? Number(room.timerDeadlineMs)
      : null;

  let remainingSeconds = 0;
  if (room.isPaused || room.status === DbRoomStatus.PAUSED) {
    remainingSeconds = Math.max(0, Math.ceil((room.timerRemainingMs || 0) / 1000));
  } else if (deadlineMs !== null) {
    remainingSeconds = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  }

  const franchises: AuctionFranchiseStateDto[] = (room.franchises || []).map((f: any) => {
    const owner = ownerByFranchiseId.get(f.id);
    const retainedSquad: SquadMemberDto[] = (f.retentions || []).map((r: any) => ({
      playerId: r.playerId,
      fullName: r.player?.fullName || 'Unknown',
      nationality: r.player?.nationality ?? null,
      isOverseas: !!r.player?.isOverseas,
      playingRole: (r.player?.playingRole || CricketRole.ALL_ROUNDER) as CricketRole,
      priceLakhs: r.retentionCostLakhs,
      acquisitionType: 'RETAINED'
    }));
    const boughtSquad: SquadMemberDto[] = (f.purchases || []).map((pur: any) => ({
      playerId: pur.playerId,
      fullName: pur.player?.fullName || 'Unknown',
      nationality: pur.player?.nationality ?? null,
      isOverseas: !!pur.player?.isOverseas,
      playingRole: (pur.player?.playingRole || CricketRole.ALL_ROUNDER) as CricketRole,
      priceLakhs: pur.purchasePriceLakhs,
      acquisitionType: 'AUCTION'
    }));

    return {
      id: f.id,
      presetCode: f.presetCode,
      name: f.name,
      customSuffix: f.customSuffix ?? null,
      displayName: formatFranchiseDisplayName(f.name, f.presetCode, f.customSuffix, allowCustom),
      abbreviation: f.abbreviation,
      primaryColor: f.primaryColor,
      secondaryColor: f.secondaryColor,
      initialPurseLakhs: f.initialPurseLakhs,
      purseAdjustmentLakhs: f.purseAdjustmentLakhs ?? 0,
      remainingPurseLakhs: f.remainingPurseLakhs,
      squadCount: f.squadCount,
      overseasCount: f.overseasCount,
      retainedCount: f.retainedCount ?? 0,
      ownerParticipantId: owner?.id || null,
      ownerDisplayName: owner?.displayName || null,
      squad: [...retainedSquad, ...boughtSquad]
    };
  });

  const upNextLots = lots
    .filter((l: any) => l.status === DbLotStatus.QUEUED)
    .slice(0, 12)
    .map((l: any) => ({
      id: l.id,
      playerId: l.playerId,
      roundNumber: l.roundNumber ?? 1,
      fullName: l.player?.fullName || 'Unknown',
      nationality: l.player?.nationality ?? null,
      isOverseas: !!l.player?.isOverseas,
      playingRole: (l.player?.playingRole || CricketRole.ALL_ROUNDER) as CricketRole,
      sequenceOrder: l.sequenceOrder,
      setCategory: l.setCategory,
      basePriceLakhs: l.basePriceLakhs,
      status: l.status as LotStatus
    }));

  const recentResults: AuctionResultItemDto[] = lots
    .filter(
      (l: any) =>
        l.status === DbLotStatus.SOLD ||
        l.status === DbLotStatus.UNSOLD ||
        l.status === DbLotStatus.SKIPPED
    )
    .sort((a: any, b: any) => {
      const ta = a.settledAt ? new Date(a.settledAt).getTime() : 0;
      const tb = b.settledAt ? new Date(b.settledAt).getTime() : 0;
      return tb - ta;
    })
    .map((l: any) => {
      const winFran = l.winningFranchiseId ? franchiseById.get(l.winningFranchiseId) : null;
      return {
        lotId: l.id,
        playerId: l.playerId,
        playerName: l.player?.fullName || 'Unknown',
        playingRole: (l.player?.playingRole || CricketRole.ALL_ROUNDER) as CricketRole,
        isOverseas: !!l.player?.isOverseas,
        status: l.status as LotStatus,
        soldPriceLakhs: l.status === DbLotStatus.SOLD ? l.currentBidLakhs : null,
        franchiseCode: winFran?.presetCode || null,
        franchiseDisplayName: winFran
          ? formatFranchiseDisplayName(winFran.name, winFran.presetCode, winFran.customSuffix, allowCustom)
          : null,
        franchiseColor: winFran?.primaryColor || null,
        settledAt: l.settledAt ? l.settledAt.toISOString() : null
      };
    });

  const allBids: AuctionBidDto[] = lots
    .flatMap((l: any) =>
      (l.bids || []).map((b: any) => {
        const fran = franchiseById.get(b.franchiseId);
        const bidder = participantById.get(b.participantId);
        return {
          id: b.id,
          lotId: b.lotId,
          playerName: l.player?.fullName || 'Unknown',
          roundNumber: b.roundNumber ?? l.roundNumber ?? 1,
          franchiseId: b.franchiseId,
          franchiseCode: fran?.presetCode || '',
          franchiseDisplayName: fran
            ? formatFranchiseDisplayName(fran.name, fran.presetCode, fran.customSuffix, allowCustom)
            : '',
          franchiseColor: fran?.primaryColor || '#38BDF8',
          participantId: b.participantId,
          bidderDisplayName: bidder?.displayName || 'Owner',
          bidAmountLakhs: b.bidAmountLakhs,
          sequenceNumber: b.sequenceNumber,
          createdAt: b.createdAt.toISOString()
        };
      })
    )
    .sort((a: AuctionBidDto, b: AuctionBidDto) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 250);

  const unsoldCount = lots.filter((l: any) => l.status === DbLotStatus.UNSOLD).length;
  const currentRound = lots.reduce(
    (maxR: number, l: any) => Math.max(maxR, l.roundNumber ?? 1),
    1
  );

  return {
    roomId: room.id,
    roomCode: room.code,
    roomName: room.name,
    roomStatus: room.status as RoomStatus,
    auctionStage,
    currentRound,
    unsoldCount,
    version: room.version,
    hostParticipantId: room.hostParticipantId,
    isPaused: !!room.isPaused,
    settings: {
      auctionMode: room.auctionMode,
      initialPurseLakhs: room.initialPurseLakhs,
      minSquadSize: room.minSquadSize,
      maxSquadSize: room.maxSquadSize,
      maxOverseas: room.maxOverseas,
      maxSpectators: room.maxSpectators,
      minOwnersRequired: room.minOwnersRequired,
      defaultBasePriceLakhs: room.defaultBasePriceLakhs,
      bidIncrementTiers: bidTiers,
      countdownSeconds: room.countdownSeconds,
      allowLateBidExtension: room.allowLateBidExtension,
      bidExtensionSeconds: room.bidExtensionSeconds,
      extensionThresholdSeconds: room.extensionThresholdSeconds,
      allowHostSkip: room.allowHostSkip,
      allowTeamPurseAdjustments: room.allowTeamPurseAdjustments,
      allowPlayerTrades: !!room.allowPlayerTrades,
      allowCustomTeamName: !!room.allowCustomTeamName,
      allowLateJoin: room.allowLateJoin ?? true,
      retentionEnabled: room.retentionEnabled,
      maxRetentionsPerFranchise: room.maxRetentionsPerFranchise,
      maxOverseasRetentions: room.maxOverseasRetentions
    },
    currentLot,
    timer: {
      lotId: currentLot?.id || null,
      deadlineMs,
      remainingSeconds,
      isPaused: !!room.isPaused || room.status === DbRoomStatus.PAUSED,
      serverTimeMs: nowMs
    },
    franchises,
    participants: activeParticipants.map((p: any) => ({
      id: p.id,
      guestSessionId: p.guestSessionId,
      displayName: p.displayName,
      role: p.role as RoomRole,
      franchiseId: p.franchiseId,
      franchiseCode: p.franchiseId ? franchiseById.get(p.franchiseId)?.presetCode || null : null,
      isReady: p.isReady,
      isConnected: p.isConnected,
      isChatMuted: !!p.isChatMuted,
      joinedAt: p.joinedAt.toISOString()
    })),
    upNextLots,
    recentResults,
    allBids,
    chatEnabled: room.chatEnabled ?? true,
    spectatorChatEnabled: room.spectatorChatEnabled ?? false,
    seasonCode: room.season?.code ?? null,
    seasonName: room.season?.name ?? null,
    seasonMonthLabel: room.seasonMonthLabel ?? null,
    serverTimeMs: nowMs
  };
}
