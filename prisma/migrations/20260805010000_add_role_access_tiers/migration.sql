-- CreateTable
CREATE TABLE "role_access_tiers" (
    "id" UUID NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "roleName" TEXT NOT NULL,
    "permissionLevel" INTEGER NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "role_access_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "role_access_tiers_discordRoleId_key" ON "role_access_tiers"("discordRoleId");

-- CreateIndex
CREATE INDEX "role_access_tiers_deletedAt_idx" ON "role_access_tiers"("deletedAt");

-- AddForeignKey
ALTER TABLE "role_access_tiers" ADD CONSTRAINT "role_access_tiers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
