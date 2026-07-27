/**
 * Core service behaviour against a real database.
 *
 * These cover the rules that only exist once the pieces are wired together: allowlist
 * enforcement, department scoping, rank ceilings, transactional audit records, and
 * mapping validation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMapping,
  discordContext,
  hireMember,
  isGuildApproved,
  listGuilds,
  promoteMember,
  registerGuild,
  removeGuild,
  requireApprovedGuild,
  grantPermission,
  setMappingEnabled,
  suspendMember,
} from '@frm/core';
import { loadActorByDiscordId } from '@frm/authorization';
import { closeQueues, closeRedis } from '@frm/queue';
import { disconnectPrisma } from '@frm/database';
import {
  AuthoritySource,
  GuildType,
  MappingDirection,
  MembershipStatus,
  PermissionScopeType,
} from '@frm/shared';
import { isPostgresAvailable, isRedisAvailable } from '../helpers/services.js';
import {
  IDS,
  buildMockGateway,
  disconnectTestPrisma,
  resetDatabase,
  seedCommunity,
  testPrisma,
} from '../helpers/fixtures.js';

const available = (await isPostgresAvailable()) && (await isRedisAvailable());

describe.skipIf(!available)('core services', () => {
  let fixtures;
  let gateway;
  let adminCtx;
  let sheriffCtx;

  beforeAll(async () => {
    await resetDatabase();
  });

  beforeEach(async () => {
    await resetDatabase();
    fixtures = await seedCommunity();
    gateway = buildMockGateway();
    adminCtx = discordContext(await loadActorByDiscordId(IDS.D_ADMIN), {
      discordGuildId: IDS.MAIN_GUILD,
    });
    sheriffCtx = discordContext(await loadActorByDiscordId(IDS.D_SHERIFF), {
      discordGuildId: IDS.HCSO_GUILD,
    });
  });

  afterAll(async () => {
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await disconnectTestPrisma();
  });

  // -------------------------------------------------------------------------
  describe('approved guild allowlist', () => {
    it('accepts an approved, enabled guild', async () => {
      const guild = await requireApprovedGuild(IDS.MAIN_GUILD);
      expect(guild.name).toBe('Florida Roleplay Community');
      expect(await isGuildApproved(IDS.MAIN_GUILD)).toBe(true);
    });

    it('refuses a guild that was never approved', async () => {
      await expect(requireApprovedGuild('999999999999999999')).rejects.toThrow(/allowlist/i);
      expect(await isGuildApproved('999999999999999999')).toBe(false);
    });

    it('refuses a guild that has been disabled', async () => {
      await testPrisma().approvedGuild.update({
        where: { id: fixtures.guilds.hcsoGuild.id },
        data: { enabled: false },
      });
      await expect(requireApprovedGuild(IDS.HCSO_GUILD)).rejects.toThrow(/allowlist/i);
    });

    it('refuses registration by somebody without guild.register', async () => {
      await expect(
        registerGuild(
          sheriffCtx,
          {
            discordGuildId: '888888888888888888',
            name: 'Random Server',
            type: GuildType.OTHER,
            reason: 'trying it on',
          },
          { gateway },
        ),
      ).rejects.toThrow(/do not have the guild.register/i);
    });

    it('refuses registration when the bot is not in the guild', async () => {
      await expect(
        registerGuild(
          adminCtx,
          {
            discordGuildId: '888888888888888888',
            name: 'Server the bot is not in',
            type: GuildType.OTHER,
            reason: 'test',
          },
          { gateway },
        ),
      ).rejects.toThrow(/bot is not in that Discord server/i);
    });

    it('registers a guild the bot is in and audits it', async () => {
      gateway.defineGuild({ id: '888888888888888888', name: 'New Department' });

      const { guild } = await registerGuild(
        adminCtx,
        {
          discordGuildId: '888888888888888888',
          name: 'New Department',
          type: GuildType.DEPARTMENT,
          reason: 'onboarding a new department',
        },
        { gateway },
      );

      expect(guild.enabled).toBe(true);

      const audit = await testPrisma().auditLog.findFirst({
        where: { action: 'guild.registered', approvedGuildId: guild.id },
      });
      expect(audit).not.toBeNull();
      expect(audit.actorUserId).toBe(fixtures.users.admin.id);
      expect(audit.reason).toBe('onboarding a new department');
    });

    it('disables every mapping when a guild is removed', async () => {
      const mapping = await testPrisma().roleMapping.create({
        data: {
          name: 'test mapping',
          sourceGuildId: fixtures.guilds.mainGuild.id,
          sourceRoleId: IDS.R_MAIN_HCSO_MEMBER,
          targetGuildId: fixtures.guilds.hcsoGuild.id,
          targetRoleId: IDS.R_HCSO_MEMBER,
          enabled: true,
        },
      });

      const result = await removeGuild(adminCtx, {
        guildId: fixtures.guilds.hcsoGuild.id,
        reason: 'department closed',
      });

      expect(result.disabledMappings).toBe(1);
      const after = await testPrisma().roleMapping.findUnique({ where: { id: mapping.id } });
      expect(after.enabled).toBe(false);
      expect(await isGuildApproved(IDS.HCSO_GUILD)).toBe(false);
    });

    it('only lists guilds the actor may see', async () => {
      const page = await listGuilds(adminCtx, {});
      expect(page.items.length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  describe('roster actions and scoping', () => {
    it('lets the sheriff promote their own deputy', async () => {
      const result = await promoteMember(sheriffCtx, {
        departmentId: fixtures.departments.hcso.id,
        discordUserId: IDS.D_DEPUTY,
        rankId: fixtures.ranks.corporal.id,
        reason: 'earned it',
      });

      expect(result.membership.rankId).toBe(fixtures.ranks.corporal.id);

      const audit = await testPrisma().auditLog.findFirst({
        where: { action: 'roster.promoted', targetUserId: fixtures.users.deputy.id },
      });
      expect(audit).not.toBeNull();
      expect(audit.previousState.rankName).toBe('Deputy');
      expect(audit.newState.rankName).toBe('Corporal');

      // The membership event and the sync job are written in the same transaction.
      const event = await testPrisma().membershipEvent.findFirst({
        where: { membershipId: fixtures.memberships.deputy.id, type: 'PROMOTED' },
      });
      expect(event).not.toBeNull();
      expect(result.syncJob.type).toBe('ROSTER_CHANGE');
    });

    it('refuses a promotion above the rank ceiling', async () => {
      await expect(
        promoteMember(sheriffCtx, {
          departmentId: fixtures.departments.hcso.id,
          discordUserId: IDS.D_DEPUTY,
          rankId: fixtures.ranks.colonel.id, // above the Major ceiling
          reason: 'too far',
        }),
      ).rejects.toThrow(/above the maximum rank/i);
    });

    it('refuses acting on another department', async () => {
      await expect(
        promoteMember(sheriffCtx, {
          departmentId: fixtures.departments.fhp.id,
          discordUserId: IDS.D_TROOPER,
          rankId: fixtures.ranks.trooper.id,
          reason: 'not mine to give',
        }),
      ).rejects.toThrow(/do not have roster.promote/i);
    });

    it('refuses a promotion that is not upwards', async () => {
      await promoteMember(sheriffCtx, {
        departmentId: fixtures.departments.hcso.id,
        discordUserId: IDS.D_DEPUTY,
        rankId: fixtures.ranks.sergeant.id,
        reason: 'first promotion',
      });

      await expect(
        promoteMember(sheriffCtx, {
          departmentId: fixtures.departments.hcso.id,
          discordUserId: IDS.D_DEPUTY,
          rankId: fixtures.ranks.corporal.id,
          reason: 'wrong direction',
        }),
      ).rejects.toThrow(/not above/i);
    });

    it('refuses to let somebody promote themselves', async () => {
      await hireMember(adminCtx, {
        departmentId: fixtures.departments.hcso.id,
        discordUserId: IDS.D_SHERIFF,
        rankId: fixtures.ranks.deputy.id,
        reason: 'sheriff joins their own roster',
      });

      const error = await promoteMember(sheriffCtx, {
        departmentId: fixtures.departments.hcso.id,
        discordUserId: IDS.D_SHERIFF,
        rankId: fixtures.ranks.corporal.id,
        reason: 'self promotion',
      }).catch((thrown) => thrown);

      expect(error.code).toBe('SELF_MANAGEMENT');
      expect(error.userMessage).toMatch(/yourself/i);
    });

    it('refuses a duplicate hire', async () => {
      await expect(
        hireMember(sheriffCtx, {
          departmentId: fixtures.departments.hcso.id,
          discordUserId: IDS.D_DEPUTY,
          rankId: fixtures.ranks.deputy.id,
          reason: 'already hired',
        }),
      ).rejects.toThrow(/already on the/i);
    });

    it('creates a member record when hiring an unknown Discord account', async () => {
      const result = await hireMember(sheriffCtx, {
        departmentId: fixtures.departments.hcso.id,
        discordUserId: IDS.D_UNLINKED,
        rankId: fixtures.ranks.deputy.id,
        callsign: 'H-555',
        reason: 'new recruit',
      });

      expect(result.membership.callsign).toBe('H-555');
      const identity = await testPrisma().discordIdentity.findUnique({
        where: { discordUserId: IDS.D_UNLINKED },
      });
      expect(identity).not.toBeNull();
    });

    it('refuses a duplicate callsign within a department', async () => {
      await expect(
        hireMember(sheriffCtx, {
          departmentId: fixtures.departments.hcso.id,
          discordUserId: IDS.D_UNLINKED,
          rankId: fixtures.ranks.deputy.id,
          callsign: 'H-101', // already used by the demo deputy
          reason: 'clashing callsign',
        }),
      ).rejects.toThrow(/already in use/i);
    });

    it('records status changes with their reason', async () => {
      const result = await suspendMember(sheriffCtx, {
        departmentId: fixtures.departments.hcso.id,
        discordUserId: IDS.D_DEPUTY,
        reason: 'pending investigation',
      });

      expect(result.membership.status).toBe(MembershipStatus.SUSPENDED);
      expect(result.membership.statusReason).toBe('pending investigation');

      const audit = await testPrisma().auditLog.findFirst({
        where: { action: 'roster.suspended', targetUserId: fixtures.users.deputy.id },
      });
      expect(audit.reason).toBe('pending investigation');
    });
  });

  // -------------------------------------------------------------------------
  describe('permission escalation', () => {
    it('refuses to grant a capability the granter does not hold', async () => {
      await expect(
        grantPermission(sheriffCtx, {
          discordUserId: IDS.D_DEPUTY,
          capability: 'guild.register',
          scopeType: PermissionScopeType.GLOBAL,
          reason: 'escalation attempt',
        }),
      ).rejects.toThrow();
    });

    it('refuses to grant a rank ceiling above the granter own', async () => {
      await testPrisma().user.update({
        where: { id: fixtures.users.deputy.id },
        data: { permissionLevel: 40 },
      });

      await expect(
        grantPermission(sheriffCtx, {
          discordUserId: IDS.D_DEPUTY,
          capability: 'roster.promote',
          scopeType: PermissionScopeType.DEPARTMENT,
          scopeId: fixtures.departments.hcso.id,
          maxRankOrder: 70, // above the sheriff's Major ceiling
          maxPermissionLevel: 20,
          reason: 'too much authority',
        }),
      ).rejects.toThrow(/rank ceiling above your own/i);
    });

    it('allows a narrower delegation and audits it', async () => {
      await testPrisma().user.update({
        where: { id: fixtures.users.deputy.id },
        data: { permissionLevel: 40 },
      });

      const assignment = await grantPermission(adminCtx, {
        discordUserId: IDS.D_DEPUTY,
        capability: 'roster.promote',
        scopeType: PermissionScopeType.DEPARTMENT,
        scopeId: fixtures.departments.hcso.id,
        maxRankOrder: 20,
        maxPermissionLevel: 20,
        reason: 'delegating promotions up to Corporal',
      });

      expect(assignment.maxRankOrder).toBe(20);
      const audit = await testPrisma().auditLog.findFirst({
        where: { action: 'permission.granted', targetUserId: fixtures.users.deputy.id },
      });
      expect(audit).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('mapping validation', () => {
    const baseMapping = {
      name: 'HCSO member sync',
      sourceGuildId: IDS.MAIN_GUILD,
      sourceRoleId: IDS.R_MAIN_HCSO_MEMBER,
      targetGuildId: IDS.HCSO_GUILD,
      targetRoleId: IDS.R_HCSO_MEMBER,
      reason: 'link the community role to the department role',
    };

    it('creates and enables a valid mapping', async () => {
      const { mapping } = await createMapping(
        adminCtx,
        { ...baseMapping, enabled: true },
        { gateway },
      );
      expect(mapping.enabled).toBe(true);
      expect(mapping.direction).toBe(MappingDirection.ONE_WAY);
    });

    it('refuses a mapping into a guild that is not approved', async () => {
      await expect(
        createMapping(
          adminCtx,
          { ...baseMapping, targetGuildId: '888888888888888888' },
          { gateway },
        ),
      ).rejects.toThrow(/allowlist/i);
    });

    it('refuses a mapping onto a role above the bot', async () => {
      await expect(
        createMapping(
          adminCtx,
          { ...baseMapping, targetRoleId: IDS.R_ABOVE_BOT, enabled: true },
          { gateway },
        ),
      ).rejects.toThrow(/above the bot's highest role/i);
    });

    it('refuses a mapping onto an integration-owned role', async () => {
      await expect(
        createMapping(
          adminCtx,
          { ...baseMapping, targetRoleId: IDS.R_INTEGRATION, enabled: true },
          { gateway },
        ),
      ).rejects.toThrow(/another integration/i);
    });

    it('refuses a protected role without the elevated capability', async () => {
      // The sheriff has no mapping capabilities at all, so grant just enough to reach
      // the protection check and prove that is what stops them.
      await testPrisma().user.update({
        where: { id: fixtures.users.sheriff.id },
        data: { permissionLevel: 80 },
      });
      await grantPermission(adminCtx, {
        discordUserId: IDS.D_SHERIFF,
        capability: 'mapping.create',
        scopeType: PermissionScopeType.GLOBAL,
        maxPermissionLevel: 40,
        reason: 'test setup',
      });
      const ctx = discordContext(await loadActorByDiscordId(IDS.D_SHERIFF), {
        discordGuildId: IDS.HCSO_GUILD,
      });

      await expect(
        createMapping(ctx, { ...baseMapping, targetRoleId: IDS.R_PROTECTED }, { gateway }),
      ).rejects.toThrow(/protected/i);
    });

    it('rejects a mapping that would close a synchronization loop', async () => {
      await createMapping(adminCtx, { ...baseMapping, enabled: true }, { gateway });

      await expect(
        createMapping(
          adminCtx,
          {
            name: 'reverse mapping',
            sourceGuildId: IDS.HCSO_GUILD,
            sourceRoleId: IDS.R_HCSO_MEMBER,
            targetGuildId: IDS.MAIN_GUILD,
            targetRoleId: IDS.R_MAIN_HCSO_MEMBER,
            enabled: true,
            reason: 'creating a loop',
          },
          { gateway },
        ),
      ).rejects.toThrow(/loop/i);
    });

    it('accepts a two-way mapping, which is not a loop', async () => {
      const { mapping } = await createMapping(
        adminCtx,
        {
          name: 'Media Team',
          sourceGuildId: IDS.MAIN_GUILD,
          sourceRoleId: IDS.R_MAIN_MEDIA,
          targetGuildId: IDS.HCSO_GUILD,
          targetRoleId: IDS.R_HCSO_MEDIA,
          direction: MappingDirection.TWO_WAY,
          authority: AuthoritySource.SOURCE_DISCORD,
          enabled: true,
          reason: 'two-way community role',
        },
        { gateway },
      );

      expect(mapping.enabled).toBe(true);
      expect(mapping.direction).toBe(MappingDirection.TWO_WAY);
    });

    it('refuses to enable a mapping without a live Discord connection', async () => {
      const { mapping } = await createMapping(adminCtx, baseMapping, { gateway });

      await expect(
        setMappingEnabled(adminCtx, {
          mappingId: mapping.id,
          enabled: true,
          reason: 'no gateway available',
        }),
      ).rejects.toThrow(/live Discord connection/i);
    });

    it('creates a mapping disabled when it cannot be validated', async () => {
      const { mapping, warnings } = await createMapping(adminCtx, {
        ...baseMapping,
        enabled: true,
      });
      expect(mapping.enabled).toBe(false);
      expect(warnings.join(' ')).toMatch(/could not be validated/i);
    });
  });
});
