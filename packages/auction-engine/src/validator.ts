import { LotStatus, RoomStatus } from '@auctioncraze/shared';
import { BidTierRule, calculateNextBidLakhs } from './increment';

export interface BidValidationContext {
  roomStatus: RoomStatus;
  isPaused: boolean;
  lotStatus: LotStatus;
  biddingDeadlineMs: number | null;
  nowMs: number;
  currentBidLakhs: number;
  basePriceLakhs: number;
  bidAmountLakhs: number;
  highestBidderFranchiseId?: string | null;
  franchiseId: string;
  remainingPurseLakhs: number;
  squadCount: number;
  overseasCount: number;
  playerIsOverseas: boolean;
  minSquadSize: number;
  maxSquadSize: number;
  maxOverseas: number;
  minReservePerSlotLakhs?: number;
  customTiers?: readonly BidTierRule[];
}

export interface ValidationResult {
  isValid: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export function validateBid(ctx: BidValidationContext): ValidationResult {
  if (ctx.roomStatus !== RoomStatus.LIVE) {
    return {
      isValid: false,
      errorCode: 'AUCTION_NOT_LIVE',
      errorMessage: `Auction is currently ${ctx.roomStatus}. Bidding is not open.`
    };
  }

  if (ctx.isPaused) {
    return {
      isValid: false,
      errorCode: 'AUCTION_PAUSED',
      errorMessage: 'Auction is paused by the host.'
    };
  }

  if (ctx.lotStatus === LotStatus.BIDDING_CLOSED) {
    return {
      isValid: false,
      errorCode: 'BIDDING_CLOSED',
      errorMessage: 'Bidding has closed for this player. Awaiting host decision.'
    };
  }

  if (ctx.lotStatus !== LotStatus.ACTIVE) {
    return {
      isValid: false,
      errorCode: 'LOT_NOT_ACTIVE',
      errorMessage: `Player lot is ${ctx.lotStatus}, not open for bidding.`
    };
  }

  if (ctx.biddingDeadlineMs !== null && ctx.nowMs > ctx.biddingDeadlineMs) {
    return {
      isValid: false,
      errorCode: 'TIMER_EXPIRED',
      errorMessage: 'Countdown has expired. Bidding is closed.'
    };
  }

  if (ctx.highestBidderFranchiseId && ctx.highestBidderFranchiseId === ctx.franchiseId) {
    return {
      isValid: false,
      errorCode: 'ALREADY_HIGHEST_BIDDER',
      errorMessage: 'Your franchise already holds the highest bid.'
    };
  }

  if (ctx.squadCount >= ctx.maxSquadSize) {
    return {
      isValid: false,
      errorCode: 'MAX_SQUAD_REACHED',
      errorMessage: `Squad limit reached (${ctx.squadCount}/${ctx.maxSquadSize}).`
    };
  }

  if (ctx.playerIsOverseas && ctx.overseasCount >= ctx.maxOverseas) {
    return {
      isValid: false,
      errorCode: 'MAX_OVERSEAS_REACHED',
      errorMessage: `Overseas player limit reached (${ctx.overseasCount}/${ctx.maxOverseas}).`
    };
  }

  const { nextBidLakhs } = calculateNextBidLakhs(
    ctx.currentBidLakhs,
    ctx.basePriceLakhs,
    ctx.customTiers
  );

  if (ctx.bidAmountLakhs < nextBidLakhs) {
    return {
      isValid: false,
      errorCode: 'BID_TOO_LOW',
      errorMessage: `Bid must be at least ${nextBidLakhs} Lakhs.`
    };
  }

  if (ctx.bidAmountLakhs > ctx.remainingPurseLakhs) {
    return {
      isValid: false,
      errorCode: 'INSUFFICIENT_PURSE',
      errorMessage: `Insufficient purse (${ctx.remainingPurseLakhs}L available, ${ctx.bidAmountLakhs}L required).`
    };
  }

  const slotsNeededAfter = Math.max(0, ctx.minSquadSize - (ctx.squadCount + 1));
  const minReserve = ctx.minReservePerSlotLakhs ?? 20;
  const requiredReserve = slotsNeededAfter * minReserve;

  if (slotsNeededAfter > 0 && ctx.remainingPurseLakhs - ctx.bidAmountLakhs < requiredReserve) {
    return {
      isValid: false,
      errorCode: 'RESERVE_PURSE_EXCEEDED',
      errorMessage: `Must reserve at least ${requiredReserve}L to fill the remaining ${slotsNeededAfter} mandatory squad slots.`
    };
  }

  return { isValid: true };
}
