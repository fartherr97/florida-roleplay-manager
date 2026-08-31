/**
 * Roster configuration and queries.
 *
 * A roster is a published list of who holds which rank, kept in agreement with Discord.
 * This file owns the configuration side of that - creating rosters, binding a Discord
 * role to a rank, recording somebody's callsign - plus the read models the website and
 * the `/roster` command both render.
 *
 * Applying changes to Discord is deliberately not here: that belongs to the worker, and
 * lives in `roster-runner.js`. The split is the same one the rest of the platform uses.
 * Nothing in this file writes to Discord.
 */
import { getPrisma, notDeleted } from '@frm/database';
import { createLogger } from '@frm/logging';
import {
  AuditAction,
  ConflictError,
  NotFoundError,
  RosterMembershipStatus,
  SyncJobType,
  ValidationError,
} from '@frm/shared';
import { authorize } from '@frm/authorization';
import {
  bindRosterRankSchema,
  createRosterSchema,
  deleteRosterSchema,
  listRostersSchema,
  parseOrThrow,
  rosterMemberDetailsSchema,
  syncRosterSchema,
  unbindRosterRankSchema,
  updateRosterSchema,
} from '@frm/validation';
import { recordAudit } from './audit-service.js';
import { presentRoster } from './roster-resolve.js';
import { createSyncJob, enqueueSyncJob } from './sync-service.js';
import { findApprovedGuildBySnowflake } from './resolve.js';

const log = createLogger('core.roster');

/** Ranks and active memberships, which is what every read model needs. */
const ROSTER_INCLUDE = {
  ranks: { where: notDeleted, orderBy: { position: 'desc' } },
  memberships: {
    where: { status: RosterMembershipStatus.ACTIVE },
    include: { rank: true },
  },
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Creates a roster against a guild that is already on the allowlist.
 *
 * @param {object} ctx
 * @param {object} input
 */
export async function createRoster(ctx, input) {
  const data = parseOrThrow(createRosterSchema, input);
  const prisma = ctx.prisma ?? getPrisma();

  const guild = await findApprovedGuildBySnowflake(data.discordGuildId, prisma);
  if (!guild || !guild.enabled) {
    throw new NotFoundError('That Discord server is not on the approved allowlist.', {
      discordGuildId: data.discordGuildId,
    });
  }

  authorize(ctx.actor, { capability: 'roster.manage', scope: { guildId: guild.id } });

  const existing = await prisma.roster.findUnique({ where: { slug: data.slug } });
  if (existing && !existing.deletedAt) {
    throw new ConflictError(`A roster with the slug "${data.slug}" already exists.`, {
      slug: data.slug,
    });
  }

  const roster = existing
    ? // Reviving a deleted slug keeps the website's URL working rather than orphaning it.
      await prisma.roster.update({
        where: { id: existing.id },
        data: {
          name: data.name,
          description: data.description ?? null,
          approvedGuildId: guild.id,
          published: data.published ?? true,
          position: data.position ?? 0,
          nicknameSyncEnabled: data.nicknameSyncEnabled ?? true,
          deletedAt: null,
          createdById: ctx.actor?.user?.id ?? null,
        },
      })
    : await prisma.roster.create({
        data: {
          slug: data.slug,
          name: data.name,
          description: data.description ?? null,
          approvedGuildId: guild.id,
          published: data.published ?? true,
          position: data.position ?? 0,
          nicknameSyncEnabled: data.nicknameSyncEnabled ?? true,
          createdById: ctx.actor?.user?.id ?? null,
        },
      });

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ROSTER_CREATED,
    approvedGuildId: guild.id,
    reason: data.reason,
    newState: { slug: roster.slug, name: roster.name, guild: guild.name },
  });

  log.info({ slug: roster.slug, guild: guild.name }, 'roster created');
  return roster;
}

