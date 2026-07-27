/**
 * Integration test fixtures.
 *
 * Builds a small but complete community in the test database: a main guild, a
 * department guild, a rank ladder, managed roles, and members with the permission
 * grants the specification's worked example describes.
 *
 * The matching Discord state is built in a `MockRoleGateway`, so a test can assert on
 * both sides of the synchronization at once.
 */
import { PrismaClient } from '@prisma/client';
import { MockRoleGateway } from '@frm/discord';
import {
  CAPABILITIES,
  GuildType,
  MembershipStatus,
  PermissionLevel,
  PermissionScopeType,
  RolePurpose,
} from '@frm/shared';

export const IDS = Object.freeze({
  MAIN_GUILD: '910000000000000001',
  HCSO_GUILD: '910000000000000002',
  FHP_GUILD: '910000000000000003',

  R_MAIN_HCSO_MEMBER: '920000000000000001',
  R_HCSO_MEMBER: '920000000000000002',
  R_HCSO_DEPUTY: '920000000000000003',
  R_HCSO_CORPORAL: '920000000000000004',
  R_HCSO_SERGEANT: '920000000000000005',
  R_HCSO_SUPERVISOR: '920000000000000006',
  R_HCSO_BLET: '920000000000000007',
  R_MAIN_MEDIA: '920000000000000008',
  R_HCSO_MEDIA: '920000000000000009',
  R_UNMANAGED: '920000000000000099',
  R_PROTECTED: '920000000000000050',
  R_ABOVE_BOT: '920000000000000051',
  R_INTEGRATION: '920000000000000052',

  D_SHERIFF: '930000000000000001',
  D_DEPUTY: '930000000000000002',
  D_TROOPER: '930000000000000003',
  D_ADMIN: '930000000000000004',
  D_UNLINKED: '930000000000000005',
});

let prisma = null;

