/**
 * Removes registered slash commands.
 *
 *   node apps/bot/src/scripts/clear-commands.js           # clear global commands
 *   node apps/bot/src/scripts/clear-commands.js --guild   # clear DEV_GUILD_IDS commands
 */
import { REST, Routes } from 'discord.js';
import { getEnv } from '@frm/shared';

async function main() {
  const env = getEnv({ service: 'bot' });
  const perGuild = process.argv.includes('--guild');
  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);

  if (perGuild) {
    for (const guildId of env.DEV_GUILD_IDS) {
      await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId), { body: [] });
      console.log(`Cleared commands in guild ${guildId}`);
    }
    return;
  }

  await rest.put(Routes.applicationCommands(env.DISCORD_CLIENT_ID), { body: [] });
  console.log('Cleared global commands.');
}

main().catch((error) => {
  console.error('Failed to clear commands:', error.message);
  process.exit(1);
});
