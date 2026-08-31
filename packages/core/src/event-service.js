/**
 * Discord event handling.
 *
 * The bot's event listeners are thin: they normalise the discord.js payload and call
 * into here, so the decision logic is testable without a gateway connection.
 *
 * The central decision for a role change is a three-way one:
 *
 *   1. **Did we do this?** Claim the loop-protection marker. If a marker exists, this
 *      event is the echo of our own write and must go no further. This is what stops
 *      two-way mappings from ping-ponging forever.
 *   2. **Does it matter?** If the role is neither platform-managed nor part of an
 *      enabled mapping, ignore it. Members' own roles are their own business.
 *   3. **Then reconcile.** Queue a resync for that member. Reconciliation is idempotent
 *      and computes the whole correct state, so a manual change that contradicts a
 *      mapping gets corrected on the next pass rather than being propagated.
 *
 * Rosters hang off the same event, and are evaluated independently: a role can confer a
 * roster rank without being mapped or managed, so "no mapping cares about this role" must
 * not be allowed to skip the roster. Both answers are reported in the result.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import {
  ActionSource,
  AuditAction,
  GuildType,
  IssueSeverity,
  NicknamePriority,
  RosterMembershipStatus,
  SyncActionType,
  SyncIssueType,
  SyncJobType,
} from '@frm/shared';
import { loadActor } from '@frm/authorization';
import {
  claimNicknameMarker,
  claimSyncMarker,
  discardNicknameMarker,
  writeNicknameMarker,
} from '@frm/queue';
import { recordAudit } from './audit-service.js';
import { systemContext } from './context.js';
import { createSyncJob, enqueueSyncJob } from './sync-service.js';
import { findApprovedGuildBySnowflake } from './resolve.js';
import { parseNickname } from './roster-nickname.js';
import { queueRosterSync } from './roster-service.js';
import { resolveTierAccessForMember, syncWebsiteAccess } from './access-service.js';
import { notifyGlobalAdmins } from './notify.js';

const log = createLogger('core.events');

/**
 * Handles a member's roles changing in a guild.
 *
 * @param {object} params
 * @param {string} params.discordGuildId
 * @param {string} params.discordUserId
 * @param {string[]} params.addedRoleIds
 * @param {string[]} params.removedRoleIds
 * @param {string|null} [params.executorDiscordId] who made the change, from the audit log
 * @param {object} [params.gateway] used to re-read live roles when an access-tier role
 *   changed, so website access is revoked immediately rather than at the next sweep
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 * @returns {Promise<{queued: boolean, reason: string, systemChanges?: number}>}
 */
