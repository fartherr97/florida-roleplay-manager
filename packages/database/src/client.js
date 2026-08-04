/**
 * Prisma client lifecycle.
 *
 * A single client per process. Prisma manages its own connection pool, so creating
 * more than one leaks connections and eventually exhausts Postgres.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient, Prisma } from '@prisma/client';
import { createLogger, serializeError } from '@frm/logging';
import { DependencyUnavailableError, getEnv } from '@frm/shared';

const log = createLogger('database');

/** @type {import('@prisma/client').PrismaClient | null} */
let client = null;

function createClient() {
  const env = getEnv();
  const instance = new PrismaClient({
    datasources: env.DATABASE_URL ? { db: { url: env.DATABASE_URL } } : undefined,
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
    ],
  });

  instance.$on('warn', (event) => log.warn({ prisma: event.message }, 'prisma warning'));
  instance.$on('error', (event) => log.error({ prisma: event.message }, 'prisma error'));

  return instance;
}

/** @returns {import('@prisma/client').PrismaClient} */
export function getPrisma() {
  if (!client) client = createClient();
  return client;
}

/**
 * Waits for the database to accept a connection, retrying with backoff.
 *
 * On a platform with private networking (Railway, Fly, Render), the link between a
 * freshly started container and the database is not always ready in the first second of
 * the container's life. A process that runs a single `SELECT 1` at boot and exits on
 * failure will crash-loop against a database that is perfectly healthy - it just was not
 * reachable yet. Retrying rides out that window while still failing closed if the
 * database is genuinely down: a wrong password or a missing database is not a connection
 * error, so it is thrown immediately rather than retried into a long, pointless wait.
 *
 * @param {object} [options]
 * @param {number} [options.attempts] total attempts before giving up
 * @param {number} [options.baseDelayMs] first backoff; doubles each attempt, capped at 5s
 * @param {import('@prisma/client').PrismaClient} [options.prisma]
 */
export async function waitForDatabase({ attempts = 10, baseDelayMs = 500, prisma } = {}) {
  const db = prisma ?? getPrisma();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await db.$queryRaw`SELECT 1`;
      if (attempt > 1) log.info({ attempt }, 'database reachable');
      return;
    } catch (error) {
      // Only a genuine reachability failure is worth waiting on. Anything else (bad
      // credentials, missing database) will never resolve by waiting, so surface it now.
      if (!isConnectionError(error) || attempt === attempts) {
        throw error;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), 5000);
      log.warn(
        { attempt, attempts, delayMs },
        'database not reachable yet; retrying (private network may still be starting)',
      );
      await sleep(delayMs);
    }
  }
}

/** Closes the connection pool. Called from graceful shutdown handlers. */
export async function disconnectPrisma() {
  if (!client) return;
  const closing = client;
  client = null;
  await closing.$disconnect();
}

/** Test helper: replaces the singleton (used by integration tests). */
export function setPrismaForTesting(instance) {
  client = instance;
}

/**
 * Runs a function inside a transaction.
 *
 * Every mutation that must stay consistent with its audit record uses this: the row
 * change, the `AuditLog` and the `SyncJob` row are written
 * together or not at all. Enqueueing onto BullMQ deliberately happens *after* the
 * commit, because a queue is not transactional.
 *
 * @template T
 * @param {(tx: import('@prisma/client').Prisma.TransactionClient) => Promise<T>} fn
 * @param {{timeout?: number, maxWait?: number, isolationLevel?: string}} [options]
 * @returns {Promise<T>}
 */
export async function withTransaction(fn, options = {}) {
  const prisma = getPrisma();
  try {
    return await prisma.$transaction(fn, {
      timeout: options.timeout ?? 15000,
      maxWait: options.maxWait ?? 5000,
      ...(options.isolationLevel ? { isolationLevel: options.isolationLevel } : {}),
    });
  } catch (error) {
    if (isConnectionError(error)) {
      log.error({ err: serializeError(error) }, 'database unavailable');
      throw new DependencyUnavailableError('database', error);
    }
    throw error;
  }
}

/** Recognises Prisma's connection-level failures so they can be surfaced as 503s. */
export function isConnectionError(error) {
  if (!error) return false;
  const code = error.code;
  return (
    error instanceof Prisma.PrismaClientInitializationError ||
    code === 'P1001' ||
    code === 'P1002' ||
    code === 'P1008' ||
    code === 'P1017'
  );
}

/** True when the error is a unique-constraint violation. */
export function isUniqueViolation(error) {
  return error?.code === 'P2002';
}

/** True when the error is a "record not found" failure. */
export function isNotFound(error) {
  return error?.code === 'P2025';
}

export { Prisma, PrismaClient };
