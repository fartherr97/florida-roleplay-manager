/**
 * Department server provisioning, end to end.
 *
 * The engine is exercised against the mock gateway and a real database: it creates the
 * whole structure, skips everything on a second run, and - with wire-in on - registers
 * the server, declares its member role as managed, and maps the main community into it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { discordContext, provisionCommunity, provisionDepartment } from '@frm/core';
import { loadActorByDiscordId } from '@frm/authorization';
import { closeQueues, closeRedis } from '@frm/queue';
import { disconnectPrisma } from '@frm/database';
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

// A fresh, empty server the bot is in but that is not yet on the allowlist.
const NEW_DEPT_GUILD = '910000000000000009';

describe.skipIf(!available)('department provisioning', () => {
  let gateway;
  let adminCtx;
  let prisma;

  const base = { discordGuildId: NEW_DEPT_GUILD, name: 'HCSO', tag: 'HCSO' };

  beforeEach(async () => {
    await resetDatabase();
    await seedCommunity();
    prisma = testPrisma();
    gateway = buildMockGateway();
    // The empty department server, with the bot present and able to manage roles/channels.
    gateway.defineGuild({
      id: NEW_DEPT_GUILD,
      name: 'New Department',
      botHighestRolePosition: 100,
    });
    adminCtx = discordContext(await loadActorByDiscordId(IDS.D_ADMIN), {
      discordGuildId: NEW_DEPT_GUILD,
    });
  });

  afterAll(async () => {
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await disconnectTestPrisma();
  });

  it('creates the roles, categories and channels on an empty server', async () => {
    const result = await provisionDepartment(adminCtx, { ...base, wireIn: false }, { gateway });

    expect(result.created.roles.length).toBeGreaterThan(10);
    expect(result.created.categories.length).toBeGreaterThan(5);
    expect(result.created.channels.length).toBeGreaterThan(10);

    const channels = await gateway.listChannels(NEW_DEPT_GUILD);
    expect(channels.some((c) => c.type === 'category' && c.name === 'HCSO | Command Staff')).toBe(
      true,
    );
    // Channels are parented to their category, not left loose.
    const command = channels.find((c) => c.name === 'HCSO | Command Staff');
    expect(channels.some((c) => c.name === 'command-chat' && c.parentId === command.id)).toBe(true);
  });

  it('is idempotent: a second run creates nothing', async () => {
    await provisionDepartment(adminCtx, { ...base, wireIn: false }, { gateway });
    const callsBefore = gateway.calls.length;

    const second = await provisionDepartment(adminCtx, { ...base, wireIn: false }, { gateway });

    expect(second.created.roles).toEqual([]);
    expect(second.created.categories).toEqual([]);
    expect(second.created.channels).toEqual([]);
    expect(gateway.calls.length).toBe(callsBefore); // nothing new was created
  });

  it('repairs a partial run: a re-run recreates a channel that went missing', async () => {
    await provisionDepartment(adminCtx, { ...base, wireIn: false }, { gateway });

    // Simulate a first run that did not finish: one channel never got created. Its name is
    // shared by channels in other categories, which used to make the planner skip it.
    const channels = await gateway.listChannels(NEW_DEPT_GUILD);
    const command = channels.find((c) => c.name === 'HCSO | Command Staff');
    const commandChat = channels.find(
      (c) => c.name === 'command-chat' && c.parentId === command.id,
    );
    gateway.deleteChannel(NEW_DEPT_GUILD, commandChat.id);

    const repair = await provisionDepartment(adminCtx, { ...base, wireIn: false }, { gateway });

    expect(repair.created.channels).toContain('command-chat');
    const after = await gateway.listChannels(NEW_DEPT_GUILD);
    expect(after.some((c) => c.name === 'command-chat' && c.parentId === command.id)).toBe(true);
  });

  it('previews without creating anything on a dry run', async () => {
    const preview = await provisionDepartment(
      adminCtx,
      { ...base, wireIn: false, dryRun: true },
      { gateway },
    );

    expect(preview.dryRun).toBe(true);
    expect(preview.plan.toCreate.roles).toBeGreaterThan(0);
    expect(gateway.calls).toHaveLength(0);
  });

  it('wires the finished server into the platform', async () => {
    const result = await provisionDepartment(
      adminCtx,
      { ...base, wireIn: true, mainCommunityRoleId: IDS.R_MAIN_HCSO_MEMBER },
      { gateway },
    );

    expect(result.wiredIn.registered).toBe(true);
    expect(result.wiredIn.managedRole).toBe(true);
    expect(result.wiredIn.mapping).toBe('created');

    const guild = await prisma.approvedGuild.findFirst({
      where: { discordGuildId: NEW_DEPT_GUILD },
    });
    expect(guild).not.toBeNull();
    expect(guild.type).toBe('DEPARTMENT');

    const managed = await prisma.managedRole.findFirst({ where: { approvedGuildId: guild.id } });
    expect(managed).not.toBeNull();
    expect(managed.name).toBe('HCSO | Department Member');

    const mapping = await prisma.roleMapping.findFirst({ where: { targetGuildId: guild.id } });
    expect(mapping).not.toBeNull();
    expect(mapping.enabled).toBe(true);
    expect(mapping.sourceRoleId).toBe(IDS.R_MAIN_HCSO_MEMBER);
  });

  it('wires in but warns when no main-community role is given', async () => {
    const result = await provisionDepartment(adminCtx, { ...base, wireIn: true }, { gateway });

    expect(result.wiredIn.registered).toBe(true);
    expect(result.wiredIn.mapping).toBe('skipped');
    expect(result.warnings.join(' ')).toMatch(/no main-community role/i);
  });

  it('refuses a caller without guild.provision', async () => {
    const guildAdminCtx = discordContext(await loadActorByDiscordId(IDS.D_GUILD_ADMIN), {
      discordGuildId: NEW_DEPT_GUILD,
    });

    await expect(
      provisionDepartment(guildAdminCtx, { ...base, wireIn: false }, { gateway }),
    ).rejects.toThrow(/guild.provision/i);
  });

  it('keeps going and warns when a single channel cannot be created', async () => {
    // Simulate one unsupported channel (e.g. a forum on a non-community server): it must
    // not abort the rest of a large server's worth of structure.
    const original = gateway.createChannel.bind(gateway);
    let failed = false;
    gateway.createChannel = async (guildId, spec) => {
      if (!failed && spec.type === 'voice') {
        failed = true;
        throw Object.assign(new Error('unsupported channel'), { userMessage: 'not allowed here' });
      }
      return original(guildId, spec);
    };

    const result = await provisionDepartment(adminCtx, { ...base, wireIn: false }, { gateway });

    expect(result.warnings.some((w) => /could not create/i.test(w))).toBe(true);
    // The rest of the server was still built.
    expect(result.created.channels.length).toBeGreaterThan(5);
    expect(result.created.roles.length).toBeGreaterThan(10);
  });

  it('rejects an unsupported department tag with a clear message', async () => {
    await expect(
      provisionDepartment(adminCtx, { ...base, tag: 'XYZ' }, { gateway }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses when the bot cannot manage channels', async () => {
    gateway.defineGuild({
      id: NEW_DEPT_GUILD,
      name: 'New Department',
      botCanManageChannels: false,
      botHighestRolePosition: 100,
    });

    await expect(
      provisionDepartment(adminCtx, { ...base, wireIn: false }, { gateway }),
    ).rejects.toThrow(/Manage Channels/i);
  });

  describe('community', () => {
    // A second fresh server, to be set up as the main community hub.
    const NEW_COMMUNITY_GUILD = '910000000000000010';
    let communityCtx;

    beforeEach(async () => {
      gateway.defineGuild({
        id: NEW_COMMUNITY_GUILD,
        name: 'New Community',
        botHighestRolePosition: 100,
      });
      communityCtx = discordContext(await loadActorByDiscordId(IDS.D_ADMIN), {
        discordGuildId: NEW_COMMUNITY_GUILD,
      });
    });

    const communityBase = { discordGuildId: NEW_COMMUNITY_GUILD, name: 'New Community' };

    it('creates the structure and registers the server as the main community', async () => {
      const result = await provisionCommunity(communityCtx, communityBase, { gateway });

      expect(result.created.roles.length).toBeGreaterThan(0);
      expect(result.created.categories.length).toBeGreaterThan(0);
      expect(result.wiredIn.registered).toBe(true);

      const guild = await prisma.approvedGuild.findFirst({
        where: { discordGuildId: NEW_COMMUNITY_GUILD },
      });
      expect(guild.type).toBe('MAIN_COMMUNITY');
      // The community server has no managed role of its own.
      const managed = await prisma.managedRole.findFirst({ where: { approvedGuildId: guild.id } });
      expect(managed).toBeNull();
    });

    it('is idempotent on a second run', async () => {
      await provisionCommunity(communityCtx, communityBase, { gateway });
      const callsBefore = gateway.calls.length;

      const second = await provisionCommunity(communityCtx, communityBase, { gateway });

      expect(second.created.roles).toEqual([]);
      expect(second.created.channels).toEqual([]);
      expect(gateway.calls.length).toBe(callsBefore);
    });
  });
});