/** Edits a roster's presentation settings. Its guild is fixed at creation. */
export async function updateRoster(ctx, input) {
  const data = parseOrThrow(updateRosterSchema, input);
  const prisma = ctx.prisma ?? getPrisma();
  const roster = await requireRoster(prisma, data.slug);

  authorize(ctx.actor, { capability: 'roster.manage', scope: { guildId: roster.approvedGuildId } });

  const patch = {};
  for (const field of ['name', 'published', 'position', 'nicknameSyncEnabled']) {
    if (data[field] !== undefined) patch[field] = data[field];
  }
  if (data.description !== undefined) patch.description = data.description ?? null;

  if (Object.keys(patch).length === 0) {
    throw new ValidationError('Nothing to change: give at least one setting to update.');
  }

  const updated = await prisma.roster.update({ where: { id: roster.id }, data: patch });

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ROSTER_UPDATED,
    approvedGuildId: roster.approvedGuildId,
    reason: data.reason,
    previousState: pickRosterState(roster),
    newState: pickRosterState(updated),
  });

  return updated;
}

/**
 * Retires a roster.
 *
 * Soft-deleted, and the memberships are left exactly as they are: the roster stops being
 * published and stops being reconciled, but who was on it remains answerable. Nobody's
 * nickname is touched - undoing a mistaken delete should not have rewritten 40 names.
 */
export async function deleteRoster(ctx, input) {
  const data = parseOrThrow(deleteRosterSchema, input);
  const prisma = ctx.prisma ?? getPrisma();
  const roster = await requireRoster(prisma, data.slug);

  authorize(ctx.actor, { capability: 'roster.manage', scope: { guildId: roster.approvedGuildId } });

  await prisma.roster.update({
    where: { id: roster.id },
    data: { deletedAt: new Date(), published: false },
  });

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ROSTER_DELETED,
    approvedGuildId: roster.approvedGuildId,
    reason: data.reason,
    previousState: pickRosterState(roster),
  });

  return { deleted: true, slug: roster.slug };
}

/**
 * Binds a Discord role to a rank, or re-binds an existing one.
 *
 * This is the whole configuration surface that matters: after this call, holding the
 * role is being the rank.
 */
export async function bindRosterRank(ctx, input) {
  const data = parseOrThrow(bindRosterRankSchema, input);
  const prisma = ctx.prisma ?? getPrisma();
  const roster = await requireRoster(prisma, data.slug);

  authorize(ctx.actor, { capability: 'roster.manage', scope: { guildId: roster.approvedGuildId } });

  // Two ranks on one roster sharing a role would make `resolveRank` depend on tie-break
  // rules nobody intended, so the pair is unique and a re-bind updates in place.
  const existing = await prisma.rosterRank.findUnique({
    where: { rosterId_discordRoleId: { rosterId: roster.id, discordRoleId: data.discordRoleId } },
  });

  // Only touch the callsign block when the caller sent it: the `/roster bind` command
  // does not know about ranges, so re-binding a rank from Discord must not wipe a range
  // an administrator configured on the dashboard.
  const rangePatch =
    data.callsignRangeStart === undefined && data.callsignRangeEnd === undefined
      ? {}
      : {
          callsignRangeStart: data.callsignRangeStart ?? null,
          callsignRangeEnd: data.callsignRangeEnd ?? null,
        };

  // Same rule as the callsign block: only touch the nickname priority when the caller
  // sent it, so re-binding a rank from Discord does not reset one set on the dashboard.
  const priorityPatch =
    data.nicknamePriority === undefined ? {} : { nicknamePriority: data.nicknamePriority };

  // Same rule again: only touch the gate role when the caller sent it, so re-binding from
  // the `/roster bind` command (which knows nothing about gates) does not clear one set
  // on the dashboard. Explicit null clears it.
  const gatePatch =
    data.requiresRoleId === undefined ? {} : { requiresRoleId: data.requiresRoleId ?? null };

  const rank = existing
    ? await prisma.rosterRank.update({
        where: { id: existing.id },
        data: {
          name: data.name,
          shortName: data.shortName ?? null,
          position: data.position,
          deletedAt: null,
          ...rangePatch,
          ...priorityPatch,
          ...gatePatch,
        },
      })
    : await prisma.rosterRank.create({
        data: {
          rosterId: roster.id,
          discordRoleId: data.discordRoleId,
          name: data.name,
          shortName: data.shortName ?? null,
          position: data.position,
          ...rangePatch,
          ...priorityPatch,
          ...gatePatch,
        },
      });

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ROSTER_RANK_BOUND,
    approvedGuildId: roster.approvedGuildId,
    reason: data.reason,
    previousState: existing ? { name: existing.name, position: existing.position } : null,
    newState: {
      roster: roster.slug,
      rank: rank.name,
      discordRoleId: rank.discordRoleId,
      position: rank.position,
    },
  });

  log.info({ slug: roster.slug, rank: rank.name }, 'roster rank bound');
  return rank;
}

