/**
 * Sync job execution.
 *
 * This is the only place in the platform that writes roles to Discord. Everything it
 * does is built around four rules:
 *
 *   1. **Plan before you touch anything.** The plan is produced by the reconciliation
 *      engine and is identical for a dry run and a real run.
 *   2. **Refuse to do something enormous by accident.** If a job wants to remove more
 *      roles than the configured threshold it pauses and raises an issue instead.
 *   3. **Mark before you write.** The loop-protection marker is written *before* the
 *      Discord call, because the resulting event can arrive before the call returns.
 *   4. **Never swallow a failure.** Every failed action becomes a `SyncIssue` with a
 *      typed reason, and permanent failures are not retried.
 */
import { currentlyEffective, getPrisma, notDeleted } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import {
  ActionSource,
  AuditAction,
  IssueSeverity,
  SyncActionStatus,
  SyncActionType,
  SyncIssueType,
  SyncJobStatus,
  SyncJobType,
  TERMINAL_JOB_STATUSES,
  getEnv,
} from '@frm/shared';
import { checkRoleOperation } from '@frm/discord';
import { discardSyncMarker, withMemberLock, writeSyncMarker } from '@frm/queue';
import { loadMemberGrants, loadPlatformContext, planForDiscordUser } from '@frm/reconciliation';
import { recordAudit } from './audit-service.js';
import { notifyGlobalAdmins } from './notify.js';
import { systemContext } from './context.js';

const log = createLogger('core.sync-runner');

/**
 * Runs one sync job to completion.
 *
 * @param {object} params
 * @param {string} params.jobId
 * @param {object} params.gateway
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 * @param {(progress: {completed: number, total: number}) => Promise<void>|void} [params.onProgress]
 * @returns {Promise<object>} the finished SyncJob row
 */
