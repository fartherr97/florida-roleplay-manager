-- An optional second role a member must ALSO hold for a rank to apply, so a rank can
-- mean "holds both roles at once" (e.g. Auxiliary Staff = Server Staff + Department Head).
ALTER TABLE "roster_ranks" ADD COLUMN "requiresRoleId" TEXT;
