/**
 * End-to-end synchronization.
 *
 * A mapping or a grant goes in, a plan is computed, and Discord (the mock gateway) comes
 * out the other side in the right state - including the parts that must *not* happen:
 * unmanaged roles left alone, dry runs touching nothing, and oversized jobs pausing.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMapping,
  createSyncJob,
  discordContext,
  issueGrant,
  revokeGrant,
  runSyncJob,
  systemContext,
} from '@frm/core';
import { loadActorByDiscordId } from '@frm/authorization';
import { claimSyncMarker, closeQueues, closeRedis, getRedis } from '@frm/queue';
import { disconnectPrisma } from '@frm/database';
import {
  SyncActionStatus,
  SyncActionType,
  SyncIssueType,
  SyncJobStatus,
  SyncJobType,
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

describe.skipIf(!available)('sync runner', () => {
  let fixtures;
  let gateway;
  let adminCtx;
  let prisma;

  beforeEach(async () => {
    await resetDatabase();
    fixtures = await seedCommunity();
    gateway = buildMockGateway();
    prisma = testPrisma();
    adminCtx = discordContext(await loadActorByDiscordId(IDS.D_ADMIN), {
      discordGuildId: IDS.MAIN_GUILD,
    });

    const redis = getRedis();
    const keys = await redis.keys('frm:*');
    if (keys.length) await redis.del(...keys);
  });

  afterAll(async () => {
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await disconnectTestPrisma();
  });

  /**
   * The community role in the main guild drives the department role in HCSO. This is the
   * shape almost every real mapping takes.
   */
  async function createMemberMapping(overrides = {}) {
    const { mapping } = await createMapping(
      adminCtx,
      {
        name: 'HCSO member sync',
        sourceGuildId: IDS.MAIN_GUILD,
        sourceRoleId: IDS.R_MAIN_HCSO_MEMBER,
        targetGuildId: IDS.HCSO_GUILD,
        targetRoleId: IDS.R_HCSO_MEMBER,
        enabled: true,
        reason: 'link the community role to the department role',
        ...overrides,
      },
      { gateway },
    );
    return mapping;
  }

  /** Puts the source role on the member, which is what the mapping reads. */
  function giveSourceRole(discordUserId = IDS.D_MEMBER) {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: discordUserId,
      roleIds: [IDS.R_MAIN_HCSO_MEMBER],
    });
  }

  /** Creates and immediately runs a member resync. */
  async function syncMember(userId, { dryRun = false } = {}) {
    const job = await createSyncJob(prisma, systemContext({ label: 'test' }), {
      type: SyncJobType.MEMBER_RESYNC,
      targetUserId: userId,
      dryRun,
      payload: { userId },
    });
    return runSyncJob({ jobId: job.id, gateway, prisma });
  }

  // -------------------------------------------------------------------------

  it('applies the role a mapping implies', async () => {
    await createMemberMapping();
    giveSourceRole();

    const finished = await syncMember(fixtures.users.member.id);

    expect(finished.status).toBe(SyncJobStatus.COMPLETED);
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toEqual([IDS.R_HCSO_MEMBER]);

    const actions = await prisma.syncAction.findMany({ where: { syncJobId: finished.id } });
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe(SyncActionStatus.APPLIED);
    expect(actions[0].action).toBe(SyncActionType.ADD_ROLE);
    expect(actions[0].reason.length).toBeGreaterThan(0);
    expect(actions[0].mappingId).toBeTruthy();
  });

  it('is idempotent: a second run changes nothing', async () => {
    await createMemberMapping();
    giveSourceRole();

    await syncMember(fixtures.users.member.id);
    const callsAfterFirst = gateway.calls.length;

    const second = await syncMember(fixtures.users.member.id);

    expect(gateway.calls.length).toBe(callsAfterFirst);
    const actions = await prisma.syncAction.findMany({ where: { syncJobId: second.id } });
    expect(actions).toHaveLength(0);
    expect(second.status).toBe(SyncJobStatus.COMPLETED);
  });

  it('never removes a role the platform does not manage', async () => {
    await createMemberMapping();
    giveSourceRole();
    gateway.defineMember(IDS.HCSO_GUILD, {
      id: IDS.D_MEMBER,
      roleIds: [IDS.R_UNMANAGED],
    });

    await syncMember(fixtures.users.member.id);

    // The unrelated community role survives untouched.
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toContain(IDS.R_UNMANAGED);
    const removals = gateway.calls.filter((call) => call.action === 'REMOVE_ROLE');
    expect(removals).toHaveLength(0);
  });

  it('removes the mapped role once the source role is gone', async () => {
    await createMemberMapping();
    giveSourceRole();
    await syncMember(fixtures.users.member.id);
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toContain(IDS.R_HCSO_MEMBER);

    // A human takes the community role away in the main guild.
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_MEMBER, roleIds: [] });
    await syncMember(fixtures.users.member.id);

    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toEqual([]);
  });

  it('leaves a mapped role alone when the mapping does not remove', async () => {
    await createMemberMapping({ syncRemove: false });
    gateway.defineMember(IDS.HCSO_GUILD, { id: IDS.D_MEMBER, roleIds: [IDS.R_HCSO_MEMBER] });

    // The member never had the source role, but an add-only mapping cannot compute the
    // correct value of the target role, so it is not the platform's to remove.
    await syncMember(fixtures.users.member.id);

    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toContain(IDS.R_HCSO_MEMBER);
  });

  it('applies a manual grant, and takes it back when it is revoked', async () => {
    const { grant } = await issueGrant(adminCtx, {
      discordUserId: IDS.D_MEMBER,
      managedRoleId: fixtures.managedRoles.grantable.id,
      reason: 'temporary investigation access',
    });

    await syncMember(fixtures.users.member.id);
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toContain(IDS.R_GRANTABLE);

    await revokeGrant(adminCtx, { grantId: grant.id, reason: 'investigation closed' });
    await syncMember(fixtures.users.member.id);

    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).not.toContain(IDS.R_GRANTABLE);
  });

  it('removes a grant role that expired, without anybody having to act', async () => {
    await issueGrant(adminCtx, {
      discordUserId: IDS.D_MEMBER,
      managedRoleId: fixtures.managedRoles.grantable.id,
      reason: 'event staff for the weekend',
    });
    await syncMember(fixtures.users.member.id);
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toContain(IDS.R_GRANTABLE);

    await prisma.manualRoleGrant.updateMany({
      where: { userId: fixtures.users.member.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await syncMember(fixtures.users.member.id);

    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).not.toContain(IDS.R_GRANTABLE);
  });

  it('writes a loop-protection marker before every change it makes', async () => {
    await createMemberMapping();
    giveSourceRole();

    await syncMember(fixtures.users.member.id);

    // The marker proves the resulting Discord event will be recognised as ours.
    const marker = await claimSyncMarker({
      discordGuildId: IDS.HCSO_GUILD,
      discordUserId: IDS.D_MEMBER,
      discordRoleId: IDS.R_HCSO_MEMBER,
      action: SyncActionType.ADD_ROLE,
    });
    expect(marker).not.toBeNull();
    expect(marker.syncJobId).toBeTruthy();
  });

  // -------------------------------------------------------------------------

  describe('dry run', () => {
    it('plans everything and changes nothing', async () => {
      await createMemberMapping();
      giveSourceRole();

      const finished = await syncMember(fixtures.users.member.id, { dryRun: true });

      expect(finished.status).toBe(SyncJobStatus.COMPLETED);
      expect(gateway.calls).toHaveLength(0);
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toEqual([]);

      const actions = await prisma.syncAction.findMany({ where: { syncJobId: finished.id } });
      expect(actions).toHaveLength(1);
      expect(actions.every((action) => action.status === SyncActionStatus.DRY_RUN)).toBe(true);
    });

    it('writes no loop-protection markers', async () => {
      await createMemberMapping();
      giveSourceRole();

      await syncMember(fixtures.users.member.id, { dryRun: true });
      const marker = await claimSyncMarker({
        discordGuildId: IDS.HCSO_GUILD,
        discordUserId: IDS.D_MEMBER,
        discordRoleId: IDS.R_HCSO_MEMBER,
        action: SyncActionType.ADD_ROLE,
      });
      expect(marker).toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  describe('safety threshold', () => {
    /** Two mapped roles plus a granted one, all currently held. */
    async function giveThreeManagedRoles() {
      await createMemberMapping();
      await createMapping(
        adminCtx,
        {
          name: 'Media Team sync',
          sourceGuildId: IDS.MAIN_GUILD,
          sourceRoleId: IDS.R_MAIN_MEDIA,
          targetGuildId: IDS.HCSO_GUILD,
          targetRoleId: IDS.R_HCSO_MEDIA,
          enabled: true,
          reason: 'community interest role',
        },
        { gateway },
      );
      await issueGrant(adminCtx, {
        discordUserId: IDS.D_MEMBER,
        managedRoleId: fixtures.managedRoles.grantable.id,
        reason: 'investigation access',
      });

      gateway.defineMember(IDS.MAIN_GUILD, {
        id: IDS.D_MEMBER,
        roleIds: [IDS.R_MAIN_HCSO_MEMBER, IDS.R_MAIN_MEDIA],
      });
      await syncMember(fixtures.users.member.id);
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toHaveLength(3);
    }

    it('pauses instead of performing a mass removal', async () => {
      await giveThreeManagedRoles();

      // Lower the threshold, then create a change that removes more than that.
      await prisma.systemSetting.create({
        data: { key: 'sync.maxRemovalsThreshold', value: 1 },
      });
      gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_MEMBER, roleIds: [] });
      await prisma.manualRoleGrant.updateMany({
        where: { userId: fixtures.users.member.id },
        data: { revokedAt: new Date() },
      });

      const callsBefore = gateway.calls.length;
      const finished = await syncMember(fixtures.users.member.id);

      expect(finished.status).toBe(SyncJobStatus.PAUSED);
      expect(finished.thresholdBreached).toBe(true);
      // Nothing was touched in Discord.
      expect(gateway.calls.length).toBe(callsBefore);
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toHaveLength(3);

      const issue = await prisma.syncIssue.findFirst({
        where: { syncJobId: finished.id, type: SyncIssueType.THRESHOLD_EXCEEDED },
      });
      expect(issue).not.toBeNull();
      expect(issue.message).toMatch(/paused/i);

      // The planned actions are still recorded so a human can review them.
      const planned = await prisma.syncAction.findMany({ where: { syncJobId: finished.id } });
      expect(planned.length).toBeGreaterThan(1);
      expect(planned.every((action) => action.status === SyncActionStatus.PENDING)).toBe(true);
    });

    it('does not apply the threshold to a dry run', async () => {
      await giveThreeManagedRoles();
      await prisma.systemSetting.create({
        data: { key: 'sync.maxRemovalsThreshold', value: 1 },
      });
      gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_MEMBER, roleIds: [] });

      const finished = await syncMember(fixtures.users.member.id, { dryRun: true });
      expect(finished.status).toBe(SyncJobStatus.COMPLETED);
    });
  });

  // -------------------------------------------------------------------------

  describe('failure handling', () => {
    beforeEach(async () => {
      await createMemberMapping();
      giveSourceRole();
    });

    it('records a typed issue when a role sits above the bot', async () => {
      // Move the target role above the bot's own highest role.
      gateway.defineRole(IDS.HCSO_GUILD, {
        id: IDS.R_HCSO_MEMBER,
        name: 'Department Member',
        position: 500,
      });

      const finished = await syncMember(fixtures.users.member.id);

      expect(finished.status).toBe(SyncJobStatus.FAILED);

      const issue = await prisma.syncIssue.findFirst({
        where: { syncJobId: finished.id, type: SyncIssueType.ROLE_ABOVE_BOT },
      });
      expect(issue).not.toBeNull();
      expect(issue.message).toMatch(/above the bot/i);
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toEqual([]);
    });

    it('does not abort the rest of the plan when one role fails', async () => {
      await issueGrant(adminCtx, {
        discordUserId: IDS.D_MEMBER,
        managedRoleId: fixtures.managedRoles.grantable.id,
        reason: 'investigation access',
      });
      gateway.defineRole(IDS.HCSO_GUILD, {
        id: IDS.R_HCSO_MEMBER,
        name: 'Department Member',
        position: 500,
      });

      const finished = await syncMember(fixtures.users.member.id);

      expect(finished.status).toBe(SyncJobStatus.PARTIAL);
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toEqual([IDS.R_GRANTABLE]);
    });

    it('records an issue when the bot lacks Manage Roles', async () => {
      gateway.defineGuild({
        id: IDS.HCSO_GUILD,
        name: 'HCSO',
        botCanManageRoles: false,
        botHighestRolePosition: 100,
      });

      const finished = await syncMember(fixtures.users.member.id);
      const issue = await prisma.syncIssue.findFirst({
        where: { syncJobId: finished.id, type: SyncIssueType.BOT_MISSING_PERMISSION },
      });
      expect(issue).not.toBeNull();
    });

    it('warns, without failing, when the member is not in a guild', async () => {
      gateway.kickMember(IDS.HCSO_GUILD, IDS.D_MEMBER);

      const finished = await syncMember(fixtures.users.member.id);

      expect(finished.status).toBe(SyncJobStatus.COMPLETED);
      const issue = await prisma.syncIssue.findFirst({
        where: { syncJobId: finished.id, type: SyncIssueType.MEMBER_NOT_IN_GUILD },
      });
      expect(issue).not.toBeNull();
      expect(issue.severity).toBe('WARNING');
    });

    it('discards the marker when a change fails, so the next real event is not swallowed', async () => {
      gateway.failNext(IDS.HCSO_GUILD, IDS.D_MEMBER, IDS.R_HCSO_MEMBER, 50013);

      await syncMember(fixtures.users.member.id);

      const marker = await claimSyncMarker({
        discordGuildId: IDS.HCSO_GUILD,
        discordUserId: IDS.D_MEMBER,
        discordRoleId: IDS.R_HCSO_MEMBER,
        action: SyncActionType.ADD_ROLE,
      });
      expect(marker).toBeNull();
    });

    it('classifies a rate limit as retryable and a permission failure as permanent', async () => {
      gateway.failNext(IDS.HCSO_GUILD, IDS.D_MEMBER, IDS.R_HCSO_MEMBER, 429);
      const rateLimited = await syncMember(fixtures.users.member.id);
      const retryable = await prisma.syncIssue.findFirst({
        where: { syncJobId: rateLimited.id, type: SyncIssueType.RATE_LIMITED },
      });
      expect(retryable.details.retryable).toBe(true);

      gateway.failNext(IDS.HCSO_GUILD, IDS.D_MEMBER, IDS.R_HCSO_MEMBER, 50013);
      const denied = await syncMember(fixtures.users.member.id);
      const permanent = await prisma.syncIssue.findFirst({
        where: { syncJobId: denied.id, type: SyncIssueType.BOT_MISSING_PERMISSION },
      });
      expect(permanent.details.retryable).toBe(false);
    });

    it('does not plan anything for a guild whose synchronization is switched off', async () => {
      await disableHcsoSync();

      const finished = await syncMember(fixtures.users.member.id);

      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toEqual([]);
      expect(finished.status).toBe(SyncJobStatus.COMPLETED);
      const actions = await prisma.syncAction.findMany({ where: { syncJobId: finished.id } });
      expect(actions).toHaveLength(0);
    });

    it('skips an action when the guild is disabled between planning and applying', async () => {
      // Defence in depth: the plan is built from approved guilds, but the allowlist can
      // change while the job runs. `onProgress` fires after planning, before applying.
      const job = await createSyncJob(prisma, systemContext({ label: 'test' }), {
        type: SyncJobType.MEMBER_RESYNC,
        targetUserId: fixtures.users.member.id,
        payload: { userId: fixtures.users.member.id },
      });

      const finished = await runSyncJob({
        jobId: job.id,
        gateway,
        prisma,
        onProgress: disableHcsoSync,
      });

      expect(gateway.calls).toHaveLength(0);
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toEqual([]);
      expect(finished.status).toBe(SyncJobStatus.COMPLETED);

      const action = await prisma.syncAction.findFirst({ where: { syncJobId: finished.id } });
      expect(action.status).toBe(SyncActionStatus.SKIPPED);
      expect(action.error).toMatch(/no longer approved|disabled/i);
    });

    function disableHcsoSync() {
      return prisma.approvedGuild.update({
        where: { id: fixtures.guilds.hcsoGuild.id },
        data: { syncEnabled: false },
      });
    }
  });

  // -------------------------------------------------------------------------

  describe('guild resync', () => {
    it('covers every Discord member of the guild, linked or not', async () => {
      await createMemberMapping();
      for (const discordUserId of [IDS.D_MEMBER, IDS.D_UNLINKED]) {
        gateway.defineMember(IDS.MAIN_GUILD, {
          id: discordUserId,
          roleIds: [IDS.R_MAIN_HCSO_MEMBER],
        });
      }

      const job = await createSyncJob(prisma, systemContext({ label: 'test' }), {
        type: SyncJobType.GUILD_RESYNC,
        approvedGuildId: fixtures.guilds.mainGuild.id,
        payload: { guildId: fixtures.guilds.mainGuild.id },
      });
      const finished = await runSyncJob({ jobId: job.id, gateway, prisma });

      expect(finished.status).toBe(SyncJobStatus.COMPLETED);
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toContain(IDS.R_HCSO_MEMBER);
      // The unlinked account has no platform record at all, and is still synchronized:
      // a mapping applies to whoever holds the source role.
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_UNLINKED)).toContain(IDS.R_HCSO_MEMBER);
    });
  });

  // -------------------------------------------------------------------------

  describe('audit trail', () => {
    it('records job completion with the applied counts', async () => {
      await createMemberMapping();
      giveSourceRole();

      const finished = await syncMember(fixtures.users.member.id);

      const audit = await prisma.auditLog.findFirst({
        where: { syncJobId: finished.id, action: 'sync.job_completed' },
      });
      expect(audit).not.toBeNull();
      expect(audit.newState.applied).toBe(1);
      expect(audit.newState.failed).toBe(0);
    });

    it('records a grant and the sync job it queued together', async () => {
      await issueGrant(adminCtx, {
        discordUserId: IDS.D_MEMBER,
        managedRoleId: fixtures.managedRoles.grantable.id,
        reason: 'new investigator',
      });

      const audit = await prisma.auditLog.findFirst({ where: { action: 'grant.issued' } });
      expect(audit).not.toBeNull();
      expect(audit.syncJobId).toBeTruthy();
      expect(audit.reason).toBe('new investigator');

      const job = await prisma.syncJob.findUnique({ where: { id: audit.syncJobId } });
      expect(job.type).toBe(SyncJobType.GRANT_CHANGE);
    });
  });
});