export async function handleMemberRoleChange({
  discordGuildId,
  discordUserId,
  addedRoleIds = [],
  removedRoleIds = [],
  executorDiscordId = null,
  gateway = null,
  prisma = getPrisma(),
}) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);
  if (!guild || !guild.enabled) {
    return { queued: false, reason: 'guild is not approved' };
  }
  if (!guild.syncEnabled) {
    return { queued: false, reason: 'synchronization is disabled for this guild' };
  }

  // Step 1: consume markers for anything we did ourselves.
  const humanChanges = { added: [], removed: [] };
  let systemChanges = 0;

  for (const roleId of addedRoleIds) {
    const marker = await claimSyncMarker({
      discordGuildId,
      discordUserId,
      discordRoleId: roleId,
      action: SyncActionType.ADD_ROLE,
    }).catch((error) => {
      // If Redis is unavailable we must fail safe. Treating the change as human would
      // risk a propagation loop, so it is ignored and scheduled reconciliation repairs
      // any drift.
      log.error({ err: serializeError(error) }, 'marker lookup failed; ignoring role change');
      return { failedLookup: true };
    });
    if (marker) systemChanges += 1;
    else humanChanges.added.push(roleId);
  }

  for (const roleId of removedRoleIds) {
    const marker = await claimSyncMarker({
      discordGuildId,
      discordUserId,
      discordRoleId: roleId,
      action: SyncActionType.REMOVE_ROLE,
    }).catch((error) => {
      log.error({ err: serializeError(error) }, 'marker lookup failed; ignoring role change');
      return { failedLookup: true };
    });
    if (marker) systemChanges += 1;
    else humanChanges.removed.push(roleId);
  }

  const changedRoleIds = [...humanChanges.added, ...humanChanges.removed];
  if (changedRoleIds.length === 0) {
    return { queued: false, reason: 'all changes were system generated', systemChanges };
  }

  // Step 2a: website access. A tier-mapped role changing hands is the one case where a
  // stale `websiteAccess` flag matters, so it is recomputed from live roles here rather
  // than left to the scheduled sweep - losing a staff role should lose the dashboard now,
  // not in six hours.
  await syncWebsiteAccessForRoleChange({
    prisma,
    guild,
    discordUserId,
    roleIds: changedRoleIds,
    gateway,
  }).catch((error) => {
    log.error({ err: serializeError(error) }, 'website access sync failed');
  });

  // Step 2b: rosters. Evaluated before the mapping check returns, because a rank role is
  // frequently neither managed nor mapped - it exists only to say who is a Senior Admin.
  //
  // Isolated deliberately. Rosters are a secondary concern layered onto an event that
  // role synchronization already depended on, and they must never be able to break it:
  // a roster failure here - a migration that has not landed yet on a rolling deploy, a
  // query that errors - degrades to "no roster work queued" and is repaired by the
  // scheduled sweep, rather than taking the whole role change down with it.
  const rosterResult = await queueRosterSyncForRoles({
    prisma,
    guild,
    discordUserId,
    roleIds: changedRoleIds,
    executorDiscordId,
  }).catch((error) => {
    log.error({ err: serializeError(error) }, 'roster evaluation failed; continuing');
    return { rosterQueued: false, rosterJobIds: [] };
  });

  // Step 2c: is any changed role relevant to role synchronization?
  const relevant = await filterRelevantRoles(prisma, guild.id, changedRoleIds);
  if (relevant.length === 0) {
    return {
      queued: false,
      reason: 'no managed or mapped roles were affected',
      systemChanges,
      ...rosterResult,
    };
  }

  // Step 3: reconcile the member.
  const identity = await prisma.discordIdentity.findUnique({
    where: { discordUserId },
    select: { userId: true },
  });

  const ctx = systemContext({ label: 'discord-event' });
  const ctxWithActor = {
    ...ctx,
    actor: { ...ctx.actor, discordUserId: executorDiscordId },
    source: ActionSource.DISCORD,
  };

  const job = await prisma.$transaction(async (tx) => {
    const created = await createSyncJob(tx, ctxWithActor, {
      // A linked member gets a full reconciliation (mappings + their manual grants). An
      // unlinked Discord account gets mapping-only propagation, since it cannot hold a
      // grant in the first place.
      type: identity ? SyncJobType.MEMBER_RESYNC : SyncJobType.MAPPING_PROPAGATION,
      targetUserId: identity?.userId ?? null,
      approvedGuildId: guild.id,
      dryRun: false,
      reason: 'Discord role change detected',
      payload: {
        userId: identity?.userId ?? null,
        discordUserId,
        originGuildId: discordGuildId,
        addedRoleIds: humanChanges.added,
        removedRoleIds: humanChanges.removed,
      },
    });

    await recordAudit(tx, {
      ctx: ctxWithActor,
      action:
        humanChanges.added.length > 0 ? AuditAction.SYNC_ROLE_ADDED : AuditAction.SYNC_ROLE_REMOVED,
      targetUserId: identity?.userId ?? null,
      targetDiscordId: discordUserId,
      approvedGuildId: guild.id,
      syncJobId: created.id,
      reason: 'Manual Discord role change observed',
      newState: {
        added: humanChanges.added,
        removed: humanChanges.removed,
        relevantRoles: relevant,
        executorDiscordId,
      },
    });

    return created;
  });

  await enqueueSyncJob(job, { prisma });

  // A role change can change a member's rank, and with it the name their
  // authoritative guild shows — so re-mirror their name to every guild. Best-effort
  // and gateway-driven; a failure never blocks the role reconciliation above.
  await propagateMemberName({ prisma, gateway, discordUserId }).catch((error) => {
    log.error({ err: serializeError(error), discordUserId }, 'name propagation on role change failed');
  });

  return {
    queued: true,
    reason: 'reconciliation queued',
    jobId: job.id,
    systemChanges,
    ...rosterResult,
  };
}

