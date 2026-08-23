/**
 * Discord-role-driven access.
 *
 * A community usually already has its authority structure in Discord: a Staff role, a
 * Supervisor role, and so on. This lets an administrator map those main-guild roles to the
 * platform's authority tiers, so that holding the role *is* the grant - no per-person
 * `/permissions` bookkeeping. Holding a mapped role makes a member that tier and gives them
 * every capability up to it, resolved live from their current Discord roles.
 *
 * Two deliberate boundaries:
 *   - The tier is never persisted onto the account. It is recomputed from live roles on
 *     every command, so removing the Discord role removes the access immediately.
 *   - A tier never confers `access.manage`. Control over this very mapping stays with
 *     explicitly provisioned administrators, so possessing a Discord role can never be used
 *     to widen who gets access.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import {
  ActionSource,
  AuditAction,
  CAPABILITIES,
  GuildType,
  PermissionScopeType,
  UnauthenticatedError,
  ValidationError,
} from '@frm/shared';
import { authorize, loadActor } from '@frm/authorization';
import { parseOrThrow, removeAccessTierSchema, setAccessTierSchema } from '@frm/validation';
import { recordAudit } from './audit-service.js';

const log = createLogger('core.access');

/**
 * Capabilities a tier must never confer, however high. `access.manage` is the control over
 * this mapping itself; keeping it out means a Discord role can never expand who gets access.
 */
const TIER_EXCLUDED_CAPABILITIES = new Set(['access.manage']);

// ---------------------------------------------------------------------------
// Pure resolution (no I/O) - the parts that decide access, unit-testable directly.
// ---------------------------------------------------------------------------

/**
 * The highest tier a member is granted by the roles they currently hold. Zero when none of
 * their roles is mapped.
 *
 * @param {Array<{discordRoleId: string, permissionLevel: number}>} rules
 * @param {Iterable<string>} heldRoleIds
 * @returns {number}
 */
export function resolveTierLevel(rules, heldRoleIds) {
  const held = heldRoleIds instanceof Set ? heldRoleIds : new Set(heldRoleIds);
  let level = 0;
  for (const rule of rules) {
    if (held.has(rule.discordRoleId) && rule.permissionLevel > level) {
      level = rule.permissionLevel;
    }
  }
  return level;
}

/**
 * The synthetic GLOBAL assignments a tier confers: every capability whose minimum level is
 * at or below the tier, minus the excluded ones. Shaped exactly like a real assignment so
 * the evaluator treats them identically.
 *
 * @param {number} level
 * @returns {Array<object>}
 */
export function synthesizeAccessAssignments(level) {
  if (!level || level <= 0) return [];
  return CAPABILITIES.filter(
    (capability) =>
      capability.minLevel <= level &&
      capability.allowedScopes.includes(PermissionScopeType.GLOBAL) &&
      !TIER_EXCLUDED_CAPABILITIES.has(capability.key),
  ).map((capability) => ({
    id: `tier:${capability.key}`,
    capabilityKey: capability.key,
    scopeType: PermissionScopeType.GLOBAL,
    scopeId: '',
    maxPermissionLevel: null,
  }));
}

/**
 * Returns a copy of the actor raised to the given tier: its authority level lifted (so the
 * ceiling checks use the tier) and the synthesized assignments appended. A tier of zero, or
 * no actor, is returned unchanged.
 *
 * @param {import('@frm/authorization').ActorSnapshot} actor
 * @param {number} level
 */
export function augmentActorWithTier(actor, level) {
  if (!actor || !level || level <= 0) return actor;
  return {
    ...actor,
    user: { ...actor.user, permissionLevel: Math.max(actor.user.permissionLevel, level) },
    assignments: [...actor.assignments, ...synthesizeAccessAssignments(level)],
    tierLevel: level,
  };
}

// ---------------------------------------------------------------------------
// Live resolution - the entry point the bot guard calls.
// ---------------------------------------------------------------------------

