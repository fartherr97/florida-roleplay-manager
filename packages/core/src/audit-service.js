/**
 * Audit logging.
 *
 * Append only. There is deliberately no update and no delete function in this module,
 * and no other module writes to the `audit_logs` table. `docs/security.md` describes
 * the database-level grant that enforces the same rule below the application.
 *
 * Sensitive values never reach an audit record: state snapshots are built from
 * explicitly listed fields rather than by spreading whole rows, so a future column
 * containing a secret cannot leak in by accident.
 */
import { getPrisma, toPage, toSkipTake } from '@frm/database';
import { createLogger } from '@frm/logging';
import { ActionSource, AuthorizationError, PAGINATION } from '@frm/shared';
import { authorize, departmentScopeFilter } from '@frm/authorization';
import { auditQuerySchema, parseOrThrow } from '@frm/validation';

const log = createLogger('core.audit');

/**
 * Writes one audit record.
 *
 * Accepts a transaction client so the audit row commits atomically with the change it
 * describes: a roster change that succeeded without its audit record, or an audit
 * record for a change that rolled back, would both be worse than useless.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} client
 * @param {object} entry
 * @param {import('./context.js').ServiceContext} entry.ctx
 * @param {string} entry.action one of AuditAction
 * @param {string} [entry.targetUserId]
 * @param {string} [entry.targetDiscordId]
 * @param {string} [entry.departmentId]
 * @param {string} [entry.approvedGuildId]
 * @param {string} [entry.mappingId]
 * @param {string} [entry.syncJobId]
 * @param {object} [entry.previousState]
 * @param {object} [entry.newState]
 * @param {string} [entry.reason]
 * @param {boolean} [entry.success]
 * @param {string} [entry.errorCode]
 * @param {string} [entry.errorMessage]
 */
export async function recordAudit(client, entry) {
  const { ctx } = entry;

  return client.auditLog.create({
    data: {
      action: entry.action,
      source: ctx.source ?? ActionSource.SYSTEM,
      actorUserId: ctx.actor?.user?.id ?? null,
      actorDiscordId: ctx.actor?.discordUserId ?? null,
      targetUserId: entry.targetUserId ?? null,
      targetDiscordId: entry.targetDiscordId ?? null,
      departmentId: entry.departmentId ?? null,
      approvedGuildId: entry.approvedGuildId ?? null,
      mappingId: entry.mappingId ?? null,
      syncJobId: entry.syncJobId ?? null,
      previousState: entry.previousState ?? undefined,
      newState: entry.newState ?? undefined,
      reason: entry.reason ?? null,
      requestId: ctx.requestId ?? null,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      success: entry.success ?? true,
      errorCode: entry.errorCode ?? null,
      errorMessage: entry.errorMessage ?? null,
    },
  });
}

/**
 * Records a failed attempt.
 *
 * Denied actions are audited too: an audit trail that only contains successes cannot
 * answer "who has been trying to promote themselves?".
 */
export async function recordFailure(ctx, { action, error, ...rest }) {
  try {
    return await recordAudit(ctx.prisma, {
      ctx,
      action,
      success: false,
      errorCode: error?.code ?? 'INTERNAL',
      errorMessage: error?.message?.slice(0, 500) ?? null,
      ...rest,
    });
  } catch (auditError) {
    // Never let audit-writing failures mask the original error.
    log.error({ err: auditError?.message, action }, 'failed to record audit failure');
    return null;
  }
}

/**
 * Reads audit records, constrained to what the actor is allowed to see.
 *
 * A department-scoped `audit.view` holder only ever sees records for their own
 * departments; the filter is applied server side and cannot be widened by the caller.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 */
export async function queryAuditLogs(ctx, input) {
  const query = parseOrThrow(auditQuerySchema, input);

  authorize(ctx.actor, {
    capability: 'audit.view',
    scope: {
      departmentId: query.departmentId,
      guildId: query.guildId,
    },
  });

  const allowedDepartments = departmentScopeFilter(ctx.actor, 'audit.view');

  /** @type {object} */
  const where = {};
  if (query.actorUserId) where.actorUserId = query.actorUserId;
  if (query.actorDiscordId) where.actorDiscordId = query.actorDiscordId;
  if (query.targetUserId) where.targetUserId = query.targetUserId;
  if (query.targetDiscordId) where.targetDiscordId = query.targetDiscordId;
  if (query.mappingId) where.mappingId = query.mappingId;
  if (query.syncJobId) where.syncJobId = query.syncJobId;
  if (query.action) where.action = query.action;
  if (typeof query.success === 'boolean') where.success = query.success;
  if (query.guildId) where.approvedGuildId = query.guildId;
  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) where.createdAt.gte = query.from;
    if (query.to) where.createdAt.lte = query.to;
  }

  if (allowedDepartments !== null) {
    if (allowedDepartments.length === 0) {
      throw new AuthorizationError('You do not have audit access to any department.');
    }
    // Records with no department (global actions) are only visible to global holders.
    where.departmentId = query.departmentId
      ? assertWithin(query.departmentId, allowedDepartments)
      : { in: allowedDepartments };
  } else if (query.departmentId) {
    where.departmentId = query.departmentId;
  }

  const prisma = ctx.prisma ?? getPrisma();
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: query.sortDir },
      ...toSkipTake(query),
      select: {
        id: true,
        action: true,
        source: true,
        actorUserId: true,
        actorDiscordId: true,
        targetUserId: true,
        targetDiscordId: true,
        departmentId: true,
        approvedGuildId: true,
        mappingId: true,
        syncJobId: true,
        previousState: true,
        newState: true,
        reason: true,
        requestId: true,
        success: true,
        errorCode: true,
        errorMessage: true,
        createdAt: true,
        actor: { select: { id: true, displayName: true } },
        target: { select: { id: true, displayName: true } },
      },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return toPage(items, total, query);
}

/**
 * Convenience reader for `/audit member`.
 * @param {import('./context.js').ServiceContext} ctx
 */
export async function auditForMember(ctx, { userId, discordUserId, page = 1, pageSize = 10 }) {
  return queryAuditLogs(ctx, {
    targetUserId: userId,
    targetDiscordId: discordUserId,
    page,
    pageSize: Math.min(pageSize, PAGINATION.MAX_PAGE_SIZE),
  });
}

/** Convenience reader for `/audit mapping`. */
export async function auditForMapping(ctx, { mappingId, page = 1, pageSize = 10 }) {
  return queryAuditLogs(ctx, { mappingId, page, pageSize });
}

/**
 * Export path for `audit.export`. Capped and still scope filtered - "export" does not
 * mean "read everything".
 */
export async function exportAuditLogs(ctx, input) {
  authorize(ctx.actor, { capability: 'audit.export', scope: {} });
  const page = await queryAuditLogs(ctx, { ...input, pageSize: PAGINATION.MAX_PAGE_SIZE });
  return page;
}

function assertWithin(value, allowed) {
  if (!allowed.includes(value)) {
    throw new AuthorizationError('You do not have audit access to that department.');
  }
  return value;
}
