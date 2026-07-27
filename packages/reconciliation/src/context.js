/**
 * Loading the data the reconciliation engine needs.
 *
 * Split into two halves on purpose:
 *
 *   - `loadPlatformContext` reads guilds, managed roles and mappings. This is identical
 *     for every member, so a department resync loads it once instead of once per person.
 *   - `loadMemberRoster` reads one member's roster facts.
 *
 * On a 400-member department that is the difference between 3 queries and 1200.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { MembershipStatus } from '@frm/shared';

/**
 * Guilds, managed roles and enabled mappings, shaped for the pure engine.
 * @param {import('@prisma/client').PrismaClient} [prisma]
 */
export async function loadPlatformContext(prisma = getPrisma()) {
  const guilds = await prisma.approvedGuild.findMany({
    where: { ...notDeleted, enabled: true, syncEnabled: true },
    select: { id: true, discordGuildId: true, name: true, type: true, departmentId: true },
  });

  const guildIds = guilds.map((guild) => guild.id);
  const guildById = new Map(guilds.map((guild) => [guild.id, guild]));

  const managedRoles = await prisma.managedRole.findMany({
    where: { ...notDeleted, approvedGuildId: { in: guildIds } },
    select: {
      id: true,
      approvedGuildId: true,
      discordRoleId: true,
      name: true,
      purpose: true,
      departmentId: true,
      rankId: true,
      certificationId: true,
      subdivisionId: true,
      protectionLevel: true,
      managedByPlatform: true,
    },
  });

  const mappings = await prisma.roleMapping.findMany({
    where: {
      ...notDeleted,
      enabled: true,
      sourceGuildId: { in: guildIds },
      targetGuildId: { in: guildIds },
    },
    select: {
      id: true,
      name: true,
      sourceGuildId: true,
      sourceRoleId: true,
      targetGuildId: true,
      targetRoleId: true,
      direction: true,
      authority: true,
      syncAdd: true,
      syncRemove: true,
      priority: true,
      enabled: true,
    },
  });

  return {
    guilds,
    guildById,
    managedRoles: managedRoles.map((role) => ({
      ...role,
      discordGuildId: guildById.get(role.approvedGuildId).discordGuildId,
    })),
    mappings: mappings.map((mapping) => ({
      ...mapping,
      sourceDiscordGuildId: guildById.get(mapping.sourceGuildId).discordGuildId,
      targetDiscordGuildId: guildById.get(mapping.targetGuildId).discordGuildId,
    })),
  };
}

/**
 * One member's roster facts: memberships, current certifications, subdivisions and
 * manual grants. Expired and revoked records are filtered out here so the engine never
 * has to reason about time.
 *
 * @param {string} userId
 * @param {object} [options]
 * @param {import('@prisma/client').PrismaClient} [options.prisma]
 * @param {Date} [options.now]
 */
export async function loadMemberRoster(userId, { prisma = getPrisma(), now = new Date() } = {}) {
  const user = await prisma.user.findFirst({
    where: { id: userId, ...notDeleted },
    select: {
      id: true,
      displayName: true,
      primaryDiscordId: true,
      discordIdentities: {
        where: { isPrimary: true },
        select: { discordUserId: true },
        take: 1,
      },
    },
  });
  if (!user) return null;

  const discordUserId = user.primaryDiscordId ?? user.discordIdentities[0]?.discordUserId ?? null;

  const memberships = await prisma.departmentMembership.findMany({
    where: {
      userId,
      ...notDeleted,
      status: { not: MembershipStatus.TERMINATED },
    },
    select: {
      id: true,
      departmentId: true,
      rankId: true,
      status: true,
      callsign: true,
      department: {
        select: {
          id: true,
          key: true,
          name: true,
          removeRankRolesOnLoa: true,
          removeRankRolesOnSuspension: true,
          removeMembershipRolesOnSuspension: true,
        },
      },
      rank: { select: { id: true, name: true, order: true, isSupervisor: true, isCommand: true } },
    },
  });

  const certifications = await prisma.memberCertification.findMany({
    where: {
      userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { certificationId: true },
  });

  const subdivisions = await prisma.memberSubdivision.findMany({
    where: { userId, leftAt: null },
    select: { subdivisionId: true },
  });

  const manualGrants = await prisma.manualRoleGrant.findMany({
    where: {
      userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { managedRoleId: true },
  });

  return {
    member: { id: user.id, displayName: user.displayName, discordUserId },
    memberships: memberships.map((membership) => ({
      id: membership.id,
      departmentId: membership.departmentId,
      departmentKey: membership.department.key,
      departmentName: membership.department.name,
      rankId: membership.rankId,
      rankName: membership.rank.name,
      rankOrder: membership.rank.order,
      status: membership.status,
      callsign: membership.callsign,
      rank: membership.rank,
      department: membership.department,
    })),
    certificationIds: certifications.map((row) => row.certificationId),
    subdivisionIds: subdivisions.map((row) => row.subdivisionId),
    manualGrantManagedRoleIds: manualGrants.map((row) => row.managedRoleId),
  };
}

/**
 * Combines platform and member data into the context the pure engine consumes.
 * @param {Awaited<ReturnType<typeof loadPlatformContext>>} platform
 * @param {Awaited<ReturnType<typeof loadMemberRoster>>} roster
 */
export function buildReconciliationContext(platform, roster) {
  return {
    member: roster.member,
    guilds: platform.guilds,
    managedRoles: platform.managedRoles,
    mappings: platform.mappings,
    memberships: roster.memberships,
    certificationIds: roster.certificationIds,
    subdivisionIds: roster.subdivisionIds,
    manualGrantManagedRoleIds: roster.manualGrantManagedRoleIds,
  };
}

/**
 * The guilds that could possibly be affected for this member.
 *
 * Fetching a member from a guild is an API call, so the engine only touches guilds that
 * actually host a managed role or take part in an enabled mapping.
 *
 * @param {object} context
 * @returns {Array<{id: string, discordGuildId: string, name: string}>}
 */
export function relevantGuilds(context) {
  const relevant = new Set();
  for (const role of context.managedRoles) relevant.add(role.discordGuildId);
  for (const mapping of context.mappings) {
    relevant.add(mapping.sourceDiscordGuildId);
    relevant.add(mapping.targetDiscordGuildId);
  }
  return context.guilds.filter((guild) => relevant.has(guild.discordGuildId));
}
