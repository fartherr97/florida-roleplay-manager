-- A rank that yields its nickname to the member's other roster in the same guild
-- (e.g. Auxiliary Staff keeping the member's department name instead of the staff one).
ALTER TABLE "roster_ranks" ADD COLUMN "yieldNickname" BOOLEAN NOT NULL DEFAULT false;
