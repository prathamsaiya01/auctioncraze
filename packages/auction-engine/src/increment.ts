import { BidTierConfig, DEFAULT_BID_TIERS_LAKHS } from '@auctioncraze/shared';

export type BidTierRule = BidTierConfig;

export function validateBidTiers(tiers: readonly BidTierRule[]): {
  isValid: boolean;
  errorMessage?: string;
} {
  if (!tiers || tiers.length === 0) {
    return { isValid: false, errorMessage: 'At least one bid increment tier is required.' };
  }

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    if (!Number.isInteger(tier.minAmount) || !Number.isInteger(tier.maxAmount) || !Number.isInteger(tier.increment)) {
      return { isValid: false, errorMessage: `Tier ${i + 1} values must be whole numbers.` };
    }
    if (tier.minAmount < 1 || tier.increment < 1) {
      return { isValid: false, errorMessage: `Tier ${i + 1} minimum and increment must be positive.` };
    }
    if (tier.maxAmount <= tier.minAmount) {
      return {
        isValid: false,
        errorMessage: `Tier ${i + 1} maximum (${tier.maxAmount}) must exceed minimum (${tier.minAmount}).`
      };
    }
    if (i > 0 && tier.minAmount <= tiers[i - 1].maxAmount) {
      return {
        isValid: false,
        errorMessage: `Tier ${i + 1} overlaps with Tier ${i}. Ranges must be strictly ascending.`
      };
    }
  }

  return { isValid: true };
}

export function calculateNextBidLakhs(
  currentBidLakhs: number,
  basePriceLakhs: number,
  customTiers?: readonly BidTierRule[]
): { nextBidLakhs: number; incrementLakhs: number } {
  if (currentBidLakhs <= 0) {
    return {
      nextBidLakhs: basePriceLakhs,
      incrementLakhs: 0
    };
  }

  const tiers = customTiers && customTiers.length > 0 ? customTiers : DEFAULT_BID_TIERS_LAKHS;
  const matchedTier = tiers.find(
    (t) => currentBidLakhs >= t.minAmount && currentBidLakhs <= t.maxAmount
  );

  const incrementLakhs = matchedTier
    ? matchedTier.increment
    : tiers[tiers.length - 1].increment;

  return {
    nextBidLakhs: currentBidLakhs + incrementLakhs,
    incrementLakhs
  };
}
