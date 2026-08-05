/**
 * Integration test fixtures.
 *
 * Builds a small but complete community in the test database: a main guild, two
 * department guilds, managed roles, and members with the permission grants the
 * authorization tests exercise.
 *
 * The matching Discord state is built in a `MockRoleGateway`, so a test can assert on
 * both sides of the synchronization at once.
 */
import { PrismaClient } from '@prisma/client';
import { MockRoleGateway } from '@frm/discord';
import {
  CAPABILITIES,
  GuildType,
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
  R_MAIN_FHP_MEMBER: '920000000000000003',
  R_FHP_MEMBER: '920000000000000004',
  R_MAIN_MEDIA: '920000000000000008',
  R_HCSO_MEDIA: '920000000000000009',
  R_GRANTABLE: '920000000000000020',
  R_UNMANAGED: '920000000000000099',
  R_PROTECTED: '920000000000000050',
  R_ABOVE_BOT: '920000000000000051',
  R_INTEGRATION: '920000000000000052',

  D_ADMIN: '930000000000000004',
  D_GUILD_ADMIN: '930000000000000001',
  D_MEMBER: '930000000000000002',
  D_OTHER: '930000000000000003',
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
      role_grant_rules, role_mappings, managed_roles, approved_guilds,
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

  const mainGuild = await client.approvedGuild.create({
    data: {
      discordGuildId: IDS.MAIN_GUILD,
      name: 'Florida Roleplay Community',
      type: GuildType.MAIN_COMMUNITY,
    },
  });

  const hcsoGuild = await client.approvedGuild.create({
    data: { discordGuildId: IDS.HCSO_GUILD, name: 'HCSO', type: GuildType.DEPARTMENT },
  });

  const fhpGuild = await client.approvedGuild.create({
    data: { discordGuildId: IDS.FHP_GUILD, name: 'FHP', type: GuildType.DEPARTMENT },
  });

  const role = (
    guild,
    discordRoleId,
    name,
    purpose = RolePurpose.MAPPING,
    protectionLevel = 'NONE',
  ) =>
    client.managedRole.create({
      data: { approvedGuildId: guild.id, discordRoleId, name, purpose, protectionLevel },
    });

  const managedRoles = {
    mainHcsoMember: await role(mainGuild, IDS.R_MAIN_HCSO_MEMBER, 'HCSO Member'),
    hcsoMember: await role(hcsoGuild, IDS.R_HCSO_MEMBER, 'Department Member'),
    mainFhpMember: await role(mainGuild, IDS.R_MAIN_FHP_MEMBER, 'FHP Member'),
    fhpMember: await role(fhpGuild, IDS.R_FHP_MEMBER, 'Department Member'),
    mainMedia: await role(mainGuild, IDS.R_MAIN_MEDIA, 'Media Team'),
    hcsoMedia: await role(hcsoGuild, IDS.R_HCSO_MEDIA, 'Media Team'),
    grantable: await role(
      hcsoGuild,
      IDS.R_GRANTABLE,
      'Investigation Access',
      RolePurpose.MANUAL_GRANT,
    ),
    protected: await role(
      hcsoGuild,
      IDS.R_PROTECTED,
      'Internal Affairs',
      RolePurpose.MAPPING,
      'ELEVATED',
    ),
  };

  // --- people --------------------------------------------------------------

  const admin = await createMember(client, {
    discordUserId: IDS.D_ADMIN,
    displayName: 'Global Admin',
    permissionLevel: PermissionLevel.GLOBAL_ADMIN,
  });
  for (const capability of CAPABILITIES) {
    await grant(client, admin.id, capability.key, PermissionScopeType.GLOBAL, '');
  }

  // A guild-scoped administrator: everything they hold is limited to the HCSO guild.
  const guildAdmin = await createMember(client, {
    discordUserId: IDS.D_GUILD_ADMIN,
    displayName: 'HCSO Administrator',
    permissionLevel: PermissionLevel.STAFF,
  });
  for (const capability of [
    'guild.view',
    'guild.settings',
    'mapping.view',
    'mapping.create',
    'mapping.update',
    'mapping.delete',
    'mapping.test',
    'role.manage',
    'grant.issue',
    'grant.revoke',
    'sync.member',
    'sync.guild',
    'sync.issue.retry',
    'member.view',
    'audit.view',
    'permission.view',
    'permission.grant',
    'permission.revoke',
  ]) {
    await grant(client, guildAdmin.id, capability, PermissionScopeType.GUILD, hcsoGuild.id, {
      maxPermissionLevel: PermissionLevel.COMMAND,
    });
  }

  const member = await createMember(client, {
    discordUserId: IDS.D_MEMBER,
    displayName: 'Ordinary Member',
  });

  const other = await createMember(client, {
    discordUserId: IDS.D_OTHER,
    displayName: 'Another Member',
  });

  return {
    guilds: { mainGuild, hcsoGuild, fhpGuild },
    managedRoles,
    users: { admin, guildAdmin, member, other },
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

  gateway.defineRole(IDS.MAIN_GUILD, { id: IDS.R_MAIN_HCSO_MEMBER, name: 'HCSO Member' });
  gateway.defineRole(IDS.MAIN_GUILD, { id: IDS.R_MAIN_FHP_MEMBER, name: 'FHP Member' });
  gateway.defineRole(IDS.MAIN_GUILD, { id: IDS.R_MAIN_MEDIA, name: 'Media Team' });

  for (const [id, name] of [
    [IDS.R_HCSO_MEMBER, 'Department Member'],
    [IDS.R_HCSO_MEDIA, 'Media Team'],
    [IDS.R_GRANTABLE, 'Investigation Access'],
    [IDS.R_PROTECTED, 'Internal Affairs'],
    [IDS.R_UNMANAGED, 'Gaming Nights'],
  ]) {
    gateway.defineRole(IDS.HCSO_GUILD, { id, name });
  }

  gateway.defineRole(IDS.FHP_GUILD, { id: IDS.R_FHP_MEMBER, name: 'Department Member' });

  // A role above the bot, and one owned by another integration: both must be refused.
  gateway.defineRole(IDS.HCSO_GUILD, { id: IDS.R_ABOVE_BOT, name: 'Server Owner', position: 200 });
  gateway.defineRole(IDS.HCSO_GUILD, {
    id: IDS.R_INTEGRATION,
    name: 'Server Booster',
    position: 5,
    managed: true,
  });

  if (withMembers) {
    for (const discordUserId of [IDS.D_ADMIN, IDS.D_GUILD_ADMIN, IDS.D_MEMBER, IDS.D_UNLINKED]) {
      gateway.defineMember(IDS.MAIN_GUILD, { id: discordUserId });
      gateway.defineMember(IDS.HCSO_GUILD, { id: discordUserId });
    }
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_OTHER });
    gateway.defineMember(IDS.FHP_GUILD, { id: IDS.D_OTHER });
  }

  return gateway;
}