/**
 * Recomputes website access when a changed role is mapped to an access tier.
 *
 * Only touches the member when one of the changed roles is actually tier-mapped, so an
 * ordinary role change costs one indexed query and nothing else.
 */
async function syncWebsiteAccessForRoleChange({ prisma, guild, discordUserId, roleIds, gateway }) {
  if (!gateway || guild.type !== GuildType.MAIN_COMMUNITY) return;

  const mapped = await prisma.roleAccessTier.count({
    where: { ...notDeleted, discordRoleId: { in: roleIds } },
  });
  if (mapped === 0) return;

  const actor = await loadActor({ discordUserId, prisma, required: false });
  if (!actor) return;

  const access = await resolveTierAccessForMember({ discordUserId, gateway, prisma });
  await syncWebsiteAccess({ user: actor.user, access, prisma });
}

/**
 * Queues a roster reconciliation when a changed role is bound to a rank.
 *
 * One job per affected roster, and only for rosters whose ranks actually reference one of
 * the changed roles - a member gaining an unrelated colour role must not set the whole
 * roster machinery going.
 *
 * @returns {Promise<{rosterQueued: boolean, rosterJobIds: string[]}>}
 */
async function queueRosterSyncForRoles({
  prisma,
  guild,
  discordUserId,
  roleIds,
  executorDiscordId,
}) {
  const ranks = await prisma.rosterRank.findMany({
    where: {
      ...notDeleted,
      discordRoleId: { in: roleIds },
      roster: { ...notDeleted, approvedGuildId: guild.id },
    },
    select: { rosterId: true, roster: { select: { id: true, slug: true, approvedGuildId: true } } },
  });

  if (ranks.length === 0) return { rosterQueued: false, rosterJobIds: [] };

  const rosters = new Map(ranks.map((rank) => [rank.rosterId, rank.roster]));
  const ctx = systemContext({ label: 'discord-event' });
  const ctxWithActor = {
    ...ctx,
    actor: { ...ctx.actor, discordUserId: executorDiscordId },
    source: ActionSource.DISCORD,
  };

  const jobIds = [];
  for (const roster of rosters.values()) {
    const job = await queueRosterSync(ctxWithActor, {
      roster,
      discordUserId,
      reason: 'Discord role change affecting a roster rank',
      prisma,
    }).catch((error) => {
      log.error({ err: serializeError(error), slug: roster.slug }, 'could not queue roster sync');
      return null;
    });
    if (job) jobIds.push(job.id);
  }

  return { rosterQueued: jobIds.length > 0, rosterJobIds: jobIds };
}

