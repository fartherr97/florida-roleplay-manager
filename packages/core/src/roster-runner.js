/**
 * Roster reconciliation.
 *
 * Runs in the worker, because it writes to Discord and nothing else in the platform may.
 *
 * The shape mirrors the role reconciliation engine: read the live state, compute the
 * whole correct answer, then apply the difference. That is what makes it safe to run
 * repeatedly - a second run over an already-correct roster performs no writes at all,
 * which is what lets the scheduled sweep exist without anybody worrying about it.
 *
 * Order matters in one place. The database row is updated *before* the nickname is
 * written, so a failed rename leaves an accurate roster and a recorded issue rather than
 * a member who is missing from the website because Discord rate-limited us.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger, serializeError } from '@frm/logging';
import {
  ActionSource,
  AuditAction,
  IssueSeverity,
  RosterMembershipStatus,
  SyncIssueType,
  SyncJobStatus,
  getEnv,
} from '@frm/shared';
import { checkNicknameOperation } from '@frm/discord';
import { discardNicknameMarker, withMemberLock, writeNicknameMarker } from '@frm/queue';
import { recordAudit } from './audit-service.js';
import { systemContext } from './context.js';
import { mirrorNameToNonRosterGuilds } from './event-service.js';
import { notifyGlobalAdmins } from './notify.js';
import { makeCallsignAllocator, planMemberChange, planRosterChanges, resolveRank } from './roster-resolve.js';
import { queueRosterSync } from './roster-service.js';

const log = createLogger('core.roster-runner');

/** The audit action that describes each kind of change. */
const AUDIT_FOR_CHANGE = Object.freeze({
  ADD: AuditAction.ROSTER_MEMBER_ADDED,
  PROMOTE: AuditAction.ROSTER_MEMBER_RANK_CHANGED,
  REMOVE: AuditAction.ROSTER_MEMBER_REMOVED,
  NICKNAME: AuditAction.ROSTER_NICKNAME_SET,
});

/**
 * Runs one roster job to completion.
 *
 * @param {object} params
 * @param {string} params.jobId the SyncJob row driving this run
 * @param {object} params.gateway
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 * @returns {Promise<{status: string, applied: number, failed: number, changes: number}>}
 */
export async function runRosterJob({ jobId, gateway, prisma = getPrisma() }) {
  const job = await prisma.syncJob.findUnique({ where: { id: jobId } });
  if (!job) {
    log.warn({ jobId }, 'roster job vanished before it ran');
    return { status: SyncJobStatus.FAILED, applied: 0, failed: 0, changes: 0 };
  }

  await prisma.syncJob.update({
    where: { id: job.id },
    data: { status: SyncJobStatus.RUNNING, startedAt: new Date() },
  });

  try {
    const result = await reconcile({ job, gateway, prisma });

    // A paused job has already recorded its own terminal state and must not be
    // overwritten here, or the threshold guard would report success.
    if (result.paused) {
      return { status: SyncJobStatus.PAUSED, ...result };
    }

    const status =
      result.failed > 0 && result.applied > 0
        ? SyncJobStatus.PARTIAL
        : result.failed > 0
          ? SyncJobStatus.FAILED
          : SyncJobStatus.COMPLETED;

    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status,
        completedAt: new Date(),
        progressTotal: result.changes,
        progressCompleted: result.applied,
      },
    });

    return { status, ...result };
  } catch (error) {
    log.error({ err: serializeError(error), jobId }, 'roster job failed');
    await prisma.syncJob.update({
      where: { id: job.id },
      data: {
        status: SyncJobStatus.FAILED,
        completedAt: new Date(),
        error: { message: error?.message ?? String(error), code: error?.code ?? null },
      },
    });
    throw error;
  }
}

