/**
 * Domain input schemas.
 *
 * These are the single definition of "what a valid request looks like" for both the
 * Discord bot and the REST API, which is what keeps the two boundaries from drifting.
 */
import { z } from 'zod';
import {
  AuthoritySource,
  CAPABILITY_KEYS,
  GuildType,
  MappingDirection,
  MembershipStatus,
  PermissionScopeType,
  RolePurpose,
  SyncIssueType,
  SyncJobStatus,
} from '@frm/shared';
import {
  booleanFlag,
  callsign,
  displayName,
  isoDate,
  notes,
  optionalIsoDate,
  optionalReason,
  optionalSnowflake,
  pagination,
  paginationWithSort,
  reason,
  slug,
  snowflake,
  uuid,
} from './common.js';

const enumOf = (obj) => z.enum(Object.values(obj));

// ---------------------------------------------------------------------------
// Guilds
// ---------------------------------------------------------------------------

export const registerGuildSchema = z.object({
  discordGuildId: snowflake,
  name: displayName,
  type: enumOf(GuildType),
  departmentId: uuid.optional(),
  syncEnabled: booleanFlag.default(true),
  features: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  reason,
});

export const updateGuildSettingsSchema = z.object({
  guildId: uuid,
  name: displayName.optional(),
  enabled: booleanFlag.optional(),
  syncEnabled: booleanFlag.optional(),
  departmentId: uuid.nullable().optional(),
  features: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  reason,
});

export const removeGuildSchema = z.object({
  guildId: uuid,
  reason,
});

export const listGuildsSchema = paginationWithSort(
  ['registeredAt', 'name', 'type'],
  'registeredAt',
).extend({
  type: enumOf(GuildType).optional(),
  enabled: booleanFlag.optional(),
  search: z.string().trim().max(100).optional(),
});

// ---------------------------------------------------------------------------
// Role mappings
// ---------------------------------------------------------------------------

export const createMappingSchema = z
  .object({
    name: displayName,
    sourceGuildId: snowflake,
    sourceRoleId: snowflake,
    targetGuildId: snowflake,
    targetRoleId: snowflake,
    direction: enumOf(MappingDirection).default(MappingDirection.ONE_WAY),
    authority: enumOf(AuthoritySource).default(AuthoritySource.SOURCE_DISCORD),
    syncAdd: booleanFlag.default(true),
    syncRemove: booleanFlag.default(true),
    priority: z.coerce.number().int().min(0).max(1000).default(100),
    enabled: booleanFlag.default(false),
    reason,
  })
  .refine(
    (value) =>
      !(value.sourceGuildId === value.targetGuildId && value.sourceRoleId === value.targetRoleId),
    { message: 'A role cannot be mapped to itself', path: ['targetRoleId'] },
  );

export const updateMappingSchema = z.object({
  mappingId: uuid,
  name: displayName.optional(),
  direction: enumOf(MappingDirection).optional(),
  authority: enumOf(AuthoritySource).optional(),
  syncAdd: booleanFlag.optional(),
  syncRemove: booleanFlag.optional(),
  priority: z.coerce.number().int().min(0).max(1000).optional(),
  reason,
});

export const mappingIdSchema = z.object({ mappingId: uuid, reason: optionalReason });

export const setMappingEnabledSchema = z.object({
  mappingId: uuid,
  enabled: z.boolean(),
  reason,
});

export const listMappingsSchema = paginationWithSort(
  ['createdAt', 'name', 'priority'],
  'createdAt',
).extend({
  guildId: optionalSnowflake,
  roleId: optionalSnowflake,
  enabled: booleanFlag.optional(),
  direction: enumOf(MappingDirection).optional(),
  search: z.string().trim().max(100).optional(),
});

// ---------------------------------------------------------------------------
// Departments, ranks, managed roles
// ---------------------------------------------------------------------------

