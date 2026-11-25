import { BidTierConfig } from '@auctioncraze/shared';
import { validateBidTiers } from './increment';

export interface AuctionConfigurationInput {
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
  bidIncrementTiers: readonly BidTierConfig[];
}

export function validateAuctionConfiguration(cfg: AuctionConfigurationInput): {
  isValid: boolean;
  errorMessage?: string;
} {
  if (cfg.initialPurseLakhs < 1000 || cfg.initialPurseLakhs > 50000) {
    return { isValid: false, errorMessage: 'Total purse must be between 10 Cr and 500 Cr.' };
  }
  if (cfg.minSquadSize < 1 || cfg.maxSquadSize < cfg.minSquadSize || cfg.maxSquadSize > 30) {
    return { isValid: false, errorMessage: 'Squad limits must satisfy 1 <= minSquad <= maxSquad <= 30.' };
  }
  if (cfg.maxOverseas < 0 || cfg.maxOverseas > cfg.maxSquadSize) {
    return { isValid: false, errorMessage: 'Max overseas players cannot exceed max squad size.' };
  }
  if (cfg.minOwnersRequired < 1 || cfg.minOwnersRequired > 10) {
    return { isValid: false, errorMessage: 'Minimum owners required must be between 1 and 10.' };
  }
  if (cfg.defaultBasePriceLakhs < 5 || cfg.defaultBasePriceLakhs > cfg.initialPurseLakhs) {
    return { isValid: false, errorMessage: 'Default base price must be between 5L and total purse.' };
  }
  if (cfg.countdownSeconds < 5 || cfg.countdownSeconds > 120) {
    return { isValid: false, errorMessage: 'Countdown timer must be between 5 and 120 seconds.' };
  }
  if (cfg.allowLateBidExtension) {
    if (cfg.bidExtensionSeconds < 0 || cfg.bidExtensionSeconds > 60) {
      return { isValid: false, errorMessage: 'Countdown extension must be between 0 and 60 seconds.' };
    }
    if (cfg.extensionThresholdSeconds < 1 || cfg.extensionThresholdSeconds > cfg.countdownSeconds) {
      return { isValid: false, errorMessage: 'Late-bid extension threshold cannot exceed countdown duration.' };
    }
  }
  if (cfg.retentionEnabled) {
    if (cfg.maxRetentionsPerFranchise < 0 || cfg.maxRetentionsPerFranchise > cfg.maxSquadSize) {
      return { isValid: false, errorMessage: 'Max retentions per franchise cannot exceed max squad size.' };
    }
    if (
      cfg.maxOverseasRetentions < 0 ||
      cfg.maxOverseasRetentions > cfg.maxRetentionsPerFranchise ||
      cfg.maxOverseasRetentions > cfg.maxOverseas
    ) {
      return {
        isValid: false,
        errorMessage: 'Max overseas retentions cannot exceed max retentions or max overseas limit.'
      };
    }
  }

  return validateBidTiers(cfg.bidIncrementTiers);
}
