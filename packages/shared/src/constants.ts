import { AuctionMode } from './enums';

export const SOCKET_EVENTS = {
  // Client -> Server Lobby
  ROOM_JOIN: 'room:join',
  ROOM_JOINED: 'room:joined',
  ROOM_LEAVE: 'room:leave',

  // Server -> Client Lobby Events (Phase 2)
  ROOM_STATE: 'ROOM_STATE',
  PARTICIPANT_JOINED: 'PARTICIPANT_JOINED',
  PARTICIPANT_LEFT: 'PARTICIPANT_LEFT',
  FRANCHISE_CLAIMED: 'FRANCHISE_CLAIMED',
  FRANCHISE_RELEASED: 'FRANCHISE_RELEASED',
  PARTICIPANT_READY: 'PARTICIPANT_READY',
  PARTICIPANT_NOT_READY: 'PARTICIPANT_NOT_READY',
  HOST_CHANGED: 'HOST_CHANGED',
  PARTICIPANT_KICKED: 'PARTICIPANT_KICKED',
  ROOM_SETTINGS_UPDATED: 'ROOM_SETTINGS_UPDATED',

  // Pre-Auction Configuration & Readiness Events (Phase 3)
  AUCTION_CONFIG_UPDATED: 'AUCTION_CONFIG_UPDATED',
  AUCTION_CONFIG_FINALIZED: 'AUCTION_CONFIG_FINALIZED',
  AUCTION_READINESS_CHANGED: 'AUCTION_READINESS_CHANGED',

  // Auction Lifecycle (Separated Events for Phases 4-5)
  AUCTION_STARTED: 'auction:started',
  AUCTION_PAUSED: 'auction:paused',
  AUCTION_RESUMED: 'auction:resumed',
  AUCTION_COMPLETED: 'auction:completed',
  PLAYER_ANNOUNCED: 'player:announced',
  BID_SUBMIT: 'bid:submit',
  BID_PLACED: 'bid:placed',
  BID_REJECTED: 'bid:rejected',
  BIDDING_CLOSED: 'bidding:closed',
  PLAYER_SOLD: 'player:sold',
  PLAYER_UNSOLD: 'player:unsold',
  PURSE_UPDATED: 'purse:updated',
  SQUAD_UPDATED: 'squad:updated',

  // Social
  CHAT_SEND: 'chat:send',
  CHAT_MESSAGE: 'chat:message',
  REACTION_SEND: 'reaction:send',
  REACTION_BROADCAST: 'reaction:broadcast',

  // Errors
  ROOM_ERROR: 'room:error'
} as const;

export const SOCKET_ROOMS = {
  room: (roomCode: string) => `room:${roomCode.toUpperCase()}`,
  participant: (participantId: string) => `participant:${participantId}`
} as const;

export interface BidTierConfig {
  minAmount: number;
  maxAmount: number;
  increment: number;
}

// Default IPL-style increment tiers (in INR Lakhs; 100 Lakhs = 1 Cr, 10000 Lakhs = 100 Cr)
export const DEFAULT_BID_TIERS_LAKHS: readonly BidTierConfig[] = [
  { minAmount: 20, maxAmount: 99, increment: 5 },
  { minAmount: 100, maxAmount: 199, increment: 10 },
  { minAmount: 200, maxAmount: 499, increment: 20 },
  { minAmount: 500, maxAmount: 999, increment: 25 },
  { minAmount: 1000, maxAmount: 100000, increment: 50 }
] as const;

export const ROOM_DEFAULTS = {
  INITIAL_PURSE_LAKHS: 10000, // 100 Cr
  MIN_SQUAD_SIZE: 15,
  MAX_SQUAD_SIZE: 25,
  MAX_OVERSEAS: 8,
  MAX_SPECTATORS: 20,
  MIN_OWNERS_REQUIRED: 2,
  DEFAULT_BASE_PRICE_LAKHS: 50,
  COUNTDOWN_SECONDS: 20,
  BID_EXTENSION_SECONDS: 10,
  EXTENSION_THRESHOLD_SECONDS: 5,
  MAX_RETENTIONS_PER_FRANCHISE: 4,
  MAX_OVERSEAS_RETENTIONS: 2
} as const;

export const AUCTION_MODE_PRESETS: Record<
  AuctionMode,
  {
    label: string;
    description: string;
    initialPurseLakhs: number;
    minSquadSize: number;
    maxSquadSize: number;
    maxOverseas: number;
    minOwnersRequired: number;
    defaultBasePriceLakhs: number;
    countdownSeconds: number;
    allowLateBidExtension: boolean;
    bidExtensionSeconds: number;
    extensionThresholdSeconds: number;
    retentionEnabled: boolean;
    maxRetentionsPerFranchise: number;
    maxOverseasRetentions: number;
    allowTeamPurseAdjustments: boolean;
    bidIncrementTiers: BidTierConfig[];
  }
> = {
  [AuctionMode.MOCK]: {
    label: 'Mock Auction',
    description: 'Fast-paced practice auction with shorter timers and flexible squad requirements.',
    initialPurseLakhs: 10000,
    minSquadSize: 11,
    maxSquadSize: 20,
    maxOverseas: 6,
    minOwnersRequired: 2,
    defaultBasePriceLakhs: 50,
    countdownSeconds: 15,
    allowLateBidExtension: true,
    bidExtensionSeconds: 8,
    extensionThresholdSeconds: 4,
    retentionEnabled: false,
    maxRetentionsPerFranchise: 2,
    maxOverseasRetentions: 1,
    allowTeamPurseAdjustments: false,
    bidIncrementTiers: [...DEFAULT_BID_TIERS_LAKHS]
  },
  [AuctionMode.MEGA]: {
    label: 'Mega Auction',
    description: 'Full-scale franchise rebuild with optional player retentions and standard purse rules.',
    initialPurseLakhs: 12000,
    minSquadSize: 18,
    maxSquadSize: 25,
    maxOverseas: 8,
    minOwnersRequired: 2,
    defaultBasePriceLakhs: 50,
    countdownSeconds: 20,
    allowLateBidExtension: true,
    bidExtensionSeconds: 10,
    extensionThresholdSeconds: 5,
    retentionEnabled: true,
    maxRetentionsPerFranchise: 4,
    maxOverseasRetentions: 2,
    allowTeamPurseAdjustments: false,
    bidIncrementTiers: [...DEFAULT_BID_TIERS_LAKHS]
  },
  [AuctionMode.CUSTOM]: {
    label: 'Custom Auction',
    description: 'Fully customizable rules including per-franchise purse adjustments and custom tiers.',
    initialPurseLakhs: 10000,
    minSquadSize: 12,
    maxSquadSize: 25,
    maxOverseas: 8,
    minOwnersRequired: 1,
    defaultBasePriceLakhs: 30,
    countdownSeconds: 20,
    allowLateBidExtension: true,
    bidExtensionSeconds: 10,
    extensionThresholdSeconds: 5,
    retentionEnabled: true,
    maxRetentionsPerFranchise: 5,
    maxOverseasRetentions: 3,
    allowTeamPurseAdjustments: true,
    bidIncrementTiers: [...DEFAULT_BID_TIERS_LAKHS]
  }
};
