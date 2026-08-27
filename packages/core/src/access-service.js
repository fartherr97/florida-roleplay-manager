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
  CAPABILITY_MAP,
  GuildType,
  PermissionScopeType,
  UnauthenticatedError,
  ValidationError,
} from '@frm/shared';
import { authorize, loadActor } from '@frm/authorization';
import {
  parseOrThrow,
  createAccessTierSchema,
  deleteAccessTierSchema,
  removeAccessTierSchema,
  setAccessTierSchema,
  updateAccessTierSchema,
} from '@frm/validation';
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
 * The authority level a set of capabilities implies: the highest minimum level among them.
 *
 * A named tier grants an explicit list of capabilities rather than a numeric level, but the
 * evaluator still gates every capability behind `actor.permissionLevel >= minLevel`. Setting
 * the actor's level to the highest such minimum is exactly what lets each granted capability
 * through - and no more, because possession is still limited to the listed capabilities.
 *
 * @param {Iterable<string>} capabilityKeys
 * @returns {number}
 */
export function tierLevelOf(capabilityKeys) {
  let level = 0;
  for (const key of capabilityKeys) {
    const definition = CAPABILITY_MAP.get(key);
    if (definition && definition.minLevel > level) level = definition.minLevel;
  }
  return level;
}

/**
 * The access a member's held roles confer, unifying both mapping styles into one result:
 * a capability set and the authority level that set implies.
 *
 *   - A mapping to a named tier contributes exactly that tier's capabilities.
 *   - A legacy numeric mapping contributes every capability up to its level (the old
 *     behaviour), so existing installs keep working unchanged.
 *
 * Excluded capabilities (`access.manage`) and unknown keys are dropped defensively, so a
 * stale or hand-edited tier can never grant more than the catalogue allows.
 *
 * @param {Array<{discordRoleId: string, permissionLevel?: number|null, accessTierId?: string|null}>} rules
 * @param {Iterable<string>} heldRoleIds
 * @param {Map<string, {capabilities: string[]}>} [tierDefsById] named-tier definitions by id
 * @returns {{level: number, capabilities: Set<string>}}
 */
export function resolveTierAccess(rules, heldRoleIds, tierDefsById = new Map()) {
  const held = heldRoleIds instanceof Set ? heldRoleIds : new Set(heldRoleIds);
  const capabilities = new Set();
  let level = 0;

  const add = (key) => {
    if (TIER_EXCLUDED_CAPABILITIES.has(key)) return;
    if (!CAPABILITY_MAP.has(key)) return;
    capabilities.add(key);
  };

  for (const rule of rules) {
    if (!held.has(rule.discordRoleId)) continue;

    if (rule.accessTierId) {
      const def = tierDefsById.get(rule.accessTierId);
      if (def) def.capabilities.forEach(add);
      continue;
    }

    if (typeof rule.permissionLevel === 'number' && rule.permissionLevel > 0) {
      level = Math.max(level, rule.permissionLevel);
      for (const capability of CAPABILITIES) {
        if (
          capability.minLevel <= rule.permissionLevel &&
          capability.allowedScopes.includes(PermissionScopeType.GLOBAL)
        ) {
          add(capability.key);
        }
      }
    }
  }

  // Named-tier capabilities push the level up to whatever they require; legacy capabilities
  // never exceed their own level, so the max leaves numeric mappings unchanged.
  level = Math.max(level, tierLevelOf(capabilities));
  return { level, capabilities };
}

/**
 * The synthetic GLOBAL assignments for an explicit capability set. Shaped exactly like a real
 * assignment so the evaluator treats them identically, and filtered to the capabilities that
 * may actually be held globally.
 *
 * @param {Iterable<string>} capabilityKeys
 * @returns {Array<object>}
 */
export function synthesizeAssignmentsFromCapabilities(capabilityKeys) {
  const keys = capabilityKeys instanceof Set ? [...capabilityKeys] : [...(capabilityKeys ?? [])];
  return keys
    .filter((key) => {
      const definition = CAPABILITY_MAP.get(key);
      return (
        definition &&
        definition.allowedScopes.includes(PermissionScopeType.GLOBAL) &&
        !TIER_EXCLUDED_CAPABILITIES.has(key)
      );
    })
    .map((key) => ({
      id: `tier:${key}`,
      capabilityKey: key,
      scopeType: PermissionScopeType.GLOBAL,
      scopeId: '',
      maxPermissionLevel: null,
    }));
}

