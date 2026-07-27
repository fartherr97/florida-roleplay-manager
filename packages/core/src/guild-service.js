/**
 * The approved guild allowlist.
 *
 * This is the boundary that stops an arbitrary Discord server from attaching itself to
 * the community's role graph. Nothing in the platform works in a guild that is not
 * listed here and enabled: not commands, not mappings, not role writes.
 *
 * Registration is a global-administrator action. Discord's own "Administrator"
 * permission is deliberately not sufficient - the owner of an unrelated server has
 * Administrator in their own guild, and that must not be a path into this platform.
 */
import { getPrisma, notDeleted, toPage, toSkipTake } from '@frm/database';
import { createLogger } from '@frm/logging';
import { ActionSource, AuditAction, ConflictError, PreconditionError, getEnv } from '@frm/shared';
import { authorize, guildScopeFilter } from '@frm/authorization';
import {
  listGuildsSchema,
  parseOrThrow,
  registerGuildSchema,
  removeGuildSchema,
  updateGuildSettingsSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { notifyGlobalAdmins } from './notify.js';
import {
  findApprovedGuildBySnowflake,
  resolveApprovedGuild,
  resolveDepartment,
} from './resolve.js';

const log = createLogger('core.guild');

/** Fields safe to include in an audit state snapshot. */
function guildState(guild) {
  if (!guild) return null;
  return {
    id: guild.id,
    discordGuildId: guild.discordGuildId,
    name: guild.name,
    type: guild.type,
    departmentId: guild.departmentId,
    enabled: guild.enabled,
    syncEnabled: guild.syncEnabled,
    features: guild.features,
  };
}

/** `/guild list` and `GET /api/guilds`. */
export async function listGuilds(ctx, input = {}) {
  const query = parseOrThrow(listGuildsSchema, input);
  authorize(ctx.actor, { capability: 'guild.view', scope: {} });

  const prisma = ctx.prisma ?? getPrisma();
  const allowedGuilds = guildScopeFilter(ctx.actor, 'guild.view');

  /** @type {object} */
  const where = { ...notDeleted };
  if (query.type) where.type = query.type;
  if (typeof query.enabled === 'boolean') where.enabled = query.enabled;
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { discordGuildId: { contains: query.search } },
    ];
  }
  if (allowedGuilds !== null) {
    where.id = { in: allowedGuilds };
  }

  const [items, total] = await Promise.all([
    prisma.approvedGuild.findMany({
      where,
      orderBy: { [query.sortBy]: query.sortDir },
      ...toSkipTake(query),
      include: {
        department: { select: { id: true, key: true, name: true } },
        _count: { select: { managedRoles: true, sourceMappings: true, targetMappings: true } },
      },
    }),
    prisma.approvedGuild.count({ where }),
  ]);

  return toPage(items, total, query);
}

/**
 * Adds a guild to the allowlist.
 *
 * When a Discord gateway is supplied (the bot process has one) the bot's presence and
 * permissions are verified live. The API process has no Discord connection, so a guild
 * registered from the website is created with synchronization switched off until it is
 * verified from Discord - registering must never be a way to silently attach an
 * unverified server to the role graph.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {{gateway?: object}} [options]
 */
