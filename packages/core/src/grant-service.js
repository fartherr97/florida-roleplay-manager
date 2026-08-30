/**
 * Manual role grants.
 *
 * Time-bounded human authority: temporary sensitive access, event assignments,
 * investigation access. A grant is the only non-mapping source of desired state, so
 * issuing one is what lets an administrator hand somebody a role that no mapping would
 * ever give them — and revoking or expiring it takes the role back automatically on the
 * next reconciliation, without anybody having to remember.
 */
import { currentlyEffective, getPrisma, toPage, toSkipTake } from '@frm/database';
import { createLogger } from '@frm/logging';
import {
  AuditAction,
  ConflictError,
  NotFoundError,
  RolePurpose,
  SyncJobType,
  ValidationError,
} from '@frm/shared';
import { authorize } from '@frm/authorization';
import {
  issueGrantSchema,
  listGrantsSchema,
  parseOrThrow,
  revokeGrantSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { authorizeAnyScope, isSelf, resolveManagedRole, resolveUser } from './resolve.js';
import { createSyncJob, enqueueSyncJob } from './sync-service.js';
import { assertActorAboveRole } from './role-hierarchy.js';

const log = createLogger('core.grant');

/**
 * Issues a grant and queues the synchronization that applies it.
 *
 * The database write, the audit record and the sync job commit together; the enqueue
 * happens after the commit, because a queue is not transactional.
 */
export async function issueGrant(ctx, input, { gateway } = {}) {
  const data = parseOrThrow(issueGrantSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const managedRole = await resolveManagedRole(ctx, data.managedRoleId);
  const user = await resolveUser(ctx, data);

  authorize(ctx.actor, {
    capability: 'grant.issue',
    scope: { guildId: managedRole.approvedGuildId },
    target: { userId: user.id, permissionLevel: user.permissionLevel },
  });

  // Beyond the capability gate: an operator may never grant a role at or above their own
  // highest role. Only enforceable when a gateway is available to read live Discord roles
  // (the bot always passes one); system/scheduled callers without a gateway skip it.
  if (gateway) {
    await assertActorAboveRole(gateway, {
      discordGuildId: managedRole.guild?.discordGuildId,
      actorDiscordUserId: ctx.actor?.discordUserId,
      discordRoleId: managedRole.discordRoleId,
    });
  }

  // A grant can only ever apply to a role the engine treats as grant-driven. Granting a
  // mapping-driven role would be silently undone on the next reconciliation, which is a
  // deeply confusing thing to debug.
  if (managedRole.purpose !== RolePurpose.MANUAL_GRANT) {
    throw new ValidationError(
      `"${managedRole.name}" is a ${managedRole.purpose} role. Only roles with the MANUAL_GRANT ` +
        'purpose can be granted directly; change the role definition first.',
    );
  }

  const existing = await prisma.manualRoleGrant.findFirst({
    where: { userId: user.id, managedRoleId: managedRole.id, ...currentlyEffective() },
  });
  if (existing) {
    throw new ConflictError(`That member already holds an active grant for "${managedRole.name}".`);
  }

  const { grant, job } = await prisma.$transaction(async (tx) => {
    const created = await tx.manualRoleGrant.create({
      data: {
        userId: user.id,
        managedRoleId: managedRole.id,
        grantedById: ctx.actor?.user?.id ?? null,
        reason: data.reason,
        expiresAt: data.expiresAt ?? null,
      },
    });

    const syncJob = await createSyncJob(tx, ctx, {
      type: SyncJobType.GRANT_CHANGE,
      targetUserId: user.id,
      approvedGuildId: managedRole.approvedGuildId,
      dryRun: false,
      reason: data.reason,
      payload: { userId: user.id },
    });

    await recordAudit(tx, {
      ctx,
      action: AuditAction.GRANT_ISSUED,
      targetUserId: user.id,
      targetDiscordId: user.primaryDiscordId,
      approvedGuildId: managedRole.approvedGuildId,
      syncJobId: syncJob.id,
      reason: data.reason,
      newState: {
        managedRoleId: managedRole.id,
        roleName: managedRole.name,
        expiresAt: created.expiresAt,
      },
    });

    return { grant: created, job: syncJob };
  });

  const enqueued = await enqueueSyncJob(job, { prisma });
  log.info({ grantId: grant.id, userId: user.id }, 'manual grant issued');

  return { grant, syncJob: job, enqueued: enqueued.enqueued };
}

/** Revokes a grant. The role comes off at the next reconciliation. */
export async function revokeGrant(ctx, input) {
  const data = parseOrThrow(revokeGrantSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const grant = await prisma.manualRoleGrant.findUnique({
    where: { id: data.grantId },
    include: { managedRole: true, user: true },
  });
  if (!grant || grant.revokedAt) throw new NotFoundError('Grant', data.grantId);

  authorize(ctx.actor, {
    capability: 'grant.revoke',
    scope: { guildId: grant.managedRole.approvedGuildId },
    target: { userId: grant.userId, permissionLevel: grant.user.permissionLevel },
  });

  const { revoked, job } = await prisma.$transaction(async (tx) => {
    const row = await tx.manualRoleGrant.update({
      where: { id: grant.id },
      data: { revokedAt: new Date(), revokedById: ctx.actor?.user?.id ?? null },
    });

    const syncJob = await createSyncJob(tx, ctx, {
      type: SyncJobType.GRANT_CHANGE,
      targetUserId: grant.userId,
      approvedGuildId: grant.managedRole.approvedGuildId,
      dryRun: false,
      reason: data.reason,
      payload: { userId: grant.userId },
    });

    await recordAudit(tx, {
      ctx,
      action: AuditAction.GRANT_REVOKED,
      targetUserId: grant.userId,
      targetDiscordId: grant.user.primaryDiscordId,
      approvedGuildId: grant.managedRole.approvedGuildId,
      syncJobId: syncJob.id,
      reason: data.reason,
      previousState: { managedRoleId: grant.managedRoleId, roleName: grant.managedRole.name },
      newState: { revoked: true },
    });

    return { revoked: row, job: syncJob };
  });

  await enqueueSyncJob(job, { prisma });
  return { grant: revoked, syncJob: job };
}

/** Lists grants, defaulting to the ones currently in force. */
export async function listGrants(ctx, input = {}) {
  const query = parseOrThrow(listGrantsSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const target =
    query.userId || query.discordUserId ? await resolveUser(ctx, query, { required: true }) : null;

  if (!target || !isSelf(ctx, target.id)) {
    authorizeAnyScope(ctx, 'grant.issue', {
      target: target ? { userId: target.id } : {},
      allowSelf: true,
    });
  }

  /** @type {object} */
  const where = query.includeExpired ? {} : { ...currentlyEffective() };
  if (target) where.userId = target.id;
  if (query.managedRoleId) where.managedRoleId = query.managedRoleId;

  const [items, total] = await Promise.all([
    prisma.manualRoleGrant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...toSkipTake(query),
      include: {
        managedRole: {
          select: {
            id: true,
            name: true,
            discordRoleId: true,
            guild: { select: { id: true, name: true } },
          },
        },
        user: { select: { id: true, displayName: true, primaryDiscordId: true } },
        grantedBy: { select: { id: true, displayName: true } },
      },
    }),
    prisma.manualRoleGrant.count({ where }),
  ]);

  return toPage(items, total, query);
}

/**
 * Expires grants whose time is up.
 *
 * Reconciliation already ignores an expired grant when computing desired state, so this
 * is bookkeeping rather than enforcement: it queues the resync that takes the role off
 * promptly instead of waiting for the next scheduled sweep.
 *
 * @param {import('./context.js').ServiceContext} ctx
 */
export async function expireGrants(ctx, { now = new Date() } = {}) {
  const prisma = ctx.prisma ?? getPrisma();

  const expiring = await prisma.manualRoleGrant.findMany({
    where: { revokedAt: null, expiresAt: { not: null, lte: now } },
    select: { id: true, userId: true, managedRole: { select: { approvedGuildId: true } } },
  });
  if (expiring.length === 0) return { expired: 0 };

  const userIds = [...new Set(expiring.map((grant) => grant.userId))];

  for (const userId of userIds) {
    const job = await createSyncJob(prisma, ctx, {
      type: SyncJobType.GRANT_CHANGE,
      targetUserId: userId,
      dryRun: false,
      reason: 'Manual grant expired',
      payload: { userId },
    });
    await enqueueSyncJob(job, { prisma });
  }

  log.info({ grants: expiring.length, members: userIds.length }, 'expired grants queued');
  return { expired: expiring.length, members: userIds.length };
}