/**
 * Returns a copy of the actor raised to the given tier: its authority level lifted (so the
 * ceiling checks use the tier) and the synthesized assignments appended. Nothing to add - a
 * tier of zero with no capabilities, or no actor - is returned unchanged.
 *
 * Accepts either a plain numeric level (the legacy path, still used by the tests and the
 * numeric `/access` command) or a resolved `{level, capabilities}` object (the unified path).
 * With capabilities the actor gets exactly those; with a bare level it gets every capability
 * up to it.
 *
 * @param {import('@frm/authorization').ActorSnapshot} actor
 * @param {number|{level: number, capabilities: Iterable<string>}} access
 */
export function augmentActorWithTier(actor, access) {
  if (!actor) return actor;
  const level = typeof access === 'number' ? access : (access?.level ?? 0);
  const capabilities = typeof access === 'number' ? null : (access?.capabilities ?? null);

  const assignments = capabilities
    ? synthesizeAssignmentsFromCapabilities(capabilities)
    : synthesizeAccessAssignments(level);

  if (assignments.length === 0 && level <= 0) return actor;

  return {
    ...actor,
    user: { ...actor.user, permissionLevel: Math.max(actor.user.permissionLevel, level) },
    assignments: [...actor.assignments, ...assignments],
    tierLevel: level,
  };
}

// ---------------------------------------------------------------------------
// Live resolution - the entry point the bot guard calls.
// ---------------------------------------------------------------------------

/** No access: the neutral result every degraded path returns. */
const NO_ACCESS = Object.freeze({ level: 0, capabilities: new Set() });

/** Loads the named-tier definitions as a map keyed by id, for resolution. */
async function loadTierDefsById(prisma) {
  const tiers = await prisma.accessTier.findMany({
    where: notDeleted,
    select: { id: true, capabilities: true },
  });
  return new Map(tiers.map((tier) => [tier.id, { capabilities: tier.capabilities }]));
}

/**
 * The access a member gets from their live main-guild roles: `{level, capabilities}`, or
 * `NO_ACCESS` if there is nothing to apply.
 *
 * Access tiers are additive and optional, and this runs inside the command guard for *every*
 * command - so it must never be the thing that fails one. Any error (most importantly the
 * `role_access_tiers`/`access_tiers` tables not existing yet, before the migration is applied)
 * degrades to "no access" rather than propagating and breaking the whole bot.
 */