export async function registerGuild(ctx, input, { gateway } = {}) {
  const data = parseOrThrow(registerGuildSchema, input);
  authorize(ctx.actor, { capability: 'guild.register', scope: {} });

  const prisma = ctx.prisma ?? getPrisma();
  const warnings = [];

  let liveGuild = null;
  if (gateway) {
    liveGuild = await gateway.getGuild(data.discordGuildId);
    if (!liveGuild || !liveGuild.botPresent) {
      throw new PreconditionError(
        'The bot is not in that Discord server. Invite it first, then register the guild.',
      );
    }
    if (!liveGuild.botCanManageRoles) {
      warnings.push(
        'The bot does not currently have Manage Roles in that server, so synchronization will fail until it does.',
      );
    }
  } else {
    warnings.push(
      'Registered without a live Discord check. Synchronization stays disabled until the guild is verified with /guild status.',
    );
  }

  if (data.departmentId) {
    await resolveDepartment(ctx, data.departmentId);
    const taken = await prisma.approvedGuild.findFirst({
      where: { departmentId: data.departmentId, ...notDeleted },
    });
    if (taken && taken.discordGuildId !== data.discordGuildId) {
      throw new ConflictError(`That department is already linked to ${taken.name}.`);
    }
  }

  const existing = await prisma.approvedGuild.findUnique({
    where: { discordGuildId: data.discordGuildId },
  });
  if (existing && !existing.deletedAt && existing.enabled) {
    throw new ConflictError(`${existing.name} is already approved.`);
  }

  const syncEnabled = gateway ? data.syncEnabled : false;

  const guild = await prisma.$transaction(async (tx) => {
    // A previously removed guild is restored rather than duplicated, which keeps its
    // managed roles, its history and its audit trail attached.
    const row = existing
      ? await tx.approvedGuild.update({
          where: { id: existing.id },
          data: {
            name: liveGuild?.name ?? data.name,
            type: data.type,
            departmentId: data.departmentId ?? null,
            enabled: true,
            syncEnabled,
            features: data.features,
            deletedAt: null,
            removedAt: null,
            removedById: null,
            registeredById: ctx.actor?.user?.id ?? null,
            registeredAt: new Date(),
          },
        })
      : await tx.approvedGuild.create({
          data: {
            discordGuildId: data.discordGuildId,
            name: liveGuild?.name ?? data.name,
            type: data.type,
            departmentId: data.departmentId ?? null,
            enabled: true,
            syncEnabled,
            features: data.features,
            registeredById: ctx.actor?.user?.id ?? null,
          },
        });

    await recordAudit(tx, {
      ctx,
      action: AuditAction.GUILD_REGISTERED,
      approvedGuildId: row.id,
      departmentId: row.departmentId,
      reason: data.reason,
      previousState: guildState(existing),
      newState: guildState(row),
    });

    return row;
  });

  log.info(
    { discordGuildId: guild.discordGuildId, actor: ctx.actor?.user?.id },
    'guild registered',
  );

  return { guild, warnings };
}

/**
 * Removes a guild from the allowlist.
 *
 * Soft delete, and every mapping touching the guild is disabled in the same
 * transaction: leaving enabled mappings pointing at a de-listed guild would let it keep
 * influencing the role graph.
 */
export async function removeGuild(ctx, input) {
  const data = parseOrThrow(removeGuildSchema, input);
  authorize(ctx.actor, { capability: 'guild.remove', scope: {} });

  const prisma = ctx.prisma ?? getPrisma();
  const guild = await resolveApprovedGuild(ctx, data.guildId);

  const result = await prisma.$transaction(async (tx) => {
    const disabled = await tx.roleMapping.updateMany({
      where: {
        ...notDeleted,
        enabled: true,
        OR: [{ sourceGuildId: guild.id }, { targetGuildId: guild.id }],
      },
      data: { enabled: false },
    });

    const row = await tx.approvedGuild.update({
      where: { id: guild.id },
      data: {
        enabled: false,
        syncEnabled: false,
        deletedAt: new Date(),
        removedAt: new Date(),
        removedById: ctx.actor?.user?.id ?? null,
      },
    });

    await recordAudit(tx, {
      ctx,
      action: AuditAction.GUILD_REMOVED,
      approvedGuildId: guild.id,
      departmentId: guild.departmentId,
      reason: data.reason,
      previousState: guildState(guild),
      newState: { ...guildState(row), disabledMappings: disabled.count },
    });

    return { guild: row, disabledMappings: disabled.count };
  });

  log.warn({ discordGuildId: guild.discordGuildId }, 'guild removed from allowlist');
  return result;
}

