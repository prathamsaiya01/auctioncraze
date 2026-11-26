-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RoomVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateEnum
CREATE TYPE "RoomStatus" AS ENUM ('LOBBY', 'LIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AuctionMode" AS ENUM ('MOCK', 'MEGA', 'CUSTOM');

-- CreateEnum
CREATE TYPE "RoomRole" AS ENUM ('HOST', 'OWNER', 'SPECTATOR');

-- CreateEnum
CREATE TYPE "LotStatus" AS ENUM ('QUEUED', 'ACTIVE', 'BIDDING_CLOSED', 'SOLD', 'UNSOLD', 'SKIPPED');

-- CreateEnum
CREATE TYPE "CricketRole" AS ENUM ('BATSMAN', 'BOWLER', 'ALL_ROUNDER', 'WICKET_KEEPER');

-- CreateEnum
CREATE TYPE "BattingStyle" AS ENUM ('RIGHT_HAND', 'LEFT_HAND');

-- CreateEnum
CREATE TYPE "BowlingStyle" AS ENUM ('RIGHT_ARM_FAST', 'RIGHT_ARM_MEDIUM', 'RIGHT_ARM_SPIN', 'LEFT_ARM_FAST', 'LEFT_ARM_MEDIUM', 'LEFT_ARM_SPIN', 'NONE');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('INITIAL', 'DEDUCTION', 'RETENTION_DEDUCTION', 'PURSE_ADJUSTMENT', 'REFUND_REVERSAL');

-- CreateEnum
CREATE TYPE "SeasonStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TradeDirection" AS ENUM ('OUTGOING', 'INCOMING');

-- CreateTable
CREATE TABLE "GuestSession" (
    "id" TEXT NOT NULL,
    "tokenSecret" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarSeed" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuestSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Room" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" "RoomVisibility" NOT NULL DEFAULT 'PUBLIC',
    "inviteToken" TEXT,
    "spectatorInviteToken" TEXT,
    "status" "RoomStatus" NOT NULL DEFAULT 'LOBBY',
    "auctionMode" "AuctionMode" NOT NULL DEFAULT 'MEGA',
    "hostParticipantId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "initialPurseLakhs" INTEGER NOT NULL DEFAULT 10000,
    "minSquadSize" INTEGER NOT NULL DEFAULT 15,
    "maxSquadSize" INTEGER NOT NULL DEFAULT 25,
    "maxOverseas" INTEGER NOT NULL DEFAULT 8,
    "maxSpectators" INTEGER NOT NULL DEFAULT 20,
    "minOwnersRequired" INTEGER NOT NULL DEFAULT 2,
    "defaultBasePriceLakhs" INTEGER NOT NULL DEFAULT 50,
    "bidIncrementTiersJson" JSONB,
    "countdownSeconds" INTEGER NOT NULL DEFAULT 20,
    "allowLateBidExtension" BOOLEAN NOT NULL DEFAULT true,
    "bidExtensionSeconds" INTEGER NOT NULL DEFAULT 10,
    "extensionThresholdSeconds" INTEGER NOT NULL DEFAULT 5,
    "allowHostSkip" BOOLEAN NOT NULL DEFAULT true,
    "allowTeamPurseAdjustments" BOOLEAN NOT NULL DEFAULT false,
    "allowPlayerTrades" BOOLEAN NOT NULL DEFAULT false,
    "allowCustomTeamName" BOOLEAN NOT NULL DEFAULT false,
    "allowLateJoin" BOOLEAN NOT NULL DEFAULT true,
    "chatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "spectatorChatEnabled" BOOLEAN NOT NULL DEFAULT false,
    "seasonId" TEXT,
    "seasonMonthLabel" TEXT,
    "seasonMonthKey" TEXT,
    "retentionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "maxRetentionsPerFranchise" INTEGER NOT NULL DEFAULT 4,
    "maxOverseasRetentions" INTEGER NOT NULL DEFAULT 2,
    "configFinalized" BOOLEAN NOT NULL DEFAULT false,
    "configFinalizedAt" TIMESTAMP(3),
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "currentLotId" TEXT,
    "timerDeadlineMs" BIGINT,
    "timerRemainingMs" INTEGER,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Room_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomFranchise" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "presetCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customSuffix" TEXT,
    "abbreviation" TEXT NOT NULL,
    "primaryColor" TEXT NOT NULL,
    "secondaryColor" TEXT NOT NULL,
    "initialPurseLakhs" INTEGER NOT NULL,
    "purseAdjustmentLakhs" INTEGER NOT NULL DEFAULT 0,
    "remainingPurseLakhs" INTEGER NOT NULL,
    "squadCount" INTEGER NOT NULL DEFAULT 0,
    "overseasCount" INTEGER NOT NULL DEFAULT 0,
    "retainedCount" INTEGER NOT NULL DEFAULT 0,
    "seasonEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomFranchise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomRetention" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "franchiseId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "retentionCostLakhs" INTEGER NOT NULL,
    "slotNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomRetention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomParticipant" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "guestSessionId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "RoomRole" NOT NULL DEFAULT 'OWNER',
    "franchiseId" TEXT,
    "isReady" BOOLEAN NOT NULL DEFAULT false,
    "isConnected" BOOLEAN NOT NULL DEFAULT true,
    "isRemoved" BOOLEAN NOT NULL DEFAULT false,
    "isChatMuted" BOOLEAN NOT NULL DEFAULT false,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "RoomParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MasterPlayer" (
    "id" TEXT NOT NULL,
    "externalKey" TEXT,
    "cricsheetId" TEXT,
    "cricinfoId" TEXT,
    "fullName" TEXT NOT NULL,
    "nationality" TEXT,
    "isOverseas" BOOLEAN NOT NULL DEFAULT false,
    "dateOfBirth" TIMESTAMP(3),
    "age" INTEGER,
    "playingRole" "CricketRole" NOT NULL DEFAULT 'ALL_ROUNDER',
    "secondaryRole" "CricketRole",
    "battingStyle" "BattingStyle",
    "bowlingStyle" "BowlingStyle",
    "basePriceLakhs" INTEGER NOT NULL DEFAULT 50,
    "imageUrl" TEXT,
    "teamHistoryJson" JSONB,
    "iplDebutYear" INTEGER,
    "iplLastYear" INTEGER,
    "provenanceSource" TEXT,
    "seasonCoverage" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MasterPlayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerSeasonStat" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "teamCode" TEXT,
    "matches" INTEGER,
    "innings" INTEGER,
    "battingInnings" INTEGER,
    "bowlingInnings" INTEGER,
    "runs" INTEGER,
    "ballsFaced" INTEGER,
    "notOuts" INTEGER,
    "highestScore" INTEGER,
    "highestScoreText" TEXT,
    "battingAverage" DECIMAL(6,2),
    "strikeRate" DECIMAL(6,2),
    "fifties" INTEGER,
    "hundreds" INTEGER,
    "wickets" INTEGER,
    "ballsBowled" INTEGER,
    "runsConceded" INTEGER,
    "bowlingAverage" DECIMAL(6,2),
    "economy" DECIMAL(6,2),
    "bowlingStrikeRate" DECIMAL(6,2),
    "bestBowling" TEXT,
    "catches" INTEGER,
    "stumpings" INTEGER,
    "provenanceSource" TEXT,

    CONSTRAINT "PlayerSeasonStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlayerImportBatch" (
    "id" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "fileName" TEXT,
    "importMode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "insertedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "insertedPlayerIds" JSONB,
    "errorsJson" JSONB,
    "provenanceNotes" TEXT,
    "createdBySessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackAt" TIMESTAMP(3),

    CONSTRAINT "PlayerImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoomPlayerLot" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL DEFAULT 1,
    "sequenceOrder" INTEGER NOT NULL,
    "setCategory" TEXT NOT NULL DEFAULT 'Marquee',
    "basePriceLakhs" INTEGER NOT NULL,
    "currentBidLakhs" INTEGER NOT NULL DEFAULT 0,
    "winningFranchiseId" TEXT,
    "status" "LotStatus" NOT NULL DEFAULT 'QUEUED',
    "biddingClosedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoomPlayerLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bid" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "franchiseId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "bidAmountLakhs" INTEGER NOT NULL,
    "roundNumber" INTEGER NOT NULL DEFAULT 1,
    "sequenceNumber" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "franchiseId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "purchasePriceLakhs" INTEGER NOT NULL,
    "soldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurseLedger" (
    "id" TEXT NOT NULL,
    "franchiseId" TEXT NOT NULL,
    "purchaseId" TEXT,
    "entryType" "LedgerEntryType" NOT NULL,
    "amountLakhs" INTEGER NOT NULL,
    "balanceAfterLakhs" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurseLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuctionEvent" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "roomVersion" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuctionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "guestSessionId" TEXT NOT NULL,
    "participantId" TEXT,
    "senderName" TEXT NOT NULL,
    "senderRole" TEXT NOT NULL DEFAULT 'OWNER',
    "franchiseCode" TEXT,
    "franchiseDisplayName" TEXT,
    "message" TEXT NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedBySessionId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MLModelRegistry" (
    "id" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL,
    "trainSplitStart" TEXT NOT NULL,
    "trainSplitEnd" TEXT NOT NULL,
    "testSplitStart" TEXT NOT NULL,
    "testSplitEnd" TEXT NOT NULL,
    "metricsJson" JSONB,
    "artifactPath" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "trainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MLModelRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostAuctionRatingSnapshot" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "snapshotVersion" INTEGER NOT NULL,
    "rosterFingerprint" TEXT NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggeredByRole" TEXT NOT NULL,
    "summaryJson" JSONB NOT NULL,

    CONSTRAINT "PostAuctionRatingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeProposal" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "proposerFranchiseId" TEXT NOT NULL,
    "receiverFranchiseId" TEXT NOT NULL,
    "proposerParticipantId" TEXT NOT NULL,
    "receiverParticipantId" TEXT NOT NULL,
    "status" "TradeStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "acceptIdempotencyKey" TEXT,
    "note" TEXT,
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeProposalItem" (
    "id" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "direction" "TradeDirection" NOT NULL,
    "fromFranchiseId" TEXT NOT NULL,
    "toFranchiseId" TEXT NOT NULL,
    "priceLakhs" INTEGER NOT NULL,

    CONSTRAINT "TradeProposalItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Season" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "description" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "status" "SeasonStatus" NOT NULL DEFAULT 'ACTIVE',
    "hostSessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Season_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonFranchiseEntry" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "presetCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "primaryColor" TEXT NOT NULL,
    "secondaryColor" TEXT NOT NULL,
    "customSuffix" TEXT,
    "controllerSessionId" TEXT,
    "controllerDisplayName" TEXT,
    "recoveryCodeHash" TEXT,
    "totalPoints" INTEGER NOT NULL DEFAULT 0,
    "auctionsJoined" INTEGER NOT NULL DEFAULT 0,
    "previousRank" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SeasonFranchiseEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeasonPointLedger" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "roomId" TEXT,
    "monthKey" TEXT,
    "pointsDelta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "adjustedBySessionId" TEXT NOT NULL,
    "adjustedByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeasonPointLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuestSession_expiresAt_idx" ON "GuestSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Room_code_key" ON "Room"("code");

-- CreateIndex
CREATE INDEX "Room_visibility_status_idx" ON "Room"("visibility", "status");

-- CreateIndex
CREATE INDEX "Room_code_idx" ON "Room"("code");

-- CreateIndex
CREATE INDEX "Room_seasonId_idx" ON "Room"("seasonId");

-- CreateIndex
CREATE INDEX "RoomFranchise_roomId_idx" ON "RoomFranchise"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomFranchise_roomId_presetCode_key" ON "RoomFranchise"("roomId", "presetCode");

-- CreateIndex
CREATE INDEX "RoomRetention_roomId_franchiseId_idx" ON "RoomRetention"("roomId", "franchiseId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomRetention_roomId_playerId_key" ON "RoomRetention"("roomId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "RoomParticipant_franchiseId_key" ON "RoomParticipant"("franchiseId");

-- CreateIndex
CREATE INDEX "RoomParticipant_roomId_role_idx" ON "RoomParticipant"("roomId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "RoomParticipant_roomId_guestSessionId_key" ON "RoomParticipant"("roomId", "guestSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "MasterPlayer_externalKey_key" ON "MasterPlayer"("externalKey");

-- CreateIndex
CREATE UNIQUE INDEX "MasterPlayer_cricsheetId_key" ON "MasterPlayer"("cricsheetId");

-- CreateIndex
CREATE INDEX "MasterPlayer_fullName_idx" ON "MasterPlayer"("fullName");

-- CreateIndex
CREATE INDEX "MasterPlayer_cricinfoId_idx" ON "MasterPlayer"("cricinfoId");

-- CreateIndex
CREATE INDEX "MasterPlayer_nationality_playingRole_idx" ON "MasterPlayer"("nationality", "playingRole");

-- CreateIndex
CREATE INDEX "MasterPlayer_playingRole_isOverseas_idx" ON "MasterPlayer"("playingRole", "isOverseas");

-- CreateIndex
CREATE INDEX "PlayerSeasonStat_season_idx" ON "PlayerSeasonStat"("season");

-- CreateIndex
CREATE UNIQUE INDEX "PlayerSeasonStat_playerId_season_key" ON "PlayerSeasonStat"("playerId", "season");

-- CreateIndex
CREATE INDEX "PlayerImportBatch_createdAt_idx" ON "PlayerImportBatch"("createdAt");

-- CreateIndex
CREATE INDEX "RoomPlayerLot_roomId_sequenceOrder_idx" ON "RoomPlayerLot"("roomId", "sequenceOrder");

-- CreateIndex
CREATE INDEX "RoomPlayerLot_roomId_status_idx" ON "RoomPlayerLot"("roomId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RoomPlayerLot_roomId_playerId_key" ON "RoomPlayerLot"("roomId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "Bid_idempotencyKey_key" ON "Bid"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Bid_lotId_sequenceNumber_idx" ON "Bid"("lotId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "Bid_franchiseId_idx" ON "Bid"("franchiseId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_lotId_key" ON "Purchase"("lotId");

-- CreateIndex
CREATE INDEX "Purchase_roomId_franchiseId_idx" ON "Purchase"("roomId", "franchiseId");

-- CreateIndex
CREATE UNIQUE INDEX "PurseLedger_purchaseId_key" ON "PurseLedger"("purchaseId");

-- CreateIndex
CREATE INDEX "PurseLedger_franchiseId_idx" ON "PurseLedger"("franchiseId");

-- CreateIndex
CREATE INDEX "AuctionEvent_roomId_sequenceNumber_idx" ON "AuctionEvent"("roomId", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_idempotencyKey_key" ON "ChatMessage"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ChatMessage_roomId_createdAt_idx" ON "ChatMessage"("roomId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MLModelRegistry_modelKey_version_key" ON "MLModelRegistry"("modelKey", "version");

-- CreateIndex
CREATE INDEX "PostAuctionRatingSnapshot_roomId_calculatedAt_idx" ON "PostAuctionRatingSnapshot"("roomId", "calculatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PostAuctionRatingSnapshot_roomId_snapshotVersion_key" ON "PostAuctionRatingSnapshot"("roomId", "snapshotVersion");

-- CreateIndex
CREATE UNIQUE INDEX "TradeProposal_idempotencyKey_key" ON "TradeProposal"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TradeProposal_acceptIdempotencyKey_key" ON "TradeProposal"("acceptIdempotencyKey");

-- CreateIndex
CREATE INDEX "TradeProposal_roomId_status_idx" ON "TradeProposal"("roomId", "status");

-- CreateIndex
CREATE INDEX "TradeProposal_proposerFranchiseId_status_idx" ON "TradeProposal"("proposerFranchiseId", "status");

-- CreateIndex
CREATE INDEX "TradeProposal_receiverFranchiseId_status_idx" ON "TradeProposal"("receiverFranchiseId", "status");

-- CreateIndex
CREATE INDEX "TradeProposal_expiresAt_status_idx" ON "TradeProposal"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "TradeProposalItem_playerId_idx" ON "TradeProposalItem"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "TradeProposalItem_tradeId_playerId_key" ON "TradeProposalItem"("tradeId", "playerId");

-- CreateIndex
CREATE UNIQUE INDEX "Season_code_key" ON "Season"("code");

-- CreateIndex
CREATE INDEX "Season_status_year_idx" ON "Season"("status", "year");

-- CreateIndex
CREATE INDEX "Season_hostSessionId_idx" ON "Season"("hostSessionId");

-- CreateIndex
CREATE INDEX "SeasonFranchiseEntry_seasonId_totalPoints_idx" ON "SeasonFranchiseEntry"("seasonId", "totalPoints");

-- CreateIndex
CREATE UNIQUE INDEX "SeasonFranchiseEntry_seasonId_presetCode_key" ON "SeasonFranchiseEntry"("seasonId", "presetCode");

-- CreateIndex
CREATE INDEX "SeasonPointLedger_seasonId_createdAt_idx" ON "SeasonPointLedger"("seasonId", "createdAt");

-- CreateIndex
CREATE INDEX "SeasonPointLedger_entryId_createdAt_idx" ON "SeasonPointLedger"("entryId", "createdAt");

-- CreateIndex
CREATE INDEX "SeasonPointLedger_seasonId_monthKey_idx" ON "SeasonPointLedger"("seasonId", "monthKey");

-- CreateIndex
CREATE INDEX "SeasonPointLedger_seasonId_roomId_idx" ON "SeasonPointLedger"("seasonId", "roomId");

-- AddForeignKey
ALTER TABLE "Room" ADD CONSTRAINT "Room_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomFranchise" ADD CONSTRAINT "RoomFranchise_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomFranchise" ADD CONSTRAINT "RoomFranchise_seasonEntryId_fkey" FOREIGN KEY ("seasonEntryId") REFERENCES "SeasonFranchiseEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomRetention" ADD CONSTRAINT "RoomRetention_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomRetention" ADD CONSTRAINT "RoomRetention_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "RoomFranchise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomRetention" ADD CONSTRAINT "RoomRetention_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "MasterPlayer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomParticipant" ADD CONSTRAINT "RoomParticipant_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomParticipant" ADD CONSTRAINT "RoomParticipant_guestSessionId_fkey" FOREIGN KEY ("guestSessionId") REFERENCES "GuestSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomParticipant" ADD CONSTRAINT "RoomParticipant_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "RoomFranchise"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlayerSeasonStat" ADD CONSTRAINT "PlayerSeasonStat_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "MasterPlayer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomPlayerLot" ADD CONSTRAINT "RoomPlayerLot_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoomPlayerLot" ADD CONSTRAINT "RoomPlayerLot_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "MasterPlayer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "RoomPlayerLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "RoomFranchise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "RoomParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "RoomPlayerLot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "RoomFranchise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "MasterPlayer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurseLedger" ADD CONSTRAINT "PurseLedger_franchiseId_fkey" FOREIGN KEY ("franchiseId") REFERENCES "RoomFranchise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurseLedger" ADD CONSTRAINT "PurseLedger_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionEvent" ADD CONSTRAINT "AuctionEvent_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_guestSessionId_fkey" FOREIGN KEY ("guestSessionId") REFERENCES "GuestSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostAuctionRatingSnapshot" ADD CONSTRAINT "PostAuctionRatingSnapshot_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeProposal" ADD CONSTRAINT "TradeProposal_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "Room"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeProposal" ADD CONSTRAINT "TradeProposal_proposerFranchiseId_fkey" FOREIGN KEY ("proposerFranchiseId") REFERENCES "RoomFranchise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeProposal" ADD CONSTRAINT "TradeProposal_receiverFranchiseId_fkey" FOREIGN KEY ("receiverFranchiseId") REFERENCES "RoomFranchise"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeProposalItem" ADD CONSTRAINT "TradeProposalItem_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "TradeProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradeProposalItem" ADD CONSTRAINT "TradeProposalItem_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "MasterPlayer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Season" ADD CONSTRAINT "Season_hostSessionId_fkey" FOREIGN KEY ("hostSessionId") REFERENCES "GuestSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonFranchiseEntry" ADD CONSTRAINT "SeasonFranchiseEntry_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonPointLedger" ADD CONSTRAINT "SeasonPointLedger_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "Season"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeasonPointLedger" ADD CONSTRAINT "SeasonPointLedger_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "SeasonFranchiseEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

