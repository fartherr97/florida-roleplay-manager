/**
 * Database seed.
 *
 * Idempotent: every write is an upsert, so it is safe to run repeatedly against an
 * existing database. Four layers:
 *
 *   1. Capability catalogue  - always seeded, required for the platform to function.
 *   2. System settings       - always seeded with safe defaults.
 *   3. Global administrators - bootstrapped from GLOBAL_ADMIN_DISCORD_IDS.
 *   4. Demo community data   - only outside production, and only with --demo.
 *
 * Usage:
 *   node prisma/seed.js            # capabilities, settings, admins
 *   node prisma/seed.js --demo     # ... plus a demo community
 */
import { PrismaClient } from '@prisma/client';
import {
  AuthoritySource,
  CAPABILITIES,
  GuildType,
  MappingDirection,
  PermissionLevel,
  PermissionScopeType,
  RolePurpose,
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

  // Capabilities that no longer exist are removed, along with any assignment of them.
  // Leaving a stale grant behind would be a permission nobody can see in the catalogue
  // but the evaluator would still have to reason about.
  const validKeys = CAPABILITIES.map((capability) => capability.key);
  const removed = await prisma.permissionCapability.findMany({
    where: { key: { notIn: validKeys } },
    select: { key: true },
  });
  if (removed.length > 0) {
    const keys = removed.map((row) => row.key);
    await prisma.permissionAssignment.deleteMany({ where: { capabilityKey: { in: keys } } });
    await prisma.permissionCapability.deleteMany({ where: { key: { in: keys } } });
    console.log(`Removed ${keys.length} obsolete capabilities: ${keys.join(', ')}`);
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

    // A global administrator holds every capability at global scope: `system.manage`
    // alone would not satisfy the evaluator, which checks the specific capability.
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
          reason: 'Bootstrapped from GLOBAL_ADMIN_DISCORD_IDS',
        },
        update: { revokedAt: null },
      });
    }
  }
  console.log(`Bootstrapped ${ids.length} global administrator(s).`);
}

/**
 * A miniature but realistic community: a main guild, two department guilds, managed
 * roles, a one-way mapping, a two-way mapping and a grantable role.
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
      features: ['mappings', 'grants'],
    },
    update: { name: 'Florida Roleplay Community' },
  });

  const hcsoGuild = await prisma.approvedGuild.upsert({
    where: { discordGuildId: env.DEV_GUILD_IDS[1] ?? demoSnowflake(2) },
    create: {
      discordGuildId: env.DEV_GUILD_IDS[1] ?? demoSnowflake(2),
      name: "Hillsborough County Sheriff's Office",
      type: GuildType.DEPARTMENT,
      features: ['mappings'],
    },
    update: {},
  });

  const fhpGuild = await prisma.approvedGuild.upsert({
    where: { discordGuildId: env.DEV_GUILD_IDS[2] ?? demoSnowflake(3) },
    create: {
      discordGuildId: env.DEV_GUILD_IDS[2] ?? demoSnowflake(3),
      name: 'Florida Highway Patrol',
      type: GuildType.DEPARTMENT,
      features: ['mappings'],
    },
    update: {},
  });

  /** Declares a managed role. */
  const managedRole = (
    guild,
    roleId,
    name,
    purpose = RolePurpose.MAPPING,
    protectionLevel = 'NONE',
  ) =>
    prisma.managedRole.upsert({
      where: {
        approvedGuildId_discordRoleId: { approvedGuildId: guild.id, discordRoleId: roleId },
      },
      create: {
        approvedGuildId: guild.id,
        discordRoleId: roleId,
        name,
        purpose,
        protectionLevel,
      },
      update: { name, purpose, protectionLevel },
    });

  await managedRole(mainGuild, demoSnowflake(400), 'HCSO Member');
  await managedRole(hcsoGuild, demoSnowflake(401), 'Department Member');
  await managedRole(mainGuild, demoSnowflake(402), 'FHP Member');
  await managedRole(fhpGuild, demoSnowflake(403), 'Department Member');
  await managedRole(mainGuild, demoSnowflake(430), 'Media Team');
  await managedRole(hcsoGuild, demoSnowflake(431), 'Media Team');

  const investigationAccess = await managedRole(
    hcsoGuild,
    demoSnowflake(440),
    'Investigation Access',
    RolePurpose.MANUAL_GRANT,
  );

  // A one-way mapping: the community membership role grants the department guild role.
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
      authority: AuthoritySource.SOURCE_DISCORD,
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

  // A demo member holding a manual grant.
  const demoDiscordId = demoSnowflake(500);
  const identity = await prisma.discordIdentity.findUnique({
    where: { discordUserId: demoDiscordId },
  });
  const demoUser =
    identity ??
    (await prisma.user
      .create({
        data: {
          displayName: 'Demo Member',
          primaryDiscordId: demoDiscordId,
          websiteAccess: true,
          discordIdentities: { create: { discordUserId: demoDiscordId, isPrimary: true } },
        },
      })
      .then((created) => ({ userId: created.id })));

  const hasGrant = await prisma.manualRoleGrant.findFirst({
    where: { userId: demoUser.userId, managedRoleId: investigationAccess.id, revokedAt: null },
  });
  if (!hasGrant) {
    await prisma.manualRoleGrant.create({
      data: {
        userId: demoUser.userId,
        managedRoleId: investigationAccess.id,
        reason: 'Demo seed: temporary investigation access',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
  }

  console.log(
    'Seeded demo community: 3 guilds, 7 managed roles, 2 mappings, 1 member with a grant.',
  );
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
