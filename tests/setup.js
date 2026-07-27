/**
 * Vitest setup.
 *
 * Runs before every test file. Establishes a deterministic, offline environment: no
 * real Discord token, no real webhook, logging silenced, and the test database.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.DEV_MODE = 'true';
process.env.DISCORD_MOCK = 'true';
process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ?? 'test-session-secret-that-is-long-enough-000000';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frm:frm_local_password@localhost:5432/frm_test?schema=public';
process.env.REDIS_URL =
  process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
process.env.SYNC_DRY_RUN_DEFAULT = 'false';
