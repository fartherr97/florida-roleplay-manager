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
import { createDiscordClient, loginClient } from './client.js';

const log = createLogger('discord.factory');

/**
 * @param {object} [options]
 * @param {boolean} [options.cacheMembers] the worker does not need a member cache
 * @returns {Promise<{gateway: object, client: import('discord.js').Client}>}
 */
export async function createGatewayFromEnv({ cacheMembers = false } = {}) {
  const env = getEnv();

  const client = createDiscordClient({ cacheMembers });
  await loginClient(client, env.DISCORD_BOT_TOKEN);

  const real = new DiscordJsRoleGateway(client);
  if (env.DISCORD_MOCK) {
    log.warn('DISCORD_MOCK is enabled: role writes will be logged and skipped');
    return { gateway: new ReadOnlyGatewayDecorator(real), client };
  }

  return { gateway: real, client };
}