/**
 * A member's nickname changed.
 *
 * The platform owns the nickname of anybody on a roster with nickname synchronization on,
 * so an edit by hand is drift and gets corrected - otherwise the format is advisory and a
 * staff member can quietly drop their rank from their name.
 *
 * The marker is what makes this safe. Every nickname the worker writes leaves one behind,
 * and claiming it here identifies the event as our own echo. Without that, the bot's own
 * rewrite would look like a hand edit and it would rewrite its rewrite, forever.
 *
 * @param {object} params
 * @param {string} params.discordGuildId
 * @param {string} params.discordUserId
 * @param {string|null} [params.nickname] the new nickname
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 */
export async function handleMemberNicknameChange({
  discordGuildId,
  discordUserId,
  nickname = null,
  gateway = null,
  prisma = getPrisma(),
}) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);
  if (!guild || !guild.enabled || !guild.syncEnabled) {
    return { queued: false, reason: 'guild is not approved or synchronization is disabled' };
  }

  const marker = await claimNicknameMarker({ discordGuildId, discordUserId }).catch((error) => {
    // Fail safe, exactly as the role path does: treating our own write as a human edit
    // would start a rename loop, and the scheduled sweep repairs any drift we ignore.
    log.error({ err: serializeError(error) }, 'nickname marker lookup failed; ignoring');
    return { failedLookup: true };
  });
  if (marker) {
    return { queued: false, reason: 'nickname was written by the platform' };
  }

  // Mirror the member's name across every guild they share with the bot, sourced from
  // their authoritative guild (see NicknamePriority). An edit in the authoritative guild
  // spreads outward; an edit anywhere else is pulled back to the authoritative name.
  try {
    await propagateMemberName({ prisma, gateway, discordUserId });
  } catch (error) {
    log.error({ err: serializeError(error), discordUserId }, 'nickname propagation failed');
  }

  // The rosters this member holds in *this* guild still need reconciling so the edited
  // nickname keeps its callsign/rank prefix here.
  const memberships = await prisma.rosterMembership.findMany({
    where: {
      discordUserId,
      status: RosterMembershipStatus.ACTIVE,
      roster: { ...notDeleted, approvedGuildId: guild.id, nicknameSyncEnabled: true },
    },
    select: { roster: { select: { id: true, slug: true, approvedGuildId: true } } },
  });

  const ctx = { ...systemContext({ label: 'discord-event' }), source: ActionSource.DISCORD };
  const jobIds = [];
  for (const { roster } of memberships) {
    const job = await queueRosterSync(ctx, {
      roster,
      discordUserId,
      reason: 'Nickname edited outside the platform',
      prisma,
    }).catch((error) => {
      log.error({ err: serializeError(error), slug: roster.slug }, 'could not queue roster sync');
      return null;
    });
    if (job) jobIds.push(job.id);
  }

  log.debug({ discordUserId, nickname, jobs: jobIds.length }, 'nickname drift handled');
  return { queued: true, reason: 'nickname reconciliation queued', jobIds };
}

/**
 * The guild whose nickname is the source of a member's name.
 *
 * MAIN (staff/dev/director/owner ranks) wins outright — the main community's name
 * everywhere. Otherwise the highest DEPARTMENT rank makes its own guild the source,
 * for a full-time member whose department name should show. With neither, the main
 * community is the default source. Returns null for a member on no nickname roster at
 * all: they are not tracked, so their name is their own business.
 *
 * @returns {Promise<{id: string, discordGuildId: string}|null>}
 */
async function resolveNameAuthorityGuild({ prisma, discordUserId }) {
  const memberships = await prisma.rosterMembership.findMany({
    where: {
      discordUserId,
      status: RosterMembershipStatus.ACTIVE,
      roster: { ...notDeleted, nicknameSyncEnabled: true },
    },
    select: {
      rank: { select: { nicknamePriority: true, position: true } },
      roster: {
        select: { guild: { select: { id: true, discordGuildId: true, type: true } } },
      },
    },
  });
  if (memberships.length === 0) return null;

  let mainCommunityGuild = null;
  let hasMainRank = false;
  let bestDept = null; // { guild, position }
  for (const m of memberships) {
    const guild = m.roster.guild;
    if (guild?.type === GuildType.MAIN_COMMUNITY) mainCommunityGuild = guild;
    const priority = m.rank?.nicknamePriority ?? NicknamePriority.NONE;
    if (priority === NicknamePriority.MAIN) hasMainRank = true;
    else if (priority === NicknamePriority.DEPARTMENT) {
      const position = m.rank?.position ?? 0;
      if (!bestDept || position > bestDept.position) bestDept = { guild, position };
    }
  }

  const pick = (guild) => (guild ? { id: guild.id, discordGuildId: guild.discordGuildId } : null);

  if (hasMainRank && mainCommunityGuild) return pick(mainCommunityGuild);
  if (bestDept) return pick(bestDept.guild);
  if (mainCommunityGuild) return pick(mainCommunityGuild);
  // On a roster, but not the main community and no priority rank: fall back to the
  // configured main community guild so the name still has one source of truth.
  const main = await prisma.approvedGuild.findFirst({
    where: { type: GuildType.MAIN_COMMUNITY, enabled: true, ...notDeleted },
    select: { id: true, discordGuildId: true },
  });
  return main ?? null;
}

