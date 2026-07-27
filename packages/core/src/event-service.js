/**
 * Discord event handling.
 *
 * The bot's event listeners are thin: they normalise the discord.js payload and call
 * into here, so the decision logic is testable without a gateway connection.
 *
 * The central decision for a role change is a three-way one:
 *
 *   1. **Did we do this?** Claim the loop-protection marker. If a marker exists, this
 *      event is the echo of our own write and must go no further. This is what stops
 *      two-way mappings from ping-ponging forever.
 *   2. **Does it matter?** If the role is neither platform-managed nor part of an
 *      enabled mapping, ignore it. Members' own roles are their own business.
 *   3. **Then reconcile.** Queue a resync for that member. Reconciliation is idempotent
 *      and computes the whole correct state, so a manual change that contradicts roster
 *      data gets corrected on the next pass rather than being propagated.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import {
  ActionSource,
  AuditAction,
  IssueSeverity,
  SyncActionType,
  SyncIssueType,
  SyncJobType,
} from '@frm/shared';
import { claimSyncMarker } from '@frm/queue';
import { recordAudit } from './audit-service.js';
import { systemContext } from './context.js';
import { createSyncJob, enqueueSyncJob } from './sync-service.js';
import { findApprovedGuildBySnowflake } from './resolve.js';
import { notifyGlobalAdmins } from './notify.js';

const log = createLogger('core.events');

/**
 * Handles a member's roles changing in a guild.
 *
 * @param {object} params
 * @param {string} params.discordGuildId
 * @param {string} params.discordUserId
 * @param {string[]} params.addedRoleIds
 * @param {string[]} params.removedRoleIds
 * @param {string|null} [params.executorDiscordId] who made the change, from the audit log
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 * @returns {Promise<{queued: boolean, reason: string, systemChanges?: number}>}
 */
export async function handleMemberRoleChange({
  discordGuildId,
  discordUserId,
  addedRoleIds = [],
  removedRoleIds = [],
  executorDiscordId = null,
  prisma = getPrisma(),
}) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);
  if (!guild || !guild.enabled) {
    return { queued: false, reason: 'guild is not approved' };
  }
  if (!guild.syncEnabled) {
    return { queued: false, reason: 'synchronization is disabled for this guild' };
  }

  // Step 1: consume markers for anything we did ourselves.
  const humanChanges = { added: [], removed: [] };
  let systemChanges = 0;

  for (const roleId of addedRoleIds) {
    const marker = await claimSyncMarker({
      discordGuildId,
      discordUserId,
      discordRoleId: roleId,
      action: SyncActionType.ADD_ROLE,
    }).catch((error) => {
      // If Redis is unavailable we must fail safe. Treating the change as human would
      // risk a propagation loop, so it is ignored and scheduled reconciliation repairs
      // any drift.
      log.error({ err: serializeError(error) }, 'marker lookup failed; ignoring role change');
      return { failedLookup: true };
    });
    if (marker) systemChanges += 1;
    else humanChanges.added.push(roleId);
  }

  for (const roleId of removedRoleIds) {
    const marker = await claimSyncMarker({
      discordGuildId,
      discordUserId,
      discordRoleId: roleId,
      action: SyncActionType.REMOVE_ROLE,
    }).catch((error) => {
      log.error({ err: serializeError(error) }, 'marker lookup failed; ignoring role change');
      return { failedLookup: true };
    });
    if (marker) systemChanges += 1;
    else humanChanges.removed.push(roleId);
  }

  const changedRoleIds = [...humanChanges.added, ...humanChanges.removed];
  if (changedRoleIds.length === 0) {
    return { queued: false, reason: 'all changes were system generated', systemChanges };
  }

  // Step 2: is any changed role relevant to the platform?
  const relevant = await filterRelevantRoles(prisma, guild.id, changedRoleIds);
  if (relevant.length === 0) {
    return { queued: false, reason: 'no managed or mapped roles were affected', systemChanges };
  }

  // Step 3: reconcile the member.
  const identity = await prisma.discordIdentity.findUnique({
    where: { discordUserId },
    select: { userId: true },
  });

  const ctx = systemContext({ label: 'discord-event' });
  const ctxWithActor = {
    ...ctx,
    actor: { ...ctx.actor, discordUserId: executorDiscordId },
    source: ActionSource.DISCORD,
  };

  const job = await prisma.$transaction(async (tx) => {
    const created = await createSyncJob(tx, ctxWithActor, {
      // A linked member gets a full reconciliation (roster + mappings). An unlinked
      // Discord account gets mapping-only propagation, because the engine has no roster
      // data with which to compute the rest of their roles.
      type: identity ? SyncJobType.MEMBER_RESYNC : SyncJobType.MAPPING_PROPAGATION,
      targetUserId: identity?.userId ?? null,
      approvedGuildId: guild.id,
      dryRun: false,
      reason: 'Discord role change detected',
      payload: {
        userId: identity?.userId ?? null,
        discordUserId,
        originGuildId: discordGuildId,
        addedRoleIds: humanChanges.added,
        removedRoleIds: humanChanges.removed,
      },
    });

    await recordAudit(tx, {
      ctx: ctxWithActor,
      action:
        humanChanges.added.length > 0 ? AuditAction.SYNC_ROLE_ADDED : AuditAction.SYNC_ROLE_REMOVED,
      targetUserId: identity?.userId ?? null,
      targetDiscordId: discordUserId,
      approvedGuildId: guild.id,
      syncJobId: created.id,
      reason: 'Manual Discord role change observed',
      newState: {
        added: humanChanges.added,
        removed: humanChanges.removed,
        relevantRoles: relevant,
        executorDiscordId,
      },
    });

    return created;
  });

  await enqueueSyncJob(job, { prisma });

  return { queued: true, reason: 'reconciliation queued', jobId: job.id, systemChanges };
}