/**
 * The member's tier from their live main-guild roles, or 0 if there is nothing to apply.
 *
 * Access tiers are additive and optional, and this runs inside the command guard for *every*
 * command - so it must never be the thing that fails one. Any error (most importantly the
 * `role_access_tiers` table not existing yet, before the migration is applied) degrades to
 * "no tier" rather than propagating and breaking the whole bot.
 */
export async function resolveTierLevelForMember({ discordUserId, gateway, prisma }) {
  try {
    const mainGuild = await prisma.approvedGuild.findFirst({
      where: { type: GuildType.MAIN_COMMUNITY, enabled: true, ...notDeleted },
    });
    if (!mainGuild) return 0;

    const rules = await prisma.roleAccessTier.findMany({
      where: notDeleted,
      select: { discordRoleId: true, permissionLevel: true },
    });
    if (rules.length === 0 || !gateway) return 0;

    const member = await gateway
      .getMember(mainGuild.discordGuildId, discordUserId)
      .catch(() => null);
    if (!member) return 0;
    return resolveTierLevel(rules, member.roleIds);
  } catch (error) {
    log.error(
      { err: serializeError(error), discordUserId },
      'could not resolve access tier; treating as none',
    );
    return 0;
  }
}

/** Creates a lightweight account for a role-holder who has never linked one. */
async function provisionMember({ discordUserId, displayName, prisma }) {
  const existing = await prisma.user.findFirst({
    where: { deletedAt: null, discordIdentities: { some: { discordUserId } } },
  });
  if (existing) return existing;

  const name = (displayName ?? '').trim().slice(0, 100) || `Discord ${discordUserId}`;
  try {
    const user = await prisma.user.create({
      data: {
        displayName: name,
        permissionLevel: 0,
        websiteAccess: false,
        primaryDiscordId: discordUserId,
        discordIdentities: { create: { discordUserId, isPrimary: true, verifiedAt: new Date() } },
      },
    });
    await recordAudit(prisma, {
      ctx: { actor: { user: { id: user.id }, discordUserId }, source: ActionSource.DISCORD },
      action: AuditAction.MEMBER_AUTO_PROVISIONED,
      targetUserId: user.id,
      targetDiscordId: discordUserId,
      newState: { displayName: name, via: 'access-tier' },
    });
    log.info({ userId: user.id, discordUserId }, 'auto-provisioned member from an access tier');
    return user;
  } catch (error) {
    // Lost a race with a concurrent command from the same new member.
    if (error?.code === 'P2002') {
      const found = await prisma.user.findFirst({
        where: { deletedAt: null, discordIdentities: { some: { discordUserId } } },
      });
      if (found) return found;
    }
    throw error;
  }
}

/**
 * Resolves the actor for a Discord command, layering Discord-role access on top of any
 * explicit grants.
 *
 * A linked member is loaded and then raised by whatever tier their main-guild roles confer.
 * An unlinked member who holds a mapped role is auto-provisioned an account first (the "give
 * anyone with the role access" choice); an unlinked member with no mapped role is refused,
 * exactly as before.
 *
 * @param {object} params
 * @param {string} params.discordUserId
 * @param {string} [params.displayName]
 * @param {object} [params.gateway]
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 */
export async function resolveDiscordActor({ discordUserId, displayName, gateway, prisma } = {}) {
  const db = prisma ?? getPrisma();
  const level = await resolveTierLevelForMember({ discordUserId, gateway, prisma: db });

  let actor = await loadActor({ discordUserId, prisma: db, required: false });
  if (!actor) {
    if (level <= 0) {
      throw new UnauthenticatedError(
        'Your Discord account is not linked to a platform account, and you do not hold a role ' +
          'that grants access. Ask an administrator to link your account.',
      );
    }
    const user = await provisionMember({ discordUserId, displayName, prisma: db });
    actor = await loadActor({ userId: user.id, prisma: db, required: true });
  }

  await syncWebsiteAccess({ user: actor.user, level, prisma: db });

  return augmentActorWithTier(actor, level);
}

