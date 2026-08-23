/**
 * Roster state calculation.
 *
 * The same shape as the role reconciliation engine, for the same reason: desired state
 * is computed from live Discord roles, actual state is what the database currently says,
 * and the difference is the work. Nothing here performs I/O, so the rules that decide
 * who is on a roster and at what rank can be tested exhaustively without a gateway.
 *
 * The single rule that matters: **holding a bound role is being that rank.** A member is
 * on the roster because Discord says so, and comes off it when Discord stops saying so.
 * There is no way to be added directly, which is what keeps the website and Discord from
 * ever disagreeing.
 */
import { RosterMembershipStatus } from '@frm/shared';
import { buildManagedNickname, inferPreferredName } from './roster-nickname.js';

/**
 * The rank a member holds, given the roles they currently have.
 *
 * A member may hold several bound roles at once - a promotion where nobody removed the
 * old role, or a department that stacks them deliberately. The highest `position` wins,
 * always, so the answer never depends on the order rows came back from the database. A
 * tie is broken by rank id so it is at least stable.
 *
 * @param {Array<{id: string, discordRoleId: string, position: number}>} ranks
 * @param {Iterable<string>} heldRoleIds
 * @returns {object|null} the winning rank, or null when they hold none
 */
export function resolveRank(ranks, heldRoleIds) {
  const held = heldRoleIds instanceof Set ? heldRoleIds : new Set(heldRoleIds ?? []);
  let winner = null;

  for (const rank of ranks) {
    if (!held.has(rank.discordRoleId)) continue;
    if (
      !winner ||
      rank.position > winner.position ||
      (rank.position === winner.position && String(rank.id) < String(winner.id))
    ) {
      winner = rank;
    }
  }

  return winner;
}

/** The label a rank contributes to a nickname. */
export function rankShortName(rank) {
  if (!rank) return null;
  const short = String(rank.shortName ?? '').trim();
  return short || String(rank.name ?? '').trim() || null;
}

/**
 * @typedef {object} RosterChange
 * @property {'ADD'|'PROMOTE'|'REMOVE'|'NICKNAME'|'NONE'} type
 * @property {string} discordUserId
 * @property {object|null} rank the rank they should hold
 * @property {object|null} previousRank
 * @property {string|null} nickname the nickname that should be written, if any
 * @property {string} name the name segment used
 * @property {string} reason human-readable, ends up in the Discord audit log
 */

/**
 * Computes what should change for one member of one roster.
 *
 * @param {object} params
 * @param {object} params.roster
 * @param {Array<object>} params.ranks every rank on the roster
 * @param {object|null} params.membership the current row, if any
 * @param {object|null} params.member the Discord member snapshot, null when they have left
 * @param {boolean} [params.nicknameSync] whether this roster owns the member's nickname
 * @returns {RosterChange}
 */
export function planMemberChange({ roster, ranks, membership, member, nicknameSync = true }) {
  const discordUserId = membership?.discordUserId ?? member?.id;
  const previousRank = membership?.rank ?? null;

  // Gone from the guild, or holds no bound role any more: off the roster. The nickname
  // prefix goes with it - they are not staff, so they should not be wearing a rank.
  if (!member) {
    return finish({
      type: membership && membership.status === RosterMembershipStatus.ACTIVE ? 'REMOVE' : 'NONE',
      discordUserId,
      rank: null,
      previousRank,
      nickname: null,
      name: membership?.preferredName || membership?.displayName || '',
      reason: `Left ${roster.name}: no longer in the server`,
    });
  }

  const rank = resolveRank(ranks, member.roleIds ?? []);
  const wasActive = membership?.status === RosterMembershipStatus.ACTIVE;
  const name = membership?.preferredName || inferPreferredName(member) || membership?.displayName;

  if (!rank) {
    const built = nicknameSync
      ? buildManagedNickname({
          currentNickname: member.nickname ?? null,
          fallbackName: member.username ?? member.displayName ?? null,
          preferredName: membership?.preferredName ?? null,
          callsign: null,
          rank: null,
        })
      : null;

    return finish({
      type: wasActive ? 'REMOVE' : 'NONE',
      discordUserId,
      rank: null,
      previousRank,
      // Strip the managed prefix rather than clearing the nickname outright: their name
      // is theirs, only the rank was ours to write.
      nickname: wasActive && nicknameSync ? built.nickname : null,
      name: built?.name ?? name,
      reason: `Left ${roster.name}: holds no roster role`,
    });
  }

  const built = nicknameSync
    ? buildManagedNickname({
        currentNickname: member.nickname ?? null,
        fallbackName: member.username ?? member.displayName ?? null,
        preferredName: membership?.preferredName ?? null,
        callsign: membership?.callsign ?? null,
        rank: rankShortName(rank),
      })
    : null;

  const nicknameNeedsWrite =
    nicknameSync && built.nickname && built.nickname !== (member.nickname ?? null);

  let type = 'NONE';
  let reason = `${roster.name}: already correct`;

  if (!wasActive) {
    type = 'ADD';
    reason = `Added to ${roster.name} as ${rank.name}`;
  } else if (previousRank?.id !== rank.id) {
    type = 'PROMOTE';
    reason = `${roster.name}: ${previousRank?.name ?? 'unranked'} -> ${rank.name}`;
  } else if (nicknameNeedsWrite) {
    type = 'NICKNAME';
    reason = `${roster.name}: nickname out of date`;
  }

  return finish({
    type,
    discordUserId,
    rank,
    previousRank,
    nickname: nicknameNeedsWrite ? built.nickname : null,
    name: built?.name ?? name,
    reason,
  });
}

