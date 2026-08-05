-- CreateTable
CREATE TABLE "role_grant_rules" (
    "id" UUID NOT NULL,
    "approvedGuildId" UUID NOT NULL,
    "grantorRoleId" TEXT NOT NULL,
    "grantorRoleName" TEXT NOT NULL,
    "grantableRoleId" TEXT NOT NULL,
    "grantableRoleName" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "role_grant_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_grant_rules_approvedGuildId_grantorRoleId_idx" ON "role_grant_rules"("approvedGuildId", "grantorRoleId");

-- CreateIndex
CREATE INDEX "role_grant_rules_deletedAt_idx" ON "role_grant_rules"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "role_grant_rules_approvedGuildId_grantorRoleId_grantableRol_key" ON "role_grant_rules"("approvedGuildId", "grantorRoleId", "grantableRoleId");

-- AddForeignKey
ALTER TABLE "role_grant_rules" ADD CONSTRAINT "role_grant_rules_approvedGuildId_fkey" FOREIGN KEY ("approvedGuildId") REFERENCES "approved_guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_grant_rules" ADD CONSTRAINT "role_grant_rules_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
