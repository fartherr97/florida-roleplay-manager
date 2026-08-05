/**
 * Self-service role delegation (`/rolemanager`).
 *
 * A member holding a configured "grantor" Discord role may hand out (and take back) the
 * "grantable" roles that grantor role is mapped to - no platform capability required. The
 * mapping itself (grantor -> grantables, per guild) is edited by someone with
 * `rolegrant.manage`.
 *
 * This is deliberately outside the reconciliation engine. The engine only ever writes
 * roles backed by a ManagedRole; these self-service roles are ordinarily unmanaged, so the
 * engine never adds or removes them. That means this service is the *only* writer for them,
 * and it applies the change directly through the gateway - guarded by the same
 * `checkRoleOperation` preflight reconciliation uses, so a member can never hand out a role
 * that sits above the bot or that the bot cannot manage.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger } from '@frm/logging';
import { AuditAction, AuthorizationError, ValidationError } from '@frm/shared';
import { authorize } from '@frm/authorization';
import { checkRoleOperation } from '@frm/discord';
import {
  addGrantRuleSchema,
  applyRoleAssignmentSchema,
  listGrantRulesSchema,
  parseOrThrow,
  removeGrantRuleSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { requireApprovedGuild } from './resolve.js';

const log = createLogger('core.role-grant');

/**
 * Groups flat rule rows into `{ grantorRoleId, grantorRoleName, grantables: [{id, name}] }`,
 * which is how both the view and the editor want to read them.
 */
function groupRules(rules) {
  const byGrantor = new Map();
  for (const rule of rules) {
    let group = byGrantor.get(rule.grantorRoleId);
    if (!group) {
      group = {
        grantorRoleId: rule.grantorRoleId,
        grantorRoleName: rule.grantorRoleName,
        grantables: [],
      };
      byGrantor.set(rule.grantorRoleId, group);
    }
    group.grantables.push({ id: rule.grantableRoleId, name: rule.grantableRoleName });
  }
  return [...byGrantor.values()];
}

/**
 * The current delegation rules for a guild.
 *
 * Reading the mapping is open to any member: it is not sensitive, and the whole point is
 * that people can see what they (or others) are able to hand out. No capability required.
 */
export async function listGrantRules(ctx, input) {
  const data = parseOrThrow(listGrantRulesSchema, input);
  const prisma = ctx.prisma ?? getPrisma();
  const guild = await requireApprovedGuild(data.discordGuildId, { prisma });

  const rules = await prisma.roleGrantRule.findMany({
    where: { approvedGuildId: guild.id, ...notDeleted },
    orderBy: [{ grantorRoleName: 'asc' }, { grantableRoleName: 'asc' }],
  });

  return {
    guild: { id: guild.id, name: guild.name, discordGuildId: guild.discordGuildId },
    groups: groupRules(rules),
    total: rules.length,
  };
}

/**
 * Adds delegation rules: the grantor role may now hand out each of the grantable roles.
 * Idempotent - a rule that already exists is skipped, and a previously removed one is
 * restored rather than duplicated.
 */