/** Plans and applies the changes for the roster named in the job payload. */
async function reconcile({ job, gateway, prisma }) {
  const payload = job.payload ?? {};
  const roster = await prisma.roster.findFirst({
    where: { id: payload.rosterId, ...notDeleted },
    include: { guild: true, ranks: { where: notDeleted } },
  });

  if (!roster) {
    log.info({ jobId: job.id, rosterId: payload.rosterId }, 'roster deleted; nothing to do');
    return { applied: 0, failed: 0, changes: 0 };
  }
  if (!roster.guild?.enabled || !roster.guild?.syncEnabled) {
    log.info({ jobId: job.id, slug: roster.slug }, 'guild disabled; skipping roster');
    return { applied: 0, failed: 0, changes: 0 };
  }
  if (roster.ranks.length === 0) {
    // A roster with no bound roles has no opinion about anybody. Reconciling it would
    // read as "nobody holds a rank" and empty the roster, which is not what an
    // half-configured roster means.
    log.info({ jobId: job.id, slug: roster.slug }, 'roster has no ranks bound; skipping');
    return { applied: 0, failed: 0, changes: 0 };
  }

  const discordGuildId = roster.guild.discordGuildId;
  const single = payload.discordUserId ?? null;

  // Keep each rank's stored colour in step with its Discord role, so the website can
  // band the roster in the same colours staff see in Discord. Cheap: one role listing,
  // and a write only for the ranks whose colour actually changed.
  const guildRoles = await syncRankColors({ roster, discordGuildId, gateway, prisma });

  // A rank bound to a role id that does not exist in this server can never match
  // anybody, and the sync would otherwise report a silent "0 changes" forever. Flag it
  // where the dashboard shows it. Best-effort - a flagging failure never stops the sync.
  await flagUnboundRanks({ job, roster, discordGuildId, guildRoles, prisma }).catch((error) => {
    log.warn({ err: serializeError(error), slug: roster.slug }, 'could not flag unbound ranks');
  });

  const changes = single
    ? await planOne({ roster, discordGuildId, discordUserId: single, gateway, prisma })
    : await planAll({ job, roster, discordGuildId, gateway, prisma });

  if (changes.length === 0) return { applied: 0, failed: 0, changes: 0 };

  // A plan that takes half the staff team off the roster is far more likely to be a
  // misconfiguration - a deleted rank role, a rank unbound by mistake - than a real mass
  // resignation. Stop and let a human look, exactly as the role engine does.
  const removals = changes.filter((change) => change.type === 'REMOVE').length;
  const threshold = await removalThreshold(prisma);
  if (removals > threshold) {
    await pauseForThreshold({ job, roster, prisma, removals, threshold, changes });
    return { applied: 0, failed: 0, changes: changes.length, paused: true };
  }

  // Which roster owns each member's nickname. Only relevant when a guild has more than
  // one nickname-writing roster, but then it matters a lot: without it two rosters would
  // alternately overwrite the same person on every sync.
  // Whether the member's rank ON THIS roster yields its nickname to another roster.
  const selfYield = new Map(
    changes.filter((c) => c.nickname).map((c) => [c.discordUserId, Boolean(c.rank?.yieldNickname)]),
  );
  const nicknameOwners = await resolveNicknameOwners({
    prisma,
    roster,
    discordUserIds: [...selfYield.keys()],
    selfYield,
  });

  let applied = 0;
  let failed = 0;
  const renamed = [];

  for (const planned of changes) {
    // Their nickname may belong to a higher-priority roster. This one still owns their
    // membership row, so the change is applied - without the rename.
    const change =
      planned.nickname && nicknameOwners.get(planned.discordUserId) !== roster.id
        ? { ...planned, nickname: null }
        : planned;

    // The same lock the role engine uses, so a roster sync and a role sync can never
    // interleave their writes for one person.
    const outcome = await withMemberLock(change.discordUserId, () =>
      applyChange({ job, roster, discordGuildId, change, gateway, prisma }),
    );

    if (outcome.skipped) {
      log.debug({ member: change.discordUserId }, 'member locked elsewhere; skipping');
      continue;
    }
    if (outcome.result === 'applied') {
      applied += 1;
      if (change.nickname) renamed.push(change.discordUserId);
    }
    if (outcome.result === 'failed') failed += 1;
  }

  // A member whose managed nickname just changed here is often the name authority for
  // their identity in guilds that carry no roster for them - a deputy's plain presence in
  // the main community. Mirror the freshly-formatted nickname outward now that it is
  // final, so those guilds show the exact same string. This runs after the rename, never
  // before, which is what a hand edit in the authority guild needs to reach the main
  // guild. Loop-safe: the mirror never queues another roster sync.
  for (const discordUserId of renamed) {
    await mirrorNameToNonRosterGuilds({ prisma, gateway, discordUserId }).catch((error) => {
      log.warn({ err: serializeError(error), discordUserId }, 'name mirror after roster write failed');
    });
  }

  return { applied, failed, changes: changes.length };
}

