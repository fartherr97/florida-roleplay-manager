/**
 * Environment validation.
 *
 * Secrets exist only as environment variables. This module validates them once at
 * startup and fails closed: in production a missing or weak required secret aborts
 * the process rather than silently degrading.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// `dotenv` never overwrites variables that are already set, so this is safe to call
// unconditionally: real process environment (Docker, systemd, CI) always wins.
loadDotenv({ quiet: true });

const SNOWFLAKE = /^\d{17,20}$/;
const PLACEHOLDER_SECRETS = new Set([
  'change_me_to_a_long_random_value_at_least_32_chars',
  'changeme',
  'secret',
]);

/** @param {boolean} defaultValue */
function booleanish(defaultValue) {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return value;
  }, z.boolean());
}

/**
 * @param {number} defaultValue
 * @param {{min?: number, max?: number}} [bounds]
 */
function integerish(defaultValue, bounds = {}) {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = bounds;
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'number') return value;
    const parsed = Number(String(value).trim());
    return Number.isNaN(parsed) ? value : parsed;
  }, z.number().int().min(min).max(max));
}

/** Comma separated list of Discord snowflakes. */
function snowflakeList() {
  return z.preprocess(
    (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value !== 'string') return [];
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    z.array(z.string().regex(SNOWFLAKE, 'must be a Discord snowflake')),
  );
}

/** Comma separated list of origins. */
function stringList() {
  return z.preprocess(
    (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value !== 'string') return [];
      return value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    z.array(z.string().min(1)),
  );
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DEV_MODE: booleanish(false),
    DEV_GUILD_IDS: snowflakeList(),
    DISCORD_MOCK: booleanish(false),
    SYNC_DRY_RUN_DEFAULT: booleanish(false),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),

    DATABASE_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

    DISCORD_BOT_TOKEN: z.string().min(1).optional(),
    DISCORD_CLIENT_ID: z.string().regex(SNOWFLAKE).optional(),
    DISCORD_CLIENT_SECRET: z.string().min(1).optional(),
    DISCORD_OAUTH_REDIRECT_URI: z.string().min(1).optional(),
    GLOBAL_ADMIN_DISCORD_IDS: snowflakeList(),
    ADMIN_ALERT_WEBHOOK_URL: z.string().min(1).optional(),

    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: integerish(4000, { min: 1, max: 65535 }),
    SESSION_SECRET: z.string().min(1).optional(),
    SESSION_TTL_SECONDS: integerish(86400, { min: 60, max: 60 * 60 * 24 * 30 }),
    COOKIE_SECURE: booleanish(false),
    CORS_ALLOWED_ORIGINS: stringList(),
    API_TRUST_PROXY: booleanish(false),
    RATE_LIMIT_MAX: integerish(120, { min: 1, max: 100000 }),
    RATE_LIMIT_WINDOW: z.string().min(1).default('1 minute'),

    SYNC_MARKER_TTL_SECONDS: integerish(60, { min: 5, max: 3600 }),
    SYNC_MAX_REMOVALS_THRESHOLD: integerish(50, { min: 1, max: 100000 }),
    SYNC_LOCK_TTL_SECONDS: integerish(30, { min: 5, max: 600 }),
    WORKER_CONCURRENCY: integerish(5, { min: 1, max: 100 }),
    RECONCILE_CRON: z.string().min(1).default('0 */6 * * *'),
    MAPPING_VALIDATION_CRON: z.string().min(1).default('0 3 * * *'),
  })
  .transform((value) => {
    // Production must fail closed: development affordances are forced off no matter
    // what the operator wrote in the environment file.
    if (value.NODE_ENV === 'production') {
      return {
        ...value,
        DEV_MODE: false,
        DISCORD_MOCK: false,
      };
    }
    return value;
  });

/**
 * Extra requirements per service. Validating these per-process means the worker does
 * not need OAuth secrets and the API does not need a bot token.
 */
const SERVICE_REQUIREMENTS = {
  bot: ['DATABASE_URL', 'REDIS_URL', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID'],
  worker: ['DATABASE_URL', 'REDIS_URL', 'DISCORD_BOT_TOKEN'],
  api: ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET'],
  script: ['DATABASE_URL'],
  test: [],
};

/**
 * Validate an environment source.
 *
 * @param {object} [options]
 * @param {'bot'|'worker'|'api'|'script'|'test'} [options.service]
 * @param {Record<string, string | undefined>} [options.source]
 * @returns {Readonly<object>}
 */
export function parseEnv({ service = 'script', source = process.env } = {}) {
  // An empty value in a `.env` file means "not configured", not "configured as the
  // empty string". Without this, every commented-out optional secret would fail
  // validation with a confusing "too small" message.
  const sanitized = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    ]),
  );

  // Platform-as-a-service hosts (Railway, Render, Heroku, Fly) assign the port at
  // runtime and pass it as `PORT`. Binding to anything else means the health check
  // never succeeds and the deployment is rolled back with no useful error, so `PORT`
  // is honoured when `API_PORT` was not set explicitly.
  if (sanitized.API_PORT === undefined && sanitized.PORT !== undefined) {
    sanitized.API_PORT = sanitized.PORT;
  }

  const result = envSchema.safeParse(sanitized);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = result.data;
  const problems = [];

  for (const key of SERVICE_REQUIREMENTS[service] ?? []) {
    if (!env[key]) problems.push(`${key} is required to run the "${service}" service`);
  }

  if (env.NODE_ENV === 'production') {
    if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) {
      problems.push('SESSION_SECRET must be at least 32 characters in production');
    }
    if (env.SESSION_SECRET && PLACEHOLDER_SECRETS.has(env.SESSION_SECRET)) {
      problems.push('SESSION_SECRET is still set to the example placeholder value');
    }
    if (service === 'api' && !env.COOKIE_SECURE) {
      problems.push('COOKIE_SECURE must be true in production');
    }
    if (service === 'api' && env.DISCORD_CLIENT_SECRET && !env.DISCORD_OAUTH_REDIRECT_URI) {
      problems.push('DISCORD_OAUTH_REDIRECT_URI is required when Discord OAuth is configured');
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  return Object.freeze({
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    isDevelopment: env.NODE_ENV === 'development',
    /** Development mode is only ever active outside production. */
    devMode: env.NODE_ENV !== 'production' && env.DEV_MODE,
  });
}

let cached = null;

/**
 * Cached environment accessor used by long-lived services.
 * @param {object} [options]
 * @param {'bot'|'worker'|'api'|'script'|'test'} [options.service]
 */
export function getEnv(options = {}) {
  if (!cached) cached = parseEnv(options);
  return cached;
}

/** Test helper: clears the cached environment so a new one can be parsed. */
export function resetEnvCache() {
  cached = null;
}
