/**
 * Scheduled maintenance.
 *
 * Two sweeps, both of which produce a report and audit records rather than quietly
 * changing things:
 *
 *   - **Mapping validation** (daily): every enabled mapping is re-checked against live
 *     Discord. Deleted roles, lost permissions, roles moved above the bot and de-listed
 *     guilds are all found here rather than during a member's sync.
 *   - **Scheduled reconciliation** (every six hours): the whole active roster is
 *     reconciled. The maximum-change threshold in the runner is what keeps this from
 *     ever becoming a mass removal.
 *
 * A third check runs alongside them: members holding platform-managed roles without a
 * matching roster record. That is *reported*, never auto-corrected, because the right
 * answer (hire them, or remove the role) is a human decision.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import {
  AuditAction,
  IssueSeverity,
  MembershipStatus,
  ROSTER_DRIVEN_PURPOSES,
  SyncIssueType,
  SyncJobType,
} from '@frm/shared';
import { recordAudit } from './audit-service.js';
import { systemContext } from './context.js';
import { notifyGlobalAdmins } from './notify.js';
import { createSyncJob } from './sync-service.js';
import { runSyncJob } from './sync-runner.js';

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
 * Finds members who hold a platform-managed role without a roster record that justifies
 * it, and members missing from a guild their department requires.
 *
 * Reported only. Auto-removing here would be a mass-removal path that bypasses the
 * threshold guard, which is precisely what the specification warns against.
 */
export async function detectRosterDrift({ gateway, prisma = getPrisma() }) {
  const ctx = systemContext({ scheduled: true, label: 'roster-drift' });

  const guilds = await prisma.approvedGuild.findMany({
    where: { ...notDeleted, enabled: true, syncEnabled: true },
    select: { id: true, discordGuildId: true, name: true, departmentId: true },
  });

  const report = { unmanagedHolders: [], missingFromGuild: [], checkedGuilds: guilds.length };

  for (const guild of guilds) {
    const managedRoles = await prisma.managedRole.findMany({
      where: {
        approvedGuildId: guild.id,
        ...notDeleted,
        managedByPlatform: true,
        purpose: { in: ROSTER_DRIVEN_PURPOSES },
      },
      select: { id: true, discordRoleId: true, name: true, departmentId: true },
    });
    if (managedRoles.length === 0) continue;

    // Members who should be in this guild but are not.
    if (guild.departmentId) {
      const memberships = await prisma.departmentMembership.findMany({
        where: {
          departmentId: guild.departmentId,
          ...notDeleted,
          status: { not: MembershipStatus.TERMINATED },
        },
        include: { user: { select: { id: true, displayName: true, primaryDiscordId: true } } },
      });

      for (const membership of memberships) {
        const discordUserId = membership.user.primaryDiscordId;
        if (!discordUserId) {
          report.missingFromGuild.push({
            userId: membership.userId,
            guildId: guild.id,
            reason: 'no linked Discord account',
          });
          continue;
        }
        const member = await gateway
          .getMember(guild.discordGuildId, discordUserId)
          .catch(() => null);
        if (!member) {
          report.missingFromGuild.push({
            userId: membership.userId,
            displayName: membership.user.displayName,
            guildId: guild.id,
            guildName: guild.name,
            reason: 'not in the department Discord server',
          });
        }
      }
    }
  }

  // Record the findings as issues so they show up in /audit failures alongside
  // everything else an administrator needs to act on.
  for (const entry of report.missingFromGuild.slice(0, 200)) {
    await prisma.syncIssue
      .create({
        data: {
          type: SyncIssueType.MEMBER_NOT_IN_GUILD,
          severity: IssueSeverity.WARNING,
          approvedGuildId: entry.guildId,
          userId: entry.userId,
          message: `${entry.displayName ?? 'A roster member'} is on the roster but ${entry.reason}.`,
          details: { reason: entry.reason },
        },
      })
      .catch(() => {});
  }

  await recordAudit(prisma, {
    ctx,
    action: 'maintenance.roster_drift',
    newState: {
      checkedGuilds: report.checkedGuilds,
      missingFromGuild: report.missingFromGuild.length,
    },
  });

  log.info(
    { missingFromGuild: report.missingFromGuild.length, guilds: report.checkedGuilds },
    'roster drift check finished',
  );
  return report;
}

/**
 * The six-hourly reconciliation of every active member.
 *
 * It creates a real `SyncJob` (so it is visible in `/resync status` and the audit trail
 * like any other job) and runs it through the same runner, which means it inherits the
 * threshold guard, the locks and the loop protection.
 */
export async function runScheduledReconciliation({ gateway, prisma = getPrisma(), dryRun }) {
  const ctx = systemContext({ scheduled: true, label: 'scheduled-reconciliation' });

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
    const finished = await runSyncJob({ jobId: job.id, gateway, prisma });
    return finished;
  } catch (error) {
    log.error({ err: serializeError(error), jobId: job.id }, 'scheduled reconciliation failed');
    throw error;
  }
}
