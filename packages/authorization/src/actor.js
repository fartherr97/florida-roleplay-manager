/**
 * Actor loading.
 *
 * Turns a Discord user id or a platform user id into the immutable snapshot the
 * evaluator works with. Expired and revoked assignments are filtered out at load time
 * so that a stale grant can never be honoured.
 */
import { currentlyEffective, getPrisma } from '@frm/database';
import { ActionSource, UnauthenticatedError } from '@frm/shared';

/**
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} [params.discordUserId]
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 * @param {boolean} [params.required] throw when the user has no account
 * @returns {Promise<import('./evaluate.js').ActorSnapshot|null>}
 */
export async function loadActor({ userId, discordUserId, prisma = getPrisma(), required = true }) {
  if (!userId && !discordUserId) {
    throw new UnauthenticatedError('No actor was supplied for this action.');
  }

  const user = userId
    ? await prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        include: { discordIdentities: { where: { isPrimary: true }, take: 1 } },
      })
    : await prisma.user.findFirst({
        where: { deletedAt: null, discordIdentities: { some: { discordUserId } } },
        include: { discordIdentities: { where: { discordUserId }, take: 1 } },
      });

  if (!user) {
    if (required) {
      throw new UnauthenticatedError(
        'Your Discord account is not linked to a platform account. Ask an administrator to link it.',
      );
    }
    return null;
  }

  const assignments = await prisma.permissionAssignment.findMany({
    where: { userId: user.id, ...currentlyEffective() },
    select: {
      id: true,
      capabilityKey: true,
      scopeType: true,
      scopeId: true,
      maxPermissionLevel: true,
    },
  });

  return Object.freeze({
    user: Object.freeze({
      id: user.id,
      displayName: user.displayName,
      status: user.status,
      permissionLevel: user.permissionLevel,
      websiteAccess: user.websiteAccess,
      accessFromTier: user.accessFromTier,
    }),
    discordUserId:
      discordUserId ?? user.discordIdentities[0]?.discordUserId ?? user.primaryDiscordId ?? null,
    assignments: Object.freeze(assignments),
    isSystem: false,
  });
}

/**
 * The internal actor used by scheduled reconciliation and event-driven propagation.
 *
 * This is only ever constructed inside the worker and the bot's event handlers; it is
 * never derived from user input, and it is recorded in the audit trail with
 * `source: SYSTEM` so automated changes are distinguishable from human ones.
 *
 * @param {string} [label]
 */
export function createSystemActor(label = 'system') {
  return Object.freeze({
    user: Object.freeze({
      id: null,
      displayName: label,
      status: 'ACTIVE',
      permissionLevel: 100,
    }),
    discordUserId: null,
    assignments: Object.freeze([]),
    isSystem: true,
    source: ActionSource.SYSTEM,
  });
}

/**
 * Loads the actor for a Discord interaction, producing a clear error when the Discord
 * account has never been linked.
 *
 * @param {string} discordUserId
 * @param {import('@prisma/client').PrismaClient} [prisma]
 */
export async function loadActorByDiscordId(discordUserId, prisma = getPrisma()) {
  return loadActor({ discordUserId, prisma, required: true });
}
