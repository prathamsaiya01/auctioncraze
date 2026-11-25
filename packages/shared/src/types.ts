import { AuctionMode, CricketRole, LotStatus, RoomRole, RoomStatus, RoomVisibility } from './enums';
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
  retentionEnabled: boolean;
  maxRetentionsPerFranchise: number;
  maxOverseasRetentions: number;
}

export interface MasterPlayerCatalogDto {
  id: string;
  externalKey: string | null;
  fullName: string;
  nationality: string;
  isOverseas: boolean;
  age: number | null;
  playingRole: CricketRole;
  battingStyle: string;
  bowlingStyle: string;
  basePriceLakhs: number;
  imageUrl: string | null;
}

export interface RoomPlayerLotDto {
  id: string;
  playerId: string;
  fullName: string;
  nationality: string;
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
  nationality: string;
  isOverseas: boolean;
  playingRole: CricketRole;
  priceLakhs: number;
  acquisitionType: 'RETAINED' | 'AUCTION';
}

export interface AuctionFranchiseStateDto {
  id: string;
  presetCode: string;
  name: string;
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
  franchiseId: string;
  franchiseCode: string;
  franchiseColor: string;
  participantId: string;
  bidderDisplayName: string;
  bidAmountLakhs: number;
  sequenceNumber: number;
  createdAt: string;
}

export interface ActiveLotDetailDto {
  id: string;
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
  winningFranchiseColor: string | null;
  winningOwnerName: string | null;
  player: {
    id: string;
    fullName: string;
    nationality: string;
    isOverseas: boolean;
    age: number | null;
    playingRole: CricketRole;
    battingStyle: string;
    bowlingStyle: string;
    imageUrl: string | null;
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
  franchiseColor: string | null;
  settledAt: string | null;
}

export interface AuctionStateSnapshotDto {
  roomId: string;
  roomCode: string;
  roomName: string;
  roomStatus: RoomStatus;
  auctionStage: AuctionStage;
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
  serverTimeMs: number;
}