/**
 * Decides which roster owns each member's nickname.
 *
 * A member can sit on more than one roster in the same guild - the staff team and their
 * department, say - and a nickname has room for exactly one rank. A rank marked
 * `yieldNickname` (an Auxiliary Staff rank keeping the member's department name) steps
 * aside; among the rest the roster with the lowest `position` wins, with the slug as a
 * stable tie-break, so the answer is the same whichever roster's job happens to run
 * first. A member every one of whose rosters yields still gets a nickname from the
 * lowest-position one, so nobody is left unformatted. Without any of this the two rosters
 * overwrite each other forever, each one's write looking to the other like drift.
 *
 * @param {Map<string, boolean>} [selfYield] whether the member's rank on the roster being
 *   reconciled yields; the competing rosters' yield comes from their own rows.
 * @returns {Promise<Map<string, string>>} discord user id -> owning roster id
 */
async function resolveNicknameOwners({ prisma, roster, discordUserIds, selfYield = new Map() }) {
  const owners = new Map();
  if (discordUserIds.length === 0) return owners;

  // Every other nickname-writing roster in this guild that these members are on, with the
  // member's rank on it (for its yield flag). The roster being reconciled is included
  // implicitly: they are on it by definition, and its yield comes from `selfYield`.
  const competing = await prisma.rosterMembership.findMany({
    where: {
      discordUserId: { in: discordUserIds },
      status: RosterMembershipStatus.ACTIVE,
      rosterId: { not: roster.id },
      roster: {
        ...notDeleted,
        approvedGuildId: roster.approvedGuildId,
        nicknameSyncEnabled: true,
      },
    },
    select: {
      discordUserId: true,
      rank: { select: { yieldNickname: true } },
      roster: { select: { id: true, slug: true, position: true } },
    },
  });

  const byMember = new Map(
    discordUserIds.map((id) => [id, [self(roster, selfYield.get(id) ?? false)]]),
  );
  for (const row of competing) {
    byMember
      .get(row.discordUserId)
      ?.push({ ...row.roster, yields: Boolean(row.rank?.yieldNickname) });
  }

  for (const [discordUserId, candidates] of byMember) {
    // A yielding rank sorts last, so a non-yielding roster owns the nickname; ties fall to
    // the lowest position, then the slug. Every candidate yielding still leaves an owner.
    candidates.sort(
      (a, b) =>
        Number(a.yields) - Number(b.yields) ||
        a.position - b.position ||
        a.slug.localeCompare(b.slug),
    );
    owners.set(discordUserId, candidates[0].id);
  }
  return owners;
}

const self = (roster, yields = false) => ({
  id: roster.id,
  slug: roster.slug,
  position: roster.position,
  yields,
});

/** The configured maximum-change threshold, falling back to the environment value. */
async function removalThreshold(prisma) {
  const setting = await prisma.systemSetting
    .findUnique({ where: { key: 'sync.maxRemovalsThreshold' } })
    .catch(() => null);
  const value = Number(setting?.value);
  return Number.isFinite(value) && value > 0 ? value : getEnv().SYNC_MAX_REMOVALS_THRESHOLD;
}

