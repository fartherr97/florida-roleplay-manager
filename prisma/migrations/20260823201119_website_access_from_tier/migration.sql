-- Website access can now be granted by a Discord access tier.
--
-- Holding a mapped staff role grants access to the dashboard, and losing it takes the
-- access away. `accessFromTier` records which grants came from a tier, so a sweep only
-- ever revokes access it granted - an explicit grant made by hand is never silently
-- taken back.
--
-- Existing rows default to false, which is correct: every current grant predates tiers
-- and is therefore explicit.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "accessFromTier" BOOLEAN NOT NULL DEFAULT false;
