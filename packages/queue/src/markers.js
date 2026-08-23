/**
 * Synchronization markers: loop protection.
 *
 * The problem: when the bot adds a role because of a mapping, Discord emits a
 * `guildMemberUpdate` event for that change. If the handler treats it as a human
 * action it will propagate it back, and a two-way mapping becomes an infinite loop.
 *
 * The solution: before the bot performs a mapped role change it writes a short-lived
 * marker to Redis. When the resulting event arrives, the handler *consumes* the marker
 * and recognises the change as its own.
 *
 * Two properties matter:
 *
 *   - **Redis, not an in-process Set.** The bot and the worker are separate processes
 *     (and may be several replicas). The process that applies the change is usually not
 *     the process that receives the event.
 *   - **Single use, consumed atomically.** GET-then-DEL as two commands would let two
 *     concurrent events both claim the same marker. The Lua script below makes claiming
 *     a marker atomic, so exactly one event can ever consume it.
 */
import { REDIS_PREFIX, getEnv, nicknameChangeKey, roleChangeKey } from '@frm/shared';
import { createLogger } from '@frm/logging';
import { getRedis } from './connection.js';

const log = createLogger('queue.markers');

/**
 * Atomic get-and-delete. Written as a script rather than using GETDEL so it works on
 * Redis versions older than 6.2 as well.
 */
const CLAIM_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
end
return value
`;

/** @param {object} parts */
function markerKey({ discordGuildId, discordUserId, discordRoleId, action }) {
  return `${REDIS_PREFIX.SYNC_MARKER}:${roleChangeKey({
    discordGuildId,
    discordUserId,
    discordRoleId,
    action,
  })}`;
}

/**
 * Records that the platform is about to make a role change, so the resulting Discord
 * event can be recognised as system generated.
 *
 * Must be called *before* the Discord API call: if it were called after, the event
 * could arrive first and be misread as a human action.
 *
 * @param {object} marker
 * @param {string} marker.discordGuildId
 * @param {string} marker.discordUserId
 * @param {string} marker.discordRoleId
 * @param {string} marker.action ADD_ROLE | REMOVE_ROLE
 * @param {string} [marker.syncJobId]
 * @param {string} [marker.originGuildId] guild whose change triggered this one
 * @param {string} [marker.originMappingId]
 * @param {import('ioredis').Redis} [redis]
 */
export async function writeSyncMarker(marker, redis = getRedis()) {
  const ttl = getEnv().SYNC_MARKER_TTL_SECONDS;
  const key = markerKey(marker);
  const payload = JSON.stringify({
    syncJobId: marker.syncJobId ?? null,
    discordUserId: marker.discordUserId,
    discordGuildId: marker.discordGuildId,
    discordRoleId: marker.discordRoleId,
    action: marker.action,
    originGuildId: marker.originGuildId ?? null,
    originMappingId: marker.originMappingId ?? null,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  });

  await redis.set(key, payload, 'EX', ttl);
  return key;
}

/**
 * Claims the marker for an observed Discord change.
 *
 * @returns {Promise<object|null>} the marker when this change was system generated,
 *   `null` when it was not (meaning: a human did it, evaluate mappings).
 */
export async function claimSyncMarker(
  { discordGuildId, discordUserId, discordRoleId, action },
  redis = getRedis(),
) {
  const key = markerKey({ discordGuildId, discordUserId, discordRoleId, action });
  const raw = await redis.eval(CLAIM_SCRIPT, 1, key);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    log.warn({ key }, 'malformed sync marker discarded');
    return null;
  }
}

/**
 * Peeks without consuming. Only for diagnostics (`/system health`); the event path must
 * always use {@link claimSyncMarker} so a marker cannot be claimed twice.
 */
export async function peekSyncMarker(parts, redis = getRedis()) {
  const raw = await redis.get(markerKey(parts));
  return raw ? JSON.parse(raw) : null;
}

/**
 * Writes markers for a batch of planned actions in one round trip.
 * @param {Array<object>} markers
 */
export async function writeSyncMarkers(markers, redis = getRedis()) {
  if (markers.length === 0) return [];
  const ttl = getEnv().SYNC_MARKER_TTL_SECONDS;
  const pipeline = redis.pipeline();
  const keys = [];

  for (const marker of markers) {
    const key = markerKey(marker);
    keys.push(key);
    pipeline.set(
      key,
      JSON.stringify({
        syncJobId: marker.syncJobId ?? null,
        discordUserId: marker.discordUserId,
        discordGuildId: marker.discordGuildId,
        discordRoleId: marker.discordRoleId,
        action: marker.action,
        originGuildId: marker.originGuildId ?? null,
        originMappingId: marker.originMappingId ?? null,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      }),
      'EX',
      ttl,
    );
  }

  await pipeline.exec();
  return keys;
}

/**
 * Drops a marker that will never be claimed because the Discord call failed. Without
 * this, a failed add would suppress the next legitimate event for that role.
 */
export async function discardSyncMarker(parts, redis = getRedis()) {
  await redis.del(markerKey(parts));
}

// ---------------------------------------------------------------------------
// Nickname markers
// ---------------------------------------------------------------------------
//
// Roster synchronization rewrites nicknames, and Discord reports a nickname change on
// the same `guildMemberUpdate` event as a role change. The nickname handler restores the
// managed format when somebody edits it by hand, so without a marker the bot's own write
// would look like a hand edit and it would rewrite its own rewrite, forever.
//
// A separate key space from role markers, because the identity of a nickname change is
// (guild, member) - there is no role in it, and reusing `roleChangeKey` would mean
// inventing a fake role id.

function nicknameMarkerKey({ discordGuildId, discordUserId }) {
  return `${REDIS_PREFIX.NICKNAME_MARKER}:${nicknameChangeKey({
    discordGuildId,
    discordUserId,
  })}`;
}

/**
 * Records that the platform is about to rewrite a member's nickname. Call before the
 * Discord write, for the same reason as {@link writeSyncMarker}.
 *
 * @param {object} marker
 * @param {string} marker.discordGuildId
 * @param {string} marker.discordUserId
 * @param {string|null} [marker.nickname] the value being written, for diagnostics
 * @param {string} [marker.syncJobId]
 * @param {import('ioredis').Redis} [redis]
 */
export async function writeNicknameMarker(marker, redis = getRedis()) {
  const ttl = getEnv().SYNC_MARKER_TTL_SECONDS;
  const key = nicknameMarkerKey(marker);
  await redis.set(
    key,
    JSON.stringify({
      syncJobId: marker.syncJobId ?? null,
      discordGuildId: marker.discordGuildId,
      discordUserId: marker.discordUserId,
      nickname: marker.nickname ?? null,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    }),
    'EX',
    ttl,
  );
  return key;
}

/**
 * Claims the marker for an observed nickname change.
 *
 * @returns {Promise<object|null>} the marker when the platform wrote this nickname,
 *   `null` when a human did.
 */
export async function claimNicknameMarker({ discordGuildId, discordUserId }, redis = getRedis()) {
  const key = nicknameMarkerKey({ discordGuildId, discordUserId });
  const raw = await redis.eval(CLAIM_SCRIPT, 1, key);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    log.warn({ key }, 'malformed nickname marker discarded');
    return null;
  }
}

/** Drops a nickname marker whose Discord write failed. */
export async function discardNicknameMarker(parts, redis = getRedis()) {
  await redis.del(nicknameMarkerKey(parts));
}
