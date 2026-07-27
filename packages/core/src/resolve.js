/**
 * Identifier resolution.
 *
 * This is the layer that stops insecure direct object references. Every identifier that
 * arrives from a slash command or an HTTP request is resolved to a real row here, and
 * the row's own scope (its department, its guild) is what the authorization check then
 * runs against. Nothing downstream ever trusts a caller-supplied scope.
 */
import { getPrisma, notDeleted } from '@frm/database';
import {
  ConflictError,
  GuildNotApprovedError,
  NotFoundError,
  PreconditionError,
  isSnowflake,
} from '@frm/shared';

/**
 * Resolves a member by platform id or Discord id.
 * @param {import('./context.js').ServiceContext} ctx
 * @param {{userId?: string, discordUserId?: string}} target
 * @param {{required?: boolean}} [options]
 */
export async function resolveUser(ctx, { userId, discordUserId }, { required = true } = {}) {
  const prisma = ctx.prisma ?? getPrisma();

  const user = userId
    ? await prisma.user.findFirst({ where: { id: userId, ...notDeleted } })
    : await prisma.user.findFirst({
        where: { ...notDeleted, discordIdentities: { some: { discordUserId } } },
      });

  if (!user && required) {
    throw new NotFoundError('Member', userId ?? discordUserId);
  }
  return user;
}

/**
 * Resolves a member, creating the platform account if the Discord user has never been
 * seen before. Used by hire and link, both of which require `member.link`-level trust
 * from the caller (checked by the calling service before this runs).
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {{userId?: string, discordUserId?: string, displayName?: string}} target
 * @param {import('@prisma/client').Prisma.TransactionClient} [client]
 */
export async function resolveOrCreateUser(ctx, target, client) {
  const prisma = client ?? ctx.prisma ?? getPrisma();
  const existing = await resolveUser({ ...ctx, prisma }, target, { required: false });
  if (existing) return existing;

  if (!target.discordUserId || !isSnowflake(target.discordUserId)) {
    throw new NotFoundError('Member', target.userId ?? target.discordUserId);
  }

  return prisma.user.create({
    data: {
      displayName: target.displayName ?? `Discord ${target.discordUserId.slice(-4)}`,
      primaryDiscordId: target.discordUserId,
      discordIdentities: {
        create: { discordUserId: target.discordUserId, isPrimary: true },
      },
    },
  });
}

/** @param {import('./context.js').ServiceContext} ctx */
export async function resolveDepartment(ctx, departmentId) {
  const prisma = ctx.prisma ?? getPrisma();
  const department = await prisma.department.findFirst({
    where: { id: departmentId, ...notDeleted },
  });
  if (!department) throw new NotFoundError('Department', departmentId);
  if (!department.enabled) {
    throw new PreconditionError(`${department.name} is currently disabled.`);
  }
  return department;
}

/**
 * Resolves a rank and verifies it belongs to the department being acted on.
 *
 * Without the department check, a caller could pass a rank id from a different
 * department and quietly move somebody onto a rank their command staff do not control.
 */
export async function resolveRank(ctx, rankId, departmentId) {
  const prisma = ctx.prisma ?? getPrisma();
  const rank = await prisma.rank.findFirst({ where: { id: rankId, ...notDeleted } });
  if (!rank) throw new NotFoundError('Rank', rankId);
  if (departmentId && rank.departmentId !== departmentId) {
    throw new ConflictError('That rank belongs to a different department.');
  }
  return rank;
}

/** @param {import('./context.js').ServiceContext} ctx */
export async function resolveApprovedGuild(ctx, guildId) {
  const prisma = ctx.prisma ?? getPrisma();
  const guild = await prisma.approvedGuild.findFirst({ where: { id: guildId, ...notDeleted } });
  if (!guild) throw new NotFoundError('Guild', guildId);
  return guild;
}

/**
 * Looks up a guild by its Discord snowflake.
 * @returns {Promise<object|null>}
 */
export async function findApprovedGuildBySnowflake(discordGuildId, prisma = getPrisma()) {
  if (!isSnowflake(discordGuildId)) return null;
  return prisma.approvedGuild.findFirst({
    where: { discordGuildId, ...notDeleted },
  });
}

/**
 * The allowlist gate.
 *
 * Called before any command is executed and before either side of a mapping is
 * accepted. A guild that is not present, not enabled, or soft deleted is refused.
 *
 * @param {string} discordGuildId
 * @param {{requireSync?: boolean, prisma?: object}} [options]
 */
export async function requireApprovedGuild(discordGuildId, { requireSync = false, prisma } = {}) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma ?? getPrisma());
  if (!guild || !guild.enabled) {
    throw new GuildNotApprovedError(discordGuildId);
  }
  if (requireSync && !guild.syncEnabled) {
    throw new PreconditionError(
      `Synchronization is disabled for ${guild.name}. Enable it with /guild settings.`,
    );
  }
  return guild;
}

/**
 * Resolves the membership a roster action targets, with everything the authorization
 * check and the audit record need.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {{userId: string, departmentId: string}} params
 * @param {{required?: boolean}} [options]
 */
export async function resolveMembership(ctx, { userId, departmentId }, { required = true } = {}) {
  const prisma = ctx.prisma ?? getPrisma();
  const membership = await prisma.departmentMembership.findFirst({
    where: { userId, departmentId, ...notDeleted },
    include: {
      user: true,
      rank: true,
      department: true,
    },
  });
  if (!membership && required) {
    throw new NotFoundError('Membership', `${userId}/${departmentId}`);
  }
  return membership;
}

/**
 * Is this actor acting on their own record?
 *
 * Reading your own profile, history or certifications never requires a capability: a
 * member with no grants at all must still be able to see their own record. Everything
 * that *changes* a record still goes through the full authorization check, and the
 * self-management rule separately forbids acting on yourself.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {string} userId
 */
export function isSelf(ctx, userId) {
  return Boolean(userId) && ctx?.actor?.user?.id === userId;
}

/**
 * Builds the authorization target descriptor for a roster action.
 *
 * Both the current and the resulting rank are included so the rank ceiling is checked
 * in both directions: you may not demote somebody who is above your ceiling, and you
 * may not promote somebody past it either.
 *
 * @param {object} membership
 * @param {{order: number}} [resultingRank]
 */
export function rosterTarget(membership, resultingRank) {
  return {
    userId: membership.userId,
    permissionLevel: membership.user.permissionLevel,
    currentRankOrder: membership.rank.order,
    resultingRankOrder: resultingRank ? resultingRank.order : membership.rank.order,
  };
}
