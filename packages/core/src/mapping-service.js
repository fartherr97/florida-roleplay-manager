/**
 * Cross-guild role mappings.
 *
 * A mapping is only ever activated after it has been proven safe:
 *
 *   1. both guilds are on the approved allowlist and enabled
 *   2. the actor is authorized for *both* sides, not just the one they are sitting in
 *   3. both roles exist, are not @everyone, and are not owned by another integration
 *   4. the bot can actually manage both roles (Manage Roles, and hierarchy position)
 *   5. protected roles require elevated authorization, and the most sensitive ones
 *      require a second approver
 *   6. the mapping does not close a synchronization loop
 *
 * Enabling always requires a live Discord gateway. A mapping created from the website
 * (where the API has no Discord connection) is stored disabled until it has been
 * validated from the bot, because "enabled but never verified" is exactly the state
 * that produces silent, confusing failures later.
 */
import { getPrisma, notDeleted, toPage, toSkipTake } from '@frm/database';
import { createLogger } from '@frm/logging';
import {
  AuditAction,
  ConflictError,
  MappingCycleError,
  NotFoundError,
  PendingApprovalStatus,
  PendingApprovalType,
  PreconditionError,
  ProtectedRoleError,
  ProtectionLevel,
  APPROVAL_TTL_MS,
} from '@frm/shared';
import { authorize, evaluate } from '@frm/authorization';
import { assertRoleMappable } from '@frm/discord';
import {
  createMappingSchema,
  listMappingsSchema,
  mappingIdSchema,
  parseOrThrow,
  setMappingEnabledSchema,
  updateMappingSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { detectMappingCycle, mappingsTargeting } from './cycle-detection.js';
import { authorizeAnyScope, requireApprovedGuild } from './resolve.js';

const log = createLogger('core.mapping');

function mappingState(mapping) {
  if (!mapping) return null;
  return {
    id: mapping.id,
    name: mapping.name,
    sourceGuildId: mapping.sourceGuildId,
    sourceRoleId: mapping.sourceRoleId,
    targetGuildId: mapping.targetGuildId,
    targetRoleId: mapping.targetRoleId,
    direction: mapping.direction,
    authority: mapping.authority,
    syncAdd: mapping.syncAdd,
    syncRemove: mapping.syncRemove,
    enabled: mapping.enabled,
    priority: mapping.priority,
    requiresApproval: mapping.requiresApproval,
  };
}

/** `/mapping list`. */
export async function listMappings(ctx, input = {}) {
  const query = parseOrThrow(listMappingsSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  authorizeAnyScope(ctx, 'mapping.view');

  /** @type {object} */
  const where = { ...notDeleted };
  if (typeof query.enabled === 'boolean') where.enabled = query.enabled;
  if (query.direction) where.direction = query.direction;
  if (query.search) where.name = { contains: query.search, mode: 'insensitive' };

  if (query.guildId) {
    const guild = await prisma.approvedGuild.findFirst({
      where: { discordGuildId: query.guildId, ...notDeleted },
      select: { id: true },
    });
    if (!guild) return toPage([], 0, query);
    where.OR = [{ sourceGuildId: guild.id }, { targetGuildId: guild.id }];
  }
  if (query.roleId) {
    where.AND = [
      ...(where.AND ?? []),
      { OR: [{ sourceRoleId: query.roleId }, { targetRoleId: query.roleId }] },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.roleMapping.findMany({
      where,
      orderBy: { [query.sortBy]: query.sortDir },
      ...toSkipTake(query),
      include: {
        sourceGuild: { select: { id: true, name: true, discordGuildId: true } },
        targetGuild: { select: { id: true, name: true, discordGuildId: true } },
      },
    }),
    prisma.roleMapping.count({ where }),
  ]);

  return toPage(items, total, query);
}

/** `/mapping view`. */
export async function getMapping(ctx, mappingId) {
  const prisma = ctx.prisma ?? getPrisma();
  const mapping = await prisma.roleMapping.findFirst({
    where: { id: mappingId, ...notDeleted },
    include: {
      sourceGuild: true,
      targetGuild: true,
      createdBy: { select: { id: true, displayName: true } },
      _count: { select: { syncActions: true, syncIssues: true } },
    },
  });
  if (!mapping) throw new NotFoundError('Mapping', mappingId);

  authorize(ctx.actor, {
    capability: 'mapping.view',
    scope: { guildId: mapping.sourceGuildId },
  });

  return mapping;
}

/**
 * Authorizes an action against both ends of a mapping.
 *
 * Holding `mapping.create` for the HCSO guild must not let somebody wire an HCSO role
 * into the Highway Patrol guild: both sides are checked, and a global grant satisfies
 * both at once.
 */
function authorizeBothSides(ctx, capability, sourceGuild, targetGuild) {
  authorize(ctx.actor, { capability, scope: { guildId: sourceGuild.id } });
  authorize(ctx.actor, { capability, scope: { guildId: targetGuild.id } });
}

/**
 * Looks up the platform's protection policy for a role.
 * @returns {Promise<{protectionLevel: string, managedRole: object|null}>}
 */
async function protectionFor(prisma, approvedGuildId, discordRoleId) {
  const managedRole = await prisma.managedRole.findFirst({
    where: { approvedGuildId, discordRoleId, ...notDeleted },
  });
  return {
    protectionLevel: managedRole?.protectionLevel ?? ProtectionLevel.NONE,
    managedRole: managedRole ?? null,
  };
}

/**
 * Runs every safety check for a mapping. Shared by create, enable and test so the three
 * paths can never drift apart.
 *
 * @returns {Promise<{problems: string[], requiresApproval: boolean, roles: object}>}
 */
async function validateMapping(ctx, mapping, { gateway, allowProtected }) {
  const prisma = ctx.prisma ?? getPrisma();
  const problems = [];

  // 1. Both guilds must be approved, enabled and synchronizing.
  const sourceGuild = await requireApprovedGuild(mapping.sourceGuild.discordGuildId, { prisma });
  const targetGuild = await requireApprovedGuild(mapping.targetGuild.discordGuildId, { prisma });

  // 2. Protection policy.
  const sourceProtection = await protectionFor(prisma, sourceGuild.id, mapping.sourceRoleId);
  const targetProtection = await protectionFor(prisma, targetGuild.id, mapping.targetRoleId);

  const requiresApproval =
    sourceProtection.protectionLevel === ProtectionLevel.TWO_PERSON ||
    targetProtection.protectionLevel === ProtectionLevel.TWO_PERSON;

  for (const [side, protection] of [
    ['source', sourceProtection],
    ['target', targetProtection],
  ]) {
    if (protection.protectionLevel === ProtectionLevel.ELEVATED && !allowProtected) {
      throw new ProtectedRoleError(
        `The ${side} role "${protection.managedRole?.name ?? mapping[`${side}RoleId`]}" is protected. ` +
          'Mapping it requires the mapping.approve capability.',
        { side },
      );
    }
  }

  // 3. Live Discord checks. Without a gateway the mapping cannot be activated.
  let roles = null;
  if (gateway) {
    const sourceRole = await assertRoleMappable(gateway, {
      discordGuildId: sourceGuild.discordGuildId,
      discordRoleId: mapping.sourceRoleId,
      side: 'source',
      protectionLevel: sourceProtection.protectionLevel,
      allowProtected,
    });
    const targetRole = await assertRoleMappable(gateway, {
      discordGuildId: targetGuild.discordGuildId,
      discordRoleId: mapping.targetRoleId,
      side: 'target',
      protectionLevel: targetProtection.protectionLevel,
      allowProtected,
    });
    roles = { source: sourceRole, target: targetRole };
  } else {
    problems.push(
      'No live Discord check was possible from this context, so the mapping stays disabled until it is validated.',
    );
  }

  // 4. Cycle detection against every other enabled mapping.
  const others = await prisma.roleMapping.findMany({
    where: {
      ...notDeleted,
      enabled: true,
      id: { not: mapping.id ?? '00000000-0000-0000-0000-000000000000' },
    },
    select: {
      id: true,
      name: true,
      sourceGuildId: true,
      sourceRoleId: true,
      targetGuildId: true,
      targetRoleId: true,
      direction: true,
    },
  });

  const nameFor = await buildNodeNamer(prisma, [
    ...others,
    { ...mapping, sourceGuildId: sourceGuild.id, targetGuildId: targetGuild.id },
  ]);

  const result = detectMappingCycle(
    others,
    {
      id: mapping.id ?? 'candidate',
      name: mapping.name,
      sourceGuildId: sourceGuild.id,
      sourceRoleId: mapping.sourceRoleId,
      targetGuildId: targetGuild.id,
      targetRoleId: mapping.targetRoleId,
      direction: mapping.direction,
    },
    nameFor,
  );

  if (result.cycle) {
    throw new MappingCycleError(result.chain);
  }

  // 5. Warn about another mapping already governing the same target role.
  const competing = mappingsTargeting(others, targetGuild.id, mapping.targetRoleId);
  for (const other of competing) {
    problems.push(
      `Mapping "${other.name}" already controls the target role. Give the two mappings different priorities to make the outcome predictable.`,
    );
  }

  return { problems, requiresApproval, roles, sourceGuild, targetGuild };
}

/** Builds a `node -> "Guild / Role"` renderer for readable cycle messages. */
async function buildNodeNamer(prisma, mappings) {
  const guildIds = new Set();
  for (const mapping of mappings) {
    guildIds.add(mapping.sourceGuildId);
    guildIds.add(mapping.targetGuildId);
  }
  const guilds = await prisma.approvedGuild.findMany({
    where: { id: { in: [...guildIds] } },
    select: { id: true, name: true },
  });
  const guildNames = new Map(guilds.map((guild) => [guild.id, guild.name]));

  const roleIds = new Set();
  for (const mapping of mappings) {
    roleIds.add(mapping.sourceRoleId);
    roleIds.add(mapping.targetRoleId);
  }
  const roles = await prisma.managedRole.findMany({
    where: { discordRoleId: { in: [...roleIds] } },
    select: { approvedGuildId: true, discordRoleId: true, name: true },
  });
  const roleNames = new Map(
    roles.map((role) => [`${role.approvedGuildId}:${role.discordRoleId}`, role.name]),
  );

  return (node) => {
    const [guildId, roleId] = node.split(':');
    const guildName = guildNames.get(guildId) ?? guildId;
    const roleName = roleNames.get(node) ?? roleId;
    return `${guildName} / ${roleName}`;
  };
}

/** `/mapping create`. */
export async function createMapping(ctx, input, { gateway } = {}) {
  const data = parseOrThrow(createMappingSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const sourceGuild = await requireApprovedGuild(data.sourceGuildId, { prisma });
  const targetGuild = await requireApprovedGuild(data.targetGuildId, { prisma });

  authorizeBothSides(ctx, 'mapping.create', sourceGuild, targetGuild);

  const allowProtected = evaluate(ctx.actor, { capability: 'mapping.approve', scope: {} }).allowed;

  const existing = await prisma.roleMapping.findUnique({
    where: {
      sourceGuildId_sourceRoleId_targetGuildId_targetRoleId: {
        sourceGuildId: sourceGuild.id,
        sourceRoleId: data.sourceRoleId,
        targetGuildId: targetGuild.id,
        targetRoleId: data.targetRoleId,
      },
    },
  });
  if (existing && !existing.deletedAt) {
    throw new ConflictError(`That mapping already exists ("${existing.name}").`);
  }

  const candidate = {
    id: existing?.id,
    name: data.name,
    sourceGuild,
    targetGuild,
    sourceRoleId: data.sourceRoleId,
    targetRoleId: data.targetRoleId,
    direction: data.direction,
  };

  const validation = await validateMapping(ctx, candidate, { gateway, allowProtected });

  // Enabling requires a live check and, for the most sensitive roles, a second approver.
  const enabled = data.enabled && Boolean(gateway) && !validation.requiresApproval;

  const mapping = await prisma.$transaction(async (tx) => {
    const row = existing
      ? await tx.roleMapping.update({
          where: { id: existing.id },
          data: {
            name: data.name,
            direction: data.direction,
            authority: data.authority,
            syncAdd: data.syncAdd,
            syncRemove: data.syncRemove,
            priority: data.priority,
            enabled,
            requiresApproval: validation.requiresApproval,
            approvedAt: null,
            deletedAt: null,
            createdById: ctx.actor?.user?.id ?? null,
          },
        })
      : await tx.roleMapping.create({
          data: {
            name: data.name,
            sourceGuildId: sourceGuild.id,
            sourceRoleId: data.sourceRoleId,
            targetGuildId: targetGuild.id,
            targetRoleId: data.targetRoleId,
            direction: data.direction,
            authority: data.authority,
            syncAdd: data.syncAdd,
            syncRemove: data.syncRemove,
            priority: data.priority,
            enabled,
            requiresApproval: validation.requiresApproval,
            createdById: ctx.actor?.user?.id ?? null,
          },
        });

    if (validation.requiresApproval) {
      await tx.pendingApproval.create({
        data: {
          type: PendingApprovalType.PROTECTED_ROLE_MAPPING,
          status: PendingApprovalStatus.PENDING,
          payload: { mappingId: row.id, name: row.name },
          requiredCapability: 'mapping.approve',
          requiredApprovals: 1,
          mappingId: row.id,
          requestedById: ctx.actor?.user?.id ?? null,
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
        },
      });
    }

    await recordAudit(tx, {
      ctx,
      action: AuditAction.MAPPING_CREATED,
      mappingId: row.id,
      approvedGuildId: sourceGuild.id,
      reason: data.reason,
      previousState: mappingState(existing),
      newState: mappingState(row),
    });

    return row;
  });

  const warnings = [...validation.problems];
  if (data.enabled && !enabled) {
    warnings.push(
      validation.requiresApproval
        ? 'This mapping touches a protected role, so it stays disabled until a second authorized approver signs off.'
        : 'The mapping was created disabled because it could not be validated against Discord from here.',
    );
  }

  log.info({ mappingId: mapping.id, enabled: mapping.enabled }, 'mapping created');
  return { mapping, warnings, requiresApproval: validation.requiresApproval };
}

/** `/mapping edit`. Changing direction or authority re-runs cycle detection. */
export async function updateMapping(ctx, input, { gateway } = {}) {
  const data = parseOrThrow(updateMappingSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const mapping = await prisma.roleMapping.findFirst({
    where: { id: data.mappingId, ...notDeleted },
    include: { sourceGuild: true, targetGuild: true },
  });
  if (!mapping) throw new NotFoundError('Mapping', data.mappingId);

  authorizeBothSides(ctx, 'mapping.update', mapping.sourceGuild, mapping.targetGuild);

  const nextDirection = data.direction ?? mapping.direction;
  if (mapping.enabled && nextDirection !== mapping.direction) {
    const allowProtected = evaluate(ctx.actor, {
      capability: 'mapping.approve',
      scope: {},
    }).allowed;
    await validateMapping(
      ctx,
      { ...mapping, direction: nextDirection },
      { gateway, allowProtected },
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.roleMapping.update({
      where: { id: mapping.id },
      data: {
        name: data.name ?? undefined,
        direction: data.direction ?? undefined,
        authority: data.authority ?? undefined,
        syncAdd: typeof data.syncAdd === 'boolean' ? data.syncAdd : undefined,
        syncRemove: typeof data.syncRemove === 'boolean' ? data.syncRemove : undefined,
        priority: typeof data.priority === 'number' ? data.priority : undefined,
      },
    });
    await recordAudit(tx, {
      ctx,
      action: AuditAction.MAPPING_UPDATED,
      mappingId: row.id,
      approvedGuildId: mapping.sourceGuildId,
      reason: data.reason,
      previousState: mappingState(mapping),
      newState: mappingState(row),
    });
    return row;
  });

  return updated;
}

/**
 * `/mapping enable` and `/mapping disable`.
 *
 * Enabling always re-validates: guilds can be de-listed, roles deleted and hierarchies
 * changed since the mapping was created.
 */
export async function setMappingEnabled(ctx, input, { gateway } = {}) {
  const data = parseOrThrow(setMappingEnabledSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const mapping = await prisma.roleMapping.findFirst({
    where: { id: data.mappingId, ...notDeleted },
    include: { sourceGuild: true, targetGuild: true },
  });
  if (!mapping) throw new NotFoundError('Mapping', data.mappingId);

  authorizeBothSides(ctx, 'mapping.update', mapping.sourceGuild, mapping.targetGuild);

  if (data.enabled) {
    if (!gateway) {
      throw new PreconditionError(
        'A mapping can only be enabled from a context with a live Discord connection, so its roles can be verified first.',
      );
    }
    const allowProtected = evaluate(ctx.actor, {
      capability: 'mapping.approve',
      scope: {},
    }).allowed;
    const validation = await validateMapping(ctx, mapping, { gateway, allowProtected });

    if (validation.requiresApproval && !mapping.approvedAt) {
      throw new PreconditionError(
        'This mapping involves a protected role and needs a second authorized approver before it can be enabled.',
      );
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.roleMapping.update({
      where: { id: mapping.id },
      data: { enabled: data.enabled },
    });
    await recordAudit(tx, {
      ctx,
      action: data.enabled ? AuditAction.MAPPING_ENABLED : AuditAction.MAPPING_DISABLED,
      mappingId: row.id,
      approvedGuildId: mapping.sourceGuildId,
      reason: data.reason,
      previousState: mappingState(mapping),
      newState: mappingState(row),
    });
    return row;
  });

  return updated;
}

/** `/mapping remove`. Soft delete so historical sync actions keep their reference. */
export async function deleteMapping(ctx, input) {
  const data = parseOrThrow(mappingIdSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const mapping = await prisma.roleMapping.findFirst({
    where: { id: data.mappingId, ...notDeleted },
    include: { sourceGuild: true, targetGuild: true },
  });
  if (!mapping) throw new NotFoundError('Mapping', data.mappingId);

  authorizeBothSides(ctx, 'mapping.delete', mapping.sourceGuild, mapping.targetGuild);

  return prisma.$transaction(async (tx) => {
    const row = await tx.roleMapping.update({
      where: { id: mapping.id },
      data: { enabled: false, deletedAt: new Date() },
    });
    await recordAudit(tx, {
      ctx,
      action: AuditAction.MAPPING_DELETED,
      mappingId: row.id,
      approvedGuildId: mapping.sourceGuildId,
      reason: data.reason,
      previousState: mappingState(mapping),
      newState: mappingState(row),
    });
    return row;
  });
}

/**
 * `/mapping test` - runs every validation without changing anything.
 *
 * @returns {Promise<{ok: boolean, problems: string[], roles: object|null}>}
 */
export async function testMapping(ctx, input, { gateway } = {}) {
  const data = parseOrThrow(mappingIdSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const mapping = await prisma.roleMapping.findFirst({
    where: { id: data.mappingId, ...notDeleted },
    include: { sourceGuild: true, targetGuild: true },
  });
  if (!mapping) throw new NotFoundError('Mapping', data.mappingId);

  authorize(ctx.actor, {
    capability: 'mapping.test',
    scope: { guildId: mapping.sourceGuildId },
  });

  const allowProtected = evaluate(ctx.actor, { capability: 'mapping.approve', scope: {} }).allowed;

  try {
    const validation = await validateMapping(ctx, mapping, { gateway, allowProtected });
    await recordAudit(prisma, {
      ctx,
      action: AuditAction.MAPPING_TESTED,
      mappingId: mapping.id,
      approvedGuildId: mapping.sourceGuildId,
      newState: { problems: validation.problems.length },
    });
    return {
      ok: validation.problems.length === 0,
      problems: validation.problems,
      roles: validation.roles,
      requiresApproval: validation.requiresApproval,
    };
  } catch (error) {
    await recordAudit(prisma, {
      ctx,
      action: AuditAction.MAPPING_TESTED,
      mappingId: mapping.id,
      approvedGuildId: mapping.sourceGuildId,
      success: false,
      errorCode: error.code,
      errorMessage: error.message,
    });
    return {
      ok: false,
      problems: [error.userMessage ?? error.message],
      roles: null,
      error,
    };
  }
}