export async function addGrantRule(ctx, input) {
  const data = parseOrThrow(addGrantRuleSchema, input);
  const prisma = ctx.prisma ?? getPrisma();
  const guild = await requireApprovedGuild(data.discordGuildId, { prisma });

  authorize(ctx.actor, { capability: 'rolegrant.manage', scope: { guildId: guild.id } });

  const added = [];
  const skipped = [];
  const warnings = [];

  // A grantable role that the platform actively manages would be fought by reconciliation:
  // a member hands it out here, the engine takes it back on its next pass. Warn rather than
  // refuse, because an operator may know better, but never let it happen silently.
  const managed = await prisma.managedRole.findMany({
    where: {
      approvedGuildId: guild.id,
      discordRoleId: { in: data.grantables.map((role) => role.id) },
      managedByPlatform: true,
      purpose: { not: 'OTHER' },
      ...notDeleted,
    },
    select: { discordRoleId: true, name: true },
  });
  const managedIds = new Set(managed.map((role) => role.discordRoleId));

  for (const grantable of data.grantables) {
    if (grantable.id === data.grantor.id) {
      warnings.push(`Skipped "${grantable.name}": a role cannot hand out itself.`);
      continue;
    }
    if (managedIds.has(grantable.id)) {
      warnings.push(
        `"${grantable.name}" is a platform-managed role; reconciliation may remove it again. ` +
          'Prefer roles the platform does not manage for self-service.',
      );
    }

    const existing = await prisma.roleGrantRule.findUnique({
      where: {
        approvedGuildId_grantorRoleId_grantableRoleId: {
          approvedGuildId: guild.id,
          grantorRoleId: data.grantor.id,
          grantableRoleId: grantable.id,
        },
      },
    });

    if (existing && !existing.deletedAt) {
      skipped.push({ id: grantable.id, name: grantable.name });
      continue;
    }

    if (existing) {
      // Restore a soft-deleted rule, refreshing the cached names.
      await prisma.roleGrantRule.update({
        where: { id: existing.id },
        data: {
          deletedAt: null,
          grantorRoleName: data.grantor.name,
          grantableRoleName: grantable.name,
          createdById: ctx.actor?.user?.id ?? null,
        },
      });
    } else {
      await prisma.roleGrantRule.create({
        data: {
          approvedGuildId: guild.id,
          grantorRoleId: data.grantor.id,
          grantorRoleName: data.grantor.name,
          grantableRoleId: grantable.id,
          grantableRoleName: grantable.name,
          createdById: ctx.actor?.user?.id ?? null,
        },
      });
    }
    added.push({ id: grantable.id, name: grantable.name });
  }

  if (added.length > 0) {
    await recordAudit(prisma, {
      ctx,
      action: AuditAction.ROLE_GRANT_RULE_ADDED,
      approvedGuildId: guild.id,
      reason: data.reason,
      newState: {
        grantorRoleId: data.grantor.id,
        grantorRoleName: data.grantor.name,
        grantableRoleIds: added.map((role) => role.id),
      },
    });
  }

  log.info(
    { guildId: guild.id, grantor: data.grantor.id, added: added.length, skipped: skipped.length },
    'grant rules added',
  );

  return {
    grantorRoleId: data.grantor.id,
    grantorRoleName: data.grantor.name,
    added,
    skipped,
    warnings,
  };
}

/**
 * Removes delegation rules for a grantor role - the listed grantable roles, or all of them
 * when none are named. The Discord roles themselves are never touched.
 */
export async function removeGrantRule(ctx, input) {
  const data = parseOrThrow(removeGrantRuleSchema, input);
  const prisma = ctx.prisma ?? getPrisma();
  const guild = await requireApprovedGuild(data.discordGuildId, { prisma });

  authorize(ctx.actor, { capability: 'rolegrant.manage', scope: { guildId: guild.id } });

  const where = {
    approvedGuildId: guild.id,
    grantorRoleId: data.grantorRoleId,
    ...(data.grantableRoleIds ? { grantableRoleId: { in: data.grantableRoleIds } } : {}),
    ...notDeleted,
  };

  const matching = await prisma.roleGrantRule.findMany({ where, select: { id: true } });
  if (matching.length === 0) {
    return { grantorRoleId: data.grantorRoleId, removed: 0 };
  }

  await prisma.roleGrantRule.updateMany({
    where: { id: { in: matching.map((rule) => rule.id) } },
    data: { deletedAt: new Date() },
  });

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ROLE_GRANT_RULE_REMOVED,
    approvedGuildId: guild.id,
    reason: data.reason,
    newState: {
      grantorRoleId: data.grantorRoleId,
      grantableRoleIds: data.grantableRoleIds ?? 'all',
      removed: matching.length,
    },
  });

  log.info(
    { guildId: guild.id, grantor: data.grantorRoleId, removed: matching.length },
    'grant rules removed',
  );

  return { grantorRoleId: data.grantorRoleId, removed: matching.length };
}

/**
 * Pure: the set of role ids a caller may hand out, given the rules and the roles the caller
 * currently holds. A caller is authorized for a grantable role if they hold any grantor
 * role mapped to it. Exported for direct unit testing.
 *
 * @param {Array<{grantorRoleId: string, grantableRoleId: string}>} rules
 * @param {Iterable<string>} holderRoleIds
 * @returns {Set<string>}
 */
export function resolveGrantableRoleIds(rules, holderRoleIds) {
  const held = holderRoleIds instanceof Set ? holderRoleIds : new Set(holderRoleIds);
  const grantable = new Set();
  for (const rule of rules) {
    if (held.has(rule.grantorRoleId)) grantable.add(rule.grantableRoleId);
  }
  return grantable;
}

