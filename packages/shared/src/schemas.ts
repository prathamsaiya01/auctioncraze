import { z } from 'zod';
import { AuctionMode, CricketRole, RoomRole, RoomVisibility } from './enums';
import { FRANCHISE_CODES } from './franchises';
import { ROOM_DEFAULTS } from './constants';

export const displayNameSchema = z
  .string()
  .trim()
  .min(2, 'Display name must be at least 2 characters')
  .max(28, 'Display name cannot exceed 28 characters')
  .regex(/^[a-zA-Z0-9 _.-]+$/, 'Display name may only contain letters, numbers, spaces, _, -, and .');

export const createGuestSessionSchema = z.object({
  displayName: displayNameSchema
});

export const updateGuestSessionSchema = z.object({
  displayName: displayNameSchema
});

export const bidTierSchema = z
  .object({
    minAmount: z.number().int().min(1, 'Tier minimum must be at least 1 Lakh'),
    maxAmount: z.number().int().min(2, 'Tier maximum must be at least 2 Lakhs'),
    increment: z.number().int().min(1, 'Tier increment must be at least 1 Lakh')
  })
  .refine((t) => t.maxAmount > t.minAmount, {
    message: 'Tier maxAmount must be strictly greater than minAmount',
    path: ['maxAmount']
  });

