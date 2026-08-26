-- The bound Discord role's colour, refreshed on each roster sync so the website
-- can band the roster in the same colours staff see in Discord. Null = no colour.
-- AlterTable
ALTER TABLE "roster_ranks" ADD COLUMN "color" TEXT;