/**
 * Records what the job wanted to do and stops, rather than emptying a roster.
 *
 * Nothing is applied: no memberships change and no nicknames are rewritten. An
 * administrator can see the whole plan, decide whether it is right, and either fix the
 * configuration or re-run with a raised threshold.
 */
async function pauseForThreshold({ job, roster, prisma, removals, threshold, changes }) {
  await prisma.syncJob.update({
    where: { id: job.id },
    data: {
      status: SyncJobStatus.PAUSED,
      thresholdBreached: true,
      completedAt: new Date(),
      progressTotal: changes.length,
      error: {
        reason: 'THRESHOLD_EXCEEDED',
        removalCount: removals,
        threshold,
        roster: roster.slug,
      },
    },
  });

  await prisma.syncIssue.create({
    data: {
      type: SyncIssueType.THRESHOLD_EXCEEDED,
      severity: IssueSeverity.CRITICAL,
      approvedGuildId: roster.approvedGuildId,
      syncJobId: job.id,
      message:
        `Reconciling "${roster.name}" would have removed ${removals} members, above the ` +
        `threshold of ${threshold}. Nothing was changed. This usually means a rank role was ` +
        'deleted or unbound rather than that everybody left.',
      details: {
        roster: roster.slug,
        removals: changes
          .filter((change) => change.type === 'REMOVE')
          .map((change) => change.discordUserId),
      },
    },
  });

  await notifyGlobalAdmins({
    title: 'A roster reconciliation was paused',
    description:
      `Reconciling **${roster.name}** would have removed ${removals} members (threshold ` +
      `${threshold}). Nothing was changed. Check that a rank role has not been deleted.`,
    severity: 'critical',
  }).catch(() => {});

  log.warn({ jobId: job.id, slug: roster.slug, removals, threshold }, 'roster job paused');
}

/** Plans a single member: the hot path, driven by a role change event. */
async function planOne({ roster, discordGuildId, discordUserId, gateway, prisma }) {
  const [member, membership] = await Promise.all([
    gateway.getMember(discordGuildId, discordUserId).catch((error) => {
      log.warn({ err: serializeError(error), discordUserId }, 'could not read member');
      return null;
    }),
    prisma.rosterMembership.findUnique({
      where: { rosterId_discordUserId: { rosterId: roster.id, discordUserId } },
      include: { rank: true },
    }),
  ]);

  // Not on the roster and not in the guild: nothing to reconcile, and no row to create.
  if (!member && !membership) return [];

  // The callsigns already in use on this roster, so a number issued to this one member
  // does not collide with anybody else's. Their own row is excluded — reissuing them the
  // number they already hold is a no-op, not a collision.
  const others = await prisma.rosterMembership.findMany({
    where: {
      rosterId: roster.id,
      status: RosterMembershipStatus.ACTIVE,
      callsign: { not: null },
      NOT: { discordUserId },
    },
    select: { callsign: true, status: true },
  });

  const change = planMemberChange({
    roster,
    ranks: roster.ranks,
    membership,
    member,
    nicknameSync: roster.nicknameSyncEnabled,
    allocateCallsign: makeCallsignAllocator(others),
  });

  return change.actionable ? [change] : [];
}

/**
 * Refreshes each rank's stored colour from its bound Discord role.
 *
 * Runs at the top of every reconciliation so the website's roster bands stay in step
 * with Discord without anybody setting a colour by hand. Best-effort: if the role listing
 * fails, the roster still reconciles with whatever colours were last stored.
 */
async function syncRankColors({ roster, discordGuildId, gateway, prisma }) {
  const roles = await gateway.listRoles(discordGuildId).catch((error) => {
    log.debug({ err: serializeError(error), slug: roster.slug }, 'could not list roles for colours');
    return [];
  });
  if (roles.length === 0) return roles;

  const colorById = new Map(roles.map((role) => [role.id, role.color ?? null]));
  for (const rank of roster.ranks) {
    const next = colorById.get(rank.discordRoleId) ?? null;
    if ((rank.color ?? null) !== next) {
      await prisma.rosterRank
        .update({ where: { id: rank.id }, data: { color: next } })
        .catch((error) => log.debug({ err: serializeError(error) }, 'could not store rank colour'));
      rank.color = next;
    }
  }
  return roles;
}

