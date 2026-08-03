/**
 * Core service behaviour against a real database.
 *
 * These cover the rules that only exist once the pieces are wired together: allowlist
 * enforcement, guild scoping, transactional audit records, mapping validation and the
 * manual grant lifecycle.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMapping,
  discordContext,
  grantPermission,
  isGuildApproved,
  issueGrant,
  listGuilds,
  listManagedRoles,
  registerGuild,
  removeGuild,
  requireApprovedGuild,
  revokeGrant,
  setMappingEnabled,
  upsertManagedRole,
} from '@frm/core';
import { loadActorByDiscordId } from '@frm/authorization';
import { closeQueues, closeRedis } from '@frm/queue';
import { disconnectPrisma } from '@frm/database';
import {
  AuthoritySource,
  GuildType,
  MappingDirection,
  PermissionScopeType,
  RolePurpose,
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
  let guildAdminCtx;

  beforeEach(async () => {
    await resetDatabase();
    fixtures = await seedCommunity();
    gateway = buildMockGateway();
    adminCtx = discordContext(await loadActorByDiscordId(IDS.D_ADMIN), {
      discordGuildId: IDS.MAIN_GUILD,
    });
    guildAdminCtx = discordContext(await loadActorByDiscordId(IDS.D_GUILD_ADMIN), {
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
          guildAdminCtx,
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
      gateway.defineGuild({ id: '888888888888888888', name: 'New Server' });

      const { guild } = await registerGuild(
        adminCtx,
        {
          discordGuildId: '888888888888888888',
          name: 'New Server',
          type: GuildType.DEPARTMENT,
          reason: 'onboarding a new server',
        },
        { gateway },
      );

      expect(guild.enabled).toBe(true);

      const audit = await testPrisma().auditLog.findFirst({
        where: { action: 'guild.registered', approvedGuildId: guild.id },
      });
      expect(audit).not.toBeNull();
      expect(audit.actorUserId).toBe(fixtures.users.admin.id);
      expect(audit.reason).toBe('onboarding a new server');
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
        reason: 'server closed',
      });

      expect(result.disabledMappings).toBe(1);
      const after = await testPrisma().roleMapping.findUnique({ where: { id: mapping.id } });
      expect(after.enabled).toBe(false);
      expect(await isGuildApproved(IDS.HCSO_GUILD)).toBe(false);
    });

    it('only lists guilds the actor may see', async () => {
      expect((await listGuilds(adminCtx, {})).items).toHaveLength(3);

      // The guild administrator's grants are scoped to one guild.
      const scoped = await listGuilds(guildAdminCtx, {});
      expect(scoped.items).toHaveLength(1);
      expect(scoped.items[0].discordGuildId).toBe(IDS.HCSO_GUILD);
    });
  });

  // -------------------------------------------------------------------------
  describe('managed roles', () => {
    it('declares a role as managed and audits it', async () => {
      const managed = await upsertManagedRole(
        guildAdminCtx,
        {
          guildId: fixtures.guilds.hcsoGuild.id,
          discordRoleId: IDS.R_UNMANAGED,
          name: 'Gaming Nights',
          purpose: RolePurpose.MANUAL_GRANT,
          reason: 'grantable community role',
        },
        { gateway },
      );

      expect(managed.purpose).toBe(RolePurpose.MANUAL_GRANT);
      const audit = await testPrisma().auditLog.findFirst({
        where: { action: 'managed_role.upserted' },
      });
      expect(audit).not.toBeNull();
    });

    it('refuses a role in a guild the actor does not administer', async () => {
      await expect(
        upsertManagedRole(
          guildAdminCtx,
          {
            guildId: fixtures.guilds.fhpGuild.id,
            discordRoleId: IDS.R_FHP_MEMBER,
            name: 'Department Member',
            reason: 'outside my guild',
          },
          { gateway },
        ),
      ).rejects.toThrow(/do not have role.manage/i);
    });

    it('refuses a role that does not exist in Discord', async () => {
      await expect(
        upsertManagedRole(
          adminCtx,
          {
            guildId: fixtures.guilds.hcsoGuild.id,
            discordRoleId: '888888888888888888',
            name: 'Ghost role',
            reason: 'typo in the snowflake',
          },
          { gateway },
        ),
      ).rejects.toThrow(/not found/i);
    });

    it('refuses an integration-owned role', async () => {
      await expect(
        upsertManagedRole(
          adminCtx,
          {
            guildId: fixtures.guilds.hcsoGuild.id,
            discordRoleId: IDS.R_INTEGRATION,
            name: 'Server Booster',
            reason: 'cannot be managed',
          },
          { gateway },
        ),
      ).rejects.toThrow(/another integration/i);
    });

    it('scopes the listing to the actor guilds', async () => {
      const page = await listManagedRoles(guildAdminCtx, {});
      expect(page.items.every((role) => role.guild.discordGuildId === IDS.HCSO_GUILD)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('manual grants', () => {
    it('issues a grant and queues the synchronization', async () => {
      const result = await issueGrant(guildAdminCtx, {
        discordUserId: IDS.D_MEMBER,
        managedRoleId: fixtures.managedRoles.grantable.id,
        reason: 'temporary investigation access',
      });

      expect(result.grant.revokedAt).toBeNull();
      expect(result.syncJob.type).toBe('GRANT_CHANGE');

      const audit = await testPrisma().auditLog.findFirst({ where: { action: 'grant.issued' } });
      expect(audit).not.toBeNull();
      expect(audit.syncJobId).toBe(result.syncJob.id);
    });

    it('refuses to grant a mapping-driven role', async () => {
      // Granting a role that reconciliation computes from a mapping would be undone on
      // the next pass, which is a deeply confusing thing to debug.
      await expect(
        issueGrant(guildAdminCtx, {
          discordUserId: IDS.D_MEMBER,
          managedRoleId: fixtures.managedRoles.hcsoMember.id,
          reason: 'wrong kind of role',
        }),
      ).rejects.toThrow(/MANUAL_GRANT/);
    });

    it('refuses a duplicate active grant', async () => {
      const input = {
        discordUserId: IDS.D_MEMBER,
        managedRoleId: fixtures.managedRoles.grantable.id,
        reason: 'first grant',
      };
      await issueGrant(guildAdminCtx, input);
      await expect(issueGrant(guildAdminCtx, input)).rejects.toThrow(/already holds/i);
    });

    it('refuses a grant for a guild the actor does not administer', async () => {
      const fhpRole = await testPrisma().managedRole.create({
        data: {
          approvedGuildId: fixtures.guilds.fhpGuild.id,
          discordRoleId: '920000000000000077',
          name: 'FHP Special Access',
          purpose: RolePurpose.MANUAL_GRANT,
        },
      });

      await expect(
        issueGrant(guildAdminCtx, {
          discordUserId: IDS.D_MEMBER,
          managedRoleId: fhpRole.id,
          reason: 'outside my guild',
        }),
      ).rejects.toThrow(/do not have grant.issue/i);
    });

    it('revokes a grant and queues the removal', async () => {
      const issued = await issueGrant(guildAdminCtx, {
        discordUserId: IDS.D_MEMBER,
        managedRoleId: fixtures.managedRoles.grantable.id,
        reason: 'temporary access',
      });

      const result = await revokeGrant(guildAdminCtx, {
        grantId: issued.grant.id,
        reason: 'no longer needed',
      });

      expect(result.grant.revokedAt).not.toBeNull();
      const audit = await testPrisma().auditLog.findFirst({ where: { action: 'grant.revoked' } });
      expect(audit).not.toBeNull();
    });

    it('refuses to grant to somebody at or above the actor authority', async () => {
      await expect(
        issueGrant(guildAdminCtx, {
          discordUserId: IDS.D_ADMIN,
          managedRoleId: fixtures.managedRoles.grantable.id,
          reason: 'targeting an administrator',
        }),
      ).rejects.toThrow(/authority/i);
    });
  });

  // -------------------------------------------------------------------------
  describe('permission escalation', () => {
    it('refuses to grant a capability the granter does not hold', async () => {
      await expect(
        grantPermission(guildAdminCtx, {
          discordUserId: IDS.D_MEMBER,
          capability: 'guild.register',
          scopeType: PermissionScopeType.GLOBAL,
          reason: 'escalation attempt',
        }),
      ).rejects.toThrow();
    });

    it('refuses to grant outside the granter guild', async () => {
      // `sync.member` is held by the guild administrator, but only for HCSO.
      await raiseMemberTo(40);

      await expect(
        grantPermission(guildAdminCtx, {
          discordUserId: IDS.D_MEMBER,
          capability: 'sync.member',
          scopeType: PermissionScopeType.GUILD,
          scopeId: fixtures.guilds.fhpGuild.id,
          maxPermissionLevel: 20,
          reason: 'another guild',
        }),
      ).rejects.toThrow(/for this guild/i);
    });

    it('refuses to grant a capability the target is not senior enough to hold', async () => {
      // The member is at level 0; `mapping.create` requires 80 to hold at all.
      await expect(
        grantPermission(guildAdminCtx, {
          discordUserId: IDS.D_MEMBER,
          capability: 'mapping.create',
          scopeType: PermissionScopeType.GUILD,
          scopeId: fixtures.guilds.hcsoGuild.id,
          maxPermissionLevel: 20,
          reason: 'granting above their level',
        }),
      ).rejects.toThrow(/requires authority level 80/i);
    });

    it('refuses to grant an authority ceiling at or above the granter own level', async () => {
      await raiseMemberTo(40);

      await expect(
        grantPermission(guildAdminCtx, {
          discordUserId: IDS.D_MEMBER,
          capability: 'sync.member',
          scopeType: PermissionScopeType.GUILD,
          scopeId: fixtures.guilds.hcsoGuild.id,
          maxPermissionLevel: 80, // the guild admin is itself 80
          reason: 'too much authority',
        }),
      ).rejects.toThrow(/at or above your own level/i);
    });

    it('allows a narrower delegation and audits it', async () => {
      await raiseMemberTo(40);

      const assignment = await grantPermission(guildAdminCtx, {
        discordUserId: IDS.D_MEMBER,
        capability: 'sync.member',
        scopeType: PermissionScopeType.GUILD,
        scopeId: fixtures.guilds.hcsoGuild.id,
        maxPermissionLevel: 20,
        reason: 'delegating member resyncs',
      });

      expect(assignment.maxPermissionLevel).toBe(20);
      const audit = await testPrisma().auditLog.findFirst({
        where: { action: 'permission.granted', targetUserId: fixtures.users.member.id },
      });
      expect(audit).not.toBeNull();
    });

    async function raiseMemberTo(permissionLevel) {
      await testPrisma().user.update({
        where: { id: fixtures.users.member.id },
        data: { permissionLevel },
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('mapping validation', () => {
    const baseMapping = {
      name: 'HCSO member sync',
      sourceGuildId: IDS.MAIN_GUILD,
      sourceRoleId: IDS.R_MAIN_HCSO_MEMBER,
      targetGuildId: IDS.HCSO_GUILD,
      targetRoleId: IDS.R_HCSO_MEMBER,
      reason: 'link the community role to the guild role',
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

    it('requires authorization for BOTH guilds', async () => {
      // The guild administrator controls HCSO but not the main community guild.
      await expect(
        createMapping(guildAdminCtx, { ...baseMapping, enabled: true }, { gateway }),
      ).rejects.toThrow(/do not have mapping.create/i);
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
      await testPrisma().user.update({
        where: { id: fixtures.users.guildAdmin.id },
        data: { permissionLevel: 80 },
      });
      await grantPermission(adminCtx, {
        discordUserId: IDS.D_GUILD_ADMIN,
        capability: 'mapping.create',
        scopeType: PermissionScopeType.GLOBAL,
        maxPermissionLevel: 40,
        reason: 'test setup',
      });
      const ctx = discordContext(await loadActorByDiscordId(IDS.D_GUILD_ADMIN), {
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