/**
 * Mirror a member's name from their authoritative guild to every guild they share with
 * the bot. A guild where they hold a roster rank keeps its own callsign/rank prefix — the
 * name is set through `syncedName` and a roster reconcile. A guild where they are on no
 * roster (a staff member sitting in a department server, say) gets an exact 1:1 copy of
 * the authority guild's whole nickname — callsign, rank and name — so their identity reads
 * identically everywhere the bot can see them. Marks every write so the resulting event is
 * not read back as a hand edit. Best-effort per guild; needs the gateway, so it is a no-op
 * without one.
 */
async function propagateMemberName({ prisma, gateway, discordUserId }) {
  if (!gateway) return { propagated: false, reason: 'no gateway' };

  const authority = await resolveNameAuthorityGuild({ prisma, discordUserId });
  if (!authority) return { propagated: false, reason: 'member is not on any nickname roster' };

  const authMember = await gateway.getMember(authority.discordGuildId, discordUserId).catch(() => null);
  if (!authMember) return { propagated: false, reason: 'not in the authoritative guild' };
  const name = parseNickname(authMember.displayName).name || String(authMember.displayName ?? '').trim();
  if (!name) return { propagated: false, reason: 'no name to propagate' };
  // The authority guild's whole nickname, verbatim — for guilds where the member is on no
  // local roster. It already fits Discord's 32-char cap because it exists as a nickname
  // there, so it can be copied across without re-truncation. A guild where they *do* hold
  // a roster still uses `name` + that roster's own format, below.
  const fullNick = String(authMember.displayName ?? '').trim() || name;

  const guilds = await prisma.approvedGuild.findMany({
    where: { ...notDeleted, enabled: true, syncEnabled: true, id: { not: authority.id } },
    select: { id: true, discordGuildId: true },
  });
  if (guilds.length === 0) return { propagated: false, reason: 'no other guilds' };

  // Which of those guilds the member holds a nickname roster in: those get the name via
  // syncedName + a reconcile, so the roster's rank prefix survives.
  const rosterRows = await prisma.rosterMembership.findMany({
    where: {
      discordUserId,
      status: RosterMembershipStatus.ACTIVE,
      roster: {
        ...notDeleted,
        nicknameSyncEnabled: true,
        approvedGuildId: { in: guilds.map((g) => g.id) },
      },
    },
    select: { id: true, syncedName: true, roster: { select: { id: true, slug: true, approvedGuildId: true } } },
  });
  const rosterByGuild = new Map();
  for (const row of rosterRows) {
    const list = rosterByGuild.get(row.roster.approvedGuildId) ?? [];
    list.push(row);
    rosterByGuild.set(row.roster.approvedGuildId, list);
  }

  const ctx = { ...systemContext({ label: 'name-sync' }), source: ActionSource.DISCORD };
  const jobIds = [];

  for (const guild of guilds) {
    const rosterMemberships = rosterByGuild.get(guild.id);
    if (rosterMemberships?.length) {
      const toWrite = rosterMemberships.filter((m) => m.syncedName !== name);
      if (toWrite.length) {
        await prisma.rosterMembership.updateMany({
          where: { id: { in: toWrite.map((m) => m.id) } },
          data: { syncedName: name },
        });
      }
      const rosters = new Map(rosterMemberships.map((m) => [m.roster.id, m.roster]));
      for (const roster of rosters.values()) {
        const job = await queueRosterSync(ctx, {
          roster,
          discordUserId,
          reason: 'Name synced from authoritative guild',
          prisma,
        }).catch(() => null);
        if (job) jobIds.push(job.id);
      }
      continue;
    }

    // No roster here: mirror the authority guild's whole nickname verbatim, so this guild
    // shows an exact 1:1 copy — callsign, rank and name. Skip if it already matches.
    const member = await gateway.getMember(guild.discordGuildId, discordUserId).catch(() => null);
    if (!member) continue;
    if (String(member.displayName ?? '').trim() === fullNick) continue;

    await writeNicknameMarker({
      discordGuildId: guild.discordGuildId,
      discordUserId,
      nickname: fullNick,
    }).catch(() => {});
    try {
      await gateway.setNickname(guild.discordGuildId, discordUserId, fullNick, 'FRM name sync');
    } catch (error) {
      await discardNicknameMarker({ discordGuildId: guild.discordGuildId, discordUserId }).catch(() => {});
      log.warn({ err: serializeError(error), guild: guild.discordGuildId }, 'name mirror failed');
    }
  }

  // The authoritative guild's own rows never carry a synced name — the local nickname
  // rules there — so clear any left over from a previous authority.
  await prisma.rosterMembership
    .updateMany({
      where: {
        discordUserId,
        status: RosterMembershipStatus.ACTIVE,
        roster: { approvedGuildId: authority.id },
        syncedName: { not: null },
      },
      data: { syncedName: null },
    })
    .catch(() => {});

  return { propagated: true, name, jobIds };
}