/** `/guild settings`. */
export async function updateGuildSettings(ctx, input) {
  const data = parseOrThrow(updateGuildSettingsSchema, input);
  const prisma = ctx.prisma ?? getPrisma();
  const guild = await resolveApprovedGuild(ctx, data.guildId);

  authorize(ctx.actor, {
    capability: 'guild.settings',
    scope: { guildId: guild.id, departmentId: guild.departmentId ?? undefined },
  });

  if (data.departmentId) {
    await resolveDepartment(ctx, data.departmentId);
    const taken = await prisma.approvedGuild.findFirst({
      where: { departmentId: data.departmentId, id: { not: guild.id }, ...notDeleted },
    });
    if (taken) throw new ConflictError(`That department is already linked to ${taken.name}.`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.approvedGuild.update({
      where: { id: guild.id },
      data: {
        name: data.name ?? undefined,
        enabled: typeof data.enabled === 'boolean' ? data.enabled : undefined,
        syncEnabled: typeof data.syncEnabled === 'boolean' ? data.syncEnabled : undefined,
        departmentId: data.departmentId === undefined ? undefined : data.departmentId,
        features: data.features ?? undefined,
      },
    });
    await recordAudit(tx, {
      ctx,
      action: AuditAction.GUILD_SETTINGS_UPDATED,
      approvedGuildId: guild.id,
      departmentId: row.departmentId,
      reason: data.reason,
      previousState: guildState(guild),
      newState: guildState(row),
    });
    return row;
  });

  return updated;
}

/**
 * `/guild status` - live health of one guild: is the bot present, can it manage roles,
 * how many managed roles and mappings are attached, and is anything broken.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {{guildId: string}} input
 * @param {{gateway?: object}} [options]
 */
export async function getGuildStatus(ctx, { guildId }, { gateway } = {}) {
  const prisma = ctx.prisma ?? getPrisma();
  const guild = await resolveApprovedGuild(ctx, guildId);

  authorize(ctx.actor, {
    capability: 'guild.view',
    scope: { guildId: guild.id, departmentId: guild.departmentId ?? undefined },
  });

  const [managedRoles, mappingCount, openIssues] = await Promise.all([
    prisma.managedRole.findMany({
      where: { approvedGuildId: guild.id, ...notDeleted },
      select: { id: true, discordRoleId: true, name: true, purpose: true },
    }),
    prisma.roleMapping.count({
      where: {
        ...notDeleted,
        OR: [{ sourceGuildId: guild.id }, { targetGuildId: guild.id }],
      },
    }),
    prisma.syncIssue.count({ where: { approvedGuildId: guild.id, resolved: false } }),
  ]);

  /** @type {object} */
  const live = { checked: false };
  const problems = [];

  if (gateway) {
    const snapshot = await gateway.getGuild(guild.discordGuildId);
    live.checked = true;
    live.botPresent = Boolean(snapshot?.botPresent);
    live.available = Boolean(snapshot?.available);
    live.botCanManageRoles = Boolean(snapshot?.botCanManageRoles);
    live.botHighestRolePosition = snapshot?.botHighestRolePosition ?? -1;

    if (!snapshot) problems.push('The bot is not in this Discord server.');
    else {
      if (!snapshot.botCanManageRoles)
        problems.push('The bot is missing the Manage Roles permission.');

      // Any managed role above the bot cannot be applied; report it before it fails.
      const roles = await gateway.listRoles(guild.discordGuildId);
      const byId = new Map(roles.map((role) => [role.id, role]));
      for (const managed of managedRoles) {
        const live_ = byId.get(managed.discordRoleId);
        if (!live_) {
          problems.push(`Managed role "${managed.name}" no longer exists in Discord.`);
        } else if (live_.position >= snapshot.botHighestRolePosition) {
          problems.push(`Managed role "${managed.name}" is above the bot's highest role.`);
        } else if (live_.managed) {
          problems.push(`Managed role "${managed.name}" is owned by another integration.`);
        }
      }
    }
  }

  return {
    guild,
    live,
    problems,
    counts: {
      managedRoles: managedRoles.length,
      mappings: mappingCount,
      openIssues,
    },
  };
}