/**
 * Raises a sync issue for every rank bound to a role id that does not exist in the
 * roster's server.
 *
 * Such a rank matches nobody, ever - the id was usually copied from a different server -
 * and without this flag the only symptom is a sync that completes with zero changes,
 * which reads as "working, roster just empty". Deduplicated: an unresolved issue for the
 * same role in the same guild is not raised twice, so the ten-minute sweep does not pile
 * up copies.
 */
async function flagUnboundRanks({ job, roster, discordGuildId, guildRoles, prisma }) {
  // An empty listing means the role fetch failed, not that the guild has no roles -
  // there is nothing trustworthy to validate against.
  if (!guildRoles || guildRoles.length === 0) return;

  const known = new Set(guildRoles.map((role) => role.id));
  for (const rank of roster.ranks) {
    if (known.has(rank.discordRoleId)) continue;

    const existing = await prisma.syncIssue.findFirst({
      where: {
        type: SyncIssueType.INVALID_ROLE_REFERENCE,
        resolved: false,
        discordRoleId: rank.discordRoleId,
        approvedGuildId: roster.approvedGuildId,
      },
      select: { id: true },
    });
    if (existing) continue;

    log.warn(
      { slug: roster.slug, rank: rank.name, roleId: rank.discordRoleId },
      'rank bound to a role that does not exist in this guild',
    );
    await recordIssue({
      prisma,
      job,
      roster,
      discordGuildId,
      discordUserId: null,
      userId: null,
      discordRoleId: rank.discordRoleId,
      type: SyncIssueType.INVALID_ROLE_REFERENCE,
      severity: IssueSeverity.ERROR,
      message:
        `Rank "${rank.name}" on roster "${roster.slug}" is bound to role ${rank.discordRoleId}, ` +
        'but no role with that id exists in this server, so nobody can ever hold it. The id was ' +
        'probably copied from a different server - re-bind the rank to a role that lives in this one.',
      retryable: false,
    });
  }
}

/** Plans the whole roster: the scheduled sweep and `/roster sync`. */
async function planAll({ job, roster, discordGuildId, gateway, prisma }) {
  const [members, memberships] = await Promise.all([
    gateway.listMembers(discordGuildId),
    prisma.rosterMembership.findMany({ where: { rosterId: roster.id }, include: { rank: true } }),
  ]);

  // A guild always contains at least the bot itself, so an empty member list is a failed
  // fetch (Server Members Intent missing, or the gateway chunk timing out) - never a real
  // state. Reconciling against it would read as the entire roster resigning at once, so
  // the roster is left untouched and the failure is recorded where the dashboard shows it.
  if (members.length === 0) {
    log.warn({ slug: roster.slug, discordGuildId }, 'member list came back empty; roster left untouched');
    await recordIssue({
      prisma,
      job,
      roster,
      discordGuildId,
      discordUserId: null,
      userId: null,
      type: SyncIssueType.GUILD_UNAVAILABLE,
      severity: IssueSeverity.ERROR,
      message:
        `The member list for this server came back empty, so "${roster.name}" was not reconciled. ` +
        'Check that the bot is in the server and has the Server Members Intent enabled; the next sync will retry.',
      retryable: true,
    });
    return [];
  }

  log.info(
    {
      slug: roster.slug,
      scanned: members.length,
      matching: members.filter((member) => resolveRank(roster.ranks, member.roleIds ?? [])).length,
    },
    'planning roster from full member list',
  );

  return planRosterChanges({ roster, ranks: roster.ranks, memberships, members });
}

