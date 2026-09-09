/**
 * Gateway construction from the environment.
 *
 * Shared by the bot and the worker so `DISCORD_MOCK` behaves identically in both:
 * reads hit the real API, writes are logged and skipped. Real plans, no consequences -
 * which is what makes a development environment worth having.
 */
import { createLogger } from '@frm/logging';
import { getEnv } from '@frm/shared';
import { DiscordJsRoleGateway, ReadOnlyGatewayDecorator } from './gateway.js';
import { GatewayIntentBits } from 'discord.js';
import { createDiscordClient, loginClient } from './client.js';

const log = createLogger('discord.factory');

/**
 * @param {object} [options]
 * @param {boolean} [options.cacheMembers] the worker does not need a member cache
 * @param {boolean} [options.chatBridge] request the message intents the chat bridge needs
 * @returns {Promise<{gateway: object, client: import('discord.js').Client}>}
 */
export async function createGatewayFromEnv({ cacheMembers = false, chatBridge = false } = {}) {
  const env = getEnv();

  // The chat bridge reads message content in one channel, which needs the (privileged)
  // MessageContent intent. Only request it when the bridge is actually configured, so a
  // portal without that intent enabled never breaks the login for everything else.
  const extraIntents = chatBridge
    ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    : [];
  const client = createDiscordClient({ cacheMembers, extraIntents });
  await loginClient(client, env.DISCORD_BOT_TOKEN);

  const real = new DiscordJsRoleGateway(client);
  if (env.DISCORD_MOCK) {
    log.warn('DISCORD_MOCK is enabled: role writes will be logged and skipped');
    return { gateway: new ReadOnlyGatewayDecorator(real), client };
  }

  return { gateway: real, client };
}
