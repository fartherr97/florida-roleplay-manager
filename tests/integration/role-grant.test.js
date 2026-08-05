/**
 * Self-service role delegation, end to end.
 *
 * Exercises the whole feature against a real database and the mock gateway: an admin edits
 * the grantor -> grantable rules, a member holding a grantor role hands roles out and takes
 * them back, and every authorization edge is enforced - editing needs the capability,
 * handing out needs the grantor role, and a role the bot cannot manage fails without
 * aborting the rest.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addGrantRule,
  applyRoleAssignment,
  discordContext,
  listAssignableRoles,
  listGrantRules,
  removeGrantRule,
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

// Roles specific to this suite, in the HCSO guild.
const GRANTOR = '940000000000000001';
const GRANTABLE_A = '940000000000000002';
const GRANTABLE_B = '940000000000000003';
const GRANTABLE_ABOVE = '940000000000000004';

describe.skipIf(!available)('self-service role delegation', () => {
  let gateway;
  let prisma;
  let adminCtx;
  let memberCtx;
  let guildAdminCtx;

  const guildId = IDS.HCSO_GUILD;

  const addBaseRules = () =>
    addGrantRule(adminCtx, {
      discordGuildId: guildId,
      grantor: { id: GRANTOR, name: 'Recruiter' },
      grantables: [
        { id: GRANTABLE_A, name: 'Trial Member' },
        { id: GRANTABLE_B, name: 'Event Ping' },
      ],
      reason: 'setup',
    });

  beforeEach(async () => {
    await resetDatabase();
    await seedCommunity();
    prisma = testPrisma();
    gateway = buildMockGateway();

    gateway.defineRole(guildId, { id: GRANTOR, name: 'Recruiter' });
    gateway.defineRole(guildId, { id: GRANTABLE_A, name: 'Trial Member' });
    gateway.defineRole(guildId, { id: GRANTABLE_B, name: 'Event Ping' });
    // A role above the bot: the bot cannot manage it.
    gateway.defineRole(guildId, { id: GRANTABLE_ABOVE, name: 'Above Bot', position: 200 });
    // The caller holds the grantor role; the target starts with nothing.
    gateway.defineMember(guildId, { id: IDS.D_MEMBER, roleIds: [GRANTOR] });
    gateway.defineMember(guildId, { id: IDS.D_OTHER, roleIds: [] });

    adminCtx = discordContext(await loadActorByDiscordId(IDS.D_ADMIN), { discordGuildId: guildId });
    memberCtx = discordContext(await loadActorByDiscordId(IDS.D_MEMBER), {
      discordGuildId: guildId,
    });
    guildAdminCtx = discordContext(await loadActorByDiscordId(IDS.D_GUILD_ADMIN), {
      discordGuildId: guildId,
    });
  });

  afterAll(async () => {
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await disconnectTestPrisma();
  });

  describe('config', () => {
    it('adds rules and is idempotent on a second run', async () => {
      const first = await addBaseRules();
      expect(first.added).toHaveLength(2);
      expect(first.skipped).toHaveLength(0);

      const second = await addBaseRules();
      expect(second.added).toHaveLength(0);
      expect(second.skipped).toHaveLength(2);

      const { groups, total } = await listGrantRules(adminCtx, { discordGuildId: guildId });
      expect(total).toBe(2);
      expect(groups).toHaveLength(1);
      expect(groups[0].grantorRoleId).toBe(GRANTOR);
      expect(groups[0].grantables.map((role) => role.id).sort()).toEqual(
        [GRANTABLE_A, GRANTABLE_B].sort(),
      );
    });

    it('warns but still adds when a grantable role is platform-managed', async () => {
      // R_GRANTABLE is seeded as a MANUAL_GRANT managed role in HCSO.
      const result = await addGrantRule(adminCtx, {
        discordGuildId: guildId,
        grantor: { id: GRANTOR, name: 'Recruiter' },
        grantables: [{ id: IDS.R_GRANTABLE, name: 'Investigation Access' }],
        reason: 'setup',
      });
      expect(result.added).toHaveLength(1);
      expect(result.warnings.join(' ')).toMatch(/platform-managed/i);
    });

    it('refuses an editor without rolegrant.manage', async () => {
      await expect(
        addGrantRule(guildAdminCtx, {
          discordGuildId: guildId,
          grantor: { id: GRANTOR, name: 'Recruiter' },
          grantables: [{ id: GRANTABLE_A, name: 'Trial Member' }],
          reason: 'nope',
        }),
      ).rejects.toThrow(/rolegrant\.manage/i);
    });

    it('removes specific grantables and, with none named, all of them', async () => {
      await addBaseRules();

      const removedOne = await removeGrantRule(adminCtx, {
        discordGuildId: guildId,
        grantorRoleId: GRANTOR,
        grantableRoleIds: [GRANTABLE_A],
        reason: 'trim',
      });
      expect(removedOne.removed).toBe(1);

      let { groups } = await listGrantRules(adminCtx, { discordGuildId: guildId });
      expect(groups[0].grantables.map((role) => role.id)).toEqual([GRANTABLE_B]);

      const removedRest = await removeGrantRule(adminCtx, {
        discordGuildId: guildId,
        grantorRoleId: GRANTOR,
        reason: 'clear',
      });
      expect(removedRest.removed).toBe(1);

      ({ groups } = await listGrantRules(adminCtx, { discordGuildId: guildId }));
      expect(groups).toHaveLength(0);
    });

    it('restores a removed rule instead of duplicating it', async () => {
      await addBaseRules();
      await removeGrantRule(adminCtx, {
        discordGuildId: guildId,
        grantorRoleId: GRANTOR,
        grantableRoleIds: [GRANTABLE_A],
        reason: 'trim',
      });
      const readd = await addGrantRule(adminCtx, {
        discordGuildId: guildId,
        grantor: { id: GRANTOR, name: 'Recruiter' },
        grantables: [{ id: GRANTABLE_A, name: 'Trial Member' }],
        reason: 'back',
      });
      expect(readd.added).toHaveLength(1);

      // No duplicate row: still exactly one active rule for (grantor, A).
      const count = await prisma.roleGrantRule.count({
        where: {
          approvedGuildId: (
            await prisma.approvedGuild.findFirst({ where: { discordGuildId: guildId } })
          ).id,
          grantorRoleId: GRANTOR,
          grantableRoleId: GRANTABLE_A,
          deletedAt: null,
        },
      });
      expect(count).toBe(1);
    });
  });

  describe('assign and remove', () => {
    beforeEach(addBaseRules);

    it('lists exactly what the caller may hand out', async () => {
      const holder = await listAssignableRoles(memberCtx, {
        discordGuildId: guildId,
        holderRoleIds: [GRANTOR],
      });
      expect(holder.map((role) => role.id).sort()).toEqual([GRANTABLE_A, GRANTABLE_B].sort());

      const nonHolder = await listAssignableRoles(adminCtx, {
        discordGuildId: guildId,
        holderRoleIds: [],
      });
      expect(nonHolder).toHaveLength(0);
    });

    it('assigns a role the caller is allowed to hand out', async () => {
      const result = await applyRoleAssignment(
        memberCtx,
        { discordGuildId: guildId, targetDiscordUserId: IDS.D_OTHER, roleIds: [GRANTABLE_A] },
        { gateway },
      );

      expect(result.applied.map((role) => role.id)).toEqual([GRANTABLE_A]);
      expect(gateway.rolesOf(guildId, IDS.D_OTHER)).toContain(GRANTABLE_A);
    });

    it('removes a role and skips one the member does not hold', async () => {
      gateway.defineMember(guildId, { id: IDS.D_OTHER, roleIds: [GRANTABLE_A] });

      const result = await applyRoleAssignment(
        memberCtx,
        {
          discordGuildId: guildId,
          targetDiscordUserId: IDS.D_OTHER,
          roleIds: [GRANTABLE_A, GRANTABLE_B],
          remove: true,
        },
        { gateway },
      );

      expect(result.applied.map((role) => role.id)).toEqual([GRANTABLE_A]);
      expect(result.skipped.map((role) => role.id)).toEqual([GRANTABLE_B]);
      expect(gateway.rolesOf(guildId, IDS.D_OTHER)).not.toContain(GRANTABLE_A);
    });

    it('skips a role the target already has', async () => {
      gateway.defineMember(guildId, { id: IDS.D_OTHER, roleIds: [GRANTABLE_A] });
      const result = await applyRoleAssignment(
        memberCtx,
        { discordGuildId: guildId, targetDiscordUserId: IDS.D_OTHER, roleIds: [GRANTABLE_A] },
        { gateway },
      );
      expect(result.applied).toHaveLength(0);
      expect(result.skipped[0].reason).toMatch(/already/i);
    });

    it('refuses a role the caller is not allowed to hand out', async () => {
      await expect(
        applyRoleAssignment(
          memberCtx,
          { discordGuildId: guildId, targetDiscordUserId: IDS.D_OTHER, roleIds: [IDS.R_UNMANAGED] },
          { gateway },
        ),
      ).rejects.toThrow(/not allowed to hand out/i);
    });

    it('refuses a caller who holds no grantor role (even a global admin)', async () => {
      // D_ADMIN holds rolegrant.manage but not the Recruiter role, so cannot hand it out.
      await expect(
        applyRoleAssignment(
          adminCtx,
          { discordGuildId: guildId, targetDiscordUserId: IDS.D_OTHER, roleIds: [GRANTABLE_A] },
          { gateway },
        ),
      ).rejects.toThrow(/do not hold a role/i);
    });

    it('fails a role the bot cannot manage without aborting the rest', async () => {
      await addGrantRule(adminCtx, {
        discordGuildId: guildId,
        grantor: { id: GRANTOR, name: 'Recruiter' },
        grantables: [{ id: GRANTABLE_ABOVE, name: 'Above Bot' }],
        reason: 'setup',
      });

      const result = await applyRoleAssignment(
        memberCtx,
        {
          discordGuildId: guildId,
          targetDiscordUserId: IDS.D_OTHER,
          roleIds: [GRANTABLE_A, GRANTABLE_ABOVE],
        },
        { gateway },
      );

      expect(result.applied.map((role) => role.id)).toEqual([GRANTABLE_A]);
      expect(result.failed.map((role) => role.id)).toEqual([GRANTABLE_ABOVE]);
      expect(gateway.rolesOf(guildId, IDS.D_OTHER)).toContain(GRANTABLE_A);
      expect(gateway.rolesOf(guildId, IDS.D_OTHER)).not.toContain(GRANTABLE_ABOVE);
    });

    it('records an audit entry for an applied change', async () => {
      await applyRoleAssignment(
        memberCtx,
        { discordGuildId: guildId, targetDiscordUserId: IDS.D_OTHER, roleIds: [GRANTABLE_A] },
        { gateway },
      );
      const audit = await testPrisma().auditLog.findFirst({
        where: { action: 'role_grant.assigned', targetDiscordId: IDS.D_OTHER },
      });
      expect(audit).not.toBeNull();
    });
  });
});
