-- Timed (temporary) community-wide bans set by /globalban with a duration. The ban lives
-- in Discord per guild; this row is the timer and the record. A maintenance sweep (or a
-- manual /globalunban) lifts it and flips `active` off. A permanent ban writes no row.
CREATE TABLE "timed_bans" (
    "id" UUID NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "reason" TEXT,
    "bannedByLabel" TEXT,
    "bannedById" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "liftedAt" TIMESTAMP(3),
    "liftedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "timed_bans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "timed_bans_active_expiresAt_idx" ON "timed_bans"("active", "expiresAt");
CREATE INDEX "timed_bans_discordUserId_idx" ON "timed_bans"("discordUserId");
