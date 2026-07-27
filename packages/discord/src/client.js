/**
 * Discord client construction.
 *
 * Intents are kept to the minimum the platform needs:
 *   - Guilds           guild and role lifecycle events
 *   - GuildMembers     member join/leave/update (privileged: enable it in the portal)
 *   - GuildModeration  audit log entries, used to attribute manual role changes
 */
import { Client, GatewayIntentBits, Options, Partials } from 'discord.js';
import { createLogger, serializeError } from '@frm/logging';

const log = createLogger('discord.client');

export const REQUIRED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration,
];

/**
 * @param {object} [options]
 * @param {boolean} [options.cacheMembers] the worker does not need a member cache
 * @returns {import('discord.js').Client}
 */
export function createDiscordClient({ cacheMembers = true } = {}) {
  const client = new Client({
    intents: REQUIRED_INTENTS,
    partials: [Partials.GuildMember],
    // Caching every member of every guild is the single largest memory cost of a
    // multi-guild bot. The worker only ever fetches members it is about to change.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      GuildMemberManager: cacheMembers ? 200 : 0,
      MessageManager: 0,
      PresenceManager: 0,
      ReactionManager: 0,
      UserManager: cacheMembers ? 200 : 0,
    }),
  });

  client.on('error', (error) => log.error({ err: serializeError(error) }, 'discord client error'));
  client.on('warn', (message) => log.warn({ message }, 'discord client warning'));
  client.rest.on('rateLimited', (info) =>
    log.warn(
      { route: info.route, timeToReset: info.timeToReset, global: info.global },
      'discord rate limit',
    ),
  );

  return client;
}

/**
 * Logs in and resolves once the client is ready.
 * @param {import('discord.js').Client} client
 * @param {string} token
 */
export async function loginClient(client, token) {
  const ready = new Promise((resolve, reject) => {
    client.once('clientReady', resolve);
    // discord.js v14 emits `ready`; v15 renames it to `clientReady`. Listening to both
    // keeps this working across the upgrade.
    client.once('ready', resolve);
    client.once('error', reject);
  });
  await client.login(token);
  await ready;
  log.info({ user: client.user?.tag, guilds: client.guilds.cache.size }, 'discord client ready');
  return client;
}
