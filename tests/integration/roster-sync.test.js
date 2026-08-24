/**
 * The roster tracker, end to end.
 *
 * Against a real database, real Redis markers and the mock gateway. This is the suite
 * that proves the thing the community actually asked for: give somebody the Senior Admin
 * role in Discord, and their display name and their place on the website roster both
 * follow - take every staff role away, and they come off it again.
 *
 * The loop-protection case at the bottom is the one that matters most for correctness.
 * The bot rewrites nicknames, and Discord reports its own rewrite back as a
 * `guildMemberUpdate`. Without the marker the handler reads that as a member editing
 * their own nickname, rewrites it, and the two chase each other forever.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindRosterRank,
  createRoster,
  discordContext,
  getPublicRosters,
  handleMemberNicknameChange,
  handleMemberRoleChange,
  handleRoleDeleted,
  runRosterJob,
  setRosterMemberDetails,
  syncRoster,
} from '@frm/core';
import { loadActorByDiscordId } from '@frm/authorization';
import { closeQueues, closeRedis, writeNicknameMarker } from '@frm/queue';
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

const R_MOD = '940000000000000001';
const R_ADMIN = '940000000000000002';
const R_SENIOR = '940000000000000003';

describe.skipIf(!available)('roster tracking', () => {
  let gateway;
  let prisma;
  let ctx;

  /** Runs whatever the event handler queued, the way the worker would. */
  async function drainRosterJobs() {
    const jobs = await prisma.syncJob.findMany({
      where: { type: { in: ['ROSTER_SYNC', 'ROSTER_MEMBER_SYNC'] }, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    for (const job of jobs) {
      await runRosterJob({ jobId: job.id, gateway, prisma });
    }
    return jobs.length;
  }

  const membershipOf = (discordUserId) =>
    prisma.rosterMembership.findFirst({
      where: { discordUserId, roster: { slug: 'staff' } },
      include: { rank: true },
    });

  beforeEach(async () => {
    await resetDatabase();
    await seedCommunity();
    prisma = testPrisma();
    gateway = buildMockGateway();

    for (const [id, name] of [
      [R_MOD, 'Moderator'],
      [R_ADMIN, 'Administrator'],
      [R_SENIOR, 'Senior Administrator'],
    ]) {
      gateway.defineRole(IDS.MAIN_GUILD, { id, name, position: 20 });
    }

    ctx = discordContext(await loadActorByDiscordId(IDS.D_ADMIN), {
      discordGuildId: IDS.MAIN_GUILD,
    });

    await createRoster(ctx, {
      slug: 'staff',
      name: 'Staff Team',
      discordGuildId: IDS.MAIN_GUILD,
      reason: 'test fixture',
    });

    for (const [roleId, name, shortName, position] of [
      [R_MOD, 'Moderator', 'Mod', 10],
      [R_ADMIN, 'Administrator', 'Admin', 20],
      [R_SENIOR, 'Senior Administrator', 'Sr. Admin', 30],
    ]) {
      await bindRosterRank(ctx, {
        slug: 'staff',
        discordRoleId: roleId,
        name,
        shortName,
        position,
        reason: 'test fixture',
      });
    }
  });

  afterAll(async () => {
    await closeQueues().catch(() => {});
    await closeRedis().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await disconnectTestPrisma();
  });

  it('adds a member to the roster and renames them when they are given a staff role', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike_flrp',
      roleIds: [R_MOD],
    });

    const result = await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [R_MOD],
      removedRoleIds: [],
    });

    // The role is not mapped or managed, so role synchronization has nothing to do -
    // but the roster does. These are evaluated independently for exactly this reason.
    expect(result.rosterQueued).toBe(true);
    await drainRosterJobs();

    const membership = await membershipOf(IDS.D_MEMBER);
    expect(membership.status).toBe('ACTIVE');
    expect(membership.rank.name).toBe('Moderator');
    expect(gateway.nicknameOf(IDS.MAIN_GUILD, IDS.D_MEMBER)).toBe('Mod | mike_flrp');
  });

  it('moves them up the roster and rewrites the nickname on promotion', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike_flrp',
      roleIds: [R_MOD],
    });
    await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [R_MOD],
      removedRoleIds: [],
    });
    await drainRosterJobs();

    await setRosterMemberDetails(ctx, {
      slug: 'staff',
      discordUserId: IDS.D_MEMBER,
      callsign: '165',
      preferredName: 'Mike',
      reason: 'test fixture',
    });
    await drainRosterJobs();
    expect(gateway.nicknameOf(IDS.MAIN_GUILD, IDS.D_MEMBER)).toBe('165 | Mod | Mike');

    // The promotion: Senior Admin added, Moderator taken away.
    gateway.members.get(IDS.MAIN_GUILD).get(IDS.D_MEMBER).roleIds = new Set([R_SENIOR]);
    await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [R_SENIOR],
      removedRoleIds: [R_MOD],
    });
    await drainRosterJobs();

    const membership = await membershipOf(IDS.D_MEMBER);
    expect(membership.rank.name).toBe('Senior Administrator');
    expect(gateway.nicknameOf(IDS.MAIN_GUILD, IDS.D_MEMBER)).toBe('165 | Sr. Admin | Mike');
  });

  it('removes them from the roster and cleans the nickname when every staff role is stripped', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike_flrp',
      roleIds: [R_ADMIN],
    });
    await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [R_ADMIN],
      removedRoleIds: [],
    });
    await drainRosterJobs();
    await setRosterMemberDetails(ctx, {
      slug: 'staff',
      discordUserId: IDS.D_MEMBER,
      callsign: '165',
      preferredName: 'Mike',
      reason: 'test fixture',
    });
    await drainRosterJobs();
    expect(gateway.nicknameOf(IDS.MAIN_GUILD, IDS.D_MEMBER)).toBe('165 | Admin | Mike');

    // Stripped of everything.
    gateway.members.get(IDS.MAIN_GUILD).get(IDS.D_MEMBER).roleIds = new Set();
    await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [],
      removedRoleIds: [R_ADMIN],
    });
    await drainRosterJobs();

    const membership = await membershipOf(IDS.D_MEMBER);
    expect(membership.status).toBe('DEPARTED');
    expect(membership.rankId).toBeNull();
    expect(membership.departedAt).not.toBeNull();
    // Their name is left alone; only the rank the platform wrote is taken back.
    expect(gateway.nicknameOf(IDS.MAIN_GUILD, IDS.D_MEMBER)).toBe('Mike');

    const [roster] = await getPublicRosters({ slug: 'staff', prisma });
    expect(roster.ranks.flatMap((rank) => rank.members)).toEqual([]);
  });

  it('ignores a role change that touches nothing on the roster', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_MEMBER, roleIds: [IDS.R_UNMANAGED] });

    const result = await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [IDS.R_UNMANAGED],
      removedRoleIds: [],
    });

    expect(result.rosterQueued).toBe(false);
    expect(await drainRosterJobs()).toBe(0);
    expect(await membershipOf(IDS.D_MEMBER)).toBeNull();
  });

  it('is idempotent: a second sync over a correct roster writes nothing', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike_flrp',
      roleIds: [R_MOD],
    });
    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await drainRosterJobs();
    expect(gateway.nicknameOf(IDS.MAIN_GUILD, IDS.D_MEMBER)).toBe('Mod | mike_flrp');

    gateway.reset();
    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await drainRosterJobs();

    // Not "wrote the same value again" - wrote nothing at all. This is what makes the
    // scheduled sweep free, and what stops a prefix stacking on every pass.
    expect(gateway.calls.filter((call) => call.action === 'SET_NICKNAME')).toEqual([]);
    expect(gateway.nicknameOf(IDS.MAIN_GUILD, IDS.D_MEMBER)).toBe('Mod | mike_flrp');
  });

  it('brings existing staff onto a newly configured roster in one sweep', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike',
      roleIds: [R_SENIOR],
    });
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_OTHER, displayName: 'ana', roleIds: [R_MOD] });
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_UNLINKED, displayName: 'sam', roleIds: [] });

    await syncRoster(ctx, { slug: 'staff', reason: 'initial import' });
    await drainRosterJobs();

    const [roster] = await getPublicRosters({ slug: 'staff', prisma });
    const byRank = Object.fromEntries(
      roster.ranks.map((rank) => [rank.name, rank.members.map((m) => m.name)]),
    );
    expect(byRank['Senior Administrator']).toEqual(['mike']);
    expect(byRank.Moderator).toEqual(['ana']);
    // Somebody with no staff role is simply not on it.
    expect(roster.ranks.flatMap((r) => r.members).map((m) => m.name)).not.toContain('sam');
  });

  it('records an issue instead of failing when the bot cannot rename the server owner', async () => {
    gateway.defineGuild({
      id: IDS.MAIN_GUILD,
      name: 'Main',
      botHighestRolePosition: 100,
      ownerId: IDS.D_MEMBER,
    });
    gateway.defineRole(IDS.MAIN_GUILD, { id: R_MOD, name: 'Moderator', position: 20 });
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'owner',
      roleIds: [R_MOD],
    });

    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await drainRosterJobs();

    // The roster is still right, because the roster is not the nickname.
    const membership = await membershipOf(IDS.D_MEMBER);
    expect(membership.status).toBe('ACTIVE');
    expect(membership.rank.name).toBe('Moderator');

    const issue = await prisma.syncIssue.findFirst({ where: { discordUserId: IDS.D_MEMBER } });
    expect(issue.type).toBe('MEMBER_ABOVE_BOT');
    expect(issue.message).toMatch(/server owner/i);
  });

  it('restores the managed format when somebody edits their own nickname', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike_flrp',
      roleIds: [R_MOD],
    });
    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await drainRosterJobs();

    // The sync's own rename produces an event first, which claims the marker it left.
    // Feeding it in is what makes the edit below a genuine human one.
    const echo = await handleMemberNicknameChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      nickname: 'Mod | mike_flrp',
    });
    expect(echo.queued).toBe(false);

    // Now they rename themselves, dropping the rank.
    gateway.members.get(IDS.MAIN_GUILD).get(IDS.D_MEMBER).nickname = 'just mike';
    const result = await handleMemberNicknameChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      nickname: 'just mike',
    });

    expect(result.queued).toBe(true);
    await drainRosterJobs();
    expect(gateway.nicknameOf(IDS.MAIN_GUILD, IDS.D_MEMBER)).toBe('Mod | just mike');
  });

  it('does not react to a nickname it wrote itself', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike_flrp',
      roleIds: [R_MOD],
    });
    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await drainRosterJobs();

    // Exactly what the worker leaves behind before it renames somebody. The echo of that
    // write must be recognised as ours and go no further; if it were not, this queues a
    // job whose own write queues another, without end.
    await writeNicknameMarker({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      nickname: 'Mod | mike_flrp',
    });

    const result = await handleMemberNicknameChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      nickname: 'Mod | mike_flrp',
    });

    expect(result.queued).toBe(false);
    expect(result.reason).toMatch(/written by the platform/i);
    expect(await drainRosterJobs()).toBe(0);
  });

  it('consumes the marker once, so a later genuine edit is still corrected', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike_flrp',
      roleIds: [R_MOD],
    });
    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await drainRosterJobs();

    await writeNicknameMarker({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      nickname: 'Mod | mike_flrp',
    });

    const ours = await handleMemberNicknameChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      nickname: 'Mod | mike_flrp',
    });
    expect(ours.queued).toBe(false);

    // A single-use marker: the next event is a human one and must be acted on.
    const theirs = await handleMemberNicknameChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      nickname: 'something else',
    });
    expect(theirs.queued).toBe(true);
  });

  it('refuses a callsign another member on the roster already holds', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike',
      roleIds: [R_MOD],
    });
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_OTHER, displayName: 'ana', roleIds: [R_MOD] });
    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await drainRosterJobs();

    await setRosterMemberDetails(ctx, {
      slug: 'staff',
      discordUserId: IDS.D_MEMBER,
      callsign: '165',
      reason: 'test fixture',
    });

    // Two people answering to 165 on the same roster is a data-entry mistake, not a
    // configuration choice.
    await expect(
      setRosterMemberDetails(ctx, {
        slug: 'staff',
        discordUserId: IDS.D_OTHER,
        callsign: '165',
        reason: 'test fixture',
      }),
    ).rejects.toThrow(/already held/i);
  });

  it('unbinds the rank instead of emptying the roster when its role is deleted', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike',
      roleIds: [R_MOD],
    });
    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_OTHER, displayName: 'ana', roleIds: [R_MOD] });
    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await drainRosterJobs();

    // Somebody deletes the Moderator role in Discord.
    gateway.deleteRole(IDS.MAIN_GUILD, R_MOD);
    await handleRoleDeleted({
      discordGuildId: IDS.MAIN_GUILD,
      discordRoleId: R_MOD,
      roleName: 'Moderator',
    });

    const rank = await prisma.rosterRank.findFirst({ where: { discordRoleId: R_MOD } });
    expect(rank.deletedAt).not.toBeNull();

    // The people who held it are unranked, not removed. Deleting one role must not take
    // the whole rank off a public roster and rename all of them.
    const membership = await membershipOf(IDS.D_MEMBER);
    expect(membership.status).toBe('ACTIVE');
    expect(membership.rankId).toBeNull();

    const issue = await prisma.syncIssue.findFirst({ where: { discordRoleId: R_MOD } });
    expect(issue.type).toBe('ROLE_DELETED');
    expect(issue.message).toMatch(/unbound/i);
  });

  it('pauses rather than performing a mass removal', async () => {
    // Six members on the roster, with the threshold lowered to five.
    const ids = [
      '950000000000000010',
      '950000000000000011',
      '950000000000000012',
      '950000000000000013',
      '950000000000000014',
      '950000000000000015',
    ];
    for (const id of ids) {
      gateway.defineMember(IDS.MAIN_GUILD, {
        id,
        displayName: `staff${id.slice(-2)}`,
        roleIds: [R_MOD],
      });
    }
    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await drainRosterJobs();
    expect(await prisma.rosterMembership.count({ where: { status: 'ACTIVE' } })).toBe(6);

    await prisma.systemSetting.create({
      data: { key: 'sync.maxRemovalsThreshold', value: 5 },
    });

    // Everybody loses the role at once - the shape of a deleted or unbound rank role,
    // not of six simultaneous resignations.
    for (const id of ids) {
      gateway.members.get(IDS.MAIN_GUILD).get(id).roleIds = new Set();
    }
    gateway.reset();

    const { jobId } = await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await drainRosterJobs();

    const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
    expect(job.status).toBe('PAUSED');
    expect(job.thresholdBreached).toBe(true);

    // Nothing was applied: still on the roster, still named.
    expect(await prisma.rosterMembership.count({ where: { status: 'ACTIVE' } })).toBe(6);
    expect(gateway.calls.filter((call) => call.action === 'SET_NICKNAME')).toEqual([]);

    const issue = await prisma.syncIssue.findFirst({ where: { syncJobId: jobId } });
    expect(issue.type).toBe('THRESHOLD_EXCEEDED');
  });

  it('gives one roster the nickname when a member is on two in the same guild', async () => {
    // A department roster alongside the staff team, lower priority.
    await createRoster(ctx, {
      slug: 'hcso',
      name: 'HCSO',
      discordGuildId: IDS.MAIN_GUILD,
      position: 5,
      reason: 'test fixture',
    });
    await bindRosterRank(ctx, {
      slug: 'hcso',
      discordRoleId: R_ADMIN,
      name: 'Deputy',
      shortName: 'Dep',
      position: 10,
      reason: 'test fixture',
    });
    // 'staff' was created at position 0, so it outranks 'hcso' for the nickname.

    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike',
      roleIds: [R_MOD, R_ADMIN],
    });

    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await syncRoster(ctx, { slug: 'hcso', reason: 'test fixture' });
    await drainRosterJobs();

    // On both rosters...
    const staff = await membershipOf(IDS.D_MEMBER);
    const hcso = await prisma.rosterMembership.findFirst({
      where: { discordUserId: IDS.D_MEMBER, roster: { slug: 'hcso' } },
      include: { rank: true },
    });
    expect(staff.status).toBe('ACTIVE');
    expect(hcso.rank.name).toBe('Deputy');

    // ...but only the higher-priority roster writes the nickname. Without this the two
    // overwrite each other on every sync, each reading the other's write as drift.
    expect(gateway.nicknameOf(IDS.MAIN_GUILD, IDS.D_MEMBER)).toBe('Admin | mike');

    // And it stays settled: re-running both changes nothing.
    gateway.reset();
    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await syncRoster(ctx, { slug: 'hcso', reason: 'test fixture' });
    await drainRosterJobs();
    expect(gateway.calls.filter((call) => call.action === 'SET_NICKNAME')).toEqual([]);
  });

  it('does not let a roster failure break role synchronization', async () => {
    // What a rolling deploy looks like from the bot's side: new code running against a
    // database where the roster migration has not landed yet. Rosters are secondary and
    // must degrade quietly; role sync is what was already in production.
    const broken = new Proxy(prisma, {
      get(target, key) {
        if (key === 'rosterRank') {
          return {
            findMany: () => Promise.reject(new Error('relation "roster_ranks" does not exist')),
          };
        }
        return target[key];
      },
    });

    gateway.defineMember(IDS.MAIN_GUILD, { id: IDS.D_MEMBER, roleIds: [R_MOD] });

    const result = await handleMemberRoleChange({
      discordGuildId: IDS.MAIN_GUILD,
      discordUserId: IDS.D_MEMBER,
      addedRoleIds: [R_MOD],
      removedRoleIds: [],
      prisma: broken,
    });

    // It returned rather than threw, and reported the roster as simply not queued.
    expect(result.rosterQueued).toBe(false);
  });

  it('serves only published rosters to the website', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike',
      roleIds: [R_MOD],
    });
    await syncRoster(ctx, { slug: 'staff', reason: 'test fixture' });
    await drainRosterJobs();

    expect(await getPublicRosters({ prisma })).toHaveLength(1);

    await prisma.roster.updateMany({ where: { slug: 'staff' }, data: { published: false } });
    expect(await getPublicRosters({ prisma })).toEqual([]);
  });

  it('does not write to Discord on a dry run', async () => {
    gateway.defineMember(IDS.MAIN_GUILD, {
      id: IDS.D_MEMBER,
      displayName: 'mike',
      roleIds: [R_MOD],
    });

    await syncRoster(ctx, { slug: 'staff', dryRun: true, reason: 'preview' });
    await drainRosterJobs();

    expect(gateway.calls.filter((call) => call.action === 'SET_NICKNAME')).toEqual([]);
    expect(await membershipOf(IDS.D_MEMBER)).toBeNull();
  });
});
