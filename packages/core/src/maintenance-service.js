/**
 * Scheduled maintenance.
 *
 * Three sweeps, all of which produce a report and audit records rather than quietly
 * changing things:
 *
 *   - **Mapping validation** (daily): every enabled mapping is re-checked against live
 *     Discord. Deleted roles, lost permissions, roles moved above the bot and de-listed
 *     guilds are all found here rather than during a member's sync.
 *   - **Managed role validation** (daily): the same checks for managed roles that no
 *     mapping happens to reference, which would otherwise go unverified until a grant
 *     needed them.
 *   - **Scheduled reconciliation** (every six hours): every member of every approved
 *     guild is reconciled. The maximum-change threshold in the runner is what keeps this
 *     from ever becoming a mass removal.
 *
 * Nothing here auto-corrects a role: broken configuration is reported for a human, and
 * only reconciliation changes Discord.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import { AuditAction, IssueSeverity, SyncIssueType, SyncJobType } from '@frm/shared';
import { recordAudit } from './audit-service.js';
import { systemContext } from './context.js';
import { notifyGlobalAdmins } from './notify.js';
import { createSyncJob } from './sync-service.js';
import { runSyncJob } from './sync-runner.js';
import { expireGrants } from './grant-service.js';

const log = createLogger('core.maintenance');

/**
 * Re-validates every enabled mapping against live Discord.
 *
 * A mapping whose role has been deleted is disabled: leaving it enabled means every
 * future sync for every affected member fails, which buries the real problem under
 * hundreds of identical issues.
 *
 * @param {object} params
 * @param {object} params.gateway
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 */
export async function runMappingValidation({ gateway, prisma = getPrisma() }) {
  const ctx = systemContext({ scheduled: true, label: 'mapping-validation' });

  const mappings = await prisma.roleMapping.findMany({
    where: { ...notDeleted, enabled: true },
    include: { sourceGuild: true, targetGuild: true },
  });

  const report = {
    checked: mappings.length,
    healthy: 0,
    disabled: 0,
    problems: [],
  };

  for (const mapping of mappings) {
    const problems = [];

    for (const side of ['source', 'target']) {
      const guild = side === 'source' ? mapping.sourceGuild : mapping.targetGuild;
      const roleId = side === 'source' ? mapping.sourceRoleId : mapping.targetRoleId;

      if (!guild.enabled || guild.deletedAt) {
        problems.push({
          type: SyncIssueType.GUILD_NOT_APPROVED,
          fatal: true,
          message: `The ${side} guild "${guild.name}" is no longer approved.`,
        });
        continue;
      }
      if (!guild.syncEnabled) {
        problems.push({
          type: SyncIssueType.GUILD_UNAVAILABLE,
          fatal: false,
          message: `Synchronization is disabled for the ${side} guild "${guild.name}".`,
        });
        continue;
      }

      const live = await gateway.getGuild(guild.discordGuildId).catch(() => null);
      if (!live || !live.botPresent) {
        problems.push({
          type: SyncIssueType.BOT_NOT_IN_GUILD,
          fatal: true,
          message: `The bot is no longer in the ${side} guild "${guild.name}".`,
        });
        continue;
      }
      if (!live.botCanManageRoles) {
        problems.push({
          type: SyncIssueType.BOT_MISSING_PERMISSION,
          fatal: false,
          message: `The bot is missing Manage Roles in the ${side} guild "${guild.name}".`,
        });
      }

      const role = await gateway.getRole(guild.discordGuildId, roleId).catch(() => null);
      if (!role) {
        problems.push({
          type: SyncIssueType.ROLE_DELETED,
          fatal: true,
          message: `The ${side} role no longer exists in "${guild.name}".`,
        });
        continue;
      }
      if (role.managed) {
        problems.push({
          type: SyncIssueType.INTEGRATION_MANAGED_ROLE,
          fatal: true,
          message: `The ${side} role "${role.name}" is now owned by another integration.`,
        });
      }
      if (role.position >= live.botHighestRolePosition) {
        problems.push({
          type: SyncIssueType.ROLE_ABOVE_BOT,
          fatal: false,
          message: `The ${side} role "${role.name}" is above the bot's highest role in "${guild.name}".`,
        });
      }
    }

    if (problems.length === 0) {
      report.healthy += 1;
      continue;
    }

    const fatal = problems.some((problem) => problem.fatal);
    report.problems.push({ mappingId: mapping.id, name: mapping.name, problems, disabled: fatal });

    await prisma.$transaction(async (tx) => {
      for (const problem of problems) {
        await tx.syncIssue.create({
          data: {
            type: problem.type,
            severity: problem.fatal ? IssueSeverity.ERROR : IssueSeverity.WARNING,
            mappingId: mapping.id,
            approvedGuildId: mapping.sourceGuildId,
            message: `Mapping "${mapping.name}": ${problem.message}`,
          },
        });
      }

      if (fatal) {
        await tx.roleMapping.update({ where: { id: mapping.id }, data: { enabled: false } });
        await recordAudit(tx, {
          ctx,
          action: AuditAction.MAPPING_DISABLED,
          mappingId: mapping.id,
          approvedGuildId: mapping.sourceGuildId,
          success: false,
          reason: 'Disabled by scheduled mapping validation',
          newState: { problems: problems.map((problem) => problem.message) },
        });
      }
    });

    if (fatal) report.disabled += 1;
  }

  await recordAudit(prisma, {
    ctx,
    action: 'maintenance.mapping_validation',
    newState: {
      checked: report.checked,
      healthy: report.healthy,
      disabled: report.disabled,
      withProblems: report.problems.length,
    },
  });

  if (report.disabled > 0) {
    await notifyGlobalAdmins({
      title: 'Mapping validation disabled broken mappings',
      description:
        `${report.disabled} of ${report.checked} mappings were disabled because their roles or guilds are ` +
        'no longer usable. Check /audit failures for the details.',
      severity: 'critical',
    });
  }

  log.info(report, 'mapping validation finished');
  return report;
}