/**
 * Applies one planned change: the database row first, then the nickname.
 *
 * @returns {Promise<'applied'|'failed'|'skipped'>}
 */
async function applyChange({ job, roster, discordGuildId, change, gateway, prisma }) {
  const ctx = {
    ...systemContext({ label: 'roster-sync' }),
    source: job.source ?? ActionSource.SYSTEM,
    requestId: job.requestId ?? undefined,
  };

  if (job.dryRun) {
    log.info(
      { slug: roster.slug, member: change.discordUserId, type: change.type },
      'dry run: change not applied',
    );
    return 'skipped';
  }

  const membership = await persistChange({ roster, change, prisma });

  await recordAudit(prisma, {
    ctx,
    action: AUDIT_FOR_CHANGE[change.type] ?? AuditAction.ROSTER_MEMBER_UPDATED,
    approvedGuildId: roster.approvedGuildId,
    targetUserId: membership?.userId ?? null,
    targetDiscordId: change.discordUserId,
    syncJobId: job.id,
    reason: change.reason,
    previousState: change.previousRank ? { rank: change.previousRank.name } : null,
    newState: {
      roster: roster.slug,
      rank: change.rank?.name ?? null,
      nickname: change.nickname ?? null,
    },
  });

  if (!change.nickname) return 'applied';

  const written = await writeNickname({
    job,
    roster,
    discordGuildId,
    change,
    membership,
    gateway,
    prisma,
  });

  return written ? 'applied' : 'failed';
}

/** Writes the membership row for a planned change. */
async function persistChange({ roster, change, prisma }) {
  const key = {
    rosterId_discordUserId: { rosterId: roster.id, discordUserId: change.discordUserId },
  };

  if (change.type === 'REMOVE') {
    // Kept, not deleted: the row is the record of who held what and when.
    return prisma.rosterMembership.update({
      where: key,
      data: {
        status: RosterMembershipStatus.DEPARTED,
        rankId: null,
        departedAt: new Date(),
        managedNickname: null,
      },
    });
  }

  // An identity link is looked up rather than required: somebody is on the roster
  // because of their Discord roles, whether or not they have ever used the website.
  const identity = await prisma.discordIdentity.findUnique({
    where: { discordUserId: change.discordUserId },
    select: { userId: true },
  });

  return prisma.rosterMembership.upsert({
    where: key,
    create: {
      rosterId: roster.id,
      discordUserId: change.discordUserId,
      userId: identity?.userId ?? null,
      rankId: change.rank?.id ?? null,
      displayName: change.name || null,
      callsign: change.callsign ?? null,
      status: RosterMembershipStatus.ACTIVE,
    },
    update: {
      rankId: change.rank?.id ?? null,
      userId: identity?.userId ?? null,
      status: RosterMembershipStatus.ACTIVE,
      departedAt: null,
      // The resolved name is refreshed; `preferredName` is never written here, because
      // an administrator's override is not the reconciler's to overwrite.
      ...(change.name ? { displayName: change.name } : {}),
      // Only when the planner actually issued a new callsign — a manually set one it chose
      // to keep must not be rewritten.
      ...(change.callsignChanged ? { callsign: change.callsign ?? null } : {}),
    },
  });
}

/**
 * Rewrites a member's nickname.
 *
 * @returns {Promise<boolean>} whether the write succeeded
 */
