/**
 * Discord-role access tiers, end to end.
 *
 * Against a real database and the mock gateway: an admin maps a main-guild role to a tier,
 * a linked member who holds it is raised to that tier, an unlinked holder is auto-provisioned
 * an account, and someone with neither an account nor a mapped role is refused. Also covers
 * the guardrails: editing needs the capability and must run from the main community server.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  discordContext,
  listAccessTiers,
  removeAccessTier,
  resolveDiscordActor,
  setAccessTier,
} from '@frm/core';
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

const STAFF_ROLE = '950000000000000009';
const NEW_STAFF = '950000000000000001'; // an unlinked Discord id holding the staff role

describe.skipIf(!available)('discord-role access tiers', () => {
  let gateway;
  let prisma;
  let adminCtx;

  beforeEach(async () => {
    await resetDatabase();
    await seedCommunity();
    prisma = testPrisma();
    gateway = buildMockGateway();

    gateway.defineRole(IDS.MAIN_GUILD, { id: STAFF_ROLE, name: 'Staff' });
    // A linked member and an unlinked member, both holding the staff role in the main guild.
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_MEMBER, roleIds: [STAFF_ROLE] });
    gateway.defineMember(IDS.MAIN_GUILD, { id: NEW_STAFF, roleIds: [STAFF_ROLE] });

    adminCtx = discordContext(await loadActorByDiscordId(IDS.D_ADMIN), {
      discordGuildId: IDS.MAIN_GUILD,
    });
  });

  afterAll(async () => {
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await disconnectTestPrisma();
  });

  const mapStaff = (level = 80) =>
    setAccessTier(adminCtx, {
      discordRoleId: STAFF_ROLE,
      roleName: 'Staff',
      level,
      reason: 'setup',
    });

  describe('config', () => {
    it('maps, lists and removes a role tier', async () => {
      await mapStaff(80);

      let tiers = await listAccessTiers(adminCtx);
      expect(tiers).toHaveLength(1);
      expect(tiers[0]).toMatchObject({ discordRoleId: STAFF_ROLE, permissionLevel: 80 });

      const removed = await removeAccessTier(adminCtx, { discordRoleId: STAFF_ROLE });
      expect(removed.removed).toBe(true);
      tiers = await listAccessTiers(adminCtx);
      expect(tiers).toHaveLength(0);
    });

    it('updates the tier on a re-map instead of duplicating', async () => {
      await mapStaff(40);
      await mapStaff(80);
      const tiers = await listAccessTiers(adminCtx);
      expect(tiers).toHaveLength(1);
      expect(tiers[0].permissionLevel).toBe(80);
    });

    it('refuses editing from outside the main community server', async () => {
      const deptCtx = discordContext(await loadActorByDiscordId(IDS.D_ADMIN), {
        discordGuildId: IDS.HCSO_GUILD,
      });
      await expect(
        setAccessTier(deptCtx, { discordRoleId: STAFF_ROLE, roleName: 'Staff', level: 80 }),
      ).rejects.toThrow(/main community server/i);
    });

    it('refuses an editor without access.manage', async () => {
      const guildAdminCtx = discordContext(await loadActorByDiscordId(IDS.D_GUILD_ADMIN), {
        discordGuildId: IDS.MAIN_GUILD,
      });
      await expect(
        setAccessTier(guildAdminCtx, { discordRoleId: STAFF_ROLE, roleName: 'Staff', level: 80 }),
      ).rejects.toThrow(/access\.manage/i);
    });
  });

  describe('resolving the actor', () => {
    it('raises a linked member who holds the mapped role', async () => {
      await mapStaff(80);

      const actor = await resolveDiscordActor({ discordUserId: IDS.D_MEMBER, gateway, prisma });
      expect(actor.user.permissionLevel).toBe(80);
      expect(actor.assignments.some((a) => a.capabilityKey === 'mapping.create')).toBe(true);
    });

    it('leaves a linked member without the role at their base level', async () => {
      await mapStaff(80);

      // D_OTHER is in the main guild but holds no mapped role.
      const actor = await resolveDiscordActor({ discordUserId: IDS.D_OTHER, gateway, prisma });
      expect(actor.user.permissionLevel).toBe(0);
      expect(actor.assignments.some((a) => a.capabilityKey === 'mapping.create')).toBe(false);
    });

    it('auto-provisions an unlinked member who holds the role', async () => {
      await mapStaff(80);
      expect(await prisma.user.count({ where: { primaryDiscordId: NEW_STAFF } })).toBe(0);

      const actor = await resolveDiscordActor({
        discordUserId: NEW_STAFF,
        displayName: 'New Staffer',
        gateway,
        prisma,
      });
      expect(actor.user.permissionLevel).toBe(80);

      const user = await prisma.user.findFirst({ where: { primaryDiscordId: NEW_STAFF } });
      expect(user).not.toBeNull();
      // The account itself carries no persisted authority; the tier is recomputed live.
      expect(user.permissionLevel).toBe(0);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'member.auto_provisioned', targetDiscordId: NEW_STAFF },
      });
      expect(audit).not.toBeNull();
    });

    it('does not create a second account on a repeat visit', async () => {
      await mapStaff(80);
      await resolveDiscordActor({ discordUserId: NEW_STAFF, gateway, prisma });
      await resolveDiscordActor({ discordUserId: NEW_STAFF, gateway, prisma });
      expect(await prisma.user.count({ where: { primaryDiscordId: NEW_STAFF } })).toBe(1);
    });

    it('refuses an unlinked member who holds no mapped role', async () => {
      await mapStaff(80);
      // D_UNLINKED is in the main guild with no roles, and has no platform account.
      await expect(
        resolveDiscordActor({ discordUserId: IDS.D_UNLINKED, gateway, prisma }),
      ).rejects.toThrow();
    });

    it('loses the tier when the mapping is removed', async () => {
      await mapStaff(80);
      await removeAccessTier(adminCtx, { discordRoleId: STAFF_ROLE });

      const actor = await resolveDiscordActor({ discordUserId: IDS.D_MEMBER, gateway, prisma });
      expect(actor.user.permissionLevel).toBe(0);
    });
  });
});
