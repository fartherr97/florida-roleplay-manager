/**
 * Reporting global bans to the community website.
 *
 * The website keeps an active Discord ban list in the Staff Hub. When
 * `/globalban` bans a user or `/globalunban` lifts one, the bot pings the site
 * so that list stays live — carrying the guild display name and Discord id
 * above all, plus the reason, who did it, and any expiry.
 *
 * Uses the same website credentials as /bgcheck (WEBSITE_API_URL +
 * WEBSITE_BOT_TOKEN) and is inert without them. Strictly best-effort: a dead or
 * unconfigured website must never affect the ban itself, so every failure is
 * swallowed after a debug log — the ban already happened in Discord.
 */
import { createLogger, serializeError } from '@frm/logging';
import { getEnv } from '@frm/shared';

const log = createLogger('bot.site-bans');

async function post(path, body) {
  const env = getEnv();
  if (!env.WEBSITE_API_URL || !env.WEBSITE_BOT_TOKEN) return;
  try {
    const res = await fetch(new URL(path, env.WEBSITE_API_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.WEBSITE_BOT_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`website responded ${res.status}`);
  } catch (error) {
    log.debug({ err: serializeError(error), path }, 'site ban report failed');
  }
}

/**
 * Report a global ban to the site's active list.
 * @param {{discordId: string, displayName?: string, reason?: string,
 *   actorId?: string, actorName?: string, serversApplied?: number,
 *   serversTotal?: number, expiresAt?: Date|string|null}} ban
 */
export function reportBan(ban) {
  if (!ban?.discordId) return Promise.resolve();
  return post('/api/bans/bot', {
    discordId: ban.discordId,
    displayName: ban.displayName ?? null,
    reason: ban.reason ?? null,
    actorId: ban.actorId ?? null,
    actorName: ban.actorName ?? null,
    serversApplied: ban.serversApplied ?? null,
    serversTotal: ban.serversTotal ?? null,
    expiresAt: ban.expiresAt instanceof Date ? ban.expiresAt.toISOString() : ban.expiresAt ?? null,
  });
}

/** Report a global unban, clearing the user from the site's active list. */
export function reportUnban({ discordId, actorId, actorName } = {}) {
  if (!discordId) return Promise.resolve();
  return post('/api/bans/bot/unban', {
    discordId,
    actorId: actorId ?? null,
    actorName: actorName ?? null,
  });
}
