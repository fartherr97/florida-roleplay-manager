-- Remove the roster subsystem.
--
-- Departments, ranks, memberships, certifications and subdivisions are gone; role
-- synchronization is now driven purely by cross-guild mappings and manual grants.
--
-- The statements in this preamble exist because the enum narrowing below casts every
-- existing row: a database still holding a removed value would fail the cast. They run
-- first, and each one preserves as much history as it can rather than deleting rows an
-- audit record might reference.

-- Managed roles that described roster concepts (ranks, memberships, certifications,
-- subdivisions, LOA/suspension status) no longer have anything to compute them from.
DELETE FROM "managed_roles"
WHERE "purpose"::text NOT IN ('MAPPING', 'MANUAL_GRANT', 'OTHER');

-- A ROSTER-authority mapping becomes source-authoritative, the closest surviving
-- semantic: the source guild's Discord state now decides.
UPDATE "role_mappings" SET "authority" = 'SOURCE_DISCORD' WHERE "authority"::text = 'ROSTER';

-- Historical jobs are relabelled rather than deleted: audit records reference them with
-- ON DELETE RESTRICT, and losing the trail would be worse than an imprecise label.
UPDATE "sync_jobs" SET "type" = 'MEMBER_RESYNC'
WHERE "type"::text IN ('DEPARTMENT_RESYNC', 'ROSTER_CHANGE');

-- Permission grants for capabilities that no longer exist, and any grant scoped to a
-- department or subdivision.
DELETE FROM "permission_assignments"
WHERE "capabilityKey" IN (
  'roster.view', 'roster.add', 'roster.remove', 'roster.promote', 'roster.demote',
  'roster.transfer', 'roster.suspend', 'roster.reinstate', 'roster.loa', 'roster.callsign',
  'certification.assign', 'certification.remove', 'subdivision.assign', 'subdivision.remove',
  'department.manage', 'sync.department'
) OR "scopeType"::text IN ('DEPARTMENT', 'SUBDIVISION');

DELETE FROM "permission_capabilities"
WHERE "key" IN (
  'roster.view', 'roster.add', 'roster.remove', 'roster.promote', 'roster.demote',
  'roster.transfer', 'roster.suspend', 'roster.reinstate', 'roster.loa', 'roster.callsign',
  'certification.assign', 'certification.remove', 'subdivision.assign', 'subdivision.remove',
  'department.manage', 'sync.department'
);

-- AlterEnum
BEGIN;
CREATE TYPE "AuthoritySource_new" AS ENUM ('SOURCE_DISCORD', 'TARGET_DISCORD', 'MANUAL', 'SYSTEM');
ALTER TABLE "public"."role_mappings" ALTER COLUMN "authority" DROP DEFAULT;
ALTER TABLE "role_mappings" ALTER COLUMN "authority" TYPE "AuthoritySource_new" USING ("authority"::text::"AuthoritySource_new");
ALTER TYPE "AuthoritySource" RENAME TO "AuthoritySource_old";
ALTER TYPE "AuthoritySource_new" RENAME TO "AuthoritySource";
DROP TYPE "public"."AuthoritySource_old";
ALTER TABLE "role_mappings" ALTER COLUMN "authority" SET DEFAULT 'SOURCE_DISCORD';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "PermissionScopeType_new" AS ENUM ('GLOBAL', 'GUILD');
ALTER TABLE "permission_assignments" ALTER COLUMN "scopeType" TYPE "PermissionScopeType_new" USING ("scopeType"::text::"PermissionScopeType_new");
ALTER TYPE "PermissionScopeType" RENAME TO "PermissionScopeType_old";
ALTER TYPE "PermissionScopeType_new" RENAME TO "PermissionScopeType";
DROP TYPE "public"."PermissionScopeType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "RolePurpose_new" AS ENUM ('MAPPING', 'MANUAL_GRANT', 'OTHER');
ALTER TABLE "managed_roles" ALTER COLUMN "purpose" TYPE "RolePurpose_new" USING ("purpose"::text::"RolePurpose_new");
ALTER TYPE "RolePurpose" RENAME TO "RolePurpose_old";
ALTER TYPE "RolePurpose_new" RENAME TO "RolePurpose";
DROP TYPE "public"."RolePurpose_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "SyncJobType_new" AS ENUM ('MEMBER_RESYNC', 'GUILD_RESYNC', 'GLOBAL_RESYNC', 'ROLE_ADD', 'ROLE_REMOVE', 'MAPPING_PROPAGATION', 'GRANT_CHANGE', 'SCHEDULED_RECONCILIATION', 'MAPPING_VALIDATION');
ALTER TABLE "sync_jobs" ALTER COLUMN "type" TYPE "SyncJobType_new" USING ("type"::text::"SyncJobType_new");
ALTER TYPE "SyncJobType" RENAME TO "SyncJobType_old";
ALTER TYPE "SyncJobType_new" RENAME TO "SyncJobType";
DROP TYPE "public"."SyncJobType_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "approved_guilds" DROP CONSTRAINT "approved_guilds_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "certifications" DROP CONSTRAINT "certifications_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "department_memberships" DROP CONSTRAINT "department_memberships_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "department_memberships" DROP CONSTRAINT "department_memberships_rankId_fkey";

