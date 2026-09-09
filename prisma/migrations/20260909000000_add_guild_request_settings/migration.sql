-- Per-guild config for /requesttraining and /requestinterview: which channel they post in
-- and which roles get pinged inside the opened thread. Set by Ownership via /requestconfig.
CREATE TYPE "RequestKind" AS ENUM ('TRAINING', 'INTERVIEW');

CREATE TABLE "guild_request_settings" (
    "id" UUID NOT NULL,
    "discordGuildId" TEXT NOT NULL,
    "kind" "RequestKind" NOT NULL,
    "channelId" TEXT NOT NULL,
    "pingRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_request_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "guild_request_settings_discordGuildId_kind_key" ON "guild_request_settings"("discordGuildId", "kind");
