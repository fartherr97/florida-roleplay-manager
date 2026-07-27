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
export const MembershipStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  LOA: 'LOA',
  SUSPENDED: 'SUSPENDED',
  TERMINATED: 'TERMINATED',
  TRANSFER_PENDING: 'TRANSFER_PENDING',
  INACTIVE: 'INACTIVE',
});

/** Statuses that still represent a person who belongs to the department. */
export const ACTIVE_MEMBERSHIP_STATUSES = Object.freeze([
  MembershipStatus.ACTIVE,
  MembershipStatus.LOA,
  MembershipStatus.SUSPENDED,
  MembershipStatus.TRANSFER_PENDING,
]);

/** @readonly */
export const MembershipEventType = Object.freeze({
  HIRED: 'HIRED',
  REHIRED: 'REHIRED',
  PROMOTED: 'PROMOTED',
  DEMOTED: 'DEMOTED',
  TRANSFERRED_IN: 'TRANSFERRED_IN',
  TRANSFERRED_OUT: 'TRANSFERRED_OUT',
  LOA_STARTED: 'LOA_STARTED',
  LOA_ENDED: 'LOA_ENDED',
  SUSPENDED: 'SUSPENDED',
  REINSTATED: 'REINSTATED',
  TERMINATED: 'TERMINATED',
  CALLSIGN_CHANGED: 'CALLSIGN_CHANGED',
  NOTE_ADDED: 'NOTE_ADDED',
});

/** @readonly */
export const MappingDirection = Object.freeze({
  ONE_WAY: 'ONE_WAY',
  TWO_WAY: 'TWO_WAY',
});

/**
 * Which system decides the correct value of a managed role.
 *
 * - ROSTER          the database roster is authoritative (official ranks, membership)
 * - SOURCE_DISCORD  the mapping source guild's Discord state is authoritative
 * - TARGET_DISCORD  the mapping target guild's Discord state is authoritative
 * - MANUAL          an explicit, time-bounded human grant is authoritative
 * - SYSTEM          the platform itself owns the role (internal bookkeeping)
 *
 * @readonly
 */
export const AuthoritySource = Object.freeze({
  ROSTER: 'ROSTER',
  SOURCE_DISCORD: 'SOURCE_DISCORD',
  TARGET_DISCORD: 'TARGET_DISCORD',
  MANUAL: 'MANUAL',
  SYSTEM: 'SYSTEM',
});

/**
 * Why the platform manages a particular Discord role. Only roles with a
 * `ManagedRole` record may ever be removed by the reconciliation engine.
 * @readonly
 */
export const RolePurpose = Object.freeze({
  DEPARTMENT_MEMBERSHIP: 'DEPARTMENT_MEMBERSHIP',
  RANK: 'RANK',
  SUPERVISOR: 'SUPERVISOR',
  COMMAND: 'COMMAND',
  CERTIFICATION: 'CERTIFICATION',
  SUBDIVISION: 'SUBDIVISION',
  STATUS_LOA: 'STATUS_LOA',
  STATUS_SUSPENDED: 'STATUS_SUSPENDED',
  MAPPING: 'MAPPING',
  MANUAL_GRANT: 'MANUAL_GRANT',
  OTHER: 'OTHER',
});

/** Role purposes whose desired state comes from roster data. */
export const ROSTER_DRIVEN_PURPOSES = Object.freeze([
  RolePurpose.DEPARTMENT_MEMBERSHIP,
  RolePurpose.RANK,
  RolePurpose.SUPERVISOR,
  RolePurpose.COMMAND,
  RolePurpose.CERTIFICATION,
  RolePurpose.SUBDIVISION,
  RolePurpose.STATUS_LOA,
  RolePurpose.STATUS_SUSPENDED,
]);

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
  DEPARTMENT: 'DEPARTMENT',
  SUBDIVISION: 'SUBDIVISION',
});

/** @readonly */
export const SyncJobType = Object.freeze({
  MEMBER_RESYNC: 'MEMBER_RESYNC',
  DEPARTMENT_RESYNC: 'DEPARTMENT_RESYNC',
  GUILD_RESYNC: 'GUILD_RESYNC',
  GLOBAL_RESYNC: 'GLOBAL_RESYNC',
  ROLE_ADD: 'ROLE_ADD',
  ROLE_REMOVE: 'ROLE_REMOVE',
  ROSTER_CHANGE: 'ROSTER_CHANGE',
  MAPPING_PROPAGATION: 'MAPPING_PROPAGATION',
  SCHEDULED_RECONCILIATION: 'SCHEDULED_RECONCILIATION',
  MAPPING_VALIDATION: 'MAPPING_VALIDATION',
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
  UNKNOWN: 'UNKNOWN',
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

  MAPPING_CREATED: 'mapping.created',
  MAPPING_UPDATED: 'mapping.updated',
  MAPPING_DELETED: 'mapping.deleted',
  MAPPING_ENABLED: 'mapping.enabled',
  MAPPING_DISABLED: 'mapping.disabled',
  MAPPING_TESTED: 'mapping.tested',
  MAPPING_REJECTED: 'mapping.rejected',

  ROSTER_HIRED: 'roster.hired',
  ROSTER_REMOVED: 'roster.removed',
  ROSTER_PROMOTED: 'roster.promoted',
  ROSTER_DEMOTED: 'roster.demoted',
  ROSTER_TRANSFERRED: 'roster.transferred',
  ROSTER_LOA_STARTED: 'roster.loa_started',
  ROSTER_LOA_ENDED: 'roster.loa_ended',
  ROSTER_SUSPENDED: 'roster.suspended',
  ROSTER_REINSTATED: 'roster.reinstated',
  ROSTER_CALLSIGN_CHANGED: 'roster.callsign_changed',

  CERTIFICATION_ASSIGNED: 'certification.assigned',
  CERTIFICATION_REMOVED: 'certification.removed',
  SUBDIVISION_ADDED: 'subdivision.added',
  SUBDIVISION_REMOVED: 'subdivision.removed',

  MEMBER_LINKED: 'member.linked',
  MEMBER_UNLINKED: 'member.unlinked',

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

  SYSTEM_SETTING_UPDATED: 'system.setting_updated',
});
