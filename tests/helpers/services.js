/**
 * Probes for the backing services.
 *
 * The unit suite - which covers all of the synchronization, authorization and
 * reconciliation logic - runs with no services at all. The integration suite needs
 * Postgres and Redis, so it checks here and skips with a loud message rather than
 * producing a wall of confusing connection errors.
 *
 * Start them with: docker compose up -d postgres redis
 */
import { Redis } from 'ioredis';
import { PrismaClient } from '@prisma/client';

let redisAvailable = null;
let postgresAvailable = null;

export async function isRedisAvailable() {
  if (redisAvailable !== null) return redisAvailable;
  const client = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    connectTimeout: 1500,
  });
  try {
    await client.connect();
    await client.ping();
    redisAvailable = true;
  } catch {
    redisAvailable = false;
  } finally {
    client.disconnect();
  }
  if (!redisAvailable) {
    console.warn('\n[tests] Redis is not reachable - skipping integration tests that need it.');
    console.warn('[tests] Start it with: docker compose up -d redis\n');
  }
  return redisAvailable;
}

export async function isPostgresAvailable() {
  if (postgresAvailable !== null) return postgresAvailable;
  const client = new PrismaClient();
  try {
    await client.$queryRaw`SELECT 1`;
    postgresAvailable = true;
  } catch {
    postgresAvailable = false;
  } finally {
    await client.$disconnect().catch(() => {});
  }
  if (!postgresAvailable) {
    console.warn('\n[tests] Postgres is not reachable - skipping integration tests that need it.');
    console.warn('[tests] Start it with: docker compose up -d postgres && npm run prisma:deploy\n');
  }
  return postgresAvailable;
}
