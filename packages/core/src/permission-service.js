/**
 * Permission administration.
 *
 * The escalation rules live in `@frm/authorization/grants`; this module resolves the
 * identifiers, verifies the scope target actually exists, and records the audit trail.
 * Keeping the rules separate from the plumbing is what makes them straightforward to
 * test exhaustively.
 */
import { currentlyEffective, getPrisma, notDeleted, toPage, toSkipTake } from '@frm/database';
import { createLogger } from '@frm/logging';
import {
  AuditAction,
  ConflictError,
  NotFoundError,
  PermissionScopeType,
  ValidationError,
  getCapability,
} from '@frm/shared';
import { assertCanGrant, assertCanRevoke } from '@frm/authorization';
import {
  grantPermissionSchema,
  listPermissionsSchema,
  parseOrThrow,
  revokePermissionSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { authorizeAnyScope, resolveUser } from './resolve.js';

const log = createLogger('core.permission');

/** Verifies that a scope id refers to a real approved guild. */
async function assertScopeExists(prisma, scopeType, scopeId) {
  if (scopeType === PermissionScopeType.GLOBAL) return;
  if (scopeType !== PermissionScopeType.GUILD) {
    throw new ValidationError(`Unknown scope type: ${scopeType}`);
  }
  const row = await prisma.approvedGuild.findFirst({ where: { id: scopeId, ...notDeleted } });
  if (!row) throw new NotFoundError('Guild', scopeId);
}

/** `/permissions grant`. */
export async function grantPermission(ctx, input) {
  const data = parseOrThrow(grantPermissionSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const targetUser = await resolveUser(ctx, data);
  const scopeId = data.scopeType === PermissionScopeType.GLOBAL ? '' : data.scopeId;
  await assertScopeExists(prisma, data.scopeType, scopeId);

  const capability = getCapability(data.capability);
  if (targetUser.permissionLevel < capability.minLevel) {
    throw new ValidationError(
      `${capability.key} requires authority level ${capability.minLevel}; that member is at ${targetUser.permissionLevel}. ` +
        'Raise their authority level first.',
    );
  }

  // All of the anti-escalation rules.
  assertCanGrant(ctx.actor, {
    capability: data.capability,
    scopeType: data.scopeType,
    scopeId,
    maxPermissionLevel: data.maxPermissionLevel,
    targetUser: { id: targetUser.id, permissionLevel: targetUser.permissionLevel },
  });

  const existing = await prisma.permissionAssignment.findUnique({
    where: {
      userId_capabilityKey_scopeType_scopeId: {
        userId: targetUser.id,
        capabilityKey: data.capability,
        scopeType: data.scopeType,
        scopeId,
      },
    },
  });
  if (existing && !existing.revokedAt) {
    throw new ConflictError('That member already has this permission in this scope.');
  }

  const assignment = await prisma.$transaction(async (tx) => {
    const row = existing
      ? await tx.permissionAssignment.update({
          where: { id: existing.id },
          data: {
            revokedAt: null,
            revokedById: null,
            grantedAt: new Date(),
            grantedById: ctx.actor?.user?.id ?? null,
            maxPermissionLevel: data.maxPermissionLevel ?? null,
            expiresAt: data.expiresAt ?? null,
            reason: data.reason,
          },
        })
      : await tx.permissionAssignment.create({
          data: {
            userId: targetUser.id,
            capabilityKey: data.capability,
            scopeType: data.scopeType,
            scopeId,
            maxPermissionLevel: data.maxPermissionLevel ?? null,
            expiresAt: data.expiresAt ?? null,
            grantedById: ctx.actor?.user?.id ?? null,
            reason: data.reason,
          },
        });

    await recordAudit(tx, {
      ctx,
      action: AuditAction.PERMISSION_GRANTED,
      targetUserId: targetUser.id,
      targetDiscordId: targetUser.primaryDiscordId,
      approvedGuildId: data.scopeType === PermissionScopeType.GUILD ? scopeId : null,
      reason: data.reason,
      newState: {
        capability: data.capability,
        scopeType: data.scopeType,
        scopeId,
        maxPermissionLevel: data.maxPermissionLevel ?? null,
      },
    });

    return row;
  });

  log.info(
    { targetUserId: targetUser.id, capability: data.capability, scopeType: data.scopeType },
    'permission granted',
  );
  return assignment;
}

/** `/permissions revoke`. */
export async function revokePermission(ctx, input) {
  const data = parseOrThrow(revokePermissionSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const assignment = await prisma.permissionAssignment.findUnique({
    where: { id: data.assignmentId },
    include: { user: true },
  });
  if (!assignment || assignment.revokedAt) {
    throw new NotFoundError('Permission assignment', data.assignmentId);
  }

  assertCanRevoke(ctx.actor, {
    capabilityKey: assignment.capabilityKey,
    scopeType: assignment.scopeType,
    scopeId: assignment.scopeId,
    user: { id: assignment.userId, permissionLevel: assignment.user.permissionLevel },
  });

  return prisma.$transaction(async (tx) => {
    const row = await tx.permissionAssignment.update({
      where: { id: assignment.id },
      data: { revokedAt: new Date(), revokedById: ctx.actor?.user?.id ?? null },
    });

    await recordAudit(tx, {
      ctx,
      action: AuditAction.PERMISSION_REVOKED,
      targetUserId: assignment.userId,
      targetDiscordId: assignment.user.primaryDiscordId,
      approvedGuildId:
        assignment.scopeType === PermissionScopeType.GUILD ? assignment.scopeId : null,
      reason: data.reason,
      previousState: {
        capability: assignment.capabilityKey,
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
      },
      newState: { revoked: true },
    });

    return row;
  });
}

/** `/permissions view`. */
export async function listPermissions(ctx, input = {}) {
  const query = parseOrThrow(listPermissionsSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const target =
    query.userId || query.discordUserId ? await resolveUser(ctx, query, { required: true }) : null;

  authorizeAnyScope(ctx, 'permission.view', {
    target: target ? { userId: target.id } : {},
    allowSelf: true,
  });

  /** @type {object} */
  const where = { ...currentlyEffective() };
  if (target) where.userId = target.id;
  if (query.capability) where.capabilityKey = query.capability;

  const [items, total] = await Promise.all([
    prisma.permissionAssignment.findMany({
      where,
      orderBy: { grantedAt: 'desc' },
      ...toSkipTake(query),
      include: {
        user: {
          select: { id: true, displayName: true, primaryDiscordId: true, permissionLevel: true },
        },
        capability: { select: { key: true, description: true, dangerous: true } },
        grantedBy: { select: { id: true, displayName: true } },
      },
    }),
    prisma.permissionAssignment.count({ where }),
  ]);

  // Scope ids are opaque UUIDs; resolve them to names so the output is readable.
  const decorated = await decorateScopes(prisma, items);
  return toPage(decorated, total, query);
}

async function decorateScopes(prisma, assignments) {
  const guildIds = assignments
    .filter((a) => a.scopeType === PermissionScopeType.GUILD)
    .map((a) => a.scopeId);

  const guilds = guildIds.length
    ? await prisma.approvedGuild.findMany({
        where: { id: { in: guildIds } },
        select: { id: true, name: true },
      })
    : [];

  const names = new Map(guilds.map((row) => [row.id, `${row.name} (guild)`]));

  return assignments.map((assignment) => ({
    ...assignment,
    scopeLabel:
      assignment.scopeType === PermissionScopeType.GLOBAL
        ? 'Global'
        : (names.get(assignment.scopeId) ?? assignment.scopeId),
  }));
}

/** The capability catalogue, for building select menus and dashboard forms. */
export async function listCapabilities(ctx) {
  authorizeAnyScope(ctx, 'permission.view', { allowSelf: true });
  const prisma = ctx.prisma ?? getPrisma();
  return prisma.permissionCapability.findMany({ orderBy: [{ category: 'asc' }, { key: 'asc' }] });
}
