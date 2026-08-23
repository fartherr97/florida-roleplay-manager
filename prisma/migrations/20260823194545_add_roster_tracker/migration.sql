-- Add the roster tracker.
--
-- Rosters are published lists of who holds which rank, computed from Discord roles: a
-- rank is bound to a role, and holding that role is being that rank. This is the inverse
-- of the roster subsystem removed in 20260803224212, which treated the roster as the
-- source of truth and drove roles from it. Nothing is added to a roster by hand.
--
-- Memberships are never deleted, only marked DEPARTED, because "who was Senior Admin in
-- March" is a question that gets asked and an audit record may reference the row.

-- CreateEnum
CREATE TYPE "RosterMembershipStatus" AS ENUM ('ACTIVE', 'DEPARTED');

-- AlterEnum
ALTER TYPE "SyncIssueType" ADD VALUE 'MEMBER_ABOVE_BOT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SyncJobType" ADD VALUE 'ROSTER_MEMBER_SYNC';
ALTER TYPE "SyncJobType" ADD VALUE 'ROSTER_SYNC';

-- CreateTable
CREATE TABLE "rosters" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "approvedGuildId" UUID NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "nicknameSyncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "rosters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_ranks" (
    "id" UUID NOT NULL,
    "rosterId" UUID NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "roster_ranks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roster_memberships" (
    "id" UUID NOT NULL,
    "rosterId" UUID NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "userId" UUID,
    "rankId" UUID,
    "callsign" TEXT,
    "preferredName" TEXT,
    "displayName" TEXT,
    "status" "RosterMembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "managedNickname" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "departedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roster_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rosters_slug_key" ON "rosters"("slug");

-- CreateIndex
CREATE INDEX "rosters_approvedGuildId_idx" ON "rosters"("approvedGuildId");

-- CreateIndex
CREATE INDEX "rosters_deletedAt_idx" ON "rosters"("deletedAt");

-- CreateIndex
CREATE INDEX "roster_ranks_rosterId_position_idx" ON "roster_ranks"("rosterId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "roster_ranks_rosterId_discordRoleId_key" ON "roster_ranks"("rosterId", "discordRoleId");

-- CreateIndex
CREATE INDEX "roster_memberships_rosterId_status_idx" ON "roster_memberships"("rosterId", "status");

-- CreateIndex
CREATE INDEX "roster_memberships_discordUserId_idx" ON "roster_memberships"("discordUserId");

-- CreateIndex
CREATE UNIQUE INDEX "roster_memberships_rosterId_discordUserId_key" ON "roster_memberships"("rosterId", "discordUserId");

-- AddForeignKey
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_approvedGuildId_fkey" FOREIGN KEY ("approvedGuildId") REFERENCES "approved_guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rosters" ADD CONSTRAINT "rosters_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_ranks" ADD CONSTRAINT "roster_ranks_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "rosters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_memberships" ADD CONSTRAINT "roster_memberships_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "rosters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_memberships" ADD CONSTRAINT "roster_memberships_rankId_fkey" FOREIGN KEY ("rankId") REFERENCES "roster_ranks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roster_memberships" ADD CONSTRAINT "roster_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
