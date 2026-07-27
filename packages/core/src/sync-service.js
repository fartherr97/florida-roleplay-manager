/**
 * Synchronization job lifecycle.
 *
 * Creating a job is a database write; running it is the worker's business. The split
 * matters: a roster change commits its `SyncJob` row inside the same transaction as the
 * change itself, and only enqueues onto BullMQ *after* the commit succeeds. A queue is
 * not transactional, so a job enqueued inside the transaction could be picked up before
 * (or instead of) the data it describes.
 *
 * If the enqueue fails, the job row still exists and a `SyncIssue` records the failure,
 * so nothing is silently lost and scheduled reconciliation will still repair the state.
 */
import { getPrisma, notDeleted, toPage, toSkipTake } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import {
  ActionSource,
  AuditAction,
  AuthorizationError,
  IssueSeverity,
  NotFoundError,
  PreconditionError,
  SyncIssueType,
  SyncJobStatus,
  SyncJobType,
  getEnv,
} from '@frm/shared';
import { authorize, departmentScopeFilter } from '@frm/authorization';
import { JOB_NAME_FOR_TYPE, enqueue } from '@frm/queue';
import {
  parseOrThrow,
  resyncDepartmentSchema,
  resyncGuildSchema,
  resyncMemberSchema,
  resyncAllSchema,
  retryIssueSchema,
  syncIssueListSchema,
  syncJobListSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { resolveApprovedGuild, resolveDepartment, resolveUser } from './resolve.js';

const log = createLogger('core.sync');

/**
 * Creates the `SyncJob` row. Call inside a transaction when the job accompanies another
 * change; call with the plain client for a standalone resync.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} client
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} params
 */
export async function createSyncJob(client, ctx, params) {
  const env = getEnv();
  const dryRun =
    typeof params.dryRun === 'boolean' ? params.dryRun : Boolean(env.SYNC_DRY_RUN_DEFAULT);

  return client.syncJob.create({
    data: {
      type: params.type,
      status: SyncJobStatus.PENDING,
      source: ctx.source ?? ActionSource.SYSTEM,
      initiatedById: ctx.actor?.user?.id ?? null,
      initiatedByDiscordId: ctx.actor?.discordUserId ?? null,
      departmentId: params.departmentId ?? null,
      approvedGuildId: params.approvedGuildId ?? null,
      targetUserId: params.targetUserId ?? null,
      mappingId: params.mappingId ?? null,
      parentJobId: params.parentJobId ?? null,
      dryRun,
      requestId: ctx.requestId ?? null,
      reason: params.reason ?? null,
      payload: params.payload ?? {},
    },
  });
}

/**
 * Enqueues a previously created job. Never throws: a queue outage must not roll back a
 * roster change that has already committed, so the failure is recorded as an issue and
 * surfaced to administrators.
 *
 * @param {object} job the SyncJob row
 * @param {object} [options]
 */
export async function enqueueSyncJob(job, { prisma = getPrisma() } = {}) {
  const jobName = JOB_NAME_FOR_TYPE[job.type];
  if (!jobName) {
    log.error({ type: job.type }, 'no queue job registered for sync job type');
    return { enqueued: false };
  }

  try {
    const queued = await enqueue(
      jobName,
      { syncJobId: job.id, type: job.type, dryRun: job.dryRun, payload: job.payload ?? {} },
      { jobId: job.id },
    );
    await prisma.syncJob.update({
      where: { id: job.id },
      data: { queueJobId: String(queued.id) },
    });
    return { enqueued: true, queueJobId: queued.id };
  } catch (error) {
    log.error({ err: serializeError(error), syncJobId: job.id }, 'failed to enqueue sync job');
    await prisma.syncIssue
      .create({
        data: {
          type: SyncIssueType.ENQUEUE_FAILED,
          severity: IssueSeverity.CRITICAL,
          syncJobId: job.id,
          message:
            'The change was saved but could not be queued for synchronization. ' +
            'Retry it from /audit failures, or wait for scheduled reconciliation.',
          details: { error: error?.message ?? String(error) },
        },
      })
      .catch(() => {});
    return { enqueued: false, error };
  }
}

/**
 * Creates a job and enqueues it, recording an audit entry. Used by every "resync"
 * command and endpoint.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} params
 */
export async function createAndEnqueue(ctx, params) {
  const prisma = ctx.prisma ?? getPrisma();

  const job = await prisma.$transaction(async (tx) => {
    const created = await createSyncJob(tx, ctx, params);
    await recordAudit(tx, {
      ctx,
      action: AuditAction.SYNC_JOB_CREATED,
      targetUserId: params.targetUserId ?? null,
      departmentId: params.departmentId ?? null,
      approvedGuildId: params.approvedGuildId ?? null,
      syncJobId: created.id,
      reason: params.reason ?? null,
      newState: { type: created.type, dryRun: created.dryRun },
    });
    return created;
  });

  const result = await enqueueSyncJob(job, { prisma });
  return { job, ...result };
}

// ---------------------------------------------------------------------------
// Resync entry points
// ---------------------------------------------------------------------------

/**
 * Authorizes an action against every department the target member belongs to.
 *
 * A member of two departments may be resynchronized by command staff of either one -
 * the change is to that member's whole role set, and refusing would make the command
 * useless for anybody with dual membership.
 */
async function authorizeAgainstMemberScopes(ctx, capability, userId) {
  const prisma = ctx.prisma ?? getPrisma();
  const memberships = await prisma.departmentMembership.findMany({
    where: { userId, ...notDeleted },
    select: { departmentId: true },
  });

  if (memberships.length === 0) {
    authorize(ctx.actor, { capability, scope: {}, allowSelf: true });
    return;
  }

  let lastError = null;
  for (const membership of memberships) {
    try {
      authorize(ctx.actor, {
        capability,
        scope: { departmentId: membership.departmentId },
        allowSelf: true,
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new AuthorizationError(`You do not have ${capability} for this member.`);
}

/** `/resync member` and `POST /api/sync/member`. */
export async function resyncMember(ctx, input) {
  const data = parseOrThrow(resyncMemberSchema, input);
  const user = await resolveUser(ctx, data);

  await authorizeAgainstMemberScopes(ctx, 'sync.member', user.id);

  return createAndEnqueue(ctx, {
    type: SyncJobType.MEMBER_RESYNC,
    targetUserId: user.id,
    dryRun: data.dryRun,
    reason: data.reason,
    payload: { userId: user.id },
  });
}

/** `/resync department`. */
export async function resyncDepartment(ctx, input) {
  const data = parseOrThrow(resyncDepartmentSchema, input);
  const department = await resolveDepartment(ctx, data.departmentId);

  authorize(ctx.actor, {
    capability: 'sync.department',
    scope: { departmentId: department.id },
  });

  return createAndEnqueue(ctx, {
    type: SyncJobType.DEPARTMENT_RESYNC,
    departmentId: department.id,
    dryRun: data.dryRun,
    reason: data.reason,
    payload: { departmentId: department.id, includeInactive: data.includeInactive },
  });
}

/** `/resync guild`. */
export async function resyncGuild(ctx, input) {
  const data = parseOrThrow(resyncGuildSchema, input);
  const guild = await resolveApprovedGuild(ctx, data.guildId);

  authorize(ctx.actor, {
    capability: 'sync.guild',
    scope: { guildId: guild.id, departmentId: guild.departmentId ?? undefined },
  });

  if (!guild.enabled || !guild.syncEnabled) {
    throw new PreconditionError(`Synchronization is disabled for ${guild.name}.`);
  }

  return createAndEnqueue(ctx, {
    type: SyncJobType.GUILD_RESYNC,
    approvedGuildId: guild.id,
    dryRun: data.dryRun,
    reason: data.reason,
    payload: { guildId: guild.id },
  });
}

/** `/resync all`. Global scope only, and always confirmed by the caller first. */
export async function resyncAll(ctx, input) {
  const data = parseOrThrow(resyncAllSchema, input);
  authorize(ctx.actor, { capability: 'sync.global', scope: {} });

  return createAndEnqueue(ctx, {
    type: SyncJobType.GLOBAL_RESYNC,
    dryRun: data.dryRun,
    reason: data.reason,
    payload: {},
  });
}

/**
 * Queues the synchronization that follows a roster change. Called from inside roster
 * service transactions, so it takes the transaction client and defers enqueueing.
 */
export async function createRosterChangeJob(tx, ctx, { userId, departmentId, reason }) {
  return createSyncJob(tx, ctx, {
    type: SyncJobType.ROSTER_CHANGE,
    targetUserId: userId,
    departmentId,
    reason,
    dryRun: false,
    payload: { userId },
  });
}

// ---------------------------------------------------------------------------
// Reading jobs and issues
// ---------------------------------------------------------------------------

/**
 * Polls for a job to finish.
 *
 * Used by the bot so that `/resync preview` can show a result in the same interaction.
 * Polling the database (rather than subscribing to queue events) keeps the bot free of
 * queue-internal state and works identically across replicas.
 *
 * @param {string} jobId
 * @param {{timeoutMs?: number, pollMs?: number, prisma?: object}} [options]
 */
export async function waitForJob(jobId, { timeoutMs = 30000, pollMs = 750, prisma } = {}) {
  const client = prisma ?? getPrisma();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = await client.syncJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundError('Sync job', jobId);
    if (job.status !== SyncJobStatus.PENDING && job.status !== SyncJobStatus.RUNNING) {
      return job;
    }
    await sleep(pollMs);
  }
  return client.syncJob.findUnique({ where: { id: jobId } });
}

/** Full job detail including its planned or applied actions. */
export async function getSyncJob(ctx, jobId, { includeActions = true, actionLimit = 100 } = {}) {
  const prisma = ctx.prisma ?? getPrisma();
  const job = await prisma.syncJob.findUnique({
    where: { id: jobId },
    include: {
      department: { select: { id: true, name: true } },
      guild: { select: { id: true, name: true } },
      issues: { where: { resolved: false }, take: 25 },
      actions: includeActions ? { take: actionLimit, orderBy: { createdAt: 'asc' } } : false,
      _count: { select: { actions: true, issues: true } },
    },
  });
  if (!job) throw new NotFoundError('Sync job', jobId);

  authorizeJobRead(ctx, job);
  return job;
}

/** Jobs list with scope filtering. */
export async function listSyncJobs(ctx, input) {
  const query = parseOrThrow(syncJobListSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const allowedDepartments = departmentScopeFilter(ctx.actor, 'sync.member');
  /** @type {object} */
  const where = {};
  if (query.status) where.status = query.status;
  if (query.departmentId) where.departmentId = query.departmentId;
  if (query.guildId) where.approvedGuildId = query.guildId;
  if (query.userId) where.targetUserId = query.userId;

  if (allowedDepartments !== null) {
    if (allowedDepartments.length === 0) {
      throw new AuthorizationError('You do not have synchronization access to any department.');
    }
    where.departmentId = { in: allowedDepartments };
  }

  const [items, total] = await Promise.all([
    prisma.syncJob.findMany({
      where,
      orderBy: { [query.sortBy]: query.sortDir },
      ...toSkipTake(query),
      include: {
        department: { select: { id: true, name: true } },
        guild: { select: { id: true, name: true } },
        _count: { select: { actions: true, issues: true } },
      },
    }),
    prisma.syncJob.count({ where }),
  ]);

  return toPage(items, total, query);
}

/** Unresolved synchronization issues, newest first. */
export async function listSyncIssues(ctx, input) {
  const query = parseOrThrow(syncIssueListSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  authorize(ctx.actor, { capability: 'sync.issue.retry', scope: {} });

  /** @type {object} */
  const where = {};
  if (query.type) where.type = query.type;
  if (typeof query.resolved === 'boolean') where.resolved = query.resolved;
  else where.resolved = false;
  if (query.guildId) where.approvedGuildId = query.guildId;
  if (query.userId) where.userId = query.userId;

  const [items, total] = await Promise.all([
    prisma.syncIssue.findMany({
      where,
      orderBy: { createdAt: query.sortDir },
      ...toSkipTake(query),
      include: {
        guild: { select: { id: true, name: true } },
        user: { select: { id: true, displayName: true } },
        mapping: { select: { id: true, name: true } },
      },
    }),
    prisma.syncIssue.count({ where }),
  ]);

  return toPage(items, total, query);
}

/**
 * Retries a single failed action by creating a fresh member resync scoped to the
 * affected member. Retrying the member (rather than replaying the exact API call) means
 * the retry re-plans against current state and cannot re-apply a change that is no
 * longer correct.
 */
export async function retrySyncIssue(ctx, input) {
  const data = parseOrThrow(retryIssueSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const issue = await prisma.syncIssue.findUnique({
    where: { id: data.issueId },
    include: { action: true },
  });
  if (!issue) throw new NotFoundError('Sync issue', data.issueId);
  if (issue.resolved) throw new PreconditionError('That issue has already been resolved.');

  const userId = issue.userId ?? issue.action?.userId ?? null;
  if (!userId) {
    throw new PreconditionError(
      'That issue is not tied to a specific member, so it cannot be retried individually. ' +
        'Run a guild or department resync instead.',
    );
  }

  await authorizeAgainstMemberScopes(ctx, 'sync.issue.retry', userId);

  const result = await createAndEnqueue(ctx, {
    type: SyncJobType.MEMBER_RESYNC,
    targetUserId: userId,
    dryRun: false,
    reason: data.reason ?? `Retry of issue ${issue.id}`,
    payload: { userId, retryOfIssueId: issue.id },
  });

  await prisma.syncIssue.update({
    where: { id: issue.id },
    data: { retryCount: { increment: 1 }, lastRetryAt: new Date() },
  });

  return result;
}

/** Marks an issue as resolved after a human has dealt with it. */
export async function resolveSyncIssue(ctx, { issueId, reason }) {
  const prisma = ctx.prisma ?? getPrisma();
  const issue = await prisma.syncIssue.findUnique({ where: { id: issueId } });
  if (!issue) throw new NotFoundError('Sync issue', issueId);

  authorize(ctx.actor, { capability: 'sync.issue.retry', scope: {} });

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.syncIssue.update({
      where: { id: issueId },
      data: { resolved: true, resolvedAt: new Date(), resolvedById: ctx.actor?.user?.id ?? null },
    });
    await recordAudit(tx, {
      ctx,
      action: AuditAction.SYNC_ISSUE_RESOLVED,
      targetUserId: issue.userId,
      reason,
      previousState: { resolved: false },
      newState: { resolved: true },
    });
    return row;
  });

  return updated;
}

/** Cancels a job that has not started yet. */
export async function cancelSyncJob(ctx, jobId, reason) {
  const prisma = ctx.prisma ?? getPrisma();
  const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError('Sync job', jobId);
  authorizeJobRead(ctx, job);

  if (job.status !== SyncJobStatus.PENDING && job.status !== SyncJobStatus.PAUSED) {
    throw new PreconditionError(`A ${job.status.toLowerCase()} job cannot be cancelled.`);
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.syncJob.update({
      where: { id: jobId },
      data: { status: SyncJobStatus.CANCELLED, completedAt: new Date() },
    });
    await recordAudit(tx, {
      ctx,
      action: AuditAction.SYNC_JOB_CANCELLED,
      syncJobId: jobId,
      reason,
      previousState: { status: job.status },
      newState: { status: SyncJobStatus.CANCELLED },
    });
    return updated;
  });
}

/**
 * Read authorization for a job: global sync holders see everything, department holders
 * see their own department's jobs, and a member may always see a job about themselves.
 */
function authorizeJobRead(ctx, job) {
  if (ctx.actor?.isSystem) return;
  if (job.targetUserId && job.targetUserId === ctx.actor?.user?.id) return;

  authorize(ctx.actor, {
    capability: 'sync.member',
    scope: {
      departmentId: job.departmentId ?? undefined,
      guildId: job.approvedGuildId ?? undefined,
    },
    allowSelf: true,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