/**
 * Which of these roles does the platform care about?
 *
 * A role matters when it is a managed role or when it appears on
 * either side of an enabled mapping.
 */
async function filterRelevantRoles(prisma, approvedGuildId, roleIds) {
  if (roleIds.length === 0) return [];

  const [managed, mappings] = await Promise.all([
    prisma.managedRole.findMany({
      where: { approvedGuildId, discordRoleId: { in: roleIds }, ...notDeleted },
      select: { discordRoleId: true },
    }),
    prisma.roleMapping.findMany({
      where: {
        ...notDeleted,
        enabled: true,
        OR: [
          { sourceGuildId: approvedGuildId, sourceRoleId: { in: roleIds } },
          { targetGuildId: approvedGuildId, targetRoleId: { in: roleIds } },
        ],
      },
      select: { sourceRoleId: true, targetRoleId: true },
    }),
  ]);

  const relevant = new Set(managed.map((row) => row.discordRoleId));
  for (const mapping of mappings) {
    if (roleIds.includes(mapping.sourceRoleId)) relevant.add(mapping.sourceRoleId);
    if (roleIds.includes(mapping.targetRoleId)) relevant.add(mapping.targetRoleId);
  }
  return [...relevant];
}

/**
 * A member joined an approved guild: give them the roles they should already have.
 */
export async function handleMemberJoin({ discordGuildId, discordUserId, prisma = getPrisma() }) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);
  if (!guild || !guild.enabled || !guild.syncEnabled) {
    return { queued: false, reason: 'guild is not approved or synchronization is disabled' };
  }

  const identity = await prisma.discordIdentity.findUnique({
    where: { discordUserId },
    select: { userId: true },
  });
  if (!identity) return { queued: false, reason: 'member is not linked to a platform account' };

  const ctx = systemContext({ label: 'discord-event' });
  const job = await createSyncJob(prisma, ctx, {
    type: SyncJobType.MEMBER_RESYNC,
    targetUserId: identity.userId,
    approvedGuildId: guild.id,
    dryRun: false,
    reason: 'Member joined an approved guild',
    payload: { userId: identity.userId },
  });

  await enqueueSyncJob(job, { prisma });
  return { queued: true, jobId: job.id };
}

/**
 * A member left an approved guild.
 *
 * Nothing is changed in the database. Leaving a Discord server is not a revocation of
 * anything, and quietly revoking somebody's grants on a misclick would be far worse than
 * a stale record. If they still hold a grant for a role in *this* guild, that is worth
 * telling an administrator about, because the grant can no longer be applied.
 */
export async function handleMemberLeave({ discordGuildId, discordUserId, prisma = getPrisma() }) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);
  if (!guild) return { recorded: false };

  const identity = await prisma.discordIdentity.findUnique({
    where: { discordUserId },
    select: { userId: true },
  });
  if (!identity) return { recorded: false };

  const activeGrants = await prisma.manualRoleGrant.count({
    where: {
      userId: identity.userId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      managedRole: { approvedGuildId: guild.id },
    },
  });

  if (activeGrants > 0) {
    await prisma.syncIssue.create({
      data: {
        type: SyncIssueType.MEMBER_NOT_IN_GUILD,
        severity: IssueSeverity.WARNING,
        approvedGuildId: guild.id,
        discordGuildId,
        userId: identity.userId,
        discordUserId,
        message:
          `A member holding ${activeGrants} active role grant(s) for this server has left it. ` +
          'The grants are unchanged; revoke them if the access is no longer intended.',
      },
    });
  }

  return { recorded: true, activeGrants };
}

