/**
 * Departments, ranks and managed role definitions.
 *
 * Managed roles are the platform's declaration of "this Discord role is mine to
 * control". Creating one is therefore a `department.manage` action, and the role is
 * validated against Discord before it is accepted, so a typo in a snowflake surfaces
 * immediately instead of as a silent no-op during the next sync.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { ConflictError, NotFoundError, RolePurpose, ValidationError } from '@frm/shared';
import { authorize, departmentScopeFilter } from '@frm/authorization';
import {
  createDepartmentSchema,
  createRankSchema,
  parseOrThrow,
  upsertManagedRoleSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { resolveApprovedGuild, resolveDepartment } from './resolve.js';

/** Departments visible to the actor. */
export async function listDepartments(ctx, { includeDisabled = false } = {}) {
  const prisma = ctx.prisma ?? getPrisma();
  authorize(ctx.actor, { capability: 'roster.view', scope: {}, allowSelf: true });

  const allowed = departmentScopeFilter(ctx.actor, 'roster.view');

  return prisma.department.findMany({
    where: {
      ...notDeleted,
      ...(includeDisabled ? {} : { enabled: true }),
      ...(allowed !== null ? { id: { in: allowed } } : {}),
    },
    orderBy: { name: 'asc' },
    include: {
      guild: { select: { id: true, name: true, discordGuildId: true } },
      _count: { select: { memberships: true, ranks: true } },
    },
  });
}

/** One department with its full rank ladder. */
export async function getDepartment(ctx, departmentId) {
  const prisma = ctx.prisma ?? getPrisma();
  const department = await resolveDepartment(ctx, departmentId);

  authorize(ctx.actor, {
    capability: 'roster.view',
    scope: { departmentId: department.id },
    allowSelf: true,
  });

  const [ranks, managedRoles, subdivisions, certifications] = await Promise.all([
    prisma.rank.findMany({
      where: { departmentId: department.id, ...notDeleted },
      orderBy: { order: 'desc' },
      include: { _count: { select: { memberships: true } } },
    }),
    prisma.managedRole.findMany({
      where: { departmentId: department.id, ...notDeleted },
      include: { guild: { select: { id: true, name: true, discordGuildId: true } } },
    }),
    prisma.subdivision.findMany({ where: { departmentId: department.id, ...notDeleted } }),
    prisma.certification.findMany({ where: { departmentId: department.id, ...notDeleted } }),
  ]);

  return { department, ranks, managedRoles, subdivisions, certifications };
}

