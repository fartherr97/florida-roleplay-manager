/**
 * Nickname rendering and parsing.
 *
 * The managed format is `Callsign | Rank | Name`, e.g. `165 | Jr. Admin | Mike`.
 *
 * This file is pure - no database, no gateway - because it is the part that runs on
 * every promotion of every staff member, and the part whose bugs are visible to the
 * whole server. It is unit-tested directly.
 *
 * Two properties matter more than anything else here:
 *
 *   1. **Idempotence.** Rendering an already-rendered nickname must produce the same
 *      string. Get this wrong and a member accumulates prefixes on every sync until
 *      they read `165 | Jr. Admin | 165 | Mod | Mike`. That is why the renderer never
 *      appends to what is already there: it parses first, takes the name out, and
 *      rebuilds the whole string from the current rank.
 *   2. **The name survives.** The name segment belongs to the member, not to us. A rank
 *      change rewrites the rank and leaves the name alone, which is why parsing has to
 *      recover it from whatever they have set - including a nickname somebody typed by
 *      hand in roughly the right shape.
 */

/** Discord rejects a nickname longer than this. */
export const NICKNAME_MAX_LENGTH = 32;

/** The separator between segments. Surrounded by single spaces when rendering. */
const SEPARATOR = '|';

/**
 * A callsign is a short alphanumeric badge: `165`, `4S-12`, `A7`. Requiring a digit is
 * what keeps a two-segment `Rank | Name` nickname from being read as `Callsign | Name`,
 * since no rank in practice is bare digits.
 */
const CALLSIGN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,9}$/;
const HAS_DIGIT = /\d/;

/**
 * @typedef {object} ParsedNickname
 * @property {string|null} callsign
 * @property {string|null} rank
 * @property {string} name the member's own name, never empty
 */

const collapse = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** Whether a segment looks like a callsign rather than a name or a rank. */
function looksLikeCallsign(segment) {
  return CALLSIGN_PATTERN.test(segment) && HAS_DIGIT.test(segment);
}

/**
 * Splits a nickname into its parts.
 *
 * Deliberately lenient about what it accepts, because it runs against nicknames humans
 * typed. Anything it cannot make sense of is treated as a bare name, which is the safe
 * reading: the member keeps what they had and gains a correct prefix.
 *
 * @param {string|null|undefined} nickname
 * @returns {ParsedNickname}
 */
export function parseNickname(nickname) {
  const text = collapse(nickname);
  if (!text) return { callsign: null, rank: null, name: '' };

  const segments = text
    .split(SEPARATOR)
    .map(collapse)
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) return { callsign: null, rank: null, name: '' };
  if (segments.length === 1) return { callsign: null, rank: null, name: segments[0] };

  // The name is always the last segment: everything the platform writes goes in front of
  // it, and a member who adds their own suffix has told us their name is longer.
  const name = segments[segments.length - 1];
  const prefix = segments.slice(0, -1);

  if (prefix.length === 1) {
    // One prefix segment is a callsign when it looks like one, otherwise a rank.
    return looksLikeCallsign(prefix[0])
      ? { callsign: prefix[0], rank: null, name }
      : { callsign: null, rank: prefix[0], name };
  }

  // Two or more: the first is the callsign if it looks like one, and the segment
  // immediately before the name is the rank. Anything in between is somebody's own
  // decoration and is dropped, because we cannot round-trip what we do not understand.
  const callsign = looksLikeCallsign(prefix[0]) ? prefix[0] : null;
  const rank = prefix[prefix.length - 1] === callsign ? null : prefix[prefix.length - 1];
  return { callsign, rank, name };
}

/**
 * Builds the managed nickname.
 *
 * Missing parts collapse rather than leaving an empty segment: no callsign renders
 * `Jr. Admin | Mike`, and no rank renders `165 | Mike`. A member with neither keeps
 * their plain name.
 *
 * @param {object} parts
 * @param {string|null} [parts.callsign]
 * @param {string|null} [parts.rank]
 * @param {string} parts.name
 * @param {number} [parts.maxLength]
 * @returns {string}
 */
export function renderNickname({ callsign, rank, name, maxLength = NICKNAME_MAX_LENGTH }) {
  const cleanCallsign = collapse(callsign);
  const cleanRank = collapse(rank);
  const cleanName = collapse(name);

  const prefix = [cleanCallsign, cleanRank].filter(Boolean);
  if (prefix.length === 0) return truncateSegment(cleanName, maxLength);

  const joiner = ` ${SEPARATOR} `;
  const prefixText = prefix.join(joiner) + joiner;

  // The callsign and the rank are the identifying parts, so the name is what gives way
  // when the whole thing will not fit. A prefix that alone exceeds the limit means the
  // rank's short name needs shortening - truncate the whole string rather than emit
  // something invalid.
  const budget = maxLength - prefixText.length;
  if (budget < 1) return truncateSegment(prefixText + cleanName, maxLength);

  return prefixText + truncateSegment(cleanName, budget);
}

/**
 * Trims to a hard character limit, cutting at a word boundary when one is close enough
 * that the result still reads like a name.
 */
function truncateSegment(value, maxLength) {
  if (value.length <= maxLength) return value;
  const hard = value.slice(0, maxLength).trimEnd();
  const lastSpace = hard.lastIndexOf(' ');
  return lastSpace >= Math.floor(maxLength * 0.6) ? hard.slice(0, lastSpace) : hard;
}

/**
 * The nickname a member should have, computed from their current nickname and their
 * current rank.
 *
 * This is the idempotent entry point the reconciler calls: run it twice and the second
 * run returns the first run's output unchanged.
 *
 * @param {object} params
 * @param {string|null} params.currentNickname what Discord shows now
 * @param {string|null} [params.fallbackName] their username, when they have no nickname
 * @param {string|null} [params.preferredName] a name an administrator set explicitly
 * @param {string|null} [params.callsign]
 * @param {string|null} [params.rank] short rank label, or null to strip the prefix
 * @param {number} [params.maxLength]
 * @returns {{nickname: string, name: string}}
 */
export function buildManagedNickname({
  currentNickname,
  fallbackName = null,
  preferredName = null,
  callsign = null,
  rank = null,
  maxLength = NICKNAME_MAX_LENGTH,
}) {
  const parsed = parseNickname(currentNickname);

  // Precedence: an explicitly set name wins, then whatever their nickname says their
  // name is, then their username. The parsed name is preferred over the raw nickname so
  // an existing managed prefix is stripped instead of being rendered into the new one.
  const rawName = collapse(preferredName) || parsed.name || collapse(fallbackName) || '';

  // Every name source is parsed again before it is trusted. A `preferredName` or a
  // username can itself be in the managed shape — "189 | Trial Mod" left behind by a
  // past rename, or a display name someone typed that way — and rendering it verbatim
  // is what stacks a nickname into "168 | Mod | 189 | Trial Mod". Taking the trailing
  // name segment keeps the rebuild idempotent no matter how the source got its prefix.
  const name = parseNickname(rawName).name || rawName;

  return {
    name,
    nickname: renderNickname({ callsign, rank, name, maxLength }),
  };
}

/**
 * The name to remember for a member the platform has not seen before.
 *
 * Learned from their nickname rather than assumed, so somebody already using the house
 * format keeps their name instead of having their username imposed on them.
 *
 * @param {{nickname?: string|null, displayName?: string|null, username?: string|null}} member
 * @returns {string}
 */
export function inferPreferredName(member = {}) {
  const parsed = parseNickname(member.nickname ?? member.displayName ?? null);
  return parsed.name || collapse(member.username) || collapse(member.displayName) || '';
}
