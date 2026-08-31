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

    // Secret managers and `.env` files frequently store a value with its quotes
    // attached, so `true` arrives as `"true"`. Stripping them here is safe because a
    // boolean's value space is tiny - unlike a password, no legitimate value is a
    // quoted string - and it turns a deployment-blocking error into a non-event.
    const normalized = String(value)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim()
      .toLowerCase();

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
    // Discord webhook the global ban/unban commands post their embedded log to.
    MOD_LOG_WEBHOOK_URL: z.string().min(1).optional(),
    // Discord webhook the `/mike` command posts to-do items to. Optional: the command
    // reports it is unavailable until it is set.
    MIKE_TODO_WEBHOOK_URL: z.string().min(1).optional(),
    // Role ids allowed to run `/mike` (Community Director and up). Optional: when empty the
    // command falls back to its built-in ownership + director role list.
    MIKE_ALLOWED_ROLE_IDS: snowflakeList(),

    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: integerish(4000, { min: 1, max: 65535 }),
    SESSION_SECRET: z.string().min(1).optional(),
    SESSION_TTL_SECONDS: integerish(86400, { min: 60, max: 60 * 60 * 24 * 30 }),
    COOKIE_SECURE: booleanish(false),
    // The cookie domain. When the dashboard runs on a different subdomain from
    // this API (e.g. flrp.us and api.flrp.us), the readable CSRF cookie must be
    // scoped to the shared parent (.flrp.us) or the dashboard cannot read it to
    // echo the token back. Leave unset for local development (host-only).
    COOKIE_DOMAIN: z.string().min(1).optional(),
    CORS_ALLOWED_ORIGINS: stringList(),
    // Where the OAuth callback sends the browser after a successful sign-in. The
    // dashboard lives on the website, not this API, so without it the callback
    // would leave the user on a JSON response. Falls back to the first allowed
    // CORS origin when unset.
    DASHBOARD_URL: z.string().min(1).optional(),

    // Soft-whitelist. The website posts submissions to this API authenticated by a
    // shared ingest token; the API posts each to the review channel with buttons, and
    // approving assigns the whitelist role. All optional: the feature is inert until
    // every value is set.
    WHITELIST_INGEST_TOKEN: z.string().min(1).optional(),
    WHITELIST_REVIEW_CHANNEL_ID: z.string().regex(SNOWFLAKE).optional(),
    // The "FLRP Whitelisted Member" role granted on approval — members need it to enter the
    // in-game server. Defaulted so approval works out of the box; override to change it.
    WHITELIST_ROLE_ID: z.string().regex(SNOWFLAKE).default('1534380773329600562'),

    // The community website, which owns disciplinary records. `/bgcheck` calls it
    // to read a member's folded record and post the embed it builds. The token is
    // the SAME shared secret the website validates as BOT_TOKEN. Both optional: the
    // command reports it is unavailable until they are set.
    WEBSITE_API_URL: z.string().min(1).optional(),
    WEBSITE_BOT_TOKEN: z.string().min(1).optional(),

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
/**
 * Variables whose value may be echoed back in a configuration error.
 *
 * Deliberately an allowlist rather than a denylist of secrets: a new secret added to the
 * schema must not start leaking into logs because somebody forgot to exclude it.
 */
const SAFE_TO_ECHO = new Set([
  'NODE_ENV',
  'DEV_MODE',
  'DISCORD_MOCK',
  'LOG_LEVEL',
  'COOKIE_SECURE',
  'API_TRUST_PROXY',
  'API_HOST',
  'API_PORT',
  'SYNC_DRY_RUN_DEFAULT',
  'SYNC_MARKER_TTL_SECONDS',
  'SYNC_MAX_REMOVALS_THRESHOLD',
  'SYNC_LOCK_TTL_SECONDS',
  'WORKER_CONCURRENCY',
  'SESSION_TTL_SECONDS',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_WINDOW',
  'RECONCILE_CRON',
  'MAPPING_VALIDATION_CRON',
]);

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
      .map((issue) => {
        const key = issue.path.join('.') || '(root)';
        // Show what actually arrived. "expected boolean, received string" without the
        // value sends you looking at the wrong variable; `received "true"` (with the
        // quotes visible) explains itself. Only safe for the values below, which are
        // never secrets - a token's contents must not reach a log.
        const shown = SAFE_TO_ECHO.has(key) ? ` (received ${JSON.stringify(sanitized[key])})` : '';
        return `  - ${key}: ${issue.message}${shown}`;
      })
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