/**
 * Keeps `websiteAccess` in step with the member's Discord tier.
 *
 * Website access follows the same rule as bot access: holding a mapped staff role grants
 * it, losing the role takes it away. Unlike the tier itself - which is recomputed live on
 * every command - this has to be persisted, because the API process has no Discord
 * gateway and so cannot read anybody's roles at sign-in time.
 *
 * Persisting it makes the flag a cache, and a cache can go stale: somebody who loses their
 * role and never runs another command would keep website access until something notices.
 * Three things do. This function (every command), the role-change event handler, and the
 * scheduled sweep, which recomputes the whole main guild and is the backstop that makes
 * the other two optimisations rather than requirements.
 *
 * An explicit grant is never revoked here. `websiteAccess` set by hand on an account with
 * no tier is somebody's deliberate decision, and a tier sweep is not the place to override
 * it - so only access this function granted is taken back.
 */
export async function syncWebsiteAccess({ user, level, prisma = getPrisma() }) {
  const shouldHave = level > 0;
  if (user.websiteAccess === shouldHave) return { changed: false };

  // Granting is unconditional; revoking only undoes a grant that came from a tier.
  if (!shouldHave && !user.accessFromTier) return { changed: false };

  await prisma.user.update({
    where: { id: user.id },
    data: { websiteAccess: shouldHave, accessFromTier: shouldHave },
  });

  await recordAudit(prisma, {
    ctx: { actor: { user: { id: user.id } }, source: ActionSource.SYSTEM },
    action: shouldHave ? AuditAction.WEBSITE_ACCESS_GRANTED : AuditAction.WEBSITE_ACCESS_REVOKED,
    targetUserId: user.id,
    reason: shouldHave
      ? 'Holds a Discord role mapped to an access tier'
      : 'No longer holds a Discord role mapped to an access tier',
    newState: { websiteAccess: shouldHave, tierLevel: level },
  }).catch(() => {});

  log.info({ userId: user.id, websiteAccess: shouldHave }, 'website access updated from tier');
  return { changed: true, websiteAccess: shouldHave };
}

/**
 * Recomputes website access for everybody in the main community guild.
 *
 * The backstop. Runs on the maintenance schedule, so a member who was promoted or removed
 * while the bot was down - or who simply never ran a command - converges anyway.
 *
 * @param {object} params
 * @param {object} params.gateway
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 */
export async function reconcileWebsiteAccess({ gateway, prisma = getPrisma() }) {
  const mainGuild = await prisma.approvedGuild.findFirst({
    where: { type: GuildType.MAIN_COMMUNITY, enabled: true, ...notDeleted },
  });
  if (!mainGuild || !gateway) return { checked: 0, changed: 0 };

  const rules = await prisma.roleAccessTier.findMany({
    where: notDeleted,
    select: { discordRoleId: true, permissionLevel: true },
  });
  if (rules.length === 0) return { checked: 0, changed: 0 };

  const members = await gateway.listMembers(mainGuild.discordGuildId).catch((error) => {
    log.error({ err: serializeError(error) }, 'could not list main guild for access sweep');
    return [];
  });
  const levelByDiscordId = new Map(
    members.map((member) => [member.id, resolveTierLevel(rules, member.roleIds)]),
  );

  // Everybody the platform knows about who either holds access now or might gain it.
  const users = await prisma.user.findMany({
    where: {
      ...notDeleted,
      OR: [{ websiteAccess: true }, { primaryDiscordId: { in: [...levelByDiscordId.keys()] } }],
    },
    select: { id: true, primaryDiscordId: true, websiteAccess: true, accessFromTier: true },
  });

  let changed = 0;
  for (const user of users) {
    const level = levelByDiscordId.get(user.primaryDiscordId ?? '') ?? 0;
    const result = await syncWebsiteAccess({ user, level, prisma }).catch((error) => {
      log.error({ err: serializeError(error), userId: user.id }, 'website access sync failed');
      return { changed: false };
    });
    if (result.changed) changed += 1;
  }

  log.info({ checked: users.length, changed }, 'website access sweep complete');
  return { checked: users.length, changed };
}