/**
 * Which of these roles does the platform care about?
 *
 * A role matters when it is a managed role (roster/manual driven) or when it appears on
 * either side of an enabled mapping.
 */
async function filterRelevantRoles(prisma, approvedGuildId, roleIds) {
  if (roleIds.length === 0) return [];

  const [managed, mappings] = await Promise.all([
    prisma.managedRole.findMany({
      where: { approvedGuildId, discordRoleId: { in: roleIds }, ...notDeleted },
      select: { discordRoleId: true },
    }),
    prisma.roleMapping.findMany({
      where: {
        ...notDeleted,
        enabled: true,
        OR: [
          { sourceGuildId: approvedGuildId, sourceRoleId: { in: roleIds } },
          { targetGuildId: approvedGuildId, targetRoleId: { in: roleIds } },
        ],
      },
      select: { sourceRoleId: true, targetRoleId: true },
    }),
  ]);

  const relevant = new Set(managed.map((row) => row.discordRoleId));
  for (const mapping of mappings) {
    if (roleIds.includes(mapping.sourceRoleId)) relevant.add(mapping.sourceRoleId);
    if (roleIds.includes(mapping.targetRoleId)) relevant.add(mapping.targetRoleId);
  }
  return [...relevant];
}

/**
 * A member joined an approved guild: give them the roles they should already have.
 */
export async function handleMemberJoin({ discordGuildId, discordUserId, prisma = getPrisma() }) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);
  if (!guild || !guild.enabled || !guild.syncEnabled) {
    return { queued: false, reason: 'guild is not approved or synchronization is disabled' };
  }

  const identity = await prisma.discordIdentity.findUnique({
    where: { discordUserId },
    select: { userId: true },
  });
  if (!identity) return { queued: false, reason: 'member is not linked to a platform account' };

  const ctx = systemContext({ label: 'discord-event' });
  const job = await createSyncJob(prisma, ctx, {
    type: SyncJobType.MEMBER_RESYNC,
    targetUserId: identity.userId,
    approvedGuildId: guild.id,
    dryRun: false,
    reason: 'Member joined an approved guild',
    payload: { userId: identity.userId },
  });

  await enqueueSyncJob(job, { prisma });
  return { queued: true, jobId: job.id };
}

/**
 * A member left an approved guild. Nothing is changed in the database: leaving a Discord
 * server is not a resignation from the department, and quietly terminating them would
 * destroy roster data on a misclick.
 */
export async function handleMemberLeave({ discordGuildId, discordUserId, prisma = getPrisma() }) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);
  if (!guild) return { recorded: false };

  const identity = await prisma.discordIdentity.findUnique({
    where: { discordUserId },
    select: { userId: true },
  });
  if (!identity) return { recorded: false };

  const activeMemberships = await prisma.departmentMembership.count({
    where: {
      userId: identity.userId,
      ...notDeleted,
      status: { notIn: ['TERMINATED'] },
      ...(guild.departmentId ? { departmentId: guild.departmentId } : {}),
    },
  });

  if (activeMemberships > 0) {
    await prisma.syncIssue.create({
      data: {
        type: SyncIssueType.MEMBER_NOT_IN_GUILD,
        severity: IssueSeverity.WARNING,
        approvedGuildId: guild.id,
        discordGuildId,
        userId: identity.userId,
        discordUserId,
        message:
          'An active roster member left this Discord server. Their roster record is unchanged; ' +
          'remove them from the roster if they have actually resigned.',
      },
    });
  }

  return { recorded: true, activeMemberships };
}

