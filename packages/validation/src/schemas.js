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
  PermissionScopeType,
  RolePurpose,
  SyncIssueType,
  SyncJobStatus,
} from '@frm/shared';
import {
  booleanFlag,
  displayName,
  isoDate,
  optionalIsoDate,
  optionalReason,
  optionalSnowflake,
  pagination,
  paginationWithSort,
  reason,
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
  syncEnabled: booleanFlag.default(true),
  features: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  reason,
});

export const updateGuildSettingsSchema = z.object({
  guildId: uuid,
  name: displayName.optional(),
  enabled: booleanFlag.optional(),
  syncEnabled: booleanFlag.optional(),
  features: z.array(z.string().trim().min(1).max(64)).max(32).optional(),
  reason,
});

export const removeGuildSchema = z.object({
  guildId: uuid,
  reason,
});

/** A role colour given as a hex string (with or without '#'), parsed to an int. */
const hexColor = z
  .string()
  .trim()
  .regex(/^#?[0-9a-fA-F]{6}$/, 'Use a hex colour like #1F8B4C')
  .transform((value) => Number.parseInt(value.replace('#', ''), 16));

export const provisionDepartmentSchema = z.object({
  discordGuildId: snowflake,
  name: displayName,
  tag: z.string().trim().min(1).max(20),
  color: hexColor.optional(),
  wireIn: booleanFlag.default(true),
  // The main community's member role, used to build the sync mapping. The main community
  // guild is resolved from the allowlist, so only the role id is needed here.
  mainCommunityRoleId: optionalSnowflake,
  dryRun: booleanFlag.default(false),
  reason: optionalReason,
});

export const provisionCommunitySchema = z.object({
  discordGuildId: snowflake,
  name: displayName,
  color: hexColor.optional(),
  wireIn: booleanFlag.default(true),
  dryRun: booleanFlag.default(false),
  reason: optionalReason,
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
// Managed roles
// ---------------------------------------------------------------------------

export const upsertManagedRoleSchema = z.object({
  guildId: uuid,
  discordRoleId: snowflake,
  name: displayName,
  purpose: enumOf(RolePurpose).default(RolePurpose.MAPPING),
  protectionLevel: z.enum(['NONE', 'ELEVATED', 'TWO_PERSON']).default('NONE'),
  managedByPlatform: booleanFlag.default(true),
  reason,
});

export const removeManagedRoleSchema = z.object({
  managedRoleId: uuid,
  reason,
});

export const listManagedRolesSchema = pagination.extend({
  guildId: uuid.optional(),
  purpose: enumOf(RolePurpose).optional(),
});

// ---------------------------------------------------------------------------
// Manual role grants
// ---------------------------------------------------------------------------

export const issueGrantSchema = z
  .object({
    managedRoleId: uuid,
    userId: uuid.optional(),
    discordUserId: optionalSnowflake,
    expiresAt: optionalIsoDate,
    reason,
  })
  .refine((value) => Boolean(value.userId || value.discordUserId), {
    message: 'Provide the member to grant to',
    path: ['discordUserId'],
  });

export const revokeGrantSchema = z.object({
  grantId: uuid,
  reason,
});

export const listGrantsSchema = pagination.extend({
  userId: uuid.optional(),
  discordUserId: optionalSnowflake,
  managedRoleId: uuid.optional(),
  includeExpired: booleanFlag.default(false),
});

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export const memberLookupSchema = z
  .object({
    discordUserId: optionalSnowflake,
    userId: uuid.optional(),
  })
  .refine((value) => value.discordUserId || value.userId, {
    message: 'Provide a Discord user or a member id',
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

export const listMembersSchema = paginationWithSort(
  ['createdAt', 'displayName', 'permissionLevel'],
  'createdAt',
).extend({
  search: z.string().trim().max(100).optional(),
  websiteAccess: booleanFlag.optional(),
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
  guildId: uuid.optional(),
  mappingId: uuid.optional(),
  syncJobId: uuid.optional(),
  action: z.string().trim().max(64).optional(),
  success: booleanFlag.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
