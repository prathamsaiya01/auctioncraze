import assert from 'node:assert/strict';
import { LotStatus, RoomStatus, DEFAULT_BID_TIERS_LAKHS } from '@auctioncraze/shared';
import { calculateNextBidLakhs, validateBidTiers } from './increment';
import { validateBid, BidValidationContext } from './validator';
import { validateAuctionConfiguration, AuctionConfigurationInput } from './configValidator';

function baseCtx(overrides: Partial<BidValidationContext> = {}): BidValidationContext {
  return {
    roomStatus: RoomStatus.LIVE,
    isPaused: false,
    lotStatus: LotStatus.ACTIVE,
    biddingDeadlineMs: Date.now() + 10_000,
    nowMs: Date.now(),
    currentBidLakhs: 0,
    basePriceLakhs: 200,
    bidAmountLakhs: 200,
    highestBidderFranchiseId: null,
    franchiseId: 'fran-1',
    remainingPurseLakhs: 10000,
    squadCount: 0,
    overseasCount: 0,
    playerIsOverseas: false,
    minSquadSize: 15,
    maxSquadSize: 25,
    maxOverseas: 8,
    ...overrides
  };
}

function baseConfig(overrides: Partial<AuctionConfigurationInput> = {}): AuctionConfigurationInput {
  return {
    initialPurseLakhs: 10000,
    minSquadSize: 15,
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
    bidIncrementTiers: DEFAULT_BID_TIERS_LAKHS,
    ...overrides
  };
}

// 1. Opening bid equals base price
const openCalc = calculateNextBidLakhs(0, 200);
assert.equal(openCalc.nextBidLakhs, 200);

// 2. Tiered increments
assert.equal(calculateNextBidLakhs(50, 20).nextBidLakhs, 55);
assert.equal(calculateNextBidLakhs(150, 20).nextBidLakhs, 160);
assert.equal(calculateNextBidLakhs(300, 20).nextBidLakhs, 320);
assert.equal(calculateNextBidLakhs(700, 20).nextBidLakhs, 725);
assert.equal(calculateNextBidLakhs(1200, 20).nextBidLakhs, 1250);

// 3. Valid opening bid
assert.equal(validateBid(baseCtx()).isValid, true);

// 4. Reject BIDDING_CLOSED
const closedRes = validateBid(baseCtx({ lotStatus: LotStatus.BIDDING_CLOSED }));
assert.equal(closedRes.isValid, false);
assert.equal(closedRes.errorCode, 'BIDDING_CLOSED');

// 5. Reject expired timer
const expiredRes = validateBid(baseCtx({ biddingDeadlineMs: 1000, nowMs: 2000 }));
assert.equal(expiredRes.isValid, false);
assert.equal(expiredRes.errorCode, 'TIMER_EXPIRED');

// 6. Reject overseas limit exceeded
const overseasRes = validateBid(
  baseCtx({ playerIsOverseas: true, overseasCount: 8, maxOverseas: 8 })
);
assert.equal(overseasRes.isValid, false);
assert.equal(overseasRes.errorCode, 'MAX_OVERSEAS_REACHED');

// 7. Reject insufficient reserve for remaining squad slots
const reserveRes = validateBid(
  baseCtx({ remainingPurseLakhs: 400, bidAmountLakhs: 200, squadCount: 0, minSquadSize: 15 })
);
assert.equal(reserveRes.isValid, false);
assert.equal(reserveRes.errorCode, 'RESERVE_PURSE_EXCEEDED');

// 8. Bid tier validation (valid & invalid overlapping/zero)
assert.equal(validateBidTiers(DEFAULT_BID_TIERS_LAKHS).isValid, true);
assert.equal(
  validateBidTiers([
    { minAmount: 20, maxAmount: 100, increment: 5 },
    { minAmount: 90, maxAmount: 200, increment: 10 }
  ]).isValid,
  false
);
assert.equal(validateBidTiers([{ minAmount: 50, maxAmount: 40, increment: 5 }]).isValid, false);
assert.equal(validateBidTiers([{ minAmount: 20, maxAmount: 100, increment: 0 }]).isValid, false);

// 9. Auction configuration validation
assert.equal(validateAuctionConfiguration(baseConfig()).isValid, true);
assert.equal(
  validateAuctionConfiguration(baseConfig({ minSquadSize: 20, maxSquadSize: 15 })).isValid,
  false
);
assert.equal(
  validateAuctionConfiguration(baseConfig({ maxOverseasRetentions: 5, maxRetentionsPerFranchise: 4 })).isValid,
  false
);

console.log('✅ @auctioncraze/auction-engine tests passed (14/14 assertions).');