export const bidTiersSchema = z
  .array(bidTierSchema)
  .min(1, 'At least 1 bid increment tier is required')
  .max(12, 'Maximum 12 bid increment tiers allowed')
  .superRefine((tiers, ctx) => {
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].minAmount <= tiers[i - 1].maxAmount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Tier ${i + 1} minAmount (${tiers[i].minAmount}) must be greater than Tier ${i} maxAmount (${tiers[i - 1].maxAmount})`,
          path: [i, 'minAmount']
        });
      }
    }
  });

export const roomSettingsSchema = z
  .object({
    initialPurseLakhs: z
      .number()
      .int()
      .min(1000, 'Minimum purse is 10 Cr (1000 Lakhs)')
      .max(50000, 'Maximum purse is 500 Cr (50000 Lakhs)')
      .default(ROOM_DEFAULTS.INITIAL_PURSE_LAKHS),
    minSquadSize: z.number().int().min(1).max(25).default(ROOM_DEFAULTS.MIN_SQUAD_SIZE),
    maxSquadSize: z.number().int().min(1).max(30).default(ROOM_DEFAULTS.MAX_SQUAD_SIZE),
    maxOverseas: z.number().int().min(0).max(15).default(ROOM_DEFAULTS.MAX_OVERSEAS),
    maxSpectators: z.number().int().min(0).max(100).default(ROOM_DEFAULTS.MAX_SPECTATORS),
    countdownSeconds: z.number().int().min(5).max(120).default(ROOM_DEFAULTS.COUNTDOWN_SECONDS),
    bidExtensionSeconds: z.number().int().min(0).max(60).default(ROOM_DEFAULTS.BID_EXTENSION_SECONDS),
    extensionThresholdSeconds: z
      .number()
      .int()
      .min(1)
      .max(30)
      .default(ROOM_DEFAULTS.EXTENSION_THRESHOLD_SECONDS),
    allowHostSkip: z.boolean().default(true),
    allowPlayerTrades: z.boolean().default(ROOM_DEFAULTS.ALLOW_PLAYER_TRADES),
    allowCustomTeamName: z.boolean().default(ROOM_DEFAULTS.ALLOW_CUSTOM_TEAM_NAME),
    allowLateJoin: z.boolean().default(ROOM_DEFAULTS.ALLOW_LATE_JOIN)
  })
  .refine((data) => data.maxSquadSize >= data.minSquadSize, {
    message: 'Maximum squad size must be greater than or equal to minimum squad size',
    path: ['maxSquadSize']
  })
  .refine((data) => data.maxOverseas <= data.maxSquadSize, {
    message: 'Maximum overseas players cannot exceed maximum squad size',
    path: ['maxOverseas']
  });

export const updateAuctionConfigSchema = z
  .object({
    auctionMode: z.nativeEnum(AuctionMode),
    visibility: z.nativeEnum(RoomVisibility).optional(),
    initialPurseLakhs: z.number().int().min(1000).max(50000),
    minSquadSize: z.number().int().min(1).max(25),
    maxSquadSize: z.number().int().min(1).max(30),
    maxOverseas: z.number().int().min(0).max(15),
    maxSpectators: z.number().int().min(0).max(100),
    minOwnersRequired: z.number().int().min(2).max(10),
    defaultBasePriceLakhs: z.number().int().min(5).max(2000),
    bidIncrementTiers: bidTiersSchema,
    countdownSeconds: z.number().int().min(5).max(120),
    allowLateBidExtension: z.boolean(),
    bidExtensionSeconds: z.number().int().min(0).max(60),
    extensionThresholdSeconds: z.number().int().min(1).max(30),
    allowHostSkip: z.boolean(),
    allowTeamPurseAdjustments: z.boolean(),
    allowPlayerTrades: z.boolean().optional(),
    allowCustomTeamName: z.boolean().optional(),
    allowLateJoin: z.boolean().optional(),
    retentionEnabled: z.boolean(),
    maxRetentionsPerFranchise: z.number().int().min(0).max(10),
    maxOverseasRetentions: z.number().int().min(0).max(10),
    franchisePurseAdjustments: z
      .array(
        z.object({
          franchiseCode: z.string().refine((code) => FRANCHISE_CODES.includes(code)),
          adjustmentLakhs: z.number().int().min(-5000).max(10000)
        })
      )
      .optional()
  })
  .refine((d) => d.maxSquadSize >= d.minSquadSize, {
    message: 'Maximum squad size must be greater than or equal to minimum squad size',
    path: ['maxSquadSize']
  })
  .refine((d) => d.maxOverseas <= d.maxSquadSize, {
    message: 'Maximum overseas players cannot exceed maximum squad size',
    path: ['maxOverseas']
  })
  .refine((d) => d.maxRetentionsPerFranchise <= d.maxSquadSize, {
    message: 'Max retentions per franchise cannot exceed maximum squad size',
    path: ['maxRetentionsPerFranchise']
  })
  .refine((d) => d.maxOverseasRetentions <= d.maxRetentionsPerFranchise, {
    message: 'Max overseas retentions cannot exceed max retentions per franchise',
    path: ['maxOverseasRetentions']
  })
  .refine((d) => d.maxOverseasRetentions <= d.maxOverseas, {
    message: 'Max overseas retentions cannot exceed max overseas squad limit',
    path: ['maxOverseasRetentions']
  })
  .refine((d) => d.extensionThresholdSeconds <= d.countdownSeconds, {
    message: 'Late bid threshold cannot exceed countdown seconds',
    path: ['extensionThresholdSeconds']
  });

export const configurePlayerPoolSchema = z.object({
  lots: z
    .array(
      z.object({
        playerId: z.string().uuid('Invalid player ID'),
        setCategory: z.string().trim().min(1).max(40).default('Marquee'),
        basePriceLakhs: z.number().int().min(5).max(5000),
        sequenceOrder: z.number().int().min(1)
      })
    )
    .max(500)
});

export const autoFillPoolSchema = z.object({
  roles: z.array(z.nativeEnum(CricketRole)).optional(),
  includeOverseas: z.boolean().default(true),
  includeDomestic: z.boolean().default(true),
  useDefaultBasePrice: z.boolean().default(false)
});

export const addRetentionSchema = z.object({
  franchiseCode: z.string().refine((code) => FRANCHISE_CODES.includes(code), {
    message: 'Invalid franchise code'
  }),
  playerId: z.string().uuid('Invalid player ID'),
  retentionCostLakhs: z.number().int().min(1).max(50000)
});

export const createRoomSchema = z.object({
  roomName: z
    .string()
    .trim()
    .min(3, 'Room name must be at least 3 characters')
    .max(50, 'Room name cannot exceed 50 characters'),
  displayName: displayNameSchema.optional(),
  franchiseCode: z.string().refine((code) => FRANCHISE_CODES.includes(code), {
    message: 'Invalid IPL franchise selection'
  }),
  visibility: z.nativeEnum(RoomVisibility).default(RoomVisibility.PUBLIC),
  auctionMode: z.nativeEnum(AuctionMode).default(AuctionMode.MEGA),
  settings: roomSettingsSchema.default({})
});

export const joinRoomSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    joinAs: z.enum([RoomRole.OWNER, RoomRole.SPECTATOR]).default(RoomRole.OWNER),
    franchiseCode: z
      .string()
      .refine((code) => FRANCHISE_CODES.includes(code), {
        message: 'Invalid IPL franchise selection'
      })
      .optional(),
    inviteToken: z.string().trim().min(8).max(128).optional()
  })
  .refine(
    (data) => data.joinAs === RoomRole.SPECTATOR || (data.joinAs === RoomRole.OWNER && !!data.franchiseCode),
    {
      message: 'Selecting an IPL franchise is required when joining as a team owner',
      path: ['franchiseCode']
    }
  );

export const claimFranchiseSchema = z.object({
  franchiseCode: z
    .string()
    .refine((code) => FRANCHISE_CODES.includes(code), {
      message: 'Invalid IPL franchise selection'
    })
    .nullable()
});

export const setReadySchema = z.object({
  isReady: z.boolean()
});

export const kickParticipantSchema = z.object({
  participantId: z.string().uuid('Invalid participant ID')
});

export const transferHostSchema = z.object({
  targetParticipantId: z.string().uuid('Invalid target participant ID')
});

export const updateRoomSettingsSchema = z.object({
  visibility: z.nativeEnum(RoomVisibility).optional(),
  settings: roomSettingsSchema
});

export const roomCodeParamSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{4,12}$/, 'Invalid room code format')
});

export const placeBidSchema = z.object({
  lotId: z.string().uuid('Invalid lot ID'),
  bidAmountLakhs: z.number().int().positive('Bid amount must be positive'),
  idempotencyKey: z.string().trim().min(6).max(128)
});

export const resolveLotSchema = z.object({
  lotId: z.string().uuid('Invalid lot ID')
});

export const extendTimerSchema = z.object({
  extraSeconds: z.number().int().min(3).max(60).default(10)
});

export const requeueUnsoldSchema = z.object({
  lotIds: z.array(z.string().uuid('Invalid lot ID')).max(500).optional()
});

export const csvImportSchema = z.object({
  importMode: z.enum(['PLAYERS', 'SEASONS']),
  csvText: z.string().min(10, 'CSV content cannot be empty').max(5_000_000, 'CSV exceeds 5MB limit'),
  sourceName: z.string().trim().min(2).max(120).default('csv_upload'),
  fileName: z.string().trim().max(180).optional(),
  provenanceNotes: z.string().trim().max(500).optional()
});

// -------------------------------------------------------------
// PHASE 6D: TRADING, CUSTOM TEAM IDENTITY & LIVE ROOM CONTROLS
// -------------------------------------------------------------

const BLOCKED_NICKNAME_TERMS = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'dick',
  'cunt',
  'slut',
  'whore',
  'nigger',
  'faggot'
] as const;

export function containsOffensiveNickname(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  return BLOCKED_NICKNAME_TERMS.some((term) => normalized.includes(term));
}

export const customSuffixSchema = z
  .string()
  .trim()
  .transform((val) => val.replace(/\s+/g, ' '))
  .refine((val) => val.length >= 2, 'Team nickname must be at least 2 characters')
  .refine(
    (val) => val.length <= ROOM_DEFAULTS.CUSTOM_TEAM_NAME_MAX_LENGTH,
    `Team nickname cannot exceed ${ROOM_DEFAULTS.CUSTOM_TEAM_NAME_MAX_LENGTH} characters`
  )
  .refine(
    (val) => /^[a-zA-Z0-9 .'-]+$/.test(val),
    'Team nickname may only contain letters, numbers, spaces, periods, hyphens, and apostrophes'
  )
  .refine(
    (val) => !containsOffensiveNickname(val),
    'Team nickname contains disallowed language'
  );

export const updateFranchiseNicknameSchema = z.object({
  customSuffix: z.union([customSuffixSchema, z.null()])
});

export const updateLiveSettingsSchema = z
  .object({
    allowPlayerTrades: z.boolean().optional(),
    allowCustomTeamName: z.boolean().optional(),
    allowLateJoin: z.boolean().optional()
  })
  .refine(
    (d) =>
      d.allowPlayerTrades !== undefined ||
      d.allowCustomTeamName !== undefined ||
      d.allowLateJoin !== undefined,
    { message: 'At least one room feature setting must be provided' }
  );

export const createTradeProposalSchema = z
  .object({
    receiverFranchiseId: z.string().uuid('Invalid receiver franchise ID'),
    outgoingPlayerIds: z
      .array(z.string().uuid('Invalid outgoing player ID'))
      .min(1, 'Select at least 1 player from your squad to offer')
      .max(10, 'Maximum 10 outgoing players per trade'),
    incomingPlayerIds: z
      .array(z.string().uuid('Invalid incoming player ID'))
      .min(1, 'Select at least 1 player to request in return')
      .max(10, 'Maximum 10 incoming players per trade'),
    note: z.string().trim().max(180, 'Trade note cannot exceed 180 characters').optional(),
    expiresInMinutes: z.number().int().min(1).max(1440).default(15),
    idempotencyKey: z.string().trim().min(6).max(128)
  })
  .refine(
    (d) => new Set(d.outgoingPlayerIds).size === d.outgoingPlayerIds.length,
    { message: 'Duplicate outgoing players are not allowed', path: ['outgoingPlayerIds'] }
  )
  .refine(
    (d) => new Set(d.incomingPlayerIds).size === d.incomingPlayerIds.length,
    { message: 'Duplicate incoming players are not allowed', path: ['incomingPlayerIds'] }
  )
  .refine(
    (d) => !d.outgoingPlayerIds.some((id) => d.incomingPlayerIds.includes(id)),
    { message: 'A player cannot appear on both sides of the same trade', path: ['incomingPlayerIds'] }
  );

export const respondTradeSchema = z.object({
  idempotencyKey: z.string().trim().min(6).max(128).optional()
});
