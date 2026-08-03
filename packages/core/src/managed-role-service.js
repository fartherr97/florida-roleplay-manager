/**
 * Managed role definitions.
 *
 * A managed role is the platform's declaration of "this Discord role is mine to
 * control". It is the single most consequential piece of configuration in the system:
 * the reconciliation engine will only ever *remove* a role that has a definition here,
 * so adding one is what moves a role from "the member's own business" into "the
 * platform's responsibility".
 *
 * Because of that, creating one is a `role.manage` action, and the role is validated
 * against live Discord when a gateway is available — a typo in a snowflake surfaces
 * immediately instead of as a silent no-op during the next sync.
 */
import { getPrisma, notDeleted, toPage, toSkipTake } from '@frm/database';
import { createLogger } from '@frm/logging';
import { AuditAction, NotFoundError, ValidationError } from '@frm/shared';
import { authorize, guildScopeFilter } from '@frm/authorization';
import {
  listManagedRolesSchema,
  parseOrThrow,
  removeManagedRoleSchema,
  upsertManagedRoleSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { authorizeAnyScope, resolveApprovedGuild, resolveManagedRole } from './resolve.js';

const log = createLogger('core.managed-role');

function roleState(role) {
  if (!role) return null;
  return {
    id: role.id,
    discordRoleId: role.discordRoleId,
    name: role.name,
    purpose: role.purpose,
    protectionLevel: role.protectionLevel,
    managedByPlatform: role.managedByPlatform,
  };
}

/** Managed roles visible to the actor. */
export async function listManagedRoles(ctx, input = {}) {
  const query = parseOrThrow(listManagedRolesSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  if (query.guildId) {
    authorize(ctx.actor, { capability: 'guild.view', scope: { guildId: query.guildId } });
  } else {
    authorizeAnyScope(ctx, 'guild.view');
  }

  const allowedGuilds = guildScopeFilter(ctx.actor, 'guild.view');

  /** @type {object} */
  const where = { ...notDeleted };
  if (query.guildId) where.approvedGuildId = query.guildId;
  else if (allowedGuilds !== null) where.approvedGuildId = { in: allowedGuilds };
  if (query.purpose) where.purpose = query.purpose;

  const [items, total] = await Promise.all([
    prisma.managedRole.findMany({
      where,
      orderBy: { name: 'asc' },
      ...toSkipTake(query),
      include: {
        guild: { select: { id: true, name: true, discordGuildId: true } },
        _count: { select: { manualGrants: true } },
      },
    }),
    prisma.managedRole.count({ where }),
  ]);

  return toPage(items, total, query);
}

/**
 * Declares a Discord role as platform managed, or updates an existing declaration.
 *
 * @param {import('./context.js').ServiceContext} ctx
 * @param {object} input
 * @param {{gateway?: object}} [options]
 */
export async function upsertManagedRole(ctx, input, { gateway } = {}) {
  const data = parseOrThrow(upsertManagedRoleSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const guild = await resolveApprovedGuild(ctx, data.guildId);
  authorize(ctx.actor, { capability: 'role.manage', scope: { guildId: guild.id } });

  if (gateway) {
    const role = await gateway.getRole(guild.discordGuildId, data.discordRoleId);
    if (!role) throw new NotFoundError('Discord role', data.discordRoleId);
    if (role.isEveryone) throw new ValidationError('The @everyone role cannot be managed.');
    if (role.managed) {
      throw new ValidationError(
        `"${role.name}" is managed by another integration and cannot be controlled by this platform.`,
      );
    }
  }

  const existing = await prisma.managedRole.findUnique({
    where: {
      approvedGuildId_discordRoleId: {
        approvedGuildId: guild.id,
        discordRoleId: data.discordRoleId,
      },
    },
  });

  const row = await prisma.$transaction(async (tx) => {
    const payload = {
      name: data.name,
      purpose: data.purpose,
      protectionLevel: data.protectionLevel,
      managedByPlatform: data.managedByPlatform,
      deletedAt: null,
    };

    const saved = existing
      ? await tx.managedRole.update({ where: { id: existing.id }, data: payload })
      : await tx.managedRole.create({
          data: { approvedGuildId: guild.id, discordRoleId: data.discordRoleId, ...payload },
        });

    await recordAudit(tx, {
      ctx,
      action: AuditAction.MANAGED_ROLE_UPSERTED,
      approvedGuildId: guild.id,
      reason: data.reason,
      previousState: roleState(existing),
      newState: roleState(saved),
    });

    return saved;
  });

  log.info({ managedRoleId: row.id, guildId: guild.id }, 'managed role saved');
  return row;
}

/**
 * Removes a managed role definition. The Discord role itself is left completely alone —
 * the platform simply stops considering it its business, which also means it will never
 * be removed from anybody again.
 */
export async function removeManagedRole(ctx, input) {
  const data = parseOrThrow(removeManagedRoleSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const managedRole = await resolveManagedRole(ctx, data.managedRoleId);
  authorize(ctx.actor, {
    capability: 'role.manage',
    scope: { guildId: managedRole.approvedGuildId },
  });

  return prisma.$transaction(async (tx) => {
    const row = await tx.managedRole.update({
      where: { id: managedRole.id },
      data: { deletedAt: new Date() },
    });
    await recordAudit(tx, {
      ctx,
      action: AuditAction.MANAGED_ROLE_REMOVED,
      approvedGuildId: managedRole.approvedGuildId,
      reason: data.reason,
      previousState: roleState(managedRole),
      newState: null,
    });
    return row;
  });
}