/** Normalises a change so every caller sees the same shape. */
function finish(change) {
  return {
    nickname: null,
    previousRank: null,
    rank: null,
    name: '',
    ...change,
    // A change is only worth queueing when it alters the roster or the nickname.
    actionable: change.type !== 'NONE' || Boolean(change.nickname),
  };
}

/**
 * Computes the whole roster in one pass.
 *
 * @param {object} params
 * @param {object} params.roster
 * @param {Array<object>} params.ranks
 * @param {Array<object>} params.memberships existing rows
 * @param {Array<object>} params.members Discord member snapshots for the guild
 * @returns {RosterChange[]} only the changes worth applying
 */
export function planRosterChanges({ roster, ranks, memberships, members }) {
  const byId = new Map(members.map((member) => [member.id, member]));
  const seen = new Set();
  const changes = [];

  for (const membership of memberships) {
    seen.add(membership.discordUserId);
    const change = planMemberChange({
      roster,
      ranks,
      membership,
      member: byId.get(membership.discordUserId) ?? null,
      nicknameSync: roster.nicknameSyncEnabled !== false,
    });
    if (change.actionable) changes.push(change);
  }

  // Everybody else in the guild who holds a bound role but has no row yet.
  for (const member of members) {
    if (seen.has(member.id)) continue;
    if (!resolveRank(ranks, member.roleIds ?? [])) continue;

    const change = planMemberChange({
      roster,
      ranks,
      membership: null,
      member,
      nicknameSync: roster.nicknameSyncEnabled !== false,
    });
    if (change.actionable) changes.push(change);
  }

  return changes;
}

/**
 * How the website should see a roster: ranks in seniority order, each with its members.
 *
 * Shaped here rather than in the API route so the Discord `/roster view` command and the
 * website are rendering the same thing.
 *
 * @param {object} roster a roster with `ranks` and active `memberships` loaded
 * @returns {object}
 */
export function presentRoster(roster) {
  const ranks = [...(roster.ranks ?? [])].sort((a, b) => b.position - a.position);
  const active = (roster.memberships ?? []).filter(
    (membership) => membership.status === RosterMembershipStatus.ACTIVE,
  );

  return {
    slug: roster.slug,
    name: roster.name,
    description: roster.description ?? null,
    position: roster.position,
    updatedAt: roster.updatedAt,
    ranks: ranks.map((rank) => ({
      name: rank.name,
      shortName: rankShortName(rank),
      position: rank.position,
      discordRoleId: rank.discordRoleId,
      members: active
        .filter((membership) => membership.rankId === rank.id)
        .map((membership) => ({
          discordUserId: membership.discordUserId,
          name: membership.preferredName ?? membership.displayName ?? '',
          callsign: membership.callsign ?? null,
          since: membership.joinedAt,
        }))
        .sort(byCallsignThenName),
    })),
  };
}

/** Callsigns sort numerically where they can, so 9 comes before 165. */
function byCallsignThenName(a, b) {
  const left = Number.parseInt(a.callsign ?? '', 10);
  const right = Number.parseInt(b.callsign ?? '', 10);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
  if (a.callsign && b.callsign && a.callsign !== b.callsign) {
    return a.callsign.localeCompare(b.callsign);
  }
  return String(a.name).localeCompare(String(b.name));
}
