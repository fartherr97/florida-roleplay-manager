/**
 * Two-person approval.
 *
 * When a mapping touches a role marked `TWO_PERSON`, creating it produces a
 * `PendingApproval` and the mapping stays disabled. This module is the other half of
 * that: it lets a *different* authorized administrator sign off, which is the entire
 * point - an approval the requester can grant themselves is not a control.
 */
import { getPrisma } from '@frm/database';
import { createLogger } from '@frm/logging';
import {
  AuditAction,
  ConflictError,
  NotFoundError,
  PendingApprovalStatus,
  PendingApprovalType,
  PreconditionError,
  SelfManagementError,
} from '@frm/shared';
import { authorize } from '@frm/authorization';
import { recordAudit } from './audit-service.js';

const log = createLogger('core.approval');

/** Approvals still awaiting a decision. */
export async function listPendingApprovals(ctx, { includeExpired = false } = {}) {
  const prisma = ctx.prisma ?? getPrisma();
  authorize(ctx.actor, { capability: 'mapping.approve', scope: {} });

  return prisma.pendingApproval.findMany({
    where: {
      status: PendingApprovalStatus.PENDING,
      ...(includeExpired ? {} : { expiresAt: { gt: new Date() } }),
    },
    orderBy: { requestedAt: 'asc' },
    include: {
      requestedBy: { select: { id: true, displayName: true } },
      mapping: {
        select: {
          id: true,
          name: true,
          sourceRoleId: true,
          targetRoleId: true,
          sourceGuild: { select: { name: true } },
          targetGuild: { select: { name: true } },
        },
      },
      votes: true,
    },
  });
}

async function loadApproval(ctx, approvalId) {
  const prisma = ctx.prisma ?? getPrisma();
  const approval = await prisma.pendingApproval.findUnique({
    where: { id: approvalId },
    include: { votes: true, mapping: true },
  });
  if (!approval) throw new NotFoundError('Approval request', approvalId);

  if (approval.status !== PendingApprovalStatus.PENDING) {
    throw new PreconditionError(`That request has already been ${approval.status.toLowerCase()}.`);
  }
  if (approval.expiresAt < new Date()) {
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { status: PendingApprovalStatus.EXPIRED },
    });
    throw new PreconditionError('That approval request has expired. Create the mapping again.');
  }

  // The capability the request itself demands, checked against the approver.
  authorize(ctx.actor, { capability: approval.requiredCapability, scope: {} });

  // The two-person rule: the person who asked cannot be the person who approves.
  if (approval.requestedById && approval.requestedById === ctx.actor?.user?.id) {
    throw new SelfManagementError('approve a request raised by');
  }

  return approval;
}

/**
 * Casts an approval vote. Once enough distinct approvers have signed off, the change
 * the request describes is applied.
 */
export async function approvePending(ctx, { approvalId, comment }) {
  const prisma = ctx.prisma ?? getPrisma();
  const approval = await loadApproval(ctx, approvalId);

  const alreadyVoted = approval.votes.some((vote) => vote.userId === ctx.actor.user.id);
  if (alreadyVoted) throw new ConflictError('You have already voted on this request.');

  const approvals = approval.votes.filter((vote) => vote.approve).length + 1;
  const satisfied = approvals >= approval.requiredApprovals;

  const result = await prisma.$transaction(async (tx) => {
    await tx.pendingApprovalVote.create({
      data: { approvalId: approval.id, userId: ctx.actor.user.id, approve: true, comment },
    });

    if (!satisfied) {
      return { approval, applied: false, approvals };
    }

    const updated = await tx.pendingApproval.update({
      where: { id: approval.id },
      data: {
        status: PendingApprovalStatus.APPROVED,
        resolvedAt: new Date(),
        resolvedById: ctx.actor.user.id,
      },
    });

    // Applying the request. Approval marks the mapping as signed off; enabling it still
    // goes through `setMappingEnabled`, which re-validates against live Discord.
    if (
      approval.mappingId &&
      (approval.type === PendingApprovalType.PROTECTED_ROLE_MAPPING ||
        approval.type === PendingApprovalType.MAPPING_ACTIVATION)
    ) {
      await tx.roleMapping.update({
        where: { id: approval.mappingId },
        data: { approvedAt: new Date() },
      });
    }

    await recordAudit(tx, {
      ctx,
      action: AuditAction.APPROVAL_APPROVED,
      mappingId: approval.mappingId,
      reason: comment,
      previousState: { status: PendingApprovalStatus.PENDING },
      newState: { status: PendingApprovalStatus.APPROVED, approvals },
    });

    return { approval: updated, applied: true, approvals };
  });

  log.info(
    { approvalId, approver: ctx.actor.user.id, applied: result.applied },
    'approval vote recorded',
  );
  return result;
}

/** Rejects a request outright. */
export async function rejectPending(ctx, { approvalId, reason }) {
  const prisma = ctx.prisma ?? getPrisma();
  const approval = await loadApproval(ctx, approvalId);

  return prisma.$transaction(async (tx) => {
    await tx.pendingApprovalVote.create({
      data: {
        approvalId: approval.id,
        userId: ctx.actor.user.id,
        approve: false,
        comment: reason,
      },
    });

    const updated = await tx.pendingApproval.update({
      where: { id: approval.id },
      data: {
        status: PendingApprovalStatus.REJECTED,
        resolvedAt: new Date(),
        resolvedById: ctx.actor.user.id,
        resolutionReason: reason,
      },
    });

    await recordAudit(tx, {
      ctx,
      action: AuditAction.APPROVAL_REJECTED,
      mappingId: approval.mappingId,
      reason,
      previousState: { status: PendingApprovalStatus.PENDING },
      newState: { status: PendingApprovalStatus.REJECTED },
    });

    return updated;
  });
}
