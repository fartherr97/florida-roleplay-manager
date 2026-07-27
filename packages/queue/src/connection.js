/**
 * Redis connections.
 *
 * Two pools, deliberately:
 *   - the BullMQ connection needs `maxRetriesPerRequest: null` because blocking
 *     commands must not be aborted, and BullMQ refuses to start otherwise;
 *   - the general-purpose connection (markers, locks, sessions) keeps normal retry
 *     semantics so a wedged Redis surfaces as an error instead of hanging.
 */
import { Redis } from 'ioredis';
import { createLogger, serializeError } from '@frm/logging';
import { DependencyUnavailableError, getEnv } from '@frm/shared';

const log = createLogger('queue.redis');

/** @type {Redis|null} */
let bullConnection = null;
/** @type {Redis|null} */
let generalConnection = null;

function attachHandlers(connection, label) {
  connection.on('error', (error) => {
    log.error({ err: serializeError(error), connection: label }, 'redis error');
  });
  connection.on('reconnecting', () => log.warn({ connection: label }, 'redis reconnecting'));
  return connection;
}

/** Connection used by BullMQ queues and workers. */
export function getBullConnection() {
  if (!bullConnection) {
    bullConnection = attachHandlers(
      new Redis(getEnv().REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      }),
      'bullmq',
    );
  }
  return bullConnection;
}

/** Connection used for markers, locks and sessions. */
export function getRedis() {
  if (!generalConnection) {
    generalConnection = attachHandlers(
      new Redis(getEnv().REDIS_URL, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: true,
      }),
      'general',
    );
  }
  return generalConnection;
}

/** Wraps a Redis operation so an outage becomes a typed, retryable error. */
export async function withRedis(operation) {
  try {
    return await operation(getRedis());
  } catch (error) {
    log.error({ err: serializeError(error) }, 'redis operation failed');
    throw new DependencyUnavailableError('redis', error);
  }
}

export async function closeRedis() {
  const connections = [bullConnection, generalConnection].filter(Boolean);
  bullConnection = null;
  generalConnection = null;
  await Promise.all(
    connections.map((connection) => connection.quit().catch(() => connection.disconnect())),
  );
}

/** Test helper: injects connections without touching the environment. */
export function setConnectionsForTesting({ bull, general }) {
  bullConnection = bull ?? bullConnection;
  generalConnection = general ?? generalConnection;
}
