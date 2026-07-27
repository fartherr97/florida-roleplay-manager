/**
 * Certifications and subdivisions.
 *
 * Both are roster-authoritative: the database decides who holds them, and the
 * reconciliation engine makes Discord match. Both therefore queue a member resync on
 * every change, in the same transaction as the change itself.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { AuditAction, ConflictError, NotFoundError, PreconditionError } from '@frm/shared';
import { authorize } from '@frm/authorization';
import {
  assignCertificationSchema,
  parseOrThrow,
  removeCertificationSchema,
  subdivisionMembershipSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { isSelf, resolveUser } from './resolve.js';
import { createRosterChangeJob, enqueueSyncJob } from './sync-service.js';

/**
 * Shared tail for every qualification change: audit, sync job, enqueue after commit.
 */
async function withSync(
  ctx,
  { userId, departmentId, reason, auditAction, previousState, newState, mutate },
) {
  const prisma = ctx.prisma ?? getPrisma();

  const { record, job } = await prisma.$transaction(async (tx) => {
    const row = await mutate(tx);
    const syncJob = await createRosterChangeJob(tx, ctx, { userId, departmentId, reason });
    await recordAudit(tx, {
      ctx,
      action: auditAction,
      targetUserId: userId,
      departmentId: departmentId ?? null,
      syncJobId: syncJob.id,
      reason,
      previousState,
      newState,
    });
    return { record: row, job: syncJob };
  });

  await enqueueSyncJob(job, { prisma });
  return { record, syncJob: job };
}

/** Loads a certification and the department scope it should be authorized against. */
async function loadCertification(ctx, certificationId) {
  const prisma = ctx.prisma ?? getPrisma();
  const certification = await prisma.certification.findFirst({
    where: { id: certificationId, ...notDeleted },
  });
  if (!certification) throw new NotFoundError('Certification', certificationId);
  return certification;
}