/**
 * A role was deleted in Discord.
 *
 * Everything referencing it is now broken, so the mappings are disabled (an enabled
 * mapping pointing at a deleted role fails on every single sync) and an issue is raised
 * for each managed role definition that needs updating.
 */
export async function handleRoleDeleted({
  discordGuildId,
  discordRoleId,
  roleName,
  prisma = getPrisma(),
}) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);
  if (!guild) return { affected: 0 };

  const [managedRoles, mappings] = await Promise.all([
    prisma.managedRole.findMany({
      where: { approvedGuildId: guild.id, discordRoleId, ...notDeleted },
    }),
    prisma.roleMapping.findMany({
      where: {
        ...notDeleted,
        OR: [
          { sourceGuildId: guild.id, sourceRoleId: discordRoleId },
          { targetGuildId: guild.id, targetRoleId: discordRoleId },
        ],
      },
    }),
  ]);

  if (managedRoles.length === 0 && mappings.length === 0) return { affected: 0 };

  const ctx = systemContext({ label: 'discord-event' });

  await prisma.$transaction(async (tx) => {
    if (mappings.length > 0) {
      await tx.roleMapping.updateMany({
        where: { id: { in: mappings.map((mapping) => mapping.id) } },
        data: { enabled: false },
      });
    }

    for (const mapping of mappings) {
      await tx.syncIssue.create({
        data: {
          type: SyncIssueType.ROLE_DELETED,
          severity: IssueSeverity.ERROR,
          approvedGuildId: guild.id,
          discordGuildId,
          mappingId: mapping.id,
          discordRoleId,
          message:
            `The role "${roleName ?? discordRoleId}" used by mapping "${mapping.name}" was deleted in Discord. ` +
            'The mapping has been disabled.',
        },
      });
    }

    for (const managed of managedRoles) {
      await tx.syncIssue.create({
        data: {
          type: SyncIssueType.ROLE_DELETED,
          severity: IssueSeverity.ERROR,
          approvedGuildId: guild.id,
          discordGuildId,
          discordRoleId,
          message:
            `The managed role "${managed.name}" was deleted in Discord. Update the role definition ` +
            'or recreate the role, otherwise every synchronization touching it will fail.',
        },
      });
    }

    await recordAudit(tx, {
      ctx,
      action: AuditAction.MAPPING_DISABLED,
      approvedGuildId: guild.id,
      reason: 'Discord role deleted',
      newState: {
        discordRoleId,
        roleName: roleName ?? null,
        disabledMappings: mappings.length,
        brokenManagedRoles: managedRoles.length,
      },
      success: false,
    });
  });

  await notifyGlobalAdmins({
    title: 'A synchronized Discord role was deleted',
    description:
      `Role \`${roleName ?? discordRoleId}\` in **${guild.name}** was deleted. ` +
      `${mappings.length} mapping(s) were disabled and ${managedRoles.length} managed role definition(s) are now broken.`,
    severity: 'critical',
  });

  return { affected: managedRoles.length + mappings.length, disabledMappings: mappings.length };
}

/**
 * A role was renamed or moved. Names are kept in step so audit records and embeds stay
 * readable, and a role that has been moved above the bot is reported before it silently
 * starts failing.
 */
export async function handleRoleUpdated({
  discordGuildId,
  discordRoleId,
  roleName,
  position,
  botHighestPosition,
  managed,
  prisma = getPrisma(),
}) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);
  if (!guild) return { updated: false };

  const managedRole = await prisma.managedRole.findFirst({
    where: { approvedGuildId: guild.id, discordRoleId, ...notDeleted },
  });
  if (!managedRole) return { updated: false };

  if (roleName && roleName !== managedRole.name) {
    await prisma.managedRole.update({ where: { id: managedRole.id }, data: { name: roleName } });
  }

  const problems = [];
  if (
    typeof position === 'number' &&
    typeof botHighestPosition === 'number' &&
    position >= botHighestPosition
  ) {
    problems.push({
      type: SyncIssueType.ROLE_ABOVE_BOT,
      message: `"${roleName ?? managedRole.name}" was moved above the bot's highest role and can no longer be applied.`,
    });
  }
  if (managed) {
    problems.push({
      type: SyncIssueType.INTEGRATION_MANAGED_ROLE,
      message: `"${roleName ?? managedRole.name}" is now managed by another integration and cannot be applied.`,
    });
  }

  for (const problem of problems) {
    await prisma.syncIssue.create({
      data: {
        type: problem.type,
        severity: IssueSeverity.ERROR,
        approvedGuildId: guild.id,
        discordGuildId,
        discordRoleId,
        message: problem.message,
      },
    });
  }

  return { updated: true, problems: problems.length };
}