-- DropForeignKey
ALTER TABLE "department_memberships" DROP CONSTRAINT "department_memberships_userId_fkey";

-- DropForeignKey
ALTER TABLE "managed_roles" DROP CONSTRAINT "managed_roles_certificationId_fkey";

-- DropForeignKey
ALTER TABLE "managed_roles" DROP CONSTRAINT "managed_roles_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "managed_roles" DROP CONSTRAINT "managed_roles_rankId_fkey";

-- DropForeignKey
ALTER TABLE "managed_roles" DROP CONSTRAINT "managed_roles_subdivisionId_fkey";

-- DropForeignKey
ALTER TABLE "member_certifications" DROP CONSTRAINT "member_certifications_certificationId_fkey";

-- DropForeignKey
ALTER TABLE "member_certifications" DROP CONSTRAINT "member_certifications_issuedById_fkey";

-- DropForeignKey
ALTER TABLE "member_certifications" DROP CONSTRAINT "member_certifications_revokedById_fkey";

-- DropForeignKey
ALTER TABLE "member_certifications" DROP CONSTRAINT "member_certifications_userId_fkey";

-- DropForeignKey
ALTER TABLE "member_subdivisions" DROP CONSTRAINT "member_subdivisions_addedById_fkey";

-- DropForeignKey
ALTER TABLE "member_subdivisions" DROP CONSTRAINT "member_subdivisions_subdivisionId_fkey";

-- DropForeignKey
ALTER TABLE "member_subdivisions" DROP CONSTRAINT "member_subdivisions_userId_fkey";

-- DropForeignKey
ALTER TABLE "membership_events" DROP CONSTRAINT "membership_events_actorUserId_fkey";

-- DropForeignKey
ALTER TABLE "membership_events" DROP CONSTRAINT "membership_events_fromRankId_fkey";

-- DropForeignKey
ALTER TABLE "membership_events" DROP CONSTRAINT "membership_events_membershipId_fkey";

-- DropForeignKey
ALTER TABLE "membership_events" DROP CONSTRAINT "membership_events_toRankId_fkey";

-- DropForeignKey
ALTER TABLE "ranks" DROP CONSTRAINT "ranks_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "subdivisions" DROP CONSTRAINT "subdivisions_departmentId_fkey";

-- DropForeignKey
ALTER TABLE "sync_jobs" DROP CONSTRAINT "sync_jobs_departmentId_fkey";

-- DropIndex
DROP INDEX "approved_guilds_departmentId_key";

-- DropIndex
DROP INDEX "managed_roles_departmentId_idx";

-- DropIndex
DROP INDEX "managed_roles_rankId_idx";

-- DropIndex
DROP INDEX "sync_jobs_departmentId_idx";

-- AlterTable
ALTER TABLE "approved_guilds" DROP COLUMN "departmentId";

-- AlterTable
ALTER TABLE "audit_logs" DROP COLUMN "departmentId";

-- AlterTable
ALTER TABLE "managed_roles" DROP COLUMN "certificationId",
DROP COLUMN "departmentId",
DROP COLUMN "rankId",
DROP COLUMN "subdivisionId",
ALTER COLUMN "purpose" SET DEFAULT 'MAPPING';

-- AlterTable
ALTER TABLE "permission_assignments" DROP COLUMN "maxRankOrder";

-- AlterTable
ALTER TABLE "sync_jobs" DROP COLUMN "departmentId";

-- DropTable
DROP TABLE "certifications";

-- DropTable
DROP TABLE "department_memberships";

-- DropTable
DROP TABLE "departments";

-- DropTable
DROP TABLE "member_certifications";

-- DropTable
DROP TABLE "member_subdivisions";

-- DropTable
DROP TABLE "membership_events";

-- DropTable
DROP TABLE "ranks";

-- DropTable
DROP TABLE "subdivisions";

-- DropEnum
DROP TYPE "MembershipEventType";

-- DropEnum
DROP TYPE "MembershipStatus";

