/** Cross-cutting constants. */

/** Pagination bounds applied to every list endpoint and paginated embed. */
export const PAGINATION = Object.freeze({
  DEFAULT_PAGE_SIZE: 25,
  MAX_PAGE_SIZE: 100,
});

/** Redis key prefixes. Namespaced so a shared Redis instance stays legible. */
export const REDIS_PREFIX = Object.freeze({
  SYNC_MARKER: 'frm:syncmarker',
  NICKNAME_MARKER: 'frm:nickmarker',
  MEMBER_LOCK: 'frm:lock:member',
  JOB_LOCK: 'frm:lock:job',
  SESSION: 'frm:session',
  CSRF: 'frm:csrf',
  COMMAND_RATE: 'frm:rate:command',
  OAUTH_STATE: 'frm:oauth:state',
});

/** BullMQ queue names. */
export const QUEUE_NAMES = Object.freeze({
  SYNC: 'frm-sync',
  ROLE_ACTION: 'frm-role-action',
  MAINTENANCE: 'frm-maintenance',
  ROSTER: 'frm-roster',
});

/**
 * Discord's own limits that the presentation layer must respect.
 */
export const DISCORD_LIMITS = Object.freeze({
  EMBED_DESCRIPTION: 4096,
  EMBED_FIELD_VALUE: 1024,
  EMBED_FIELDS: 25,
  SELECT_OPTIONS: 25,
  COMPONENT_CUSTOM_ID: 100,
  MESSAGE_CONTENT: 2000,
});

/** How long an interactive confirmation stays valid. */
export const CONFIRMATION_TTL_MS = 2 * 60 * 1000;

/** How long a pending two-person approval stays valid. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Retry policy for Discord operations that may succeed later.
 * Permanent failures (missing permission, deleted role) are never retried.
 */
export const RETRY_POLICY = Object.freeze({
  attempts: 5,
  backoff: Object.freeze({ type: 'exponential', delay: 2000 }),
});

/** The action a member of every guild implicitly has; never managed by the platform. */
export const EVERYONE_ROLE_NAME = '@everyone';