/** Creates a department. Global or department-scoped `department.manage`. */
export async function createDepartment(ctx, input) {
  const data = parseOrThrow(createDepartmentSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  authorize(ctx.actor, { capability: 'department.manage', scope: {} });

  const existing = await prisma.department.findUnique({ where: { key: data.key } });
  if (existing && !existing.deletedAt) {
    throw new ConflictError(`A department with the key "${data.key}" already exists.`);
  }

  return prisma.$transaction(async (tx) => {
    const department = existing
      ? await tx.department.update({
          where: { id: existing.id },
          data: {
            name: data.name,
            abbreviation: data.abbreviation,
            enabled: true,
            deletedAt: null,
            removeRankRolesOnLoa: data.removeRankRolesOnLoa,
            removeRankRolesOnSuspension: data.removeRankRolesOnSuspension,
          },
        })
      : await tx.department.create({
          data: {
            key: data.key,
            name: data.name,
            abbreviation: data.abbreviation,
            removeRankRolesOnLoa: data.removeRankRolesOnLoa,
            removeRankRolesOnSuspension: data.removeRankRolesOnSuspension,
          },
        });

    if (data.guildId) {
      const guild = await resolveApprovedGuild({ ...ctx, prisma: tx }, data.guildId);
      await tx.approvedGuild.update({
        where: { id: guild.id },
        data: { departmentId: department.id },
      });
    }

    await recordAudit(tx, {
      ctx,
      action: 'department.created',
      departmentId: department.id,
      reason: data.reason,
      newState: { key: department.key, name: department.name },
    });

    return department;
  });
}

/** Adds a rank to a department's ladder. */
export async function createRank(ctx, input) {
  const data = parseOrThrow(createRankSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const department = await resolveDepartment(ctx, data.departmentId);
  authorize(ctx.actor, {
    capability: 'department.manage',
    scope: { departmentId: department.id },
  });

  const clash = await prisma.rank.findFirst({
    where: {
      departmentId: department.id,
      ...notDeleted,
      OR: [{ order: data.order }, { name: data.name }],
    },
  });
  if (clash) {
    throw new ConflictError(
      clash.order === data.order
        ? `Rank order ${data.order} is already used by ${clash.name}.`
        : `A rank named ${data.name} already exists in this department.`,
    );
  }

  return prisma.$transaction(async (tx) => {
    const rank = await tx.rank.create({
      data: {
        departmentId: department.id,
        name: data.name,
        abbreviation: data.abbreviation ?? null,
        order: data.order,
        isSupervisor: data.isSupervisor,
        isCommand: data.isCommand,
      },
    });
    await recordAudit(tx, {
      ctx,
      action: 'department.rank_created',
      departmentId: department.id,
      reason: data.reason,
      newState: { name: rank.name, order: rank.order },
    });
    return rank;
  });
}

/**
 * Declares a Discord role as platform managed.
 *
 * The role is checked against Discord when a gateway is available: a managed role that
 * does not exist, or that the bot cannot reach, would fail on every future sync.
 */
export async function upsertManagedRole(ctx, input, { gateway } = {}) {
  const data = parseOrThrow(upsertManagedRoleSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const guild = await resolveApprovedGuild(ctx, data.guildId);
  authorize(ctx.actor, {
    capability: 'department.manage',
    scope: {
      guildId: guild.id,
      departmentId: data.departmentId ?? guild.departmentId ?? undefined,
    },
  });

  // Purpose-specific requirements: a rank role without a rank, or a certification role
  // without a certification, can never be computed by the engine.
  if (data.purpose === RolePurpose.RANK && !data.rankId) {
    throw new ValidationError('A rank role must reference the rank it represents.');
  }
  if (data.purpose === RolePurpose.CERTIFICATION && !data.certificationId) {
    throw new ValidationError('A certification role must reference a certification.');
  }
  if (data.purpose === RolePurpose.SUBDIVISION && !data.subdivisionId) {
    throw new ValidationError('A subdivision role must reference a subdivision.');
  }

  if (gateway) {
    const role = await gateway.getRole(guild.discordGuildId, data.discordRoleId);
    if (!role) {
      throw new NotFoundError('Discord role', data.discordRoleId);
    }
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

  return prisma.$transaction(async (tx) => {
    const payload = {
      name: data.name,
      purpose: data.purpose,
      departmentId: data.departmentId ?? null,
      rankId: data.rankId ?? null,
      certificationId: data.certificationId ?? null,
      subdivisionId: data.subdivisionId ?? null,
      protectionLevel: data.protectionLevel,
      deletedAt: null,
    };

    const row = existing
      ? await tx.managedRole.update({ where: { id: existing.id }, data: payload })
      : await tx.managedRole.create({
          data: {
            approvedGuildId: guild.id,
            discordRoleId: data.discordRoleId,
            ...payload,
          },
        });

    await recordAudit(tx, {
      ctx,
      action: 'department.managed_role_upserted',
      approvedGuildId: guild.id,
      departmentId: row.departmentId,
      reason: data.reason,
      previousState: existing
        ? {
            name: existing.name,
            purpose: existing.purpose,
            protectionLevel: existing.protectionLevel,
          }
        : null,
      newState: { name: row.name, purpose: row.purpose, protectionLevel: row.protectionLevel },
    });

    return row;
  });
}

/** Removes a managed role definition. The Discord role itself is left alone. */
export async function removeManagedRole(ctx, { managedRoleId, reason }) {
  const prisma = ctx.prisma ?? getPrisma();
  const managedRole = await prisma.managedRole.findFirst({
    where: { id: managedRoleId, ...notDeleted },
    include: { guild: true },
  });
  if (!managedRole) throw new NotFoundError('Managed role', managedRoleId);

  authorize(ctx.actor, {
    capability: 'department.manage',
    scope: {
      guildId: managedRole.approvedGuildId,
      departmentId: managedRole.departmentId ?? undefined,
    },
  });

  return prisma.$transaction(async (tx) => {
    const row = await tx.managedRole.update({
      where: { id: managedRole.id },
      data: { deletedAt: new Date() },
    });
    await recordAudit(tx, {
      ctx,
      action: 'department.managed_role_removed',
      approvedGuildId: managedRole.approvedGuildId,
      departmentId: managedRole.departmentId,
      reason,
      previousState: { name: managedRole.name, purpose: managedRole.purpose },
      newState: null,
    });
    return row;
  });
}

/** The rank ladder for select menus. */
export async function listRanks(ctx, departmentId) {
  const prisma = ctx.prisma ?? getPrisma();
  const department = await resolveDepartment(ctx, departmentId);
  authorize(ctx.actor, {
    capability: 'roster.view',
    scope: { departmentId: department.id },
    allowSelf: true,
  });

  return prisma.rank.findMany({
    where: { departmentId: department.id, ...notDeleted },
    orderBy: { order: 'desc' },
  });
}
