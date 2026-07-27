/**
 * Distributed locks.
 *
 * Two sync jobs for the same member running concurrently can issue contradictory role
 * calls (one adding Corporal while the other removes it). A short-lived Redis lock
 * serializes them. The token check on release means a job that overran its TTL cannot
 * delete a lock another job has since acquired.
 */
import { REDIS_PREFIX, getEnv } from '@frm/shared';
import { randomUUID } from 'node:crypto';
import { getRedis } from './connection.js';

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const EXTEND_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/**
 * @param {string} memberId platform user id (falls back to a Discord id)
 * @param {object} [options]
 * @param {number} [options.ttlSeconds]
 * @param {import('ioredis').Redis} [options.redis]
 * @returns {Promise<{token: string, key: string}|null>} null when the lock is held
 */
export async function acquireMemberLock(memberId, { ttlSeconds, redis = getRedis() } = {}) {
  const ttl = ttlSeconds ?? getEnv().SYNC_LOCK_TTL_SECONDS;
  const key = `${REDIS_PREFIX.MEMBER_LOCK}:${memberId}`;
  const token = randomUUID();
  const result = await redis.set(key, token, 'PX', ttl * 1000, 'NX');
  return result === 'OK' ? { token, key } : null;
}

/** @param {{key: string, token: string}} lock */
export async function releaseLock(lock, redis = getRedis()) {
  if (!lock) return false;
  const released = await redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.token);
  return released === 1;
}

/** Extends a lock the caller still holds. */
export async function extendLock(lock, ttlSeconds, redis = getRedis()) {
  if (!lock) return false;
  const extended = await redis.eval(EXTEND_SCRIPT, 1, lock.key, lock.token, ttlSeconds * 1000);
  return extended === 1;
}

/**
 * Runs `fn` while holding the member lock, retrying briefly before giving up.
 *
 * Returns `{ skipped: true }` rather than throwing when the lock cannot be taken: a
 * concurrent job for the same member is already doing this work, and because
 * reconciliation is idempotent, letting it do so is correct.
 *
 * @template T
 * @param {string} memberId
 * @param {() => Promise<T>} fn
 * @param {{ttlSeconds?: number, waitMs?: number, redis?: import('ioredis').Redis}} [options]
 */
export async function withMemberLock(memberId, fn, options = {}) {
  const { waitMs = 2000, redis = getRedis() } = options;
  const deadline = Date.now() + waitMs;

  let lock = await acquireMemberLock(memberId, { ...options, redis });
  while (!lock && Date.now() < deadline) {
    await sleep(100);
    lock = await acquireMemberLock(memberId, { ...options, redis });
  }

  if (!lock) return { skipped: true, reason: 'member is already being synchronized' };

  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    await releaseLock(lock, redis).catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
