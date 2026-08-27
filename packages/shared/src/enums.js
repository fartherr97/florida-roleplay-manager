/**
 * Domain enumerations.
 *
 * These mirror the enums declared in `prisma/schema.prisma`. `@frm/shared` must not
 * depend on the database package (that would create a cycle), so the values are
 * duplicated here and a test (`tests/unit/enum-parity.test.js`) asserts that the two
 * definitions never drift apart.
 */

/** @readonly */
export const GuildType = Object.freeze({
  MAIN_COMMUNITY: 'MAIN_COMMUNITY',
  DEPARTMENT: 'DEPARTMENT',
  SUBDIVISION: 'SUBDIVISION',
  STAFF: 'STAFF',
  OTHER: 'OTHER',
});

/** @readonly */
export const UserStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  BANNED: 'BANNED',
});

/** @readonly */
export const MappingDirection = Object.freeze({
  ONE_WAY: 'ONE_WAY',
  TWO_WAY: 'TWO_WAY',
});

/**
 * Which system decides the correct value of a managed role.
 *
 * - SOURCE_DISCORD  the mapping source guild's Discord state is authoritative
 * - TARGET_DISCORD  the mapping target guild's Discord state is authoritative
 * - MANUAL          an explicit, time-bounded human grant is authoritative
 * - SYSTEM          the platform itself owns the role (internal bookkeeping)
 *
 * @readonly
 */
export const AuthoritySource = Object.freeze({
  SOURCE_DISCORD: 'SOURCE_DISCORD',
  TARGET_DISCORD: 'TARGET_DISCORD',
  MANUAL: 'MANUAL',
  SYSTEM: 'SYSTEM',
});

/**
 * Why the platform manages a particular Discord role. Only roles with a
 * `ManagedRole` record may ever be removed by the reconciliation engine.
 *
 * - MAPPING       participates in cross-guild mappings
 * - MANUAL_GRANT  granted through a time-bounded manual grant
 * - OTHER         known to the platform but never added or removed automatically
 *
 * @readonly
 */
export const RolePurpose = Object.freeze({
  MAPPING: 'MAPPING',
  MANUAL_GRANT: 'MANUAL_GRANT',
  OTHER: 'OTHER',
});

/**
 * How strongly a role is protected.
 * - NONE       ordinary managed role
 * - ELEVATED   requires an elevated capability to map or modify
 * - TWO_PERSON requires a second approver before a mapping becomes active
 * @readonly
 */
export const ProtectionLevel = Object.freeze({
  NONE: 'NONE',
  ELEVATED: 'ELEVATED',
  TWO_PERSON: 'TWO_PERSON',
});

/** @readonly */
export const PermissionScopeType = Object.freeze({
  GLOBAL: 'GLOBAL',
  GUILD: 'GUILD',
});

/** @readonly */
export const SyncJobType = Object.freeze({
  MEMBER_RESYNC: 'MEMBER_RESYNC',
  GUILD_RESYNC: 'GUILD_RESYNC',
  GLOBAL_RESYNC: 'GLOBAL_RESYNC',
  ROLE_ADD: 'ROLE_ADD',
  ROLE_REMOVE: 'ROLE_REMOVE',
  MAPPING_PROPAGATION: 'MAPPING_PROPAGATION',
  GRANT_CHANGE: 'GRANT_CHANGE',
  SCHEDULED_RECONCILIATION: 'SCHEDULED_RECONCILIATION',
  MAPPING_VALIDATION: 'MAPPING_VALIDATION',
  ROSTER_MEMBER_SYNC: 'ROSTER_MEMBER_SYNC',
  ROSTER_SYNC: 'ROSTER_SYNC',
});

/**
 * PAUSED is an extension of the statuses named in the specification: it is the
 * state a job enters when the maximum-change threshold trips, so that a human
 * can review before anything destructive happens.
 * @readonly
 */
export const SyncJobStatus = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  PARTIAL: 'PARTIAL',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  PAUSED: 'PAUSED',
});

