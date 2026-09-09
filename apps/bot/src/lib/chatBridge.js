/**
 * Discord -> game chat bridge.
 *
 * Watches one channel (CHAT_BRIDGE_CHANNEL_ID). Every human message there is posted to
 * the game server's flrp_api `/chat/discord` endpoint, which renders it in every
 * player's chatbox as "[Discord] Display Name: text". The game -> Discord direction is
 * a plain webhook owned by the game server (flrp_chatbridge), so nothing here echoes.
 *
 * Failures are visible but quiet: a ❌ reaction on the message, and a log line.
 */
import { Events } from 'discord.js';
import { createLogger, serializeError } from '@frm/logging';

const log = createLogger('bot.chatbridge');
const MAX_LEN = 256;

/** Collapse a Discord message to one plain chat line the game can show. */
export function toGameLine(message) {
  let text = (message.cleanContent || message.content || '').replace(/\s+/g, ' ').trim();
  if (!text && message.attachments?.size) text = '[attachment]';
  if (!text && message.stickers?.size) text = '[sticker]';
  // Custom emoji come through as <:name:id>; keep just :name:.
  text = text.replace(/<a?(:\w+:)\d+>/g, '$1');
  if (text.length > MAX_LEN) text = `${text.slice(0, MAX_LEN - 1)}…`;
  return text;
}

/**
 * @param {import('discord.js').Client} client
 * @param {{env: object}} deps
 */
export function registerChatBridge(client, { env }) {
  const channelId = env.CHAT_BRIDGE_CHANNEL_ID;
  if (!channelId) return false;
  if (!env.FIVEM_API_URL || !env.FIVEM_API_SECRET) {
    log.warn('CHAT_BRIDGE_CHANNEL_ID is set but FIVEM_API_URL/FIVEM_API_SECRET are not; bridge is inbound-only from the game');
    return false;
  }
  const allowedRoles = new Set(env.CHAT_BRIDGE_ROLE_IDS ?? []);

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (message.channelId !== channelId) return;
      if (message.author.bot || message.webhookId || message.system) return;
      if (allowedRoles.size && !message.member?.roles.cache.some((r) => allowedRoles.has(r.id))) return;

      const text = toGameLine(message);
      if (!text) return;
      const name = message.member?.displayName || message.author.displayName || message.author.username;

      const res = await fetch(new URL('/flrp_api/chat/discord', env.FIVEM_API_URL), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-flrp-secret': env.FIVEM_API_SECRET },
        body: JSON.stringify({ name, message: text }),
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        log.warn({ status: res.status, body }, 'game server rejected a bridged chat line');
        await message.react('❌').catch(() => {});
      }
    } catch (error) {
      log.warn({ err: serializeError(error) }, 'could not relay a chat line to the game server');
      await message.react('❌').catch(() => {});
    }
  });

  log.info({ channelId, roleGate: allowedRoles.size }, 'chat bridge listening');
  return true;
}
