/**
 * Database seed.
 *
 * Idempotent: every write is an upsert, so it is safe to run repeatedly against an
 * existing database. Three layers:
 *
 *   1. Capability catalogue  - always seeded, required for the platform to function.
 *   2. System settings       - always seeded with safe defaults.
 *   3. Global administrators - bootstrapped from GLOBAL_ADMIN_DISCORD_IDS.
 *   4. Demo community data   - only outside production, and only with --demo.
 *
 * Usage:
 *   node prisma/seed.js            # capabilities, settings, admins
 *   node prisma/seed.js --demo     # ... plus a full demo community
 */
import { PrismaClient } from '@prisma/client';
import {
  CAPABILITIES,
  GuildType,
  MembershipStatus,
  PermissionLevel,
  PermissionScopeType,
  RolePurpose,
  MappingDirection,
  AuthoritySource,
  parseEnv,
} from '@frm/shared';

const prisma = new PrismaClient();
const env = parseEnv({ service: 'script' });
const wantsDemo = process.argv.includes('--demo');

/** Deterministic fake snowflakes so the demo data is stable across reseeds. */
function demoSnowflake(seed) {
  return String(100000000000000000n + BigInt(seed));
}

async function seedCapabilities() {
  for (const capability of CAPABILITIES) {
    await prisma.permissionCapability.upsert({
      where: { key: capability.key },
      create: {
        key: capability.key,
        category: capability.category,
        description: capability.description,
        dangerous: capability.dangerous,
        minLevel: capability.minLevel,
      },
      update: {
        category: capability.category,
        description: capability.description,
        dangerous: capability.dangerous,
        minLevel: capability.minLevel,
      },
    });
  }
  console.log(`Seeded ${CAPABILITIES.length} capabilities.`);
}

const DEFAULT_SETTINGS = [
  {
    key: 'sync.maxRemovalsThreshold',
    value: env.SYNC_MAX_REMOVALS_THRESHOLD,
    description: 'A job removing more roles than this pauses for human review.',
  },
  {
    key: 'sync.markerTtlSeconds',
    value: env.SYNC_MARKER_TTL_SECONDS,
    description: 'Lifetime of a Redis loop-protection marker.',
  },
  {
    key: 'guild.autoLeaveUnapproved',
    value: true,
    description: 'Leave guilds that are not on the allowlist (forced on in production).',
  },
  {
    key: 'approval.requiredForProtectedMappings',
    value: true,
    description: 'Protected role mappings require a second approver before activation.',
  },
];

async function seedSettings() {
  for (const setting of DEFAULT_SETTINGS) {
    await prisma.systemSetting.upsert({
      where: { key: setting.key },
      create: setting,
      update: { description: setting.description },
    });
  }
  console.log(`Seeded ${DEFAULT_SETTINGS.length} system settings.`);
}

async function seedGlobalAdmins() {
  const ids = env.GLOBAL_ADMIN_DISCORD_IDS;
  if (ids.length === 0) {
    console.warn(
      'No GLOBAL_ADMIN_DISCORD_IDS configured - nobody can administer the platform yet.',
    );
    return;
  }

  for (const discordUserId of ids) {
    const existing = await prisma.discordIdentity.findUnique({
      where: { discordUserId },
      include: { user: true },
    });

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.userId },
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

    await prisma.permissionAssignment.upsert({
      where: {
        userId_capabilityKey_scopeType_scopeId: {
          userId: user.id,
          capabilityKey: 'system.manage',
          scopeType: PermissionScopeType.GLOBAL,
          scopeId: '',
        },
      },
      create: {
        userId: user.id,
        capabilityKey: 'system.manage',
        scopeType: PermissionScopeType.GLOBAL,
        scopeId: '',
        maxPermissionLevel: PermissionLevel.GLOBAL_ADMIN,
        reason: 'Bootstrapped from GLOBAL_ADMIN_DISCORD_IDS',
      },
      update: { revokedAt: null },
    });
  }
  console.log(`Bootstrapped ${ids.length} global administrator(s).`);
}

