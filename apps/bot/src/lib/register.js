/**
 * Slash-command registration.
 *
 * Registration is a REST call, independent of the gateway connection - it needs only the
 * bot token and the application id, not a logged-in client. Guild-scoped registration is
 * instant, which makes it the right choice for a single community; global registration is
 * what a bot spread across many servers uses, at the cost of up to an hour to propagate.
 *
 * `rest.put` replaces the whole command set for the scope, so calling this repeatedly
 * (for example on every deploy) is idempotent rather than additive.
 */
import { REST, Routes } from 'discord.js';
import { commandPayload } from '../commands/index.js';

/**
 * Registers the full command set to a specific set of guilds. Guild-scoped registration
 * is instant, so this is how a freshly onboarded server gets its commands without waiting
 * for global propagation. Empty and duplicate ids are ignored.
 *
 * @param {object} params
 * @param {object} params.env parsed environment: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID
 * @param {string[]} params.guildIds guilds to register the commands in
 * @returns {Promise<{scope: 'guild', count: number, guildIds: string[]}>}
 */
export async function registerGuildCommands({ env, guildIds }) {
  const targets = [...new Set(guildIds)].filter(Boolean);
  const body = commandPayload();
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);

  for (const guildId of targets) {
    await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId), { body });
  }
  return { scope: 'guild', count: body.length, guildIds: targets };
}

/**
 * @param {object} params
 * @param {object} params.env parsed environment: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DEV_GUILD_IDS
 * @param {boolean} [params.perGuild] register per DEV_GUILD_IDS (instant) rather than globally.
 *   Defaults to guild scope whenever DEV_GUILD_IDS is set, because that is what a single
 *   community wants: commands that appear the moment the bot boots.
 * @param {string[]} [params.guildIds] override which guilds to register in when guild-scoped;
 *   defaults to DEV_GUILD_IDS.
 * @returns {Promise<{scope: 'guild'|'global', count: number, guildIds: string[]}>}
 */
export async function registerCommands({
  env,
  perGuild = env.DEV_GUILD_IDS.length > 0,
  guildIds = env.DEV_GUILD_IDS,
}) {
  if (perGuild) {
    if (guildIds.length === 0) {
      throw new Error('Guild registration was requested but DEV_GUILD_IDS is empty.');
    }
    return registerGuildCommands({ env, guildIds });
  }

  const body = commandPayload();
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body });
  return { scope: 'global', count: body.length, guildIds: [] };
}

/**
 * Empties the global command set.
 *
 * When the bot registers guild-scoped commands (the single-community setup), Discord still
 * shows any commands left in the *global* scope from an earlier global registration — so
 * every command appears twice, once per scope. Clearing global whenever we go guild-scoped
 * keeps exactly one copy. It is idempotent: clearing an already-empty global set is a
 * no-op, so it is safe to run on every boot.
 *
 * @param {object} params
 * @param {object} params.env parsed environment: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID
 * @returns {Promise<{scope: 'global', cleared: true}>}
 */
export async function clearGlobalCommands({ env }) {
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
  await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: [] });
  return { scope: 'global', cleared: true };
}

/**
 * Empties the guild-scoped command set for the given guilds.
 *
 * The mirror of {@link clearGlobalCommands}: when the bot registers *globally*,
 * any commands left in a *guild* scope from an earlier guild-scoped registration
 * still show — so every command appears twice in those guilds. Clearing them
 * whenever we go global keeps exactly one copy. Idempotent and best-effort per
 * guild, so a single guild that refuses the clear does not stop the rest.
 *
 * @param {object} params
 * @param {object} params.env parsed environment: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID
 * @param {string[]} params.guildIds guilds to clear
 * @returns {Promise<{scope: 'guild', cleared: string[]}>}
 */
export async function clearGuildCommands({ env, guildIds }) {
  const targets = [...new Set(guildIds)].filter(Boolean);
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
  const cleared = [];
  for (const guildId of targets) {
    try {
      await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId), { body: [] });
      cleared.push(guildId);
    } catch {
      // Best-effort: a guild the bot can no longer manage just keeps its stale set.
    }
  }
  return { scope: 'guild', cleared };
}
