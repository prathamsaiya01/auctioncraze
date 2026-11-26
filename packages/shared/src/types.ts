import {
  AuctionMode,
  CricketRole,
  LotStatus,
  RoomRole,
  RoomStatus,
  RoomVisibility,
  TradeDirection,
  TradeStatus
} from './enums';
import { BidTierConfig } from './constants';

export interface GuestSessionDto {
  id: string;
  displayName: string;
  avatarSeed: string;
  expiresAt: string;
}

export interface RoomFranchiseDto {
  id: string;
  presetCode: string;
  name: string;
  customSuffix: string | null;
  displayName: string;
  abbreviation: string;
  primaryColor: string;
  secondaryColor: string;
  initialPurseLakhs: number;
  purseAdjustmentLakhs: number;
  remainingPurseLakhs: number;
  squadCount: number;
  overseasCount: number;
  retainedCount: number;
  claimedByParticipantId: string | null;
  claimedByDisplayName: string | null;
}

export interface RoomParticipantDto {
  id: string;
  guestSessionId: string;
  displayName: string;
  role: RoomRole;
  franchiseId: string | null;
  franchiseCode: string | null;
  isReady: boolean;
  isConnected: boolean;
  joinedAt: string;
}

export interface RoomSettingsDto {
  auctionMode: AuctionMode;
  initialPurseLakhs: number;
  minSquadSize: number;
  maxSquadSize: number;
  maxOverseas: number;
  maxSpectators: number;
  minOwnersRequired: number;
  defaultBasePriceLakhs: number;
  bidIncrementTiers: BidTierConfig[];
  countdownSeconds: number;
  allowLateBidExtension: boolean;
  bidExtensionSeconds: number;
  extensionThresholdSeconds: number;
  allowHostSkip: boolean;
  allowTeamPurseAdjustments: boolean;
  allowPlayerTrades: boolean;
  allowCustomTeamName: boolean;
  allowLateJoin: boolean;
  retentionEnabled: boolean;
  maxRetentionsPerFranchise: number;
  maxOverseasRetentions: number;
}

export interface MasterPlayerCatalogDto {
  id: string;
  externalKey: string | null;
  cricsheetId: string | null;
  cricinfoId: string | null;
  fullName: string;
  nationality: string | null;
  isOverseas: boolean;
  age: number | null;
  playingRole: CricketRole;
  secondaryRole: CricketRole | null;
  battingStyle: string | null;
  bowlingStyle: string | null;
  basePriceLakhs: number;
  imageUrl: string | null;
  iplDebutYear: number | null;
  iplLastYear: number | null;
  teamHistory: string[];
  provenanceSource: string | null;
  seasonCoverage: string | null;
  careerMatches?: number | null;
  careerRuns?: number | null;
  careerWickets?: number | null;
}

export interface RoomPlayerLotDto {
  id: string;
  playerId: string;
  roundNumber: number;
  fullName: string;
  nationality: string | null;
  isOverseas: boolean;
  playingRole: CricketRole;
  sequenceOrder: number;
  setCategory: string;
  basePriceLakhs: number;
  status: LotStatus;
}

export interface RoomRetentionDto {
  id: string;
  franchiseId: string;
  franchiseCode: string;
  playerId: string;
  playerName: string;
  playingRole: CricketRole;
  isOverseas: boolean;
  retentionCostLakhs: number;
  slotNumber: number;
}

export interface ReadinessCheckItem {
  key: string;
  label: string;
  passed: boolean;
  message: string;
}

export interface AuctionReadinessDto {
  isReadyToStart: boolean;
  checks: ReadinessCheckItem[];
}

export interface RoomDetailDto {
  id: string;
  code: string;
  name: string;
  visibility: RoomVisibility;
  inviteToken?: string | null;
  status: RoomStatus;
  hostParticipantId: string | null;
  version: number;
  configFinalized: boolean;
  configFinalizedAt: string | null;
  settings: RoomSettingsDto;
  franchises: RoomFranchiseDto[];
  participants: RoomParticipantDto[];
  lots: RoomPlayerLotDto[];
  retentions: RoomRetentionDto[];
  readiness: AuctionReadinessDto;
  spectatorCount: number;
  createdAt: string;
}

