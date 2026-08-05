/**
 * Discord bot process.
 *
 * Deliberately thin. It observes Discord, translates interactions into `@frm/core`
 * calls, and renders the results. It performs no role writes of its own - those belong
 * to the worker, so that a slow synchronization can never blow Discord's three second
 * interaction budget.
 */
process.env.FRM_SERVICE = process.env.FRM_SERVICE ?? 'bot';

import { createLogger, serializeError } from '@frm/logging';
import { disconnectPrisma, waitForDatabase } from '@frm/database';
import { createGatewayFromEnv } from '@frm/discord';
import { closeQueues, closeRedis } from '@frm/queue';
import { getEnv } from '@frm/shared';
import { isGuildApproved, reconcileGlobalAdminsSafely } from '@frm/core';
import { registerEventHandlers } from './events.js';
import { registerCommands, registerGuildCommands } from './lib/register.js';

const log = createLogger('bot');

async function main() {
  const env = getEnv({ service: 'bot' });
  log.info({ nodeEnv: env.NODE_ENV, devMode: env.devMode, mock: env.DISCORD_MOCK }, 'starting bot');

  // The database must be reachable before the bot goes online: without it every command
  // would fail, and a bot that appears online but rejects everything is worse than one
  // that is visibly down. Retry first, so a slow-to-initialise private network on a
  // fresh container does not crash-loop a perfectly healthy database.
  await waitForDatabase();

  // Make sure the root administrators (GLOBAL_ADMIN_DISCORD_IDS) hold every capability,
  // including any added since the last database seed. Self-healing and idempotent, so a
  // newly shipped capability reaches them on the next boot without a separate re-seed.
  const admins = await reconcileGlobalAdminsSafely({ env });
  log.info(
    { admins: admins.admins, capabilities: admins.capabilities },
    'global admins reconciled',
  );

  const { gateway, client } = await createGatewayFromEnv({ cacheMembers: true });
  registerEventHandlers(client, { gateway, env });

  // Register slash commands on boot so a fresh deployment is usable without a separate
  // step: guild-scoped (instant) when DEV_GUILD_IDS is set, global otherwise. Never
  // fatal - a registration hiccup must not take an otherwise-healthy bot offline.
  //
  // In guild scope, register for every server the bot is actually in, not just
  // DEV_GUILD_IDS: a server invited while the bot was offline (so guildCreate never
  // fired for it) would otherwise have no commands until it was listed by hand.
  try {
    const perGuild = env.DEV_GUILD_IDS.length > 0;
    const registered = perGuild
      ? await registerGuildCommands({
          env,
          guildIds: [...env.DEV_GUILD_IDS, ...client.guilds.cache.keys()],
        })
      : await registerCommands({ env, perGuild });
    log.info(
      { scope: registered.scope, count: registered.count, guilds: registered.guildIds.length },
      'slash commands registered',
    );
  } catch (error) {
    log.error({ err: serializeError(error) }, 'slash command registration failed; continuing');
  }

  await auditStartupGuilds(client);

  log.info({ user: client.user?.tag, guilds: client.guilds.cache.size }, 'bot ready');

  const shutdown = async (signal) => {
    log.info({ signal }, 'shutting down');
    client.destroy();
    await closeQueues().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    log.error({ err: serializeError(reason) }, 'unhandled rejection');
  });
}

/**
 * Reports guilds the bot is in that are not on the allowlist.
 *
 * `guildCreate` only fires for joins that happen while the process is running, so a bot
 * that was added while it was offline would otherwise sit in an unapproved server
 * unnoticed. Leaving is left to a human here rather than done automatically at boot: a
 * momentary database problem during startup must never cause the bot to leave the
 * community's real servers.
 */
async function auditStartupGuilds(client) {
  const unapproved = [];

  for (const guild of client.guilds.cache.values()) {
    const approved = await isGuildApproved(guild.id).catch(() => true);
    if (!approved) unapproved.push({ id: guild.id, name: guild.name });
  }

  if (unapproved.length > 0) {
    log.warn(
      { unapproved },
      'the bot is in guilds that are not on the approved allowlist; review them with /guild list',
    );
  }
}

main().catch((error) => {
  log.fatal({ err: serializeError(error) }, 'bot failed to start');
  console.error(error);
  process.exit(1);
});