export function testPrisma() {
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

export async function disconnectTestPrisma() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

/**
 * Truncates every table. `RESTART IDENTITY CASCADE` keeps this fast and avoids having
 * to delete in dependency order by hand.
 */
export async function resetDatabase() {
  const client = testPrisma();
  await client.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_logs, sync_issues, sync_actions, sync_jobs,
      pending_approval_votes, pending_approvals,
      permission_assignments, manual_role_grants,
      member_subdivisions, member_certifications, membership_events,
      department_memberships, role_mappings, managed_roles,
      subdivisions, certifications, ranks, approved_guilds, departments,
      discord_identities, users, system_settings
    RESTART IDENTITY CASCADE
  `);
}

/** Seeds the capability catalogue, which the permission tables reference. */
export async function seedCapabilities() {
  const client = testPrisma();
  await client.permissionCapability.createMany({
    data: CAPABILITIES.map((capability) => ({
      key: capability.key,
      category: capability.category,
      description: capability.description,
      dangerous: capability.dangerous,
      minLevel: capability.minLevel,
    })),
    skipDuplicates: true,
  });
}

/**
 * Builds the whole fixture set.
 * @returns {Promise<object>} every created entity, for assertions
 */
export async function seedCommunity() {
  const client = testPrisma();
  await seedCapabilities();

  const hcso = await client.department.create({
    data: {
      key: 'hcso',
      name: "Hillsborough County Sheriff's Office",
      abbreviation: 'HCSO',
      removeRankRolesOnSuspension: true,
    },
  });

  const fhp = await client.department.create({
    data: { key: 'fhp', name: 'Florida Highway Patrol', abbreviation: 'FHP' },
  });

  const mainGuild = await client.approvedGuild.create({
    data: {
      discordGuildId: IDS.MAIN_GUILD,
      name: 'Florida Roleplay Community',
      type: GuildType.MAIN_COMMUNITY,
    },
  });

  const hcsoGuild = await client.approvedGuild.create({
    data: {
      discordGuildId: IDS.HCSO_GUILD,
      name: 'HCSO',
      type: GuildType.DEPARTMENT,
      departmentId: hcso.id,
    },
  });

  const fhpGuild = await client.approvedGuild.create({
    data: {
      discordGuildId: IDS.FHP_GUILD,
      name: 'FHP',
      type: GuildType.DEPARTMENT,
      departmentId: fhp.id,
    },
  });

  const deputy = await client.rank.create({
    data: { departmentId: hcso.id, name: 'Deputy', order: 10 },
  });
  const corporal = await client.rank.create({
    data: { departmentId: hcso.id, name: 'Corporal', order: 20, isSupervisor: true },
  });
  const sergeant = await client.rank.create({
    data: { departmentId: hcso.id, name: 'Sergeant', order: 30, isSupervisor: true },
  });
  const major = await client.rank.create({
    data: { departmentId: hcso.id, name: 'Major', order: 60, isSupervisor: true, isCommand: true },
  });
  const colonel = await client.rank.create({
    data: {
      departmentId: hcso.id,
      name: 'Colonel',
      order: 70,
      isSupervisor: true,
      isCommand: true,
    },
  });
  const trooper = await client.rank.create({
    data: { departmentId: fhp.id, name: 'Trooper', order: 10 },
  });

  const blet = await client.certification.create({
    data: { key: 'blet', name: 'BLET Certified', departmentId: hcso.id },
  });

  const managedRoles = await Promise.all([
    client.managedRole.create({
      data: {
        approvedGuildId: mainGuild.id,
        discordRoleId: IDS.R_MAIN_HCSO_MEMBER,
        name: 'HCSO Member',
        purpose: RolePurpose.DEPARTMENT_MEMBERSHIP,
        departmentId: hcso.id,
      },
    }),
    client.managedRole.create({
      data: {
        approvedGuildId: hcsoGuild.id,
        discordRoleId: IDS.R_HCSO_MEMBER,
        name: 'Department Member',
        purpose: RolePurpose.DEPARTMENT_MEMBERSHIP,
        departmentId: hcso.id,
      },
    }),
    client.managedRole.create({
      data: {
        approvedGuildId: hcsoGuild.id,
        discordRoleId: IDS.R_HCSO_DEPUTY,
        name: 'Deputy',
        purpose: RolePurpose.RANK,
        departmentId: hcso.id,
        rankId: deputy.id,
      },
    }),
    client.managedRole.create({
      data: {
        approvedGuildId: hcsoGuild.id,
        discordRoleId: IDS.R_HCSO_CORPORAL,
        name: 'Corporal',
        purpose: RolePurpose.RANK,
        departmentId: hcso.id,
        rankId: corporal.id,
      },
    }),
    client.managedRole.create({
      data: {
        approvedGuildId: hcsoGuild.id,
        discordRoleId: IDS.R_HCSO_SERGEANT,
        name: 'Sergeant',
        purpose: RolePurpose.RANK,
        departmentId: hcso.id,
        rankId: sergeant.id,
      },
    }),
    client.managedRole.create({
      data: {
        approvedGuildId: hcsoGuild.id,
        discordRoleId: IDS.R_HCSO_SUPERVISOR,
        name: 'Supervisor',
        purpose: RolePurpose.SUPERVISOR,
        departmentId: hcso.id,
      },
    }),
    client.managedRole.create({
      data: {
        approvedGuildId: hcsoGuild.id,
        discordRoleId: IDS.R_HCSO_BLET,
        name: 'BLET Certified',
        purpose: RolePurpose.CERTIFICATION,
        departmentId: hcso.id,
        certificationId: blet.id,
      },
    }),
    client.managedRole.create({
      data: {
        approvedGuildId: hcsoGuild.id,
        discordRoleId: IDS.R_PROTECTED,
        name: 'Internal Affairs Command',
        purpose: RolePurpose.OTHER,
        protectionLevel: 'ELEVATED',
      },
    }),
  ]);

  // --- people --------------------------------------------------------------

  const admin = await createMember(client, {
    discordUserId: IDS.D_ADMIN,
    displayName: 'Global Admin',
    permissionLevel: PermissionLevel.GLOBAL_ADMIN,
  });
  await grant(client, admin.id, 'system.manage', PermissionScopeType.GLOBAL, '');
  for (const capability of [
    'guild.view',
    'guild.register',
    'guild.remove',
    'guild.settings',
    'mapping.view',
    'mapping.create',
    'mapping.update',
    'mapping.delete',
    'mapping.test',
    'mapping.approve',
    'sync.member',
    'sync.department',
    'sync.guild',
    'sync.global',
    'sync.issue.retry',
    'roster.view',
    'roster.add',
    'roster.remove',
    'roster.promote',
    'roster.demote',
    'roster.transfer',
    'roster.suspend',
    'roster.reinstate',
    'roster.loa',
    'roster.callsign',
    'certification.assign',
    'certification.remove',
    'subdivision.assign',
    'subdivision.remove',
    'department.manage',
    'member.view',
    'member.link',
    'audit.view',
    'audit.export',
    'permission.view',
    'permission.grant',
    'permission.revoke',
  ]) {
    await grant(client, admin.id, capability, PermissionScopeType.GLOBAL, '');
  }

  const sheriff = await createMember(client, {
    discordUserId: IDS.D_SHERIFF,
    displayName: 'Demo Sheriff',
    permissionLevel: PermissionLevel.DEPARTMENT_HEAD,
  });
  // The specification's worked example: department scope, rank ceiling of Major.
  for (const capability of [
    'roster.view',
    'roster.add',
    'roster.promote',
    'roster.demote',
    'roster.suspend',
    'roster.reinstate',
    'roster.loa',
    'roster.remove',
    'roster.transfer',
    'sync.member',
    'member.view',
    'permission.grant',
    'permission.view',
  ]) {
    await grant(client, sheriff.id, capability, PermissionScopeType.DEPARTMENT, hcso.id, {
      maxRankOrder: major.order,
      maxPermissionLevel: PermissionLevel.COMMAND,
    });
  }

  const deputyMember = await createMember(client, {
    discordUserId: IDS.D_DEPUTY,
    displayName: 'Demo Deputy',
  });
  const deputyMembership = await client.departmentMembership.create({
    data: {
      userId: deputyMember.id,
      departmentId: hcso.id,
      rankId: deputy.id,
      callsign: 'H-101',
      status: MembershipStatus.ACTIVE,
    },
  });

  const trooperMember = await createMember(client, {
    discordUserId: IDS.D_TROOPER,
    displayName: 'Demo Trooper',
  });
  await client.departmentMembership.create({
    data: {
      userId: trooperMember.id,
      departmentId: fhp.id,
      rankId: trooper.id,
      callsign: 'F-201',
      status: MembershipStatus.ACTIVE,
    },
  });

  return {
    departments: { hcso, fhp },
    guilds: { mainGuild, hcsoGuild, fhpGuild },
    ranks: { deputy, corporal, sergeant, major, colonel, trooper },
    certifications: { blet },
    managedRoles,
    users: { admin, sheriff, deputy: deputyMember, trooper: trooperMember },
    memberships: { deputy: deputyMembership },
  };
}

async function createMember(client, { discordUserId, displayName, permissionLevel = 0 }) {
  return client.user.create({
    data: {
      displayName,
      permissionLevel,
      websiteAccess: true,
      primaryDiscordId: discordUserId,
      discordIdentities: { create: { discordUserId, isPrimary: true, verifiedAt: new Date() } },
    },
  });
}

async function grant(client, userId, capabilityKey, scopeType, scopeId, extra = {}) {
  return client.permissionAssignment.create({
    data: {
      userId,
      capabilityKey,
      scopeType,
      scopeId,
      maxRankOrder: extra.maxRankOrder ?? null,
      maxPermissionLevel: extra.maxPermissionLevel ?? null,
      reason: 'test fixture',
    },
  });
}

/**
 * A mock Discord matching the fixtures: three guilds, the managed roles, and the
 * members present in each.
 */
export function buildMockGateway({ withMembers = true } = {}) {
  const gateway = new MockRoleGateway();

  gateway.defineGuild({ id: IDS.MAIN_GUILD, name: 'Main', botHighestRolePosition: 100 });
  gateway.defineGuild({ id: IDS.HCSO_GUILD, name: 'HCSO', botHighestRolePosition: 100 });
  gateway.defineGuild({ id: IDS.FHP_GUILD, name: 'FHP', botHighestRolePosition: 100 });

  gateway.defineRole(IDS.MAIN_GUILD, {
    id: IDS.R_MAIN_HCSO_MEMBER,
    name: 'HCSO Member',
    position: 10,
  });
  gateway.defineRole(IDS.MAIN_GUILD, { id: IDS.R_MAIN_MEDIA, name: 'Media Team', position: 11 });

  for (const [id, name] of [
    [IDS.R_HCSO_MEMBER, 'Department Member'],
    [IDS.R_HCSO_DEPUTY, 'Deputy'],
    [IDS.R_HCSO_CORPORAL, 'Corporal'],
    [IDS.R_HCSO_SERGEANT, 'Sergeant'],
    [IDS.R_HCSO_SUPERVISOR, 'Supervisor'],
    [IDS.R_HCSO_BLET, 'BLET Certified'],
    [IDS.R_HCSO_MEDIA, 'Media Team'],
    [IDS.R_UNMANAGED, 'Gaming Nights'],
    [IDS.R_PROTECTED, 'Internal Affairs Command'],
  ]) {
    gateway.defineRole(IDS.HCSO_GUILD, { id, name, position: 10 });
  }

  // A role above the bot, and one owned by another integration: both must be refused.
  gateway.defineRole(IDS.HCSO_GUILD, { id: IDS.R_ABOVE_BOT, name: 'Server Owner', position: 200 });
  gateway.defineRole(IDS.HCSO_GUILD, {
    id: IDS.R_INTEGRATION,
    name: 'Server Booster',
    position: 5,
    managed: true,
  });

  if (withMembers) {
    for (const discordUserId of [IDS.D_SHERIFF, IDS.D_DEPUTY, IDS.D_ADMIN, IDS.D_UNLINKED]) {
      gateway.defineMember(IDS.MAIN_GUILD, { id: discordUserId });
      gateway.defineMember(IDS.HCSO_GUILD, { id: discordUserId });
    }
    gateway.defineMember(IDS.FHP_GUILD, { id: IDS.D_TROOPER });
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_TROOPER });
  }

  return gateway;
}