export const createDepartmentSchema = z.object({
  key: slug,
  name: displayName,
  abbreviation: z.string().trim().min(1).max(12),
  guildId: uuid.optional(),
  loaRoleId: optionalSnowflake,
  suspendedRoleId: optionalSnowflake,
  removeRankRolesOnLoa: booleanFlag.default(false),
  removeRankRolesOnSuspension: booleanFlag.default(true),
  reason,
});

export const createRankSchema = z.object({
  departmentId: uuid,
  name: displayName,
  abbreviation: z.string().trim().max(12).optional(),
  order: z.coerce.number().int().min(0).max(1000),
  isSupervisor: booleanFlag.default(false),
  isCommand: booleanFlag.default(false),
  reason,
});

export const upsertManagedRoleSchema = z.object({
  guildId: uuid,
  discordRoleId: snowflake,
  name: displayName,
  purpose: enumOf(RolePurpose),
  departmentId: uuid.optional(),
  rankId: uuid.optional(),
  certificationId: uuid.optional(),
  subdivisionId: uuid.optional(),
  protectionLevel: z.enum(['NONE', 'ELEVATED', 'TWO_PERSON']).default('NONE'),
  reason,
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const memberLookupSchema = z
  .object({
    discordUserId: optionalSnowflake,
    userId: uuid.optional(),
    callsign: callsign.optional(),
  })
  .refine((value) => value.discordUserId || value.userId || value.callsign, {
    message: 'Provide a Discord user, a member id or a callsign',
  });

export const linkMemberSchema = z.object({
  discordUserId: snowflake,
  userId: uuid.optional(),
  displayName: displayName.optional(),
  reason,
});

export const unlinkMemberSchema = z.object({
  discordUserId: snowflake,
  reason,
});

export const memberHistorySchema = pagination.extend({
  userId: uuid.optional(),
  discordUserId: optionalSnowflake,
});

// ---------------------------------------------------------------------------
// Roster actions
// ---------------------------------------------------------------------------

const rosterTarget = {
  departmentId: uuid,
  userId: uuid.optional(),
  discordUserId: optionalSnowflake,
};

/** Every roster action must identify the target by platform id or Discord id. */
const withTarget = (shape) =>
  z
    .object({ ...rosterTarget, ...shape })
    .refine((value) => Boolean(value.userId || value.discordUserId), {
      message: 'Provide the member to act on',
      path: ['discordUserId'],
    });

export const hireSchema = withTarget({
  rankId: uuid,
  callsign: callsign.optional(),
  hireDate: optionalIsoDate,
  badgeNumber: z.string().trim().max(20).optional(),
  notes,
  reason,
});

export const promoteSchema = withTarget({ rankId: uuid, reason, notes });
export const demoteSchema = withTarget({ rankId: uuid, reason, notes });

export const transferSchema = withTarget({
  targetDepartmentId: uuid,
  targetRankId: uuid,
  keepCallsign: booleanFlag.default(false),
  reason,
  notes,
});

export const loaSchema = withTarget({
  until: optionalIsoDate,
  reason,
  notes,
});

export const returnFromLoaSchema = withTarget({ reason, notes });

export const suspendSchema = withTarget({
  until: optionalIsoDate,
  reason,
  notes,
});

export const reinstateSchema = withTarget({ reason, notes });

export const removeMemberSchema = withTarget({ reason, notes });

export const changeCallsignSchema = withTarget({ callsign, reason });

export const rosterListSchema = paginationWithSort(
  ['rankOrder', 'callsign', 'hireDate', 'status'],
  'rankOrder',
).extend({
  departmentId: uuid.optional(),
  status: enumOf(MembershipStatus).optional(),
  rankId: uuid.optional(),
  subdivisionId: uuid.optional(),
  search: z.string().trim().max(100).optional(),
});

// ---------------------------------------------------------------------------
// Certifications and subdivisions
// ---------------------------------------------------------------------------

export const assignCertificationSchema = z
  .object({
    certificationId: uuid,
    userId: uuid.optional(),
    discordUserId: optionalSnowflake,
    expiresAt: optionalIsoDate,
    reason,
  })
  .refine((value) => Boolean(value.userId || value.discordUserId), {
    message: 'Provide the member to act on',
    path: ['discordUserId'],
  });

export const removeCertificationSchema = z
  .object({
    certificationId: uuid,
    userId: uuid.optional(),
    discordUserId: optionalSnowflake,
    reason,
  })
  .refine((value) => Boolean(value.userId || value.discordUserId), {
    message: 'Provide the member to act on',
    path: ['discordUserId'],
  });

export const subdivisionMembershipSchema = z
  .object({
    subdivisionId: uuid,
    userId: uuid.optional(),
    discordUserId: optionalSnowflake,
    reason,
  })
  .refine((value) => Boolean(value.userId || value.discordUserId), {
    message: 'Provide the member to act on',
    path: ['discordUserId'],
  });

// ---------------------------------------------------------------------------
// Synchronization
// ---------------------------------------------------------------------------

export const resyncMemberSchema = z
  .object({
    userId: uuid.optional(),
    discordUserId: optionalSnowflake,
    dryRun: booleanFlag.optional(),
    reason: optionalReason,
  })
  .refine((value) => Boolean(value.userId || value.discordUserId), {
    message: 'Provide the member to resynchronize',
    path: ['discordUserId'],
  });

export const resyncDepartmentSchema = z.object({
  departmentId: uuid,
  dryRun: booleanFlag.optional(),
  includeInactive: booleanFlag.default(false),
  reason: optionalReason,
});

export const resyncGuildSchema = z.object({
  guildId: uuid,
  dryRun: booleanFlag.optional(),
  reason: optionalReason,
});

export const resyncAllSchema = z.object({
  dryRun: booleanFlag.optional(),
  confirmationToken: z.string().trim().min(8).optional(),
  reason,
});

export const syncJobListSchema = paginationWithSort(
  ['createdAt', 'status', 'type'],
  'createdAt',
).extend({
  status: enumOf(SyncJobStatus).optional(),
  departmentId: uuid.optional(),
  guildId: uuid.optional(),
  userId: uuid.optional(),
});

export const syncIssueListSchema = paginationWithSort(
  ['createdAt', 'severity'],
  'createdAt',
).extend({
  type: enumOf(SyncIssueType).optional(),
  resolved: booleanFlag.optional(),
  guildId: uuid.optional(),
  userId: uuid.optional(),
});

export const retryIssueSchema = z.object({ issueId: uuid, reason: optionalReason });

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export const grantPermissionSchema = z
  .object({
    userId: uuid.optional(),
    discordUserId: optionalSnowflake,
    capability: z.enum(CAPABILITY_KEYS),
    scopeType: enumOf(PermissionScopeType),
    scopeId: uuid.optional(),
    maxRankOrder: z.coerce.number().int().min(0).max(1000).optional(),
    maxPermissionLevel: z.coerce.number().int().min(0).max(100).optional(),
    expiresAt: optionalIsoDate,
    reason,
  })
  .refine((value) => Boolean(value.userId || value.discordUserId), {
    message: 'Provide the user to grant to',
    path: ['discordUserId'],
  })
  .refine((value) => value.scopeType === PermissionScopeType.GLOBAL || Boolean(value.scopeId), {
    message: 'A non-global scope requires a scope id',
    path: ['scopeId'],
  });

export const revokePermissionSchema = z.object({
  assignmentId: uuid,
  reason,
});

export const listPermissionsSchema = pagination.extend({
  userId: uuid.optional(),
  discordUserId: optionalSnowflake,
  capability: z.enum(CAPABILITY_KEYS).optional(),
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const auditQuerySchema = paginationWithSort(['createdAt'], 'createdAt').extend({
  actorUserId: uuid.optional(),
  actorDiscordId: optionalSnowflake,
  targetUserId: uuid.optional(),
  targetDiscordId: optionalSnowflake,
  departmentId: uuid.optional(),
  guildId: uuid.optional(),
  mappingId: uuid.optional(),
  syncJobId: uuid.optional(),
  action: z.string().trim().max(64).optional(),
  success: booleanFlag.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