/** Job statuses that mean the job is no longer executing. */
export const TERMINAL_JOB_STATUSES = Object.freeze([
  SyncJobStatus.COMPLETED,
  SyncJobStatus.FAILED,
  SyncJobStatus.CANCELLED,
  SyncJobStatus.PARTIAL,
]);

/** @readonly */
export const SyncActionType = Object.freeze({
  ADD_ROLE: 'ADD_ROLE',
  REMOVE_ROLE: 'REMOVE_ROLE',
});

/** @readonly */
export const SyncActionStatus = Object.freeze({
  PENDING: 'PENDING',
  APPLIED: 'APPLIED',
  SKIPPED: 'SKIPPED',
  FAILED: 'FAILED',
  DRY_RUN: 'DRY_RUN',
});

/** @readonly */
export const SyncIssueType = Object.freeze({
  MEMBER_NOT_IN_GUILD: 'MEMBER_NOT_IN_GUILD',
  MEMBER_NOT_LINKED: 'MEMBER_NOT_LINKED',
  BOT_MISSING_PERMISSION: 'BOT_MISSING_PERMISSION',
  BOT_NOT_IN_GUILD: 'BOT_NOT_IN_GUILD',
  ROLE_ABOVE_BOT: 'ROLE_ABOVE_BOT',
  ROLE_DELETED: 'ROLE_DELETED',
  INVALID_ROLE_REFERENCE: 'INVALID_ROLE_REFERENCE',
  INTEGRATION_MANAGED_ROLE: 'INTEGRATION_MANAGED_ROLE',
  PROTECTED_ROLE_VIOLATION: 'PROTECTED_ROLE_VIOLATION',
  GUILD_UNAVAILABLE: 'GUILD_UNAVAILABLE',
  GUILD_NOT_APPROVED: 'GUILD_NOT_APPROVED',
  RATE_LIMITED: 'RATE_LIMITED',
  API_TIMEOUT: 'API_TIMEOUT',
  DISCORD_ERROR: 'DISCORD_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  REDIS_ERROR: 'REDIS_ERROR',
  MAPPING_CONFLICT: 'MAPPING_CONFLICT',
  THRESHOLD_EXCEEDED: 'THRESHOLD_EXCEEDED',
  ENQUEUE_FAILED: 'ENQUEUE_FAILED',
  /// The bot cannot rename this member: they own the server, or they outrank the bot.
  MEMBER_ABOVE_BOT: 'MEMBER_ABOVE_BOT',
  UNKNOWN: 'UNKNOWN',
});

/** @readonly */
export const RosterMembershipStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  DEPARTED: 'DEPARTED',
});

/** @readonly */
export const IssueSeverity = Object.freeze({
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
});

/** @readonly */
export const ActionSource = Object.freeze({
  DISCORD: 'DISCORD',
  WEBSITE: 'WEBSITE',
  SYSTEM: 'SYSTEM',
  SCHEDULED: 'SCHEDULED',
});

/** @readonly */
export const PendingApprovalType = Object.freeze({
  MAPPING_ACTIVATION: 'MAPPING_ACTIVATION',
  PROTECTED_ROLE_MAPPING: 'PROTECTED_ROLE_MAPPING',
  GUILD_REGISTRATION: 'GUILD_REGISTRATION',
  GUILD_REMOVAL: 'GUILD_REMOVAL',
  GLOBAL_RESYNC: 'GLOBAL_RESYNC',
});

/** @readonly */
export const PendingApprovalStatus = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
});

/**
 * Audit action keys. Stored as a string column so new actions never require a
 * migration, but always drawn from this list so reporting stays consistent.
 */
