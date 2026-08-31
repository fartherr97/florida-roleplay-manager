/**
 * Nudging the community website when a member changes.
 *
 * The website keeps its own roster read straight from Discord. Rather than have
 * it poll, the bot pings it the moment a member's roles, nickname or presence
 * change; the site then re-reads just that member and updates its roster
 * instantly. The ping carries only the member id — the site fetches the live
 * state itself, so nothing here can write anything wrong.
 *
 * Uses the same website credentials as /bgcheck (WEBSITE_API_URL +
 * WEBSITE_BOT_TOKEN) and is inert without them. Strictly best-effort: a dead
 * website must never affect event handling, so every failure is swallowed after
 * a debug log, and the site's interval sync repairs whatever a lost ping missed.
 */
import { createLogger, serializeError } from '@frm/logging';
import { getEnv } from '@frm/shared';

const log = createLogger('bot.site-notify');

/** One Discord change arrives as a burst of events (role mirroring across
 * guilds, a rename alongside), so coalesce per member for a moment and ping
 * once. */
const pending = new Map(); // discordUserId -> timeout

export function notifySiteMemberChange(discordUserId) {
  const env = getEnv();
  if (!env.WEBSITE_API_URL || !env.WEBSITE_BOT_TOKEN) return;

  const id = String(discordUserId ?? '');
  if (!id) return;

  clearTimeout(pending.get(id));
  const timer = setTimeout(() => {
    pending.delete(id);
    sendPing(env, id).catch((error) => {
      log.debug({ err: serializeError(error), discordUserId: id }, 'site roster ping failed');
    });
  }, 2000);
  timer.unref?.();
  pending.set(id, timer);
}

async function sendPing(env, discordUserId) {
  const res = await fetch(new URL('/api/roster/event', env.WEBSITE_API_URL), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.WEBSITE_BOT_TOKEN}`,
    },
    body: JSON.stringify({ discordId: discordUserId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`website responded ${res.status}`);
  log.debug({ discordUserId }, 'site roster ping sent');
}
