/**
 * Identifier helpers.
 *
 * Internal records use UUIDs. Discord identifiers are snowflakes and are always
 * stored and compared as strings — they exceed `Number.MAX_SAFE_INTEGER`.
 */
import { randomUUID } from 'node:crypto';

export const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @param {unknown} value */
export function isSnowflake(value) {
  return typeof value === 'string' && SNOWFLAKE_PATTERN.test(value);
}

/** @param {unknown} value */
export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Generates a request/correlation identifier. */
export function newRequestId() {
  return randomUUID();
}

/**
 * Deterministic key for a role change, used for Redis loop-protection markers and
 * for de-duplicating planned actions.
 *
 * @param {{discordGuildId: string, discordUserId: string, discordRoleId: string, action: string}} parts
 */
export function roleChangeKey({ discordGuildId, discordUserId, discordRoleId, action }) {
  return `${discordGuildId}:${discordUserId}:${discordRoleId}:${action}`;
}

/**
 * Strips a Discord mention wrapper (`<@123>`, `<@!123>`, `<@&123>`) leaving the raw id.
 * Slash-command string options frequently arrive in mention form when copy-pasted.
 *
 * @param {string} value
 * @returns {string}
 */
export function extractSnowflake(value) {
  if (typeof value !== 'string') return '';
  const match = value.trim().match(/^<[@#]?[!&]?(\d{17,20})>$/);
  if (match) return match[1];
  return value.trim();
}