export interface PublicRoomSummaryDto {
  id: string;
  code: string;
  name: string;
  status: RoomStatus;
  auctionMode: AuctionMode;
  hostDisplayName: string;
  occupiedFranchises: number;
  totalFranchises: number;
  spectatorCount: number;
  maxSpectators: number;
  initialPurseLakhs: number;
  countdownSeconds: number;
  createdAt: string;
}

export type AuctionStage =
  | 'CONFIGURING'
  | 'READY'
  | 'LIVE'
  | 'PAUSED'
  | 'BIDDING_CLOSED'
  | 'PLAYER_SOLD'
  | 'PLAYER_UNSOLD'
  | 'COMPLETED';

export interface SquadMemberDto {
  playerId: string;
  fullName: string;
  nationality: string | null;
  isOverseas: boolean;
  playingRole: CricketRole;
  priceLakhs: number;
  acquisitionType: 'RETAINED' | 'AUCTION';
}

export interface AuctionFranchiseStateDto {
  id: string;
  presetCode: string;
  name: string;
  customSuffix: string | null;
  displayName: string;
  abbreviation: string;
  primaryColor: string;
  secondaryColor: string;
  initialPurseLakhs: number;
  purseAdjustmentLakhs: number;
  remainingPurseLakhs: number;
  squadCount: number;
  overseasCount: number;
  retainedCount: number;
  ownerParticipantId: string | null;
  ownerDisplayName: string | null;
  squad: SquadMemberDto[];
}

export interface AuctionBidDto {
  id: string;
  lotId: string;
  playerName?: string;
  roundNumber: number;
  franchiseId: string;
  franchiseCode: string;
  franchiseDisplayName?: string;
  franchiseColor: string;
  participantId: string;
  bidderDisplayName: string;
  bidAmountLakhs: number;
  sequenceNumber: number;
  createdAt: string;
}

export interface ActiveLotDetailDto {
  id: string;
  roundNumber: number;
  sequenceOrder: number;
  totalLots: number;
  setCategory: string;
  status: LotStatus;
  basePriceLakhs: number;
  currentBidLakhs: number;
  nextBidLakhs: number;
  incrementLakhs: number;
  winningFranchiseId: string | null;
  winningFranchiseCode: string | null;
  winningFranchiseName: string | null;
  winningFranchiseDisplayName: string | null;
  winningFranchiseColor: string | null;
  winningOwnerName: string | null;
  player: {
    id: string;
    cricsheetId: string | null;
    fullName: string;
    nationality: string | null;
    isOverseas: boolean;
    age: number | null;
    playingRole: CricketRole;
    secondaryRole: CricketRole | null;
    battingStyle: string | null;
    bowlingStyle: string | null;
    iplDebutYear: number | null;
    iplLastYear: number | null;
    teamHistory: string[];
    imageUrl: string | null;
    provenanceSource: string | null;
  };
  bids: AuctionBidDto[];
}

export interface AuctionTimerDto {
  lotId: string | null;
  deadlineMs: number | null;
  remainingSeconds: number;
  isPaused: boolean;
  serverTimeMs: number;
}

export interface AuctionResultItemDto {
  lotId: string;
  playerId: string;
  playerName: string;
  playingRole: CricketRole;
  isOverseas: boolean;
  status: LotStatus;
  soldPriceLakhs: number | null;
  franchiseCode: string | null;
  franchiseDisplayName?: string | null;
  franchiseColor: string | null;
  settledAt: string | null;
}

export interface AuctionStateSnapshotDto {
  roomId: string;
  roomCode: string;
  roomName: string;
  roomStatus: RoomStatus;
  auctionStage: AuctionStage;
  currentRound: number;
  unsoldCount: number;
  version: number;
  hostParticipantId: string | null;
  isPaused: boolean;
  settings: RoomSettingsDto;
  currentLot: ActiveLotDetailDto | null;
  timer: AuctionTimerDto;
  franchises: AuctionFranchiseStateDto[];
  participants: RoomParticipantDto[];
  upNextLots: RoomPlayerLotDto[];
  recentResults: AuctionResultItemDto[];
  allBids: AuctionBidDto[];
  serverTimeMs: number;
}

// -------------------------------------------------------------
// PHASE 5: PLAYER PROFILES, SEASON STATS & CSV IMPORT CONTRACTS
// -------------------------------------------------------------

