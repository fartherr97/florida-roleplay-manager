/**
 * Registers slash commands with Discord.
 *
 *   node apps/bot/src/scripts/register-commands.js            # global (up to 1h to appear)
 *   node apps/bot/src/scripts/register-commands.js --guild    # per DEV_GUILD_IDS, instant
 *
 * Guild registration is instant, which is what makes iterating on commands bearable
 * during development. Global registration is what production uses.
 */
import { REST, Routes } from 'discord.js';
import { getEnv } from '@frm/shared';
import { commandPayload } from '../commands/index.js';

async function main() {
  const env = getEnv({ service: 'bot' });
  const perGuild = process.argv.includes('--guild');
  const body = commandPayload();

  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);

  if (perGuild) {
    if (env.DEV_GUILD_IDS.length === 0) {
      console.error('DEV_GUILD_IDS is empty; nothing to register against.');
      process.exit(1);
    }
    for (const guildId of env.DEV_GUILD_IDS) {
      await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId), { body });
      console.log(`Registered ${body.length} commands in guild ${guildId}`);
    }
    return;
  }

  await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body });
  console.log(
    `Registered ${body.length} global commands: ${body.map((command) => command.name).join(', ')}`,
  );
  console.log('Global commands can take up to an hour to appear. Use --guild while developing.');
}

main().catch((error) => {
  console.error('Failed to register commands:', error.message);
  process.exit(1);
});