export async function runSyncJob({ jobId, gateway, prisma = getPrisma(), onProgress }) {
  const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Sync job ${jobId} not found`);

  if (TERMINAL_JOB_STATUSES.includes(job.status) || job.status === SyncJobStatus.PAUSED) {
    log.info({ jobId, status: job.status }, 'sync job already finished; skipping');
    return job;
  }

  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      status: SyncJobStatus.RUNNING,
      startedAt: job.startedAt ?? new Date(),
      attempts: { increment: 1 },
    },
  });

  try {
    const targets = await resolveTargets(job, prisma, gateway);
    const platform = await loadPlatformContext(prisma);

    await prisma.syncJob.update({
      where: { id: jobId },
      data: { progressTotal: targets.length },
    });

    const plans = [];
    let completed = 0;

    for (const target of targets) {
      const planned = await planTarget({ target, gateway, platform, prisma });
      if (planned) plans.push(planned);
      completed += 1;

      if (completed % 10 === 0 || completed === targets.length) {
        await prisma.syncJob
          .update({ where: { id: jobId }, data: { progressCompleted: completed } })
          .catch(() => {});
        await onProgress?.({ completed, total: targets.length });
      }
    }

    const removalCount = plans.reduce(
      (total, entry) =>
        total + entry.plan.actions.filter((a) => a.action === SyncActionType.REMOVE_ROLE).length,
      0,
    );

    // Rule 2: a job that wants to remove an unreasonable number of roles stops and asks.
    const threshold = await removalThreshold(prisma);
    if (!job.dryRun && removalCount > threshold) {
      return pauseForThreshold({ job, prisma, removalCount, threshold, plans });
    }

    const outcome = await applyPlans({ job, plans, gateway, prisma });
    return finalizeJob({ job, prisma, outcome, plans });
  } catch (error) {
    log.error({ err: serializeError(error), jobId }, 'sync job failed');
    await prisma.syncJob
      .update({
        where: { id: jobId },
        data: {
          status: SyncJobStatus.FAILED,
          completedAt: new Date(),
          error: { message: error?.message ?? String(error), code: error?.code ?? null },
        },
      })
      .catch(() => {});
    await prisma.syncIssue
      .create({
        data: {
          type: error?.issueType ?? SyncIssueType.UNKNOWN,
          severity: IssueSeverity.ERROR,
          syncJobId: jobId,
          message: error?.userMessage ?? error?.message ?? 'Sync job failed',
          details: { code: error?.code ?? null },
        },
      })
      .catch(() => {});
    throw error;
  }
}

/**
 * Works out which Discord accounts a job covers.
 *
 * Everything is keyed on a Discord account rather than a platform member, because
 * mappings apply to whoever holds the source role — including people who have never
 * signed in. A platform id is attached when one exists, which is what adds that
 * account's manual grants to its plan.
 *
 * @returns {Promise<Array<{discordUserId: string, userId: string|null}>>}
 */
async function resolveTargets(job, prisma, gateway) {
  const payload = job.payload ?? {};

  switch (job.type) {
    case SyncJobType.MEMBER_RESYNC:
    case SyncJobType.GRANT_CHANGE: {
      const userId = payload.userId ?? job.targetUserId;
      if (!userId) return [];
      const member = await loadMemberGrants(userId, { prisma });
      if (!member?.member.discordUserId) return [];
      return [{ discordUserId: member.member.discordUserId, userId }];
    }

    case SyncJobType.MAPPING_PROPAGATION: {
      const discordUserId = payload.discordUserId;
      if (!discordUserId) return [];
      const identity = await prisma.discordIdentity.findUnique({
        where: { discordUserId },
        select: { userId: true },
      });
      return [{ discordUserId, userId: identity?.userId ?? null }];
    }

    case SyncJobType.GUILD_RESYNC: {
      const guild = await prisma.approvedGuild.findUnique({
        where: { id: payload.guildId ?? job.approvedGuildId },
        select: { id: true, discordGuildId: true },
      });
      if (!guild) return [];
      return withPlatformIds(await listGuildMembers(gateway, guild.discordGuildId), prisma);
    }

    case SyncJobType.GLOBAL_RESYNC:
    case SyncJobType.SCHEDULED_RECONCILIATION: {
      const guilds = await prisma.approvedGuild.findMany({
        where: { ...notDeleted, enabled: true, syncEnabled: true },
        select: { discordGuildId: true },
      });

      // Deduplicate: one person in five guilds is still one member to reconcile, and
      // reconciliation covers all of their guilds in a single plan.
      const discordUserIds = new Set();
      for (const guild of guilds) {
        for (const member of await listGuildMembers(gateway, guild.discordGuildId)) {
          discordUserIds.add(member);
        }
      }

      // Members holding a manual grant matter even if they are not currently in any
      // guild we could enumerate: their grant may have expired and need removing.
      const granted = await prisma.manualRoleGrant.findMany({
        where: currentlyEffective(),
        select: { user: { select: { primaryDiscordId: true } } },
        distinct: ['userId'],
      });
      for (const grant of granted) {
        if (grant.user.primaryDiscordId) discordUserIds.add(grant.user.primaryDiscordId);
      }

      return withPlatformIds([...discordUserIds], prisma);
    }

    default:
      return [];
  }
}

/** Reads a guild's Discord member list, tolerating a guild we cannot enumerate. */
async function listGuildMembers(gateway, discordGuildId) {
  try {
    const members = await gateway.listMembers(discordGuildId);
    return members.map((member) => member.id);
  } catch (error) {
    log.warn({ discordGuildId, err: serializeError(error) }, 'could not list guild members');
    return [];
  }
}

/** Attaches platform ids to Discord ids in one query rather than one per member. */
async function withPlatformIds(discordUserIds, prisma) {
  if (discordUserIds.length === 0) return [];

  const identities = await prisma.discordIdentity.findMany({
    where: { discordUserId: { in: discordUserIds } },
    select: { discordUserId: true, userId: true },
  });
  const byDiscordId = new Map(identities.map((row) => [row.discordUserId, row.userId]));

  return discordUserIds.map((discordUserId) => ({
    discordUserId,
    userId: byDiscordId.get(discordUserId) ?? null,
  }));
}

/** Produces the plan for one target. */
async function planTarget({ target, gateway, platform, prisma }) {
  const member = target.userId ? await loadMemberGrants(target.userId, { prisma }) : null;

  const { plan } = await planForDiscordUser({
    gateway,
    platform,
    discordUserId: target.discordUserId,
    member,
  });

  return { userId: target.userId ?? null, discordUserId: target.discordUserId, plan };
}

/** The configured maximum-change threshold, falling back to the environment value. */
async function removalThreshold(prisma) {
  const setting = await prisma.systemSetting
    .findUnique({ where: { key: 'sync.maxRemovalsThreshold' } })
    .catch(() => null);
  const value = Number(setting?.value);
  return Number.isFinite(value) && value > 0 ? value : getEnv().SYNC_MAX_REMOVALS_THRESHOLD;
}

/**
 * Records the planned actions and stops, rather than performing a mass removal.
 *
 * The actions are still written (as PENDING) so an administrator can see exactly what
 * the job wanted to do before deciding whether to raise the threshold or fix the
 * configuration that caused it.
 */
async function pauseForThreshold({ job, prisma, removalCount, threshold, plans }) {
  await persistActions({ job, plans, prisma, status: SyncActionStatus.PENDING });

  await prisma.$transaction(async (tx) => {
    await tx.syncJob.update({
      where: { id: job.id },
      data: {
        status: SyncJobStatus.PAUSED,
        thresholdBreached: true,
        completedAt: new Date(),
        error: {
          reason: 'THRESHOLD_EXCEEDED',
          removalCount,
          threshold,
        },
      },
    });
    await tx.syncIssue.create({
      data: {
        type: SyncIssueType.THRESHOLD_EXCEEDED,
        severity: IssueSeverity.CRITICAL,
        syncJobId: job.id,
        message:
          `This job would remove ${removalCount} roles, which is above the safety threshold of ` +
          `${threshold}. It has been paused. Review the planned actions before continuing.`,
        details: { removalCount, threshold },
      },
    });
    await recordAudit(tx, {
      ctx: systemContext({ label: 'sync-runner' }),
      action: AuditAction.SYNC_JOB_PAUSED,
      syncJobId: job.id,
      approvedGuildId: job.approvedGuildId,
      success: false,
      reason: 'Maximum-change threshold exceeded',
      newState: { removalCount, threshold },
    });
  });

  await notifyGlobalAdmins({
    title: 'Synchronization job paused: too many removals',
    description:
      `A ${job.type} job planned ${removalCount} role removals, above the threshold of ${threshold}. ` +
      'It has been paused and nothing was changed in Discord.',
    severity: 'critical',
    fields: [
      { name: 'Job', value: job.id },
      { name: 'Removals planned', value: String(removalCount) },
      { name: 'Threshold', value: String(threshold) },
    ],
  });

  log.warn({ jobId: job.id, removalCount, threshold }, 'sync job paused on threshold');
  return prisma.syncJob.findUnique({ where: { id: job.id } });
}

/**
 * Applies every plan.
 *
 * Each member is processed under their own lock so two jobs cannot fight over the same
 * person, and each action is validated against live Discord state immediately before it
 * is attempted.
 */
async function applyPlans({ job, plans, gateway, prisma }) {
  let applied = 0;
  let failed = 0;
  let skipped = 0;

  for (const entry of plans) {
    if (entry.plan.actions.length === 0) {
      await persistPlanMetadata({ job, entry, prisma });
      continue;
    }

    const lockKey = entry.userId ?? entry.discordUserId;
    const outcome = await withMemberLock(lockKey, async () => {
      const results = { applied: 0, failed: 0, skipped: 0 };

      for (const action of entry.plan.actions) {
        const result = await applyAction({ job, entry, action, gateway, prisma });
        results[result] += 1;
      }
      return results;
    });

    if (outcome.skipped) {
      // Somebody else is already synchronizing this member. Because reconciliation is
      // idempotent, letting their job do the work is correct.
      skipped += entry.plan.actions.length;
      log.debug({ member: lockKey, jobId: job.id }, 'member locked by another job; skipping');
      continue;
    }

    applied += outcome.result.applied;
    failed += outcome.result.failed;
    skipped += outcome.result.skipped;

    await persistPlanMetadata({ job, entry, prisma });
  }

  return { applied, failed, skipped };
}

/**
 * Applies a single role change.
 * @returns {Promise<'applied'|'failed'|'skipped'>}
 */
async function applyAction({ job, entry, action, gateway, prisma }) {
  const guild = await prisma.approvedGuild.findFirst({
    where: { discordGuildId: action.discordGuildId, ...notDeleted },
    select: { id: true, syncEnabled: true, enabled: true },
  });

  // Defence in depth: the plan was built from approved guilds, but the allowlist can
  // change between planning and applying.
  if (!guild || !guild.enabled || !guild.syncEnabled) {
    await recordActionRow({
      prisma,
      job,
      entry,
      action,
      status: SyncActionStatus.SKIPPED,
      error: 'Guild is no longer approved or has synchronization disabled',
      approvedGuildId: guild?.id ?? null,
    });
    return 'skipped';
  }

  if (job.dryRun) {
    await recordActionRow({
      prisma,
      job,
      entry,
      action,
      status: SyncActionStatus.DRY_RUN,
      approvedGuildId: guild.id,
    });
    return 'skipped';
  }

  const managedRole = action.managedRoleId
    ? await prisma.managedRole.findUnique({ where: { id: action.managedRoleId } })
    : null;

  const preflight = await checkRoleOperation(gateway, {
    discordGuildId: action.discordGuildId,
    discordUserId: action.discordUserId,
    discordRoleId: action.discordRoleId,
    protectionLevel: managedRole?.protectionLevel,
    // The platform's own reconciliation is the authorized path for protected roles: the
    // authorization check happened when the mapping or grant was requested.
    allowProtected: true,
  });

  if (!preflight.ok) {
    const actionRow = await recordActionRow({
      prisma,
      job,
      entry,
      action,
      status: SyncActionStatus.FAILED,
      error: preflight.message,
      approvedGuildId: guild.id,
    });
    await recordIssue({
      prisma,
      job,
      entry,
      action,
      actionRow,
      type: preflight.issueType,
      severity: preflight.severity,
      message: preflight.message,
      approvedGuildId: guild.id,
    });
    return 'failed';
  }

  const markerParts = {
    discordGuildId: action.discordGuildId,
    discordUserId: action.discordUserId,
    discordRoleId: action.discordRoleId,
    action: action.action,
    syncJobId: job.id,
    originMappingId: action.mappingId ?? null,
  };

  // Rule 3: mark first. Discord can deliver the resulting event before the HTTP call
  // returns, and an unmarked event would be treated as a human action and propagated.
  await writeSyncMarker(markerParts).catch((error) => {
    log.warn({ err: serializeError(error) }, 'could not write sync marker; continuing');
  });

  try {
    const reason = `FRM: ${action.reason}`.slice(0, 400);
    if (action.action === SyncActionType.ADD_ROLE) {
      await gateway.addRole(
        action.discordGuildId,
        action.discordUserId,
        action.discordRoleId,
        reason,
      );
    } else {
      await gateway.removeRole(
        action.discordGuildId,
        action.discordUserId,
        action.discordRoleId,
        reason,
      );
    }

    await recordActionRow({
      prisma,
      job,
      entry,
      action,
      status: SyncActionStatus.APPLIED,
      approvedGuildId: guild.id,
      appliedAt: new Date(),
    });
    return 'applied';
  } catch (error) {
    // The change never happened, so the marker must go: otherwise it would swallow the
    // next genuine event for this role.
    await discardSyncMarker(markerParts).catch(() => {});

    const actionRow = await recordActionRow({
      prisma,
      job,
      entry,
      action,
      status: SyncActionStatus.FAILED,
      error: error?.userMessage ?? error?.message ?? 'Unknown error',
      approvedGuildId: guild.id,
    });
    await recordIssue({
      prisma,
      job,
      entry,
      action,
      actionRow,
      type: error?.issueType ?? SyncIssueType.DISCORD_ERROR,
      severity: error?.retryable ? IssueSeverity.WARNING : IssueSeverity.ERROR,
      message: error?.userMessage ?? error?.message ?? 'Discord rejected the change',
      approvedGuildId: guild.id,
      retryable: Boolean(error?.retryable),
    });

    log.warn(
      {
        jobId: job.id,
        action: action.action,
        discordGuildId: action.discordGuildId,
        err: serializeError(error),
      },
      'role change failed',
    );
    return 'failed';
  }
}

function recordActionRow({
  prisma,
  job,
  entry,
  action,
  status,
  error,
  approvedGuildId,
  appliedAt,
}) {
  return prisma.syncAction.create({
    data: {
      syncJobId: job.id,
      action: action.action,
      status,
      userId: entry.userId ?? null,
      discordUserId: action.discordUserId,
      approvedGuildId: approvedGuildId ?? null,
      discordGuildId: action.discordGuildId,
      discordRoleId: action.discordRoleId,
      managedRoleId: action.managedRoleId ?? null,
      mappingId: action.mappingId ?? null,
      reason: action.reason,
      error: error ?? null,
      appliedAt: appliedAt ?? null,
    },
  });
}

function recordIssue({
  prisma,
  job,
  entry,
  action,
  actionRow,
  type,
  severity,
  message,
  approvedGuildId,
  retryable,
}) {
  return prisma.syncIssue.create({
    data: {
      type: type ?? SyncIssueType.UNKNOWN,
      severity: severity ?? IssueSeverity.ERROR,
      syncJobId: job.id,
      syncActionId: actionRow?.id ?? null,
      approvedGuildId: approvedGuildId ?? null,
      discordGuildId: action.discordGuildId,
      userId: entry.userId ?? null,
      discordUserId: action.discordUserId,
      mappingId: action.mappingId ?? null,
      discordRoleId: action.discordRoleId,
      message,
      details: { retryable: Boolean(retryable), reason: action.reason },
    },
  });
}

/** Records warnings and conflicts that are not tied to a single action. */
async function persistPlanMetadata({ job, entry, prisma }) {
  for (const warning of entry.plan.warnings ?? []) {
    if (warning.type === SyncIssueType.MEMBER_NOT_IN_GUILD) {
      await prisma.syncIssue
        .create({
          data: {
            type: SyncIssueType.MEMBER_NOT_IN_GUILD,
            severity: IssueSeverity.WARNING,
            syncJobId: job.id,
            userId: entry.userId ?? null,
            discordUserId: entry.discordUserId,
            discordGuildId: warning.details?.discordGuildId ?? null,
            message: warning.message,
            details: warning.details ?? {},
          },
        })
        .catch(() => {});
    }
  }

  for (const conflict of entry.plan.conflicts ?? []) {
    await prisma.syncIssue
      .create({
        data: {
          type: SyncIssueType.MAPPING_CONFLICT,
          severity: IssueSeverity.WARNING,
          syncJobId: job.id,
          userId: entry.userId ?? null,
          discordUserId: entry.discordUserId,
          mappingId: conflict.details?.mappingId ?? null,
          discordGuildId: conflict.details?.discordGuildId ?? null,
          discordRoleId: conflict.details?.discordRoleId ?? null,
          message: conflict.message,
          details: conflict.details ?? {},
        },
      })
      .catch(() => {});
  }
}

/** Writes planned actions without applying them (used by the threshold pause path). */
async function persistActions({ job, plans, prisma, status }) {
  for (const entry of plans) {
    for (const action of entry.plan.actions) {
      const guild = await prisma.approvedGuild.findFirst({
        where: { discordGuildId: action.discordGuildId, ...notDeleted },
        select: { id: true },
      });
      await recordActionRow({
        prisma,
        job,
        entry,
        action,
        status,
        approvedGuildId: guild?.id ?? null,
      });
    }
  }
}

/** Sets the final status and writes the completion audit record. */
async function finalizeJob({ job, prisma, outcome, plans }) {
  const total = outcome.applied + outcome.failed + outcome.skipped;
  const status =
    outcome.failed === 0
      ? SyncJobStatus.COMPLETED
      : outcome.applied > 0
        ? SyncJobStatus.PARTIAL
        : SyncJobStatus.FAILED;

  const finished = await prisma.$transaction(async (tx) => {
    const row = await tx.syncJob.update({
      where: { id: job.id },
      data: {
        status,
        completedAt: new Date(),
        progressCompleted: plans.length,
        progressTotal: plans.length,
      },
    });

    await recordAudit(tx, {
      ctx: {
        actor: { user: { id: job.initiatedById }, discordUserId: job.initiatedByDiscordId },
        source: job.source ?? ActionSource.SYSTEM,
        requestId: job.requestId,
      },
      action:
        status === SyncJobStatus.COMPLETED
          ? AuditAction.SYNC_JOB_COMPLETED
          : AuditAction.SYNC_JOB_FAILED,
      syncJobId: job.id,
      targetUserId: job.targetUserId,
      approvedGuildId: job.approvedGuildId,
      success: status !== SyncJobStatus.FAILED,
      newState: {
        status,
        applied: outcome.applied,
        failed: outcome.failed,
        skipped: outcome.skipped,
        membersReviewed: plans.length,
        totalActions: total,
        dryRun: job.dryRun,
      },
    });

    return row;
  });

  log.info(
    {
      jobId: job.id,
      status,
      applied: outcome.applied,
      failed: outcome.failed,
      skipped: outcome.skipped,
      members: plans.length,
    },
    'sync job finished',
  );

  return finished;
}