/**
 * A miniature but realistic community: a main guild, two department guilds, ranks,
 * managed roles, a one-way mapping and a two-way mapping, and a few members.
 */
async function seedDemoData() {
  if (env.isProduction) {
    console.error('Refusing to seed demo data in production.');
    return;
  }

  const mainGuild = await prisma.approvedGuild.upsert({
    where: { discordGuildId: env.DEV_GUILD_IDS[0] ?? demoSnowflake(1) },
    create: {
      discordGuildId: env.DEV_GUILD_IDS[0] ?? demoSnowflake(1),
      name: 'Florida Roleplay Community',
      type: GuildType.MAIN_COMMUNITY,
      features: ['roster', 'mappings', 'certifications'],
    },
    update: { name: 'Florida Roleplay Community' },
  });

  const hcso = await prisma.department.upsert({
    where: { key: 'hcso' },
    create: {
      key: 'hcso',
      name: "Hillsborough County Sheriff's Office",
      abbreviation: 'HCSO',
      description: 'County law enforcement.',
    },
    update: {},
  });

  const fhp = await prisma.department.upsert({
    where: { key: 'fhp' },
    create: {
      key: 'fhp',
      name: 'Florida Highway Patrol',
      abbreviation: 'FHP',
      description: 'State highway patrol.',
    },
    update: {},
  });

  const hcsoGuild = await prisma.approvedGuild.upsert({
    where: { discordGuildId: env.DEV_GUILD_IDS[1] ?? demoSnowflake(2) },
    create: {
      discordGuildId: env.DEV_GUILD_IDS[1] ?? demoSnowflake(2),
      name: "Hillsborough County Sheriff's Office",
      type: GuildType.DEPARTMENT,
      departmentId: hcso.id,
      features: ['roster', 'mappings'],
    },
    update: { departmentId: hcso.id },
  });

  const fhpGuild = await prisma.approvedGuild.upsert({
    where: { discordGuildId: env.DEV_GUILD_IDS[2] ?? demoSnowflake(3) },
    create: {
      discordGuildId: env.DEV_GUILD_IDS[2] ?? demoSnowflake(3),
      name: 'Florida Highway Patrol',
      type: GuildType.DEPARTMENT,
      departmentId: fhp.id,
      features: ['roster', 'mappings'],
    },
    update: { departmentId: fhp.id },
  });

  const hcsoRankDefs = [
    { name: 'Deputy', order: 10, isSupervisor: false, isCommand: false },
    { name: 'Corporal', order: 20, isSupervisor: true, isCommand: false },
    { name: 'Sergeant', order: 30, isSupervisor: true, isCommand: false },
    { name: 'Lieutenant', order: 40, isSupervisor: true, isCommand: true },
    { name: 'Captain', order: 50, isSupervisor: true, isCommand: true },
    { name: 'Major', order: 60, isSupervisor: true, isCommand: true },
    { name: 'Colonel', order: 70, isSupervisor: true, isCommand: true },
    { name: 'Sheriff', order: 80, isSupervisor: true, isCommand: true },
  ];

  const hcsoRanks = {};
  for (const [index, def] of hcsoRankDefs.entries()) {
    const rank = await prisma.rank.upsert({
      where: { departmentId_name: { departmentId: hcso.id, name: def.name } },
      create: { ...def, departmentId: hcso.id },
      update: { order: def.order, isSupervisor: def.isSupervisor, isCommand: def.isCommand },
    });
    hcsoRanks[def.name] = rank;

    // Rank role inside the department guild.
    await prisma.managedRole.upsert({
      where: {
        approvedGuildId_discordRoleId: {
          approvedGuildId: hcsoGuild.id,
          discordRoleId: demoSnowflake(200 + index),
        },
      },
      create: {
        approvedGuildId: hcsoGuild.id,
        discordRoleId: demoSnowflake(200 + index),
        name: def.name,
        purpose: RolePurpose.RANK,
        departmentId: hcso.id,
        rankId: rank.id,
      },
      update: { rankId: rank.id, name: def.name },
    });
  }

  const fhpRankDefs = [
    { name: 'Trooper', order: 10, isSupervisor: false, isCommand: false },
    { name: 'Corporal', order: 20, isSupervisor: true, isCommand: false },
    { name: 'Sergeant', order: 30, isSupervisor: true, isCommand: false },
    { name: 'Lieutenant', order: 40, isSupervisor: true, isCommand: true },
    { name: 'Captain', order: 50, isSupervisor: true, isCommand: true },
    { name: 'Colonel', order: 60, isSupervisor: true, isCommand: true },
  ];
  const fhpRanks = {};
  for (const [index, def] of fhpRankDefs.entries()) {
    const rank = await prisma.rank.upsert({
      where: { departmentId_name: { departmentId: fhp.id, name: def.name } },
      create: { ...def, departmentId: fhp.id },
      update: { order: def.order },
    });
    fhpRanks[def.name] = rank;
    await prisma.managedRole.upsert({
      where: {
        approvedGuildId_discordRoleId: {
          approvedGuildId: fhpGuild.id,
          discordRoleId: demoSnowflake(300 + index),
        },
      },
      create: {
        approvedGuildId: fhpGuild.id,
        discordRoleId: demoSnowflake(300 + index),
        name: def.name,
        purpose: RolePurpose.RANK,
        departmentId: fhp.id,
        rankId: rank.id,
      },
      update: { rankId: rank.id },
    });
  }

  // Membership roles: one in the main community guild, one in each department guild.
  const membershipRoles = [
    { guild: mainGuild, role: demoSnowflake(400), name: 'HCSO Member', department: hcso },
    { guild: hcsoGuild, role: demoSnowflake(401), name: 'Department Member', department: hcso },
    { guild: mainGuild, role: demoSnowflake(402), name: 'FHP Member', department: fhp },
    { guild: fhpGuild, role: demoSnowflake(403), name: 'Department Member', department: fhp },
  ];
  for (const entry of membershipRoles) {
    await prisma.managedRole.upsert({
      where: {
        approvedGuildId_discordRoleId: {
          approvedGuildId: entry.guild.id,
          discordRoleId: entry.role,
        },
      },
      create: {
        approvedGuildId: entry.guild.id,
        discordRoleId: entry.role,
        name: entry.name,
        purpose: RolePurpose.DEPARTMENT_MEMBERSHIP,
        departmentId: entry.department.id,
      },
      update: { name: entry.name },
    });
  }

  // Supervisor role inside the HCSO guild.
  await prisma.managedRole.upsert({
    where: {
      approvedGuildId_discordRoleId: {
        approvedGuildId: hcsoGuild.id,
        discordRoleId: demoSnowflake(410),
      },
    },
    create: {
      approvedGuildId: hcsoGuild.id,
      discordRoleId: demoSnowflake(410),
      name: 'Supervisor',
      purpose: RolePurpose.SUPERVISOR,
      departmentId: hcso.id,
    },
    update: {},
  });

  // Certification + role.
  const blet = await prisma.certification.upsert({
    where: { key: 'blet' },
    create: { key: 'blet', name: 'BLET Certified', description: 'Basic law enforcement training.' },
    update: {},
  });
  await prisma.managedRole.upsert({
    where: {
      approvedGuildId_discordRoleId: {
        approvedGuildId: hcsoGuild.id,
        discordRoleId: demoSnowflake(420),
      },
    },
    create: {
      approvedGuildId: hcsoGuild.id,
      discordRoleId: demoSnowflake(420),
      name: 'BLET Certified',
      purpose: RolePurpose.CERTIFICATION,
      departmentId: hcso.id,
      certificationId: blet.id,
    },
    update: { certificationId: blet.id },
  });

  // A one-way mapping: main community "HCSO Member" grants the department guild role.
  await prisma.roleMapping.upsert({
    where: {
      sourceGuildId_sourceRoleId_targetGuildId_targetRoleId: {
        sourceGuildId: mainGuild.id,
        sourceRoleId: demoSnowflake(400),
        targetGuildId: hcsoGuild.id,
        targetRoleId: demoSnowflake(401),
      },
    },
    create: {
      name: 'HCSO Member -> Department Member',
      sourceGuildId: mainGuild.id,
      sourceRoleId: demoSnowflake(400),
      targetGuildId: hcsoGuild.id,
      targetRoleId: demoSnowflake(401),
      direction: MappingDirection.ONE_WAY,
      authority: AuthoritySource.ROSTER,
      enabled: true,
    },
    update: { enabled: true },
  });

  // A two-way mapping for a community interest role.
  await prisma.roleMapping.upsert({
    where: {
      sourceGuildId_sourceRoleId_targetGuildId_targetRoleId: {
        sourceGuildId: mainGuild.id,
        sourceRoleId: demoSnowflake(430),
        targetGuildId: hcsoGuild.id,
        targetRoleId: demoSnowflake(431),
      },
    },
    create: {
      name: 'Media Team (two-way)',
      sourceGuildId: mainGuild.id,
      sourceRoleId: demoSnowflake(430),
      targetGuildId: hcsoGuild.id,
      targetRoleId: demoSnowflake(431),
      direction: MappingDirection.TWO_WAY,
      authority: AuthoritySource.SOURCE_DISCORD,
      enabled: true,
    },
    update: { enabled: true },
  });

  // Demo members.
  const demoMembers = [
    {
      discordId: demoSnowflake(500),
      name: 'Demo Deputy',
      rank: hcsoRanks.Deputy,
      callsign: 'H-101',
    },
    {
      discordId: demoSnowflake(501),
      name: 'Demo Sergeant',
      rank: hcsoRanks.Sergeant,
      callsign: 'H-201',
    },
    {
      discordId: demoSnowflake(502),
      name: 'Demo Sheriff',
      rank: hcsoRanks.Sheriff,
      callsign: 'H-001',
    },
  ];

  for (const member of demoMembers) {
    const identity = await prisma.discordIdentity.findUnique({
      where: { discordUserId: member.discordId },
    });
    const user =
      identity ??
      (await prisma.user
        .create({
          data: {
            displayName: member.name,
            primaryDiscordId: member.discordId,
            websiteAccess: true,
            discordIdentities: { create: { discordUserId: member.discordId, isPrimary: true } },
          },
        })
        .then((created) => ({ userId: created.id })));

    await prisma.departmentMembership.upsert({
      where: { userId_departmentId: { userId: user.userId, departmentId: hcso.id } },
      create: {
        userId: user.userId,
        departmentId: hcso.id,
        rankId: member.rank.id,
        callsign: member.callsign,
        status: MembershipStatus.ACTIVE,
        isPrimary: true,
      },
      update: { rankId: member.rank.id, status: MembershipStatus.ACTIVE },
    });
  }

  // Give the demo sheriff department-scoped promote authority up to Major.
  const sheriffIdentity = await prisma.discordIdentity.findUnique({
    where: { discordUserId: demoSnowflake(502) },
  });
  if (sheriffIdentity) {
    await prisma.user.update({
      where: { id: sheriffIdentity.userId },
      data: { permissionLevel: PermissionLevel.DEPARTMENT_HEAD },
    });
    for (const capability of ['roster.promote', 'roster.demote', 'roster.add', 'roster.view']) {
      await prisma.permissionAssignment.upsert({
        where: {
          userId_capabilityKey_scopeType_scopeId: {
            userId: sheriffIdentity.userId,
            capabilityKey: capability,
            scopeType: PermissionScopeType.DEPARTMENT,
            scopeId: hcso.id,
          },
        },
        create: {
          userId: sheriffIdentity.userId,
          capabilityKey: capability,
          scopeType: PermissionScopeType.DEPARTMENT,
          scopeId: hcso.id,
          maxRankOrder: hcsoRanks.Major.order,
          maxPermissionLevel: PermissionLevel.COMMAND,
          reason: 'Demo seed',
        },
        update: { maxRankOrder: hcsoRanks.Major.order },
      });
    }
  }

  console.log('Seeded demo community: 2 departments, 3 guilds, 14 ranks, 2 mappings, 3 members.');
}

async function main() {
  await seedCapabilities();
  await seedSettings();
  await seedGlobalAdmins();
  if (wantsDemo) await seedDemoData();
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error('Seed failed:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