/**
 * A role was deleted in Discord.
 *
 * Everything referencing it is now broken, so the mappings are disabled (an enabled
 * mapping pointing at a deleted role fails on every single sync) and an issue is raised
 * for each managed role definition that needs updating.
 */
export async function handleRoleDeleted({
  discordGuildId,
  discordRoleId,
  roleName,
  prisma = getPrisma(),
}) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);
  if (!guild) return { affected: 0 };

  const [managedRoles, mappings, rosterRanks] = await Promise.all([
    prisma.managedRole.findMany({
      where: { approvedGuildId: guild.id, discordRoleId, ...notDeleted },
    }),
    prisma.roleMapping.findMany({
      where: {
        ...notDeleted,
        OR: [
          { sourceGuildId: guild.id, sourceRoleId: discordRoleId },
          { targetGuildId: guild.id, targetRoleId: discordRoleId },
        ],
      },
    }),
    prisma.rosterRank.findMany({
      where: {
        ...notDeleted,
        discordRoleId,
        roster: { ...notDeleted, approvedGuildId: guild.id },
      },
      include: { roster: { select: { id: true, slug: true, name: true } } },
    }),
  ]);

  // The rank has to be unbound explicitly. If it were left bound, the next
  // reconciliation would find that nobody holds a role that no longer exists, conclude
  // the entire rank has resigned, and strip every one of them from the roster and their
  // nicknames. Unbinding leaves them on the roster without a rank, which is recoverable.
  if (rosterRanks.length > 0) {
    await unbindDeletedRanks({ prisma, guild, discordRoleId, roleName, rosterRanks });
  }

  if (managedRoles.length === 0 && mappings.length === 0) {
    return { affected: rosterRanks.length, rosterRanks: rosterRanks.length };
  }

  const ctx = systemContext({ label: 'discord-event' });

  await prisma.$transaction(async (tx) => {
    if (mappings.length > 0) {
      await tx.roleMapping.updateMany({
        where: { id: { in: mappings.map((mapping) => mapping.id) } },
        data: { enabled: false },
      });
    }

    for (const mapping of mappings) {
      await tx.syncIssue.create({
        data: {
          type: SyncIssueType.ROLE_DELETED,
          severity: IssueSeverity.ERROR,
          approvedGuildId: guild.id,
          discordGuildId,
          mappingId: mapping.id,
          discordRoleId,
          message:
            `The role "${roleName ?? discordRoleId}" used by mapping "${mapping.name}" was deleted in Discord. ` +
            'The mapping has been disabled.',
        },
      });
    }

    for (const managed of managedRoles) {
      await tx.syncIssue.create({
        data: {
          type: SyncIssueType.ROLE_DELETED,
          severity: IssueSeverity.ERROR,
          approvedGuildId: guild.id,
          discordGuildId,
          discordRoleId,
          message:
            `The managed role "${managed.name}" was deleted in Discord. Update the role definition ` +
            'or recreate the role, otherwise every synchronization touching it will fail.',
        },
      });
    }

    await recordAudit(tx, {
      ctx,
      action: AuditAction.MAPPING_DISABLED,
      approvedGuildId: guild.id,
      reason: 'Discord role deleted',
      newState: {
        discordRoleId,
        roleName: roleName ?? null,
        disabledMappings: mappings.length,
        brokenManagedRoles: managedRoles.length,
      },
      success: false,
    });
  });

  await notifyGlobalAdmins({
    title: 'A synchronized Discord role was deleted',
    description:
      `Role \`${roleName ?? discordRoleId}\` in **${guild.name}** was deleted. ` +
      `${mappings.length} mapping(s) were disabled and ${managedRoles.length} managed role definition(s) are now broken.`,
    severity: 'critical',
  });

  return { affected: managedRoles.length + mappings.length, disabledMappings: mappings.length };
}

/**
 * Unbinds roster ranks whose Discord role has been deleted.
 *
 * Members keep their place on the roster, unranked, rather than being removed: a deleted
 * role is usually a restructure or a mistake, and quietly taking 30 people off a public
 * roster - and renaming all of them - is not a reasonable answer to either.
 */
