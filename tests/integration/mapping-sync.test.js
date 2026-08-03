/**
 * Mapping propagation and loop protection, end to end.
 *
 * This is the scenario that would otherwise take a bot down: a two-way mapping where
 * every applied change produces a Discord event, which produces another change. The
 * test walks the whole cycle - human change, propagation, echo - and asserts that it
 * terminates.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMapping,
  createSyncJob,
  discordContext,
  handleMemberRoleChange,
  issueGrant,
  runSyncJob,
  systemContext,
} from '@frm/core';
import { loadActorByDiscordId } from '@frm/authorization';
import { closeQueues, closeRedis, getRedis } from '@frm/queue';
import { disconnectPrisma } from '@frm/database';
import { AuthoritySource, MappingDirection, SyncJobType } from '@frm/shared';
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

describe.skipIf(!available)('mapping propagation', () => {
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

  async function createMediaMapping(
    direction = MappingDirection.TWO_WAY,
    authority = AuthoritySource.SOURCE_DISCORD,
  ) {
    const { mapping } = await createMapping(
      adminCtx,
      {
        name: 'Media Team',
        sourceGuildId: IDS.MAIN_GUILD,
        sourceRoleId: IDS.R_MAIN_MEDIA,
        targetGuildId: IDS.HCSO_GUILD,
        targetRoleId: IDS.R_HCSO_MEDIA,
        direction,
        authority,
        enabled: true,
        reason: 'community interest role',
      },
      { gateway },
    );
    return mapping;
  }

  /** The department mapping: the community role in the main guild drives HCSO. */
  async function createMemberMapping() {
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
      },
      { gateway },
    );
    return mapping;
  }

  /** Runs the pending propagation job created by an event. */
  async function runJob(jobId) {
    return runSyncJob({ jobId, gateway, prisma });
  }

  // -------------------------------------------------------------------------

  it('propagates a manual role addition across a mapping', async () => {
    await createMediaMapping();

    // A human gives the member the Media Team role in the main guild.
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_MEMBER, roleIds: [IDS.R_MAIN_MEDIA] });

    const result = await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [IDS.R_MAIN_MEDIA],
      removedRoleIds: [],
      executorDiscordId: IDS.D_ADMIN,
      prisma,
    });

    expect(result.queued).toBe(true);

    await runJob(result.jobId);
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toContain(IDS.R_HCSO_MEDIA);
  });

  it('ignores the echo of its own change, which is what breaks the loop', async () => {
    await createMediaMapping();
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_MEMBER, roleIds: [IDS.R_MAIN_MEDIA] });

    // Round 1: the human change propagates into the HCSO guild.
    const first = await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [IDS.R_MAIN_MEDIA],
      removedRoleIds: [],
      prisma,
    });
    await runJob(first.jobId);
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toContain(IDS.R_HCSO_MEDIA);

    // Round 2: Discord now emits the event for the change the bot just made. Without
    // loop protection this would propagate back to the main guild, and round-trip
    // forever.
    const echo = await handleMemberRoleChange({
      discordGuildId: IDS.HCSO_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [IDS.R_HCSO_MEDIA],
      removedRoleIds: [],
      prisma,
    });

    expect(echo.queued).toBe(false);
    expect(echo.reason).toMatch(/system generated/i);
    expect(echo.systemChanges).toBe(1);
  });

  it('treats a genuine change in the target guild as human, once the marker is spent', async () => {
    await createMediaMapping();
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_MEMBER, roleIds: [IDS.R_MAIN_MEDIA] });

    const first = await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [IDS.R_MAIN_MEDIA],
      removedRoleIds: [],
      prisma,
    });
    await runJob(first.jobId);

    // The echo consumes the marker...
    await handleMemberRoleChange({
      discordGuildId: IDS.HCSO_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [IDS.R_HCSO_MEDIA],
      removedRoleIds: [],
      prisma,
    });

    // ...so a later, genuine removal by a human is recognised as such.
    const human = await handleMemberRoleChange({
      discordGuildId: IDS.HCSO_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [],
      removedRoleIds: [IDS.R_HCSO_MEDIA],
      prisma,
    });

    expect(human.queued).toBe(true);
  });

  it('ignores changes to roles the platform does not care about', async () => {
    await createMediaMapping();

    const result = await handleMemberRoleChange({
      discordGuildId: IDS.HCSO_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [IDS.R_UNMANAGED],
      removedRoleIds: [],
      prisma,
    });

    expect(result.queued).toBe(false);
    expect(result.reason).toMatch(/no managed or mapped roles/i);
  });

  it('ignores every change in a guild that is not approved', async () => {
    const result = await handleMemberRoleChange({
      discordGuildId: '888888888888888888',
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [IDS.R_MAIN_MEDIA],
      removedRoleIds: [],
      prisma,
    });

    expect(result.queued).toBe(false);
    expect(result.reason).toMatch(/not approved/i);
  });

  it('ignores changes in a guild whose synchronization is switched off', async () => {
    await prisma.approvedGuild.update({
      where: { id: fixtures.guilds.mainGuild.id },
      data: { syncEnabled: false },
    });

    const result = await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [IDS.R_MAIN_HCSO_MEMBER],
      removedRoleIds: [],
      prisma,
    });

    expect(result.queued).toBe(false);
    expect(result.reason).toMatch(/disabled/i);
  });

  it('records who made a manual change when Discord tells us', async () => {
    const result = await handleMemberRoleChange({
      discordGuildId: IDS.HCSO_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [IDS.R_HCSO_MEMBER],
      removedRoleIds: [],
      executorDiscordId: IDS.D_GUILD_ADMIN,
      prisma,
    });

    expect(result.queued).toBe(true);
    const audit = await prisma.auditLog.findFirst({
      where: { syncJobId: result.jobId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.newState.executorDiscordId).toBe(IDS.D_GUILD_ADMIN);
    expect(audit.actorDiscordId).toBe(IDS.D_GUILD_ADMIN);
  });

  it('reverts a manual addition of a mapped role, because the source guild decides', async () => {
    await createMemberMapping();

    // A supervisor hands out the department role directly in HCSO, without the member
    // having the community role that drives it.
    await gateway.addRole(IDS.HCSO_GUILD, IDS.D_MEMBER, IDS.R_HCSO_MEMBER, 'manual');

    const result = await handleMemberRoleChange({
      discordGuildId: IDS.HCSO_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [IDS.R_HCSO_MEMBER],
      removedRoleIds: [],
      prisma,
    });
    expect(result.queued).toBe(true);

    await runJob(result.jobId);

    // The next reconciliation takes it straight back off: an authoritative mapping can
    // compute the correct value of that role, and the correct value is "absent".
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).not.toContain(IDS.R_HCSO_MEMBER);
  });

  it('propagates for an unlinked Discord account, without touching what it cannot compute', async () => {
    await createMediaMapping();

    // A community member with no platform record holds the mapped media role's source,
    // plus a role that only a manual grant could ever justify.
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_UNLINKED, roleIds: [IDS.R_MAIN_MEDIA] });
    gateway.defineMember(IDS.HCSO_GUILD, { id: IDS.D_UNLINKED, roleIds: [IDS.R_GRANTABLE] });

    const result = await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_UNLINKED,
      addedRoleIds: [IDS.R_MAIN_MEDIA],
      removedRoleIds: [],
      prisma,
    });
    expect(result.queued).toBe(true);

    const job = await prisma.syncJob.findUnique({ where: { id: result.jobId } });
    expect(job.type).toBe(SyncJobType.MAPPING_PROPAGATION);

    await runJob(result.jobId);

    // The mapping applied...
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_UNLINKED)).toContain(IDS.R_HCSO_MEDIA);
    // ...and the grant-driven role was left alone. With no platform record the engine
    // cannot know whether a grant justifies it, and never removes what it cannot compute.
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_UNLINKED)).toContain(IDS.R_GRANTABLE);
  });

  it('propagates a removal when the mapping says to', async () => {
    await createMediaMapping(MappingDirection.ONE_WAY, AuthoritySource.SOURCE_DISCORD);

    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_MEMBER, roleIds: [IDS.R_MAIN_MEDIA] });
    gateway.defineMember(IDS.HCSO_GUILD, { id: IDS.D_MEMBER, roleIds: [IDS.R_HCSO_MEDIA] });

    // The source role is taken away by a human.
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_MEMBER, roleIds: [] });

    const result = await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [],
      removedRoleIds: [IDS.R_MAIN_MEDIA],
      prisma,
    });
    expect(result.queued).toBe(true);

    await runJob(result.jobId);
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).not.toContain(IDS.R_HCSO_MEDIA);
  });

  it('keeps a granted role that a mapping would otherwise remove, and records the conflict', async () => {
    // The grantable role is also the target of a mapping nobody satisfies.
    await createMapping(
      adminCtx,
      {
        name: 'Investigation access via community role',
        sourceGuildId: IDS.MAIN_GUILD,
        sourceRoleId: IDS.R_MAIN_MEDIA,
        targetGuildId: IDS.HCSO_GUILD,
        targetRoleId: IDS.R_GRANTABLE,
        enabled: true,
        reason: 'community shortcut',
      },
      { gateway },
    );

    await issueGrant(adminCtx, {
      discordUserId: IDS.D_MEMBER,
      managedRoleId: fixtures.managedRoles.grantable.id,
      reason: 'active investigation',
    });

    const job = await createSyncJob(prisma, systemContext({ label: 'test' }), {
      type: SyncJobType.MEMBER_RESYNC,
      targetUserId: fixtures.users.member.id,
      payload: { userId: fixtures.users.member.id },
    });
    await runJob(job.id);

    // The grant wins outright...
    expect(gateway.rolesOf(IDS.HCSO_GUILD, IDS.D_MEMBER)).toContain(IDS.R_GRANTABLE);
    // ...and the disagreement is surfaced rather than silently resolved.
    const issue = await prisma.syncIssue.findFirst({
      where: { syncJobId: job.id, type: 'MAPPING_CONFLICT' },
    });
    expect(issue).not.toBeNull();
    expect(issue.message).toMatch(/grant wins/i);
  });
});
