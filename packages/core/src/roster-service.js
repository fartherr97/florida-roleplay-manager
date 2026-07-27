/**
 * Department roster actions.
 *
 * Every action follows the same shape, and the shape is the point:
 *
 *   1. validate the input                          (Zod, again, server side)
 *   2. resolve every identifier to a real row      (no trusted IDs from the caller)
 *   3. authorize: capability + department scope + rank ceiling + level ceiling
 *   4. validate the domain rule                    (a promotion must go up, etc.)
 *   5. write the change, the membership event and the audit record in ONE transaction
 *   6. create the sync job in that same transaction
 *   7. enqueue after the commit, recording an issue if the queue is unavailable
 *
 * Steps 5-7 are handled by `runRosterMutation` so that no individual action can forget
 * its audit record or its synchronization.
 */
import { getPrisma, isUniqueViolation, notDeleted, toPage, toSkipTake } from '@frm/database';
import { createLogger } from '@frm/logging';
import {
  AuditAction,
  ConflictError,
  MembershipEventType,
  MembershipStatus,
  NotFoundError,
  PreconditionError,
  ValidationError,
} from '@frm/shared';
import { authorize, departmentScopeFilter } from '@frm/authorization';
import {
  changeCallsignSchema,
  demoteSchema,
  hireSchema,
  loaSchema,
  parseOrThrow,
  promoteSchema,
  reinstateSchema,
  removeMemberSchema,
  returnFromLoaSchema,
  rosterListSchema,
  suspendSchema,
  transferSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import {
  isSelf,
  resolveDepartment,
  resolveMembership,
  resolveOrCreateUser,
  resolveRank,
  resolveUser,
  rosterTarget,
} from './resolve.js';
import { createRosterChangeJob, enqueueSyncJob } from './sync-service.js';

const log = createLogger('core.roster');

/** Audit-safe snapshot of a membership. */
function membershipState(membership) {
  if (!membership) return null;
  return {
    id: membership.id,
    userId: membership.userId,
    departmentId: membership.departmentId,
    rankId: membership.rankId,
    rankName: membership.rank?.name,
    status: membership.status,
    callsign: membership.callsign,
    badgeNumber: membership.badgeNumber,
    isPrimary: membership.isPrimary,
  };
}

/**
 * Performs a roster mutation atomically and queues the resulting synchronization.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} params
 * @param {object} params.membership current membership row (may be null for a hire)
 * @param {(tx: object) => Promise<object>} params.mutate returns the updated membership
 * @param {string} params.auditAction
 * @param {string} params.eventType
 * @param {object} [params.eventData]
 * @param {string} params.reason
 * @param {string} params.userId
 * @param {string} params.departmentId
 */
async function runRosterMutation(ctx, params) {
  const prisma = ctx.prisma ?? getPrisma();

  const { membership, job } = await prisma.$transaction(async (tx) => {
    const updated = await params.mutate(tx);

    await tx.membershipEvent.create({
      data: {
        membershipId: updated.id,
        type: params.eventType,
        fromRankId: params.eventData?.fromRankId ?? null,
        toRankId: params.eventData?.toRankId ?? null,
        fromDepartment: params.eventData?.fromDepartment ?? null,
        toDepartment: params.eventData?.toDepartment ?? null,
        actorUserId: ctx.actor?.user?.id ?? null,
        actorDiscordId: ctx.actor?.discordUserId ?? null,
        reason: params.reason ?? null,
        metadata: params.eventData?.metadata ?? undefined,
      },
    });

    const syncJob = await createRosterChangeJob(tx, ctx, {
      userId: params.userId,
      departmentId: params.departmentId,
      reason: params.reason,
    });

    await recordAudit(tx, {
      ctx,
      action: params.auditAction,
      targetUserId: params.userId,
      targetDiscordId: params.targetDiscordId ?? null,
      departmentId: params.departmentId,
      syncJobId: syncJob.id,
      reason: params.reason,
      previousState: membershipState(params.membership),
      newState: membershipState(updated),
    });

    return { membership: updated, job: syncJob };
  });

  // Outside the transaction on purpose: a queue is not transactional, and a job that
  // ran before its data was visible would reconcile against stale state.
  const enqueueResult = await enqueueSyncJob(job, { prisma });

  return { membership, syncJob: job, enqueued: enqueueResult.enqueued };
}

/** Resolves the member a roster action targets and loads their membership. */
async function loadTarget(ctx, data, { requireMembership = true } = {}) {
  const department = await resolveDepartment(ctx, data.departmentId);
  const user = await resolveUser(ctx, data, { required: true });
  const membership = await resolveMembership(
    ctx,
    { userId: user.id, departmentId: department.id },
    { required: requireMembership },
  );
  return { department, user, membership };
}

// ---------------------------------------------------------------------------
// Hire
// ---------------------------------------------------------------------------

/** `/roster hire`. Creates the platform account if the Discord user is new. */
export async function hireMember(ctx, input) {
  const data = parseOrThrow(hireSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const department = await resolveDepartment(ctx, data.departmentId);
  const rank = await resolveRank(ctx, data.rankId, department.id);

  const existingUser = await resolveUser(ctx, data, { required: false });

  authorize(ctx.actor, {
    capability: 'roster.add',
    scope: { departmentId: department.id },
    target: {
      userId: existingUser?.id,
      permissionLevel: existingUser?.permissionLevel ?? 0,
      currentRankOrder: rank.order,
      resultingRankOrder: rank.order,
    },
  });

  const user =
    existingUser ??
    (await resolveOrCreateUser(ctx, { ...data, displayName: data.displayName }, prisma));

  const existing = await resolveMembership(
    ctx,
    { userId: user.id, departmentId: department.id },
    { required: false },
  );

  if (existing && existing.status !== MembershipStatus.TERMINATED) {
    throw new ConflictError(
      `That member is already on the ${department.abbreviation} roster with the status ${existing.status}.`,
    );
  }

  const isRehire = Boolean(existing);

  try {
    return await runRosterMutation(ctx, {
      membership: existing,
      userId: user.id,
      targetDiscordId: data.discordUserId ?? user.primaryDiscordId,
      departmentId: department.id,
      auditAction: AuditAction.ROSTER_HIRED,
      eventType: isRehire ? MembershipEventType.REHIRED : MembershipEventType.HIRED,
      eventData: { toRankId: rank.id, metadata: { callsign: data.callsign ?? null } },
      reason: data.reason,
      mutate: async (tx) => {
        const payload = {
          rankId: rank.id,
          status: MembershipStatus.ACTIVE,
          callsign: data.callsign ?? null,
          badgeNumber: data.badgeNumber ?? null,
          hireDate: data.hireDate ?? new Date(),
          rankDate: new Date(),
          notes: data.notes ?? null,
          statusUntil: null,
          statusReason: null,
          terminatedAt: null,
          deletedAt: null,
        };

        return existing
          ? tx.departmentMembership.update({
              where: { id: existing.id },
              data: payload,
              include: { rank: true, user: true, department: true },
            })
          : tx.departmentMembership.create({
              data: {
                userId: user.id,
                departmentId: department.id,
                ...payload,
                isPrimary: true,
              },
              include: { rank: true, user: true, department: true },
            });
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        `The callsign ${data.callsign} is already in use in ${department.abbreviation}.`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Rank changes
// ---------------------------------------------------------------------------

async function changeRank(ctx, input, { schema, direction, capability, auditAction, eventType }) {
  const data = parseOrThrow(schema, input);
  const { department, user, membership } = await loadTarget(ctx, data);
  const rank = await resolveRank(ctx, data.rankId, department.id);

  // Authorization runs before the domain rules on purpose: an actor who may not touch
  // this department must not learn its rank structure from the error message.
  authorize(ctx.actor, {
    capability,
    scope: { departmentId: department.id },
    target: rosterTarget(membership, rank),
  });

  if (membership.status === MembershipStatus.TERMINATED) {
    throw new PreconditionError('That member is not currently on the roster.');
  }

  if (direction === 'up' && rank.order <= membership.rank.order) {
    throw new ValidationError(
      `${rank.name} is not above ${membership.rank.name}. Use /roster demote to move a member down.`,
    );
  }
  if (direction === 'down' && rank.order >= membership.rank.order) {
    throw new ValidationError(
      `${rank.name} is not below ${membership.rank.name}. Use /roster promote to move a member up.`,
    );
  }

  return runRosterMutation(ctx, {
    membership,
    userId: user.id,
    targetDiscordId: user.primaryDiscordId,
    departmentId: department.id,
    auditAction,
    eventType,
    eventData: { fromRankId: membership.rankId, toRankId: rank.id },
    reason: data.reason,
    mutate: (tx) =>
      tx.departmentMembership.update({
        where: { id: membership.id },
        data: { rankId: rank.id, rankDate: new Date(), notes: data.notes ?? membership.notes },
        include: { rank: true, user: true, department: true },
      }),
  });
}

/** `/roster promote`. */
export async function promoteMember(ctx, input) {
  return changeRank(ctx, input, {
    schema: promoteSchema,
    direction: 'up',
    capability: 'roster.promote',
    auditAction: AuditAction.ROSTER_PROMOTED,
    eventType: MembershipEventType.PROMOTED,
  });
}

/** `/roster demote`. */
export async function demoteMember(ctx, input) {
  return changeRank(ctx, input, {
    schema: demoteSchema,
    direction: 'down',
    capability: 'roster.demote',
    auditAction: AuditAction.ROSTER_DEMOTED,
    eventType: MembershipEventType.DEMOTED,
  });
}

// ---------------------------------------------------------------------------
// Status changes
// ---------------------------------------------------------------------------

async function changeStatus(ctx, input, config) {
  const data = parseOrThrow(config.schema, input);
  const { department, user, membership } = await loadTarget(ctx, data);

  authorize(ctx.actor, {
    capability: config.capability,
    scope: { departmentId: department.id },
    target: rosterTarget(membership),
  });

  if (config.from && !config.from.includes(membership.status)) {
    throw new PreconditionError(config.fromError(membership));
  }

  return runRosterMutation(ctx, {
    membership,
    userId: user.id,
    targetDiscordId: user.primaryDiscordId,
    departmentId: department.id,
    auditAction: config.auditAction,
    eventType: config.eventType,
    eventData: { metadata: { until: data.until ?? null } },
    reason: data.reason,
    mutate: (tx) =>
      tx.departmentMembership.update({
        where: { id: membership.id },
        data: {
          status: config.status,
          statusUntil: data.until ?? null,
          statusReason: config.clearsStatusReason ? null : data.reason,
        },
        include: { rank: true, user: true, department: true },
      }),
  });
}

/** `/roster loa`. */
export async function placeOnLeave(ctx, input) {
  return changeStatus(ctx, input, {
    schema: loaSchema,
    capability: 'roster.loa',
    status: MembershipStatus.LOA,
    auditAction: AuditAction.ROSTER_LOA_STARTED,
    eventType: MembershipEventType.LOA_STARTED,
    from: [MembershipStatus.ACTIVE, MembershipStatus.INACTIVE],
    fromError: (membership) => `That member is currently ${membership.status}, not active.`,
  });
}

/** `/roster return`. */
export async function returnFromLeave(ctx, input) {
  return changeStatus(ctx, input, {
    schema: returnFromLoaSchema,
    capability: 'roster.loa',
    status: MembershipStatus.ACTIVE,
    auditAction: AuditAction.ROSTER_LOA_ENDED,
    eventType: MembershipEventType.LOA_ENDED,
    from: [MembershipStatus.LOA],
    fromError: () => 'That member is not currently on leave.',
    clearsStatusReason: true,
  });
}

/** `/roster suspend`. */
export async function suspendMember(ctx, input) {
  return changeStatus(ctx, input, {
    schema: suspendSchema,
    capability: 'roster.suspend',
    status: MembershipStatus.SUSPENDED,
    auditAction: AuditAction.ROSTER_SUSPENDED,
    eventType: MembershipEventType.SUSPENDED,
    from: [MembershipStatus.ACTIVE, MembershipStatus.LOA, MembershipStatus.INACTIVE],
    fromError: (membership) => `That member is already ${membership.status}.`,
  });
}

/** `/roster reinstate`. */
export async function reinstateMember(ctx, input) {
  return changeStatus(ctx, input, {
    schema: reinstateSchema,
    capability: 'roster.reinstate',
    status: MembershipStatus.ACTIVE,
    auditAction: AuditAction.ROSTER_REINSTATED,
    eventType: MembershipEventType.REINSTATED,
    from: [MembershipStatus.SUSPENDED],
    fromError: () => 'That member is not currently suspended.',
    clearsStatusReason: true,
  });
}

// ---------------------------------------------------------------------------
// Termination and transfer
// ---------------------------------------------------------------------------

/**
 * `/roster remove`. The membership row is kept (status TERMINATED) so the history in
 * `membership_events` stays attached; the callsign is released for reuse.
 */
export async function removeMember(ctx, input) {
  const data = parseOrThrow(removeMemberSchema, input);
  const { department, user, membership } = await loadTarget(ctx, data);

  authorize(ctx.actor, {
    capability: 'roster.remove',
    scope: { departmentId: department.id },
    target: rosterTarget(membership),
  });

  if (membership.status === MembershipStatus.TERMINATED) {
    throw new PreconditionError('That member has already been removed from this roster.');
  }

  return runRosterMutation(ctx, {
    membership,
    userId: user.id,
    targetDiscordId: user.primaryDiscordId,
    departmentId: department.id,
    auditAction: AuditAction.ROSTER_REMOVED,
    eventType: MembershipEventType.TERMINATED,
    eventData: {
      fromRankId: membership.rankId,
      metadata: { releasedCallsign: membership.callsign },
    },
    reason: data.reason,
    mutate: (tx) =>
      tx.departmentMembership.update({
        where: { id: membership.id },
        data: {
          status: MembershipStatus.TERMINATED,
          terminatedAt: new Date(),
          callsign: null,
          statusUntil: null,
          statusReason: data.reason,
          notes: data.notes ?? membership.notes,
        },
        include: { rank: true, user: true, department: true },
      }),
  });
}

/**
 * `/roster transfer`.
 *
 * Authorized against BOTH departments: moving somebody out of a department you do not
 * control, or into one you do not control, are each their own privilege problem.
 */
export async function transferMember(ctx, input) {
  const data = parseOrThrow(transferSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const fromDepartment = await resolveDepartment(ctx, data.departmentId);
  const toDepartment = await resolveDepartment(ctx, data.targetDepartmentId);
  if (fromDepartment.id === toDepartment.id) {
    throw new ValidationError('The source and destination departments are the same.');
  }

  const user = await resolveUser(ctx, data);
  const membership = await resolveMembership(ctx, {
    userId: user.id,
    departmentId: fromDepartment.id,
  });
  const targetRank = await resolveRank(ctx, data.targetRankId, toDepartment.id);

  authorize(ctx.actor, {
    capability: 'roster.transfer',
    scope: { departmentId: fromDepartment.id },
    target: rosterTarget(membership),
  });
  authorize(ctx.actor, {
    capability: 'roster.transfer',
    scope: { departmentId: toDepartment.id },
    target: {
      userId: user.id,
      permissionLevel: user.permissionLevel,
      currentRankOrder: targetRank.order,
      resultingRankOrder: targetRank.order,
    },
  });

  if (membership.status === MembershipStatus.TERMINATED) {
    throw new PreconditionError('That member is not currently on the source roster.');
  }

  const existingTarget = await resolveMembership(
    ctx,
    { userId: user.id, departmentId: toDepartment.id },
    { required: false },
  );
  if (existingTarget && existingTarget.status !== MembershipStatus.TERMINATED) {
    throw new ConflictError(`That member is already on the ${toDepartment.abbreviation} roster.`);
  }

  const result = await prisma.$transaction(async (tx) => {
    const closed = await tx.departmentMembership.update({
      where: { id: membership.id },
      data: {
        status: MembershipStatus.TERMINATED,
        terminatedAt: new Date(),
        callsign: null,
        statusReason: `Transferred to ${toDepartment.abbreviation}`,
      },
      include: { rank: true, user: true, department: true },
    });

    await tx.membershipEvent.create({
      data: {
        membershipId: closed.id,
        type: MembershipEventType.TRANSFERRED_OUT,
        fromRankId: membership.rankId,
        fromDepartment: fromDepartment.key,
        toDepartment: toDepartment.key,
        actorUserId: ctx.actor?.user?.id ?? null,
        actorDiscordId: ctx.actor?.discordUserId ?? null,
        reason: data.reason,
      },
    });

    const payload = {
      rankId: targetRank.id,
      status: MembershipStatus.ACTIVE,
      callsign: data.keepCallsign ? membership.callsign : null,
      hireDate: new Date(),
      rankDate: new Date(),
      terminatedAt: null,
      statusUntil: null,
      statusReason: null,
      notes: data.notes ?? null,
      deletedAt: null,
    };

    const opened = existingTarget
      ? await tx.departmentMembership.update({
          where: { id: existingTarget.id },
          data: payload,
          include: { rank: true, user: true, department: true },
        })
      : await tx.departmentMembership.create({
          data: { userId: user.id, departmentId: toDepartment.id, ...payload },
          include: { rank: true, user: true, department: true },
        });

    await tx.membershipEvent.create({
      data: {
        membershipId: opened.id,
        type: MembershipEventType.TRANSFERRED_IN,
        toRankId: targetRank.id,
        fromDepartment: fromDepartment.key,
        toDepartment: toDepartment.key,
        actorUserId: ctx.actor?.user?.id ?? null,
        actorDiscordId: ctx.actor?.discordUserId ?? null,
        reason: data.reason,
      },
    });

    const syncJob = await createRosterChangeJob(tx, ctx, {
      userId: user.id,
      departmentId: toDepartment.id,
      reason: data.reason,
    });

    await recordAudit(tx, {
      ctx,
      action: AuditAction.ROSTER_TRANSFERRED,
      targetUserId: user.id,
      targetDiscordId: user.primaryDiscordId,
      departmentId: toDepartment.id,
      syncJobId: syncJob.id,
      reason: data.reason,
      previousState: membershipState(membership),
      newState: membershipState(opened),
    });

    return { from: closed, to: opened, syncJob };
  });

  await enqueueSyncJob(result.syncJob, { prisma });

  log.info(
    { userId: user.id, from: fromDepartment.key, to: toDepartment.key },
    'member transferred',
  );
  return { membership: result.to, previous: result.from, syncJob: result.syncJob };
}

/** `/roster callsign`. */
export async function changeCallsign(ctx, input) {
  const data = parseOrThrow(changeCallsignSchema, input);
  const { department, user, membership } = await loadTarget(ctx, data);

  authorize(ctx.actor, {
    capability: 'roster.callsign',
    scope: { departmentId: department.id },
    target: rosterTarget(membership),
  });

  try {
    return await runRosterMutation(ctx, {
      membership,
      userId: user.id,
      targetDiscordId: user.primaryDiscordId,
      departmentId: department.id,
      auditAction: AuditAction.ROSTER_CALLSIGN_CHANGED,
      eventType: MembershipEventType.CALLSIGN_CHANGED,
      eventData: { metadata: { from: membership.callsign, to: data.callsign } },
      reason: data.reason,
      mutate: (tx) =>
        tx.departmentMembership.update({
          where: { id: membership.id },
          data: { callsign: data.callsign },
          include: { rank: true, user: true, department: true },
        }),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        `The callsign ${data.callsign} is already in use in ${department.abbreviation}.`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Department roster listing, constrained to the actor's scope. */
export async function listRoster(ctx, input) {
  const query = parseOrThrow(rosterListSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  authorize(ctx.actor, {
    capability: 'roster.view',
    scope: { departmentId: query.departmentId },
    allowSelf: true,
  });

  const allowedDepartments = departmentScopeFilter(ctx.actor, 'roster.view');

  /** @type {object} */
  const where = { ...notDeleted };
  if (query.departmentId) where.departmentId = query.departmentId;
  else if (allowedDepartments !== null) where.departmentId = { in: allowedDepartments };

  if (query.status) where.status = query.status;
  else where.status = { not: MembershipStatus.TERMINATED };

  if (query.rankId) where.rankId = query.rankId;
  if (query.search) {
    where.OR = [
      { callsign: { contains: query.search, mode: 'insensitive' } },
      { user: { displayName: { contains: query.search, mode: 'insensitive' } } },
    ];
  }
  if (query.subdivisionId) {
    where.user = {
      ...(where.user ?? {}),
      subdivisions: { some: { subdivisionId: query.subdivisionId, leftAt: null } },
    };
  }

  const orderBy =
    query.sortBy === 'rankOrder'
      ? [{ rank: { order: query.sortDir } }, { callsign: 'asc' }]
      : [{ [query.sortBy]: query.sortDir }];

  const [items, total] = await Promise.all([
    prisma.departmentMembership.findMany({
      where,
      orderBy,
      ...toSkipTake(query),
      include: {
        user: { select: { id: true, displayName: true, primaryDiscordId: true } },
        rank: {
          select: { id: true, name: true, order: true, isSupervisor: true, isCommand: true },
        },
        department: { select: { id: true, key: true, abbreviation: true } },
      },
    }),
    prisma.departmentMembership.count({ where }),
  ]);

  return toPage(items, total, query);
}

/** Full membership history for `/member history`. */
export async function getMembershipHistory(ctx, { userId, departmentId, limit = 50 }) {
  const prisma = ctx.prisma ?? getPrisma();
  const user = await resolveUser(ctx, { userId }, { required: true });

  if (!isSelf(ctx, user.id)) {
    authorize(ctx.actor, {
      capability: 'roster.view',
      scope: { departmentId },
      target: { userId: user.id },
    });
  }

  const memberships = await prisma.departmentMembership.findMany({
    where: { userId: user.id, ...(departmentId ? { departmentId } : {}) },
    select: { id: true },
  });
  if (memberships.length === 0) throw new NotFoundError('Membership', userId);

  return prisma.membershipEvent.findMany({
    where: { membershipId: { in: memberships.map((m) => m.id) } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
    include: {
      fromRank: { select: { name: true } },
      toRank: { select: { name: true } },
      actor: { select: { id: true, displayName: true } },
      membership: { select: { department: { select: { key: true, abbreviation: true } } } },
    },
  });
}
