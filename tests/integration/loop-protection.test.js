/**
 * Loop protection against a real Redis.
 *
 * The single-use property is the one that actually prevents infinite loops, so it is
 * tested against the real server rather than a fake: a Lua script that works in theory
 * but not against this Redis version would be a very bad thing to discover in
 * production.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SyncActionType } from '@frm/shared';
import {
  acquireMemberLock,
  claimSyncMarker,
  closeRedis,
  discardSyncMarker,
  getRedis,
  peekSyncMarker,
  releaseLock,
  withMemberLock,
  writeSyncMarker,
  writeSyncMarkers,
} from '@frm/queue';
import { isRedisAvailable } from '../helpers/services.js';

const available = await isRedisAvailable();

const GUILD = '900000000000000111';
const USER = '700000000000000111';
const ROLE = '800000000000000111';

const marker = (overrides = {}) => ({
  discordGuildId: GUILD,
  discordUserId: USER,
  discordRoleId: ROLE,
  action: SyncActionType.ADD_ROLE,
  syncJobId: 'job-1',
  originGuildId: '900000000000000222',
  originMappingId: 'mapping-1',
  ...overrides,
});

describe.skipIf(!available)('sync markers', () => {
  beforeEach(async () => {
    const redis = getRedis();
    const keys = await redis.keys('frm:syncmarker:*');
    if (keys.length) await redis.del(...keys);
  });

  afterAll(async () => {
    await closeRedis();
  });

  it('recognises a system generated change', async () => {
    await writeSyncMarker(marker());
    const claimed = await claimSyncMarker({
      discordGuildId: GUILD,
      discordUserId: USER,
      discordRoleId: ROLE,
      action: SyncActionType.ADD_ROLE,
    });

    expect(claimed).not.toBeNull();
    expect(claimed.originMappingId).toBe('mapping-1');
    expect(claimed.syncJobId).toBe('job-1');
  });

  it('is single use: a second event cannot claim the same marker', async () => {
    await writeSyncMarker(marker());
    const parts = {
      discordGuildId: GUILD,
      discordUserId: USER,
      discordRoleId: ROLE,
      action: SyncActionType.ADD_ROLE,
    };

    const first = await claimSyncMarker(parts);
    const second = await claimSyncMarker(parts);

    expect(first).not.toBeNull();
    // This is what breaks the loop: the echo of our own change is consumed once, and
    // any subsequent change to the same role is treated as a genuine human action.
    expect(second).toBeNull();
  });

  it('does not claim across a different action, role, guild or member', async () => {
    await writeSyncMarker(marker());

    expect(
      await claimSyncMarker({
        discordGuildId: GUILD,
        discordUserId: USER,
        discordRoleId: ROLE,
        action: SyncActionType.REMOVE_ROLE,
      }),
    ).toBeNull();
    expect(
      await claimSyncMarker({
        discordGuildId: GUILD,
        discordUserId: USER,
        discordRoleId: '800000000000000999',
        action: SyncActionType.ADD_ROLE,
      }),
    ).toBeNull();
    expect(
      await claimSyncMarker({
        discordGuildId: '900000000000000999',
        discordUserId: USER,
        discordRoleId: ROLE,
        action: SyncActionType.ADD_ROLE,
      }),
    ).toBeNull();

    // The original marker is still there, unconsumed.
    expect(await peekSyncMarker(marker())).not.toBeNull();
  });

  it('sets an expiry so a lost event cannot suppress changes forever', async () => {
    await writeSyncMarker(marker());
    const redis = getRedis();
    const [key] = await redis.keys('frm:syncmarker:*');
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('writes a batch of markers in one round trip', async () => {
    const markers = [
      marker({ discordRoleId: '800000000000000201' }),
      marker({ discordRoleId: '800000000000000202' }),
      marker({ discordRoleId: '800000000000000203', action: SyncActionType.REMOVE_ROLE }),
    ];
    await writeSyncMarkers(markers);

    for (const entry of markers) {
      expect(await claimSyncMarker(entry)).not.toBeNull();
    }
  });

  it('discards a marker when the Discord call failed', async () => {
    await writeSyncMarker(marker());
    await discardSyncMarker(marker());
    // No marker left, so the next event is treated as a human action - which is right,
    // because our change never actually happened.
    expect(await claimSyncMarker(marker())).toBeNull();
  });
});

describe.skipIf(!available)('member locks', () => {
  const memberId = 'lock-test-member';

  it('prevents two concurrent syncs for the same member', async () => {
    const first = await acquireMemberLock(memberId, { ttlSeconds: 5 });
    expect(first).not.toBeNull();

    const second = await acquireMemberLock(memberId, { ttlSeconds: 5 });
    expect(second).toBeNull();

    await releaseLock(first);
    const third = await acquireMemberLock(memberId, { ttlSeconds: 5 });
    expect(third).not.toBeNull();
    await releaseLock(third);
  });

  it('does not let a stale holder release a lock it no longer owns', async () => {
    const lock = await acquireMemberLock(memberId, { ttlSeconds: 5 });
    await releaseLock(lock);

    const other = await acquireMemberLock(memberId, { ttlSeconds: 5 });
    // The first holder tries to release again; it must not remove the new holder's lock.
    expect(await releaseLock(lock)).toBe(false);
    expect(await acquireMemberLock(memberId, { ttlSeconds: 5 })).toBeNull();
    await releaseLock(other);
  });

  it('skips rather than throws when a member is already being synchronized', async () => {
    const held = await acquireMemberLock(memberId, { ttlSeconds: 5 });
    const outcome = await withMemberLock(memberId, async () => 'ran', { waitMs: 150 });

    expect(outcome.skipped).toBe(true);
    await releaseLock(held);

    const second = await withMemberLock(memberId, async () => 'ran', { waitMs: 150 });
    expect(second.skipped).toBe(false);
    expect(second.result).toBe('ran');
  });
});
