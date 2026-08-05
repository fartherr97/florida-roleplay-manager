/**
 * Root-administrator bootstrap.
 *
 * The Discord ids in `GLOBAL_ADMIN_DISCORD_IDS` are the platform's root administrators:
 * they are meant to hold every capability at all times. Tying that to a one-off seed is
 * fragile - a capability added in a later release would not reach them until somebody
 * re-ran the seed against the right database.
 *
 * This reconciles that on demand: it makes sure every configured id is a global
 * administrator holding every capability, adding any that are new. It is idempotent and
 * self-healing, so it is safe to run on every boot of the bot - which is exactly what
 * keeps a freshly shipped capability working without a separate re-seed.
 *
 * It only ever grants to the ids in that environment variable, which is trusted operator
 * configuration, never user input.
 */
import { getPrisma } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import { CAPABILITIES, PermissionLevel, PermissionScopeType, getEnv } from '@frm/shared';

const log = createLogger('core.bootstrap');

/**
 * @param {object} [options]
 * @param {import('@prisma/client').PrismaClient} [options.prisma]
 * @param {object} [options.env]
 * @returns {Promise<{admins: number, capabilities: number}>}
 */
export async function reconcileGlobalAdmins({ prisma = getPrisma(), env = getEnv() } = {}) {
  const ids = env.GLOBAL_ADMIN_DISCORD_IDS ?? [];
  if (ids.length === 0) {
    log.warn('GLOBAL_ADMIN_DISCORD_IDS is empty; no root administrators to reconcile');
    return { admins: 0, capabilities: CAPABILITIES.length };
  }

  // The capability catalogue is the parent of every assignment, so make sure it holds
  // every current capability before granting any of them.
  await prisma.permissionCapability.createMany({
    data: CAPABILITIES.map((capability) => ({
      key: capability.key,
      category: capability.category,
      description: capability.description,
      dangerous: capability.dangerous,
      minLevel: capability.minLevel,
    })),
    skipDuplicates: true,
  });

  for (const discordUserId of ids) {
    const identity = await prisma.discordIdentity.findUnique({
      where: { discordUserId },
      include: { user: true },
    });

    const user = identity
      ? await prisma.user.update({
          where: { id: identity.userId },
          data: { permissionLevel: PermissionLevel.GLOBAL_ADMIN, websiteAccess: true },
        })
      : await prisma.user.create({
          data: {
            displayName: `Global Administrator ${discordUserId.slice(-4)}`,
            permissionLevel: PermissionLevel.GLOBAL_ADMIN,
            websiteAccess: true,
            primaryDiscordId: discordUserId,
            discordIdentities: {
              create: { discordUserId, isPrimary: true, verifiedAt: new Date() },
            },
          },
        });

    for (const capability of CAPABILITIES) {
      await prisma.permissionAssignment.upsert({
        where: {
          userId_capabilityKey_scopeType_scopeId: {
            userId: user.id,
            capabilityKey: capability.key,
            scopeType: PermissionScopeType.GLOBAL,
            scopeId: '',
          },
        },
        create: {
          userId: user.id,
          capabilityKey: capability.key,
          scopeType: PermissionScopeType.GLOBAL,
          scopeId: '',
          reason: 'Reconciled from GLOBAL_ADMIN_DISCORD_IDS',
        },
        update: { revokedAt: null },
      });
    }
  }

  log.info(
    { admins: ids.length, capabilities: CAPABILITIES.length },
    'reconciled global administrators',
  );
  return { admins: ids.length, capabilities: CAPABILITIES.length };
}

/** Runs the reconciliation without ever throwing, for use in a startup path. */
export async function reconcileGlobalAdminsSafely(options) {
  try {
    return await reconcileGlobalAdmins(options);
  } catch (error) {
    log.error({ err: serializeError(error) }, 'global administrator reconciliation failed');
    return { admins: 0, capabilities: 0, error: true };
  }
}
