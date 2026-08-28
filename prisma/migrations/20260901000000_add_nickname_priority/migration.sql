-- Cross-guild nickname priority: a rank can force the main community's name (MAIN)
-- or its own guild's name (DEPARTMENT) as the source of a member's name everywhere,
-- and each membership remembers the name propagated from that authoritative guild.

-- CreateEnum
CREATE TYPE "NicknamePriority" AS ENUM ('NONE', 'MAIN', 'DEPARTMENT');

-- AlterTable
ALTER TABLE "roster_ranks" ADD COLUMN "nicknamePriority" "NicknamePriority" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "roster_memberships" ADD COLUMN "syncedName" TEXT;