async function writeNickname({ job, roster, discordGuildId, change, membership, gateway, prisma }) {
  const preflight = await checkNicknameOperation(gateway, {
    discordGuildId,
    discordUserId: change.discordUserId,
  });

  if (!preflight.ok) {
    await recordIssue({
      prisma,
      job,
      roster,
      discordGuildId,
      discordUserId: change.discordUserId,
      userId: membership?.userId ?? null,
      type: preflight.issueType,
      severity: preflight.severity ?? IssueSeverity.ERROR,
      message: preflight.message,
      retryable: Boolean(preflight.retryable),
    });
    // The roster itself is correct - only the rename failed - so this is reported and
    // the member stays where they belong.
    return false;
  }

  const markerParts = {
    discordGuildId,
    discordUserId: change.discordUserId,
    nickname: change.nickname,
    syncJobId: job.id,
  };

  // Mark first: Discord can deliver the resulting `guildMemberUpdate` before the HTTP
  // call returns, and an unmarked event would look like somebody editing their own
  // nickname - which the handler answers by rewriting it again.
  await writeNicknameMarker(markerParts).catch((error) => {
    log.warn({ err: serializeError(error) }, 'could not write nickname marker; continuing');
  });

  try {
    await gateway.setNickname(
      discordGuildId,
      change.discordUserId,
      change.nickname,
      `FRM roster: ${change.reason}`.slice(0, 400),
    );

    if (membership) {
      await prisma.rosterMembership.update({
        where: { id: membership.id },
        data: { managedNickname: change.nickname },
      });
    }
    return true;
  } catch (error) {
    // The rename never happened, so the marker has to go: leaving it would swallow the
    // next genuine nickname event for this member.
    await discardNicknameMarker(markerParts).catch(() => {});

    await recordIssue({
      prisma,
      job,
      roster,
      discordGuildId,
      discordUserId: change.discordUserId,
      userId: membership?.userId ?? null,
      type: error?.issueType ?? SyncIssueType.DISCORD_ERROR,
      severity: error?.retryable ? IssueSeverity.WARNING : IssueSeverity.ERROR,
      message: error?.userMessage ?? error?.message ?? 'Discord rejected the nickname change',
      retryable: Boolean(error?.retryable),
    });

    log.warn(
      { err: serializeError(error), member: change.discordUserId, slug: roster.slug },
      'nickname write failed',
    );
    return false;
  }
}

function recordIssue({
  prisma,
  job,
  roster,
  discordGuildId,
  discordUserId,
  userId,
  discordRoleId = null,
  type,
  severity,
  message,
  retryable,
}) {
  return prisma.syncIssue
    .create({
      data: {
        type: type ?? SyncIssueType.UNKNOWN,
        severity,
        approvedGuildId: roster.approvedGuildId,
        discordGuildId,
        discordUserId,
        userId,
        discordRoleId,
        syncJobId: job.id,
        message,
        details: { retryable: Boolean(retryable), roster: roster.slug },
      },
    })
    .catch((error) => {
      log.error({ err: serializeError(error) }, 'could not record roster issue');
    });
}

/**
 * The scheduled sweep: reconciles every published roster.
 *
 * Drift is inevitable - roles change while the bot is restarting, an event is missed, a
 * rename fails and is retried later - so the roster is recomputed from scratch on a
 * timer. Because reconciliation is idempotent this is almost always a no-op.
 *
 * Only queues: each roster is reconciled by its own job on the roster queue, so the
 * sweep never holds the maintenance worker open while it talks to Discord.
 *
 * @param {object} params
 * @param {import('@prisma/client').PrismaClient} [params.prisma]
 */
export async function runScheduledRosterSweep({ prisma = getPrisma() } = {}) {
  const rosters = await prisma.roster.findMany({
    where: { ...notDeleted, guild: { enabled: true, syncEnabled: true, ...notDeleted } },
    select: { id: true, slug: true, approvedGuildId: true },
  });

  const ctx = systemContext({ label: 'roster-sweep' });
  const results = [];

  for (const roster of rosters) {
    // Each roster gets its own job so a failure on one is visible on its own terms and
    // does not abandon the rest of the sweep.
    const job = await queueRosterSync(ctx, {
      roster,
      reason: 'Scheduled roster reconciliation',
      prisma,
    }).catch((error) => {
      log.error({ err: serializeError(error), slug: roster.slug }, 'could not queue roster sweep');
      return null;
    });
    if (job) results.push({ slug: roster.slug, jobId: job.id });
  }

  log.info({ rosters: results.length }, 'scheduled roster sweep queued');
  return { queued: results.length, rosters: results };
}