// ---------------------------------------------------------------------------
// Configuration (/access) - editing the role -> tier mapping.
// ---------------------------------------------------------------------------

/**
 * Access tiers are always main-guild roles, and Discord's role picker only offers roles
 * from the server the command was run in - so editing must happen in the main community
 * server, or an admin would map a department role that can never match. Returns the main
 * guild for convenience.
 */
async function requireMainGuildContext(ctx, prisma) {
  const mainGuild = await prisma.approvedGuild.findFirst({
    where: { type: GuildType.MAIN_COMMUNITY, ...notDeleted },
  });
  if (!mainGuild) {
    throw new ValidationError(
      'No main community server is registered yet. Register it before mapping access roles.',
    );
  }
  if (ctx.discordGuildId && ctx.discordGuildId !== mainGuild.discordGuildId) {
    throw new ValidationError(
      `Run /access from your main community server (${mainGuild.name}) so the role picker shows its roles.`,
    );
  }
  return mainGuild;
}

/** Lists the configured role -> tier rules, highest tier first. */
export async function listAccessTiers(ctx) {
  authorize(ctx.actor, { capability: 'access.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();
  return prisma.roleAccessTier.findMany({
    where: notDeleted,
    orderBy: [{ permissionLevel: 'desc' }, { roleName: 'asc' }],
  });
}

/** Maps a main-guild role to an authority tier (creating or updating the rule). */
export async function setAccessTier(ctx, input) {
  const data = parseOrThrow(setAccessTierSchema, input);
  authorize(ctx.actor, { capability: 'access.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();
  await requireMainGuildContext(ctx, prisma);

  const existing = await prisma.roleAccessTier.findUnique({
    where: { discordRoleId: data.discordRoleId },
  });
  const previous = existing && !existing.deletedAt ? { level: existing.permissionLevel } : null;

  const row = await prisma.roleAccessTier.upsert({
    where: { discordRoleId: data.discordRoleId },
    create: {
      discordRoleId: data.discordRoleId,
      roleName: data.roleName,
      permissionLevel: data.level,
      createdById: ctx.actor?.user?.id ?? null,
    },
    update: {
      roleName: data.roleName,
      permissionLevel: data.level,
      deletedAt: null,
      createdById: ctx.actor?.user?.id ?? null,
    },
  });

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ACCESS_TIER_SET,
    reason: data.reason,
    previousState: previous,
    newState: { discordRoleId: data.discordRoleId, roleName: data.roleName, level: data.level },
  });

  log.info({ discordRoleId: data.discordRoleId, level: data.level }, 'access tier set');
  return row;
}

/** Removes the tier mapping for a role. The Discord role itself is untouched. */
export async function removeAccessTier(ctx, input) {
  const data = parseOrThrow(removeAccessTierSchema, input);
  authorize(ctx.actor, { capability: 'access.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();
  await requireMainGuildContext(ctx, prisma);

  const existing = await prisma.roleAccessTier.findFirst({
    where: { discordRoleId: data.discordRoleId, ...notDeleted },
  });
  if (!existing) return { removed: false };

  await prisma.roleAccessTier.update({
    where: { id: existing.id },
    data: { deletedAt: new Date() },
  });
  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ACCESS_TIER_REMOVED,
    reason: data.reason,
    previousState: { discordRoleId: data.discordRoleId, level: existing.permissionLevel },
  });

  log.info({ discordRoleId: data.discordRoleId }, 'access tier removed');
  return { removed: true };
}