export interface PlayerSeasonStatDto {
  id: string;
  season: number;
  teamCode: string | null;
  matches: number | null;
  innings: number | null;
  battingInnings: number | null;
  bowlingInnings: number | null;
  runs: number | null;
  ballsFaced: number | null;
  notOuts: number | null;
  highestScore: number | null;
  highestScoreText: string | null;
  battingAverage: number | null;
  strikeRate: number | null;
  fifties: number | null;
  hundreds: number | null;
  wickets: number | null;
  ballsBowled: number | null;
  runsConceded: number | null;
  bowlingAverage: number | null;
  economy: number | null;
  bowlingStrikeRate: number | null;
  bestBowling: string | null;
  catches: number | null;
  stumpings: number | null;
  provenanceSource: string | null;
}

export interface PlayerCareerSummaryDto {
  seasonsPlayed: number;
  matches: number | null;
  batting: {
    innings: number | null;
    runs: number | null;
    ballsFaced: number | null;
    notOuts: number | null;
    highestScoreText: string | null;
    average: number | null;
    strikeRate: number | null;
    fifties: number | null;
    hundreds: number | null;
  };
  bowling: {
    innings: number | null;
    wickets: number | null;
    ballsBowled: number | null;
    runsConceded: number | null;
    average: number | null;
    economy: number | null;
    strikeRate: number | null;
    bestBowling: string | null;
  };
  fielding: {
    catches: number | null;
    stumpings: number | null;
  };
}

export interface PlayerProfileDetailDto extends MasterPlayerCatalogDto {
  dateOfBirth: string | null;
  careerSummary: PlayerCareerSummaryDto;
  seasonStats: PlayerSeasonStatDto[];
}

export interface CsvImportErrorDto {
  rowNumber: number;
  field?: string;
  message: string;
}

export interface CsvImportPreviewRowDto {
  rowNumber: number;
  action: 'INSERT' | 'UPDATE' | 'DUPLICATE_IN_CSV' | 'ERROR';
  matchedBy?: 'cricsheetId' | 'cricinfoId' | 'externalKey' | 'fullName' | null;
  identityLabel: string;
  season?: number | null;
  summary: string;
}

export interface CsvImportReportDto {
  importMode: 'PLAYERS' | 'SEASONS';
  sourceName: string;
  totalRows: number;
  insertCount: number;
  updateCount: number;
  duplicateCount: number;
  errorCount: number;
  canCommit: boolean;
  errors: CsvImportErrorDto[];
  previewRows: CsvImportPreviewRowDto[];
}

export interface PlayerImportBatchDto {
  id: string;
  sourceName: string;
  fileName: string | null;
  importMode: string;
  status: string;
  totalRows: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  provenanceNotes: string | null;
  createdAt: string;
  rolledBackAt: string | null;
}

// -------------------------------------------------------------
// PHASE 6D: FRANCHISE PLAYER TRADING CONTRACTS
// -------------------------------------------------------------

export interface TradeProposalItemDto {
  id: string;
  playerId: string;
  playerName: string;
  playingRole: CricketRole;
  isOverseas: boolean;
  sourceType: 'AUCTION' | 'RETENTION';
  direction: TradeDirection;
  fromFranchiseId: string;
  fromFranchiseCode: string;
  toFranchiseId: string;
  toFranchiseCode: string;
  priceLakhs: number;
}

export interface TradeProposalDto {
  id: string;
  roomId: string;
  proposerFranchiseId: string;
  proposerFranchiseCode: string;
  proposerFranchiseDisplayName: string;
  receiverFranchiseId: string;
  receiverFranchiseCode: string;
  receiverFranchiseDisplayName: string;
  proposerOwnerName: string;
  receiverOwnerName: string;
  status: TradeStatus;
  note: string | null;
  failureReason: string | null;
  expiresAt: string;
  respondedAt: string | null;
  executedAt: string | null;
  createdAt: string;
  outgoingPlayers: TradeProposalItemDto[];
  incomingPlayers: TradeProposalItemDto[];
}

export interface TradeCenterStateDto {
  roomCode: string;
  allowPlayerTrades: boolean;
  lifecyclePermitsTrading: boolean;
  roomStatus: RoomStatus;
  myFranchiseId: string;
  myFranchiseCode: string;
  myFranchiseDisplayName: string;
  pendingIncoming: TradeProposalDto[];
  pendingOutgoing: TradeProposalDto[];
  history: TradeProposalDto[];
}
