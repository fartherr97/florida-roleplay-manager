-- Named, reusable access tiers: a bundle of capabilities defined once and mapped to roles.
-- CreateTable
CREATE TABLE "access_tiers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "access_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_tiers_name_key" ON "access_tiers"("name");

-- CreateIndex
CREATE INDEX "access_tiers_deletedAt_idx" ON "access_tiers"("deletedAt");

-- A role mapping may now point at a named tier instead of a numeric level.
-- AlterTable
ALTER TABLE "role_access_tiers" ADD COLUMN "accessTierId" UUID;
ALTER TABLE "role_access_tiers" ALTER COLUMN "permissionLevel" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "role_access_tiers_accessTierId_idx" ON "role_access_tiers"("accessTierId");

-- AddForeignKey
ALTER TABLE "access_tiers" ADD CONSTRAINT "access_tiers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_access_tiers" ADD CONSTRAINT "role_access_tiers_accessTierId_fkey" FOREIGN KEY ("accessTierId") REFERENCES "access_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
