-- Soft-whitelist submissions: a member answers a few questions on the website to
-- be able to join the game server. Each submission is posted to a staff review
-- channel with Approve/Deny buttons; approving assigns the whitelist role.

-- CreateTable
CREATE TABLE "whitelist_submissions" (
    "id" UUID NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "answers" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "channelId" TEXT,
    "messageId" TEXT,
    "reviewedByDiscordId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whitelist_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "whitelist_submissions_discordUserId_idx" ON "whitelist_submissions"("discordUserId");

-- CreateIndex
CREATE INDEX "whitelist_submissions_status_idx" ON "whitelist_submissions"("status");