/**
 * Handles the bot being added to a guild that is not on the allowlist.
 *
 * 1. record an audit entry
 * 2. alert the global administrators
 * 3. refuse to process anything for that guild
 * 4. leave, unless development mode says otherwise
 *
 * Production always leaves: `devMode` is forced off when NODE_ENV is production.
 *
 * @param {object} params
 * @param {string} params.discordGuildId
 * @param {string} params.name
 * @param {object} [params.gateway]
 * @param {number} [params.memberCount]
 */
export async function handleUnapprovedGuildJoin({ discordGuildId, name, gateway, memberCount }) {
  const env = getEnv();
  const prisma = getPrisma();

  const ctx = {
    actor: { user: { id: null }, discordUserId: null, isSystem: true },
    source: ActionSource.SYSTEM,
    requestId: null,
    ipAddress: null,
    userAgent: null,
  };

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.GUILD_UNAPPROVED_JOIN,
    reason: 'Bot was added to a guild that is not on the approved allowlist',
    newState: { discordGuildId, name, memberCount: memberCount ?? null },
    success: false,
  });

  await notifyGlobalAdmins({
    title: 'Bot added to an unapproved Discord server',
    description:
      `The bot was added to **${name}** (\`${discordGuildId}\`), which is not on the approved ` +
      'allowlist. All commands and synchronization are refused there.',
    severity: 'critical',
    fields: [
      { name: 'Guild ID', value: discordGuildId },
      { name: 'Members', value: String(memberCount ?? 'unknown') },
      {
        name: 'Action',
        value: env.devMode ? 'Staying (development mode)' : 'Leaving automatically',
      },
    ],
  });

  if (env.devMode) {
    log.warn({ discordGuildId, name }, 'unapproved guild join - staying because DEV_MODE is on');
    return { left: false, reason: 'development mode' };
  }

  if (gateway) {
    await gateway.leaveGuild(discordGuildId).catch((error) => {
      log.error({ discordGuildId, err: error?.message }, 'failed to leave unapproved guild');
    });
    await recordAudit(prisma, {
      ctx,
      action: AuditAction.GUILD_AUTO_LEFT,
      reason: 'Automatically left an unapproved guild',
      newState: { discordGuildId, name },
    });
    log.warn({ discordGuildId, name }, 'left unapproved guild');
    return { left: true };
  }

  return { left: false, reason: 'no gateway available' };
}

/**
 * Handles the bot being removed from a guild. The allowlist entry is kept (so its
 * history and managed roles survive a re-invite) but synchronization is switched off.
 */
export async function handleGuildRemoved({ discordGuildId, name }) {
  const prisma = getPrisma();
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);

  const ctx = {
    actor: { user: { id: null }, discordUserId: null, isSystem: true },
    source: ActionSource.SYSTEM,
  };

  if (!guild) {
    await recordAudit(prisma, {
      ctx,
      action: AuditAction.GUILD_DELETED_EXTERNALLY,
      newState: { discordGuildId, name, approved: false },
    });
    return { updated: false };
  }

  await prisma.$transaction(async (tx) => {
    await tx.approvedGuild.update({
      where: { id: guild.id },
      data: { syncEnabled: false },
    });
    await recordAudit(tx, {
      ctx,
      action: AuditAction.GUILD_DELETED_EXTERNALLY,
      approvedGuildId: guild.id,
      reason: 'Bot was removed from the guild; synchronization disabled',
      previousState: guildState(guild),
      newState: { ...guildState(guild), syncEnabled: false },
    });
  });

  await notifyGlobalAdmins({
    title: 'Bot removed from an approved guild',
    description:
      `The bot is no longer in **${guild.name}** (\`${discordGuildId}\`). Synchronization for ` +
      'that guild has been disabled until the bot is re-invited.',
    severity: 'critical',
  });

  return { updated: true };
}

/**
 * Whether a guild may be used right now. Used by the bot's command gate.
 * @param {string} discordGuildId
 */
export async function isGuildApproved(discordGuildId) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId);
  return Boolean(guild && guild.enabled);
}