async function unbindDeletedRanks({ prisma, guild, discordRoleId, roleName, rosterRanks }) {
  const ctx = systemContext({ label: 'discord-event' });
  const affected = await prisma.rosterMembership.count({
    where: { rankId: { in: rosterRanks.map((rank) => rank.id) } },
  });

  await prisma.$transaction(async (tx) => {
    await tx.rosterMembership.updateMany({
      where: { rankId: { in: rosterRanks.map((rank) => rank.id) } },
      data: { rankId: null },
    });
    await tx.rosterRank.updateMany({
      where: { id: { in: rosterRanks.map((rank) => rank.id) } },
      data: { deletedAt: new Date() },
    });

    for (const rank of rosterRanks) {
      await tx.syncIssue.create({
        data: {
          type: SyncIssueType.ROLE_DELETED,
          severity: IssueSeverity.ERROR,
          approvedGuildId: guild.id,
          discordGuildId: guild.discordGuildId,
          discordRoleId,
          message:
            `The role "${roleName ?? discordRoleId}" conferred the rank "${rank.name}" on ` +
            `roster "${rank.roster.slug}" and was deleted in Discord. The rank has been ` +
            'unbound; anybody holding it stays on the roster without a rank. Bind a ' +
            'replacement role with /roster rank.',
          details: { roster: rank.roster.slug, rank: rank.name, affectedMembers: affected },
        },
      });
    }

    await recordAudit(tx, {
      ctx,
      action: AuditAction.ROSTER_RANK_UNBOUND,
      approvedGuildId: guild.id,
      reason: 'Discord role deleted',
      previousState: {
        discordRoleId,
        roleName: roleName ?? null,
        ranks: rosterRanks.map((rank) => `${rank.roster.slug}:${rank.name}`),
        affectedMembers: affected,
      },
      success: false,
    });
  });

  await notifyGlobalAdmins({
    title: 'A roster rank role was deleted',
    description:
      `Role \`${roleName ?? discordRoleId}\` in **${guild.name}** conferred ` +
      `${rosterRanks.length} roster rank(s), affecting ${affected} member(s). The rank(s) ` +
      'have been unbound and those members are now unranked on their roster.',
    severity: 'critical',
  }).catch(() => {});

  log.warn(
    { discordRoleId, ranks: rosterRanks.length, affected },
    'roster ranks unbound after role deletion',
  );
}

/**
 * A role was renamed or moved. Names are kept in step so audit records and embeds stay
 * readable, and a role that has been moved above the bot is reported before it silently
 * starts failing.
 */
export async function handleRoleUpdated({
  discordGuildId,
  discordRoleId,
  roleName,
  position,
  botHighestPosition,
  managed,
  prisma = getPrisma(),
}) {
  const guild = await findApprovedGuildBySnowflake(discordGuildId, prisma);
  if (!guild) return { updated: false };

  const managedRole = await prisma.managedRole.findFirst({
    where: { approvedGuildId: guild.id, discordRoleId, ...notDeleted },
  });
  if (!managedRole) return { updated: false };

  if (roleName && roleName !== managedRole.name) {
    await prisma.managedRole.update({ where: { id: managedRole.id }, data: { name: roleName } });
  }

  const problems = [];
  if (
    typeof position === 'number' &&
    typeof botHighestPosition === 'number' &&
    position >= botHighestPosition
  ) {
    problems.push({
      type: SyncIssueType.ROLE_ABOVE_BOT,
      message: `"${roleName ?? managedRole.name}" was moved above the bot's highest role and can no longer be applied.`,
    });
  }
  if (managed) {
    problems.push({
      type: SyncIssueType.INTEGRATION_MANAGED_ROLE,
      message: `"${roleName ?? managedRole.name}" is now managed by another integration and cannot be applied.`,
    });
  }

  for (const problem of problems) {
    await prisma.syncIssue.create({
      data: {
        type: problem.type,
        severity: IssueSeverity.ERROR,
        approvedGuildId: guild.id,
        discordGuildId,
        discordRoleId,
        message: problem.message,
      },
    });
  }

  return { updated: true, problems: problems.length };
}
