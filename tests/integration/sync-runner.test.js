/**
 * End-to-end synchronization.
 *
 * A roster change goes in, a plan is computed, and Discord (the mock gateway) comes out
 * the other side in the right state - including the parts that must *not* happen:
 * unmanaged roles left alone, dry runs touching nothing, and oversized jobs pausing.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSyncJob,
  hireMember,
  promoteMember,
  removeMember,
  runSyncJob,
  systemContext,
  discordContext,
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

  it('applies the roles a roster membership implies', async () => {
    const finished = await syncMember(fixtures.users.deputy.id);

    expect(finished.status).toBe(SyncJobStatus.COMPLETED);
    expect(gateway.rolesOf(IDS.MAIN_GUILD, IDS.D_DEPUTY)).toEqual([IDS.R_MAIN_HCSO_MEMBER]);
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_DEPUTY)).toEqual(
      [IDS.R_HCSO_MEMBER, IDS.R_HCSO_DEPUTY].sort(),
    );

    const actions = await prisma.syncAction.findMany({ where: { syncJobId: finished.id } });
    expect(actions).toHaveLength(3);
    expect(actions.every((action) => action.status === SyncActionStatus.APPLIED)).toBe(true);
    expect(actions.every((action) => action.reason.length > 0)).toBe(true);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await syncMember(fixtures.users.deputy.id);
    const callsAfterFirst = gateway.calls.length;

    const second = await syncMember(fixtures.users.deputy.id);

    expect(gateway.calls.length).toBe(callsAfterFirst);
    const actions = await prisma.syncAction.findMany({ where: { syncJobId: second.id } });
    expect(actions).toHaveLength(0);
    expect(second.status).toBe(SyncJobStatus.COMPLETED);
  });

  it('never removes a role the platform does not manage', async () => {
    gateway.defineMember(IDS.HCSO_GUILD, {
      id: IDS.D_DEPUTY,
      roleIds: [IDS.R_UNMANAGED, IDS.R_HCSO_MEMBER, IDS.R_HCSO_DEPUTY],
    });

    await syncMember(fixtures.users.deputy.id);

    // The unrelated community role survives untouched.
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_DEPUTY)).toContain(IDS.R_UNMANAGED);
    const removals = gateway.calls.filter((call) => call.action === 'REMOVE_ROLE');
    expect(removals).toHaveLength(0);
  });

  it('corrects a rank role that was changed by hand in Discord', async () => {
    // Somebody hands the deputy a Sergeant role directly in Discord.
    gateway.defineMember(IDS.HCSO_GUILD, {
      id: IDS.D_DEPUTY,
      roleIds: [IDS.R_HCSO_MEMBER, IDS.R_HCSO_SERGEANT],
    });

    await syncMember(fixtures.users.deputy.id);

    // The roster says Deputy, and the roster is authoritative.
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_DEPUTY)).toEqual(
      [IDS.R_HCSO_MEMBER, IDS.R_HCSO_DEPUTY].sort(),
    );
  });

  it('swaps the rank role on a promotion, including the supervisor role', async () => {
    await syncMember(fixtures.users.deputy.id);

    await promoteMember(adminCtx, {
      departmentId: fixtures.departments.hcso.id,
      discordUserId: IDS.D_DEPUTY,
      rankId: fixtures.ranks.corporal.id,
      reason: 'promotion',
    });
    await syncMember(fixtures.users.deputy.id);

    const roles = gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_DEPUTY);
    expect(roles).toContain(IDS.R_HCSO_CORPORAL);
    expect(roles).toContain(IDS.R_HCSO_SUPERVISOR); // Corporal is a supervisor rank
    expect(roles).not.toContain(IDS.R_HCSO_DEPUTY);
  });

  it('removes every department role when a member is terminated', async () => {
    await syncMember(fixtures.users.deputy.id);

    await removeMember(adminCtx, {
      departmentId: fixtures.departments.hcso.id,
      discordUserId: IDS.D_DEPUTY,
      reason: 'resigned',
    });
    await syncMember(fixtures.users.deputy.id);

    expect(gateway.rolesOf(IDS.MAIN_GUILD, IDS.D_DEPUTY)).toEqual([]);
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_DEPUTY)).toEqual([]);
  });

  it('writes a loop-protection marker before every change it makes', async () => {
    await syncMember(fixtures.users.deputy.id);

    // The marker proves the resulting Discord event will be recognised as ours.
    const marker = await claimSyncMarker({
      discordGuildId: IDS.HCSO_GUILD,
      discordUserId: IDS.D_DEPUTY,
      discordRoleId: IDS.R_HCSO_DEPUTY,
      action: SyncActionType.ADD_ROLE,
    });
    expect(marker).not.toBeNull();
    expect(marker.syncJobId).toBeTruthy();
  });

  // -------------------------------------------------------------------------

  describe('dry run', () => {
    it('plans everything and changes nothing', async () => {
      const finished = await syncMember(fixtures.users.deputy.id, { dryRun: true });

      expect(finished.status).toBe(SyncJobStatus.COMPLETED);
      expect(gateway.calls).toHaveLength(0);
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_DEPUTY)).toEqual([]);

      const actions = await prisma.syncAction.findMany({ where: { syncJobId: finished.id } });
      expect(actions).toHaveLength(3);
      expect(actions.every((action) => action.status === SyncActionStatus.DRY_RUN)).toBe(true);
    });

    it('writes no loop-protection markers', async () => {
      await syncMember(fixtures.users.deputy.id, { dryRun: true });
      const marker = await claimSyncMarker({
        discordGuildId: IDS.HCSO_GUILD,
        discordUserId: IDS.D_DEPUTY,
        discordRoleId: IDS.R_HCSO_DEPUTY,
        action: SyncActionType.ADD_ROLE,
      });
      expect(marker).toBeNull();
    });
  });

  // -------------------------------------------------------------------------

  describe('safety threshold', () => {
    it('pauses instead of performing a mass removal', async () => {
      await syncMember(fixtures.users.deputy.id);
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_DEPUTY)).toHaveLength(2);

      // Lower the threshold, then create a change that removes more than that.
      await prisma.systemSetting.create({
        data: { key: 'sync.maxRemovalsThreshold', value: 1 },
      });
      await removeMember(adminCtx, {
        departmentId: fixtures.departments.hcso.id,
        discordUserId: IDS.D_DEPUTY,
        reason: 'terminated',
      });

      const callsBefore = gateway.calls.length;
      const finished = await syncMember(fixtures.users.deputy.id);

      expect(finished.status).toBe(SyncJobStatus.PAUSED);
      expect(finished.thresholdBreached).toBe(true);
      // Nothing was touched in Discord.
      expect(gateway.calls.length).toBe(callsBefore);
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_DEPUTY)).toHaveLength(2);

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
      await prisma.systemSetting.create({
        data: { key: 'sync.maxRemovalsThreshold', value: 1 },
      });
      const finished = await syncMember(fixtures.users.deputy.id, { dryRun: true });
      expect(finished.status).toBe(SyncJobStatus.COMPLETED);
    });
  });

  // -------------------------------------------------------------------------

  describe('failure handling', () => {
    it('records a typed issue when a role sits above the bot', async () => {
      // Move the bot below the rank role it is supposed to manage.
      gateway.defineRole(IDS.HCSO_GUILD, {
        id: IDS.R_HCSO_DEPUTY,
        name: 'Deputy',
        position: 500,
      });

      const finished = await syncMember(fixtures.users.deputy.id);

      expect(finished.status).toBe(SyncJobStatus.PARTIAL);

      const issue = await prisma.syncIssue.findFirst({
        where: { syncJobId: finished.id, type: SyncIssueType.ROLE_ABOVE_BOT },
      });
      expect(issue).not.toBeNull();
      expect(issue.message).toMatch(/above the bot/i);

      // The other two roles still applied: one bad role does not abort the whole plan.
      expect(gateway.rolesOf(IDS.MAIN_GUILD, IDS.D_DEPUTY)).toContain(IDS.R_MAIN_HCSO_MEMBER);
      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_DEPUTY)).toContain(IDS.R_HCSO_MEMBER);
    });

    it('records an issue when the bot lacks Manage Roles', async () => {
      gateway.defineGuild({
        id: IDS.HCSO_GUILD,
        name: 'HCSO',
        botCanManageRoles: false,
        botHighestRolePosition: 100,
      });

      const finished = await syncMember(fixtures.users.deputy.id);
      const issue = await prisma.syncIssue.findFirst({
        where: { syncJobId: finished.id, type: SyncIssueType.BOT_MISSING_PERMISSION },
      });
      expect(issue).not.toBeNull();
    });

    it('warns, without failing, when the member is not in a guild', async () => {
      gateway.kickMember(IDS.HCSO_GUILD, IDS.D_DEPUTY);

      const finished = await syncMember(fixtures.users.deputy.id);

      expect(finished.status).toBe(SyncJobStatus.COMPLETED);
      const issue = await prisma.syncIssue.findFirst({
        where: { syncJobId: finished.id, type: SyncIssueType.MEMBER_NOT_IN_GUILD },
      });
      expect(issue).not.toBeNull();
      expect(issue.severity).toBe('WARNING');
      // The guild they *are* in still gets synchronized.
      expect(gateway.rolesOf(IDS.MAIN_GUILD, IDS.D_DEPUTY)).toContain(IDS.R_MAIN_HCSO_MEMBER);
    });

    it('discards the marker when a change fails, so the next real event is not swallowed', async () => {
      gateway.failNext(IDS.HCSO_GUILD, IDS.D_DEPUTY, IDS.R_HCSO_DEPUTY, 50013);

      await syncMember(fixtures.users.deputy.id);

      const marker = await claimSyncMarker({
        discordGuildId: IDS.HCSO_GUILD,
        discordUserId: IDS.D_DEPUTY,
        discordRoleId: IDS.R_HCSO_DEPUTY,
        action: SyncActionType.ADD_ROLE,
      });
      expect(marker).toBeNull();
    });

    it('classifies a rate limit as retryable and a permission failure as permanent', async () => {
      gateway.failNext(IDS.HCSO_GUILD, IDS.D_DEPUTY, IDS.R_HCSO_DEPUTY, 429);
      const rateLimited = await syncMember(fixtures.users.deputy.id);
      const retryable = await prisma.syncIssue.findFirst({
        where: { syncJobId: rateLimited.id, type: SyncIssueType.RATE_LIMITED },
      });
      expect(retryable.details.retryable).toBe(true);

      gateway.failNext(IDS.HCSO_GUILD, IDS.D_DEPUTY, IDS.R_HCSO_DEPUTY, 50013);
      const denied = await syncMember(fixtures.users.deputy.id);
      const permanent = await prisma.syncIssue.findFirst({
        where: { syncJobId: denied.id, type: SyncIssueType.BOT_MISSING_PERMISSION },
      });
      expect(permanent.details.retryable).toBe(false);
    });

    it('skips a guild whose synchronization was disabled after planning', async () => {
      await prisma.approvedGuild.update({
        where: { id: fixtures.guilds.hcsoGuild.id },
        data: { syncEnabled: false },
      });

      const finished = await syncMember(fixtures.users.deputy.id);

      expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_DEPUTY)).toEqual([]);
      expect(gateway.rolesOf(IDS.MAIN_GUILD, IDS.D_DEPUTY)).toContain(IDS.R_MAIN_HCSO_MEMBER);
      expect(finished.status).toBe(SyncJobStatus.COMPLETED);
    });
  });

  // -------------------------------------------------------------------------

  describe('audit trail', () => {
    it('records job completion with the applied counts', async () => {
      const finished = await syncMember(fixtures.users.deputy.id);

      const audit = await prisma.auditLog.findFirst({
        where: { syncJobId: finished.id, action: 'sync.job_completed' },
      });
      expect(audit).not.toBeNull();
      expect(audit.newState.applied).toBe(3);
      expect(audit.newState.failed).toBe(0);
    });

    it('records a hire, its membership event and its sync job together', async () => {
      await hireMember(adminCtx, {
        departmentId: fixtures.departments.hcso.id,
        discordUserId: IDS.D_UNLINKED,
        rankId: fixtures.ranks.deputy.id,
        callsign: 'H-777',
        reason: 'new hire',
      });

      const audit = await prisma.auditLog.findFirst({ where: { action: 'roster.hired' } });
      expect(audit).not.toBeNull();
      expect(audit.syncJobId).toBeTruthy();

      const job = await prisma.syncJob.findUnique({ where: { id: audit.syncJobId } });
      expect(job.type).toBe(SyncJobType.ROSTER_CHANGE);

      const event = await prisma.membershipEvent.findFirst({ where: { type: 'HIRED' } });
      expect(event).not.toBeNull();
      expect(event.reason).toBe('new hire');
    });
  });
});
