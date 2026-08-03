/**
 * Community members.
 *
 * The Discord user ID is the external identity, but a member is one platform account
 * spanning every approved guild - never one account per guild. Linking is a privileged
 * action because a wrong link hands somebody else's roles, grants and history to the
 * wrong Discord account.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger } from '@frm/logging';
import { AuditAction, ConflictError, NotFoundError, PreconditionError } from '@frm/shared';
import { authorize } from '@frm/authorization';
import {
  linkMemberSchema,
  listMembersSchema,
  memberLookupSchema,
  parseOrThrow,
  unlinkMemberSchema,
} from '@frm/validation';
import { currentlyEffective, toPage, toSkipTake } from '@frm/database';
import { recordAudit } from './audit-service.js';
import { authorizeAnyScope, isSelf, resolveUser } from './resolve.js';

const log = createLogger('core.member');

/**
 * `/member lookup`.
 *
 * Returns the full picture: linked Discord accounts, active manual grants, permission
 * assignments and open synchronization issues.
 */
export async function lookupMember(ctx, input) {
  const query = parseOrThrow(memberLookupSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const user = await resolveUser(ctx, query, { required: false });
  if (!user) throw new NotFoundError('Member', query.discordUserId ?? query.userId);

  if (!isSelf(ctx, user.id)) {
    authorizeAnyScope(ctx, 'member.view', { target: { userId: user.id } });
  }

  const [identities, grants, permissions, openIssues] = await Promise.all([
    prisma.discordIdentity.findMany({ where: { userId: user.id } }),
    prisma.manualRoleGrant.findMany({
      where: { userId: user.id, ...currentlyEffective() },
      include: {
        managedRole: {
          select: {
            id: true,
            name: true,
            discordRoleId: true,
            guild: { select: { id: true, name: true } },
          },
        },
      },
    }),
    prisma.permissionAssignment.findMany({
      where: { userId: user.id, revokedAt: null },
      select: {
        id: true,
        capabilityKey: true,
        scopeType: true,
        scopeId: true,
        maxPermissionLevel: true,
        expiresAt: true,
      },
    }),
    prisma.syncIssue.count({ where: { userId: user.id, resolved: false } }),
  ]);

  return {
    user: {
      id: user.id,
      displayName: user.displayName,
      status: user.status,
      permissionLevel: user.permissionLevel,
      websiteAccess: user.websiteAccess,
      primaryDiscordId: user.primaryDiscordId,
      createdAt: user.createdAt,
    },
    identities,
    grants,
    permissions,
    openIssues,
  };
}

/** Paginated member directory. */
export async function listMembers(ctx, input = {}) {
  const query = parseOrThrow(listMembersSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  authorizeAnyScope(ctx, 'member.view');

  /** @type {object} */
  const where = { ...notDeleted };
  if (typeof query.websiteAccess === 'boolean') where.websiteAccess = query.websiteAccess;
  if (query.search) {
    where.OR = [
      { displayName: { contains: query.search, mode: 'insensitive' } },
      { primaryDiscordId: { contains: query.search } },
    ];
  }

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { [query.sortBy]: query.sortDir },
      ...toSkipTake(query),
      select: {
        id: true,
        displayName: true,
        primaryDiscordId: true,
        permissionLevel: true,
        websiteAccess: true,
        status: true,
        createdAt: true,
        _count: { select: { manualGrants: true, permissions: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  return toPage(items, total, query);
}

/**
 * `/member link`.
 *
 * Two shapes: linking a brand new Discord account to an existing platform user, or
 * creating a platform user for a Discord account that has never been seen.
 */
export async function linkMember(ctx, input) {
  const data = parseOrThrow(linkMemberSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  authorize(ctx.actor, { capability: 'member.link', scope: {} });

  const existingIdentity = await prisma.discordIdentity.findUnique({
    where: { discordUserId: data.discordUserId },
    include: { user: true },
  });

  if (existingIdentity) {
    if (!data.userId || existingIdentity.userId === data.userId) {
      throw new ConflictError(
        `That Discord account is already linked to ${existingIdentity.user.displayName}.`,
      );
    }
    throw new ConflictError(
      'That Discord account is linked to a different member. Unlink it first.',
    );
  }

  const targetUser = data.userId
    ? await resolveUser(ctx, { userId: data.userId }, { required: true })
    : null;

  const result = await prisma.$transaction(async (tx) => {
    const user =
      targetUser ??
      (await tx.user.create({
        data: {
          displayName: data.displayName ?? `Discord ${data.discordUserId.slice(-4)}`,
          primaryDiscordId: data.discordUserId,
        },
      }));

    const identity = await tx.discordIdentity.create({
      data: {
        userId: user.id,
        discordUserId: data.discordUserId,
        isPrimary: !user.primaryDiscordId,
        linkedById: ctx.actor?.user?.id ?? null,
        verifiedAt: new Date(),
      },
    });

    const updated = user.primaryDiscordId
      ? user
      : await tx.user.update({
          where: { id: user.id },
          data: { primaryDiscordId: data.discordUserId },
        });

    await recordAudit(tx, {
      ctx,
      action: AuditAction.MEMBER_LINKED,
      targetUserId: user.id,
      targetDiscordId: data.discordUserId,
      reason: data.reason,
      newState: { discordUserId: data.discordUserId, userId: user.id },
    });

    return { user: updated, identity };
  });

  log.info(
    { userId: result.user.id, discordUserId: data.discordUserId },
    'discord identity linked',
  );
  return result;
}

/**
 * `/member unlink`.
 *
 * Refuses to remove the last identity of a member who still holds active grants: a
 * member with no Discord account cannot be synchronized, so the grant would sit there
 * doing nothing, which is confusing to debug later.
 */
export async function unlinkMember(ctx, input) {
  const data = parseOrThrow(unlinkMemberSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  authorize(ctx.actor, { capability: 'member.link', scope: {} });

  const identity = await prisma.discordIdentity.findUnique({
    where: { discordUserId: data.discordUserId },
    include: { user: true },
  });
  if (!identity) throw new NotFoundError('Discord identity', data.discordUserId);

  const [identityCount, activeGrants] = await Promise.all([
    prisma.discordIdentity.count({ where: { userId: identity.userId } }),
    prisma.manualRoleGrant.count({
      where: { userId: identity.userId, ...currentlyEffective() },
    }),
  ]);

  if (identityCount === 1 && activeGrants > 0) {
    throw new PreconditionError(
      'That is the only Discord account linked to a member who still holds active role grants. ' +
        'Revoke the grants first, or link a replacement account.',
    );
  }

  return prisma.$transaction(async (tx) => {
    await tx.discordIdentity.delete({ where: { id: identity.id } });

    const remaining = await tx.discordIdentity.findFirst({
      where: { userId: identity.userId },
      orderBy: { linkedAt: 'asc' },
    });

    const user = await tx.user.update({
      where: { id: identity.userId },
      data: { primaryDiscordId: remaining?.discordUserId ?? null },
    });

    if (remaining && !remaining.isPrimary) {
      await tx.discordIdentity.update({ where: { id: remaining.id }, data: { isPrimary: true } });
    }

    await recordAudit(tx, {
      ctx,
      action: AuditAction.MEMBER_UNLINKED,
      targetUserId: identity.userId,
      targetDiscordId: data.discordUserId,
      reason: data.reason,
      previousState: { discordUserId: data.discordUserId },
      newState: { primaryDiscordId: user.primaryDiscordId },
    });

    return { user };
  });
}

/**
 * Finds the platform user for a Discord id without throwing, used by event handlers
 * where an unlinked account is an ordinary situation rather than an error.
 */
export async function findUserByDiscordId(discordUserId, prisma = getPrisma()) {
  const identity = await prisma.discordIdentity.findUnique({
    where: { discordUserId },
    include: { user: true },
  });
  if (!identity || identity.user.deletedAt) return null;
  return identity.user;
}