/**
 * Checks every managed role definition against live Discord.
 *
 * Reported only. A managed role that has been deleted in Discord is a configuration
 * problem for a human to fix; silently dropping the definition would quietly remove the
 * platform's ability to manage a role somebody deliberately put under its control.
 *
 * @param {object} params
 * @param {object} params.gateway
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 */
export async function validateManagedRoles({ gateway, prisma = getPrisma() }) {
  const ctx = systemContext({ scheduled: true, label: 'managed-role-validation' });

  const guilds = await prisma.approvedGuild.findMany({
    where: { ...notDeleted, enabled: true, syncEnabled: true },
    select: { id: true, discordGuildId: true, name: true },
  });

  const report = { checked: 0, healthy: 0, problems: [] };

  for (const guild of guilds) {
    const managedRoles = await prisma.managedRole.findMany({
      where: { approvedGuildId: guild.id, ...notDeleted, managedByPlatform: true },
      select: { id: true, discordRoleId: true, name: true },
    });
    if (managedRoles.length === 0) continue;

    const live = await gateway.getGuild(guild.discordGuildId).catch(() => null);
    const roles = live ? await gateway.listRoles(guild.discordGuildId).catch(() => []) : [];
    const byId = new Map(roles.map((role) => [role.id, role]));

    for (const managed of managedRoles) {
      report.checked += 1;
      const problem = describeRoleProblem(managed, byId.get(managed.discordRoleId), live);

      if (!problem) {
        report.healthy += 1;
        continue;
      }

      report.problems.push({ managedRoleId: managed.id, guild: guild.name, ...problem });
      await prisma.syncIssue
        .create({
          data: {
            type: problem.type,
            severity: IssueSeverity.ERROR,
            approvedGuildId: guild.id,
            discordGuildId: guild.discordGuildId,
            discordRoleId: managed.discordRoleId,
            message: `Managed role "${managed.name}" in ${guild.name}: ${problem.message}`,
          },
        })
        .catch(() => {});
    }
  }

  await recordAudit(prisma, {
    ctx,
    action: 'maintenance.managed_role_validation',
    newState: {
      checked: report.checked,
      healthy: report.healthy,
      problems: report.problems.length,
    },
  });

  log.info(
    { checked: report.checked, healthy: report.healthy, problems: report.problems.length },
    'managed role validation finished',
  );
  return report;
}

function describeRoleProblem(managed, liveRole, liveGuild) {
  if (!liveGuild || !liveGuild.botPresent) {
    return { type: SyncIssueType.BOT_NOT_IN_GUILD, message: 'the bot is not in that guild.' };
  }
  if (!liveRole) {
    return { type: SyncIssueType.ROLE_DELETED, message: 'the role no longer exists in Discord.' };
  }
  if (liveRole.managed) {
    return {
      type: SyncIssueType.INTEGRATION_MANAGED_ROLE,
      message: 'the role is now owned by another integration and cannot be applied.',
    };
  }
  if (liveRole.position >= liveGuild.botHighestRolePosition) {
    return {
      type: SyncIssueType.ROLE_ABOVE_BOT,
      message: "the role is above the bot's highest role and cannot be applied.",
    };
  }
  if (!liveGuild.botCanManageRoles) {
    return {
      type: SyncIssueType.BOT_MISSING_PERMISSION,
      message: 'the bot is missing Manage Roles in that guild.',
    };
  }
  return null;
}

/**
 * The six-hourly reconciliation of every member of every approved guild.
 *
 * It creates a real `SyncJob` (so it is visible in `/resync status` and the audit trail
 * like any other job) and runs it through the same runner, which means it inherits the
 * threshold guard, the locks and the loop protection.
 *
 * Expired grants are swept first so that the reconciliation which follows already sees
 * the correct desired state and takes the roles off in the same pass.
 */
export async function runScheduledReconciliation({ gateway, prisma = getPrisma(), dryRun }) {
  const ctx = systemContext({ scheduled: true, label: 'scheduled-reconciliation' });

  await expireGrants(ctx).catch((error) => {
    log.error({ err: serializeError(error) }, 'grant expiry sweep failed');
  });

  const job = await createSyncJob(prisma, ctx, {
    type: SyncJobType.SCHEDULED_RECONCILIATION,
    dryRun: dryRun ?? false,
    reason: 'Scheduled reconciliation',
    payload: {},
  });

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.SYNC_JOB_CREATED,
    syncJobId: job.id,
    newState: { type: job.type, dryRun: job.dryRun },
  });

  try {
    return await runSyncJob({ jobId: job.id, gateway, prisma });
  } catch (error) {
    log.error({ err: serializeError(error), jobId: job.id }, 'scheduled reconciliation failed');
    throw error;
  }
}
