-- Temporary Discord role assignments set by /temprole with a duration. The role is added
-- in the guild where the command ran and lives in Discord like any other; this row is the
-- timer and the record. A maintenance sweep (or an early /temprole remove) takes the role
-- back off and flips `active` off. This is a direct role assignment, not a managed role.
CREATE TABLE "temp_roles" (
    "id" UUID NOT NULL,
    "discordGuildId" TEXT NOT NULL,
    "guildName" TEXT,
    "discordUserId" TEXT NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "roleName" TEXT,
    "reason" TEXT,
    "addedByLabel" TEXT,
    "addedById" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "removedAt" TIMESTAMP(3),
    "removedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "temp_roles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "temp_roles_active_expiresAt_idx" ON "temp_roles"("active", "expiresAt");
CREATE INDEX "temp_roles_discordUserId_idx" ON "temp_roles"("discordUserId");
