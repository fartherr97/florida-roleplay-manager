/**
 * Community members.
 *
 * The Discord user ID is the external identity, but a member is one platform account
 * with many department memberships - never one account per guild. Linking is a
 * privileged action because a wrong link hands somebody else's roles, rank and history
 * to the wrong Discord account.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger } from '@frm/logging';
import {
  AuditAction,
  ConflictError,
  MembershipStatus,
  NotFoundError,
  PreconditionError,
} from '@frm/shared';
import { authorize } from '@frm/authorization';
import {
  linkMemberSchema,
  memberLookupSchema,
  parseOrThrow,
  unlinkMemberSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { isSelf, resolveUser } from './resolve.js';

const log = createLogger('core.member');

/**
 * `/member lookup`.
 *
 * Returns the full picture: identities, memberships, certifications, subdivisions,
 * permissions and open synchronization issues.
 */
export async function lookupMember(ctx, input) {
  const query = parseOrThrow(memberLookupSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  let user = null;
  if (query.userId || query.discordUserId) {
    user = await resolveUser(ctx, query, { required: false });
  } else if (query.callsign) {
    const membership = await prisma.departmentMembership.findFirst({
      where: {
        callsign: query.callsign,
        ...notDeleted,
        status: { not: MembershipStatus.TERMINATED },
      },
      include: { user: true },
    });
    user = membership?.user ?? null;
  }

  if (!user)
    throw new NotFoundError('Member', query.discordUserId ?? query.userId ?? query.callsign);

  if (!isSelf(ctx, user.id)) {
    authorize(ctx.actor, {
      capability: 'member.view',
      scope: {},
      target: { userId: user.id },
    });
  }

  const [identities, memberships, certifications, subdivisions, permissions, openIssues] =
    await Promise.all([
      prisma.discordIdentity.findMany({ where: { userId: user.id } }),
      prisma.departmentMembership.findMany({
        where: { userId: user.id, ...notDeleted },
        include: {
          department: { select: { id: true, key: true, name: true, abbreviation: true } },
          rank: {
            select: { id: true, name: true, order: true, isSupervisor: true, isCommand: true },
          },
        },
        orderBy: { hireDate: 'asc' },
      }),
      prisma.memberCertification.findMany({
        where: { userId: user.id, revokedAt: null },
        include: { certification: { select: { id: true, key: true, name: true } } },
      }),
      prisma.memberSubdivision.findMany({
        where: { userId: user.id, leftAt: null },
        include: {
          subdivision: { select: { id: true, key: true, name: true, departmentId: true } },
        },
      }),
      prisma.permissionAssignment.findMany({
        where: { userId: user.id, revokedAt: null },
        select: {
          id: true,
          capabilityKey: true,
          scopeType: true,
          scopeId: true,
          maxRankOrder: true,
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
    memberships,
    certifications,
    subdivisions,
    permissions,
    openIssues,
  };
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
 * Refuses to remove the last identity of a member who is still on a roster: an active
 * member with no Discord account cannot be synchronized, and the resulting state is
 * confusing to debug later.
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

  const [identityCount, activeMemberships] = await Promise.all([
    prisma.discordIdentity.count({ where: { userId: identity.userId } }),
    prisma.departmentMembership.count({
      where: {
        userId: identity.userId,
        ...notDeleted,
        status: { not: MembershipStatus.TERMINATED },
      },
    }),
  ]);

  if (identityCount === 1 && activeMemberships > 0) {
    throw new PreconditionError(
      'That is the only Discord account linked to a member who is still on a roster. ' +
        'Remove them from their rosters first, or link a replacement account.',
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
