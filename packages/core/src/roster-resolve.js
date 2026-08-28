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
 * A rank's configured callsign block, or null when it has none.
 *
 * Both ends must be present and coherent for the block to count — a half-set range is
 * treated as no range so a misconfiguration never issues nonsense numbers.
 */
export function callsignRange(rank) {
  const start = rank?.callsignRangeStart;
  const end = rank?.callsignRangeEnd;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) return null;
  return { start, end };
}

/**
 * What a member wears when their rank has a callsign block but every number in it is
 * already taken. Visible on purpose — a placeholder in the nickname and on the roster is
 * how an administrator notices the block needs widening, rather than the member silently
 * going numberless. It is reissued a real number automatically the moment one frees up.
 */
export const CALLSIGN_UNASSIGNED = '???';

/** The integer a callsign represents, or null when it is not a plain number. */
function numericCallsign(callsign) {
  return /^\d+$/.test(String(callsign ?? '')) ? Number(callsign) : null;
}

/**
 * The callsign a member should wear given their rank.
 *
 * Only plain numeric callsigns are auto-managed: a custom badge like `K9-1` is somebody's
 * deliberate choice and is left alone. A number already inside the rank's block is kept,
 * so a promotion within the same block does not churn it; a missing number, or one that
 * belongs to a different rank's block, is reissued from this rank's block. When every
 * number in the block is taken the member gets the `???` placeholder until one frees up;
 * when the rank has no block at all, whatever they already had stands.
 *
 * @param {object|null} rank
 * @param {string|null} current the member's existing callsign
 * @param {(rank: object) => (string|null)} [allocate] reserves and returns the next free number
 * @returns {string|null}
 */
export function resolveCallsign(rank, current, allocate) {
  const range = callsignRange(rank);
  if (!range) return current ?? null;

  // The placeholder is not a real callsign — it always wants replacing with a number.
  if (current != null && current !== CALLSIGN_UNASSIGNED) {
    const n = numericCallsign(current);
    if (n === null) return current; // a custom, non-numeric callsign is theirs to keep
    if (n >= range.start && n <= range.end) return current; // already in this block
  }

  const next = allocate ? allocate(rank) : null;
  return next ?? CALLSIGN_UNASSIGNED;
}

/**
 * Builds a callsign allocator over a set of memberships.
 *
 * The allocator hands out the lowest free number in a rank's block and reserves it, so a
 * single planning pass over a whole roster never issues the same number twice. Only active
 * numeric callsigns count as taken — a departed member's number is free to reissue.
 *
 * @param {Array<{callsign?: string|null, status?: string}>} memberships
 * @returns {(rank: object) => (string|null)}
 */
export function makeCallsignAllocator(memberships = []) {
  const taken = new Set();
  for (const membership of memberships) {
    if (membership?.status && membership.status !== RosterMembershipStatus.ACTIVE) continue;
    const n = numericCallsign(membership?.callsign);
    if (n !== null) taken.add(n);
  }

  return (rank) => {
    const range = callsignRange(rank);
    if (!range) return null;
    for (let n = range.start; n <= range.end; n += 1) {
      if (!taken.has(n)) {
        taken.add(n);
        return String(n);
      }
    }
    return null; // the block is full
  };
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
export function planMemberChange({
  roster,
  ranks,
  membership,
  member,
  nicknameSync = true,
  allocateCallsign = null,
}) {
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
  const name =
    membership?.preferredName ||
    membership?.syncedName ||
    inferPreferredName(member) ||
    membership?.displayName;

  if (!rank) {
    const built = nicknameSync
      ? buildManagedNickname({
          currentNickname: member.nickname ?? null,
          fallbackName: member.username ?? member.displayName ?? null,
          preferredName: membership?.preferredName ?? null,
          syncedName: membership?.syncedName ?? null,
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

  // The callsign the member should wear for this rank: kept when it is already right,
  // issued from the rank's block when it is missing or belongs to another rank.
  const currentCallsign = membership?.callsign ?? null;
  const callsign = resolveCallsign(rank, currentCallsign, allocateCallsign);
  const callsignChanged = (callsign ?? null) !== currentCallsign;

  const built = nicknameSync
    ? buildManagedNickname({
        currentNickname: member.nickname ?? null,
        fallbackName: member.username ?? member.displayName ?? null,
        preferredName: membership?.preferredName ?? null,
        syncedName: membership?.syncedName ?? null,
        callsign,
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
  } else if (callsignChanged) {
    // A callsign was issued but nothing else changed — e.g. on a roster that does not
    // rewrite nicknames. Still worth persisting so the website shows it.
    reason = `${roster.name}: callsign ${callsign} issued`;
  }

  return finish({
    type,
    discordUserId,
    rank,
    previousRank,
    callsign,
    callsignChanged,
    nickname: nicknameNeedsWrite ? built.nickname : null,
    name: built?.name ?? name,
    reason,
  });
}

/** Normalises a change so every caller sees the same shape. */
function finish(change) {
  const normalized = {
    nickname: null,
    previousRank: null,
    rank: null,
    callsign: null,
    callsignChanged: false,
    name: '',
    ...change,
  };
  return {
    ...normalized,
    // A change is worth queueing when it alters the roster, the nickname, or the callsign.
    actionable:
      normalized.type !== 'NONE' ||
      Boolean(normalized.nickname) ||
      Boolean(normalized.callsignChanged),
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

  // One allocator for the whole pass, seeded from the numbers already in use, so a sweep
  // that issues several callsigns at once never hands out the same one twice.
  const allocateCallsign = makeCallsignAllocator(memberships);
  const nicknameSync = roster.nicknameSyncEnabled !== false;

  for (const membership of memberships) {
    seen.add(membership.discordUserId);
    const change = planMemberChange({
      roster,
      ranks,
      membership,
      member: byId.get(membership.discordUserId) ?? null,
      nicknameSync,
      allocateCallsign,
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
      nicknameSync,
      allocateCallsign,
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
      // The auto-assign block, so the dashboard can show and edit it. Null when unset.
      callsignRangeStart: rank.callsignRangeStart ?? null,
      callsignRangeEnd: rank.callsignRangeEnd ?? null,
      // The bound Discord role's colour, so the website can band the roster to match.
      color: rank.color ?? null,
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