/** `/certification assign`. */
export async function assignCertification(ctx, input) {
  const data = parseOrThrow(assignCertificationSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const certification = await loadCertification(ctx, data.certificationId);
  const user = await resolveUser(ctx, data);

  authorize(ctx.actor, {
    capability: 'certification.assign',
    scope: { departmentId: certification.departmentId ?? undefined },
    target: { userId: user.id, permissionLevel: user.permissionLevel },
  });

  // A department-scoped certification only makes sense for a member of that department.
  if (certification.departmentId) {
    const membership = await prisma.departmentMembership.findFirst({
      where: { userId: user.id, departmentId: certification.departmentId, ...notDeleted },
    });
    if (!membership) {
      throw new PreconditionError(
        'That member is not on the roster of the department this certification belongs to.',
      );
    }
  }

  const existing = await prisma.memberCertification.findUnique({
    where: { userId_certificationId: { userId: user.id, certificationId: certification.id } },
  });
  if (existing && !existing.revokedAt) {
    throw new ConflictError(`That member already holds ${certification.name}.`);
  }

  const expiresAt =
    data.expiresAt ??
    (certification.expiresAfterDays
      ? new Date(Date.now() + certification.expiresAfterDays * 24 * 60 * 60 * 1000)
      : null);

  return withSync(ctx, {
    userId: user.id,
    departmentId: certification.departmentId,
    reason: data.reason,
    auditAction: AuditAction.CERTIFICATION_ASSIGNED,
    previousState: existing ? { revokedAt: existing.revokedAt } : null,
    newState: { certificationId: certification.id, expiresAt },
    mutate: (tx) =>
      existing
        ? tx.memberCertification.update({
            where: { id: existing.id },
            data: {
              revokedAt: null,
              revokedById: null,
              issuedAt: new Date(),
              expiresAt,
              issuedById: ctx.actor?.user?.id ?? null,
              reason: data.reason,
            },
          })
        : tx.memberCertification.create({
            data: {
              userId: user.id,
              certificationId: certification.id,
              expiresAt,
              issuedById: ctx.actor?.user?.id ?? null,
              reason: data.reason,
            },
          }),
  });
}

/** `/certification remove`. Revoked rather than deleted, so the history survives. */
export async function removeCertification(ctx, input) {
  const data = parseOrThrow(removeCertificationSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const certification = await loadCertification(ctx, data.certificationId);
  const user = await resolveUser(ctx, data);

  authorize(ctx.actor, {
    capability: 'certification.remove',
    scope: { departmentId: certification.departmentId ?? undefined },
    target: { userId: user.id, permissionLevel: user.permissionLevel },
  });

  const existing = await prisma.memberCertification.findUnique({
    where: { userId_certificationId: { userId: user.id, certificationId: certification.id } },
  });
  if (!existing || existing.revokedAt) {
    throw new NotFoundError('Certification assignment', `${user.id}/${certification.id}`);
  }

  return withSync(ctx, {
    userId: user.id,
    departmentId: certification.departmentId,
    reason: data.reason,
    auditAction: AuditAction.CERTIFICATION_REMOVED,
    previousState: { certificationId: certification.id, issuedAt: existing.issuedAt },
    newState: { revoked: true },
    mutate: (tx) =>
      tx.memberCertification.update({
        where: { id: existing.id },
        data: {
          revokedAt: new Date(),
          revokedById: ctx.actor?.user?.id ?? null,
          reason: data.reason,
        },
      }),
  });
}

/** `/certification list` - the catalogue, optionally filtered to one department. */
export async function listCertifications(ctx, { departmentId } = {}) {
  const prisma = ctx.prisma ?? getPrisma();
  authorize(ctx.actor, { capability: 'roster.view', scope: { departmentId }, allowSelf: true });

  return prisma.certification.findMany({
    where: {
      ...notDeleted,
      ...(departmentId ? { OR: [{ departmentId }, { departmentId: null }] } : {}),
    },
    orderBy: { name: 'asc' },
    include: {
      department: { select: { id: true, abbreviation: true } },
      _count: { select: { members: true } },
    },
  });
}

/** The certifications one member currently holds. */
export async function listMemberCertifications(ctx, { userId }) {
  const prisma = ctx.prisma ?? getPrisma();
  const user = await resolveUser(ctx, { userId });

  if (!isSelf(ctx, user.id)) {
    authorize(ctx.actor, {
      capability: 'roster.view',
      scope: {},
      target: { userId: user.id },
    });
  }

  return prisma.memberCertification.findMany({
    where: { userId: user.id, revokedAt: null },
    include: { certification: true },
    orderBy: { issuedAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// Subdivisions
// ---------------------------------------------------------------------------

async function loadSubdivision(ctx, subdivisionId) {
  const prisma = ctx.prisma ?? getPrisma();
  const subdivision = await prisma.subdivision.findFirst({
    where: { id: subdivisionId, ...notDeleted },
  });
  if (!subdivision) throw new NotFoundError('Subdivision', subdivisionId);
  return subdivision;
}

/** Adds a member to a subdivision. */
export async function addToSubdivision(ctx, input) {
  const data = parseOrThrow(subdivisionMembershipSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const subdivision = await loadSubdivision(ctx, data.subdivisionId);
  const user = await resolveUser(ctx, data);

  authorize(ctx.actor, {
    capability: 'subdivision.assign',
    scope: { departmentId: subdivision.departmentId, subdivisionId: subdivision.id },
    target: { userId: user.id, permissionLevel: user.permissionLevel },
  });

  const membership = await prisma.departmentMembership.findFirst({
    where: { userId: user.id, departmentId: subdivision.departmentId, ...notDeleted },
  });
  if (!membership) {
    throw new PreconditionError(
      'That member is not on the roster of the department this subdivision belongs to.',
    );
  }

  const existing = await prisma.memberSubdivision.findUnique({
    where: { userId_subdivisionId: { userId: user.id, subdivisionId: subdivision.id } },
  });
  if (existing && !existing.leftAt) {
    throw new ConflictError(`That member is already in ${subdivision.name}.`);
  }

  return withSync(ctx, {
    userId: user.id,
    departmentId: subdivision.departmentId,
    reason: data.reason,
    auditAction: AuditAction.SUBDIVISION_ADDED,
    previousState: null,
    newState: { subdivisionId: subdivision.id },
    mutate: (tx) =>
      existing
        ? tx.memberSubdivision.update({
            where: { id: existing.id },
            data: { leftAt: null, joinedAt: new Date(), addedById: ctx.actor?.user?.id ?? null },
          })
        : tx.memberSubdivision.create({
            data: {
              userId: user.id,
              subdivisionId: subdivision.id,
              addedById: ctx.actor?.user?.id ?? null,
            },
          }),
  });
}

/** Removes a member from a subdivision. */
export async function removeFromSubdivision(ctx, input) {
  const data = parseOrThrow(subdivisionMembershipSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const subdivision = await loadSubdivision(ctx, data.subdivisionId);
  const user = await resolveUser(ctx, data);

  authorize(ctx.actor, {
    capability: 'subdivision.remove',
    scope: { departmentId: subdivision.departmentId, subdivisionId: subdivision.id },
    target: { userId: user.id, permissionLevel: user.permissionLevel },
  });

  const existing = await prisma.memberSubdivision.findUnique({
    where: { userId_subdivisionId: { userId: user.id, subdivisionId: subdivision.id } },
  });
  if (!existing || existing.leftAt) {
    throw new NotFoundError('Subdivision membership', `${user.id}/${subdivision.id}`);
  }

  return withSync(ctx, {
    userId: user.id,
    departmentId: subdivision.departmentId,
    reason: data.reason,
    auditAction: AuditAction.SUBDIVISION_REMOVED,
    previousState: { subdivisionId: subdivision.id, joinedAt: existing.joinedAt },
    newState: { left: true },
    mutate: (tx) =>
      tx.memberSubdivision.update({ where: { id: existing.id }, data: { leftAt: new Date() } }),
  });
}
