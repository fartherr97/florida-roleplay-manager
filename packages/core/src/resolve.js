/**
 * Identifier resolution and scope helpers.
 *
 * This is the layer that stops insecure direct object references. Every identifier that
 * arrives from a slash command or an HTTP request is resolved to a real row here, and
 * the row's own scope (its guild) is what the authorization check then runs against.
 * Nothing downstream ever trusts a caller-supplied scope.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { authorize, guildScopeFilter } from '@frm/authorization';
import {
  AuthorizationError,
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
 * seen before. Used by grant issuing and linking, both of which require elevated trust
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
export async function resolveApprovedGuild(ctx, guildId) {
  const prisma = ctx.prisma ?? getPrisma();
  const guild = await prisma.approvedGuild.findFirst({ where: { id: guildId, ...notDeleted } });
  if (!guild) throw new NotFoundError('Guild', guildId);
  return guild;
}

/**
 * Resolves a managed role together with the guild it belongs to, so the caller can
 * authorize against that guild rather than a caller-supplied one.
 *
 * @param {import('./context.js').ServiceContext} ctx
 */
export async function resolveManagedRole(ctx, managedRoleId) {
  const prisma = ctx.prisma ?? getPrisma();
  const managedRole = await prisma.managedRole.findFirst({
    where: { id: managedRoleId, ...notDeleted },
    include: { guild: true },
  });
  if (!managedRole) throw new NotFoundError('Managed role', managedRoleId);
  return managedRole;
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
 * Is this actor acting on their own record?
 *
 * Reading your own profile or grants never requires a capability: a member with no
 * grants at all must still be able to see their own record. Everything that *changes* a
 * record still goes through the full authorization check, and the self-management rule
 * separately forbids acting on yourself.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {string} userId
 */
export function isSelf(ctx, userId) {
  return Boolean(userId) && ctx?.actor?.user?.id === userId;
}

/**
 * Authorizes an action that has no single guild to check against.
 *
 * Two shapes need this: an action about a *member* (whose roles span every approved
 * guild) and a *listing* (which spans whatever the actor can see). A global holder is
 * allowed outright; a guild-scoped holder is allowed if the capability covers at least
 * one approved guild.
 *
 * For listings this is only half the story — the caller must still narrow the query
 * with `guildScopeFilter`, which is what stops a guild-scoped holder from reading
 * another guild's rows. For member actions it is sufficient on its own, because
 * reconciliation only ever applies the state the platform itself computed: an actor can
 * influence *when* it runs, never *what* it does.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {string} capability
 * @param {object} [options]
 */
export function authorizeAnyScope(ctx, capability, { target = {}, allowSelf = false } = {}) {
  const guildIds = guildScopeFilter(ctx.actor, capability);

  if (guildIds === null) {
    return authorize(ctx.actor, { capability, scope: {}, target, allowSelf });
  }

  let lastError = null;
  for (const guildId of guildIds) {
    try {
      return authorize(ctx.actor, { capability, scope: { guildId }, target, allowSelf });
    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ??
    new AuthorizationError(`You do not have the ${capability} permission.`, { capability })
  );
}
