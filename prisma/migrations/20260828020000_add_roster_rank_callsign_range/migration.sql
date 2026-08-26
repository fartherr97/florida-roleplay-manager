-- Auto-assign callsign block for a roster rank. When both ends are set, a member
-- who joins or is promoted into the rank with no in-range callsign is issued the
-- lowest free number in [start, end]. Both null keeps callsigns manual.
-- AlterTable
ALTER TABLE "roster_ranks" ADD COLUMN "callsignRangeStart" INTEGER;
ALTER TABLE "roster_ranks" ADD COLUMN "callsignRangeEnd" INTEGER;
