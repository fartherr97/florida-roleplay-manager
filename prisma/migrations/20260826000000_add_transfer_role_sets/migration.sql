-- The ES Transfer Portal: a per-department set of Discord role ids.
--
-- On a transfer these roles are stripped from the member in the outgoing department's
-- guild and added to them in the incoming department's guild. Storing them on the guild
-- keeps the transfer's definition next to the guild it belongs to, and an empty default
-- means every existing guild is simply "not a transfer endpoint" until configured.

-- AlterTable
ALTER TABLE "approved_guilds" ADD COLUMN     "transferRoleIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