/**
 * The distinct roles a caller may hand out, given the roles they currently hold. Used by
 * the bot to build the selection menu; `applyRoleAssignment` re-checks authoritatively, so
 * this is only ever a convenience, never the security boundary. Read-only, no capability.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {{discordGuildId: string, holderRoleIds: string[]}} input
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function listAssignableRoles(ctx, { discordGuildId, holderRoleIds }) {
  const prisma = ctx.prisma ?? getPrisma();
  const guild = await requireApprovedGuild(discordGuildId, { prisma });

  const rules = await prisma.roleGrantRule.findMany({
    where: { approvedGuildId: guild.id, ...notDeleted },
    select: { grantorRoleId: true, grantableRoleId: true, grantableRoleName: true },
  });
  const grantable = resolveGrantableRoleIds(rules, holderRoleIds ?? []);

  const byId = new Map();
  for (const rule of rules) {
    if (grantable.has(rule.grantableRoleId)) byId.set(rule.grantableRoleId, rule.grantableRoleName);
  }
  return [...byId.entries()].map(([id, name]) => ({ id, name }));
}

/**
 * Applies a self-service assignment or removal.
 *
 * Authorization is by held grantor role, not by capability: the caller's live Discord roles
 * are read from the gateway and checked against the guild's rules. Every requested role must
 * be one the caller is allowed to hand out. Each role is then applied individually - already
 * satisfied roles are skipped, and a role the bot cannot manage fails on its own without
 * aborting the rest.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {{gateway: object}} deps
 */
export async function applyRoleAssignment(ctx, input, { gateway }) {
  const data = parseOrThrow(applyRoleAssignmentSchema, input);
  const prisma = ctx.prisma ?? getPrisma();
  const guild = await requireApprovedGuild(data.discordGuildId, { prisma });

  const rules = await prisma.roleGrantRule.findMany({
    where: { approvedGuildId: guild.id, ...notDeleted },
    select: { grantorRoleId: true, grantableRoleId: true, grantableRoleName: true },
  });
  const nameById = new Map(rules.map((rule) => [rule.grantableRoleId, rule.grantableRoleName]));

  // The caller's own roles, read live - never taken from the interaction, which the caller
  // could otherwise shape.
  const caller = ctx.actor?.discordUserId
    ? await gateway.getMember(data.discordGuildId, ctx.actor.discordUserId).catch(() => null)
    : null;
  const authorized = resolveGrantableRoleIds(rules, caller?.roleIds ?? []);

  if (authorized.size === 0) {
    throw new AuthorizationError('You do not hold a role that lets you manage roles here.');
  }

  const unauthorized = data.roleIds.filter((roleId) => !authorized.has(roleId));
  if (unauthorized.length > 0) {
    const names = unauthorized.map((id) => nameById.get(id) ?? id).join(', ');
    throw new AuthorizationError(`You are not allowed to hand out: ${names}.`);
  }

  const target = await gateway
    .getMember(data.discordGuildId, data.targetDiscordUserId)
    .catch(() => null);
  if (!target) {
    throw new ValidationError('That member is not in this server.');
  }
  const held = new Set(target.roleIds);
  const reason = `FRM self-service: ${data.reason ?? 'role manager'}`.slice(0, 400);

  const applied = [];
  const skipped = [];
  const failed = [];

  for (const roleId of data.roleIds) {
    const name = nameById.get(roleId) ?? roleId;

    if (data.remove && !held.has(roleId)) {
      skipped.push({ id: roleId, name, reason: 'not held' });
      continue;
    }
    if (!data.remove && held.has(roleId)) {
      skipped.push({ id: roleId, name, reason: 'already has it' });
      continue;
    }

    const preflight = await checkRoleOperation(gateway, {
      discordGuildId: data.discordGuildId,
      discordUserId: data.targetDiscordUserId,
      discordRoleId: roleId,
    });
    if (!preflight.ok) {
      failed.push({ id: roleId, name, message: preflight.message });
      continue;
    }

    try {
      if (data.remove) {
        await gateway.removeRole(data.discordGuildId, data.targetDiscordUserId, roleId, reason);
      } else {
        await gateway.addRole(data.discordGuildId, data.targetDiscordUserId, roleId, reason);
      }
      applied.push({ id: roleId, name });
    } catch (error) {
      failed.push({
        id: roleId,
        name,
        message: error?.userMessage ?? 'Discord rejected the change.',
      });
    }
  }

  if (applied.length > 0) {
    await recordAudit(prisma, {
      ctx,
      action: data.remove
        ? AuditAction.ROLE_SELF_SERVICE_REMOVED
        : AuditAction.ROLE_SELF_SERVICE_ASSIGNED,
      approvedGuildId: guild.id,
      targetDiscordId: data.targetDiscordUserId,
      reason: data.reason,
      newState: { roleIds: applied.map((role) => role.id), remove: data.remove },
    });
  }

  log.info(
    {
      guildId: guild.id,
      target: data.targetDiscordUserId,
      remove: data.remove,
      applied: applied.length,
      skipped: skipped.length,
      failed: failed.length,
    },
    'self-service role change applied',
  );

  return {
    target: { id: target.id, displayName: target.displayName },
    remove: data.remove,
    applied,
    skipped,
    failed,
  };
}