export async function resolveTierAccessForMember({ discordUserId, gateway, prisma }) {
  try {
    const mainGuild = await prisma.approvedGuild.findFirst({
      where: { type: GuildType.MAIN_COMMUNITY, enabled: true, ...notDeleted },
    });
    if (!mainGuild) return NO_ACCESS;

    const rules = await prisma.roleAccessTier.findMany({
      where: notDeleted,
      select: { discordRoleId: true, permissionLevel: true, accessTierId: true },
    });
    if (rules.length === 0 || !gateway) return NO_ACCESS;

    const member = await gateway
      .getMember(mainGuild.discordGuildId, discordUserId)
      .catch(() => null);
    if (!member) return NO_ACCESS;

    const tierDefsById = rules.some((rule) => rule.accessTierId)
      ? await loadTierDefsById(prisma)
      : new Map();
    return resolveTierAccess(rules, member.roleIds, tierDefsById);
  } catch (error) {
    log.error(
      { err: serializeError(error), discordUserId },
      'could not resolve access tier; treating as none',
    );
    return NO_ACCESS;
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
  const access = await resolveTierAccessForMember({ discordUserId, gateway, prisma: db });
  const hasAccess = access.level > 0 || access.capabilities.size > 0;

  let actor = await loadActor({ discordUserId, prisma: db, required: false });
  if (!actor) {
    if (!hasAccess) {
      throw new UnauthenticatedError(
        'Your Discord account is not linked to a platform account, and you do not hold a role ' +
          'that grants access. Ask an administrator to link your account.',
      );
    }
    const user = await provisionMember({ discordUserId, displayName, prisma: db });
    actor = await loadActor({ userId: user.id, prisma: db, required: true });
  }

  await syncWebsiteAccess({ user: actor.user, access, prisma: db });

  return augmentActorWithTier(actor, access);
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
export async function syncWebsiteAccess({ user, access, level, prisma = getPrisma() }) {
  // Accept either a resolved `{level, capabilities}` object or a bare numeric level (the
  // legacy signature). Any capability at all, even a low-level one, grants website access.
  const resolvedLevel = access ? access.level : (level ?? 0);
  const capabilityCount = access?.capabilities
    ? access.capabilities instanceof Set
      ? access.capabilities.size
      : access.capabilities.length
    : 0;
  const shouldHave = resolvedLevel > 0 || capabilityCount > 0;
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
    newState: { websiteAccess: shouldHave, tierLevel: resolvedLevel },
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
    select: { discordRoleId: true, permissionLevel: true, accessTierId: true },
  });
  if (rules.length === 0) return { checked: 0, changed: 0 };

  const tierDefsById = rules.some((rule) => rule.accessTierId)
    ? await loadTierDefsById(prisma)
    : new Map();

  const members = await gateway.listMembers(mainGuild.discordGuildId).catch((error) => {
    log.error({ err: serializeError(error) }, 'could not list main guild for access sweep');
    return [];
  });
  const accessByDiscordId = new Map(
    members.map((member) => [member.id, resolveTierAccess(rules, member.roleIds, tierDefsById)]),
  );

  // Everybody the platform knows about who either holds access now or might gain it.
  const users = await prisma.user.findMany({
    where: {
      ...notDeleted,
      OR: [{ websiteAccess: true }, { primaryDiscordId: { in: [...accessByDiscordId.keys()] } }],
    },
    select: { id: true, primaryDiscordId: true, websiteAccess: true, accessFromTier: true },
  });

  let changed = 0;
  for (const user of users) {
    const access = accessByDiscordId.get(user.primaryDiscordId ?? '') ?? NO_ACCESS;
    const result = await syncWebsiteAccess({ user, access, prisma }).catch((error) => {
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

/**
 * The capabilities an administrator may put in a tier, in plain language, grouped by area.
 *
 * Sourced from the static catalogue rather than the database, so the tier editor works for
 * whoever holds `access.manage` without also needing `permission.view`. `access.manage` is
 * never offered - a tier can never widen who gets access.
 */
export async function listSelectableCapabilities(ctx) {
  authorize(ctx.actor, { capability: 'access.manage', scope: {} });
  return CAPABILITIES.filter(
    (capability) =>
      !TIER_EXCLUDED_CAPABILITIES.has(capability.key) &&
      capability.allowedScopes.includes(PermissionScopeType.GLOBAL),
  ).map((capability) => ({
    key: capability.key,
    category: capability.category,
    description: capability.description,
    dangerous: capability.dangerous,
    minLevel: capability.minLevel,
    // The slash commands this capability unlocks, for the website's access-tier editor.
    commands: capability.commands ?? [],
  }));
}

/** Lists the named access tiers, with how many roles each is mapped to. */
export async function listTiers(ctx) {
  authorize(ctx.actor, { capability: 'access.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();

  const tiers = await prisma.accessTier.findMany({
    where: notDeleted,
    orderBy: [{ name: 'asc' }],
  });

  // Count the live mappings per tier with a plain groupBy rather than a filtered
  // relation count, which keeps the query simple and portable.
  const counts =
    tiers.length === 0
      ? []
      : await prisma.roleAccessTier.groupBy({
          by: ['accessTierId'],
          where: { ...notDeleted, accessTierId: { in: tiers.map((tier) => tier.id) } },
          _count: { _all: true },
        });
  const countByTier = new Map(counts.map((row) => [row.accessTierId, row._count._all]));

  return tiers.map((tier) => ({
    id: tier.id,
    name: tier.name,
    description: tier.description,
    color: tier.color,
    capabilities: tier.capabilities,
    roleCount: countByTier.get(tier.id) ?? 0,
    createdAt: tier.createdAt,
    updatedAt: tier.updatedAt,
  }));
}

/** Creates a named access tier. */
export async function createTier(ctx, input) {
  const data = parseOrThrow(createAccessTierSchema, input);
  authorize(ctx.actor, { capability: 'access.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();

  const capabilities = [...new Set(data.capabilities)];
  let tier;
  try {
    tier = await prisma.accessTier.create({
      data: {
        name: data.name,
        description: data.description ?? null,
        color: data.color ?? null,
        capabilities,
        createdById: ctx.actor?.user?.id ?? null,
      },
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      throw new ValidationError(`A tier named "${data.name}" already exists.`);
    }
    throw error;
  }

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ACCESS_TIER_SET,
    reason: data.reason,
    newState: { tierId: tier.id, name: tier.name, capabilities },
  });

  log.info({ tierId: tier.id, name: tier.name }, 'named access tier created');
  return tier;
}

/** Edits a named access tier. Role mappings that point at it pick up the change live. */
export async function updateTier(ctx, input) {
  const data = parseOrThrow(updateAccessTierSchema, input);
  authorize(ctx.actor, { capability: 'access.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();

  const existing = await prisma.accessTier.findFirst({ where: { id: data.id, ...notDeleted } });
  if (!existing) throw new ValidationError('That access tier no longer exists.');

  const patch = {};
  if (data.name !== undefined) patch.name = data.name;
  if (data.description !== undefined) patch.description = data.description;
  if (data.color !== undefined) patch.color = data.color;
  if (data.capabilities !== undefined) patch.capabilities = [...new Set(data.capabilities)];

  let tier;
  try {
    tier = await prisma.accessTier.update({ where: { id: existing.id }, data: patch });
  } catch (error) {
    if (error?.code === 'P2002') {
      throw new ValidationError(`A tier named "${data.name}" already exists.`);
    }
    throw error;
  }

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ACCESS_TIER_SET,
    reason: data.reason,
    previousState: {
      name: existing.name,
      description: existing.description,
      capabilities: existing.capabilities,
    },
    newState: { tierId: tier.id, name: tier.name, capabilities: tier.capabilities },
  });

  log.info({ tierId: tier.id, name: tier.name }, 'named access tier updated');
  return tier;
}

/**
 * Deletes a named access tier. Any role mappings that point at it are cleared in the same
 * transaction, so a member never keeps access from a tier that no longer exists (the FK is
 * `SET NULL`, which would otherwise leave a mapping with neither a tier nor a level).
 */
export async function deleteTier(ctx, input) {
  const data = parseOrThrow(deleteAccessTierSchema, input);
  authorize(ctx.actor, { capability: 'access.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();

  const existing = await prisma.accessTier.findFirst({ where: { id: data.id, ...notDeleted } });
  if (!existing) return { removed: false };

  await prisma.$transaction([
    prisma.roleAccessTier.updateMany({
      where: { accessTierId: existing.id, ...notDeleted },
      data: { deletedAt: new Date() },
    }),
    prisma.accessTier.update({ where: { id: existing.id }, data: { deletedAt: new Date() } }),
  ]);

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ACCESS_TIER_REMOVED,
    reason: data.reason,
    previousState: { tierId: existing.id, name: existing.name },
  });

  log.info({ tierId: existing.id, name: existing.name }, 'named access tier deleted');
  return { removed: true };
}

/** Lists the configured role -> access rules, named tiers included. */
export async function listAccessTiers(ctx) {
  authorize(ctx.actor, { capability: 'access.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();
  const rules = await prisma.roleAccessTier.findMany({
    where: notDeleted,
    orderBy: [{ permissionLevel: 'desc' }, { roleName: 'asc' }],
    include: {
      accessTier: {
        select: { id: true, name: true, color: true, capabilities: true, deletedAt: true },
      },
    },
  });
  // A tier soft-deleted out from under a mapping should read as "no tier", not a dangling name.
  return rules.map((rule) => ({
    ...rule,
    accessTier: rule.accessTier && !rule.accessTier.deletedAt ? rule.accessTier : null,
  }));
}

/**
 * Maps a main-guild role to access: either a named tier (`accessTierId`) or a legacy numeric
 * `level`. The two are mutually exclusive, enforced by the schema; whichever is set becomes
 * authoritative and the other column is cleared.
 */
export async function setAccessTier(ctx, input) {
  const data = parseOrThrow(setAccessTierSchema, input);
  authorize(ctx.actor, { capability: 'access.manage', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();
  await requireMainGuildContext(ctx, prisma);

  // A named mapping must reference a real, live tier.
  if (data.accessTierId) {
    const tier = await prisma.accessTier.findFirst({
      where: { id: data.accessTierId, ...notDeleted },
    });
    if (!tier) throw new ValidationError('That access tier no longer exists.');
  }

  const existing = await prisma.roleAccessTier.findUnique({
    where: { discordRoleId: data.discordRoleId },
  });
  const previous =
    existing && !existing.deletedAt
      ? { level: existing.permissionLevel, accessTierId: existing.accessTierId }
      : null;

  const fields = {
    roleName: data.roleName,
    permissionLevel: data.accessTierId ? null : data.level,
    accessTierId: data.accessTierId ?? null,
    createdById: ctx.actor?.user?.id ?? null,
  };

  const row = await prisma.roleAccessTier.upsert({
    where: { discordRoleId: data.discordRoleId },
    create: { discordRoleId: data.discordRoleId, ...fields },
    update: { ...fields, deletedAt: null },
  });

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ACCESS_TIER_SET,
    reason: data.reason,
    previousState: previous,
    newState: {
      discordRoleId: data.discordRoleId,
      roleName: data.roleName,
      level: data.level ?? null,
      accessTierId: data.accessTierId ?? null,
    },
  });

  log.info(
    { discordRoleId: data.discordRoleId, level: data.level ?? null, accessTierId: data.accessTierId ?? null },
    'access tier set',
  );
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
