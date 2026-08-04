/**
 * Registers slash commands with Discord from the command line.
 *
 *   node apps/bot/src/scripts/register-commands.js            # global (up to 1h to appear)
 *   node apps/bot/src/scripts/register-commands.js --guild    # per DEV_GUILD_IDS, instant
 *
 * The bot also registers its commands automatically on startup (see apps/bot/src/index.js),
 * so this script is only needed for an out-of-band re-registration - for example to push
 * a command change without redeploying, or to register globally while the running bot is
 * configured for guild scope.
 */
import { getEnv } from '@frm/shared';
import { registerCommands } from '../lib/register.js';

async function main() {
  const env = getEnv({ service: 'bot' });
  const perGuild = process.argv.includes('--guild');

  const result = await registerCommands({ env, perGuild });

  if (result.scope === 'guild') {
    console.log(
      `Registered ${result.count} commands in ${result.guildIds.length} guild(s): ${result.guildIds.join(', ')}`,
    );
  } else {
    console.log(`Registered ${result.count} global commands.`);
    console.log('Global commands can take up to an hour to appear. Use --guild while developing.');
  }
}

main().catch((error) => {
  console.error('Failed to register commands:', error.message);
  process.exit(1);
});
