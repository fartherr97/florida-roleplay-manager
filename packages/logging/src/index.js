/**
 * Structured logging.
 *
 * A single pino instance with an explicit redaction list. Secrets must never reach a
 * log sink, so the redaction paths cover every shape a token or credential can take as
 * it moves through the system (env objects, request headers, Discord client options,
 * Prisma connection strings, job payloads).
 */
import { pino } from 'pino';
import { getEnv } from '@frm/shared/env';

/**
 * Paths scrubbed from every log record. pino applies these to the merged object, so
 * both top level and nested occurrences are covered by the wildcard forms.
 */
export const REDACTED_PATHS = Object.freeze([
  'token',
  'botToken',
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_SECRET',
  'SESSION_SECRET',
  'DATABASE_URL',
  'ADMIN_ALERT_WEBHOOK_URL',
  'password',
  'secret',
  'authorization',
  'cookie',
  'set-cookie',
  '*.token',
  '*.botToken',
  '*.password',
  '*.secret',
  '*.authorization',
  'env.DISCORD_BOT_TOKEN',
  'env.DISCORD_CLIENT_SECRET',
  'env.SESSION_SECRET',
  'env.DATABASE_URL',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
]);

let rootLogger = null;

function createRootLogger() {
  let level = 'info';
  let pretty = false;
  try {
    const env = getEnv();
    level = env.LOG_LEVEL;
    pretty = !env.isProduction && !env.isTest;
  } catch {
    // Logging must never be the reason a process fails to start; fall back to defaults
    // and let the service's own env validation produce the real error.
    level = process.env.LOG_LEVEL ?? 'info';
  }

  if (process.env.NODE_ENV === 'test') level = process.env.LOG_LEVEL ?? 'silent';

  /** @type {import('pino').LoggerOptions} */
  const options = {
    level,
    redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
    base: { service: process.env.FRM_SERVICE ?? undefined },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (pretty) {
    try {
      return pino({
        ...options,
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
        },
      });
    } catch {
      // pino-pretty is a dev dependency; fall back to JSON if it is absent.
      return pino(options);
    }
  }

  return pino(options);
}

/** The process-wide logger. */
export function getLogger() {
  if (!rootLogger) rootLogger = createRootLogger();
  return rootLogger;
}

/**
 * Child logger with stable context.
 * @param {string} name component name, e.g. "worker.sync"
 * @param {Record<string, unknown>} [bindings]
 */
export function createLogger(name, bindings = {}) {
  return getLogger().child({ component: name, ...bindings });
}

/** Test helper. */
export function resetLogger() {
  rootLogger = null;
}

/**
 * Serializes an error for logging without losing the AppError metadata and without
 * including a stack trace in production (stack traces belong in the error tracker,
 * not in aggregated logs where they bloat storage).
 *
 * @param {unknown} error
 */
export function serializeError(error) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      details: error.details,
      retryable: error.retryable,
      stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
      cause:
        error.cause instanceof Error
          ? { name: error.cause.name, message: error.cause.message }
          : undefined,
    };
  }
  return { message: String(error) };
}