export const AuditAction = Object.freeze({
  GUILD_REGISTERED: 'guild.registered',
  GUILD_REMOVED: 'guild.removed',
  GUILD_SETTINGS_UPDATED: 'guild.settings_updated',
  GUILD_UNAPPROVED_JOIN: 'guild.unapproved_join',
  GUILD_AUTO_LEFT: 'guild.auto_left',
  GUILD_DELETED_EXTERNALLY: 'guild.deleted_externally',
  GUILD_PROVISIONED: 'guild.provisioned',
  GUILD_PERMISSIONS_RESET: 'guild.permissions_reset',

  MAPPING_CREATED: 'mapping.created',
  MAPPING_UPDATED: 'mapping.updated',
  MAPPING_DELETED: 'mapping.deleted',
  MAPPING_ENABLED: 'mapping.enabled',
  MAPPING_DISABLED: 'mapping.disabled',
  MAPPING_TESTED: 'mapping.tested',
  MAPPING_REJECTED: 'mapping.rejected',

  MANAGED_ROLE_UPSERTED: 'managed_role.upserted',
  MANAGED_ROLE_REMOVED: 'managed_role.removed',

  GRANT_ISSUED: 'grant.issued',
  GRANT_REVOKED: 'grant.revoked',

  ROLE_GRANT_RULE_ADDED: 'role_grant.rule_added',
  ROLE_GRANT_RULE_REMOVED: 'role_grant.rule_removed',
  ROLE_SELF_SERVICE_ASSIGNED: 'role_grant.assigned',
  ROLE_SELF_SERVICE_REMOVED: 'role_grant.removed',

  MEMBER_LINKED: 'member.linked',
  MEMBER_UNLINKED: 'member.unlinked',
  MEMBER_AUTO_PROVISIONED: 'member.auto_provisioned',
  MEMBER_GLOBAL_BANNED: 'member.global_banned',
  MEMBER_GLOBAL_UNBANNED: 'member.global_unbanned',
  MEMBER_ROLE_TEMP_ADDED: 'member.role_temp_added',
  MEMBER_ROLE_TEMP_REMOVED: 'member.role_temp_removed',

  ACCESS_TIER_SET: 'access.tier_set',
  ACCESS_TIER_REMOVED: 'access.tier_removed',
  WEBSITE_ACCESS_GRANTED: 'access.website_granted',
  WEBSITE_ACCESS_REVOKED: 'access.website_revoked',

  SYNC_JOB_CREATED: 'sync.job_created',
  SYNC_JOB_COMPLETED: 'sync.job_completed',
  SYNC_JOB_FAILED: 'sync.job_failed',
  SYNC_JOB_PAUSED: 'sync.job_paused',
  SYNC_JOB_CANCELLED: 'sync.job_cancelled',
  SYNC_ROLE_ADDED: 'sync.role_added',
  SYNC_ROLE_REMOVED: 'sync.role_removed',
  SYNC_ACTION_FAILED: 'sync.action_failed',
  SYNC_ISSUE_RESOLVED: 'sync.issue_resolved',

  PERMISSION_GRANTED: 'permission.granted',
  PERMISSION_REVOKED: 'permission.revoked',

  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_APPROVED: 'approval.approved',
  APPROVAL_REJECTED: 'approval.rejected',

  AUTH_LOGIN: 'auth.login',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_DENIED: 'auth.denied',

  ROSTER_CREATED: 'roster.created',
  ROSTER_UPDATED: 'roster.updated',
  ROSTER_DELETED: 'roster.deleted',
  ROSTER_RANK_BOUND: 'roster.rank_bound',
  ROSTER_RANK_UNBOUND: 'roster.rank_unbound',
  ROSTER_MEMBER_ADDED: 'roster.member_added',
  ROSTER_MEMBER_RANK_CHANGED: 'roster.member_rank_changed',
  ROSTER_MEMBER_REMOVED: 'roster.member_removed',
  ROSTER_MEMBER_UPDATED: 'roster.member_updated',
  ROSTER_NICKNAME_SET: 'roster.nickname_set',

  TRANSFER_ROLES_SET: 'transfer.roles_set',
  TRANSFER_EXECUTED: 'transfer.executed',

  WHITELIST_SUBMITTED: 'whitelist.submitted',
  WHITELIST_APPROVED: 'whitelist.approved',
  WHITELIST_DENIED: 'whitelist.denied',

  SYSTEM_SETTING_UPDATED: 'system.setting_updated',
  LOG_WEBHOOK_SET: 'system.log_webhook_set',
  LOG_WEBHOOK_CLEARED: 'system.log_webhook_cleared',
});
