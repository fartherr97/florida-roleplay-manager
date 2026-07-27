-- CreateEnum
CREATE TYPE "GuildType" AS ENUM ('MAIN_COMMUNITY', 'DEPARTMENT', 'SUBDIVISION', 'STAFF', 'OTHER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED', 'BANNED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'LOA', 'SUSPENDED', 'TERMINATED', 'TRANSFER_PENDING', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MembershipEventType" AS ENUM ('HIRED', 'REHIRED', 'PROMOTED', 'DEMOTED', 'TRANSFERRED_IN', 'TRANSFERRED_OUT', 'LOA_STARTED', 'LOA_ENDED', 'SUSPENDED', 'REINSTATED', 'TERMINATED', 'CALLSIGN_CHANGED', 'NOTE_ADDED');

-- CreateEnum
CREATE TYPE "MappingDirection" AS ENUM ('ONE_WAY', 'TWO_WAY');

-- CreateEnum
CREATE TYPE "AuthoritySource" AS ENUM ('ROSTER', 'SOURCE_DISCORD', 'TARGET_DISCORD', 'MANUAL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RolePurpose" AS ENUM ('DEPARTMENT_MEMBERSHIP', 'RANK', 'SUPERVISOR', 'COMMAND', 'CERTIFICATION', 'SUBDIVISION', 'STATUS_LOA', 'STATUS_SUSPENDED', 'MAPPING', 'MANUAL_GRANT', 'OTHER');

-- CreateEnum
CREATE TYPE "ProtectionLevel" AS ENUM ('NONE', 'ELEVATED', 'TWO_PERSON');

-- CreateEnum
CREATE TYPE "PermissionScopeType" AS ENUM ('GLOBAL', 'GUILD', 'DEPARTMENT', 'SUBDIVISION');

-- CreateEnum
CREATE TYPE "SyncJobType" AS ENUM ('MEMBER_RESYNC', 'DEPARTMENT_RESYNC', 'GUILD_RESYNC', 'GLOBAL_RESYNC', 'ROLE_ADD', 'ROLE_REMOVE', 'ROSTER_CHANGE', 'MAPPING_PROPAGATION', 'SCHEDULED_RECONCILIATION', 'MAPPING_VALIDATION');

-- CreateEnum
CREATE TYPE "SyncJobStatus" AS ENUM ('PENDING', 'RUNNING', 'PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED');

-- CreateEnum
CREATE TYPE "SyncActionType" AS ENUM ('ADD_ROLE', 'REMOVE_ROLE');

-- CreateEnum
CREATE TYPE "SyncActionStatus" AS ENUM ('PENDING', 'APPLIED', 'SKIPPED', 'FAILED', 'DRY_RUN');

-- CreateEnum
CREATE TYPE "SyncIssueType" AS ENUM ('MEMBER_NOT_IN_GUILD', 'MEMBER_NOT_LINKED', 'BOT_MISSING_PERMISSION', 'BOT_NOT_IN_GUILD', 'ROLE_ABOVE_BOT', 'ROLE_DELETED', 'INVALID_ROLE_REFERENCE', 'INTEGRATION_MANAGED_ROLE', 'PROTECTED_ROLE_VIOLATION', 'GUILD_UNAVAILABLE', 'GUILD_NOT_APPROVED', 'RATE_LIMITED', 'API_TIMEOUT', 'DISCORD_ERROR', 'DATABASE_ERROR', 'REDIS_ERROR', 'MAPPING_CONFLICT', 'THRESHOLD_EXCEEDED', 'ENQUEUE_FAILED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ActionSource" AS ENUM ('DISCORD', 'WEBSITE', 'SYSTEM', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "PendingApprovalType" AS ENUM ('MAPPING_ACTIVATION', 'PROTECTED_ROLE_MAPPING', 'GUILD_REGISTRATION', 'GUILD_REMOVAL', 'GLOBAL_RESYNC');

-- CreateEnum
CREATE TYPE "PendingApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "permissionLevel" INTEGER NOT NULL DEFAULT 0,
    "websiteAccess" BOOLEAN NOT NULL DEFAULT false,
    "primaryDiscordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discord_identities" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "discordUserId" TEXT NOT NULL,
    "username" TEXT,
    "globalName" TEXT,
    "avatarHash" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "linkedById" UUID,

    CONSTRAINT "discord_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approved_guilds" (
    "id" UUID NOT NULL,
    "discordGuildId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "GuildType" NOT NULL,
    "departmentId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "syncEnabled" BOOLEAN NOT NULL DEFAULT true,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registeredById" UUID,
    "removedAt" TIMESTAMP(3),
    "removedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "approved_guilds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "removeRankRolesOnLoa" BOOLEAN NOT NULL DEFAULT false,
    "removeRankRolesOnSuspension" BOOLEAN NOT NULL DEFAULT true,
    "removeMembershipRolesOnSuspension" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranks" (
    "id" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "abbreviation" TEXT,
    "order" INTEGER NOT NULL,
    "isSupervisor" BOOLEAN NOT NULL DEFAULT false,
    "isCommand" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ranks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_memberships" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "rankId" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "callsign" TEXT,
    "badgeNumber" TEXT,
    "hireDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rankDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusUntil" TIMESTAMP(3),
    "statusReason" TEXT,
    "notes" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "terminatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "department_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_events" (
    "id" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "type" "MembershipEventType" NOT NULL,
    "fromRankId" UUID,
    "toRankId" UUID,
    "fromDepartment" TEXT,
    "toDepartment" TEXT,
    "actorUserId" UUID,
    "actorDiscordId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certifications" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "departmentId" UUID,
    "expiresAfterDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_certifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "certificationId" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "issuedById" UUID,
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "reason" TEXT,

    CONSTRAINT "member_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subdivisions" (
    "id" UUID NOT NULL,
    "departmentId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "subdivisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_subdivisions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "subdivisionId" UUID NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "addedById" UUID,

    CONSTRAINT "member_subdivisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "managed_roles" (
    "id" UUID NOT NULL,
    "approvedGuildId" UUID NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" "RolePurpose" NOT NULL,
    "departmentId" UUID,
    "rankId" UUID,
    "certificationId" UUID,
    "subdivisionId" UUID,
    "protectionLevel" "ProtectionLevel" NOT NULL DEFAULT 'NONE',
    "managedByPlatform" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "managed_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_role_grants" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "managedRoleId" UUID NOT NULL,
    "grantedById" UUID,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_role_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_mappings" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sourceGuildId" UUID NOT NULL,
    "sourceRoleId" TEXT NOT NULL,
    "targetGuildId" UUID NOT NULL,
    "targetRoleId" TEXT NOT NULL,
    "direction" "MappingDirection" NOT NULL DEFAULT 'ONE_WAY',
    "authority" "AuthoritySource" NOT NULL DEFAULT 'SOURCE_DISCORD',
    "syncAdd" BOOLEAN NOT NULL DEFAULT true,
    "syncRemove" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "role_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_capabilities" (
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dangerous" BOOLEAN NOT NULL DEFAULT false,
    "minLevel" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permission_capabilities_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "permission_assignments" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "capabilityKey" TEXT NOT NULL,
    "scopeType" "PermissionScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT '',
    "maxRankOrder" INTEGER,
    "maxPermissionLevel" INTEGER,
    "grantedById" UUID,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "reason" TEXT,

    CONSTRAINT "permission_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" UUID NOT NULL,
    "type" "SyncJobType" NOT NULL,
    "status" "SyncJobStatus" NOT NULL DEFAULT 'PENDING',
    "source" "ActionSource" NOT NULL,
    "initiatedById" UUID,
    "initiatedByDiscordId" TEXT,
    "departmentId" UUID,
    "approvedGuildId" UUID,
    "targetUserId" UUID,
    "mappingId" UUID,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "progressTotal" INTEGER NOT NULL DEFAULT 0,
    "progressCompleted" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "queueJobId" TEXT,
    "parentJobId" UUID,
    "requestId" TEXT,
    "reason" TEXT,
    "payload" JSONB,
    "error" JSONB,
    "thresholdBreached" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_actions" (
    "id" UUID NOT NULL,
    "syncJobId" UUID NOT NULL,
    "action" "SyncActionType" NOT NULL,
    "status" "SyncActionStatus" NOT NULL DEFAULT 'PENDING',
    "userId" UUID,
    "discordUserId" TEXT NOT NULL,
    "approvedGuildId" UUID,
    "discordGuildId" TEXT NOT NULL,
    "discordRoleId" TEXT NOT NULL,
    "roleName" TEXT,
    "managedRoleId" UUID,
    "mappingId" UUID,
    "reason" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_issues" (
    "id" UUID NOT NULL,
    "type" "SyncIssueType" NOT NULL,
    "severity" "IssueSeverity" NOT NULL DEFAULT 'ERROR',
    "syncJobId" UUID,
    "syncActionId" UUID,
    "approvedGuildId" UUID,
    "discordGuildId" TEXT,
    "userId" UUID,
    "discordUserId" TEXT,
    "mappingId" UUID,
    "discordRoleId" TEXT,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "source" "ActionSource" NOT NULL,
    "actorUserId" UUID,
    "actorDiscordId" TEXT,
    "targetUserId" UUID,
    "targetDiscordId" TEXT,
    "departmentId" UUID,
    "approvedGuildId" UUID,
    "mappingId" UUID,
    "syncJobId" UUID,
    "previousState" JSONB,
    "newState" JSONB,
    "reason" TEXT,
    "requestId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_approvals" (
    "id" UUID NOT NULL,
    "type" "PendingApprovalType" NOT NULL,
    "status" "PendingApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "requiredCapability" TEXT NOT NULL,
    "requiredApprovals" INTEGER NOT NULL DEFAULT 1,
    "mappingId" UUID,
    "requestedById" UUID NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "resolutionReason" TEXT,

    CONSTRAINT "pending_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_approval_votes" (
    "id" UUID NOT NULL,
    "approvalId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "approve" BOOLEAN NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_approval_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_primaryDiscordId_key" ON "users"("primaryDiscordId");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "discord_identities_discordUserId_key" ON "discord_identities"("discordUserId");

-- CreateIndex
CREATE INDEX "discord_identities_userId_idx" ON "discord_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "approved_guilds_discordGuildId_key" ON "approved_guilds"("discordGuildId");

-- CreateIndex
CREATE UNIQUE INDEX "approved_guilds_departmentId_key" ON "approved_guilds"("departmentId");

-- CreateIndex
CREATE INDEX "approved_guilds_enabled_idx" ON "approved_guilds"("enabled");

-- CreateIndex
CREATE INDEX "approved_guilds_type_idx" ON "approved_guilds"("type");

-- CreateIndex
CREATE INDEX "approved_guilds_deletedAt_idx" ON "approved_guilds"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "departments_key_key" ON "departments"("key");

-- CreateIndex
CREATE INDEX "departments_enabled_idx" ON "departments"("enabled");

-- CreateIndex
CREATE INDEX "departments_deletedAt_idx" ON "departments"("deletedAt");

-- CreateIndex
CREATE INDEX "ranks_departmentId_idx" ON "ranks"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ranks_departmentId_order_key" ON "ranks"("departmentId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ranks_departmentId_name_key" ON "ranks"("departmentId", "name");

-- CreateIndex
CREATE INDEX "department_memberships_departmentId_status_idx" ON "department_memberships"("departmentId", "status");

-- CreateIndex
CREATE INDEX "department_memberships_userId_idx" ON "department_memberships"("userId");

-- CreateIndex
CREATE INDEX "department_memberships_status_idx" ON "department_memberships"("status");

-- CreateIndex
CREATE UNIQUE INDEX "department_memberships_userId_departmentId_key" ON "department_memberships"("userId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "department_memberships_departmentId_callsign_key" ON "department_memberships"("departmentId", "callsign");

-- CreateIndex
CREATE INDEX "membership_events_membershipId_createdAt_idx" ON "membership_events"("membershipId", "createdAt");

-- CreateIndex
CREATE INDEX "membership_events_type_idx" ON "membership_events"("type");

-- CreateIndex
CREATE UNIQUE INDEX "certifications_key_key" ON "certifications"("key");

-- CreateIndex
CREATE INDEX "certifications_departmentId_idx" ON "certifications"("departmentId");

-- CreateIndex
CREATE INDEX "member_certifications_certificationId_idx" ON "member_certifications"("certificationId");

-- CreateIndex
CREATE INDEX "member_certifications_expiresAt_idx" ON "member_certifications"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "member_certifications_userId_certificationId_key" ON "member_certifications"("userId", "certificationId");

-- CreateIndex
CREATE INDEX "subdivisions_departmentId_idx" ON "subdivisions"("departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "subdivisions_departmentId_key_key" ON "subdivisions"("departmentId", "key");

-- CreateIndex
CREATE INDEX "member_subdivisions_subdivisionId_idx" ON "member_subdivisions"("subdivisionId");

-- CreateIndex
CREATE UNIQUE INDEX "member_subdivisions_userId_subdivisionId_key" ON "member_subdivisions"("userId", "subdivisionId");

-- CreateIndex
CREATE INDEX "managed_roles_departmentId_idx" ON "managed_roles"("departmentId");

-- CreateIndex
CREATE INDEX "managed_roles_purpose_idx" ON "managed_roles"("purpose");

-- CreateIndex
CREATE INDEX "managed_roles_rankId_idx" ON "managed_roles"("rankId");

-- CreateIndex
CREATE UNIQUE INDEX "managed_roles_approvedGuildId_discordRoleId_key" ON "managed_roles"("approvedGuildId", "discordRoleId");

-- CreateIndex
CREATE INDEX "manual_role_grants_userId_idx" ON "manual_role_grants"("userId");

-- CreateIndex
CREATE INDEX "manual_role_grants_managedRoleId_idx" ON "manual_role_grants"("managedRoleId");

-- CreateIndex
CREATE INDEX "manual_role_grants_expiresAt_idx" ON "manual_role_grants"("expiresAt");

-- CreateIndex
CREATE INDEX "role_mappings_sourceGuildId_sourceRoleId_idx" ON "role_mappings"("sourceGuildId", "sourceRoleId");

-- CreateIndex
CREATE INDEX "role_mappings_targetGuildId_targetRoleId_idx" ON "role_mappings"("targetGuildId", "targetRoleId");

-- CreateIndex
CREATE INDEX "role_mappings_enabled_idx" ON "role_mappings"("enabled");

-- CreateIndex
CREATE INDEX "role_mappings_deletedAt_idx" ON "role_mappings"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "role_mappings_sourceGuildId_sourceRoleId_targetGuildId_targ_key" ON "role_mappings"("sourceGuildId", "sourceRoleId", "targetGuildId", "targetRoleId");

-- CreateIndex
CREATE INDEX "permission_assignments_userId_idx" ON "permission_assignments"("userId");

-- CreateIndex
CREATE INDEX "permission_assignments_capabilityKey_idx" ON "permission_assignments"("capabilityKey");

-- CreateIndex
CREATE INDEX "permission_assignments_expiresAt_idx" ON "permission_assignments"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "permission_assignments_userId_capabilityKey_scopeType_scope_key" ON "permission_assignments"("userId", "capabilityKey", "scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "sync_jobs_status_createdAt_idx" ON "sync_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "sync_jobs_type_idx" ON "sync_jobs"("type");

-- CreateIndex
CREATE INDEX "sync_jobs_targetUserId_idx" ON "sync_jobs"("targetUserId");

-- CreateIndex
CREATE INDEX "sync_jobs_departmentId_idx" ON "sync_jobs"("departmentId");

-- CreateIndex
CREATE INDEX "sync_jobs_createdAt_idx" ON "sync_jobs"("createdAt");

-- CreateIndex
CREATE INDEX "sync_actions_syncJobId_idx" ON "sync_actions"("syncJobId");

-- CreateIndex
CREATE INDEX "sync_actions_discordUserId_idx" ON "sync_actions"("discordUserId");

-- CreateIndex
CREATE INDEX "sync_actions_status_idx" ON "sync_actions"("status");

-- CreateIndex
CREATE INDEX "sync_actions_createdAt_idx" ON "sync_actions"("createdAt");

-- CreateIndex
CREATE INDEX "sync_issues_resolved_createdAt_idx" ON "sync_issues"("resolved", "createdAt");

-- CreateIndex
CREATE INDEX "sync_issues_type_idx" ON "sync_issues"("type");

-- CreateIndex
CREATE INDEX "sync_issues_userId_idx" ON "sync_issues"("userId");

-- CreateIndex
CREATE INDEX "sync_issues_approvedGuildId_idx" ON "sync_issues"("approvedGuildId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_actorUserId_createdAt_idx" ON "audit_logs"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_targetUserId_createdAt_idx" ON "audit_logs"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_approvedGuildId_createdAt_idx" ON "audit_logs"("approvedGuildId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_mappingId_idx" ON "audit_logs"("mappingId");

-- CreateIndex
CREATE INDEX "audit_logs_syncJobId_idx" ON "audit_logs"("syncJobId");

-- CreateIndex
CREATE INDEX "audit_logs_requestId_idx" ON "audit_logs"("requestId");

-- CreateIndex
CREATE INDEX "pending_approvals_status_expiresAt_idx" ON "pending_approvals"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "pending_approvals_type_idx" ON "pending_approvals"("type");

-- CreateIndex
CREATE UNIQUE INDEX "pending_approval_votes_approvalId_userId_key" ON "pending_approval_votes"("approvalId", "userId");

-- AddForeignKey
ALTER TABLE "discord_identities" ADD CONSTRAINT "discord_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discord_identities" ADD CONSTRAINT "discord_identities_linkedById_fkey" FOREIGN KEY ("linkedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approved_guilds" ADD CONSTRAINT "approved_guilds_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approved_guilds" ADD CONSTRAINT "approved_guilds_registeredById_fkey" FOREIGN KEY ("registeredById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approved_guilds" ADD CONSTRAINT "approved_guilds_removedById_fkey" FOREIGN KEY ("removedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranks" ADD CONSTRAINT "ranks_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_memberships" ADD CONSTRAINT "department_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_memberships" ADD CONSTRAINT "department_memberships_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_memberships" ADD CONSTRAINT "department_memberships_rankId_fkey" FOREIGN KEY ("rankId") REFERENCES "ranks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_events" ADD CONSTRAINT "membership_events_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "department_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_events" ADD CONSTRAINT "membership_events_fromRankId_fkey" FOREIGN KEY ("fromRankId") REFERENCES "ranks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_events" ADD CONSTRAINT "membership_events_toRankId_fkey" FOREIGN KEY ("toRankId") REFERENCES "ranks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_events" ADD CONSTRAINT "membership_events_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certifications" ADD CONSTRAINT "certifications_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_certifications" ADD CONSTRAINT "member_certifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_certifications" ADD CONSTRAINT "member_certifications_certificationId_fkey" FOREIGN KEY ("certificationId") REFERENCES "certifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_certifications" ADD CONSTRAINT "member_certifications_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_certifications" ADD CONSTRAINT "member_certifications_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subdivisions" ADD CONSTRAINT "subdivisions_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_subdivisions" ADD CONSTRAINT "member_subdivisions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_subdivisions" ADD CONSTRAINT "member_subdivisions_subdivisionId_fkey" FOREIGN KEY ("subdivisionId") REFERENCES "subdivisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_subdivisions" ADD CONSTRAINT "member_subdivisions_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_roles" ADD CONSTRAINT "managed_roles_approvedGuildId_fkey" FOREIGN KEY ("approvedGuildId") REFERENCES "approved_guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_roles" ADD CONSTRAINT "managed_roles_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_roles" ADD CONSTRAINT "managed_roles_rankId_fkey" FOREIGN KEY ("rankId") REFERENCES "ranks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_roles" ADD CONSTRAINT "managed_roles_certificationId_fkey" FOREIGN KEY ("certificationId") REFERENCES "certifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_roles" ADD CONSTRAINT "managed_roles_subdivisionId_fkey" FOREIGN KEY ("subdivisionId") REFERENCES "subdivisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_role_grants" ADD CONSTRAINT "manual_role_grants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_role_grants" ADD CONSTRAINT "manual_role_grants_managedRoleId_fkey" FOREIGN KEY ("managedRoleId") REFERENCES "managed_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_role_grants" ADD CONSTRAINT "manual_role_grants_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_role_grants" ADD CONSTRAINT "manual_role_grants_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_mappings" ADD CONSTRAINT "role_mappings_sourceGuildId_fkey" FOREIGN KEY ("sourceGuildId") REFERENCES "approved_guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_mappings" ADD CONSTRAINT "role_mappings_targetGuildId_fkey" FOREIGN KEY ("targetGuildId") REFERENCES "approved_guilds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_mappings" ADD CONSTRAINT "role_mappings_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_assignments" ADD CONSTRAINT "permission_assignments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_assignments" ADD CONSTRAINT "permission_assignments_capabilityKey_fkey" FOREIGN KEY ("capabilityKey") REFERENCES "permission_capabilities"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_assignments" ADD CONSTRAINT "permission_assignments_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "permission_assignments" ADD CONSTRAINT "permission_assignments_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_initiatedById_fkey" FOREIGN KEY ("initiatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_approvedGuildId_fkey" FOREIGN KEY ("approvedGuildId") REFERENCES "approved_guilds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "role_mappings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_parentJobId_fkey" FOREIGN KEY ("parentJobId") REFERENCES "sync_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_actions" ADD CONSTRAINT "sync_actions_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "sync_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_actions" ADD CONSTRAINT "sync_actions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_actions" ADD CONSTRAINT "sync_actions_approvedGuildId_fkey" FOREIGN KEY ("approvedGuildId") REFERENCES "approved_guilds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_actions" ADD CONSTRAINT "sync_actions_managedRoleId_fkey" FOREIGN KEY ("managedRoleId") REFERENCES "managed_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_actions" ADD CONSTRAINT "sync_actions_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "role_mappings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "sync_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_syncActionId_fkey" FOREIGN KEY ("syncActionId") REFERENCES "sync_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_approvedGuildId_fkey" FOREIGN KEY ("approvedGuildId") REFERENCES "approved_guilds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "role_mappings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_issues" ADD CONSTRAINT "sync_issues_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_approvedGuildId_fkey" FOREIGN KEY ("approvedGuildId") REFERENCES "approved_guilds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "role_mappings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "sync_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "role_mappings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_approval_votes" ADD CONSTRAINT "pending_approval_votes_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "pending_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_approval_votes" ADD CONSTRAINT "pending_approval_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