/**
 * Unbinds a rank.
 *
 * The members who held it are left on the roster, unranked, rather than being silently
 * removed: unbinding is usually a step in restructuring, and quietly dropping people
 * mid-edit is exactly the surprise this platform is meant not to produce. The next sync
 * puts everyone where the remaining bindings say they belong.
 */
export async function unbindRosterRank(ctx, input) {
  const data = parseOrThrow(unbindRosterRankSchema, input);
  const prisma = ctx.prisma ?? getPrisma();
  const roster = await requireRoster(prisma, data.slug);

  authorize(ctx.actor, { capability: 'roster.manage', scope: { guildId: roster.approvedGuildId } });

  const rank = await prisma.rosterRank.findUnique({
    where: { rosterId_discordRoleId: { rosterId: roster.id, discordRoleId: data.discordRoleId } },
  });
  if (!rank || rank.deletedAt) return { removed: false };

  await prisma.$transaction(async (tx) => {
    await tx.rosterMembership.updateMany({ where: { rankId: rank.id }, data: { rankId: null } });
    await tx.rosterRank.update({ where: { id: rank.id }, data: { deletedAt: new Date() } });

    await recordAudit(tx, {
      ctx,
      action: AuditAction.ROSTER_RANK_UNBOUND,
      approvedGuildId: roster.approvedGuildId,
      reason: data.reason,
      previousState: { roster: roster.slug, rank: rank.name, discordRoleId: rank.discordRoleId },
    });
  });

  return { removed: true, rank: rank.name };
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/**
 * Sets a member's callsign and/or the name they are shown under.
 *
 * Both are the parts of a nickname the platform cannot derive: a callsign is issued by a
 * human, and a preferred name is whatever somebody wants to be called. Changing either
 * queues the rewrite rather than performing it, because writing to Discord is the
 * worker's job.
 */
export async function setRosterMemberDetails(ctx, input) {
  const data = parseOrThrow(rosterMemberDetailsSchema, input);
  const prisma = ctx.prisma ?? getPrisma();
  const roster = await requireRoster(prisma, data.slug);

  authorize(ctx.actor, { capability: 'roster.member', scope: { guildId: roster.approvedGuildId } });

  if (data.callsign === undefined && data.preferredName === undefined) {
    throw new ValidationError('Give a callsign or a name to set.');
  }

  const membership = await prisma.rosterMembership.findUnique({
    where: {
      rosterId_discordUserId: { rosterId: roster.id, discordUserId: data.discordUserId },
    },
  });
  if (!membership) {
    throw new NotFoundError(
      'That member is not on this roster. They join it by holding one of its roles in Discord.',
      { slug: roster.slug, discordUserId: data.discordUserId },
    );
  }

  // A callsign identifies somebody on the roster and over the radio, so two people
  // wearing the same one is a data-entry mistake worth refusing rather than publishing.
  if (data.callsign) {
    const taken = await prisma.rosterMembership.findFirst({
      where: {
        rosterId: roster.id,
        callsign: data.callsign,
        status: RosterMembershipStatus.ACTIVE,
        NOT: { id: membership.id },
      },
      select: { discordUserId: true },
    });
    if (taken) {
      throw new ConflictError(
        `Callsign ${data.callsign} is already held by <@${taken.discordUserId}> on this roster.`,
        { slug: roster.slug, callsign: data.callsign, heldBy: taken.discordUserId },
      );
    }
  }

  const patch = {};
  if (data.callsign !== undefined) patch.callsign = data.callsign ?? null;
  if (data.preferredName !== undefined) patch.preferredName = data.preferredName ?? null;

  const updated = await prisma.rosterMembership.update({
    where: { id: membership.id },
    data: patch,
  });

  await recordAudit(prisma, {
    ctx,
    action: AuditAction.ROSTER_MEMBER_UPDATED,
    approvedGuildId: roster.approvedGuildId,
    targetUserId: membership.userId,
    targetDiscordId: membership.discordUserId,
    reason: data.reason,
    previousState: { callsign: membership.callsign, preferredName: membership.preferredName },
    newState: { callsign: updated.callsign, preferredName: updated.preferredName },
  });

  const job = await queueRosterSync(ctx, {
    roster,
    discordUserId: data.discordUserId,
    reason: 'Roster member details changed',
    prisma,
  });

  return { membership: updated, jobId: job?.id ?? null };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Every roster an operator may see, with ranks and members loaded. */
export async function listRosters(ctx, input = {}) {
  const query = parseOrThrow(listRostersSchema, input);
  authorize(ctx.actor, { capability: 'roster.view', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();

  const guild = query.discordGuildId
    ? await findApprovedGuildBySnowflake(query.discordGuildId, prisma)
    : null;

  const rosters = await prisma.roster.findMany({
    where: {
      ...notDeleted,
      ...(guild ? { approvedGuildId: guild.id } : {}),
      ...(query.includeUnpublished ? {} : { published: true }),
    },
    include: ROSTER_INCLUDE,
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
  });

  return rosters.map(presentRoster);
}

/** One roster, by slug. */
export async function getRoster(ctx, slug) {
  authorize(ctx.actor, { capability: 'roster.view', scope: {} });
  const prisma = ctx.prisma ?? getPrisma();
  const roster = await requireRoster(prisma, slug, ROSTER_INCLUDE);
  // The platform guild id is added only on this authenticated management read (never the
  // public one) so the dashboard can offer that server's roles when binding a rank.
  return { ...presentRoster(roster), approvedGuildId: roster.approvedGuildId };
}

/**
 * The read model the website consumes.
 *
 * Unauthenticated on purpose - a public roster page is public - so it serves only
 * published rosters and only fields that already appear on that page. No platform user
 * ids, no audit trail, nothing about who is linked to what.
 */
export async function getPublicRosters({ slug = null, prisma = getPrisma() } = {}) {
  const rosters = await prisma.roster.findMany({
    where: { ...notDeleted, published: true, ...(slug ? { slug } : {}) },
    include: ROSTER_INCLUDE,
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
  });

  return rosters.map(presentRoster);
}

/**
 * Queues a reconciliation: one member when `discordUserId` is given, the whole roster
 * otherwise.
 */
export async function syncRoster(ctx, input) {
  const data = parseOrThrow(syncRosterSchema, input);
  const prisma = ctx.prisma ?? getPrisma();
  const roster = await requireRoster(prisma, data.slug);

  authorize(ctx.actor, { capability: 'roster.sync', scope: { guildId: roster.approvedGuildId } });

  const job = await queueRosterSync(ctx, {
    roster,
    discordUserId: data.discordUserId ?? null,
    dryRun: data.dryRun,
    reason: data.reason ?? 'Manual roster synchronization',
    prisma,
  });

  return { jobId: job?.id ?? null, queued: Boolean(job) };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Creates and enqueues a roster job. Shared by every caller that wants Discord brought
 * back into agreement, including the event handler.
 *
 * @returns {Promise<object|null>}
 */
export async function queueRosterSync(
  ctx,
  { roster, discordUserId = null, dryRun, reason, prisma = getPrisma() },
) {
  const job = await createSyncJob(prisma, ctx, {
    type: discordUserId ? SyncJobType.ROSTER_MEMBER_SYNC : SyncJobType.ROSTER_SYNC,
    approvedGuildId: roster.approvedGuildId,
    dryRun: dryRun ?? false,
    reason,
    payload: { rosterId: roster.id, rosterSlug: roster.slug, discordUserId },
  });

  await enqueueSyncJob(job, { prisma });
  return job;
}

/** Loads a roster by slug or explains that it does not exist. */
export async function requireRoster(prisma, slug, include = undefined) {
  const roster = await prisma.roster.findFirst({
    where: { slug: String(slug ?? '').toLowerCase(), ...notDeleted },
    ...(include ? { include } : {}),
  });
  if (!roster) {
    throw new NotFoundError(`No roster with the slug "${slug}".`, { slug });
  }
  return roster;
}

function pickRosterState(roster) {
  return {
    name: roster.name,
    description: roster.description ?? null,
    published: roster.published,
    position: roster.position,
    nicknameSyncEnabled: roster.nicknameSyncEnabled,
  };
}
