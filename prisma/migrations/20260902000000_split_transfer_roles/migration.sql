-- Split the transfer portal's single membership role set into two: the roles stripped
-- from a member LEAVING a department, and the roles granted to a member JOINING it. The
-- legacy `transferRoleIds` column is kept as a read fallback for departments configured
-- before the split; existing rows are seeded so behaviour is unchanged until re-saved.

-- AlterTable
ALTER TABLE "approved_guilds" ADD COLUMN "transferStripRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "approved_guilds" ADD COLUMN "transferGrantRoleIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Seed the new sets from the legacy set so a department that already had membership roles
-- keeps stripping and granting exactly that set until an admin edits the two lists.
UPDATE "approved_guilds"
  SET "transferStripRoleIds" = "transferRoleIds",
      "transferGrantRoleIds" = "transferRoleIds"
  WHERE cardinality("transferRoleIds") > 0;
