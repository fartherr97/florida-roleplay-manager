/**
 * Two-person approval for protected mappings.
 *
 * The control only means something if the requester cannot also be the approver, so
 * that is the case this suite spends most of its effort on.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  approvePending,
  createMapping,
  discordContext,
  listPendingApprovals,
  rejectPending,
  setMappingEnabled,
} from '@frm/core';
import { loadActorByDiscordId } from '@frm/authorization';
import { closeQueues, closeRedis } from '@frm/queue';
import { disconnectPrisma } from '@frm/database';
import { PermissionLevel, PermissionScopeType, ProtectionLevel, RolePurpose } from '@frm/shared';
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
const SECOND_ADMIN_DISCORD_ID = '930000000000000009';

describe.skipIf(!available)('two-person approval', () => {
  let fixtures;
  let gateway;
  let adminCtx;
  let secondAdminCtx;
  let prisma;

  beforeEach(async () => {
    await resetDatabase();
    fixtures = await seedCommunity();
    gateway = buildMockGateway();
    prisma = testPrisma();

    // A protected role that demands a second signature.
    await prisma.managedRole.update({
      where: {
        approvedGuildId_discordRoleId: {
          approvedGuildId: fixtures.guilds.hcsoGuild.id,
          discordRoleId: IDS.R_PROTECTED,
        },
      },
      data: { protectionLevel: ProtectionLevel.TWO_PERSON, purpose: RolePurpose.OTHER },
    });

    // A second global administrator, so approving is possible at all.
    const second = await prisma.user.create({
      data: {
        displayName: 'Second Administrator',
        permissionLevel: PermissionLevel.GLOBAL_ADMIN,
        websiteAccess: true,
        primaryDiscordId: SECOND_ADMIN_DISCORD_ID,
        discordIdentities: {
          create: { discordUserId: SECOND_ADMIN_DISCORD_ID, isPrimary: true },
        },
      },
    });
    for (const capability of [
      'mapping.approve',
      'mapping.view',
      'mapping.update',
      'mapping.create',
    ]) {
      await prisma.permissionAssignment.create({
        data: {
          userId: second.id,
          capabilityKey: capability,
          scopeType: PermissionScopeType.GLOBAL,
          scopeId: '',
          reason: 'test fixture',
        },
      });
    }

    adminCtx = discordContext(await loadActorByDiscordId(IDS.D_ADMIN), {
      discordGuildId: IDS.MAIN_GUILD,
    });
    secondAdminCtx = discordContext(await loadActorByDiscordId(SECOND_ADMIN_DISCORD_ID), {
      discordGuildId: IDS.MAIN_GUILD,
    });
  });

  afterAll(async () => {
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await disconnectTestPrisma();
  });

  async function createProtectedMapping() {
    return createMapping(
      adminCtx,
      {
        name: 'Internal Affairs access',
        sourceGuildId: IDS.MAIN_GUILD,
        sourceRoleId: IDS.R_MAIN_MEDIA,
        targetGuildId: IDS.HCSO_GUILD,
        targetRoleId: IDS.R_PROTECTED,
        enabled: true,
        reason: 'sensitive access mapping',
      },
      { gateway },
    );
  }

  it('creates a protected mapping disabled, with an approval request', async () => {
    const { mapping, requiresApproval, warnings } = await createProtectedMapping();

    expect(requiresApproval).toBe(true);
    expect(mapping.enabled).toBe(false);
    expect(mapping.requiresApproval).toBe(true);
    expect(warnings.join(' ')).toMatch(/second authorized approver/i);

    const pending = await prisma.pendingApproval.findFirst({ where: { mappingId: mapping.id } });
    expect(pending).not.toBeNull();
    expect(pending.requiredCapability).toBe('mapping.approve');
    expect(pending.requestedById).toBe(fixtures.users.admin.id);
  });

  it('refuses to enable the mapping before it is approved', async () => {
    const { mapping } = await createProtectedMapping();

    await expect(
      setMappingEnabled(
        adminCtx,
        { mappingId: mapping.id, enabled: true, reason: 'skipping approval' },
        { gateway },
      ),
    ).rejects.toThrow(/second authorized approver/i);
  });

  it('refuses to let the requester approve their own request', async () => {
    const { mapping } = await createProtectedMapping();
    const pending = await prisma.pendingApproval.findFirst({ where: { mappingId: mapping.id } });

    // This is the entire point of the control.
    const error = await approvePending(adminCtx, { approvalId: pending.id }).catch((e) => e);
    expect(error.code).toBe('SELF_MANAGEMENT');
  });

  it('refuses approval from somebody without the capability', async () => {
    const { mapping } = await createProtectedMapping();
    const pending = await prisma.pendingApproval.findFirst({ where: { mappingId: mapping.id } });

    // The guild administrator may create and edit mappings, but approving is a global
    // capability they deliberately do not hold.
    const guildAdminCtx = discordContext(await loadActorByDiscordId(IDS.D_GUILD_ADMIN), {
      discordGuildId: IDS.HCSO_GUILD,
    });

    await expect(approvePending(guildAdminCtx, { approvalId: pending.id })).rejects.toThrow(
      /mapping.approve/i,
    );
  });

  it('lets a different administrator approve, after which the mapping can be enabled', async () => {
    const { mapping } = await createProtectedMapping();
    const pending = await prisma.pendingApproval.findFirst({ where: { mappingId: mapping.id } });

    const result = await approvePending(secondAdminCtx, {
      approvalId: pending.id,
      comment: 'reviewed and agreed',
    });
    expect(result.applied).toBe(true);

    const approved = await prisma.roleMapping.findUnique({ where: { id: mapping.id } });
    expect(approved.approvedAt).not.toBeNull();

    const enabled = await setMappingEnabled(
      adminCtx,
      { mappingId: mapping.id, enabled: true, reason: 'approved, activating' },
      { gateway },
    );
    expect(enabled.enabled).toBe(true);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'approval.approved' } });
    expect(audit).not.toBeNull();
    expect(audit.actorUserId).not.toBe(fixtures.users.admin.id);
  });

  it('lists what is waiting for a signature', async () => {
    await createProtectedMapping();
    const pending = await listPendingApprovals(secondAdminCtx);

    expect(pending).toHaveLength(1);
    expect(pending[0].mapping.name).toBe('Internal Affairs access');
    expect(pending[0].requestedBy.displayName).toBe('Global Admin');
  });

  it('can be rejected, leaving the mapping inert', async () => {
    const { mapping } = await createProtectedMapping();
    const pending = await prisma.pendingApproval.findFirst({ where: { mappingId: mapping.id } });

    await rejectPending(secondAdminCtx, {
      approvalId: pending.id,
      reason: 'not appropriate for a mapping',
    });

    const after = await prisma.pendingApproval.findUnique({ where: { id: pending.id } });
    expect(after.status).toBe('REJECTED');

    const stillDisabled = await prisma.roleMapping.findUnique({ where: { id: mapping.id } });
    expect(stillDisabled.approvedAt).toBeNull();
    expect(stillDisabled.enabled).toBe(false);
  });

  it('refuses a second decision on a resolved request', async () => {
    const { mapping } = await createProtectedMapping();
    const pending = await prisma.pendingApproval.findFirst({ where: { mappingId: mapping.id } });

    await approvePending(secondAdminCtx, { approvalId: pending.id });
    await expect(approvePending(secondAdminCtx, { approvalId: pending.id })).rejects.toThrow(
      /already been approved/i,
    );
  });
});
